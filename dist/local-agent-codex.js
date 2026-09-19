import { homedir } from "node:os";
import { execFile, spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isSandboxFallbackEnabled } from "./local-agent-config.js";
import { AgentProviderExecutionError, AgentProviderProtocolError, AgentProviderUnavailableError, AgentSandboxUnavailableError, captureAgentProviderResult, } from "./local-agent-errors.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import { terminateProcessTree } from "./process-platform.js";
import { resolveAllowedPath } from "./roots.js";
import { CODEX_DEFAULT_EFFORT, CODEX_NATIVE_MAX_EFFORT, } from "./local-agent-targets.js";
export function codexCommandEnvironment(env = process.env) {
    const next = { ...env };
    delete next.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    if (env.CODEX_COMMAND)
        return next;
    if (next.PATH)
        next.PATH = removeDevspaceNodeModulesBinFromPath(next.PATH);
    return next;
}
export function resolveCodexCommand(env = process.env) {
    const command = env.CODEX_COMMAND ?? "codex";
    const probeEnv = codexCommandEnvironment(env);
    for (const candidate of commandCandidates(command, probeEnv)) {
        const result = spawnSync(candidate, ["--version"], {
            encoding: "utf8",
            env: probeEnv,
            windowsHide: true,
            timeout: 5_000,
            shell: usesWindowsCommandShell(candidate),
        });
        const code = result.error && "code" in result.error ? result.error.code : undefined;
        if (code === "ENOENT")
            continue;
        if (result.error || result.status !== 0)
            continue;
        return { executable: candidate, version: parseCodexVersion(result.stdout) };
    }
    return undefined;
}
export function isCodexAppServerSupported(command, env = process.env) {
    const result = spawnSync(command, ["app-server", "--help"], {
        encoding: "utf8",
        env: codexCommandEnvironment(env),
        windowsHide: true,
        timeout: 5_000,
        shell: usesWindowsCommandShell(command),
    });
    return result.error === undefined && result.status === 0;
}
export function parseCodexVersion(output) {
    const match = output?.trim().match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
    return match?.[1];
}
export const sandboxProbeTtlMs = 60_000;
const LINUX_SANDBOX_PROBE_TIMEOUT_MS = 5_000;
const LINUX_SANDBOX_PROBE_COMMAND = "unshare -Ur true";
const MAX_SANDBOX_PROBE_STDERR_BYTES = 8 * 1024;
let linuxSandboxProbeCache;
let linuxSandboxProbeInFlight;
let linuxSandboxProbeImplementation;
let linuxSandboxProbeGeneration = 0;
export function resetSandboxProbeCache() {
    linuxSandboxProbeGeneration += 1;
    linuxSandboxProbeCache = undefined;
    linuxSandboxProbeInFlight = undefined;
    linuxSandboxProbeImplementation = undefined;
}
export function getLinuxSandboxProbeState() {
    if (!linuxSandboxProbeCache)
        return { outcome: "unknown", at: undefined };
    return {
        outcome: linuxSandboxProbeCache.result.outcome,
        at: new Date(linuxSandboxProbeCache.at).toISOString(),
    };
}
export function probeLinuxUserNamespace(execFileImpl = execFile, options = {}) {
    if (process.platform !== "linux")
        return Promise.resolve({ outcome: "ok" });
    const ttlMs = options.ttlMs ?? options.sandboxProbeTtlMs ?? sandboxProbeTtlMs;
    const now = options.now ?? Date.now;
    const cached = linuxSandboxProbeCache;
    if (cached && linuxSandboxProbeImplementation === execFileImpl && now() - cached.at < ttlMs)
        return Promise.resolve(cached.result);
    if (linuxSandboxProbeInFlight)
        return linuxSandboxProbeInFlight;
    linuxSandboxProbeImplementation = execFileImpl;
    const generation = linuxSandboxProbeGeneration;
    const probe = new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        try {
            const child = execFileImpl("unshare", ["-Ur", "true"], {
                timeout: LINUX_SANDBOX_PROBE_TIMEOUT_MS,
                windowsHide: true,
            }, (error, _stdout, stderr) => finish(classifySandboxProbeError(error, stderr)));
            if (child && typeof child.then === "function") {
                child.then(() => finish({ outcome: "ok" }), (error) => finish(classifySandboxProbeError(error)));
            }
        }
        catch (error) {
            finish(classifySandboxProbeError(error));
        }
    });
    const inFlight = probe
        .then((result) => {
        if (generation === linuxSandboxProbeGeneration)
            linuxSandboxProbeCache = { result, at: now() };
        return result;
    })
        .finally(() => {
        if (linuxSandboxProbeInFlight === inFlight)
            linuxSandboxProbeInFlight = undefined;
    });
    linuxSandboxProbeInFlight = inFlight;
    return inFlight;
}
export const probeLinuxSandbox = probeLinuxUserNamespace;
function classifySandboxProbeError(error, stderr) {
    if (!error)
        return { outcome: "ok" };
    const code = error?.code;
    if (code === "ENOENT")
        return { outcome: "indeterminate", reason: "not_found" };
    const signal = typeof error?.signal === "string" ? error.signal : undefined;
    if (error?.timedOut === true || code === "ETIMEDOUT" || (error?.killed === true && (!signal || signal === "SIGTERM")))
        return { outcome: "indeterminate", reason: "timeout" };
    if (signal)
        return { outcome: "indeterminate", reason: `signal ${signal}` };
    if (typeof code === "number") {
        const capturedStderr = boundedProbeStderr(error, stderr);
        if (code === 1 && /Operation not permitted|\bEPERM\b/i.test(capturedStderr)) {
            return {
                outcome: "denied",
                code,
                ...(capturedStderr ? { stderr: capturedStderr } : {}),
            };
        }
        return {
            outcome: "indeterminate",
            reason: `exit ${code}`,
        };
    }
    if (code === "ENOENT")
        return { outcome: "indeterminate", reason: "not_found" };
    return { outcome: "indeterminate", reason: "spawn_error" };
}
function boundedProbeStderr(error, stderr) {
    const value = stderr ?? error?.stderr;
    if (value === undefined || value === null)
        return "";
    const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= MAX_SANDBOX_PROBE_STDERR_BYTES)
        return text;
    const marker = text.search(/Operation not permitted|\bEPERM\b/i);
    const markerByte = marker < 0 ? -1 : Buffer.byteLength(text.slice(0, marker), "utf8");
    const tailStart = bytes.length - MAX_SANDBOX_PROBE_STDERR_BYTES;
    const start = markerByte < 0 ? tailStart : Math.min(markerByte, tailStart);
    return bytes.subarray(start, start + MAX_SANDBOX_PROBE_STDERR_BYTES).toString("utf8");
}
export class CodexAppServerRuntime {
    options;
    provider = "codex";
    child;
    rpc;
    alive = true;
    closePromise;
    constructor(options) {
        this.options = options;
        this.child = spawn(options.command, ["app-server"], {
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
            shell: usesWindowsCommandShell(options.command),
        });
        this.rpc = new CodexAppServerRpc(this.child, options.version);
        this.child.once("exit", (code, signal) => {
            this.alive = false;
            this.rpc.fail(new Error(`codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`));
        });
        this.child.once("error", (error) => {
            this.alive = false;
            this.rpc.fail(error);
        });
    }
    async initialize() {
        await this.rpc.request("initialize", {
            clientInfo: { name: "devspace", title: "DevSpace", version: "1.0.7" },
            capabilities: {},
        });
        this.rpc.notify("initialized");
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
                        message: "Codex app-server is not running.",
                    });
                }
                const sandbox = await resolveCodexSandbox(input, {
                    ...this.options,
                    onSandboxFallback: async (event) => {
                        await callbacks?.onSandboxFallback?.(event);
                        try {
                            await this.options.onSandboxFallback?.(event);
                        }
                        catch {
                            // Logging must never prevent a validated fallback from running.
                        }
                    },
                });
                const providerInput = sandbox.workspaceRoot
                    ? { ...input, workspaceRoot: sandbox.workspaceRoot }
                    : input;
                const threadResponse = await this.rpc.request(providerInput.providerSessionId ? "thread/resume" : "thread/start", threadParams(providerInput, sandbox));
                const threadId = readString(asRecord(threadResponse)?.thread, "id");
                if (!threadId) {
                    throw new AgentProviderProtocolError({
                        code: "PROVIDER_PROTOCOL_ERROR",
                        provider: this.provider,
                        operation: "open_thread",
                        retryable: false,
                        cause: threadResponse,
                        message: "Codex app-server did not return a thread id.",
                    });
                }
                await callbacks?.onSessionId?.(threadId);
                const completed = await this.rpc.runTurn(threadId, turnParams(providerInput, threadId, sandbox));
                const parsed = parseCompletedTurn(completed.event.params, completed.items);
                if (parsed.failure) {
                    throw new AgentProviderExecutionError({
                        code: "PROVIDER_EXECUTION_ERROR",
                        provider: this.provider,
                        operation: "run",
                        retryable: false,
                        cause: completed.event.params,
                        message: "Codex agent turn failed.",
                    });
                }
                if (!parsed.finalResponse.trim()) {
                    throw new AgentProviderProtocolError({
                        code: "PROVIDER_PROTOCOL_ERROR",
                        provider: this.provider,
                        operation: "run",
                        retryable: false,
                        cause: completed.event.params,
                        message: "Codex did not return a final assistant response.",
                    });
                }
                return {
                    provider: this.provider,
                    providerSessionId: threadId,
                    finalResponse: parsed.finalResponse.trim(),
                    items: parsed.items,
                    ...(sandbox.metadata ? { metadata: sandbox.metadata } : {}),
                };
            },
        });
    }
    async releaseSession(providerSessionId) {
        if (!this.alive)
            return;
        try {
            await this.rpc.request("thread/unsubscribe", { threadId: providerSessionId });
        }
        catch {
            // Unsubscribe is an optimization; persisted thread identity remains valid.
        }
    }
    isAlive() {
        return this.alive && !this.child.killed && this.child.exitCode === null;
    }
    async close() {
        if (this.closePromise)
            return this.closePromise;
        this.closePromise = (async () => {
            this.alive = false;
            this.rpc.fail(new Error("codex app-server closed."));
            if (!this.child.stdin.destroyed)
                this.child.stdin.end();
            if (this.child.exitCode === null) {
                terminateProcessTree(this.child, "SIGTERM", process.platform !== "win32");
                if (!await waitForProcessExit(this.child, 1_000)) {
                    terminateProcessTree(this.child, "SIGKILL", process.platform !== "win32");
                }
            }
        })();
        return this.closePromise;
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
export class CodexLocalAgentDriver {
    env;
    commandResolver;
    provider = "codex";
    idleTimeoutMs = 5 * 60_000;
    commandResolved = false;
    resolvedCommand;
    sandboxFallback;
    worktreeRoot;
    sandboxProbe;
    onSandboxFallback;
    sandboxProbeTtlMs;
    execFile;
    constructor(env = process.env, commandResolver = resolveCodexCommand, options = {}) {
        this.env = env;
        this.commandResolver = commandResolver;
        this.sandboxFallback = options.sandboxFallback ?? "fail";
        this.worktreeRoot = options.worktreeRoot;
        this.sandboxProbe = options.sandboxProbe;
        this.onSandboxFallback = options.onSandboxFallback;
        this.sandboxProbeTtlMs = options.sandboxProbeTtlMs;
        this.execFile = options.execFile;
    }
    runtimeKey(_context) {
        const command = this.resolveCommand();
        const executable = command?.executable ?? this.env.CODEX_COMMAND ?? "codex";
        const codexHome = resolve(this.env.CODEX_HOME ?? join(homedir(), ".codex"));
        return `codex:${executable}:${codexHome}`;
    }
    async createRuntime(_context) {
        return captureAgentProviderResult({
            provider: this.provider,
            operation: "create_runtime",
            run: async () => {
                const command = this.resolveCommand();
                if (!command) {
                    throw new AgentProviderUnavailableError({
                        code: "PROVIDER_UNAVAILABLE",
                        provider: this.provider,
                        operation: "create_runtime",
                        retryable: false,
                        message: "Codex executable was not found.",
                    });
                }
                if (!isCodexAppServerSupported(command.executable, this.env)) {
                    throw new AgentProviderUnavailableError({
                        code: "PROVIDER_UNAVAILABLE",
                        provider: this.provider,
                        operation: "create_runtime",
                        retryable: false,
                        message: "Installed Codex does not support app-server.",
                    });
                }
                const runtime = new CodexAppServerRuntime({
                    command: command.executable,
                    env: codexCommandEnvironment(this.env),
                    version: command.version,
                    sandboxFallback: this.sandboxFallback,
                    worktreeRoot: this.worktreeRoot,
                    sandboxProbe: this.sandboxProbe,
                    onSandboxFallback: this.onSandboxFallback,
                    sandboxProbeTtlMs: this.sandboxProbeTtlMs,
                    execFile: this.execFile,
                });
                try {
                    await runtime.initialize();
                    return runtime;
                }
                catch (cause) {
                    await runtime.close();
                    throw new AgentProviderProtocolError({
                        code: "PROVIDER_PROTOCOL_ERROR",
                        provider: this.provider,
                        operation: "create_runtime",
                        retryable: true,
                        cause: codexAppServerError(errorMessage(cause), command.version),
                        message: "Codex app-server initialization failed.",
                    });
                }
            },
        });
    }
    resolveCommand() {
        if (!this.commandResolved) {
            this.resolvedCommand = this.commandResolver(this.env);
            this.commandResolved = true;
        }
        return this.resolvedCommand;
    }
}
const MAX_TURN_ITEMS = 10_000;
const MAX_STDERR_BYTES = 32 * 1024;
class CodexAppServerRpc {
    child;
    version;
    pending = new Map();
    turns = new Map();
    nextId = 1;
    fatalError;
    buffer = "";
    stderr = "";
    constructor(child, version) {
        this.child = child;
        this.version = version;
        createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.handleLine(line));
        child.stdin.on("error", (error) => this.fail(error));
        child.stderr.on("data", (chunk) => {
            this.stderr = appendTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
        });
    }
    request(method, params) {
        if (this.fatalError)
            return Promise.reject(this.fatalError);
        const id = String(this.nextId++);
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write({ id, method, ...(params === undefined ? {} : { params }) });
        });
    }
    notify(method, params) {
        this.write({ method, ...(params === undefined ? {} : { params }) });
    }
    async runTurn(threadId, params) {
        if (this.fatalError)
            throw this.fatalError;
        if (this.turns.has(threadId))
            throw new Error(`Codex thread ${threadId} already has an active turn.`);
        let resolveTurn;
        let rejectTurn;
        const completion = new Promise((resolve, reject) => {
            resolveTurn = resolve;
            rejectTurn = reject;
        });
        const turn = {
            threadId,
            items: [],
            resolve: resolveTurn,
            reject: rejectTurn,
        };
        this.turns.set(threadId, turn);
        try {
            const response = await this.request("turn/start", params);
            turn.turnId = readString(asRecord(response)?.turn, "id");
            if (turn.completed)
                return { event: turn.completed, items: turn.items };
            return await completion;
        }
        finally {
            if (this.turns.get(threadId) === turn)
                this.turns.delete(threadId);
        }
    }
    fail(error) {
        if (this.fatalError)
            return;
        this.fatalError = new Error(`${error.message}${this.stderr.trim() ? `\n${this.stderr.trim()}` : ""}${this.version ? `\ncodex version: ${this.version}` : ""}`);
        for (const pending of this.pending.values())
            pending.reject(this.fatalError);
        for (const turn of this.turns.values())
            turn.reject(this.fatalError);
        this.pending.clear();
        this.turns.clear();
    }
    write(message) {
        if (this.fatalError)
            throw this.fatalError;
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    handleLine(line) {
        this.buffer += line;
        const trimmed = this.buffer.trim();
        this.buffer = "";
        if (!trimmed)
            return;
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch {
            this.fail(new Error("codex app-server emitted malformed JSON."));
            return;
        }
        const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
        const method = typeof message.method === "string" ? message.method : undefined;
        if (id && !method) {
            const pending = this.pending.get(id);
            if (!pending)
                return;
            this.pending.delete(id);
            if (message.error !== undefined)
                pending.reject(new Error(protocolErrorText(message.error)));
            else
                pending.resolve(message.result);
            return;
        }
        if (id && method) {
            this.write({ id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
            return;
        }
        if (!method)
            return;
        const event = { method, params: message.params };
        const turn = this.findTurn(event);
        if (!turn)
            return;
        const params = asRecord(event.params);
        if (params?.item !== undefined) {
            turn.items.push(params.item);
            if (turn.items.length > MAX_TURN_ITEMS)
                turn.items.shift();
        }
        if (event.method !== "turn/completed" || !turnMatchesEvent(turn, event))
            return;
        turn.completed = event;
        turn.resolve({ event, items: turn.items.slice() });
    }
    findTurn(event) {
        const params = asRecord(event.params);
        const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
        const turnId = typeof params?.turnId === "string"
            ? params.turnId
            : readString(asRecord(params?.turn), "id");
        if (threadId)
            return this.turns.get(threadId);
        if (!turnId)
            return undefined;
        return Array.from(this.turns.values()).find((turn) => turn.turnId === turnId);
    }
}
function threadParams(input, sandbox = normalCodexSandbox(input)) {
    return {
        ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
        cwd: input.workspaceRoot,
        approvalPolicy: "never",
        sandbox: sandbox.sandbox,
        ...(input.model ? { model: input.model } : {}),
    };
}
function turnParams(input, threadId, sandbox = normalCodexSandbox(input)) {
    return {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        approvalPolicy: "never",
        sandboxPolicy: sandbox.sandboxPolicy,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: mapCodexEffort(input.effort) } : {}),
    };
}
export function mapCodexEffort(effort) {
    return effort?.trim().toLowerCase() === CODEX_DEFAULT_EFFORT ? CODEX_NATIVE_MAX_EFFORT : effort;
}
export function sandboxFor(writeMode) {
    switch (writeMode) {
        case "allowed": return "workspace-write";
        case "full_access": return "danger-full-access";
        case "read_only":
        case undefined: return "read-only";
    }
}
function sandboxPolicyFor(writeMode) {
    switch (writeMode) {
        case "allowed": return { type: "workspaceWrite" };
        case "full_access": return { type: "dangerFullAccess" };
        case "read_only":
        case undefined: return { type: "readOnly" };
    }
}
function normalCodexSandbox(input) {
    return {
        sandbox: sandboxFor(input.writeMode),
        sandboxPolicy: sandboxPolicyFor(input.writeMode),
    };
}
export async function resolveCodexSandbox(input, options = {}) {
    const normal = normalCodexSandbox(input);
    if (process.platform !== "linux" || normal.sandbox === "danger-full-access")
        return normal;
    let probe;
    try {
        probe = options.sandboxProbe
            ? normalizeSandboxProbe(await options.sandboxProbe())
            : await probeLinuxUserNamespace(options.execFile, { ttlMs: options.sandboxProbeTtlMs });
    }
    catch (cause) {
        probe = classifySandboxProbeError(cause);
    }
    if (probe.outcome === "ok")
        return normal;
    if (probe.outcome === "indeterminate") {
        throw sandboxUnavailable({
            stage: "probe",
            detail: indeterminateProbeDetail(probe),
            fallbackAvailable: false,
            operation: "run",
            retryable: true,
        });
    }
    const fallbackEnabled = isSandboxFallbackEnabled(options.sandboxFallback);
    if (!fallbackEnabled) {
        throw sandboxUnavailable({
            stage: "probe",
            detail: deniedProbeDetail(probe),
            fallbackAvailable: true,
            operation: "run",
            retryable: false,
        });
    }
    if (normal.sandbox === "read-only") {
        throw sandboxUnavailable({
            stage: "policy",
            detail: "read-only turns are not eligible for the unsandboxed fallback; fix user namespaces or run with write access.",
            fallbackAvailable: false,
            operation: "run",
            retryable: false,
        });
    }
    let workspaceRoot;
    try {
        workspaceRoot = resolveAllowedPath(".", realpathSync(input.workspaceRoot), options.worktreeRoot ? [options.worktreeRoot] : []);
    }
    catch (cause) {
        throw sandboxUnavailable({
            stage: "worktree-confinement",
            detail: "The no-OS-sandbox fallback requires the session cwd to resolve under the configured worktree root.",
            fallbackAvailable: false,
            operation: "run",
            cause,
        });
    }
    const warning = "Codex is running WITHOUT an OS sandbox as the daemon account: unrestricted filesystem and network access. The worktree check authorized only the starting directory; it does not confine execution. Enable this fallback for trusted workloads only.";
    const metadata = {
        sandbox: "worktree-embedded",
        warnings: [warning],
    };
    await options.onSandboxFallback?.({
        provider: "codex",
        workspaceRoot,
        sandbox: metadata.sandbox,
        warning,
        metadata,
    });
    return {
        sandbox: sandboxFor("full_access"),
        sandboxPolicy: sandboxPolicyFor("full_access"),
        workspaceRoot,
        metadata,
    };
}
function normalizeSandboxProbe(value) {
    if (value === true)
        return { outcome: "ok" };
    if (value === false)
        return { outcome: "denied" };
    if (value && typeof value === "object" && (value.outcome === "ok" || value.outcome === "denied" || value.outcome === "indeterminate")) {
        return {
            outcome: value.outcome,
            ...(value.reason === undefined ? {} : { reason: value.reason }),
            ...(value.code === undefined ? {} : { code: value.code }),
            ...(value.signal === undefined ? {} : { signal: value.signal }),
            ...(value.stderr === undefined ? {} : { stderr: boundedProbeStderr({}, value.stderr) }),
        };
    }
    return { outcome: "indeterminate", reason: "spawn_error" };
}
function indeterminateProbeDetail(probe) {
    switch (probe.reason) {
        case "not_found":
            return `Linux user namespace probe could not run: unshare not found in PATH (probe command: ${LINUX_SANDBOX_PROBE_COMMAND}).`;
        case "timeout":
            return `Linux user namespace probe timed out after ${LINUX_SANDBOX_PROBE_TIMEOUT_MS}ms (probe command: ${LINUX_SANDBOX_PROBE_COMMAND}).`;
        default:
            if (probe.reason?.startsWith("exit ") || probe.reason?.startsWith("signal ")) {
                return `Linux user namespace probe failed (${probe.reason}; probe command: ${LINUX_SANDBOX_PROBE_COMMAND}).`;
            }
            return `Linux user namespace probe could not start (spawn error; probe command: ${LINUX_SANDBOX_PROBE_COMMAND}).`;
    }
}
function deniedProbeDetail(probe) {
    const status = probe.code === undefined ? "failed" : `exited with code ${String(probe.code)}`;
    const signal = probe.signal ? ` (signal ${probe.signal})` : "";
    const stderr = typeof probe.stderr === "string" && probe.stderr.trim() ? ` stderr: ${JSON.stringify(probe.stderr.trim())}` : "";
    return `Linux user namespace probe denied: ${LINUX_SANDBOX_PROBE_COMMAND} ${status}${signal}.${stderr} set subagents.sandboxFallback to "worktree-embedded" to permit unsandboxed execution from an eligible worktree. after host fixes run: devspace agents daemon stop`;
}
function sandboxUnavailable(fields) {
    return new AgentSandboxUnavailableError({
        code: "SANDBOX_UNAVAILABLE",
        provider: "codex",
        backend: "linux-user-namespace",
        stage: fields.stage,
        detail: fields.detail,
        operation: fields.operation,
        retryable: fields.retryable ?? false,
        fallbackAvailable: fields.fallbackAvailable,
        cause: fields.cause,
        message: fields.detail,
    });
}
function parseCompletedTurn(params, items) {
    const turn = asRecord(asRecord(params)?.turn);
    const completedItems = (Array.isArray(turn?.items) ? turn.items : items).slice(-MAX_TURN_ITEMS);
    let finalResponse = "";
    for (const item of completedItems) {
        const record = asRecord(item);
        if (!record)
            continue;
        const type = record.type;
        if ((type === "agentMessage" || type === "agent_message") && typeof record.text === "string") {
            finalResponse = record.text;
        }
    }
    const status = turn?.status;
    const error = asRecord(turn?.error);
    const failure = status === "failed"
        ? directString(error?.message) ?? "Codex turn failed."
        : undefined;
    return { finalResponse, items: completedItems, failure };
}
export function codexAppServerError(message, version, stderr) {
    return new Error([
        message,
        version ? `codex version: ${version}` : undefined,
        stderr?.trim() ? `stderr:\n${stderr.trim()}` : undefined,
    ].filter(Boolean).join("\n"));
}
function commandCandidates(command, env) {
    if (command.includes("/") || command.includes("\\") || /\.(?:cmd|bat|exe|com)$/i.test(command))
        return [command];
    const path = env.PATH;
    if (!path)
        return [command];
    const extensions = process.platform === "win32"
        ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
        : [""];
    return path.split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => extensions.map((extension) => resolve(directory, `${command}${extension}`)));
}
function usesWindowsCommandShell(command) {
    return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}
function turnMatchesEvent(turn, event) {
    const params = asRecord(event.params);
    const eventThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const eventTurnId = typeof params?.turnId === "string"
        ? params.turnId
        : readString(asRecord(params?.turn), "id");
    if (eventThreadId && eventThreadId !== turn.threadId)
        return false;
    if (turn.turnId && eventTurnId && turn.turnId !== eventTurnId)
        return false;
    return eventThreadId === turn.threadId || Boolean(turn.turnId && eventTurnId === turn.turnId);
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function readString(value, key) {
    const result = asRecord(value)?.[key];
    return typeof result === "string" ? result : undefined;
}
function directString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function protocolErrorText(value) {
    const record = asRecord(value);
    if (!record)
        return String(value);
    const message = directString(record.message);
    const code = record.code;
    return message ? `codex app-server${code === undefined ? "" : ` ${String(code)}`}: ${message}` : String(value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function appendTail(value, chunk, maxBytes) {
    const next = value + chunk;
    if (Buffer.byteLength(next, "utf8") <= maxBytes)
        return next;
    const bytes = Buffer.from(next, "utf8");
    return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}
