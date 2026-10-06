import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";
import type { WorkspaceStore } from "./workspace-store.js";

export interface CliWorkspaceContext {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface DurableAgentWorkspaceContext {
  worktreeRoot: string;
  workspaceStore: Pick<WorkspaceStore, "getSession">;
}

/** Checkout authority is unchanged; worktrees require their durable admission. */
export function assertLocalAgentWorkspaceAllowed(
  workspaceRoot: string,
  workspaceId: string,
  allowedRoots: readonly string[],
  durableContext?: DurableAgentWorkspaceContext,
): string {
  try {
    return assertAllowedPath(workspaceRoot, [...allowedRoots]);
  } catch (cause) {
    if (!durableContext) throw cause;
    const session = durableContext.workspaceStore.getSession(workspaceId);
    if (!session || session.id !== workspaceId || session.mode !== "worktree" || !session.managed ||
        !session.sourceRoot || canonicalizePath(session.root) !== canonicalizePath(workspaceRoot)) {
      throw cause;
    }
    assertAllowedPath(canonicalizePath(session.sourceRoot), allowedRoots.map(canonicalizePath));
    assertAllowedPath(canonicalizePath(workspaceRoot), [canonicalizePath(durableContext.worktreeRoot)]);
    return resolve(workspaceRoot);
  }
}

/** Resolve the project context used by local agent commands. */
export function resolveCliWorkspaceContext(
  allowedRoots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  durableContext?: DurableAgentWorkspaceContext,
): CliWorkspaceContext {
  const workspaceId = env.DEVSPACE_WORKSPACE_ID?.trim() || undefined;
  const injectedRoot = workspaceId ? env.DEVSPACE_WORKSPACE_ROOT?.trim() : undefined;
  const candidate = canonicalizePath(
    injectedRoot ? resolve(injectedRoot) : findGitRoot(cwd) ?? resolve(cwd),
  );

  if (!workspaceId) return { workspaceId, workspaceRoot: candidate };

  return {
    workspaceId,
    workspaceRoot: assertLocalAgentWorkspaceAllowed(
      candidate,
      workspaceId,
      allowedRoots.map(canonicalizePath),
      durableContext,
    ),
  };
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function findGitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(cwd),
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? resolve(root) : undefined;
}
