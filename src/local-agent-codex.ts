import { homedir } from "node:os";
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isSandboxFallbackEnabled } from "./local-agent-config.js";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  AgentSandboxUnavailableError,
  captureAgentProviderResult,
  errorMessage,
} from "./local-agent-errors.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import { terminateProcessTree } from "./process-platform.js";
import { resolveAllowedPath } from "./roots.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentSandboxFallbackEvent,
  LocalAgentSandboxMetadata,
  LocalAgentWriteMode,
} from "./local-agent-runtime-pool.js";

export interface ResolvedCodexCommand {
  executable: string;
  version?: string;
}

export type CodexCommandResolver = (env: NodeJS.ProcessEnv) => ResolvedCodexCommand | undefined;

export function codexCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (env.CODEX_COMMAND) return next;
  if (next.PATH) next.PATH = removeDevspaceNodeModulesBinFromPath(next.PATH);
  return next;
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): ResolvedCodexCommand | undefined {
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
    if (code === "ENOENT") continue;
    if (result.error || result.status !== 0) continue;
    return { executable: candidate, version: parseCodexVersion(result.stdout) };
  }
  return undefined;
}

export function isCodexAppServerSupported(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = spawnSync(command, ["app-server", "--help"], {
    encoding: "utf8",
    env: codexCommandEnvironment(env),
    windowsHide: true,
    timeout: 5_000,
    shell: usesWindowsCommandShell(command),
  });
  return result.error === undefined && result.status === 0;
}

export function parseCodexVersion(output: string | undefined): string | undefined {
  const match = output?.trim().match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1];
}

export const sandboxProbeTtlMs = 60_000;

const LINUX_SANDBOX_PROBE_TIMEOUT_MS = 5_000;
const LINUX_SANDBOX_PROBE_COMMAND = "unshare -Ur true";
const MAX_SANDBOX_PROBE_STDERR_BYTES = 8 * 1024;

type LinuxSandboxProbeOutcome = "ok" | "denied" | "indeterminate";

interface LinuxSandboxProbeResult {
  outcome: LinuxSandboxProbeOutcome;
  reason?: string;
  code?: number | string;
  signal?: string;
  stderr?: string;
}

export interface LinuxSandboxProbeState {
  outcome: LinuxSandboxProbeOutcome | "unknown";
  at?: string;
}

export type ExecFileImplementation = typeof execFile;

export interface ProbeLinuxUserNamespaceOptions {
  ttlMs?: number;
  sandboxProbeTtlMs?: number;
  now?: () => number;
}

let linuxSandboxProbeCache: { result: LinuxSandboxProbeResult; at: number } | undefined;
let linuxSandboxProbeInFlight: Promise<LinuxSandboxProbeResult> | undefined;
let linuxSandboxProbeImplementation: ExecFileImplementation | undefined;
let linuxSandboxProbeGeneration = 0;

export function resetSandboxProbeCache(): void {
  linuxSandboxProbeGeneration += 1;
  linuxSandboxProbeCache = undefined;
  linuxSandboxProbeInFlight = undefined;
  linuxSandboxProbeImplementation = undefined;
}

export function getLinuxSandboxProbeState(): LinuxSandboxProbeState {
  if (!linuxSandboxProbeCache) return { outcome: "unknown", at: undefined };
  return {
    outcome: linuxSandboxProbeCache.result.outcome,
    at: new Date(linuxSandboxProbeCache.at).toISOString(),
  };
}

export function probeLinuxUserNamespace(
  execFileImpl: ExecFileImplementation = execFile,
  options: ProbeLinuxUserNamespaceOptions = {},
): Promise<LinuxSandboxProbeResult> {
  if (process.platform !== "linux") return Promise.resolve({ outcome: "ok" });
  const ttlMs = options.ttlMs ?? options.sandboxProbeTtlMs ?? sandboxProbeTtlMs;
  const now = options.now ?? Date.now;
  const cached = linuxSandboxProbeCache;
  if (cached && linuxSandboxProbeImplementation === execFileImpl && now() - cached.at < ttlMs)
    return Promise.resolve(cached.result);
  if (linuxSandboxProbeInFlight) return linuxSandboxProbeInFlight;

  linuxSandboxProbeImplementation = execFileImpl;
  const generation = linuxSandboxProbeGeneration;
  const probe = new Promise<LinuxSandboxProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: LinuxSandboxProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = execFileImpl("unshare", ["-Ur", "true"], {
        timeout: LINUX_SANDBOX_PROBE_TIMEOUT_MS,
        windowsHide: true,
      }, (error, _stdout, stderr) => finish(classifySandboxProbeError(error, stderr)));
      if (child && typeof (child as { then?: unknown }).then === "function") {
        (child as unknown as Promise<unknown>).then(
          () => finish({ outcome: "ok" }),
          (error) => finish(classifySandboxProbeError(error)),
        );
      }
    } catch (error) {
      finish(classifySandboxProbeError(error));
    }
  });

  const inFlight = probe
    .then((result) => {
      if (generation === linuxSandboxProbeGeneration) linuxSandboxProbeCache = { result, at: now() };
      return result;
    })
    .finally(() => {
      if (linuxSandboxProbeInFlight === inFlight) linuxSandboxProbeInFlight = undefined;
    });
  linuxSandboxProbeInFlight = inFlight;
  return inFlight;
}

