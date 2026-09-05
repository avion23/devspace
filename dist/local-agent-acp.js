import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentProviderProtocolError, AgentProviderUnavailableError, captureAgentProviderResult, isProgrammerDefect, } from "./local-agent-errors.js";
import { terminateProcessTree } from "./process-platform.js";
import { GrokPromptCompletionRegistry, GROK_DEFAULT_MODEL, parseGrokPromptCompletion, readGrokSessionState, resolveGrokEffort, resolveGrokModelId, } from "./local-agent-grok.js";
const MAX_ACP_QUEUE_ITEMS = 10_000;
const MAX_ACP_STDERR_BYTES = 32 * 1024;
const ACP_INITIALIZE_TIMEOUT_MS = 10_000;
const ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const require = createRequire(import.meta.url);
const spawn = require("cross-spawn");
const DEVSPACE_VERSION = readDevspaceVersion();
const observeChildError = () => { };
const ACP_COMMANDS = {
    cursor: ["cursor-agent", "acp"],
    copilot: ["copilot", "--acp"],
    grok: ["grok", "agent", "stdio"],
};
export class AcpRuntime {
    provider;
    child;
    connection;
    capabilities;
    queues;
    liveSessions;
    sessionWriteModes;
    sessionMetadata;
    grokCompletionRegistry;
    promptCompletionTimeoutMs;
    activeSessions = new Set();
    promptSequence = 0;
    alive = true;
    closed = false;
    constructor(options, connection) {
        this.provider = options.provider;
        this.child = options.child;
        this.connection = connection;
        this.capabilities = options.capabilities ?? { resume: false, close: false };
        this.queues = options.queues ?? new Map();
        this.liveSessions = options.liveSessions ?? new Set();
        this.sessionWriteModes = options.sessionWriteModes ?? new Map();
        this.sessionMetadata = options.sessionMetadata ?? new Map();
        this.grokCompletionRegistry = options.grokCompletionRegistry;
        this.promptCompletionTimeoutMs = options.promptCompletionTimeoutMs ?? ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS;
        void this.connection.closed.then(() => {
            if (!this.closed)
                this.alive = false;
            this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP connection closed.`));
        }).catch(() => {
            if (!this.closed)
                this.alive = false;
            this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP connection closed.`));
        });
        this.child?.once("exit", () => {
            this.alive = false;
            this.connection.close(new Error(`${this.provider} ACP process exited.`));
        });
        this.child?.once("error", (error) => {
            this.alive = false;
            this.connection.close(error);
        });
    }
    async run(input, callbacks) {
        return captureAgentProviderResult({
            provider: this.provider,
            operation: "run",
            run: async () => {
                if (!this.isAlive()) {
                    throw new AgentProviderUnavailableError({
                        code: "PROVIDER_UNAVAILABLE",
                        provider: this.provider,
                        operation: "run",
                        retryable: true,
                        message: `${this.provider} ACP runtime is not running.`,
                    });
                }
                const sessionId = await this.openSession(input, callbacks);
                if (this.activeSessions.has(sessionId)) {
                    throw new TypeError(`${this.provider} ACP session ${sessionId} already has an active turn.`);
                }
                this.activeSessions.add(sessionId);
                const queue = this.queues.get(sessionId) ?? { values: [] };
                this.queues.set(sessionId, queue);
                const promptId = this.provider === "grok" ? this.nextPromptId() : undefined;
                const completion = promptId && this.grokCompletionRegistry
                    ? this.grokCompletionRegistry.wait(sessionId, promptId, this.promptCompletionTimeoutMs, () => new AgentProviderProtocolError({
                        code: "PROVIDER_PROTOCOL_ERROR",
                        provider: this.provider,
                        operation: "run",
                        retryable: true,
                        message: "Grok ACP did not report completion for the prompt before the timeout.",
                    }))
                    : undefined;
                try {
                    queue.values.length = 0;
                    const standardResponse = this.connection.agent.request("session/prompt", {
                        sessionId,
                        prompt: [{ type: "text", text: input.prompt }],
                        ...(promptId ? { _meta: { promptId, requestId: promptId } } : {}),
                    });
                    const response = completion
                        ? await Promise.race([standardResponse, completion])
                        : await standardResponse;
                    if (completion && isGrokPromptCompletion(response)) {
                        await yieldToAcpQueue();
                    }
                    else if (promptId) {
                        this.grokCompletionRegistry?.markCompleted(sessionId, promptId);
                    }
                    const updates = queue.values.splice(0);
                    const finalResponse = extractAcpText(updates);
                    if (!finalResponse) {
                        throw new AgentProviderProtocolError({
                            code: "PROVIDER_PROTOCOL_ERROR",
                            provider: this.provider,
                            operation: "run",
                            retryable: false,
                            cause: response,
                            message: `${this.provider} ACP did not return a final assistant response.`,
                        });
                    }
                    return {
                        provider: this.provider,
                        providerSessionId: sessionId,
                        finalResponse,
                        items: updates,
                    };
                }
                finally {
                    if (promptId)
                        this.grokCompletionRegistry?.remove(sessionId, promptId);
                    this.activeSessions.delete(sessionId);
                }
            },
        });
    }
    async releaseSession(providerSessionId) {
        this.queues.delete(providerSessionId);
        this.liveSessions.delete(providerSessionId);
        this.sessionWriteModes.delete(providerSessionId);
        this.sessionMetadata.delete(providerSessionId);
        if (!this.capabilities.close || !this.isAlive())
            return;
        await this.connection.agent.request("session/close", { sessionId: providerSessionId });
    }
    isAlive() {
        return this.alive && !this.closed && (!this.child || (this.child.exitCode === null && !this.child.killed));
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.alive = false;
        this.queues.clear();
        this.liveSessions.clear();
        this.sessionWriteModes.clear();
        this.sessionMetadata.clear();
        this.activeSessions.clear();
        this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP runtime closed.`));
        this.connection.close(new Error(`${this.provider} ACP runtime closed.`));
        if (this.child && this.child.exitCode === null) {
            const detached = process.platform !== "win32";
            terminateProcessTree(this.child, "SIGTERM", detached);
            if (!await waitForProcessExit(this.child, 1_000)) {
                terminateProcessTree(this.child, "SIGKILL", detached);
            }
        }
    }
    async openSession(input, callbacks) {
        if (input.providerSessionId) {
            if (this.liveSessions.has(input.providerSessionId)) {
                this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
                await callbacks?.onSessionId?.(input.providerSessionId);
                await this.configureSession(input.providerSessionId, input, this.sessionMetadata.get(input.providerSessionId), false);
                return input.providerSessionId;
            }
            if (!this.capabilities.resume) {
                throw new AgentProviderProtocolError({
                    code: "PROVIDER_PROTOCOL_ERROR",
                    provider: this.provider,
                    operation: "resume_session",
                    retryable: false,
                    message: `${this.provider} ACP does not advertise session resume support.`,
                });
            }
            const response = await this.connection.agent.request("session/resume", {
                sessionId: input.providerSessionId,
                cwd: input.workspaceRoot,
                mcpServers: [],
                ...this.additionalDirectoryParams(),
            });
            this.cacheSessionMetadata(input.providerSessionId, response);
            this.queues.set(input.providerSessionId, { values: [] });
            this.liveSessions.add(input.providerSessionId);
            this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
            await callbacks?.onSessionId?.(input.providerSessionId);
            await this.configureSession(input.providerSessionId, input, response, false);
            return input.providerSessionId;
        }
        const response = await this.connection.agent.request("session/new", {
            cwd: input.workspaceRoot,
            mcpServers: [],
            ...this.additionalDirectoryParams(),
        });
        const sessionId = readString(response, "sessionId");
        if (!sessionId) {
            throw new AgentProviderProtocolError({
                code: "PROVIDER_PROTOCOL_ERROR",
                provider: this.provider,
                operation: "create_session",
                retryable: false,
                cause: response,
                message: `${this.provider} ACP did not return a session id.`,
            });
        }
        this.cacheSessionMetadata(sessionId, response);
        this.queues.set(sessionId, { values: [] });
        this.liveSessions.add(sessionId);
        this.sessionWriteModes.set(sessionId, input.writeMode ?? "allowed");
        await callbacks?.onSessionId?.(sessionId);
        await this.configureSession(sessionId, input, response, true);
        return sessionId;
    }
    cacheSessionMetadata(sessionId, response) {
        if (hasAcpConfigOptions(response) || (this.provider === "grok" && readGrokSessionState(response))) {
            this.sessionMetadata.set(sessionId, response);
        }
    }
    async configureSession(sessionId, input, response, isNewSession = false) {
        const metadata = response ?? this.sessionMetadata.get(sessionId);
        if (this.provider === "grok") {
            await this.configureGrokSession(sessionId, input, metadata, isNewSession);
            return;
        }
        const canConfigure = isNewSession || hasAcpConfigOptions(metadata);
        if (!canConfigure) {
            const requested = [
                input.model && input.modelOverrideRequested ? "model" : undefined,
                input.effort && input.effortOverrideRequested ? "effort" : undefined,
            ]
                .filter(Boolean)
                .join(" and ");
            if (requested) {
                throw new AgentProviderProtocolError({
                    code: "PROVIDER_PROTOCOL_ERROR",
                    provider: this.provider,
                    operation: "configure_session",
                    retryable: false,
                    message: `${this.provider} ACP cannot apply the requested ${requested} override because the resumed session did not advertise configurable options.`,
                });
            }
            // A durable resumed session keeps its previously selected provider
            // configuration. If resume does not re-advertise config options, do not
            // force a redundant set operation for persisted model/effort values.
            return;
        }
        if (input.model) {
            const config = resolveAcpModelConfigUpdate(metadata, input.model, this.provider, sessionId);
            await this.connection.agent.request("session/set_config_option", config);
        }
        if (input.effort) {
            const config = resolveAcpEffortConfigUpdate(metadata, input.effort, this.provider, sessionId);
            await this.connection.agent.request("session/set_config_option", config);
        }
    }
    async configureGrokSession(sessionId, input, response, isNewSession) {
        const state = readGrokSessionState(response);
        if (!state) {
            const requested = [
                input.model && (isNewSession || input.modelOverrideRequested) ? "model" : undefined,
                input.effort && (isNewSession || input.effortOverrideRequested) ? "effort" : undefined,
            ].filter(Boolean).join(" and ");
            if (requested) {
                throw new AgentProviderProtocolError({
                    code: "PROVIDER_PROTOCOL_ERROR",
                    provider: this.provider,
                    operation: "configure_session",
                    retryable: false,
                    message: `${this.provider} ACP did not advertise typed model metadata required for the requested ${requested} override.`,
                });
            }
            return;
        }
        const currentModel = state.currentModelId;
        const requestedModel = input.model
            ? resolveGrokModelId(input.model, state)
            : currentModel ?? state.availableModels[0]?.id ?? GROK_DEFAULT_MODEL;
        const effort = input.effort
            ? resolveGrokEffort(input.effort, state, requestedModel)
            : undefined;
        const shouldSetModel = Boolean(input.model && requestedModel !== currentModel) || effort !== undefined;
        if (!shouldSetModel)
            return;
        try {
            await this.connection.agent.request("session/set_model", {
                sessionId,
                modelId: requestedModel,
                ...(effort ? { _meta: { reasoningEffort: effort } } : {}),
            });
        }
        catch (cause) {
            throw new AgentProviderProtocolError({
                code: "PROVIDER_PROTOCOL_ERROR",
                provider: this.provider,
                operation: "configure_session",
                retryable: false,
                cause,
                message: `${this.provider} ACP could not select model '${requestedModel}'.`,
            });
        }
    }
    additionalDirectoryParams() {
        // DevSpace currently authorizes exactly one workspace root per agent turn.
        // Do not advertise an empty additional-directory scope to ACP providers.
        return {};
    }
    nextPromptId() {
        this.promptSequence += 1;
        return `devspace-grok-prompt-${this.promptSequence}`;
    }
}
export class AcpLocalAgentDriver {
    env;
    commandResolver;
    provider;
    // Keep ACP warm briefly, then let the generic pool close the process so the
    // daemon can reach its own idle shutdown state.
    idleTimeoutMs = 5 * 60_000;
    commandResolved = false;
    resolvedCommand;
    constructor(provider, env = process.env, commandResolver = resolveAcpCommand) {
        this.env = env;
        this.commandResolver = commandResolver;
        this.provider = provider;
    }
    runtimeKey(context) {
        const command = this.resolveCommand() ?? ACP_COMMANDS[this.provider][0];
        const writeMode = context.writeMode ?? "allowed";
        return `acp:${this.provider}:${command}:${writeMode}:${resolve(context.workspaceRoot)}`;
    }
    async createRuntime(context) {
        return captureAgentProviderResult({
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            run: async () => {
                const command = this.resolveCommand();
                if (!command) {
                    throw new AgentProviderUnavailableError({
                        code: "PROVIDER_UNAVAILABLE",
                        provider: this.provider,
                        agentId: context.agentId,
                        operation: "create_runtime",
                        retryable: false,
                        message: `${this.provider} executable was not found.`,
                    });
                }
                const args = acpCommandArgs(this.provider, context, this.env);
                const child = spawn(command, args, {
                    cwd: resolve(context.workspaceRoot),
                    env: this.env,
                    stdio: ["pipe", "pipe", "pipe"],
                    detached: process.platform !== "win32",
                    windowsHide: true,
                });
                let resolveStartupError;
                const startupError = new Promise((resolveError) => { resolveStartupError = resolveError; });
                const onStartupError = (error) => { resolveStartupError(error); };
                child.once("error", onStartupError);
                if (!child.stdin || !child.stdout || !child.stderr) {
                    child.on("error", observeChildError);
                    child.removeListener("error", onStartupError);
                    if (child.exitCode === null) {
                        const detached = process.platform !== "win32";
                        terminateProcessTree(child, "SIGTERM", detached);
                        if (!await waitForProcessExit(child, 1_000)) {
                            terminateProcessTree(child, "SIGKILL", detached);
                        }
                    }
                    throw new AgentProviderProtocolError({
                        code: "PROVIDER_PROTOCOL_ERROR",
                        provider: this.provider,
                        agentId: context.agentId,
                        operation: "create_runtime",
                        retryable: false,
                        message: `${this.provider} ACP process did not expose stdio pipes.`,
                    });
                }
                let connection;
                child.stderr.setEncoding("utf8");
                let stderrTail = "";
                child.stderr.on("data", (chunk) => {
                    stderrTail = appendTail(stderrTail, chunk, MAX_ACP_STDERR_BYTES);
                });
                try {
                    const { client, methods, ndJsonStream } = await import("@agentclientprotocol/sdk");
                    const queues = new Map();
                    const sessionWriteModes = new Map();
                    const grokCompletionRegistry = this.provider === "grok"
                        ? new GrokPromptCompletionRegistry()
                        : undefined;
                    const app = client({ name: "DevSpace" })
                        .onRequest(methods.client.session.requestPermission, (context) => {
                        const writeMode = sessionWriteModes.get(context.params.sessionId);
                        const selected = selectAcpPermissionOption(context.params.options, writeMode, this.provider);
                        return selected
                            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
                            : { outcome: { outcome: "cancelled" } };
                    })
                        .onNotification(methods.client.session.update, (context) => {
                        const sessionId = context.params.sessionId;
                        const queue = queues.get(sessionId);
                        if (queue)
                            appendAcpQueueValue(queue, context.params);
                    });
                    if (grokCompletionRegistry) {
                        for (const method of [
                            "x.ai/session/prompt_complete",
                            "_x.ai/session/prompt_complete",
                            "x.ai/session/update",
                            "_x.ai/session/update",
                        ]) {
                            app.onNotification(method, parseGrokPromptCompletion, (context) => {
                                if (context.params)
                                    grokCompletionRegistry.resolve(context.params);
                            });
                        }
                    }
                    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
                    connection = app.connect(stream);
                    const init = await withTimeout(Promise.race([
                        connection.agent.request(methods.agent.initialize, {
                            protocolVersion: 1,
                            clientInfo: { name: "DevSpace", version: DEVSPACE_VERSION },
                            clientCapabilities: {},
                        }),
                        startupError.then((error) => { throw error; }),
                    ]), ACP_INITIALIZE_TIMEOUT_MS, `${this.provider} ACP initialize timed out.`);
                    const capabilities = readAcpCapabilities(init);
                    const runtime = new AcpRuntime({
                        provider: this.provider,
                        command,
                        args,
                        env: this.env,
                        child,
                        capabilities,
                        queues,
                        sessionWriteModes,
                        grokCompletionRegistry,
                    }, connection);
                    // AcpRuntime installs the long-lived child error listener before this
                    // startup-only listener is removed, so there is no unobserved gap.
                    child.removeListener("error", onStartupError);
                    return runtime;
                }
                catch (error) {
                    child.on("error", observeChildError);
                    child.removeListener("error", onStartupError);
                    try {
                        connection?.close(error);
                    }
                    catch {
                        // The child still needs to be terminated if the protocol failed early.
                    }
                    if (child.exitCode === null) {
                        const detached = process.platform !== "win32";
                        terminateProcessTree(child, "SIGTERM", detached);
                        if (!await waitForProcessExit(child, 1_000)) {
                            terminateProcessTree(child, "SIGKILL", detached);
                        }
                    }
                    if (isProgrammerDefect(error))
                        throw error;
                    throw new AgentProviderProtocolError({
                        code: "PROVIDER_PROTOCOL_ERROR",
                        provider: this.provider,
                        agentId: context.agentId,
                        operation: "create_runtime",
                        retryable: true,
                        cause: { error, stderr: stderrTail.trim() || undefined },
                        message: `${this.provider} ACP initialization failed.`,
                    });
                }
            },
        });
    }
    resolveCommand() {
        if (!this.commandResolved) {
            this.resolvedCommand = this.commandResolver(this.provider, this.env);
            this.commandResolved = true;
        }
        return this.resolvedCommand;
    }
}
async function waitForProcessExit(child, timeoutMs) {
    if (child.exitCode !== null)
        return true;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
        }, timeoutMs);
        timer.unref();
        const onExit = () => {
            clearTimeout(timer);
            resolve(true);
        };
        child.once("exit", onExit);
    });
}
export function resolveAcpCommand(provider, env = process.env) {
    const configured = provider === "cursor"
        ? env.CURSOR_COMMAND
        : provider === "copilot"
            ? env.COPILOT_COMMAND
            : env.GROK_COMMAND;
    const command = configured ?? ACP_COMMANDS[provider][0];
    if (command.includes("/") || command.includes("\\"))
        return executableExists(command) ? command : undefined;
    const path = env.PATH;
    if (!path)
        return undefined;
    const extensions = process.platform === "win32"
        ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
        : [""];
    for (const directory of path.split(delimiter)) {
        if (!directory)
            continue;
        for (const extension of extensions) {
            const candidate = resolve(directory, `${command}${extension}`);
            if (executableExists(candidate))
                return candidate;
        }
    }
    return undefined;
}
export function acpCommandArgs(provider, context, env = process.env) {
    const writeMode = context.writeMode ?? "allowed";
    if (provider === "cursor") {
        return [
            "acp",
            "--sandbox", writeMode === "full_access" ? "disabled" : "enabled",
            "--workspace", resolve(context.workspaceRoot),
            ...(writeMode === "read_only" ? ["--mode", "plan"] : []),
            ...(writeMode === "full_access" ? ["--force"] : []),
        ];
    }
    if (provider === "grok") {
        const agentProfile = env.GROK_AGENT_PROFILE?.trim();
        const effort = context.effort
            ? resolveGrokEffort(context.effort, undefined, undefined)
            : undefined;
        return [
            "agent",
            ...(agentProfile ? ["--agent-profile", agentProfile] : []),
            ...(effort ? ["--reasoning-effort", effort] : []),
            "stdio",
        ];
    }
    const sandboxArgs = writeMode === "full_access"
        ? ["--no-sandbox"]
        : ["--experimental", "--sandbox"];
    return [
        "--acp",
        ...sandboxArgs,
        ...(writeMode === "full_access"
            ? ["--allow-all"]
            : ["--allow-all-tools", "--add-dir", resolve(context.workspaceRoot)]),
        "-C", resolve(context.workspaceRoot),
        ...(writeMode === "read_only" ? ["--mode", "plan"] : []),
    ];
}
export function resolveAcpModelConfigUpdate(session, model, provider, sessionIdOverride) {
    return resolveAcpSelectConfigUpdate(session, {
        category: "model",
        label: "model",
        provider,
        value: model,
        sessionIdOverride,
    });
}
export function resolveAcpEffortConfigUpdate(session, effort, provider, sessionIdOverride) {
    return resolveAcpSelectConfigUpdate(session, {
        category: "thought_level",
        label: "reasoning effort option",
        provider,
        value: effort,
        sessionIdOverride,
    });
}
function resolveAcpSelectConfigUpdate(session, options) {
    const record = asRecord(session);
    if (!record)
        throw new Error(`${options.provider} ACP session metadata is missing.`);
    const sessionId = options.sessionIdOverride ?? directString(record?.sessionId);
    if (!sessionId)
        throw new Error(`${options.provider} ACP session did not return a session id.`);
    const response = asRecord(record?.newSessionResponse) ?? record;
    const configOptions = readArray(response, "configOptions") ?? [];
    const config = configOptions
        .map(asRecord)
        .find((option) => option?.type === "select" && option.category === options.category);
    if (!config)
        throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
    const configId = directString(config.id);
    if (!configId)
        throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);
    const available = flattenAcpSelectValues(config);
    if (!available.includes(options.value)) {
        const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
        throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
    }
    return { sessionId, configId, value: options.value };
}
export function flattenAcpSelectValues(option) {
    const values = [];
    for (const item of readArray(option, "options") ?? []) {
        const record = asRecord(item);
        const value = directString(record?.value);
        if (value) {
            values.push(value);
            continue;
        }
        for (const nested of readArray(record, "options") ?? []) {
            const nestedValue = directString(asRecord(nested)?.value);
            if (nestedValue)
                values.push(nestedValue);
        }
    }
    return values;
}
export function selectAcpAllowPermissionOption(options) {
    return selectAcpPermissionOption(options, "allowed");
}
export function selectAcpPermissionOption(options, writeMode, provider) {
    if (!writeMode)
        return undefined;
    // Copilot's native sandbox has a per-command escape hatch enabled by
    // default. Normal turns already pass --allow-all-tools, so any permission
    // request that reaches ACP is an attempted escalation (including a
    // sandbox bypass). Cancel it instead of turning an ACP approval into host
    // authority. Full access deliberately keeps the provider's unrestricted
    // behavior.
    if (provider === "copilot" && writeMode !== "full_access")
        return undefined;
    const selected = writeMode === "read_only"
        ? options.find((option) => option.kind === "reject_once")
            ?? options.find((option) => option.kind === "reject_always")
        : options.find((option) => option.kind === "allow_once")
            ?? options.find((option) => option.kind === "allow_always");
    return selected ? { optionId: selected.optionId } : undefined;
}
function readAcpCapabilities(value) {
    const capabilities = asRecord(asRecord(value)?.agentCapabilities);
    const sessions = asRecord(capabilities?.sessionCapabilities);
    return {
        resume: Boolean(sessions?.resume),
        close: Boolean(sessions?.close),
        additionalDirectories: Boolean(sessions?.additionalDirectories),
    };
}
function extractAcpText(updates) {
    return updates
        .map((value) => {
        const update = asRecord(asRecord(value)?.update);
        const content = asRecord(update?.content);
        return update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string"
            ? content.text
            : "";
    })
        .join("")
        .trim();
}
function isGrokPromptCompletion(value) {
    const record = asRecord(value);
    return typeof record?.sessionId === "string";
}
async function yieldToAcpQueue() {
    await new Promise((resolve) => setImmediate(resolve));
}
function hasAcpConfigOptions(value) {
    const record = asRecord(value);
    const response = asRecord(record?.newSessionResponse) ?? record;
    return Array.isArray(response?.configOptions);
}
function appendAcpQueueValue(queue, value) {
    if (queue.values.length >= MAX_ACP_QUEUE_ITEMS)
        queue.values.shift();
    queue.values.push(value);
}
function appendTail(current, chunk, maxBytes) {
    const next = current + chunk;
    if (Buffer.byteLength(next, "utf8") <= maxBytes)
        return next;
    return Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
}
function executableExists(command) {
    try {
        accessSync(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function readDevspaceVersion() {
    const packageJson = require("../package.json");
    if (typeof packageJson.version !== "string" || !packageJson.version) {
        throw new Error("Unable to read DevSpace package version.");
    }
    return packageJson.version;
}
function readArray(value, key) {
    const result = asRecord(value)?.[key];
    return Array.isArray(result) ? result : undefined;
}
function readString(value, key) {
    const result = asRecord(value)?.[key];
    return typeof result === "string" ? result : undefined;
}
function directString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
