import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";
export function encodeLocalAgentDaemonRequest(request) {
    return `${JSON.stringify(request)}\n`;
}
export function encodeLocalAgentDaemonResponse(response) {
    return `${JSON.stringify(response)}\n`;
}
export function decodeLocalAgentDaemonRequest(value) {
    const record = asRecord(value);
    const requestId = requiredString(record?.requestId, "requestId");
    const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
    const authToken = requiredString(record?.authToken, "authToken");
    const method = requiredString(record?.method, "method");
    const params = record?.params;
    switch (method) {
        case "hello":
        case "daemon.status":
        case "daemon.stop":
            return { requestId, protocolVersion, authToken, method, params: decodeEmptyParams(params) };
        case "agent.start":
            return {
                requestId,
                protocolVersion,
                authToken,
                method,
                params: decodeStartInput(params),
            };
        case "agent.continue":
            return {
                requestId,
                protocolVersion,
                authToken,
                method,
                params: decodeContinueInput(params),
            };
        case "agent.get":
            return {
                requestId,
                protocolVersion,
                method,
                authToken,
                params: {
                    id: requiredString(asRecord(params)?.id, "id"),
                    scope: decodeWorkspaceScope(asRecord(params)?.scope),
                },
            };
        case "agent.list":
            return {
                requestId,
                protocolVersion,
                authToken,
                method,
                params: decodeListScope(params),
            };
        case "daemon.logs":
            return {
                requestId,
                protocolVersion,
                authToken,
                method,
                params: decodeLogsParams(params),
            };
        default:
            throw new LocalAgentDaemonProtocolError("UNKNOWN_METHOD", `Unknown daemon method: ${method}`);
    }
}
export function decodeLocalAgentDaemonResponse(value) {
    const record = asRecord(value);
    const requestId = requiredString(record?.requestId, "requestId");
    const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
    if (record?.ok === true) {
        return { requestId, protocolVersion, ok: true, result: record.result };
    }
    if (record?.ok === false) {
        const error = asRecord(record.error);
        return {
            requestId,
            protocolVersion,
            ok: false,
            error: {
                code: requiredString(error?.code, "error.code"),
                message: requiredString(error?.message, "error.message"),
                retryable: optionalBoolean(error?.retryable),
                provider: optionalString(error?.provider),
                agentId: optionalString(error?.agentId),
                workspaceId: optionalString(error?.workspaceId),
                operation: optionalString(error?.operation),
                target: optionalString(error?.target),
            },
        };
    }
    throw new LocalAgentDaemonProtocolError("INVALID_RESPONSE", "Daemon returned an invalid response.");
}
export function decodeAgentRecord(value) {
    const record = asRecord(value);
    const status = requiredString(record?.status, "status");
    if (!isLocalAgentStatus(status))
        throw new LocalAgentDaemonProtocolError("INVALID_RECORD", "Invalid agent status.");
    return {
        id: requiredString(record?.id, "id"),
        workspaceId: optionalString(record?.workspaceId),
        workspaceRoot: requiredString(record?.workspaceRoot, "workspaceRoot"),
        profileName: requiredString(record?.profileName, "profileName"),
        provider: requiredString(record?.provider, "provider"),
        model: optionalString(record?.model),
        effort: optionalString(record?.effort),
        providerSessionId: optionalString(record?.providerSessionId),
        status,
        latestResponse: optionalContentString(record?.latestResponse),
        error: optionalContentString(record?.error),
        errorCode: optionalString(record?.errorCode),
        errorRetryable: optionalBoolean(record?.errorRetryable),
        createdAt: requiredString(record?.createdAt, "createdAt"),
        updatedAt: requiredString(record?.updatedAt, "updatedAt"),
    };
}
export function decodeAgentRecordList(value) {
    if (!Array.isArray(value))
        throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid agent list.");
    return value.map(decodeAgentRecord);
}
export function decodeDaemonStatus(value) {
    const record = asRecord(value);
    const state = requiredString(record?.state, "state");
    if (state !== "ready" && state !== "stopping") {
        throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid status.");
    }
    return {
        state,
        protocolVersion: requiredInteger(record?.protocolVersion, "protocolVersion"),
        pid: requiredInteger(record?.pid, "pid"),
        endpoint: requiredString(record?.endpoint, "endpoint"),
        startedAt: requiredString(record?.startedAt, "startedAt"),
        activeTurns: requiredInteger(record?.activeTurns, "activeTurns"),
        runtimeCount: requiredInteger(record?.runtimeCount, "runtimeCount"),
        clientConnections: requiredInteger(record?.clientConnections, "clientConnections"),
    };
}
export function decodeDaemonLogs(value) {
    if (typeof value !== "string")
        throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned invalid logs.");
    return value;
}
export class LocalAgentDaemonProtocolError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "LocalAgentDaemonProtocolError";
    }
}
function decodeEmptyParams(value) {
    if (value === undefined)
        return {};
    const record = asRecord(value);
    if (!record || Object.keys(record).length > 0) {
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "This daemon method does not accept parameters.");
    }
    return {};
}
function decodeStartInput(value) {
    const record = asRecord(value);
    return {
        target: requiredString(record?.target, "target"),
        prompt: requiredContentString(record?.prompt, "prompt"),
        workspaceRoot: requiredString(record?.workspaceRoot, "workspaceRoot"),
        workspaceId: optionalString(record?.workspaceId),
        model: optionalString(record?.model),
        effort: optionalString(record?.effort),
        writeMode: decodeWriteMode(record?.writeMode),
    };
}
function decodeContinueInput(value) {
    const record = asRecord(value);
    const overrides = asRecord(record?.overrides);
    return {
        id: requiredString(record?.id, "id"),
        prompt: requiredContentString(record?.prompt, "prompt"),
        scope: decodeWorkspaceScope(record?.scope),
        ...(overrides ? { overrides: {
                model: optionalString(overrides.model),
                effort: optionalString(overrides.effort),
                writeMode: decodeWriteMode(overrides.writeMode),
            } } : {}),
    };
}
function decodeWorkspaceScope(value) {
    const record = asRecord(value);
    if (!record)
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Workspace scope is required.");
    return {
        workspaceId: optionalString(record.workspaceId),
        workspaceRoot: requiredString(record.workspaceRoot, "scope.workspaceRoot"),
    };
}
function decodeListScope(value) {
    return decodeWorkspaceScope(value);
}
function decodeLogsParams(value) {
    if (value === undefined)
        return {};
    const record = asRecord(value);
    if (!record)
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Log options must be an object.");
    const lines = record.lines;
    if (lines === undefined)
        return {};
    if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 10_000) {
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Log lines must be an integer between 1 and 10000.");
    }
    return { lines };
}
function decodeWriteMode(value) {
    if (value === undefined)
        return undefined;
    if (value === "read_only" || value === "allowed" || value === "full_access")
        return value;
    throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Invalid write mode.");
}
function isLocalAgentStatus(value) {
    return value === "starting" || value === "running" || value === "idle" || value === "error" || value === "stopped";
}
function requiredString(value, field) {
    const result = optionalString(value);
    if (!result)
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", `Missing ${field}.`);
    return result;
}
function requiredContentString(value, field) {
    const result = optionalContentString(value);
    if (result === undefined)
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", `Missing ${field}.`);
    return result;
}
function requiredInteger(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new LocalAgentDaemonProtocolError("INVALID_PROTOCOL", `Invalid ${field}.`);
    }
    return value;
}
function optionalString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
function optionalContentString(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    return value;
}
function optionalBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value;
}
export function supportedDaemonProtocolVersion() {
    return LOCAL_AGENT_DAEMON_PROTOCOL_VERSION;
}
