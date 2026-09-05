import { AgentProviderProtocolError, AgentProviderUnavailableError, captureAgentProviderResult, } from "./local-agent-errors.js";
const OPENCODE_SESSION_POLL_INTERVAL_MS = 250;
const OPENCODE_SESSION_POLL_TIMEOUT_MS = 5 * 60_000;
export class OpencodeRuntime {
    client;
    server;
    provider = "opencode";
    alive = true;
    closed = false;
    constructor(client, server) {
        this.client = client;
        this.server = server;
    }
    async run(input, callbacks) {
        return captureAgentProviderResult({
            provider: this.provider,
            operation: "run",
            run: async () => {
                if (!this.alive) {
                    throw new AgentProviderUnavailableError({
                        code: "PROVIDER_UNAVAILABLE",
                        provider: this.provider,
                        operation: "run",
                        retryable: true,
                        message: "OpenCode runtime is not running.",
                    });
                }
                try {
                    await assertOpencodeHealthy(this.client);
                    const resumed = Boolean(input.providerSessionId);
                    const initialModel = input.model ? parseOpencodeModel(input.model, input.effort) : undefined;
                    const sessionId = input.providerSessionId ?? await createOpencodeSession(this.client, input, initialModel);
                    await callbacks?.onSessionId?.(sessionId);
                    await this.client.v2.session.switchAgent({
                        sessionID: sessionId,
                        agent: opencodeAgentFor(input.writeMode),
                    }, { throwOnError: true });
                    const model = initialModel ?? (input.effort ? await modelWithEffort(this.client, sessionId, input.effort) : undefined);
                    if (model && (resumed || !initialModel)) {
                        await this.client.v2.session.switchModel({ sessionID: sessionId, model }, { throwOnError: true });
                    }
                    const promptResult = await promptOpencodeSession(this.client, sessionId, input);
                    await waitForOpencodeSession(this.client, sessionId, promptResult);
                    const promptId = extractOpenCodePromptId(promptResult);
                    const messages = await readOpencodeMessages(this.client, sessionId, promptId);
                    const finalResponse = requireFinalResponse(extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult));
                    return {
                        provider: this.provider,
                        providerSessionId: sessionId,
                        finalResponse,
                        items: [promptResult, messages],
                    };
                }
                catch (error) {
                    if (isOpenCodeTransportFailure(error)) {
                        this.alive = false;
                        throw new AgentProviderUnavailableError({
                            code: "PROVIDER_UNAVAILABLE",
                            provider: this.provider,
                            operation: "run",
                            retryable: true,
                            cause: error,
                            message: "OpenCode provider is unavailable.",
                        });
                    }
                    throw error;
                }
            },
        });
    }
    async releaseSession(_providerSessionId) {
        // OpenCode keeps durable sessions independently of this process.
    }
    isAlive() {
        return this.alive && !this.closed;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.alive = false;
        this.server.close();
    }
}
export class OpencodeLocalAgentDriver {
    factory;
    provider = "opencode";
    idleTimeoutMs = 5 * 60_000;
    constructor(factory = defaultOpencodeFactory) {
        this.factory = factory;
    }
    runtimeKey(_context) {
        return "opencode:default";
    }
    async createRuntime(context) {
        return captureAgentProviderResult({
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            run: async () => {
                const { client, server } = await this.factory(context);
                return new OpencodeRuntime(client, server);
            },
        });
    }
}
async function defaultOpencodeFactory() {
    const { createOpencode } = await import("@opencode-ai/sdk/v2");
    return createOpencode({ config: {
            agent: {
                devspace_read_only: opencodeAgentConfig("read_only"),
                devspace_allowed: opencodeAgentConfig("allowed"),
                devspace_full_access: opencodeAgentConfig("full_access"),
            },
        } });
}
export function opencodeAgentConfig(writeMode) {
    return {
        mode: "primary",
        permission: opencodePermissionFor(writeMode),
    };
}
async function createOpencodeSession(client, input, model) {
    const result = await client.v2.session.create({
        location: { directory: input.workspaceRoot },
        agent: opencodeAgentFor(input.writeMode),
        ...(model ? { model } : {}),
    }, { throwOnError: true });
    return requireSessionId(result.data.data);
}
export function opencodeAgentFor(writeMode) {
    switch (writeMode) {
        case "read_only": return "devspace_read_only";
        case "full_access": return "devspace_full_access";
        case "allowed":
        case undefined: return "devspace_allowed";
    }
}
export function opencodePermissionFor(writeMode) {
    const allowed = writeMode !== "read_only";
    const unrestricted = writeMode === "full_access";
    return {
        read: "allow",
        edit: allowed ? "allow" : "deny",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: allowed ? "allow" : "deny",
        task: "deny",
        external_directory: unrestricted ? "allow" : "deny",
    };
}
async function assertOpencodeHealthy(client) {
    const health = client.v2.health;
    if (!health)
        return;
    try {
        await health.get({ throwOnError: true });
    }
    catch (error) {
        throw new OpencodeHealthError(errorMessage(error));
    }
}
function isOpenCodeTransportFailure(error) {
    if (error instanceof OpencodeHealthError)
        return true;
    const code = transportErrorCode(error);
    return code === "ECONNREFUSED"
        || code === "ECONNRESET"
        || code === "EPIPE"
        || code === "ENETDOWN"
        || code === "ENETUNREACH"
        || code === "ETIMEDOUT";
}
function transportErrorCode(error) {
    if (!error || typeof error !== "object")
        return undefined;
    const code = error.code;
    if (typeof code === "string")
        return code;
    const cause = error.cause;
    return cause && typeof cause === "object" && typeof cause.code === "string"
        ? cause.code
        : undefined;
}
class OpencodeHealthError extends Error {
    constructor(message) {
        super(`OpenCode server health check failed: ${message}`);
        this.name = "OpencodeHealthError";
    }
}
async function modelWithEffort(client, sessionId, effort) {
    const result = await client.v2.session.get({ sessionID: sessionId }, { throwOnError: true });
    const model = result.data.data.model;
    if (!model) {
        throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: "opencode",
            operation: "resolve_model",
            retryable: false,
            message: "OpenCode did not return the current session model for an effort override.",
        });
    }
    return { ...model, variant: effort };
}
async function promptOpencodeSession(client, sessionId, input) {
    const prompt = { text: input.prompt };
    return client.v2.session.prompt({
        sessionID: sessionId,
        prompt,
    }, { throwOnError: true });
}
async function waitForOpencodeSession(client, sessionId, promptResult) {
    // OpenCode 1.18 accepts the prompt before its foreground drain is ready.
    // Its wait endpoint rejects that state and can keep rejecting after the
    // session has completed, so use the v2 active-session lifecycle instead.
    const active = typeof client.v2.session.active === "function"
        ? client.v2.session.active.bind(client.v2.session)
        : undefined;
    if (!active) {
        await client.v2.session.wait({ sessionID: sessionId }, { throwOnError: true });
        return;
    }
    const promptId = extractOpenCodePromptId(promptResult);
    const deadline = Date.now() + OPENCODE_SESSION_POLL_TIMEOUT_MS;
    let observedActive = false;
    while (true) {
        const messages = await readOpencodeMessages(client, sessionId, promptId);
        const activity = await active({ throwOnError: true });
        const running = isOpenCodeSessionActive(activity, sessionId);
        if (running)
            observedActive = true;
        const completed = hasCompletedOpenCodeTurn(messages, promptId);
        if (completed && (promptId !== undefined || (observedActive && !running)))
            return;
        if (Date.now() >= deadline) {
            throw new AgentProviderProtocolError({
                code: "PROVIDER_PROTOCOL_ERROR",
                provider: "opencode",
                operation: "wait_for_session",
                retryable: false,
                message: "OpenCode did not finish the session before the provider timeout.",
            });
        }
        await delay(OPENCODE_SESSION_POLL_INTERVAL_MS);
    }
}
async function readOpencodeMessages(client, sessionId, promptId) {
    const messages = [];
    const seenCursors = new Set();
    let cursor;
    while (true) {
        const result = await client.v2.session.messages({
            sessionID: sessionId,
            limit: 100,
            ...(cursor ? { cursor } : { order: "asc" }),
        }, { throwOnError: true });
        const page = result.data;
        messages.push(...page.data);
        // A prompt-specific read can stop as soon as the submitted turn is
        // complete. Reads without a prompt id still walk the full history because
        // they are used to extract the final response after the wait fallback.
        if (promptId !== undefined && hasCompletedOpenCodeTurn({ data: messages }, promptId)) {
            break;
        }
        const nextCursor = page.cursor?.next;
        if (!nextCursor || seenCursors.has(nextCursor))
            break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
    }
    return { data: messages, cursor: {} };
}
function extractOpenCodePromptId(value) {
    const id = asRecord(unwrapProviderPayload(value))?.id;
    return typeof id === "string" ? id : undefined;
}
function isOpenCodeSessionActive(value, sessionId) {
    const activeSessions = asRecord(unwrapProviderPayload(value));
    return activeSessions?.[sessionId] !== undefined;
}
function hasCompletedOpenCodeTurn(value, promptId) {
    const root = unwrapProviderPayload(value);
    const messages = Array.isArray(root) ? root : readArray(root, "messages");
    if (!messages)
        return false;
    let promptSeen = promptId === undefined;
    for (const message of messages) {
        const record = asRecord(message);
        if (!record)
            continue;
        const info = asRecord(record.info) ?? record;
        const role = typeof info.role === "string" ? info.role : record.type;
        if (promptId !== undefined && info.id === promptId && role === "user") {
            promptSeen = true;
            continue;
        }
        if (!promptSeen || role !== "assistant")
            continue;
        const time = asRecord(info.time) ?? asRecord(record.time);
        if (typeof info.finish === "string" || typeof record.finish === "string")
            return true;
        if (typeof time?.completed === "number")
            return true;
        if (info.error !== undefined || record.error !== undefined)
            return true;
    }
    return false;
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function parseOpencodeModel(model, variant) {
    const separator = model.indexOf("/");
    const reference = separator === -1
        ? { providerID: "opencode", id: model }
        : { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
    return variant ? { ...reference, variant } : reference;
}
function requireSessionId(session) {
    if (!session.id) {
        throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: "opencode",
            operation: "create_session",
            retryable: false,
            message: "OpenCode did not return a session id.",
        });
    }
    return session.id;
}
export function extractOpenCodeFinalResponse(value) {
    const root = unwrapProviderPayload(value);
    const messages = Array.isArray(root) ? root : readArray(root, "messages");
    if (messages)
        return extractLastOpenCodeAssistantMessageText(messages);
    return extractOpenCodeAssistantMessageText(root);
}
function extractLastOpenCodeAssistantMessageText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asRecord(messages[index]);
        if (!message)
            continue;
        const info = asRecord(message.info);
        const role = typeof info?.role === "string" ? info.role : message.role;
        const type = typeof message.type === "string" ? message.type : undefined;
        if (role !== "assistant" && type !== "assistant")
            continue;
        const text = extractOpenCodeAssistantMessageText(message);
        if (text)
            return text;
    }
    return "";
}
function extractOpenCodeAssistantMessageText(value) {
    const message = asRecord(value);
    if (!message)
        return "";
    for (const key of ["content", "parts"]) {
        const parts = readArray(message, key);
        if (!parts)
            continue;
        const text = parts
            .map((part) => {
            const record = asRecord(part);
            return record?.type === "text" && typeof record.text === "string" ? record.text : "";
        })
            .filter(Boolean)
            .join("");
        if (text.trim())
            return text.trim();
    }
    const info = asRecord(message.info) ?? message;
    return stringifyStructuredMessage(info.structured);
}
function stringifyStructuredMessage(value) {
    if (value === undefined || value === null)
        return "";
    if (typeof value === "string")
        return value.trim();
    return JSON.stringify(value);
}
function unwrapProviderPayload(value) {
    let current = value;
    for (let depth = 0; depth < 3; depth += 1) {
        const record = asRecord(current);
        if (!record)
            return current;
        if (record.data !== undefined) {
            current = record.data;
            continue;
        }
        if (record.result !== undefined) {
            current = record.result;
            continue;
        }
        return current;
    }
    return current;
}
function readArray(value, key) {
    const result = asRecord(value)?.[key];
    return Array.isArray(result) ? result : undefined;
}
function readNestedString(value, path) {
    let current = value;
    for (const key of path)
        current = asRecord(current)?.[key];
    return typeof current === "string" ? current : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function requireFinalResponse(response) {
    const trimmed = response.trim();
    if (!trimmed) {
        throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: "opencode",
            operation: "run",
            retryable: false,
            message: "OpenCode did not return a final assistant response.",
        });
    }
    return trimmed;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
