import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerRuntime } from "../dist/local-agent-codex.js";
import { AgentSandboxUnavailableError } from "../dist/local-agent-errors.js";
import { resolveSubagentsConfig } from "../dist/local-agent-config.js";

if (process.platform !== "linux") {
  console.log("sandbox fallback behavior: SKIP (Linux only)");
  process.exit(0);
}

function fakeRuntime(options, calls) {
  const runtime = Object.create(CodexAppServerRuntime.prototype);
  runtime.provider = "codex";
  runtime.alive = true;
  runtime.child = { killed: false, exitCode: null };
  runtime.options = options;
  runtime.rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: "thread-1" } };
    },
    runTurn: async (threadId, params) => {
      calls.push({ method: "turn/start", threadId, params });
      return {
        event: { params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "ok" }] } } },
        items: [],
      };
    },
  };
  return runtime;
}

assert.equal(resolveSubagentsConfig(undefined, {}).sandboxFallback, "fail");
assert.equal(resolveSubagentsConfig({ enabled: true, providers: [], sandboxFallback: false }, {}).sandboxFallback, "fail");

const root = realpathSync(mkdtempSync(join(tmpdir(), "devspace-sandbox-")));
const input = { workspaceRoot: root, writeMode: "allowed", prompt: "hello" };

const blockedCalls = [];
await assert.rejects(
  () => fakeRuntime({ sandboxFallback: "fail", worktreeRoot: root, sandboxProbe: () => false }, blockedCalls).run(input),
  (error) => error instanceof AgentSandboxUnavailableError
    && error.code === "SANDBOX_UNAVAILABLE"
    && error.stage === "probe"
    && error.fallback_available === false,
);
assert.equal(blockedCalls.length, 0, "sandbox failure must happen before a provider turn");

const fallbackCalls = [];
const fallbackWarnings = [];
const fallback = await fakeRuntime({ sandboxFallback: "worktree-embedded", worktreeRoot: root, sandboxProbe: () => false, onSandboxFallback: (event) => fallbackWarnings.push(event) }, fallbackCalls).run(input);
assert.equal(fallback.isOk(), true);
assert.equal(fallback.value.metadata.sandbox, "worktree-embedded");
assert.match(fallback.value.metadata.warnings[0], /without an OS sandbox/);
assert.equal(fallbackWarnings.length, 1);
assert.equal(fallbackWarnings[0].sandbox, "worktree-embedded");
assert.equal(fallbackCalls[0].params.sandbox, "danger-full-access");
assert.deepEqual(fallbackCalls[1].params.sandboxPolicy, { type: "dangerFullAccess" });
assert.equal(fallbackCalls[0].params.cwd, root);

const normalCalls = [];
const normal = await fakeRuntime({ sandboxFallback: "worktree-embedded", worktreeRoot: root, sandboxProbe: () => true }, normalCalls).run(input);
assert.equal(normal.isOk(), true);
assert.equal(normal.value.metadata, undefined);
assert.equal(normalCalls[0].params.sandbox, "workspace-write");
assert.deepEqual(normalCalls[1].params.sandboxPolicy, { type: "workspaceWrite" });

const outside = realpathSync(mkdtempSync(join(tmpdir(), "devspace-outside-")));
const link = join(root, "escape");
symlinkSync(outside, link);
const confinedCalls = [];
await assert.rejects(
  () => fakeRuntime({ sandboxFallback: "worktree-embedded", worktreeRoot: root, sandboxProbe: () => false }, confinedCalls).run({ ...input, workspaceRoot: link }),
  (error) => error instanceof AgentSandboxUnavailableError
    && error.code === "SANDBOX_UNAVAILABLE"
    && error.stage === "worktree-confinement",
);
assert.equal(confinedCalls.length, 0, "confinement failure must happen before a provider turn");

console.log("sandbox fallback behavior: PASS");
