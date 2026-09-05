import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentProviderExecutionError, AgentProviderProtocolError, AgentProviderUnavailableError, captureAgentProviderResult, isProgrammerDefect, } from "./local-agent-errors.js";
class AsyncInputQueue {
    values = [];
    waiters = [];
    closed = false;
    push(value) {
        if (this.closed)
            throw new Error("Claude input stream is closed.");
        const waiter = this.waiters.shift();
        if (waiter)
            waiter.resolve({ done: false, value });
        else
            this.values.push(value);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        while (this.waiters.length > 0)
            this.waiters.shift().resolve({ done: true, value: undefined });
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    next() {
        const value = this.values.shift();
        if (value !== undefined)
            return Promise.resolve({ done: false, value });
        if (this.closed)
            return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
}
export class ClaudeQueryRuntime {
    query;
    inputQueue;
    provider = "claude";
    iterator;
    alive = true;
    closed = false;
    providerSessionId;
    constructor(query, inputQueue, context) {
        this.query = query;
        this.inputQueue = inputQueue;
        this.providerSessionId = context.providerSessionId;
        this.iterator = query[Symbol.asyncIterator]();
    }
    async run(input, callbacks) {
        return captureAgentProviderResult({
            provider: "claude",
            operation: "run",
            run: async () => {
                if (!this.isAlive()) {
                    throw new AgentProviderUnavailableError({
                        code: "PROVIDER_UNAVAILABLE",
                        provider: "claude",
                        operation: "run",
                        retryable: true,
                        message: "Claude runtime is not running.",
                    });
                }
                if (this.providerSessionId)
                    await callbacks?.onSessionId?.(this.providerSessionId);
                const flagSettings = claudeAuthoritySettings(input.workspaceRoot, input.writeMode);
                if (input.effort) {
                    Object.assign(flagSettings, {
                        alwaysThinkingEnabled: true,
                        effortLevel: input.effort,
                    });
                }
                await this.query.applyFlagSettings(flagSettings);
                await this.query.setPermissionMode(claudePermissionMode(input.writeMode));
                if (input.model && this.query.setModel)
                    await this.query.setModel(input.model);
                this.inputQueue.push({
                    type: "user",
                    message: { role: "user", content: input.prompt },
                    parent_tool_use_id: null,
                });
                const items = [];
                for (;;) {
                    let next;
                    try {
                        next = await this.iterator.next();
                    }
                    catch (error) {
                        this.alive = false;
                        if (isProgrammerDefect(error))
                            throw error;
                        throw new AgentProviderUnavailableError({
                            code: "PROVIDER_UNAVAILABLE",
                            provider: "claude",
                            operation: "run",
                            retryable: true,
                            cause: error,
                            message: "Claude query stream failed.",
                        });
                    }
                    if (next.done) {
                        this.alive = false;
                        throw new AgentProviderProtocolError({
                            code: "PROVIDER_PROTOCOL_ERROR",
                            provider: "claude",
                            operation: "run",
                            retryable: true,
                            message: "Claude query ended before returning a result.",
                        });
                    }
                    const message = next.value;
                    items.push(message);
                    const record = asRecord(message);
                    if (typeof record?.session_id === "string") {
                        const previousSessionId = this.providerSessionId;
                        this.providerSessionId = record.session_id;
                        if (previousSessionId !== this.providerSessionId) {
                            await callbacks?.onSessionId?.(this.providerSessionId);
                        }
                    }
                    if (record?.type !== "result")
                        continue;
                    const resultError = claudeResultError(record);
                    if (resultError) {
                        throw new AgentProviderExecutionError({
                            code: "PROVIDER_EXECUTION_ERROR",
                            provider: "claude",
                            operation: "run",
                            retryable: false,
                            cause: new Error(resultError),
                            message: "Claude agent turn failed.",
                        });
                    }
                    const finalResponse = typeof record.result === "string" ? record.result.trim() : "";
                    if (!finalResponse) {
                        throw new AgentProviderProtocolError({
                            code: "PROVIDER_PROTOCOL_ERROR",
                            provider: "claude",
                            operation: "run",
                            retryable: false,
                            message: "Claude did not return a final assistant response.",
                        });
                    }
                    return {
                        provider: this.provider,
                        providerSessionId: this.providerSessionId ?? null,
                        finalResponse,
                        items,
                    };
                }
            },
        });
    }
    async releaseSession(_providerSessionId) {
        // Claude's streaming query owns the durable session; it remains warm.
    }
    isAlive() {
        return this.alive && !this.closed;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.alive = false;
        this.inputQueue.close();
        this.query.close();
    }
}
export class ClaudeLocalAgentDriver {
    factory;
    env;
    provider = "claude";
    idleTimeoutMs = 3 * 60_000;
    constructor(factory = defaultClaudeQueryFactory, env = process.env) {
        this.factory = factory;
        this.env = env;
    }
    runtimeKey(context) {
        const authority = context.writeMode === "full_access" ? "full_access" : "restricted";
        return `claude:${context.agentId}:${authority}`;
    }
    async createRuntime(context) {
        return captureAgentProviderResult({
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            run: async () => {
                const inputQueue = new AsyncInputQueue();
                const input = {
                    prompt: "",
                    workspaceRoot: context.workspaceRoot,
                    providerSessionId: context.providerSessionId,
                    writeMode: context.writeMode,
                    model: context.model,
                    effort: context.effort,
                };
                const query = await this.factory({
                    context,
                    options: claudeQueryOptions(context, input, this.env),
                    prompt: inputQueue,
                });
                return new ClaudeQueryRuntime(query, inputQueue, context);
            },
        });
    }
}
async function defaultClaudeQueryFactory({ options, prompt, }) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    return query({
        prompt,
        options: options,
    });
}
export function claudeQueryOptions(context, input, env = process.env) {
    const executable = env.CLAUDE_COMMAND ?? resolveExecutable("claude", env);
    const permissionMode = claudePermissionMode(input.writeMode);
    const authority = claudeAuthorityOptions(input.workspaceRoot, input.writeMode);
    return {
        cwd: input.workspaceRoot,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { thinking: { type: "adaptive" }, effort: input.effort } : {}),
        ...(context.providerSessionId ? { resume: context.providerSessionId } : {}),
        permissionMode,
        sandbox: authority.sandbox,
        settings: authority.settings,
        ...(input.writeMode === "full_access" ? { allowDangerouslySkipPermissions: true } : {}),
        env: claudeCommandEnvironment(env),
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    };
}
export function claudePermissionMode(writeMode) {
    switch (writeMode) {
        case "read_only":
        case "allowed":
        case undefined:
            return "dontAsk";
        case "full_access": return "bypassPermissions";
    }
}
export function claudeAuthoritySettings(workspaceRoot, writeMode) {
    return claudeAuthorityOptions(workspaceRoot, writeMode).settings;
}
function claudeAuthorityOptions(workspaceRoot, writeMode) {
    if (writeMode === "full_access") {
        const sandbox = {
            enabled: false,
            allowUnsandboxedCommands: true,
        };
        return {
            sandbox,
            settings: {
                permissions: { defaultMode: "bypassPermissions" },
                sandbox,
            },
        };
    }
    const resolvedWorkspace = workspaceRoot.replaceAll("\\", "/");
    const workspaceRules = [
        `Read(${resolvedWorkspace}/**)`,
        `Glob(${resolvedWorkspace}/**)`,
        `Grep(${resolvedWorkspace}/**)`,
        `LS(${resolvedWorkspace}/**)`,
    ];
    const allowed = writeMode !== "read_only";
    const protectedPaths = claudeProtectedPaths();
    const permissions = {
        defaultMode: "dontAsk",
        allow: [
            ...workspaceRules,
            ...(allowed ? [`Edit(${resolvedWorkspace}/**)`, "Bash(*)"] : []),
        ],
        deny: [
            ...protectedPaths.map((path) => `Read(${path.replaceAll("\\", "/")}/**)`),
            ...(allowed ? [] : ["Bash(*)", "Edit(*)", "Write(*)", "NotebookEdit(*)"]),
        ],
    };
    const sandbox = {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: {
            allowWrite: allowed ? [workspaceRoot] : [],
            denyWrite: allowed ? [] : [workspaceRoot],
            denyRead: protectedPaths,
            allowRead: [workspaceRoot],
        },
    };
    return { sandbox, settings: { permissions, sandbox } };
}
function claudeProtectedPaths() {
    const home = homedir();
    return [
        join(home, ".ssh"),
        join(home, ".aws"),
        join(home, ".gnupg"),
        join(home, ".config", "gcloud"),
        join(home, ".netrc"),
        join(home, ".npmrc"),
    ];
}
export function claudeCommandEnvironment(env) {
    const next = { ...env };
    for (const key of [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SSE_PORT",
        "CLAUDE_AGENT_SDK_VERSION",
    ]) {
        delete next[key];
    }
    return next;
}
export function claudeResultError(record) {
    const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
    const isError = record.is_error === true || subtype?.startsWith("error");
    if (!isError)
        return undefined;
    const message = directString(record.error) ??
        directString(record.message) ??
        directString(record.result) ??
        subtype ??
        "Claude returned an error result.";
    return `Claude returned an error result: ${message}`;
}
function resolveExecutable(command, env) {
    const commandHasPath = command.includes("/") || command.includes("\\");
    if (commandHasPath)
        return command;
    const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
        encoding: "utf8",
        env,
        windowsHide: true,
    });
    const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
    return executable?.trim() || undefined;
}
function directString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
