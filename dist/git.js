import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
// Default budget mirrors the 10s execFile timeout already used for repo_status
// in server.js. Subcommands that routinely do more work (diffing or staging a
// large working tree) get a larger, still-bounded budget; every call must
// finish well inside the ~30s tool-call yield window.
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS_BY_SUBCOMMAND = {
    diff: 20_000,
    add: 15_000,
};
export async function git(cwd, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS_BY_SUBCOMMAND[args[0]] ?? DEFAULT_GIT_TIMEOUT_MS;
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd,
            env: {
                ...(options.env ? { ...process.env, ...options.env } : process.env),
                GIT_TERMINAL_PROMPT: "0",
            },
            maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
            timeout: timeoutMs,
            killSignal: "SIGTERM",
        });
        return { stdout, stderr };
    }
    catch (error) {
        if (error && typeof error === "object" && error.killed) {
            throw new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`);
        }
        throw error;
    }
}
export async function getGitEligibility(cwd) {
    try {
        await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    }
    catch {
        return {
            ok: false,
            reason: "not_git",
            message: "workspace is not inside a git repository",
        };
    }
    const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
    try {
        await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    }
    catch {
        return {
            ok: false,
            gitRoot,
            reason: "no_head",
            message: "repository has no HEAD commit",
        };
    }
    return { ok: true, gitRoot };
}
export function safeWorkspaceRefSegment(workspaceId) {
    const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
    return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}
