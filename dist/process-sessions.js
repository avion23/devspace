import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_YIELD_MS = 30_000;
// Bash is 59% of production tool calls and routinely returns build/test logs.
// ChatGPT web has far less headroom per tool call than a CLI/editor host (Codex
// exec defaults to ~10k tokens there); at 10k tokens/call, a handful of bash
// calls already dominate the conversation. 3k tokens (~12KB via the 4-char
// heuristic below) still fits a command's head plus the tail where build
// errors live, and the full output always stays on disk (see logPath) for
// follow-up rg/sed. Callers can still raise this up to the 100k cap.
const DEFAULT_MAX_OUTPUT_TOKENS = 3_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
// How long a session's full-output log survives after the process exits:
// long enough for the model to rg/sed-n it in a follow-up call, short enough
// to bound disk growth without per-directory size accounting.
const DEFAULT_LOG_RETENTION_MS = 15 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
function defaultStateDir() {
    return resolve(expandHomePath(process.env.DEVSPACE_STATE_DIR ?? join(homedir(), ".local", "share", "devspace")));
}
function boundedInteger(value, fallback, maximum) {
    if (value === undefined)
        return fallback;
    if (!Number.isFinite(value) || value < 0) {
        throw new Error("Duration and output limits must be non-negative.");
    }
    return Math.min(Math.floor(value), maximum);
}
function terminalSize(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 1_000) {
        throw new Error("Terminal dimensions must be integers between 1 and 1000.");
    }
    return value;
}
function processEnvironment(input) {
    return {
        ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
        NO_COLOR: "1",
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
        CODEX_CI: "1",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
        ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
    };
}
function codePointLength(value) {
    return Array.from(value).length;
}
function sliceCodePoints(value, start, end) {
    return Array.from(value).slice(start, end).join("");
}
function takeHead(value, count) {
    if (count <= 0)
        return "";
    return sliceCodePoints(value, 0, count);
}
function takeTail(value, count) {
    if (count <= 0)
        return "";
    const characters = Array.from(value);
    return characters.slice(Math.max(0, characters.length - count)).join("");
}
function splitBudget(maxCharacters) {
    return {
        head: Math.ceil(maxCharacters / 2),
        tail: Math.floor(maxCharacters / 2),
    };
}
export class HeadTailBuffer {
    maxCharacters;
    head = "";
    tail = "";
    totalCharacters = 0;
    constructor(maxCharacters) {
        this.maxCharacters = maxCharacters;
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
            throw new Error("Head/tail buffer limit must be a positive integer.");
        }
    }
    append(output) {
        if (!output)
            return;
        const previousTotal = this.totalCharacters;
        this.totalCharacters += codePointLength(output);
        if (this.totalCharacters <= this.maxCharacters) {
            this.head += output;
            return;
        }
        const budget = splitBudget(this.maxCharacters);
        if (previousTotal <= this.maxCharacters) {
            const fullOutput = this.head + output;
            this.head = takeHead(fullOutput, budget.head);
            this.tail = takeTail(fullOutput, budget.tail);
            return;
        }
        this.tail = takeTail(this.tail + output, budget.tail);
    }
    hasOutput() {
        return this.totalCharacters > 0;
    }
    // Returns the raw retained text plus how much was omitted, without a
    // formatted marker: the caller knows the session's log path and can
    // report where the omitted portion can still be read.
    drain(maxCharacters) {
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
            throw new Error("Output limit must be a positive integer.");
        }
        const omittedByBuffer = Math.max(0, this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail));
        const combined = this.head + this.tail;
        const combinedCharacters = codePointLength(combined);
        const budget = splitBudget(maxCharacters);
        const fitsBudget = combinedCharacters <= maxCharacters;
        const text = fitsBudget ? combined : takeHead(combined, budget.head) + takeTail(combined, budget.tail);
        const omittedByBudget = fitsBudget ? 0 : combinedCharacters - budget.head - budget.tail;
        const omittedCharacters = omittedByBuffer + omittedByBudget;
        this.head = "";
        this.tail = "";
        this.totalCharacters = 0;
        return { text, omittedCharacters, truncated: omittedCharacters > 0 };
    }
}
export class ProcessSessionManager {
    sessions = new Map();
    maxBufferCharacters;
    completedSessionTtlMs;
    nextSessionId = 1;
    constructor(options = {}) {
        this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
        this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
        this.logDir = resolve(expandHomePath(options.logDir ?? join(defaultStateDir(), "process-logs")));
        this.logRetentionMs = options.logRetentionMs ?? DEFAULT_LOG_RETENTION_MS;
        this.logDirReady = false;
        // Crash/restart recovery: timers that would delete a finished session's
        // log don't survive process death, so sweep stale logs on startup too.
        this.reapStaleLogs();
    }
    reapStaleLogs() {
        let entries;
        try {
            entries = readdirSync(this.logDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        const cutoff = Date.now() - this.logRetentionMs;
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const path = join(this.logDir, entry.name);
            try {
                if (statSync(path).mtimeMs < cutoff)
                    unlinkSync(path);
            }
            catch { }
        }
    }
    ensureLogDir() {
        if (this.logDirReady)
            return;
        mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
        this.logDirReady = true;
    }
    // Best-effort: a disk/stream failure disables logging for this session but
    // must never fail the command it is observing.
    openSessionLog(session) {
        const path = join(this.logDir, `session-${session.id}-${session.startedAt}.log`);
        try {
            this.ensureLogDir();
            const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
            stream.on("error", () => {
                session.logStream = undefined;
            });
            session.logStream = stream;
            return path;
        }
        catch {
            return undefined;
        }
    }
    discardLog(session) {
        if (session.logStream) {
            session.logStream.end();
            session.logStream = undefined;
        }
        if (session.logPath) {
            try {
                unlinkSync(session.logPath);
            }
            catch { }
        }
    }
    async start(input) {
        // Validate before spawning: rejected limits must not leave a child behind.
        const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_YIELD_MS);
        boundedInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
        if (input.timeoutSeconds !== undefined && (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0)) {
            throw new Error("Execution timeout must be positive and finite.");
        }
        const session = this.createSession(input);
        this.sessions.set(session.id, session);
        try {
            if (input.tty && process.platform !== "win32")
                await this.startPty(session, input);
            else
                this.startPipe(session, input);
        }
        catch (error) {
            this.discardLog(session);
            this.sessions.delete(session.id);
            throw error;
        }
        if (input.timeoutSeconds !== undefined) {
            session.timeoutSeconds = input.timeoutSeconds;
            if (session.running) {
                session.deadlineTimer = setTimeout(() => {
                    session.timedOut = true;
                    this.stop(session, "SIGTERM");
                }, Math.max(0, input.timeoutSeconds * 1_000 - (Date.now() - session.startedAt)));
            }
        }
        await this.waitForExit(session, yieldTimeMs);
        const snapshot = this.consume(session, input.maxOutputTokens);
        if (!session.running)
            this.removeSession(session.id);
        this.throwIfFailed(session, snapshot.output);
        return snapshot;
    }
    async write(input) {
        const session = this.getOwnedSession(input.workspaceId, input.sessionId);
        boundedInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
        const yieldTimeMs = boundedInteger(input.yieldTimeMs,
            input.chars || input.columns !== undefined || input.rows !== undefined
                ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS,
            MAX_YIELD_MS);
        const chars = input.chars ?? "";
        const interactionRequested = chars.length > 0 || input.columns !== undefined || input.rows !== undefined;
        if (!session.failure && (input.columns !== undefined || input.rows !== undefined)) {
            session.columns = terminalSize(input.columns, session.columns);
            session.rows = terminalSize(input.rows, session.rows);
            if (!session.process?.resize) {
                throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
            }
            session.process.resize(session.columns, session.rows);
        }
        const interruptRequested = chars.includes("\u0003") && session.running && !session.failure;
        if (interruptRequested) {
            this.stop(session, "SIGINT");
        }
        const writableChars = chars.replaceAll("\u0003", "");
        if (writableChars && session.running && !session.failure) {
            try {
                session.process?.write(writableChars);
            }
            catch (error) {
                this.fail(session, error);
            }
        }
        if ((session.failure || interactionRequested || !session.buffer.hasOutput()) && session.running) {
            await this.waitForExit(session, yieldTimeMs);
        }
        const snapshot = this.consume(session, input.maxOutputTokens);
        if (!session.running)
            this.removeSession(session.id);
        this.throwIfFailed(session, snapshot.output);
        return snapshot;
    }
    terminate(workspaceId, sessionId) {
        const session = this.getOwnedSession(workspaceId, sessionId);
        if (session.running)
            this.stop(session, "SIGTERM");
    }
    stop(session, signal) {
        session.process?.kill(signal);
        // Escalate even if the shell exits: descendants can ignore the signal
        // and close their pipes. Shutdown must await this tree cleanup too.
        session.terminationPromise ??= new Promise((resolve) => {
            setTimeout(() => {
                session.process?.kill("SIGKILL");
                // Detached groups are outside ownership but may retain our pipes.
                // Close those handles after the normal drain/termination grace.
                session.process?.closeStdio?.();
                resolve();
            }, 1_000);
        });
    }
    async shutdown() {
        const sessions = [...this.sessions.values()];
        for (const session of sessions) {
            if (session.running)
                this.stop(session, "SIGTERM");
        }
        await Promise.all(sessions.map(async (session) => {
            await session.terminationPromise;
            await session.exitPromise;
            if (session.cleanupTimer)
                clearTimeout(session.cleanupTimer);
        }));
        this.sessions.clear();
    }
    async waitForExit(session, yieldTimeMs) {
        if (session.failure)
            return;
        let timer;
        try {
            await Promise.race([
                session.exitPromise,
                new Promise((resolve) => {
                    timer = setTimeout(resolve, yieldTimeMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    createSession(input) {
        let resolveExit = () => undefined;
        const exitPromise = new Promise((resolve) => {
            resolveExit = resolve;
        });
        const session = {
            id: this.nextSessionId++,
            workspaceId: input.workspaceId,
            startedAt: Date.now(),
            columns: terminalSize(input.columns, DEFAULT_COLUMNS),
            rows: terminalSize(input.rows, DEFAULT_ROWS),
            buffer: new HeadTailBuffer(this.maxBufferCharacters),
            loggedBytes: 0,
            running: true,
            exitPromise,
            resolveExit,
        };
        session.logPath = this.openSessionLog(session);
        return session;
    }
    startPipe(session, input) {
        const shell = resolveShellCommand(input.command);
        const detached = process.platform !== "win32";
        const commandFromStdin = input.shellConfig?.commandTransport === "stdin";
        const command = input.shellConfig?.shell ?? input.command;
        const args = input.shellConfig
            ? [...input.shellConfig.args, ...(commandFromStdin ? [] : [input.command])]
            : [];
        const child = spawn(command, args, {
            cwd: input.cwd,
            env: processEnvironment({
                workspaceId: input.workspaceId,
                workspaceRoot: input.workspaceRoot,
            }),
            stdio: "pipe",
            windowsHide: true,
            detached,
            shell: input.shellConfig ? false : shell.executable,
        });
        session.process = {
            write: (data) => child.stdin.write(data),
            kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
            destroy: () => {
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
            },
            resize: input.tty ? () => undefined : undefined,
            closeStdio: () => {
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
            },
        };
        child.stdout.setEncoding("utf8").on("data", (data) => this.append(session, data));
        child.stderr.setEncoding("utf8").on("data", (data) => this.append(session, data));
        child.stdin.on("error", (error) => this.fail(session, error));
        child.stdout.on("error", (error) => this.fail(session, error));
        child.stderr.on("error", (error) => this.fail(session, error));
        child.on("error", (error) => this.fail(session, error));
        child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
        if (commandFromStdin)
            child.stdin.end(input.command);
    }
    async startPty(session, input) {
        let nodePty;
        try {
            nodePty = await import("node-pty");
        }
        catch {
            throw new Error("PTY support requires the optional node-pty dependency.");
        }
        const shell = resolveShellCommand(input.command);
        let pty;
        try {
            pty = nodePty.spawn(shell.executable, shell.args, {
                cwd: input.cwd,
                env: processEnvironment({
                    workspaceId: input.workspaceId,
                    workspaceRoot: input.workspaceRoot,
                }),
                name: "xterm-256color",
                cols: session.columns,
                rows: session.rows,
            });
        }
        catch (error) {
            throw error;
        }
        session.process = {
            write: (data) => pty.write(data),
            kill: (signal = "SIGTERM") => terminateProcessTree(pty, signal, true),
            resize: (columns, rows) => pty.resize(columns, rows),
        };
        pty.onData((data) => this.append(session, data));
        pty.onExit(({ exitCode, signal }) => {
            this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
        });
    }
    finish(session, exitCode, signal) {
        if (!session.running)
            return;
        // Do not publish completion while descendants still have the kill grace.
        if (session.terminationPromise && !session.terminationComplete) {
            void session.terminationPromise.then(() => {
                session.terminationComplete = true;
                this.finish(session, exitCode, signal);
            });
            return;
        }
        session.running = false;
        if (session.deadlineTimer)
            clearTimeout(session.deadlineTimer);
        session.deadlineTimer = undefined;
        session.exitCode = exitCode;
        session.signal = signal;
        session.resolveExit();
        if (session.logStream) {
            session.logStream.end();
            session.logStream = undefined;
        }
        if (session.logPath) {
            const logPath = session.logPath;
            session.logCleanupTimer = setTimeout(() => {
                try {
                    unlinkSync(logPath);
                }
                catch { }
            }, this.logRetentionMs);
            session.logCleanupTimer.unref();
        }
        session.cleanupTimer = setTimeout(() => this.sessions.delete(session.id), this.completedSessionTtlMs);
        session.cleanupTimer.unref();
    }
    fail(session, error) {
        if (!session.running || session.failure)
            return;
        session.failure = error instanceof Error ? error : new Error(String(error));
        this.append(session, `${session.failure.message}\n`);
        try {
            session.process?.kill("SIGKILL");
        }
        catch { }
        try {
            session.process?.destroy?.();
        }
        catch { }
        this.finish(session, undefined, "SIGKILL");
    }
    throwIfFailed(session, output) {
        if (!session.failure)
            return;
        throw new Error(`Process I/O failed: ${output || session.failure.message}`);
    }
    append(session, output) {
        session.buffer.append(output);
        if (session.logStream) {
            session.loggedBytes += Buffer.byteLength(output, "utf8");
            session.logStream.write(output);
        }
    }
    // Errors at the end are why head+tail beats a simple head truncation: the
    // marker carries the exact omitted size and the absolute log path holding
    // the complete output, so the model can rg/sed-n it instead of rerunning.
    truncationMarker(session, omittedCharacters) {
        const logNote = session.logPath
            ? `full output (${session.loggedBytes} bytes) logged at ${session.logPath} -- use rg or sed -n on that path to inspect the rest`
            : "full output was not retained on disk (log unavailable)";
        return `\n... output truncated: ${omittedCharacters} characters omitted; ${logNote} ...`;
    }
    consume(session, maxOutputTokens) {
        const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
        const maxCharacters = Math.max(256, limit * 4);
        const drained = session.buffer.drain(maxCharacters);
        const output = drained.truncated
            ? drained.text + this.truncationMarker(session, drained.omittedCharacters)
            : drained.text;
        return {
            sessionId: session.running ? session.id : undefined,
            output,
            outputTruncated: drained.truncated,
            running: session.running,
            exitCode: session.exitCode,
            signal: session.signal,
            timedOut: session.timedOut ?? false,
            timeoutSeconds: session.timeoutSeconds,
            wallTimeMs: Date.now() - session.startedAt,
        };
    }
    getOwnedSession(workspaceId, sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown process session: ${sessionId}`);
        if (session.workspaceId !== workspaceId) {
            throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
        }
        return session;
    }
    removeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session?.cleanupTimer) {
            clearTimeout(session.cleanupTimer);
            session.cleanupTimer = undefined;
        }
        if (session?.terminationPromise) {
            void session.terminationPromise.then(() => this.sessions.delete(sessionId));
        }
        else {
            this.sessions.delete(sessionId);
        }
    }
}