export const probeLinuxSandbox = probeLinuxUserNamespace;

interface SandboxProbeErrorLike {
  code?: number | string;
  signal?: unknown;
  timedOut?: boolean;
  killed?: boolean;
  stderr?: unknown;
}

function classifySandboxProbeError(error?: unknown, stderr?: string): LinuxSandboxProbeResult {
  if (!error) return { outcome: "ok" };
  const code = (error as SandboxProbeErrorLike)?.code;
  if (code === "ENOENT") return { outcome: "indeterminate", reason: "not_found" };
  const signal = typeof (error as SandboxProbeErrorLike)?.signal === "string" ? (error as SandboxProbeErrorLike).signal as string : undefined;
  if ((error as SandboxProbeErrorLike)?.timedOut === true || code === "ETIMEDOUT" || ((error as SandboxProbeErrorLike)?.killed === true && (!signal || signal === "SIGTERM")))
    return { outcome: "indeterminate", reason: "timeout" };
  if (signal) return { outcome: "indeterminate", reason: `signal ${signal}` };
  if (typeof code === "number") {
    const capturedStderr = boundedProbeStderr(error as SandboxProbeErrorLike, stderr);
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
  if (code === "ENOENT") return { outcome: "indeterminate", reason: "not_found" };
  return { outcome: "indeterminate", reason: "spawn_error" };
}

function boundedProbeStderr(error: { stderr?: unknown }, stderr?: string): string {
  const value = stderr ?? error?.stderr;
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_SANDBOX_PROBE_STDERR_BYTES) return text;
  const marker = text.search(/Operation not permitted|\bEPERM\b/i);
  const markerByte = marker < 0 ? -1 : Buffer.byteLength(text.slice(0, marker), "utf8");
  const tailStart = bytes.length - MAX_SANDBOX_PROBE_STDERR_BYTES;
  const start = markerByte < 0 ? tailStart : Math.min(markerByte, tailStart);
  return bytes.subarray(start, start + MAX_SANDBOX_PROBE_STDERR_BYTES).toString("utf8");
}

export interface CodexAppServerRuntimeOptions {
  command: string;
  env: NodeJS.ProcessEnv;
  version?: string;
  sandboxFallback?: "fail" | "worktree-embedded";
  worktreeRoot?: string;
  sandboxProbe?: () => Promise<LinuxSandboxProbeResult | boolean>;
  onSandboxFallback?: (event: LocalAgentSandboxFallbackEvent) => void | Promise<void>;
  sandboxProbeTtlMs?: number;
  execFile?: ExecFileImplementation;
  sandboxMode?: "auto" | "full-access";
}

