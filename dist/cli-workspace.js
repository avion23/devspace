import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";
/** Resolve the project context used by local agent commands. */
export function resolveCliWorkspaceContext(allowedRoots, env = process.env, cwd = process.cwd()) {
    const workspaceId = env.DEVSPACE_WORKSPACE_ID?.trim() || undefined;
    const injectedRoot = workspaceId ? env.DEVSPACE_WORKSPACE_ROOT?.trim() : undefined;
    const candidate = canonicalizePath(injectedRoot ? resolve(injectedRoot) : findGitRoot(cwd) ?? resolve(cwd));
    if (!workspaceId)
        return { workspaceId, workspaceRoot: candidate };
    return {
        workspaceId,
        workspaceRoot: assertAllowedPath(candidate, allowedRoots.map(canonicalizePath)),
    };
}
function canonicalizePath(path) {
    try {
        return realpathSync.native(path);
    }
    catch {
        return resolve(path);
    }
}
function findGitRoot(cwd) {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: resolve(cwd),
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0)
        return undefined;
    const root = result.stdout.trim();
    return root ? resolve(root) : undefined;
}
