#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createLocalAgentDrivers } from "./local-agent-adapters.js";
import { getLinuxSandboxProbeState } from "./local-agent-codex.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import { LocalAgentDaemon, writeLocalAgentDaemonLog, type LocalAgentDaemonStopReason } from "./local-agent-daemon.js";
import {
  LocalAgentDaemonAlreadyRunningError,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { FORK_REVISION } from "./fork-revision.js";
import { createWorkspaceStore } from "./workspace-store.js";

const config = loadConfig();
const daemonBuildVersion = `${readPackageVersion()}-${FORK_REVISION}`;
const DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;
const paths = localAgentDaemonPaths(config.stateDir);
const log = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => writeLocalAgentDaemonLog(paths, level, event, fields);
const store = new LocalAgentStore(paths.stateDir);
const workspaceStore = createWorkspaceStore(config.stateDir);
const drivers = createLocalAgentDrivers({
  sandboxFallback: config.subagents.sandboxFallback,
  worktreeRoot: config.worktreeRoot,
  onSandboxFallback: (fields) => log("warn", "codex_sandbox_fallback", fields),
  codexSandboxMode: config.subagents.providers.find((entry) => entry.id === "codex")?.sandboxMode ?? "auto",
});
const manager = new LocalAgentManager({
  store,
  drivers,
  pool: new LocalAgentRuntimePool({ logger: log }),
  loadProfiles: (workspaceRoot) => loadLocalAgentProfiles(config, workspaceRoot, { includeDisabled: true }),
  agentDir: config.agentDir,
  allowedRoots: config.allowedRoots,
  durableWorkspaceContext: { workspaceStore, worktreeRoot: config.worktreeRoot },
  logger: log,
  subagents: config.subagents,
});
const daemon = new LocalAgentDaemon({
  stateDir: paths.stateDir,
  manager,
  onLockAcquired: () => {
    const reconciled = manager.reconcileActiveRuns();
    if (reconciled.isErr()) throw reconciled.error;
  },
  onClosed: () => {
    workspaceStore.close?.();
    if (!shuttingDown) process.exit(0);
  },
  idleShutdownMs: parseIdleShutdownMs(process.env.DEVSPACE_AGENTD_IDLE_TIMEOUT_MS),
  buildVersion: daemonBuildVersion,
  sandboxFallback: config.subagents.sandboxFallback,
  getSandboxProbeState: getLinuxSandboxProbeState,
});

let shuttingDown = false;
const shutdown = (reason: LocalAgentDaemonStopReason) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceTimer = setTimeout(() => {
    log("error", "daemon_forced_shutdown", {
      activeTurns: manager.activeTurnCount,
      runtimeCount: manager.runtimeCount,
    });
    // Active records intentionally remain durable. The next daemon startup
    // reconciles them to error while preserving provider continuation data.
    process.exit(1);
  }, parseShutdownTimeoutMs(process.env.DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS));
  forceTimer.unref();
  void daemon.close(reason).finally(() => process.exit(0));
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// The daemon is spawned with stdio ignored, so a fatal error that Node prints
// to stderr is lost. Record it before exiting; active runs stay durable and
// are reconciled by the next daemon start.
const exitOnFatal = (event: "uncaught_exception" | "unhandled_rejection") => (error: unknown) => {
  log("error", `daemon_${event}`, {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    activeTurns: manager.activeTurnCount,
    runtimeCount: manager.runtimeCount,
  });
  process.exit(1);
};
process.once("uncaughtException", exitOnFatal("uncaught_exception"));
process.once("unhandledRejection", exitOnFatal("unhandled_rejection"));

try {
  await daemon.start();
} catch (error) {
  if (error instanceof LocalAgentDaemonAlreadyRunningError) {
    await manager.close();
    workspaceStore.close?.();
    process.exit(0);
  }
  log("error", "daemon_start_failed", { error: error instanceof Error ? error.message : String(error) });
  await manager.close();
  workspaceStore.close?.();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseIdleShutdownMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 30_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("DEVSPACE_AGENTD_IDLE_TIMEOUT_MS must be a non-negative duration.");
  }
  return parsed;
}

function parseShutdownTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS must be a non-negative duration.");
  }
  return parsed;
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}