export class CodexAppServerRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: CodexAppServerRpc;
  private alive = true;
  private closePromise?: Promise<void>;

  constructor(private readonly options: CodexAppServerRuntimeOptions) {
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
      this.rpc.fail(new Error(
        `codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`,
      ));
    });
    this.child.once("error", (error) => {
      this.alive = false;
      this.rpc.fail(error);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "devspace", title: "DevSpace", version: "1.0.7" },
      capabilities: {},
    });
    this.rpc.notify("initialized");
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
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
            } catch {
              // Logging must never prevent a validated fallback from running.
            }
          },
        });
        const providerInput = sandbox.workspaceRoot
          ? { ...input, workspaceRoot: sandbox.workspaceRoot }
          : input;
        const threadResponse = await this.rpc.request(
          providerInput.providerSessionId ? "thread/resume" : "thread/start",
          threadParams(providerInput, sandbox),
        );
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

  async releaseSession(providerSessionId: string): Promise<void> {
    if (!this.alive) return;
    try {
      await this.rpc.request("thread/unsubscribe", { threadId: providerSessionId });
    } catch {
      // Unsubscribe is an optimization; persisted thread identity remains valid.
    }
  }

  isAlive(): boolean {
    return this.alive && !this.child.killed && this.child.exitCode === null;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.alive = false;
      this.rpc.fail(new Error("codex app-server closed."));
      if (!this.child.stdin.destroyed) this.child.stdin.end();
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

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
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

export class CodexLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "codex" as const;
  readonly idleTimeoutMs = 5 * 60_000;

  private commandResolved = false;
  private resolvedCommand?: ResolvedCodexCommand;
  private readonly sandboxFallback: "fail" | "worktree-embedded";
  private readonly worktreeRoot?: string;
  private readonly sandboxProbe?: () => Promise<LinuxSandboxProbeResult | boolean>;
  private readonly onSandboxFallback?: (event: LocalAgentSandboxFallbackEvent) => void | Promise<void>;
  private readonly sandboxProbeTtlMs?: number;
  private readonly execFile?: ExecFileImplementation;
  private readonly sandboxMode: "auto" | "full-access";

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: CodexCommandResolver = resolveCodexCommand,
    options: {
      sandboxFallback?: "fail" | "worktree-embedded";
      worktreeRoot?: string;
      sandboxProbe?: () => Promise<LinuxSandboxProbeResult | boolean>;
      onSandboxFallback?: (event: LocalAgentSandboxFallbackEvent) => void | Promise<void>;
      sandboxProbeTtlMs?: number;
      execFile?: ExecFileImplementation;
      sandboxMode?: "auto" | "full-access";
    } = {},
  ) {
    this.sandboxFallback = options.sandboxFallback ?? "fail";
    this.sandboxMode = options.sandboxMode ?? "auto";
    this.worktreeRoot = options.worktreeRoot;
    this.sandboxProbe = options.sandboxProbe;
    this.onSandboxFallback = options.onSandboxFallback;
    this.sandboxProbeTtlMs = options.sandboxProbeTtlMs;
    this.execFile = options.execFile;
  }

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand();
    const executable = command?.executable ?? this.env.CODEX_COMMAND ?? "codex";
    const codexHome = resolve(this.env.CODEX_HOME ?? join(homedir(), ".codex"));
    return `codex:${executable}:${codexHome}`;
  }

  async createRuntime(_context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
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
          sandboxMode: this.sandboxMode,
        });
        try {
          await runtime.initialize();
          return runtime;
        } catch (cause) {
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

  private resolveCommand(): ResolvedCodexCommand | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

const MAX_TURN_ITEMS = 10_000;
const MAX_STDERR_BYTES = 32 * 1024;

interface CodexEvent {
  method: string;
  params?: unknown;
}

interface CodexTurnResult {
  event: CodexEvent;
  items: unknown[];
}

interface CodexTurnAccumulator {
  threadId: string;
  turnId?: string;
  items: unknown[];
  completed?: CodexEvent;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

class CodexAppServerRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly turns = new Map<string, CodexTurnAccumulator>();
  private nextId = 1;
  private fatalError?: Error;
  private buffer = "";
  private stderr = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly version?: string,
  ) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.handleLine(line));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async runTurn(threadId: string, params: unknown): Promise<CodexTurnResult> {
    if (this.fatalError) throw this.fatalError;
    if (this.turns.has(threadId)) throw new Error(`Codex thread ${threadId} already has an active turn.`);
    let resolveTurn!: (result: CodexTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const turn: CodexTurnAccumulator = {
      threadId,
      items: [],
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.turns.set(threadId, turn);
    try {
      const response = await this.request("turn/start", params);
      turn.turnId = readString(asRecord(response)?.turn, "id");
      if (turn.completed) return { event: turn.completed, items: turn.items };
      return await completion;
    } finally {
      if (this.turns.get(threadId) === turn) this.turns.delete(threadId);
    }
  }

  fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = new Error(`${error.message}${this.stderr.trim() ? `\n${this.stderr.trim()}` : ""}${this.version ? `\ncodex version: ${this.version}` : ""}`);
    for (const pending of this.pending.values()) pending.reject(this.fatalError);
    for (const turn of this.turns.values()) turn.reject(this.fatalError);
    this.pending.clear();
    this.turns.clear();
  }

  private write(message: Record<string, unknown>): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    this.buffer += line;
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.fail(new Error("codex app-server emitted malformed JSON."));
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id && !method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error !== undefined) pending.reject(new Error(protocolErrorText(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (id && method) {
      this.write({ id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
      return;
    }
    if (!method) return;
    const event = { method, params: message.params };
    const turn = this.findTurn(event);
    if (!turn) return;
    const params = asRecord(event.params);
    if (params?.item !== undefined) {
      turn.items.push(params.item);
      if (turn.items.length > MAX_TURN_ITEMS) turn.items.shift();
    }
    if (event.method !== "turn/completed" || !turnMatchesEvent(turn, event)) return;
    turn.completed = event;
    turn.resolve({ event, items: turn.items.slice() });
  }

  private findTurn(event: CodexEvent): CodexTurnAccumulator | undefined {
    const params = asRecord(event.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params?.turnId === "string"
      ? params.turnId
      : readString(asRecord(params?.turn), "id");
    if (threadId) return this.turns.get(threadId);
    if (!turnId) return undefined;
    return Array.from(this.turns.values()).find((turn) => turn.turnId === turnId);
  }
}

function threadParams(
  input: LocalAgentRunInput,
  sandbox: CodexSandboxResolution = normalCodexSandbox(input),
): Record<string, unknown> {
  return {
    ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
    cwd: input.workspaceRoot,
    approvalPolicy: "never",
    sandbox: sandbox.sandbox,
    ...(input.model ? { model: input.model } : {}),
  };
}

function turnParams(
  input: LocalAgentRunInput,
  threadId: string,
  sandbox: CodexSandboxResolution = normalCodexSandbox(input),
): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: input.prompt }],
    approvalPolicy: "never",
    sandboxPolicy: sandbox.sandboxPolicy,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  };
}

