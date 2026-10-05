import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileTool, writeFileTool } from "../dist/pi-tools.js";
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
mkdirSync(base, { recursive: true });
rmSync("/tmp/rev10-test/out", { recursive: true, force: true }); mkdirSync("/tmp/rev10-test/out");
writeFileSync(base + "/f1.txt", "hello\n");
writeFileSync("/tmp/rev10-test/out/victim", "outside\n");
symlinkSync("/tmp/rev10-test/out", base + "/evil");
symlinkSync(base + "/f1.txt", base + "/link.txt");
const ctx = { cwd: base, root: base };
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name, detail); } };

// 1. intermediate symlink escape must refuse (read/write)
let denied = 0;
try { resolveAllowedPath("evil/victim", base, [base]); } catch (e) { denied = e.name === "AccessDeniedError" ? 1 : 0; }
check("resolveAllowedPath: intermediate symlink refused (modules stay in checkout)", denied === 1 && modulePathsInsideCheckout, resolvedModules.join(", "));
let readDenied = false, writeDenied = false;
try { await readFileTool({ path: "evil/victim" }, ctx); } catch (e) { readDenied = e.name === "AccessDeniedError"; }
check("read: intermediate symlink refused", readDenied);
try { await writeFileTool({ path: "evil/new", content: "x" }, ctx); } catch (e) { writeDenied = e.name === "AccessDeniedError"; }
check("write: intermediate symlink refused", writeDenied && !existsSync("/tmp/rev10-test/out/new"));

// 2. final-symlink semantics preserved
const r5 = await readFileTool({ path: "link.txt" }, ctx);
check("read: final symlink still follows", !r5.isError && r5.content[0].text.includes("hello"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
