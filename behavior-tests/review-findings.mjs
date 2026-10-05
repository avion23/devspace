import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "../dist/pi-tools.js";

const base = mkdtempSync(join(tmpdir(), "devspace-review-"));
const root = join(base, "root");
const outside = join(base, "outside");
mkdirSync(root, { recursive: true });
mkdirSync(outside);
const outsideFile = join(outside, "secret.txt");
const outsideDir = join(outside, "directory");
writeFileSync(outsideFile, "outside\n");
mkdirSync(outsideDir);
writeFileSync(join(outsideDir, "nested.txt"), "nested\n");
symlinkSync(outsideFile, join(root, "outside-file"));
symlinkSync(outsideDir, join(root, "outside-dir"));
const context = { cwd: root, root };

process.on("exit", () => rmSync(base, { recursive: true, force: true }));

async function assertDenied(name, operation) {
  await assert.rejects(operation, (error) => error?.name === "AccessDeniedError", name);
}

await assertDenied("read rejects an outside final symlink", () =>
  readFileTool({ path: "outside-file" }, context));
await assertDenied("write rejects an outside final symlink", () =>
  writeFileTool({ path: "outside-file", content: "changed\n" }, context));
await assertDenied("edit rejects an outside final symlink", () =>
  editFileTool({ path: "outside-file", edits: [{ oldText: "outside", newText: "changed" }] }, context));
await assertDenied("grep rejects an outside final symlink", () =>
  grepFilesTool({ pattern: "outside", path: "outside-file" }, context));
await assertDenied("find rejects an outside final symlink", () =>
  findFilesTool({ pattern: "*", path: "outside-dir" }, context));
await assertDenied("list rejects an outside final symlink", () =>
  listDirectoryTool({ path: "outside-dir" }, context));
assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");

symlinkSync(join(outside, "missing.txt"), join(root, "dangling"));
await assertDenied("write rejects a dangling final symlink", () =>
  writeFileTool({ path: "dangling", content: "must not escape\n" }, context));
await assertDenied("edit rejects a dangling final symlink", () =>
  editFileTool({ path: "dangling", edits: [{ oldText: "x", newText: "y" }] }, context));

writeFileSync(join(root, "inside.txt"), "inside\n");
symlinkSync(join(root, "inside.txt"), join(root, "inside-link"));
const insideRead = await readFileTool({ path: "inside-link" }, context);
assert.equal(insideRead.isError, undefined);
assert.equal(insideRead.content[0].text.includes("inside"), true);
const created = await writeFileTool({ path: "created.txt", content: "created\n" }, context);
assert.equal(created.isError, undefined);

console.log("review findings: PASS (final symlink confinement)");