export function sandboxFor(writeMode: LocalAgentWriteMode | undefined): string {
  switch (writeMode) {
    case "allowed": return "workspace-write";
    case "full_access": return "danger-full-access";
    case "read_only":
    case undefined: return "read-only";
  }
}

function sandboxPolicyFor(writeMode: LocalAgentWriteMode | undefined): Record<string, string> {
  switch (writeMode) {
    case "allowed": return { type: "workspaceWrite" };
    case "full_access": return { type: "dangerFullAccess" };
    case "read_only":
    case undefined: return { type: "readOnly" };
  }
}

interface CodexSandboxResolution {
  sandbox: string;
  sandboxPolicy: Record<string, string>;
  workspaceRoot?: string;
  metadata?: LocalAgentSandboxMetadata;
}

interface ResolveCodexSandboxOptions {
  sandboxMode?: "auto" | "full-access";
  sandboxFallback?: "fail" | "worktree-embedded";
  worktreeRoot?: string;
  sandboxProbe?: () => Promise<LinuxSandboxProbeResult | boolean>;
  execFile?: ExecFileImplementation;
  sandboxProbeTtlMs?: number;
  onSandboxFallback?: (event: LocalAgentSandboxFallbackEvent) => void | Promise<void>;
}

function normalCodexSandbox(input: LocalAgentRunInput): CodexSandboxResolution {
  return {
    sandbox: sandboxFor(input.writeMode),
    sandboxPolicy: sandboxPolicyFor(input.writeMode),
  };
}

