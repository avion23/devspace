import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";
const REVIEW_REF_PREFIX = "refs/devspace/review";
export function createReviewCheckpointManager() {
    const states = new Map();
    const initializations = new Map();
    return {
        async initializeWorkspace({ workspaceId, root }) {
            const existingState = states.get(workspaceId);
            assertWorkspaceRoot(existingState, workspaceId, root);
            if (existingState?.root === root && existingState.gitRoot !== undefined) {
                return;
            }
            const pending = initializations.get(workspaceId);
            if (pending) {
                await pending;
                assertWorkspaceRoot(states.get(workspaceId), workspaceId, root);
                return;
            }
            const initialize = initializeWorkspaceState(states, workspaceId, root);
            initializations.set(workspaceId, initialize);
            try {
                await initialize;
            }
            finally {
                if (initializations.get(workspaceId) === initialize) {
                    initializations.delete(workspaceId);
                }
            }
        },
        async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
            let state = states.get(workspaceId);
            assertWorkspaceRoot(state, workspaceId, root);
            if (!isReadyState(state)) {
                await this.initializeWorkspace({ workspaceId, root });
                state = states.get(workspaceId);
            }
            assertWorkspaceRoot(state, workspaceId, root);
            if (!state?.gitRoot) {
                throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
            }
            let effectiveSince = since;
            let usedWorkspaceOpenFallback = false;
            if (since === "last_shown" && !state.baselineRefAvailable) {
                if (!state.openRefAvailable) {
                    throw new Error("Review checkpoints are missing; show_changes cannot reconstruct that history safely.");
                }
                effectiveSince = "workspace_open";
                usedWorkspaceOpenFallback = true;
            }
            else if (since === "workspace_open" && !state.openRefAvailable) {
                throw new Error("The workspace-open review checkpoint is missing; show_changes cannot reconstruct that history safely.");
            }
            const baselineRef = effectiveSince === "workspace_open" ? state.openRef : state.baselineRef;
            const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
            const current = await createWorkingTreeSnapshot(state.gitRoot);
            const patch = (await git(state.gitRoot, ["diff", "--binary", "--no-color", baseline, current], {
                maxBuffer: 50 * 1024 * 1024,
            })).stdout;
            const numstat = (await git(state.gitRoot, ["diff", "--numstat", "-z", baseline, current], {
                maxBuffer: 50 * 1024 * 1024,
            })).stdout;
            const files = parseNumstat(numstat);
            const summary = summarizeFiles(files);
            if (markReviewed) {
                await git(state.gitRoot, ["update-ref", state.baselineRef, current]);
                state.baselineRefAvailable = true;
            }
            const fallbackNote = usedWorkspaceOpenFallback
                ? ` The last-shown checkpoint was missing, so changes were compared from workspace open${markReviewed ? " and the baseline was re-established" : ""}.`
                : "";
            return {
                result: `${summary.files === 0
                    ? `No changes since ${effectiveSince === "workspace_open" ? "workspace open" : "last shown changes"}.`
                    : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`}${fallbackNote}`,
                summary,
                files,
                patch,
            };
        },
    };
}
function assertWorkspaceRoot(state, workspaceId, root) {
    if (state && state.root !== root) {
        throw new Error(`Review checkpoint workspace root mismatch for ${workspaceId}.`);
    }
}
async function initializeWorkspaceState(states, workspaceId, root) {
    const refs = reviewRefs(workspaceId);
    const state = {
        root,
        ...refs,
        openRefAvailable: false,
        baselineRefAvailable: false,
    };
    try {
        const eligibility = await getGitEligibility(root);
        if (!eligibility.ok || !eligibility.gitRoot) {
            state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
            return;
        }
        const [openCommit, baselineCommit] = await Promise.all([
            commitForRef(eligibility.gitRoot, state.openRef),
            commitForRef(eligibility.gitRoot, state.baselineRef),
        ]);
        if (!openCommit && !baselineCommit) {
            const initialCommit = await createWorkingTreeSnapshot(eligibility.gitRoot);
            await git(eligibility.gitRoot, ["update-ref", state.openRef, initialCommit]);
            await git(eligibility.gitRoot, ["update-ref", state.baselineRef, initialCommit]);
            state.openRefAvailable = true;
            state.baselineRefAvailable = true;
        }
        else {
            state.openRefAvailable = openCommit !== undefined;
            state.baselineRefAvailable = baselineCommit !== undefined;
        }
        state.gitRoot = eligibility.gitRoot;
    }
    catch (error) {
        state.diagnostic = error instanceof Error ? error.message : String(error);
    }
    finally {
        states.set(workspaceId, state);
    }
}
function isReadyState(state) {
    return state?.gitRoot !== undefined;
}
async function commitForRef(gitRoot, ref) {
    try {
        return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
    }
    catch {
        return undefined;
    }
}
function reviewRefs(workspaceId) {
    const segment = safeWorkspaceRefSegment(workspaceId);
    return {
        openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
        baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
    };
}
async function createWorkingTreeSnapshot(gitRoot) {
    const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
    const indexPath = join(tempDir, "index");
    const env = checkpointEnv(indexPath);
    try {
        await git(gitRoot, ["read-tree", "HEAD"], { env });
        await git(gitRoot, ["add", "-A", "--", "."], { env });
        const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
        const parent = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
        return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
    }
    finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}
function checkpointEnv(indexPath) {
    return {
        GIT_INDEX_FILE: indexPath,
        GIT_AUTHOR_NAME: "DevSpace",
        GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
        GIT_COMMITTER_NAME: "DevSpace",
        GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
    };
}
function parseNumstat(output) {
    const fields = output.split("\0").filter((field) => field.length > 0);
    const files = [];
    for (let index = 0; index < fields.length;) {
        const header = fields[index++] ?? "";
        const parts = header.split("\t");
        const additions = parseStatNumber(parts[0]);
        const removals = parseStatNumber(parts[1]);
        if (parts.length >= 3) {
            const path = parts[2] ?? "";
            if (path)
                files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
            continue;
        }
        const previousPath = fields[index++];
        const path = fields[index++];
        if (!path)
            continue;
        files.push({
            path,
            previousPath,
            type: fileType(path, previousPath, additions, removals),
            additions,
            removals,
        });
    }
    return files;
}
function parseStatNumber(value) {
    if (!value || value === "-")
        return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function fileType(path, previousPath, additions, removals) {
    if (previousPath)
        return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
    if (additions > 0 && removals === 0)
        return "new";
    if (additions === 0 && removals > 0)
        return "deleted";
    return "change";
}
function summarizeFiles(files) {
    return files.reduce((summary, file) => ({
        files: summary.files + 1,
        additions: summary.additions + file.additions,
        removals: summary.removals + file.removals,
    }), { files: 0, additions: 0, removals: 0 });
}
