import { join } from "node:path";
import { AgentProviderExecutionError, AgentProviderProtocolError, AgentProviderUnavailableError, captureAgentProviderResult, } from "./local-agent-errors.js";
import { createPiSandboxExtension, createPiSandboxModeRef, registerPiSandboxSession, releasePiSandboxSession, updatePiSandboxSession, } from "./local-agent-pi-sandbox.js";
const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const PI_WORKSPACE_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
const PI_FULL_ACCESS_TOOLS = [...PI_WORKSPACE_TOOLS];
const MAX_PI_EVENTS = 10_000;
export class PiSessionRuntime {
    session;
    provider = "pi";
    unsubscribe;
    alive = true;
    closed = false;
    collectingEvents = false;
    events = [];
    constructor(session) {
        this.session = session;
        this.unsubscribe = session.subscribe((event) => {
            if (!this.collectingEvents)
                return;
            if (this.events.length >= MAX_PI_EVENTS)
                this.events.shift();
            this.events.push(event);
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
                        message: "Pi runtime is not running.",
                    });
                }
                await callbacks?.onSessionId?.(this.session.sessionId);
                await this.applyOverrides(input);
                this.events = [];
                const messageStart = this.session.messages.length;
                this.collectingEvents = true;
                try {
                    await this.session.prompt(input.prompt);
                }
                finally {
                    this.collectingEvents = false;
                }
                const currentMessages = this.session.messages.slice(messageStart);
                const finalResponse = extractPiFinalResponse({ messages: currentMessages });
                if (!finalResponse) {
                    const providerError = extractPiProviderError(this.events) || extractPiProviderError(currentMessages);
                    if (providerError) {
                        throw new AgentProviderExecutionError({
                            code: "PROVIDER_EXECUTION_ERROR",
                            provider: this.provider,
                            operation: "run",
                            retryable: false,
                            cause: new Error(providerError),
                            message: "Pi agent turn failed.",
                        });
                    }
                    throw new AgentProviderProtocolError({
                        code: "PROVIDER_PROTOCOL_ERROR",
                        provider: this.provider,
                        operation: "run",
                        retryable: false,
                        message: "Pi did not return a final assistant response.",
                    });
                }
                return {
                    provider: this.provider,
                    providerSessionId: this.session.sessionId,
                    finalResponse,
                    items: [...this.events, ...currentMessages],
                };
            },
        });
    }
    async releaseSession(_providerSessionId) {
        // The runtime is already scoped to one logical Pi session.
    }
    isAlive() {
        return this.alive && !this.closed;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.alive = false;
        this.unsubscribe();
        try {
            await releasePiSandboxSession(this.session);
        }
        finally {
            this.session.dispose();
        }
    }
    async applyOverrides(input) {
        await updatePiSandboxSession(this.session, input.workspaceRoot, input.writeMode ?? "allowed");
        this.session.setActiveToolsByName([...piToolsForWriteMode(input.writeMode)]);
        if (input.model) {
            const model = resolvePiModel(this.session.modelRegistry, input.model);
            if (!model) {
                throw new AgentProviderProtocolError({
                    code: "PROVIDER_PROTOCOL_ERROR",
                    provider: "pi",
                    operation: "configure_model",
                    retryable: false,
                    message: `Pi model not found: ${input.model}.`,
                });
            }
            await this.session.setModel(model);
        }
        if (input.effort) {
            this.session.setThinkingLevel(input.effort);
        }
    }
}
export class PiLocalAgentDriver {
    factory;
    provider = "pi";
    idleTimeoutMs = 3 * 60_000;
    constructor(factory = defaultPiSessionFactory) {
        this.factory = factory;
    }
    runtimeKey(context) {
        return `pi:${context.agentId}`;
    }
    async createRuntime(context) {
        return captureAgentProviderResult({
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            run: async () => {
                const input = {
                    prompt: "",
                    workspaceRoot: context.workspaceRoot,
                    providerSessionId: context.providerSessionId,
                    writeMode: context.writeMode,
                    model: context.model,
                    effort: context.effort,
                };
                const session = await this.factory(context, input);
                return new PiSessionRuntime(session);
            },
        });
    }
}
async function defaultPiSessionFactory(context, input) {
    const { AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader, createAgentSession, getAgentDir, } = await import("@earendil-works/pi-coding-agent");
    // DevSpace's agentDir is the compatibility directory used for instructions;
    // Pi keeps its own native auth, model, and session state under getAgentDir().
    const agentDir = getAgentDir();
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const sessionManager = await resolveSessionManager(SessionManager, input.workspaceRoot, input.providerSessionId);
    const model = input.model ? resolvePiModel(modelRegistry, input.model) : undefined;
    if (input.model && !model) {
        throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: "pi",
            agentId: context.agentId,
            operation: "configure_model",
            retryable: false,
            message: `Pi model not found: ${input.model}.`,
        });
    }
    const modeRef = createPiSandboxModeRef(input.writeMode ?? "allowed");
    const resourceLoader = new DefaultResourceLoader({
        cwd: input.workspaceRoot,
        agentDir,
        extensionFactories: [createPiSandboxExtension(input.workspaceRoot, modeRef)],
    });
    let session;
    try {
        const result = await createAgentSession({
            cwd: input.workspaceRoot,
            agentDir,
            authStorage,
            modelRegistry,
            sessionManager: sessionManager,
            resourceLoader,
            ...(model ? { model: model } : {}),
            ...(input.effort ? { thinkingLevel: input.effort } : {}),
            // Keep the full built-in registry available so warm turns can narrow or
            // broaden active tools without recreating the session.
            tools: [...PI_FULL_ACCESS_TOOLS],
        });
        session = result.session;
        await registerPiSandboxSession(session, input.workspaceRoot, modeRef, input.writeMode ?? "allowed");
        session.setActiveToolsByName([...piToolsForWriteMode(input.writeMode)]);
        return session;
    }
    catch (error) {
        if (session) {
            try {
                await releasePiSandboxSession(session);
            }
            finally {
                session.dispose();
            }
        }
        throw error;
    }
}
export function piToolsForWriteMode(writeMode) {
    switch (writeMode) {
        case "read_only": return PI_READ_ONLY_TOOLS;
        case "full_access": return PI_FULL_ACCESS_TOOLS;
        case "allowed":
        case undefined:
            return PI_WORKSPACE_TOOLS;
    }
}
async function resolveSessionManager(SessionManager, workspaceRoot, providerSessionId) {
    if (!providerSessionId)
        return SessionManager.create(workspaceRoot);
    const sessions = await SessionManager.list(workspaceRoot);
    const match = sessions.find((session) => session.id === providerSessionId);
    if (!match) {
        throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: "pi",
            operation: "session",
            retryable: false,
            message: `Pi session not found: ${providerSessionId}.`,
        });
    }
    return SessionManager.open(match.path);
}
function resolvePiModel(registry, reference) {
    const separator = reference.indexOf("/");
    if (separator !== -1) {
        return registry.find(reference.slice(0, separator), reference.slice(separator + 1));
    }
    const all = registry.getAll?.() ?? [];
    return all.find((model) => asRecord(model)?.id === reference);
}
export function extractPiFinalResponse(value) {
    const root = unwrapProviderPayload(value);
    const messages = Array.isArray(root) ? root : readArray(root, "messages");
    if (!messages)
        return "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asRecord(messages[index]);
        if (!message || message.role !== "assistant")
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            continue;
        const text = content
            .map((part) => {
            const record = asRecord(part);
            return record?.type === "text" && typeof record.text === "string" ? record.text : "";
        })
            .filter(Boolean)
            .join("\n\n")
            .trim();
        if (text)
            return text;
    }
    return "";
}
export function extractPiProviderError(value) {
    const root = unwrapProviderPayload(value);
    if (Array.isArray(root)) {
        for (let index = root.length - 1; index >= 0; index -= 1) {
            const error = extractPiProviderError(root[index]);
            if (error)
                return error;
        }
        return "";
    }
    const messages = readArray(root, "messages");
    if (messages)
        return extractPiProviderError(messages);
    const record = asRecord(asRecord(root)?.message ?? root);
    if (!record)
        return "";
    const error = record.errorMessage ?? record.error;
    return typeof error === "string" ? error.trim() : "";
}
function unwrapProviderPayload(value) {
    const record = asRecord(value);
    return record ? record.data ?? record.result ?? value : value;
}
function readArray(value, key) {
    const result = asRecord(value)?.[key];
    return Array.isArray(result) ? result : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
