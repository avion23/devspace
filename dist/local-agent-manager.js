import { resolve } from "node:path";
import { Result } from "better-result";
import { AgentConflictError, AgentScopeError, AgentTargetError, isLocalAgentError, isProgrammerDefect, } from "./local-agent-errors.js";
import { isLocalAgentProvider, } from "./local-agent-profiles.js";
import { resolveLocalAgentTarget, } from "./local-agent-targets.js";
import { assertAllowedPath } from "./roots.js";
import { isSubagentProviderEnabled, } from "./local-agent-config.js";
/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
    store;
    drivers = new Map();
    pool;
    loadProfiles;
    agentDir;
    allowedRoots;
    logger;
    subagents;
    activeTurns = new Map();
    accepting = true;
    closePromise;
    constructor(options) {
        this.store = options.store;
        for (const driver of options.drivers)
            this.drivers.set(driver.provider, driver);
        this.pool = options.pool;
        this.loadProfiles = options.loadProfiles;
        this.agentDir = options.agentDir;
        this.allowedRoots = options.allowedRoots;
        this.logger = options.logger;
        this.subagents = options.subagents;
    }
    reconcileActiveRuns(message) {
        return this.store.reconcileActiveRunsResult(message);
    }
    async start(input) {
        const manager = this;
        return Result.gen(async function* () {
            yield* manager.acceptingResult("start");
            const workspaceRoot = yield* manager.authorizeWorkspace(input.workspaceRoot, input.workspaceId, "start");
            const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target));
            const target = resolveLocalAgentTarget(input.target, profiles, input.model, input.effort, manager.subagents.providers);
            if (!target) {
                return Result.err(new AgentTargetError({
                    code: "UNKNOWN_TARGET",
                    target: input.target,
                    retryable: false,
                    message: `Unknown subagent profile or provider: ${input.target}.`,
                }));
            }
            if (target.kind === "profile" && target.profile.disabled) {
                return Result.err(new AgentTargetError({
                    code: "PROVIDER_DISABLED",
                    target: target.name,
                    provider: target.provider,
                    retryable: false,
                    message: `Subagent profile is disabled: ${target.name}.`,
                }));
            }
            yield* manager.providerEnabledResult(target.provider, target.name, "start");
            yield* manager.driverResult(target.provider, "start");
            const record = yield* manager.store.createResult({
                workspaceId: input.workspaceId,
                workspaceRoot,
                profileName: target.name,
                provider: target.provider,
                model: target.model,
                effort: target.effort,
            });
            return manager.begin(record, input.prompt, {
                model: target.model,
                effort: target.effort,
                writeMode: input.writeMode,
            }, input.workspaceId);
        });
    }
    async continue(agentId, prompt, overrides = {}, scope) {
        const manager = this;
        return Result.gen(async function* () {
            yield* manager.acceptingResult("continue", agentId);
            const record = yield* manager.store.getByIdResult(agentId);
            if (!record)
                return Result.err(agentNotFound(agentId));
            yield* manager.agentWorkspaceResult(record, scope, "continue");
            const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName));
            yield* manager.profileForRecordResult(record, profiles);
            yield* manager.providerEnabledResult(record.provider, record.profileName, "continue");
            yield* manager.driverResult(record.provider, "continue", agentId);
            return manager.begin(record, prompt, overrides, scope.workspaceId);
        });
    }
    get(agentId, scope) {
        const lookup = this.store.getByIdResult(agentId);
        if (lookup.isErr())
            return lookup;
        const record = lookup.value;
        if (!record)
            return Result.err(agentNotFound(agentId));
        const scoped = this.agentWorkspaceResult(record, scope, "get");
        if (scoped.isErr())
            return scoped;
        return Result.ok(record);
    }
    list(scope) {
        return this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, "list").andThen((workspaceRoot) => (this.store.listResult({
            workspaceId: scope.workspaceId,
            workspaceRoot,
        })));
    }
    async close() {
        if (this.closePromise)
            return this.closePromise;
        this.accepting = false;
        const turns = Array.from(this.activeTurns.values());
        this.closePromise = (async () => {
            // Closing pooled runtimes is what interrupts provider turns. Waiting for
            // those turns first can strand a provider process indefinitely.
            await this.pool.close();
            const turnResults = await Promise.allSettled(turns);
            for (const result of turnResults) {
                if (result.status === "rejected") {
                    this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
                }
            }
            this.store.close();
        })();
        return this.closePromise;
    }
    get activeTurnCount() {
        return this.activeTurns.size;
    }
    get runtimeCount() {
        return this.pool.size;
    }
    async evictIdle(now) {
        await this.pool.evictIdle(now);
    }
    begin(record, prompt, overrides, workspaceId) {
        if (this.activeTurns.has(record.id)) {
            return Result.err(new AgentConflictError({
                code: "AGENT_CONFLICT",
                agentId: record.id,
                operation: "continue",
                retryable: true,
                message: `Agent ${record.id} already has a running turn.`,
            }));
        }
        const updated = this.store.updateResult(record.id, {
            status: "running",
            model: overrides.model ?? record.model,
            effort: overrides.effort ?? record.effort,
            latestResponse: undefined,
            error: undefined,
            errorCode: undefined,
            errorRetryable: undefined,
        });
        if (updated.isErr())
            return updated;
        // Defer invocation until after the tracking entry is visible. This keeps
        // cleanup correct even if runTurn later gains a synchronous completion path.
        const turn = Promise.resolve().then(() => (this.runTurn(updated.value, prompt, overrides, workspaceId)));
        this.activeTurns.set(record.id, turn);
        void turn.catch(() => undefined);
        return updated;
    }
    async runTurn(record, prompt, overrides, workspaceId) {
        const startedAt = Date.now();
        this.log("info", "agent_run_started", {
            provider: record.provider,
            agentId: record.id,
            providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        });
        try {
            const authorized = this.authorizeWorkspace(record.workspaceRoot, workspaceId, "run");
            if (authorized.isErr()) {
                this.persistRunError(record, authorized.error, startedAt);
                return;
            }
            const workspaceRoot = authorized.value;
            const authorizedRecord = workspaceRoot === record.workspaceRoot
                ? record
                : { ...record, workspaceRoot };
            const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName);
            if (profiles.isErr()) {
                this.persistRunError(record, profiles.error, startedAt);
                return;
            }
            const profile = this.profileForRecordResult(record, profiles.value);
            if (profile.isErr()) {
                this.persistRunError(record, profile.error, startedAt);
                return;
            }
            const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
            if (input.isErr()) {
                this.persistRunError(record, input.error, startedAt);
                return;
            }
            const driver = this.driverResult(record.provider, "run", record.id);
            if (driver.isErr()) {
                this.persistRunError(record, driver.error, startedAt);
                return;
            }
            const context = {
                agentId: record.id,
                provider: driver.value.provider,
                workspaceRoot,
                providerSessionId: record.providerSessionId,
                writeMode: input.value.writeMode,
                model: input.value.model,
                effort: input.value.effort,
                agentDir: this.agentDir,
            };
            const callbacks = {
                onSessionId: (providerSessionId) => {
                    const current = this.store.getByIdResult(record.id);
                    if (current.isErr())
                        throw current.error;
                    if (!current.value || current.value.providerSessionId === providerSessionId)
                        return;
                    const updated = this.store.updateResult(record.id, { providerSessionId });
                    if (updated.isErr())
                        throw updated.error;
                },
            };
            const result = await this.pool.run(driver.value, context, input.value, callbacks);
            if (result.isErr()) {
                this.persistRunError(record, result.error, startedAt);
                return;
            }
            const runResult = result.value;
            const current = this.store.getByIdResult(record.id);
            if (current.isErr())
                throw current.error;
            if (!current.value)
                return;
            const updated = this.store.updateResult(record.id, {
                providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
                status: "idle",
                latestResponse: runResult.finalResponse,
                error: undefined,
                errorCode: undefined,
                errorRetryable: undefined,
            });
            if (updated.isErr())
                throw updated.error;
            this.log("info", "agent_run_completed", {
                provider: updated.value.provider,
                agentId: updated.value.id,
                providerSessionIdPrefix: updated.value.providerSessionId?.slice(0, 8),
                durationMs: Math.max(0, Date.now() - startedAt),
            });
        }
        catch (error) {
            if (isLocalAgentError(error)) {
                this.persistRunError(record, error, startedAt);
                return;
            }
            const persisted = this.store.updateResult(record.id, {
                status: "error",
                error: "Unexpected internal subagent failure.",
                errorCode: "AGENT_INTERNAL_ERROR",
                errorRetryable: false,
            });
            this.log("error", "agent_run_failed", {
                provider: record.provider,
                agentId: record.id,
                providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
                durationMs: Math.max(0, Date.now() - startedAt),
                error: "Unexpected internal subagent failure.",
                errorType: error instanceof Error ? error.name : typeof error,
                persistenceFailed: persisted.isErr(),
            });
            throw error;
        }
        finally {
            this.activeTurns.delete(record.id);
        }
    }
    persistRunError(record, error, startedAt) {
        const persisted = this.store.updateResult(record.id, {
            status: "error",
            error: error.message,
            errorCode: error.code,
            errorRetryable: error.retryable,
        });
        this.log("error", "agent_run_failed", {
            provider: record.provider,
            agentId: record.id,
            providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
            durationMs: Math.max(0, Date.now() - startedAt),
            errorCode: error.code,
            error: error.message,
            causeType: safeCauseType("cause" in error ? error.cause : undefined),
            persistenceFailed: persisted.isErr(),
        });
    }
    buildRunInputResult(record, profile, prompt, overrides) {
        const isRawProvider = record.profileName === record.provider;
        if (!profile && !isRawProvider) {
            return Result.err(new AgentTargetError({
                code: "UNKNOWN_TARGET",
                target: record.profileName,
                provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
                retryable: false,
                message: `Subagent profile not found: ${record.profileName}.`,
            }));
        }
        const body = profile?.body.trim();
        const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
        return Result.ok({
            prompt: fullPrompt,
            workspaceRoot: record.workspaceRoot,
            providerSessionId: record.providerSessionId,
            writeMode: overrides.writeMode ?? "allowed",
            model: record.model ?? profile?.model,
            effort: record.effort ?? profile?.effort,
            modelOverrideRequested: overrides.model !== undefined,
            effortOverrideRequested: overrides.effort !== undefined,
        });
    }
    profileForRecordResult(record, profiles) {
        if (record.profileName === record.provider)
            return Result.ok(undefined);
        const profile = profiles.find((candidate) => candidate.name === record.profileName);
        if (!profile) {
            return Result.err(new AgentTargetError({
                code: "UNKNOWN_TARGET",
                target: record.profileName,
                provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
                retryable: false,
                message: `Subagent profile not found: ${record.profileName}.`,
            }));
        }
        if (profile.disabled) {
            return Result.err(new AgentTargetError({
                code: "PROVIDER_DISABLED",
                target: profile.name,
                provider: profile.provider,
                retryable: false,
                message: `Subagent profile is disabled: ${profile.name}.`,
            }));
        }
        return Result.ok(profile);
    }
    driverResult(provider, operation, agentId) {
        if (!isLocalAgentProvider(provider)) {
            return Result.err(new AgentTargetError({
                code: "PROVIDER_NOT_CONFIGURED",
                target: provider,
                operation,
                retryable: false,
                message: `No local agent driver is configured for provider: ${provider}.`,
            }));
        }
        const driver = this.drivers.get(provider);
        if (!driver) {
            return Result.err(new AgentTargetError({
                code: "PROVIDER_NOT_CONFIGURED",
                target: agentId ?? provider,
                provider,
                operation,
                retryable: false,
                message: `No local agent driver is configured for provider: ${provider}.`,
            }));
        }
        return Result.ok(driver);
    }
    providerEnabledResult(provider, target, operation) {
        if (!isLocalAgentProvider(provider))
            return Result.ok(undefined);
        if (isSubagentProviderEnabled(this.subagents, provider))
            return Result.ok(undefined);
        return Result.err(new AgentTargetError({
            code: "PROVIDER_DISABLED",
            target,
            provider,
            operation,
            retryable: false,
            message: `Subagent provider is disabled: ${provider}.`,
        }));
    }
    acceptingResult(operation, agentId) {
        if (this.accepting)
            return Result.ok(undefined);
        return Result.err(new AgentConflictError({
            code: "AGENT_CONFLICT",
            agentId,
            operation,
            retryable: false,
            message: "Local agent manager is closed.",
        }));
    }
    authorizeWorkspace(workspaceRoot, workspaceId, operation) {
        const normalized = resolve(workspaceRoot);
        if (!workspaceId || !this.allowedRoots)
            return Result.ok(normalized);
        try {
            return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
        }
        catch (cause) {
            return Result.err(new AgentScopeError({
                code: "WORKSPACE_NOT_ALLOWED",
                operation,
                retryable: false,
                cause,
                message: "Workspace root is outside configured allowed roots.",
            }));
        }
    }
    agentWorkspaceResult(record, scope, operation) {
        const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, operation);
        if (workspaceRoot.isErr())
            return workspaceRoot;
        const idMismatch = scope.workspaceId !== undefined && record.workspaceId !== scope.workspaceId;
        if (workspaceRoot.value !== record.workspaceRoot || idMismatch) {
            return Result.err(new AgentScopeError({
                code: "WORKSPACE_MISMATCH",
                agentId: record.id,
                workspaceId: scope.workspaceId,
                operation,
                retryable: false,
                message: `Subagent ${record.id} belongs to a different workspace.`,
            }));
        }
        return Result.ok(undefined);
    }
    async loadProfilesResult(workspaceRoot, target) {
        try {
            return Result.ok(await this.loadProfiles(workspaceRoot));
        }
        catch (cause) {
            if (isProgrammerDefect(cause))
                throw cause;
            return Result.err(new AgentTargetError({
                code: "TARGET_RESOLUTION_FAILED",
                target,
                retryable: false,
                cause,
                message: "Unable to load subagent profiles.",
            }));
        }
    }
    log(level, event, fields) {
        this.logger?.(level, event, fields);
    }
}
export function createLocalAgentManager(options) {
    return new LocalAgentManager(options);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function safeCauseType(cause) {
    if (cause instanceof Error)
        return cause.name;
    if (cause && typeof cause === "object" && "error" in cause) {
        const nested = cause.error;
        if (nested instanceof Error)
            return nested.name;
    }
    return cause === undefined ? undefined : typeof cause;
}
function agentNotFound(agentId) {
    return new AgentTargetError({
        code: "AGENT_NOT_FOUND",
        target: agentId,
        retryable: false,
        message: `Unknown subagent id: ${agentId}.`,
    });
}
