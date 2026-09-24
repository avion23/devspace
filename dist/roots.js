import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
export class AccessDeniedError extends Error {
    constructor(message) {
        super(message);
        this.name = "AccessDeniedError";
    }
}
export function expandHomePath(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/") || path.startsWith("~\\")) {
        return resolve(homedir(), path.slice(2));
    }
    return path;
}
export function isPathInsideRoot(path, root) {
    const resolvedPath = resolve(expandHomePath(path));
    const resolvedRoot = resolve(expandHomePath(root));
    const relationship = relative(resolvedRoot, resolvedPath);
    return (relationship === "" ||
        (!isAbsolute(relationship) &&
            !relationship.startsWith("..") &&
            relationship !== ".." &&
            !relationship.includes(`..${sep}`)));
}
export function assertAllowedPath(path, allowedRoots) {
    const resolvedPath = resolve(expandHomePath(path));
    if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
        return resolvedPath;
    }
    throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}
function realpathOfClosestExistingAncestor(absolutePath) {
    let current = absolutePath;
    let missingSuffix = [];
    for (;;) {
        try {
            return { realParent: realpathSync(current), missingSuffix };
        }
        catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
                throw error;
            const parent = dirname(current);
            if (parent === current)
                throw error;
            missingSuffix.unshift(basename(current));
            current = parent;
        }
    }
}
function tryRealpath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
export function resolveAllowedPath(inputPath, cwd, allowedRoots, { followFinal = false } = {}) {
    const candidate = assertAllowedPath(resolve(cwd, expandHomePath(inputPath)), allowedRoots);
    // Lexical containment is not enough: an intermediate symlinked directory
    // (root/evil -> /etc) makes root/evil/passwd lexically inside the root while
    // actually resolving outside it. Canonicalize through the closest existing
    // ancestor and re-assert containment against both the lexical and the real
    // roots. The FINAL component is realpathed only for callers that follow
    // it; delete/move keep their historical leaf-symlink semantics and lstat it.
    const { realParent, missingSuffix } = realpathOfClosestExistingAncestor(dirname(candidate));
    let canonical = resolve(realParent, ...missingSuffix, basename(candidate));
    if (followFinal) {
        let finalStats;
        try {
            finalStats = lstatSync(canonical);
        }
        catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
                throw error;
        }
        if (finalStats?.isSymbolicLink()) {
            try {
                canonical = realpathSync(canonical);
            }
            catch (error) {
                if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                    throw new AccessDeniedError(`Path has a dangling final symlink: ${inputPath}`);
                }
                throw error;
            }
        }
    }
    const canonicalRoots = allowedRoots.flatMap((root) => {
        const real = tryRealpath(resolve(expandHomePath(root)));
        return real ? [root, real] : [root];
    });
    try {
        return assertAllowedPath(canonical, canonicalRoots);
    }
    catch {
        throw new AccessDeniedError(`Path resolves outside allowed roots: ${inputPath}`);
    }
}
