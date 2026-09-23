import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
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
  deletePathsTool,
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  movePathTool,
  readFileTool,
  writeFileTool,
} from "../dist/pi-tools.js";
import { McpSessionRegistry } from "../dist/mcp-sessions.js";

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

symlinkSync(outsideFile, join(root, "delete-link"));
const deleted = await deletePathsTool({ paths: ["delete-link"] }, context);
assert.equal(deleted.isError, undefined);
assert.equal(existsSync(join(root, "delete-link")), false);
assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");

symlinkSync(outsideFile, join(root, "move-link"));
const moved = await movePathTool({ from: "move-link", to: "moved-link" }, context);
assert.equal(moved.isError, undefined);
assert.equal(lstatSync(join(root, "moved-link")).isSymbolicLink(), true);
assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");

const transport = () => ({ close: async () => undefined });
const concurrent = new McpSessionRegistry({ now: () => 0 });
let releaseGate;
const gate = new Promise((resolve) => { releaseGate = resolve; });
async function admit(sessionId) {
  const reservation = concurrent.reserve(1);
  if (!reservation)
    return false;
  await gate;
  return concurrent.register(sessionId, transport(), reservation);
}
const first = admit("first");
const second = admit("second");
assert.equal(await second, false);
releaseGate();
assert.equal(await first, true);
assert.equal(concurrent.size, 1);

const failed = new McpSessionRegistry();
const failedReservation = failed.reserve(1);
assert.ok(failedReservation);
assert.equal(failed.release(failedReservation), true);
const closingReservation = failed.reserve(1);
assert.ok(closingReservation, "a failed admission must release its reservation");
await failed.closeAll();
assert.equal(failed.register("after-close", transport(), closingReservation), false);
assert.ok(failed.reserve(1), "closeAll must clear in-flight reservations");

const activeVictim = new McpSessionRegistry({ now: () => 0 });
const victimReservation = activeVictim.reserve(1);
assert.equal(activeVictim.register("victim", transport(), victimReservation), true);
const victimEntry = activeVictim.sessions.get("victim");
const victimActivityVersion = victimEntry.activityVersion;
const replacement = activeVictim.reserve(1, "victim");
assert.ok(replacement);
activeVictim.get("victim");
assert.notEqual(victimEntry.activityVersion, victimActivityVersion);
assert.equal(activeVictim.register("new", transport(), replacement), false);
assert.equal(activeVictim.size, 1);
assert.ok(activeVictim.reserve(1, "victim"), "a rejected replacement must release its reservation");

console.log("review findings: PASS (final symlink confinement, leaf delete/move, session reservations)");
