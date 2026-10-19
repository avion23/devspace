import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { assertLocalAgentWorkspaceAllowed, canonicalizePath, type DurableAgentWorkspaceContext } from "./roots.js";

export interface CliWorkspaceContext {
  workspaceId?: string;
  workspaceRoot: string;
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
