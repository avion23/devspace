import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { CodexLocalAgentDriver } from "./local-agent-codex.js";
import type {
  CodexCommandResolver,
  ExecFileImplementation,
  LinuxSandboxProbeResult,
} from "./local-agent-codex.js";
import type {
  LocalAgentDriver,
  LocalAgentSandboxFallbackEvent,
} from "./local-agent-runtime-pool.js";

export type LocalAgentAdapter = LocalAgentDriver;

export interface LocalAgentDriverOptions {
  env?: NodeJS.ProcessEnv;
  codexCommandResolver?: CodexCommandResolver;
  sandboxFallback?: "fail" | "worktree-embedded";
  worktreeRoot?: string;
  sandboxProbe?: () => Promise<LinuxSandboxProbeResult | boolean>;
  onSandboxFallback?: (event: LocalAgentSandboxFallbackEvent) => void | Promise<void>;
  sandboxProbeTtlMs?: number;
  execFile?: ExecFileImplementation;
  codexSandboxMode?: "auto" | "full-access";
}

export function createLocalAgentDrivers(
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver[] {
  return [
    new CodexLocalAgentDriver(options.env, options.codexCommandResolver, {
      sandboxFallback: options.sandboxFallback,
      worktreeRoot: options.worktreeRoot,
      sandboxProbe: options.sandboxProbe,
      onSandboxFallback: options.onSandboxFallback,
      sandboxProbeTtlMs: options.sandboxProbeTtlMs,
      execFile: options.execFile,
      sandboxMode: options.codexSandboxMode,
    }),
  ];
}

export function createLocalAgentAdapter(
  provider: LocalAgentProvider,
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver | undefined {
  if (provider !== "codex") return undefined;
  return new CodexLocalAgentDriver(options.env, options.codexCommandResolver, {
    sandboxFallback: options.sandboxFallback,
    worktreeRoot: options.worktreeRoot,
    sandboxProbe: options.sandboxProbe,
    onSandboxFallback: options.onSandboxFallback,
    sandboxProbeTtlMs: options.sandboxProbeTtlMs,
    execFile: options.execFile,
    sandboxMode: options.codexSandboxMode,
  });
}