import { constants, createReadStream, statSync } from "node:fs";
import { access, open } from "node:fs/promises";
import { finished } from "node:stream/promises";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type TruncationResult,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";

// `@earendil-works/pi-coding-agent` does not publicly export its image
// signature sniff (only "." and "./rpc-entry" are in its `exports` map), so
// it is reimplemented here against the formats the upstream binary read
// path (`createReadTool`, used below) supports: JPEG, PNG (rejecting
// APNG), GIF, WEBP, and BMP. Detection reads only the leading bytes needed
// for each signature, matching the upstream sniff window.
const IMAGE_TYPE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function detectSupportedImageMimeType(buffer: Buffer): string | null {
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWithBytes(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF")) {
    return "image/gif";
  }
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
    return "image/bmp";
  }
  return null;
}

async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  const fileHandle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
    return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
  } finally {
    await fileHandle.close();
  }
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Buffer): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function isBmp(buffer: Buffer): boolean {
  if (buffer.length < 26) return false;
  const declaredFileSize = readUint32LE(buffer, 2);
  const pixelDataOffset = readUint32LE(buffer, 10);
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Buffer, offset: number): number {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function readUint32LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) +
    ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16) +
    (buffer[offset + 3] ?? 0) * 0x1000000
  );
}

function startsWithBytes(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;

// Single source for bash timeout bounds (seconds): the MCP schema in server.js
// imports these consts, so schema and executor cannot drift (rev 6 split-brain:
// schema max 900 vs executor clamp 300). Out-of-range explicit values are
// rejected by the schema.
export const BASH_TOOL_DEFAULT_TIMEOUT_SECONDS = 300;
export const BASH_TOOL_MAX_TIMEOUT_SECONDS = 900;

function formatReadLimitError(path: string, sizeBytes: number): string {
  const groupedBytes = String(sizeBytes).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return `${path} (${groupedBytes} bytes, ${sizeMb} MB) exceeds the 5 MB read limit for LLM ingestion. Use the bash tool instead: \`tail -n N ${path}\`, \`head -c N ${path}\`, or \`rg --max-count PATTERN ${path}\` to pull the relevant slice.`;
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
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

function formatToolError(error: unknown): { type: "text"; text: string }[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

// `totalLines`/`totalBytes` describe the full file; when the read stopped
// early (line/byte/offset bound hit before EOF) they are deleted below
// because they would otherwise describe only the inspected prefix.
type HeadTruncation = Omit<TruncationResult, "totalLines" | "totalBytes"> &
  Partial<Pick<TruncationResult, "totalLines" | "totalBytes">>;

async function readTextFile(
  path: string,
  offset = 1,
  limit?: number,
): Promise<AgentToolResult<{ truncation: HeadTruncation } | undefined>> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let line = 1;
  let prefix = "";
  let bytes = 0;
  let stopped = false;
  let failure: unknown;

  function append(text: string): void {
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
        if (end === -1) break;
        line++;
        start = end + 1;
      } while (start <= chunk.length);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    stream.destroy();
    // Only suppress the iterator's expected early-exit AbortError, never
    // a real I/O error racing with the bounded stop or stream closure.
    await finished(stream, { cleanup: true }).catch((error) => {
      if (!failure && !(stopped && error.code === "ABORT_ERR")) throw error;
    });
  }

  if (offset > line) {
    throw new Error(`Offset ${offset} is beyond end of file (${line} lines total)`);
  }

  const truncation: HeadTruncation = truncateHead(prefix);
  if (stopped) {
    // These would describe only our inspected prefix, not the full file.
    delete truncation.totalLines;
    delete truncation.totalBytes;
  }

  let text = truncation.content;
  let details: { truncation: HeadTruncation } | undefined;
  if (truncation.firstLineExceedsLimit) {
    text = `[Line ${offset} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${offset}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (stopped || truncation.truncated) {
    const outputLines = truncation.truncated ? truncation.outputLines : line - offset + 1;
    const endLine = offset + outputLines - 1;
    const sizeNote = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
    text += `\n\n[Showing lines ${offset}-${endLine}${sizeNote}. Use offset=${endLine + 1} to continue.]`;
    if (truncation.truncated) details = { truncation };
  }

  return { content: [{ type: "text", text }], details };
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root], { followFinal: true });
  for (const name of ["offset", "limit"] as const) {
    if (input[name] !== undefined && (!Number.isSafeInteger(input[name]) || input[name] <= 0)) {
      return { content: [{ type: "text", text: `${name} must be a positive safe integer` }], isError: true };
    }
  }

  // Missing files return the upstream isError shape; reject non-regular
  // files before reading. Existing path-check/open TOCTOU remains unchanged.
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
  if (!stats.isFile()) {
    return {
      content: [{ type: "text", text: `${path} is not a regular file (directories, FIFOs, sockets, and size-0 special files cannot be read with this tool).` }],
      isError: true,
    };
  }

  return runTool(
    async (params) => {
      await access(path, constants.R_OK);
      if (!await detectSupportedImageMimeTypeFromFile(path)) {
        return readTextFile(path, params.offset, params.limit);
      }
      // Images still use the upstream binary reader and its existing size cap.
      if (stats.size > MAX_READ_FILE_BYTES) {
        throw new Error(formatReadLimitError(path, stats.size));
      }
      return createReadTool(context.cwd).execute("read_file", params);
    },
    { path, offset: input.offset, limit: input.limit },
    context,
  );
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = input.path === undefined
    ? undefined
    : resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
  const tool = createGrepTool(context.cwd);

  return runTool(
    (params) => tool.execute("grep_files", params),
    path === undefined ? input : { ...input, path },
    context,
  );
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = input.path === undefined
    ? undefined
    : resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
  const tool = createFindTool(context.cwd);

  return runTool(
    (params) => tool.execute("find_files", params),
    path === undefined ? input : { ...input, path },
    context,
  );
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = input.path === undefined
    ? undefined
    : resolveAllowedPath(input.path, context.cwd, [context.root], { followFinal: true });
  const tool = createLsTool(context.cwd);

  return runTool(
    (params) => tool.execute("list_directory", params),
    path === undefined ? input : { ...input, path },
    context,
  );
}
