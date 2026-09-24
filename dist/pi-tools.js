import { linkSync, lstatSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, } from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
// Single source for bash timeout bounds (seconds): the MCP schema in server.js
// imports these consts, so schema and executor cannot drift (rev 6 split-brain:
// schema max 900 vs executor clamp 300). Out-of-range explicit values are
// rejected by the schema; the Math.min below is defense-in-depth only.
export const BASH_TOOL_DEFAULT_TIMEOUT_SECONDS = 300;
export const BASH_TOOL_MAX_TIMEOUT_SECONDS = 900;
function formatReadLimitError(path, sizeBytes) {
    const groupedBytes = String(sizeBytes).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
    return `${path} (${groupedBytes} bytes, ${sizeMb} MB) exceeds the 5 MB read limit for LLM ingestion. Use the bash tool instead: \`tail -n N ${path}\`, \`head -c N ${path}\`, or \`rg --max-count PATTERN ${path}\` to pull the relevant slice.`;
}
function toMcpContent(result) {
    return result.content.map((content) => {
        if (content.type === "text") {
            return { type: "text", text: content.text };
        }
        return {
            type: "image",
            data: content.data,
            mimeType: content.mimeType,
        };
    });
}
function formatToolError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ type: "text", text: message }];
}
async function runTool(execute, input, context) {
    try {
        const result = await execute(input);
        return {
            content: toMcpContent(result),
            details: result.details,
        };
    }
    catch (error) {
        return { content: formatToolError(error), isError: true };
    }
}
export async function readFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root], { followFinal: true });
    // Hotfix pending rev 8 (live-only 2026-09-05): stat inside try so missing
    // files return the upstream isError shape (via formatToolError) instead of
    // throwing MCP -32603; reject non-regular files before reading. Residual
    // TOCTOU (size-check-then-read race) intentionally stays — see PATCHES.md.
    let stats;
    try {
        stats = statSync(path);
    }
    catch (error) {
        return { content: formatToolError(error), isError: true };
    }
    if (!stats.isFile()) {
        return {
            content: [{ type: "text", text: `${path} is not a regular file (directories, FIFOs, sockets, and size-0 special files cannot be read with this tool).` }],
            isError: true,
        };
    }
    if (stats.size > MAX_READ_FILE_BYTES) {
        return {
            content: [{ type: "text", text: formatReadLimitError(path, stats.size) }],
            isError: true,
        };
    }
    const tool = createReadTool(context.cwd);
    return runTool((params) => tool.execute("read_file", params), {
        path,
        offset: input.offset,
        limit: input.limit,
    }, context);
}
export async function writeFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
    const tool = createWriteTool(context.cwd);
    return runTool((params) => tool.execute("write_file", params), {
        path,
        content: input.content,
    }, context);
}
export async function editFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
    const tool = createEditTool(context.cwd);
    return runTool((params) => tool.execute("edit_file", params), {
        path,
        edits: input.edits,
    }, context);
}
function fileMutationError(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}
export async function deletePathsTool(input, context) {
    let resolved;
    try {
        resolved = input.paths.map((path) => resolveAllowedPath(path, context.cwd, [context.root]));
    }
    catch (error) {
        return fileMutationError(formatToolError(error)[0].text);
    }
    // Deduplicate and preflight everything before mutating anything: the tool
    // validates all entries (exists, not a directory) before the first unlink.
    const unique = [...new Map(resolved.map((path) => [path, path])).keys()];
    const duplicates = resolved.length - unique.length;
    const stats = new Map();
    try {
        for (const path of unique) {
            const st = lstatSync(path);
            if (st.isDirectory()) {
                return fileMutationError(`${path} is a directory; delete only removes files and symlinks. Use the bash tool with rm -r for directories. (nothing deleted yet; ${unique.length} paths pending)`);
            }
            stats.set(path, st.size);
        }
    }
    catch (error) {
        return fileMutationError(`${formatToolError(error)[0].text} (nothing deleted yet; ${unique.length} paths pending)`);
    }
    const deleted = [];
    const failed = [];
    let lastError = null;
    for (const path of unique) {
        try {
            unlinkSync(path);
            deleted.push(`${path} (${stats.get(path)} bytes)`);
        }
        catch (error) {
            failed.push(path);
            lastError = error;
        }
    }
    if (failed.length > 0) {
        const suffix = deleted.length > 0 ? ` (deleted ${deleted.length}: ${deleted.join(", ")})` : "";
        return fileMutationError(`${formatToolError(lastError)[0].text} (failed: ${failed.join(", ")})${suffix}`);
    }
    const duplicateNote = duplicates > 0 ? ` (${duplicates} duplicate path${duplicates === 1 ? "" : "s"} ignored)` : "";
    return { content: [{ type: "text", text: `Deleted ${deleted.length} file${deleted.length === 1 ? "" : "s"}: ${deleted.join(", ")}${duplicateNote}` }] };
}
export async function movePathTool(input, context) {
    let from;
    let to;
    try {
        from = resolveAllowedPath(input.from, context.cwd, [context.root]);
        to = resolveAllowedPath(input.to, context.cwd, [context.root]);
    }
    catch (error) {
        return fileMutationError(formatToolError(error)[0].text);
    }
    try {
        const st = lstatSync(from);
        if (st.isDirectory()) {
            return fileMutationError(`${from} is a directory; move only renames files and symlinks. Use the bash tool with mv for directories.`);
        }
        let existing = null;
        try {
            existing = lstatSync(to);
        }
        catch { }
        if (existing) {
            return fileMutationError(`${to} already exists; move never overwrites. Delete the destination first if that is intended.`);
        }
        // Atomic no-replace: link(2) fails with EEXIST if `to` appears between
        // the check and the mutation, which rename(2) would silently replace.
        // On Linux link(2) does not dereference symlinks, so a moved symlink
        // stays a symlink. Crash between link and unlink leaves both names
        // pointing at the same inode (recoverable, no data loss). On EXDEV
        // (cross-device, possible only if a mount point sits inside the
        // workspace) fall back to checked rename.
        try {
            linkSync(from, to);
        }
        catch (error) {
            if (error.code === "EEXIST") {
                return fileMutationError(`${to} already exists; move never overwrites. Delete the destination first if that is intended.`);
            }
            if (error.code === "EXDEV") {
                if (lstatSync(to)) {
                    return fileMutationError(`${to} already exists; move never overwrites.`);
                }
                renameSync(from, to);
            }
            else {
                throw error;
            }
        }
        unlinkSync(from);
        return { content: [{ type: "text", text: `Moved ${from} (${st.size} bytes) to ${to}` }] };
    }
    catch (error) {
        return fileMutationError(formatToolError(error)[0].text);
    }
}
export async function grepFilesTool(input, context) {
    const path = input.path === undefined
        ? undefined
        : resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
    const tool = createGrepTool(context.cwd);
    return runTool((params) => tool.execute("grep_files", params), path === undefined ? input : { ...input, path }, context);
}
export async function findFilesTool(input, context) {
    const path = input.path === undefined
        ? undefined
        : resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
    const tool = createFindTool(context.cwd);
    return runTool((params) => tool.execute("find_files", params), path === undefined ? input : { ...input, path }, context);
}
export async function listDirectoryTool(input, context) {
    const path = input.path === undefined
        ? undefined
        : resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
    const tool = createLsTool(context.cwd);
    return runTool((params) => tool.execute("list_directory", params), path === undefined ? input : { ...input, path }, context);
}
export async function runShellTool(input, context) {
    const tool = createBashTool(context.cwd);
    const timeout = input.timeout === undefined ? BASH_TOOL_DEFAULT_TIMEOUT_SECONDS : Math.min(input.timeout, BASH_TOOL_MAX_TIMEOUT_SECONDS);
    return runTool((params) => tool.execute("run_shell", params), {
        command: input.command,
        timeout,
    }, context);
}
