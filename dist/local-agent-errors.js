import { matchError, Result, TaggedError, } from "better-result";
import { isLocalAgentProvider, } from "./local-agent-profiles.js";
export class AgentTargetError extends TaggedError("AgentTargetError")() {
}
export class AgentConflictError extends TaggedError("AgentConflictError")() {
}
export class AgentScopeError extends TaggedError("AgentScopeError")() {
}
export class AgentProviderUnavailableError extends TaggedError("AgentProviderUnavailableError")() {
}
export class AgentProviderCancelledError extends TaggedError("AgentProviderCancelledError")() {
}
export class AgentProviderProtocolError extends TaggedError("AgentProviderProtocolError")() {
}
export class AgentProviderExecutionError extends TaggedError("AgentProviderExecutionError")() {
}
export class AgentDaemonUnavailableError extends TaggedError("AgentDaemonUnavailableError")() {
}
export class AgentDaemonStartupError extends TaggedError("AgentDaemonStartupError")() {
}
export class AgentDaemonTimeoutError extends TaggedError("AgentDaemonTimeoutError")() {
}
export class AgentDaemonProtocolMismatchError extends TaggedError("AgentDaemonProtocolMismatchError")() {
}
export class AgentDaemonUnauthorizedError extends TaggedError("AgentDaemonUnauthorizedError")() {
}
export class AgentDaemonInvalidRequestError extends TaggedError("AgentDaemonInvalidRequestError")() {
}
export class AgentDaemonInvalidResponseError extends TaggedError("AgentDaemonInvalidResponseError")() {
}
export class AgentDaemonInternalError extends TaggedError("AgentDaemonInternalError")() {
}
export class AgentStoreError extends TaggedError("AgentStoreError")() {
    constructor(operation, cause, message) {
        super({
            code: "AGENT_STORE_ERROR",
            operation,
            retryable: false,
            cause,
            message: message ?? `Subagent persistence operation failed: ${operation}.`,
        });
    }
}
export function isAgentProviderError(error) {
    return AgentProviderUnavailableError.is(error)
        || AgentProviderCancelledError.is(error)
        || AgentProviderProtocolError.is(error)
        || AgentProviderExecutionError.is(error);
}
export function isAgentDaemonError(error) {
    return AgentDaemonUnavailableError.is(error)
        || AgentDaemonStartupError.is(error)
        || AgentDaemonTimeoutError.is(error)
        || AgentDaemonProtocolMismatchError.is(error)
        || AgentDaemonUnauthorizedError.is(error)
        || AgentDaemonInvalidRequestError.is(error)
        || AgentDaemonInvalidResponseError.is(error)
        || AgentDaemonInternalError.is(error);
}
export function isLocalAgentError(error) {
    return AgentTargetError.is(error)
        || AgentConflictError.is(error)
        || AgentScopeError.is(error)
        || isAgentProviderError(error)
        || AgentStoreError.is(error)
        || isAgentDaemonError(error);
}
export function toAgentErrorPayload(error) {
    return matchError(error, {
        AgentTargetError: targetErrorPayload,
        AgentConflictError: conflictErrorPayload,
        AgentScopeError: scopeErrorPayload,
        AgentProviderUnavailableError: providerErrorPayload,
        AgentProviderCancelledError: providerErrorPayload,
        AgentProviderProtocolError: providerErrorPayload,
        AgentProviderExecutionError: providerErrorPayload,
        AgentDaemonUnavailableError: daemonErrorPayload,
        AgentDaemonStartupError: daemonErrorPayload,
        AgentDaemonTimeoutError: daemonErrorPayload,
        AgentDaemonProtocolMismatchError: daemonErrorPayload,
        AgentDaemonUnauthorizedError: daemonErrorPayload,
        AgentDaemonInvalidRequestError: daemonErrorPayload,
        AgentDaemonInvalidResponseError: daemonErrorPayload,
        AgentDaemonInternalError: daemonErrorPayload,
        AgentStoreError: storeErrorPayload,
    });
}
export function agentErrorFromPayload(payload) {
    const retryable = payload.retryable ?? false;
    const provider = payload.provider && isLocalAgentProvider(payload.provider)
        ? payload.provider
        : undefined;
    switch (payload.code) {
        case "UNKNOWN_TARGET":
        case "AGENT_NOT_FOUND":
        case "PROVIDER_DISABLED":
        case "PROVIDER_NOT_CONFIGURED":
        case "TARGET_RESOLUTION_FAILED":
            return new AgentTargetError({
                code: payload.code,
                target: payload.target ?? payload.agentId ?? payload.provider ?? "unknown",
                provider,
                operation: payload.operation,
                retryable,
                message: payload.message,
            });
        case "AGENT_CONFLICT":
            return new AgentConflictError({
                code: payload.code,
                agentId: payload.agentId,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        case "WORKSPACE_MISMATCH":
        case "WORKSPACE_NOT_ALLOWED":
        case "WORKSPACE_SCOPE_REQUIRED":
            return new AgentScopeError({
                code: payload.code,
                agentId: payload.agentId,
                workspaceId: payload.workspaceId,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        case "PROVIDER_UNAVAILABLE":
        case "PROVIDER_CANCELLED":
        case "PROVIDER_PROTOCOL_ERROR":
        case "PROVIDER_EXECUTION_ERROR": {
            if (!provider)
                return undefined;
            const fields = {
                provider,
                agentId: payload.agentId,
                operation: payload.operation ?? "run",
                retryable,
                message: payload.message,
            };
            if (payload.code === "PROVIDER_UNAVAILABLE") {
                return new AgentProviderUnavailableError({ code: payload.code, ...fields });
            }
            if (payload.code === "PROVIDER_CANCELLED") {
                return new AgentProviderCancelledError({ code: payload.code, ...fields });
            }
            if (payload.code === "PROVIDER_PROTOCOL_ERROR") {
                return new AgentProviderProtocolError({ code: payload.code, ...fields });
            }
            return new AgentProviderExecutionError({ code: payload.code, ...fields });
        }
        case "AGENT_STORE_ERROR":
            return new AgentStoreError(payload.operation ?? "request", undefined, payload.message);
        case "DAEMON_UNAVAILABLE":
            return new AgentDaemonUnavailableError({
                code: payload.code,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        case "DAEMON_STARTUP_FAILURE":
            return new AgentDaemonStartupError({
                code: payload.code,
                operation: payload.operation ?? "startup",
                retryable,
                message: payload.message,
            });
        case "DAEMON_TIMEOUT":
            return new AgentDaemonTimeoutError({
                code: payload.code,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        case "DAEMON_PROTOCOL_MISMATCH":
            return new AgentDaemonProtocolMismatchError({
                code: payload.code,
                operation: payload.operation ?? "hello",
                retryable,
                message: payload.message,
            });
        case "DAEMON_UNAUTHORIZED":
            return new AgentDaemonUnauthorizedError({
                code: payload.code,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        case "DAEMON_INVALID_REQUEST":
            return new AgentDaemonInvalidRequestError({
                code: payload.code,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        case "DAEMON_INVALID_RESPONSE":
            return new AgentDaemonInvalidResponseError({
                code: payload.code,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        case "DAEMON_INTERNAL_ERROR":
            return new AgentDaemonInternalError({
                code: payload.code,
                operation: payload.operation ?? "request",
                retryable,
                message: payload.message,
            });
        default:
            return undefined;
    }
}
export function providerErrorFromCause(input) {
    if (isAgentProviderError(input.cause))
        return input.cause;
    if (isLocalAgentError(input.cause))
        return undefined;
    const unavailable = unavailableCauseKind(input.cause);
    if (unavailable) {
        return new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: input.provider,
            agentId: input.agentId,
            operation: input.operation,
            retryable: unavailable === "transient",
            cause: input.cause,
            message: `${displayProvider(input.provider)} provider is unavailable.`,
        });
    }
    if (isProgrammerDefect(input.cause))
        return undefined;
    if (isAbortError(input.cause)) {
        return new AgentProviderCancelledError({
            code: "PROVIDER_CANCELLED",
            provider: input.provider,
            agentId: input.agentId,
            operation: input.operation,
            retryable: false,
            cause: input.cause,
            message: `${displayProvider(input.provider)} agent turn was cancelled.`,
        });
    }
    return new AgentProviderExecutionError({
        code: "PROVIDER_EXECUTION_ERROR",
        provider: input.provider,
        agentId: input.agentId,
        operation: input.operation,
        retryable: false,
        cause: input.cause,
        message: `${displayProvider(input.provider)} agent execution failed.`,
    });
}
export async function captureAgentProviderResult(input) {
    try {
        return Result.ok(await input.run());
    }
    catch (cause) {
        const error = providerErrorFromCause({
            provider: input.provider,
            agentId: input.agentId,
            operation: input.operation,
            cause,
        });
        if (!error)
            throw cause;
        return Result.err(error);
    }
}
export function isProgrammerDefect(error) {
    if (unavailableCauseKind(error))
        return false;
    return error instanceof TypeError
        || error instanceof ReferenceError
        || error instanceof SyntaxError
        || error instanceof RangeError
        || (error instanceof Error && error.name === "AssertionError");
}
function isAbortError(error) {
    return Boolean(error
        && typeof error === "object"
        && "name" in error
        && String(error.name) === "AbortError");
}
function unavailableCauseKind(error) {
    const seen = new Set();
    let current = error;
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const code = "code" in current ? String(current.code) : "";
        if (code === "ENOENT")
            return "permanent";
        if (code === "ECONNREFUSED" || code === "ENOTFOUND")
            return "transient";
        current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
}
function displayProvider(provider) {
    switch (provider) {
        case "codex": return "Codex";
        case "claude": return "Claude";
        case "opencode": return "OpenCode";
        case "pi": return "Pi";
        case "cursor": return "Cursor";
        case "copilot": return "Copilot";
        case "grok": return "Grok";
    }
}
function targetErrorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        target: error.target,
        ...(error.provider ? { provider: error.provider } : {}),
        ...(error.operation ? { operation: error.operation } : {}),
    };
}
function conflictErrorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        operation: error.operation,
        ...(error.agentId ? { agentId: error.agentId } : {}),
    };
}
function scopeErrorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        operation: error.operation,
        ...(error.agentId ? { agentId: error.agentId } : {}),
        ...(error.workspaceId ? { workspaceId: error.workspaceId } : {}),
    };
}
function providerErrorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        provider: error.provider,
        operation: error.operation,
        ...(error.agentId ? { agentId: error.agentId } : {}),
    };
}
function daemonErrorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        operation: error.operation,
    };
}
function storeErrorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        operation: error.operation,
    };
}
