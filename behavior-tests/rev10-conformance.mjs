import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deletePathsTool, movePathTool, readFileTool, writeFileTool } from "../dist/pi-tools.js";
import { resolveAllowedPath } from "../dist/roots.js";

const checkout = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resolvedModules = [
  fileURLToPath(import.meta.resolve("../dist/pi-tools.js")),
  fileURLToPath(import.meta.resolve("../dist/roots.js")),
];
const modulePathsInsideCheckout = resolvedModules.every((path) => {
  const relationship = relative(checkout, resolve(path));
  return relationship === "" || (!relationship.startsWith("..") && !relationship.includes(".."));
});

const base = "/tmp/rev10-test/wk";
process.on("exit", () => rmSync("/tmp/rev10-test", { recursive: true, force: true }));
rmSync(base, { recursive: true, force: true });
mkdirSync(base + "/sub", { recursive: true });
rmSync("/tmp/rev10-test/out", { recursive: true, force: true }); mkdirSync("/tmp/rev10-test/out");
writeFileSync(base + "/f1.txt", "hello\n");
writeFileSync(base + "/f2.txt", "world\n");
writeFileSync("/tmp/rev10-test/out/victim", "outside\n");
symlinkSync("/tmp/rev10-test/out", base + "/evil");
symlinkSync(base + "/f1.txt", base + "/link.txt");
const ctx = { cwd: base, root: base };
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name, detail); } };

// 1. intermediate symlink escape must refuse (all destructive + read/write)
let denied = 0;
try { resolveAllowedPath("evil/victim", base, [base]); } catch (e) { denied = e.name === "AccessDeniedError" ? 1 : 0; }
check("delete: intermediate symlink refused (resolveAllowedPath; modules stay in checkout)", denied === 1 && modulePathsInsideCheckout, resolvedModules.join(", "));
const r1 = await deletePathsTool({ paths: ["evil/victim"] }, ctx);
check("delete: escape refused", r1.isError === true && !existsSync("/tmp/rev10-test/out/.was-deleted") && existsSync("/tmp/rev10-test/out/victim"), JSON.stringify(r1.content));
const r2 = await movePathTool({ from: "f1.txt", to: "evil/escaped" }, ctx);
check("move: escape refused", r2.isError === true && !existsSync("/tmp/rev10-test/out/escaped"));
let readDenied = false, writeDenied = false;
try { await readFileTool({ path: "evil/victim" }, ctx); } catch (e) { readDenied = e.name === "AccessDeniedError"; }
check("read: intermediate symlink refused", readDenied);
try { await writeFileTool({ path: "evil/new", content: "x" }, ctx); } catch (e) { writeDenied = e.name === "AccessDeniedError"; }
check("write: intermediate symlink refused", writeDenied && !existsSync("/tmp/rev10-test/out/new"));

// 2. final-symlink semantics preserved
const r5 = await readFileTool({ path: "link.txt" }, ctx);
check("read: final symlink still follows", !r5.isError && r5.content[0].text.includes("hello"));
const r6 = await deletePathsTool({ paths: ["link.txt"] }, ctx);
check("delete: symlink leaf removed, target untouched", !r6.isError && existsSync(base + "/f1.txt"));

// 3. delete preflight: nothing deleted when a later entry is invalid
const r7 = await deletePathsTool({ paths: ["f2.txt", "sub"] }, ctx);
check("delete: dir refusal preflight", r7.isError === true && existsSync(base + "/f2.txt") && r7.content[0].text.includes("nothing deleted yet"));

// 4. delete duplicates reported, single unlink
writeFileSync(base + "/dup.txt", "d\n");
const r8 = await deletePathsTool({ paths: ["dup.txt", "dup.txt"] }, ctx);
check("delete: duplicate ignored", !r8.isError && r8.content[0].text.includes("1 duplicate path ignored") && !existsSync(base + "/dup.txt"));

// 5. delete nonexistent: clean error naming the path
const r9 = await deletePathsTool({ paths: ["ghost.txt"] }, ctx);
check("delete: nonexistent clean error", r9.isError && r9.content[0].text.includes("ghost.txt"));

// 6. move: fresh, overwrite refusal (incl. dangling symlink), dir, escape
const m1 = await movePathTool({ from: "f2.txt", to: "g2.txt" }, ctx);
check("move: fresh works", !m1.isError && existsSync(base + "/g2.txt"));
symlinkSync("/nonexistent", base + "/dangling");
const m2 = await movePathTool({ from: "g2.txt", to: "dangling" }, ctx);
check("move: dangling dest refused", m2.isError && existsSync(base + "/g2.txt"));
const m3 = await movePathTool({ from: "sub", to: "sub2" }, ctx);
check("move: dir refused", m3.isError);
const m4 = await movePathTool({ from: "g2.txt", to: "evil/escaped2" }, ctx);
check("move: escape refused", m4.isError && !existsSync("/tmp/rev10-test/out/escaped2"));

// 7. symlink move stays a symlink (Linux link(2))
symlinkSync("g2.txt", base + "/sym.txt");
const m5 = await movePathTool({ from: "sym.txt", to: "sym2.txt" }, ctx);
check("move: symlink moved as symlink", !m5.isError && !existsSync(base + "/sym.txt") && existsSync(base + "/sym2.txt") && readFileSync(base + "/sym2.txt", "utf8") === "world\n");

// 8. repo_status git safety: fsmonitor must not run
const repo = "/tmp/rev10-test/repo";
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
writeFileSync(repo + "/tracked.txt", "t\n");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
writeFileSync(repo + "/fsmonitor.sh", "#!/bin/sh\ntouch /tmp/rev10-test/FSMONITOR_RAN\n");
execFileSync("git", ["-C", repo, "config", "core.fsmonitor", "/tmp/rev10-test/fsmonitor.sh"]);
execFileSync("git", ["--no-optional-locks", "-C", repo, "-c", "core.fsmonitor=false", "-c", "core.fsmonitorDaemon=false", "status", "--porcelain", "-b", "--ignore-submodules=all"]);
check("repo_status: fsmonitor disabled (no script exec)", !existsSync("/tmp/rev10-test/FSMONITOR_RAN"));

// 9. unborn repo: no crash, branch from status line
const unborn = "/tmp/rev10-test/unborn";
rmSync(unborn, { recursive: true, force: true });
mkdirSync(unborn);
execFileSync("git", ["init", "-q", "-b", "main", unborn]);
const line = execFileSync("git", ["--no-optional-locks", "-C", unborn, "-c", "core.fsmonitor=false", "status", "--porcelain", "-b"]).toString().split("\n")[0];
check("repo_status: unborn branch line parseable", /No commits yet on main/.test(line), line);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
