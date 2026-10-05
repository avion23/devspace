import { constants, createReadStream, linkSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { access } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, } from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
// The dependency's signature-based image detector is not publicly exported.
const { detectSupportedImageMimeTypeFromFile } = await import(new URL("./utils/mime.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
// Single source for bash timeout bounds (seconds): the MCP schema in server.js
// imports these consts, so schema and executor cannot drift (rev 6 split-brain:
// schema max 900 vs executor clamp 300). Out-of-range explicit values are
// rejected by the schema.
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
    let prefix = "";
    let bytes = 0;
    let stopped = false;
    let failure;
    function append(text) {
        prefix += text;
        bytes += Buffer.byteLength(text, "utf8");
    }
    try {
        reading: for await (const chunk of stream) {
            let start = 0;
            do {
                const end = chunk.indexOf("\n", start);
                const text = chunk.slice(start, end === -1 ? chunk.length : end);
                if (line >= offset) {
                    // A terminal empty line doesn't count toward truncateHead's
                    // line cap. Inspect only a bounded fragment beyond it.
                    if (line - offset >= DEFAULT_MAX_LINES && (text.length > 0 || end !== -1)) {
                        append(text.length > 0 ? text.slice(0, 2) : "\n");
                        stopped = true;
                        break reading;
                    }
                    append(text);
                    if (bytes > DEFAULT_MAX_BYTES) {
                        stopped = true;
                        break reading;
                    }
                    if (end !== -1) {
                        if (limit !== undefined && line - offset + 1 >= limit) {
                            stopped = true;
                            break reading;
                        }
                        append("\n");
                        if (bytes > DEFAULT_MAX_BYTES) {
                            stopped = true;
                            break reading;
                        }
                    }
                }
                if (end === -1)
                    break;
                line++;
                start = end + 1;
            } while (start <= chunk.length);
        }
    }
    catch (error) {
        failure = error;
        throw error;
    }
    finally {
        stream.destroy();
        // Only suppress the iterator's expected early-exit AbortError, never
        // a real I/O error racing with the bounded stop or stream closure.
        await finished(stream, { cleanup: true }).catch((error) => {
            if (!failure && !(stopped && error.code === "ABORT_ERR"))
                throw error;
        });
    }
    if (offset > line) {
        throw new Error(`Offset ${offset} is beyond end of file (${line} lines total)`);
    }
    const truncation = truncateHead(prefix);
    if (stopped) {
        // These would describe only our inspected prefix, not the full file.
        delete truncation.totalLines;
        delete truncation.totalBytes;
    }
    let text = truncation.content;
    let details;
    if (truncation.firstLineExceedsLimit) {
        text = `[Line ${offset} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${offset}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
    }
    else if (stopped || truncation.truncated) {
        const outputLines = truncation.truncated ? truncation.outputLines : line - offset + 1;
        const endLine = offset + outputLines - 1;
        const sizeNote = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
        text += `\n\n[Showing lines ${offset}-${endLine}${sizeNote}. Use offset=${endLine + 1} to continue.]`;
        if (truncation.truncated)
            details = { truncation };
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
        // Create the destination's parent directory tree (already confined to
        // the validated workspace path by resolveAllowedPath above), mirroring
        // the write tool's recursive mkdir so a move into a new module
        // directory does not fail with a misleading ENOENT naming the source.
        mkdirSync(dirname(to), { recursive: true });
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
                let destExists = true;
                try {
                    lstatSync(to);
                }
                catch {
                    destExists = false;
                }
                if (destExists) {
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
