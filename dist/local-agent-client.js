import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { matchError, Result } from "better-result";
import { AgentDaemonInvalidResponseError, AgentDaemonProtocolMismatchError, AgentDaemonStartupError, AgentDaemonTimeoutError, AgentDaemonUnavailableError, agentErrorFromPayload, isAgentDaemonError, isProgrammerDefect, } from "./local-agent-errors.js";
import { decodeAgentRecord, decodeAgentRecordList, decodeDaemonLogs, decodeDaemonStatus, decodeLocalAgentDaemonResponse, encodeLocalAgentDaemonRequest, LocalAgentDaemonProtocolError, } from "./local-agent-daemon-protocol.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION, ensureLocalAgentDaemonSecret, isProcessAlive, localAgentDaemonPaths, readLocalAgentDaemonSecret, } from "./local-agent-daemon-lifecycle.js";
const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 40;
export class LocalAgentClient {
    stateDir;
    paths;
    endpoint;
    startupTimeoutMs;
    requestTimeoutMs;
    spawnDaemon;
    startupPromise;
    constructor(options) {
        this.stateDir = options.stateDir;
        this.paths = localAgentDaemonPaths(options.stateDir);
        this.endpoint = options.endpoint ?? this.paths.endpoint;
        this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.spawnDaemon = options.spawnDaemon ?? (() => spawnLocalAgentDaemon(options.stateDir));
    }
    async run(input) {
        return this.start(input);
    }
    async start(input) {
        const result = await this.request("agent.start", input);
        return decodeRequestResult(result, "agent.start", decodeAgentRecord);
    }
    async continue(agentId, prompt, overrides = {}, scope) {
        const result = await this.request("agent.continue", {
            id: agentId,
            prompt,
            scope,
            ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        });
        return decodeRequestResult(result, "agent.continue", decodeAgentRecord);
    }
    async get(agentId, scope) {
        const result = await this.request("agent.get", { id: agentId, scope });
        return decodeRequestResult(result, "agent.get", decodeAgentRecord);
    }
    async list(scope) {
        const result = await this.request("agent.list", scope);
        return decodeRequestResult(result, "agent.list", decodeAgentRecordList);
    }
    async status() {
        const result = await this.requestExisting("daemon.status", {});
        return decodeRequestResult(result, "daemon.status", decodeDaemonStatus);
    }
    async stop() {
        const result = await this.requestExisting("daemon.stop", {});
        return decodeRequestResult(result, "daemon.stop", decodeDaemonStatus);
    }
    async logs(lines = 200) {
        const result = await this.requestExisting("daemon.logs", { lines });
        return decodeRequestResult(result, "daemon.logs", decodeDaemonLogs);
    }
    async ensureReady() {
        if (this.startupPromise)
            return this.startupPromise;
        this.startupPromise = this.ensureReadyInternal().finally(() => {
            this.startupPromise = undefined;
        });
        return this.startupPromise;
    }
    async ensureReadyInternal() {
        const existing = await this.tryHello();
        if (existing.isErr())
            return existing;
        if (existing.value)
            return Result.ok(existing.value);
        try {
            this.spawnDaemon();
        }
        catch (cause) {
            return Result.err(new AgentDaemonStartupError({
                code: "DAEMON_STARTUP_FAILURE",
                operation: "startup",
                retryable: true,
                cause,
                message: `Unable to start the local agent daemon in ${this.stateDir}.`,
            }));
        }
        const deadline = Date.now() + this.startupTimeoutMs;
        let lastError;
        while (Date.now() < deadline) {
            await delay(RETRY_DELAY_MS);
            const ready = await this.tryHello();
            if (ready.isErr()) {
                lastError = ready.error;
                if (ready.error.code === "DAEMON_PROTOCOL_MISMATCH"
                    || ready.error.code === "DAEMON_INVALID_RESPONSE")
                    return ready;
                continue;
            }
            if (ready.value)
                return Result.ok(ready.value);
        }
        return Result.err(new AgentDaemonStartupError({
            code: "DAEMON_STARTUP_FAILURE",
            operation: "startup",
            retryable: true,
            cause: lastError,
            message: `Unable to start the local agent daemon in ${this.stateDir}.`,
        }));
    }
    async tryHello() {
        const authToken = this.authTokenResult("hello");
        if (authToken.isErr())
            return authToken;
        const response = await sendRequest(this.endpoint, {
            requestId: randomUUID(),
            protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
            authToken: authToken.value,
            method: "hello",
            params: {},
        }, this.requestTimeoutMs);
        if (response.isErr()) {
            if (response.error.code === "DAEMON_UNAVAILABLE"
                || response.error.code === "DAEMON_TIMEOUT")
                return Result.ok(undefined);
            return response;
        }
        if (!response.value.ok) {
            const error = decodeRemoteError(response.value.error, "hello");
            if (!isAgentDaemonError(error)) {
                return Result.err(new AgentDaemonInvalidResponseError({
                    code: "DAEMON_INVALID_RESPONSE",
                    operation: "hello",
                    retryable: false,
                    cause: response.value.error,
                    message: "Local agent daemon returned an invalid hello error.",
                }));
            }
            if (error.code === "DAEMON_PROTOCOL_MISMATCH"
                && response.value.protocolVersion < LOCAL_AGENT_DAEMON_PROTOCOL_VERSION) {
                return this.replaceIdleOlderDaemon(authToken.value, response.value.protocolVersion, error);
            }
            return error.code === "DAEMON_UNAVAILABLE" ? Result.ok(undefined) : Result.err(error);
        }
        const decoded = decodeValue(response.value.result, "hello", decodeDaemonStatus);
        return decoded.map((status) => status.state === "ready" ? status : undefined);
    }
    async replaceIdleOlderDaemon(authToken, protocolVersion, mismatch) {
        const statusResponse = await sendRequest(this.endpoint, {
            requestId: randomUUID(),
            protocolVersion,
            authToken,
            method: "hello",
            params: {},
        }, this.requestTimeoutMs);
        if (statusResponse.isErr() || !statusResponse.value.ok)
            return Result.err(mismatch);
        const status = decodeValue(statusResponse.value.result, "hello", decodeDaemonStatus);
        if (status.isErr())
            return status;
        if (status.value.activeTurns > 0) {
            return Result.err(new AgentDaemonProtocolMismatchError({
                code: "DAEMON_PROTOCOL_MISMATCH",
                operation: "startup",
                retryable: true,
                cause: mismatch,
                message: "An older local agent daemon is still running active turns. Retry after they finish.",
            }));
        }
        const stopResponse = await sendRequest(this.endpoint, {
            requestId: randomUUID(),
            protocolVersion,
            authToken,
            method: "daemon.stop",
            params: {},
        }, this.requestTimeoutMs);
        if (stopResponse.isErr() || !stopResponse.value.ok)
            return Result.err(mismatch);
        const deadline = Date.now() + this.startupTimeoutMs;
        while (Date.now() < deadline) {
            await delay(RETRY_DELAY_MS);
            const probe = await sendRequest(this.endpoint, {
                requestId: randomUUID(),
                protocolVersion,
                authToken,
                method: "hello",
                params: {},
            }, Math.min(this.requestTimeoutMs, 250));
            if (probe.isErr() && probe.error.code === "DAEMON_UNAVAILABLE") {
                if (!existsSync(this.paths.lockPath) || !isProcessAlive(status.value.pid)) {
                    return Result.ok(undefined);
                }
                continue;
            }
            if (probe.isOk()
                && probe.value.protocolVersion >= LOCAL_AGENT_DAEMON_PROTOCOL_VERSION) {
                // Another client completed the replacement while this client was
                // waiting for the old endpoint to disappear.
                return this.tryHello();
            }
        }
        return Result.err(new AgentDaemonStartupError({
            code: "DAEMON_STARTUP_FAILURE",
            operation: "startup",
            retryable: true,
            cause: mismatch,
            message: "The older local agent daemon did not stop in time for the upgrade.",
        }));
    }
    async request(method, params) {
        const ready = await this.ensureReady();
        if (ready.isErr())
            return ready;
        const authToken = this.authTokenResult(method);
        if (authToken.isErr())
            return authToken;
        const response = await sendRequest(this.endpoint, {
            requestId: randomUUID(),
            protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
            authToken: authToken.value,
            method,
            params,
        }, this.requestTimeoutMs);
        if (response.isErr())
            return response;
        if (!response.value.ok) {
            const error = decodeRemoteError(response.value.error, method);
            if (!isRequestError(method, error)) {
                return Result.err(new AgentDaemonInvalidResponseError({
                    code: "DAEMON_INVALID_RESPONSE",
                    operation: method,
                    retryable: false,
                    cause: response.value.error,
                    message: "Local agent daemon returned an error that is invalid for this request.",
                }));
            }
            return Result.err(error);
        }
        return Result.ok(response.value.result);
    }
    async requestExisting(method, params) {
        const authToken = this.existingAuthTokenResult(method);
        if (authToken.isErr())
            return authToken;
        if (!authToken.value) {
            return Result.err(new AgentDaemonUnavailableError({
                code: "DAEMON_UNAVAILABLE",
                operation: method,
                retryable: true,
                message: "Local agent daemon is not running.",
            }));
        }
        const response = await sendRequest(this.endpoint, {
            requestId: randomUUID(),
            protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
            authToken: authToken.value,
            method,
            params,
        }, this.requestTimeoutMs);
        if (response.isErr())
            return response;
        if (!response.value.ok) {
            const error = decodeRemoteError(response.value.error, method);
            if (isAgentDaemonError(error))
                return Result.err(error);
            return Result.err(new AgentDaemonInvalidResponseError({
                code: "DAEMON_INVALID_RESPONSE",
                operation: method,
                retryable: false,
                cause: response.value.error,
                message: "Local agent daemon returned an invalid daemon-control error.",
            }));
        }
        return Result.ok(response.value.result);
    }
    authTokenResult(operation) {
        try {
            return Result.ok(ensureLocalAgentDaemonSecret(this.paths));
        }
        catch (cause) {
            if (isProgrammerDefect(cause))
                throw cause;
            return Result.err(new AgentDaemonUnavailableError({
                code: "DAEMON_UNAVAILABLE",
                operation,
                retryable: false,
                cause,
                message: "Local agent daemon credentials are unavailable.",
            }));
        }
    }
    existingAuthTokenResult(operation) {
        try {
            return Result.ok(readLocalAgentDaemonSecret(this.paths));
        }
        catch (cause) {
            if (isProgrammerDefect(cause))
                throw cause;
            return Result.err(new AgentDaemonUnavailableError({
                code: "DAEMON_UNAVAILABLE",
                operation,
                retryable: false,
                cause,
                message: "Local agent daemon credentials are unavailable.",
            }));
        }
    }
}
export function createLocalAgentClient(config) {
    return new LocalAgentClient({ stateDir: config.stateDir });
}
export function spawnLocalAgentDaemon(stateDir, env = process.env) {
    const entrypoint = resolveDaemonEntrypoint();
    const child = spawn(process.execPath, [...daemonExecArgv(process.execArgv), entrypoint], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...env, DEVSPACE_STATE_DIR: stateDir },
    });
    child.unref();
}
export function daemonExecArgv(execArgv) {
    const result = [];
    for (let index = 0; index < execArgv.length; index += 1) {
        const argument = execArgv[index];
        if (/^--inspect(?:-brk|-wait)?(?:=.*)?$/.test(argument))
            continue;
        if (argument === "--inspect-port") {
            index += 1;
            continue;
        }
        if (argument.startsWith("--inspect-port="))
            continue;
        result.push(argument);
    }
    return result;
}
export function resolveDaemonEntrypoint() {
    const compiled = fileURLToPath(new URL("./local-agent-daemon-main.js", import.meta.url));
    if (existsSync(compiled))
        return compiled;
    return fileURLToPath(new URL("./local-agent-daemon-main.ts", import.meta.url));
}
async function sendRequest(endpoint, request, timeoutMs) {
    return new Promise((resolve) => {
        const socket = createConnection(endpoint);
        let buffer = "";
        let settled = false;
        const timer = setTimeout(() => {
            finish(Result.err(new AgentDaemonTimeoutError({
                code: "DAEMON_TIMEOUT",
                operation: request.method,
                retryable: true,
                message: "Timed out waiting for the local agent daemon.",
            })), true);
        }, timeoutMs);
        const finish = (result, destroy = false) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (destroy)
                socket.destroy();
            resolve(result);
        };
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            const newline = buffer.indexOf("\n");
            if (newline === -1)
                return;
            try {
                const response = decodeLocalAgentDaemonResponse(JSON.parse(buffer.slice(0, newline)));
                if (response.requestId !== request.requestId) {
                    throw new LocalAgentDaemonProtocolError("INVALID_RESPONSE", "Daemon response request id did not match.");
                }
                finish(Result.ok(response));
                socket.end();
            }
            catch (cause) {
                finish(Result.err(new AgentDaemonInvalidResponseError({
                    code: "DAEMON_INVALID_RESPONSE",
                    operation: request.method,
                    retryable: false,
                    cause,
                    message: "Local agent daemon returned an invalid response.",
                })), true);
            }
        });
        socket.once("error", (cause) => finish(Result.err(new AgentDaemonUnavailableError({
            code: "DAEMON_UNAVAILABLE",
            operation: request.method,
            retryable: true,
            cause,
            message: "Local agent daemon is unavailable.",
        }))));
        socket.once("close", () => {
            if (!settled) {
                finish(Result.err(new AgentDaemonUnavailableError({
                    code: "DAEMON_UNAVAILABLE",
                    operation: request.method,
                    retryable: true,
                    message: "Local agent daemon closed the connection.",
                })));
            }
        });
        socket.once("connect", () => socket.write(encodeLocalAgentDaemonRequest(request)));
    });
}
function decodeRequestResult(result, operation, decode) {
    return result.andThen((value) => decodeValue(value, operation, decode));
}
function decodeValue(value, operation, decode) {
    try {
        return Result.ok(decode(value));
    }
    catch (cause) {
        return Result.err(new AgentDaemonInvalidResponseError({
            code: "DAEMON_INVALID_RESPONSE",
            operation,
            retryable: false,
            cause,
            message: "Local agent daemon returned an invalid response.",
        }));
    }
}
function decodeRemoteError(payload, operation) {
    const decoded = agentErrorFromPayload(payload);
    return decoded ?? new AgentDaemonInvalidResponseError({
        code: "DAEMON_INVALID_RESPONSE",
        operation,
        retryable: false,
        cause: payload,
        message: "Local agent daemon returned an unknown error code.",
    });
}
function isRequestError(method, error) {
    const category = matchError(error, {
        AgentTargetError: () => "target",
        AgentConflictError: () => "conflict",
        AgentScopeError: () => "scope",
        AgentProviderUnavailableError: () => "provider",
        AgentProviderCancelledError: () => "provider",
        AgentProviderProtocolError: () => "provider",
        AgentProviderExecutionError: () => "provider",
        AgentDaemonUnavailableError: () => "daemon",
        AgentDaemonStartupError: () => "daemon",
        AgentDaemonTimeoutError: () => "daemon",
        AgentDaemonProtocolMismatchError: () => "daemon",
        AgentDaemonUnauthorizedError: () => "daemon",
        AgentDaemonInvalidRequestError: () => "daemon",
        AgentDaemonInvalidResponseError: () => "daemon",
        AgentDaemonInternalError: () => "daemon",
        AgentStoreError: () => "store",
    });
    if (category === "daemon")
        return true;
    switch (method) {
        case "agent.start":
        case "agent.continue":
            return category === "target"
                || category === "scope"
                || category === "conflict"
                || category === "store";
        case "agent.get":
            return category === "target" || category === "scope" || category === "store";
        case "agent.list":
            return category === "scope" || category === "store";
        case "hello":
        case "daemon.status":
        case "daemon.stop":
        case "daemon.logs":
            return false;
    }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