export async function resolveCodexSandbox(
  input: LocalAgentRunInput,
  options: ResolveCodexSandboxOptions = {},
): Promise<CodexSandboxResolution> {
  const normal = normalCodexSandbox(input);
  if (options.sandboxMode === "full-access") {
    // Operator-explicit unsandboxed mode. Keep the same durable audit trail
    // the sandbox-fallback path records (previouslyUnsandboxed metadata), so
    // full-access turns are not indistinguishable from sandboxed ones.
    const warning = "Codex is running WITHOUT an OS sandbox as the daemon account: unrestricted filesystem and network access. This is the operator-configured full-access sandbox mode for the codex provider.";
    const metadata: LocalAgentSandboxMetadata = {
      sandbox: "full-access",
      warnings: [warning],
    };
    await options.onSandboxFallback?.({
      provider: "codex",
      workspaceRoot: input.workspaceRoot,
      sandbox: "full-access",
      warning,
      metadata,
    });
    return {
      sandbox: sandboxFor("full_access"),
      sandboxPolicy: sandboxPolicyFor("full_access"),
      metadata,
    };
  }

  if (process.platform !== "linux" || normal.sandbox === "danger-full-access") return normal;

  let probe: LinuxSandboxProbeResult;
  try {
    probe = options.sandboxProbe
      ? normalizeSandboxProbe(await options.sandboxProbe())
      : await probeLinuxUserNamespace(options.execFile, { ttlMs: options.sandboxProbeTtlMs });
  } catch (cause) {
    probe = classifySandboxProbeError(cause);
  }

  if (probe.outcome === "ok") return normal;

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

  let workspaceRoot: string;
  try {
    workspaceRoot = resolveAllowedPath(
      ".",
      realpathSync(input.workspaceRoot),
      options.worktreeRoot ? [options.worktreeRoot] : [],
    );
  } catch (cause) {
    throw sandboxUnavailable({
      stage: "worktree-confinement",
      detail: "The no-OS-sandbox fallback requires the session cwd to resolve under the configured worktree root.",
      fallbackAvailable: false,
      operation: "run",
      cause,
    });
  }

  const warning = "Codex is running WITHOUT an OS sandbox as the daemon account: unrestricted filesystem and network access. The worktree check authorized only the starting directory; it does not confine execution. Enable this fallback for trusted workloads only.";
  const metadata: LocalAgentSandboxMetadata = {
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

function normalizeSandboxProbe(value: LinuxSandboxProbeResult | boolean): LinuxSandboxProbeResult {
  if (value === true) return { outcome: "ok" };
  if (value === false) return { outcome: "denied" };
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

function indeterminateProbeDetail(probe: LinuxSandboxProbeResult): string {
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

function deniedProbeDetail(probe: LinuxSandboxProbeResult): string {
  const status = probe.code === undefined ? "failed" : `exited with code ${String(probe.code)}`;
  const signal = probe.signal ? ` (signal ${probe.signal})` : "";
  const stderr = typeof probe.stderr === "string" && probe.stderr.trim() ? ` stderr: ${JSON.stringify(probe.stderr.trim())}` : "";
  return `Linux user namespace probe denied: ${LINUX_SANDBOX_PROBE_COMMAND} ${status}${signal}.${stderr} set subagents.sandboxFallback to "worktree-embedded" to permit unsandboxed execution from an eligible worktree. after host fixes run: devspace agents daemon stop`;
}

function sandboxUnavailable(fields: {
  stage: string;
  detail: string;
  fallbackAvailable: boolean;
  operation: string;
  retryable?: boolean;
  cause?: unknown;
}): AgentSandboxUnavailableError {
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

function parseCompletedTurn(params: unknown, items: unknown[]): {
  finalResponse: string;
  items: unknown[];
  failure?: string;
} {
  const turn = asRecord(asRecord(params)?.turn);
  const completedItems = (Array.isArray(turn?.items) ? turn.items : items).slice(-MAX_TURN_ITEMS);
  let finalResponse = "";
  for (const item of completedItems) {
    const record = asRecord(item);
    if (!record) continue;
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

export function codexAppServerError(message: string, version?: string, stderr?: string): Error {
  return new Error([
    message,
    version ? `codex version: ${version}` : undefined,
    stderr?.trim() ? `stderr:\n${stderr.trim()}` : undefined,
  ].filter(Boolean).join("\n"));
}

function commandCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (command.includes("/") || command.includes("\\") || /\.(?:cmd|bat|exe|com)$/i.test(command)) return [command];
  const path = env.PATH;
  if (!path) return [command];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return path.split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => resolve(directory, `${command}${extension}`)));
}

function usesWindowsCommandShell(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function turnMatchesEvent(turn: CodexTurnAccumulator, event: CodexEvent): boolean {
  const params = asRecord(event.params);
  const eventThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const eventTurnId = typeof params?.turnId === "string"
    ? params.turnId
    : readString(asRecord(params?.turn), "id");
  if (eventThreadId && eventThreadId !== turn.threadId) return false;
  if (turn.turnId && eventTurnId && turn.turnId !== eventTurnId) return false;
  return eventThreadId === turn.threadId || Boolean(turn.turnId && eventTurnId === turn.turnId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function protocolErrorText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return String(value);
  const message = directString(record.message);
  const code = record.code;
  return message ? `codex app-server${code === undefined ? "" : ` ${String(code)}`}: ${message}` : String(value);
}

function appendTail(value: string, chunk: string, maxBytes: number): string {
  const next = value + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const bytes = Buffer.from(next, "utf8");
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}
