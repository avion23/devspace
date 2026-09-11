import { lstatSync, renameSync, statSync, unlinkSync } from "node:fs";
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
    const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
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
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createWriteTool(context.cwd);
    return runTool((params) => tool.execute("write_file", params), {
        path,
        content: input.content,
    }, context);
}
export async function editFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
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
    const deleted = [];
    try {
        for (const path of resolved) {
            const st = lstatSync(path);
            if (st.isDirectory()) {
                return fileMutationError(`${path} is a directory; delete only removes files and symlinks. Use the bash tool with rm -r for directories. (stopped after deleting ${deleted.length} of ${resolved.length})`);
            }
            unlinkSync(path);
            deleted.push(`${path} (${st.size} bytes)`);
        }
    }
    catch (error) {
        const remaining = resolved.length - deleted.length;
        return fileMutationError(`${formatToolError(error)[0].text} (stopped after deleting ${deleted.length} of ${resolved.length}; ${remaining} untouched)`);
    }
    return { content: [{ type: "text", text: `Deleted ${deleted.length} file${deleted.length === 1 ? "" : "s"}: ${deleted.join(", ")}` }] };
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
        renameSync(from, to);
        return { content: [{ type: "text", text: `Moved ${from} (${st.size} bytes) to ${to}` }] };
    }
    catch (error) {
        return fileMutationError(formatToolError(error)[0].text);
    }
}
export async function grepFilesTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createGrepTool(context.cwd);
    return runTool((params) => tool.execute("grep_files", params), input, context);
}
export async function findFilesTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createFindTool(context.cwd);
    return runTool((params) => tool.execute("find_files", params), input, context);
}
export async function listDirectoryTool(input, context) {
    if (input.path)
        resolveAllowedPath(input.path, context.cwd, [context.root]);
    const tool = createLsTool(context.cwd);
    return runTool((params) => tool.execute("list_directory", params), input, context);
}
export async function runShellTool(input, context) {
    const tool = createBashTool(context.cwd);
    const timeout = input.timeout === undefined ? BASH_TOOL_DEFAULT_TIMEOUT_SECONDS : Math.min(input.timeout, BASH_TOOL_MAX_TIMEOUT_SECONDS);
    return runTool((params) => tool.execute("run_shell", params), {
        command: input.command,
        timeout,
    }, context);
}
