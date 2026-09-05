import { AgentProviderProtocolError } from "./local-agent-errors.js";
export const GROK_DEFAULT_MODEL = "grok-build";
export const GROK_REASONING_EFFORTS = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];
const COMPLETED_PROMPT_ID_LIMIT = 128;
/**
 * Owns the one ordering-sensitive xAI completion bridge. Grok may resolve the
 * standard session/prompt request or emit its private completion notification;
 * whichever arrives first settles the turn, while duplicate and stale events
 * are bounded and ignored.
 */
export class GrokPromptCompletionRegistry {
    pending = new Map();
    completedPromptIds = [];
    wait(sessionId, promptId, timeoutMs, onTimeout) {
        const key = promptKey(sessionId, promptId);
        if (this.pending.has(key)) {
            throw new Error(`Grok prompt completion is already pending: ${promptId}`);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(key);
                reject(onTimeout());
            }, timeoutMs);
            timer.unref();
            this.pending.set(key, { sessionId, promptId, resolve, reject, timer });
        });
    }
    resolve(completion) {
        if (completion.promptId && this.completedPromptIds.includes(completion.promptId))
            return;
        const pending = completion.promptId
            ? this.pending.get(promptKey(completion.sessionId, completion.promptId))
            : findPendingForSession(this.pending, completion.sessionId);
        if (!pending)
            return;
        this.pending.delete(promptKey(pending.sessionId, pending.promptId));
        clearTimeout(pending.timer);
        this.rememberCompletedPromptId(completion.promptId ?? pending.promptId);
        pending.resolve({ ...completion, promptId: completion.promptId ?? pending.promptId });
    }
    remove(sessionId, promptId) {
        const key = promptKey(sessionId, promptId);
        const pending = this.pending.get(key);
        if (!pending)
            return;
        this.pending.delete(key);
        clearTimeout(pending.timer);
    }
    rejectAll(error) {
        const pending = Array.from(this.pending.values());
        this.pending.clear();
        for (const entry of pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
    }
    markCompleted(sessionId, promptId) {
        const key = promptKey(sessionId, promptId);
        const pending = this.pending.get(key);
        if (pending) {
            this.pending.delete(key);
            clearTimeout(pending.timer);
        }
        this.rememberCompletedPromptId(promptId);
    }
    get size() {
        return this.pending.size;
    }
    rememberCompletedPromptId(promptId) {
        if (this.completedPromptIds.includes(promptId))
            return;
        this.completedPromptIds.push(promptId);
        if (this.completedPromptIds.length > COMPLETED_PROMPT_ID_LIMIT) {
            this.completedPromptIds.splice(0, this.completedPromptIds.length - COMPLETED_PROMPT_ID_LIMIT);
        }
    }
}
export function parseGrokPromptCompletion(input) {
    const record = asRecord(input);
    const sessionId = directString(record?.sessionId);
    if (!sessionId)
        return undefined;
    const update = asRecord(record?.update);
    const sessionUpdate = directString(update?.sessionUpdate);
    if (update && sessionUpdate !== "turn_completed")
        return undefined;
    const promptId = firstString(record?.promptId, record?.requestId, update?.promptId, update?.requestId, asRecord(record?._meta)?.promptId, asRecord(update?._meta)?.promptId);
    if (promptId && isBackgroundPromptId(promptId))
        return undefined;
    return {
        sessionId,
        ...(promptId ? { promptId } : {}),
        ...((firstString(record?.stopReason, update?.stopReason))
            ? { stopReason: firstString(record?.stopReason, update?.stopReason) }
            : {}),
    };
}
export function readGrokSessionState(value) {
    const record = asRecord(value);
    const response = asRecord(record?.newSessionResponse) ?? record;
    const models = asRecord(response?.models)
        ?? asRecord(asRecord(response?._meta)?.modelState);
    if (!models)
        return undefined;
    const availableModels = (readArray(models.availableModels) ?? [])
        .map(readGrokModelInfo)
        .filter((model) => model !== undefined);
    return {
        currentModelId: directString(models.currentModelId),
        availableModels,
    };
}
export function normalizeGrokModelId(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return undefined;
    return trimmed.replace(/^(?:grok|xai)\//i, "");
}
export function resolveGrokModelId(requested, state) {
    const modelId = normalizeGrokModelId(requested);
    if (!modelId)
        throw grokConfigurationError("Grok model must not be empty.");
    const available = state?.availableModels ?? [];
    if (available.length > 0 && !available.some((model) => model.id === modelId)) {
        throw grokConfigurationError(`Grok does not support '${modelId}'. Available models: ${available.map((model) => model.id).join(", ")}.`);
    }
    return modelId;
}
export function resolveGrokEffort(effort, state, modelId) {
    const normalized = effort.trim().toLowerCase();
    if (!isGrokReasoningEffort(normalized)) {
        throw grokConfigurationError(`Grok reasoning effort must be one of: ${GROK_REASONING_EFFORTS.join(", ")}.`);
    }
    const selectedModel = state?.availableModels.find((model) => model.id === modelId);
    const availableEfforts = selectedModel?.reasoningEfforts ?? [];
    if (availableEfforts.length > 0 && !availableEfforts.includes(normalized)) {
        throw grokConfigurationError(`Grok model '${modelId ?? GROK_DEFAULT_MODEL}' does not support effort '${normalized}'. Available efforts: ${availableEfforts.join(", ")}.`);
    }
    return normalized;
}
function grokConfigurationError(message) {
    return new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: "grok",
        operation: "configure_session",
        retryable: false,
        message,
    });
}
export function isGrokReasoningEffort(value) {
    return GROK_REASONING_EFFORTS.includes(value);
}
function readGrokModelInfo(value) {
    const record = asRecord(value);
    const id = directString(record?.modelId) ?? directString(record?.id);
    if (!id)
        return undefined;
    const modelMeta = asRecord(record?._meta);
    const reasoningEfforts = (readArray(modelMeta?.reasoningEfforts) ?? [])
        .flatMap((entry) => {
        const effort = asRecord(entry);
        return [directString(effort?.id), directString(effort?.value)].filter((value) => value !== undefined);
    })
        .filter((effort, index, values) => values.indexOf(effort) === index);
    return { id, reasoningEfforts };
}
function findPendingForSession(pending, sessionId) {
    return Array.from(pending.values()).find((entry) => entry.sessionId === sessionId);
}
function promptKey(sessionId, promptId) {
    return `${sessionId}\u0000${promptId}`;
}
function isBackgroundPromptId(promptId) {
    return /^(?:task|subagent|background)(?:-|_)/i.test(promptId)
        || /^task-completed-/i.test(promptId);
}
function firstString(...values) {
    for (const value of values) {
        const result = directString(value);
        if (result)
            return result;
    }
    return undefined;
}
function readArray(value) {
    return Array.isArray(value) ? value : undefined;
}
function directString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
