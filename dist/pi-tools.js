import { constants, createReadStream, linkSync, lstatSync, renameSync, statSync, unlinkSync } from "node:fs";
import { access } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, DEFAULT_MAX_BYTES, formatSize, truncateHead, } from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
// The dependency's signature-based image detector is not publicly exported.
const { detectSupportedImageMimeTypeFromFile } = await import(new URL("./utils/mime.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
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
async function readTextFile(path, offset = 1, limit) {
    const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
    let line = 1;
    let lineStarted = false;
    let selectedLines = 0;
    let selectedBytes = 0;
    let lastLineBytes = 0;
    let firstLineBytes = 0;
    let prefix = "";
    function append(text) {
        selectedBytes += Buffer.byteLength(text, "utf8");
        // Two extra code units cover byte overflow plus a newline at the
        // boundary; even a huge single line retains only this bounded prefix.
        if (prefix.length < DEFAULT_MAX_BYTES + 2) {
            prefix += text.slice(0, DEFAULT_MAX_BYTES + 2 - prefix.length);
        }
    }
    function consume(text) {
        if (line < offset || (limit !== undefined && line - offset >= limit))
            return;
        if (!lineStarted) {
            if (selectedLines > 0)
                append("\n");
            selectedLines++;
            lastLineBytes = 0;
            lineStarted = true;
        }
        const bytes = Buffer.byteLength(text, "utf8");
        lastLineBytes += bytes;
        if (selectedLines === 1)
            firstLineBytes += bytes;
        append(text);
    }
    try {
        // Scan to EOF for the upstream's exact total/remaining-line notices,
        // but retain only the requested selection's bounded output prefix.
        for await (const chunk of stream) {
            let start = 0;
            let end;
            while ((end = chunk.indexOf("\n", start)) !== -1) {
                consume(chunk.slice(start, end));
                line++;
                lineStarted = false;
                start = end + 1;
            }
            consume(chunk.slice(start));
        }
        consume(""); // Empty files and a final newline each have a final empty line.
    }
    finally {
        stream.destroy();
        await finished(stream, { cleanup: true }).catch(() => {});
    }
    if (offset > line) {
        throw new Error(`Offset ${offset} is beyond end of file (${line} lines total)`);
    }
    const truncation = truncateHead(prefix);
    truncation.totalLines = selectedLines - (lastLineBytes === 0 ? 1 : 0);
    truncation.totalBytes = selectedBytes;
    let text = truncation.content;
    let details;
    if (truncation.firstLineExceedsLimit) {
        text = `[Line ${offset} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${offset}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
    }
    else if (truncation.truncated) {
        const endLine = offset + truncation.outputLines - 1;
        const sizeNote = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
        text += `\n\n[Showing lines ${offset}-${endLine} of ${line}${sizeNote}. Use offset=${endLine + 1} to continue.]`;
        details = { truncation };
    }
    else if (limit !== undefined && offset + selectedLines - 1 < line) {
        text += `\n\n[${line - (offset + selectedLines - 1)} more lines in file. Use offset=${offset + selectedLines} to continue.]`;
    }
    return { content: [{ type: "text", text }], details };
}
export async function readFileTool(input, context) {
    const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root], { followFinal: true });
    for (const name of ["offset", "limit"]) {
        if (input[name] !== undefined && (!Number.isSafeInteger(input[name]) || input[name] <= 0)) {
            return { content: [{ type: "text", text: `${name} must be a positive safe integer` }], isError: true };
        }
    }
    // Missing files return the upstream isError shape; reject non-regular
    // files before reading. Existing path-check/open TOCTOU remains unchanged.
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
    return runTool(async (params) => {
        await access(path, constants.R_OK);
        if (!await detectSupportedImageMimeTypeFromFile(path)) {
            return readTextFile(path, params.offset, params.limit);
        }
        // Images still use the upstream binary reader and its existing size cap.
        if (stats.size > MAX_READ_FILE_BYTES) {
            throw new Error(formatReadLimitError(path, stats.size));
        }
        return createReadTool(context.cwd).execute("read_file", params);
    }, { path, offset: input.offset, limit: input.limit }, context);
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
