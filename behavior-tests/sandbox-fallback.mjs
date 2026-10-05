import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import {
  CodexAppServerRuntime,
  getLinuxSandboxProbeState,
  probeLinuxUserNamespace,
  resetSandboxProbeCache,
} from "../dist/local-agent-codex.js";
import { AgentDaemonBusyError, AgentSandboxUnavailableError, agentErrorFromPayload, toAgentErrorPayload } from "../dist/local-agent-errors.js";
import { LocalAgentClient } from "../dist/local-agent-client.js";
import { LocalAgentDaemon } from "../dist/local-agent-daemon.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "../dist/local-agent-daemon-lifecycle.js";
import { decodeAgentRecord, decodeDaemonStatus, decodeLocalAgentDaemonRequest, decodeLocalAgentDaemonResponse, encodeLocalAgentDaemonResponse } from "../dist/local-agent-daemon-protocol.js";
import { LocalAgentManager } from "../dist/local-agent-manager.js";
import { formatAgentObservation, presentAgentObservation } from "../dist/local-agent-presentation.js";
import { LocalAgentStore } from "../dist/local-agent-store.js";
import { resolveSubagentsConfig } from "../dist/local-agent-config.js";

if (process.platform !== "linux") {
  console.log("sandbox fallback behavior: SKIP (Linux only)");
  process.exit(0);
}

const tempPaths = [];
function tempDir(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempPaths.push(path);
  return path;
}
process.on("exit", () => {
  for (const path of tempPaths)
    rmSync(path, { recursive: true, force: true });
});

function fakeRuntime(options, calls, runTurn = async () => ({
  event: { params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "ok" }] } } },
  items: [],
})) {
  const runtime = Object.create(CodexAppServerRuntime.prototype);
  runtime.provider = "codex";
  runtime.alive = true;
  runtime.child = { killed: false, exitCode: null };
  runtime.options = options;
  runtime.rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: `thread-${calls.length}` } };
    },
    runTurn: async (threadId, params) => {
      calls.push({ method: "turn/start", threadId, params });
      return runTurn(threadId, params);
    },
  };
  return runtime;
}

function denied(code = 1) {
  return { outcome: "denied", code };
}

function assertSandboxError(result, expected = {}) {
  assert.equal(result.isErr(), true);
  assert.equal(result.error instanceof AgentSandboxUnavailableError, true);
  assert.equal(result.error.code, "SANDBOX_UNAVAILABLE");
  for (const [key, value] of Object.entries(expected))
    assert.equal(result.error[key], value, key);
  return result.error;
}

async function probeCases() {
  resetSandboxProbeCache();
  let calls = 0;
  const ok = await probeLinuxUserNamespace((command, args, options, callback) => {
    calls += 1;
    assert.equal(command, "unshare");
    assert.deepEqual(args, ["-Ur", "true"]);
    assert.equal(options.timeout, 5000);
    callback(null, "", "");
  }, { ttlMs: 60_000 });
  assert.deepEqual(ok, { outcome: "ok" });
  assert.equal(calls, 1);

  resetSandboxProbeCache();
  const deniedResult = await probeLinuxUserNamespace((_, __, ___, callback) => callback({ code: 1 }, "", "unshare: unshare failed: Operation not permitted\n"), { ttlMs: 60_000 });
  assert.deepEqual(deniedResult, { outcome: "denied", code: 1, stderr: "unshare: unshare failed: Operation not permitted\n" });

  resetSandboxProbeCache();
  const wrongExit = await probeLinuxUserNamespace((_, __, ___, callback) => callback({ code: 17 }), { ttlMs: 60_000 });
  assert.deepEqual(wrongExit, { outcome: "indeterminate", reason: "exit 17" });

  resetSandboxProbeCache();
  const killed = await probeLinuxUserNamespace((_, __, ___, callback) => callback({ signal: "SIGKILL" }), { ttlMs: 60_000 });
  assert.deepEqual(killed, { outcome: "indeterminate", reason: "signal SIGKILL" });

  resetSandboxProbeCache();
  const notFound = await probeLinuxUserNamespace((_, __, ___, callback) => callback({ code: "ENOENT" }), { ttlMs: 60_000 });
  assert.deepEqual(notFound, { outcome: "indeterminate", reason: "not_found" });

  resetSandboxProbeCache();
  const timeout = await probeLinuxUserNamespace((_, __, ___, callback) => callback({ killed: true, signal: "SIGTERM" }), { ttlMs: 60_000 });
  assert.deepEqual(timeout, { outcome: "indeterminate", reason: "timeout" });

  resetSandboxProbeCache();
  let now = 0;
  let hostRepaired = false;
  calls = 0;
  const ttlExec = (_, __, ___, callback) => {
    calls += 1;
    callback(hostRepaired ? null : { code: 1 }, "", hostRepaired ? "" : "Operation not permitted");
  };
  const ttlProbe = await probeLinuxUserNamespace(ttlExec, { ttlMs: 60, now: () => now });
  assert.equal(ttlProbe.outcome, "denied");
  const measuredAt = getLinuxSandboxProbeState().at;
  now = 30;
  const cached = await probeLinuxUserNamespace(ttlExec, { ttlMs: 60, now: () => now });
  assert.equal(cached.outcome, "denied");
  assert.equal(getLinuxSandboxProbeState().at, measuredAt, "cache reuse must not look like a fresh measurement");
  assert.equal(calls, 1, "a stable implementation must reuse an unexpired result");
  hostRepaired = true;
  now = 61;
  const repaired = await probeLinuxUserNamespace(ttlExec, { ttlMs: 60, now: () => now });
  assert.equal(repaired.outcome, "ok");
  assert.equal(calls, 2, "expired denial must be re-probed after host repair");

  resetSandboxProbeCache();
  calls = 0;
  const dedupProbe = (_, __, ___, callback) => {
    calls += 1;
    setTimeout(() => callback({ code: 1 }, "", "Operation not permitted"), 5);
  };
  const deduped = await Promise.all(Array.from({ length: 5 }, () => probeLinuxUserNamespace(dedupProbe, { ttlMs: 60_000 })));
  assert.equal(calls, 1, "concurrent callers must share one probe");
  assert.deepEqual(deduped.map((result) => result.outcome), ["denied", "denied", "denied", "denied", "denied"]);
  assert.equal(getLinuxSandboxProbeState().outcome, "denied");
}

async function sandboxDecisionCases() {
  assert.equal(resolveSubagentsConfig(undefined, {}).sandboxFallback, "fail");
  assert.equal(resolveSubagentsConfig({ enabled: true, providers: [], sandboxFallback: false }, {}).sandboxFallback, "fail");
  const root = tempDir("devspace-sandbox-");
  const input = { workspaceRoot: root, writeMode: "allowed", prompt: "hello" };

  const blockedCalls = [];
  const blocked = await fakeRuntime({ sandboxFallback: "fail", worktreeRoot: root, sandboxProbe: () => denied() }, blockedCalls).run(input);
  const blockedError = assertSandboxError(blocked, { stage: "probe", retryable: false, fallback_available: true });
  assert.match(blockedError.detail, /unshare -Ur true/);
  assert.match(blockedError.detail, /set subagents\.sandboxFallback to "worktree-embedded"/);
  assert.match(blockedError.detail, /after host fixes run: devspace agents daemon stop/);
  assert.equal(blockedCalls.length, 0, "sandbox failure must happen before a provider turn");

  const stderrBlocked = await fakeRuntime({
    sandboxFallback: "fail",
    worktreeRoot: root,
    sandboxProbe: () => ({ outcome: "denied", code: 1, stderr: "unshare: Operation not permitted\n" }),
  }, []).run(input);
  assert.match(assertSandboxError(stderrBlocked).detail, /Operation not permitted/);

  const fallbackCalls = [];
  const fallbackWarnings = [];
  const fallback = await fakeRuntime({
    sandboxFallback: "worktree-embedded",
    worktreeRoot: root,
    sandboxProbe: () => denied(),
    onSandboxFallback: (event) => fallbackWarnings.push(event),
  }, fallbackCalls).run(input);
  assert.equal(fallback.isOk(), true);
  assert.equal(fallback.value.metadata.sandbox, "worktree-embedded");
  assert.match(fallback.value.metadata.warnings[0], /WITHOUT an OS sandbox/);
  assert.equal(fallbackWarnings.length, 1);
  assert.deepEqual(fallbackWarnings[0].metadata, fallback.value.metadata);
  assert.equal(fallbackCalls[0].params.sandbox, "danger-full-access");
  assert.deepEqual(fallbackCalls[1].params.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(fallbackCalls[0].params.cwd, root);

  const readOnlyCalls = [];
  const readOnly = await fakeRuntime({ sandboxFallback: "worktree-embedded", worktreeRoot: root, sandboxProbe: () => denied() }, readOnlyCalls).run({ ...input, writeMode: "read_only" });
  const readOnlyError = assertSandboxError(readOnly, { stage: "policy", retryable: false, fallback_available: false });
  assert.match(readOnlyError.detail, /read-only turns are not eligible/);
  assert.equal(readOnlyCalls.length, 0, "read-only fallback must not reach RPC");

  const indeterminateCalls = [];
  const indeterminate = await fakeRuntime({ sandboxFallback: "worktree-embedded", worktreeRoot: root, sandboxProbe: () => ({ outcome: "indeterminate", reason: "timeout" }) }, indeterminateCalls).run(input);
  const indeterminateError = assertSandboxError(indeterminate, { stage: "probe", retryable: true, fallback_available: false });
  assert.match(indeterminateError.detail, /timed out after 5000ms/);
  assert.equal(indeterminateCalls.length, 0, "indeterminate probe must never authorize fallback");

  const transitions = [];
  const sequence = [denied(), { outcome: "ok" }, { outcome: "ok" }];
  const transitionRuntime = fakeRuntime({ sandboxFallback: "worktree-embedded", worktreeRoot: root, sandboxProbe: () => sequence.shift() }, transitions);
  const first = await transitionRuntime.run({ ...input, providerSessionId: undefined });
  const second = await transitionRuntime.run({ ...input, providerSessionId: "thread-1" });
  const third = await transitionRuntime.run({ ...input, providerSessionId: "thread-1" });
  assert.equal(first.isOk(), true);
  assert.equal(second.isOk(), true);
  assert.equal(third.isOk(), true);
  assert.equal(transitions[0].params.sandbox, "danger-full-access");
  assert.deepEqual(transitions[1].params.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(first.value.metadata.sandbox, "worktree-embedded");
  assert.equal(transitions[2].params.sandbox, "workspace-write");
  assert.deepEqual(transitions[3].params.sandboxPolicy, { type: "workspaceWrite" });
  assert.equal(second.value.metadata, undefined);
  assert.equal(transitions[4].params.sandbox, "workspace-write");
  assert.equal(third.value.metadata, undefined);

  const outside = tempDir("devspace-outside-");
  const link = join(root, "escape");
  symlinkSync(outside, link);
  const confinedCalls = [];
  const confined = await fakeRuntime({ sandboxFallback: "worktree-embedded", worktreeRoot: root, sandboxProbe: () => denied() }, confinedCalls).run({ ...input, workspaceRoot: link });
  assertSandboxError(confined, { stage: "worktree-confinement" });
  assert.equal(confinedCalls.length, 0, "confinement failure must happen before a provider turn");
}

async function errorAndMetadataCases() {
  const error = new AgentSandboxUnavailableError({
    code: "SANDBOX_UNAVAILABLE",
    provider: "codex",
    backend: "linux-user-namespace",
    stage: "probe",
    detail: "probe denied",
    retryable: false,
    fallbackAvailable: true,
    operation: "run",
    message: "probe denied",
  });
  const payload = toAgentErrorPayload(error);
  const wire = decodeLocalAgentDaemonResponse(JSON.parse(encodeLocalAgentDaemonResponse({
    requestId: "request-1",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    ok: false,
    error: payload,
  })));
  const roundTrip = agentErrorFromPayload(wire.error);
  assert.equal(roundTrip instanceof AgentSandboxUnavailableError, true);
  assert.equal(roundTrip.backend, "linux-user-namespace");
  assert.equal(roundTrip.stage, "probe");
  assert.equal(roundTrip.detail, "probe denied");
  assert.equal(roundTrip.retryable, false);
  assert.equal(roundTrip.fallback_available, true);

  const state = {
    id: "agt_meta",
    workspaceRoot: "/tmp/worktree",
    profileName: "codex",
    provider: "codex",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let stored = { ...state };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const warning = "Codex is running WITHOUT an OS sandbox.";
  const metadata = { sandbox: "worktree-embedded", warnings: [warning], reviewer: "kept" };
  let runCount = 0;
  const store = {
    getByIdResult: () => Result.ok(stored),
    updateResult: (_id, patch) => {
      stored = { ...stored, ...patch };
      return Result.ok(stored);
    },
    reconcileActiveRunsResult: () => Result.ok(0),
    close: () => undefined,
  };
  const pool = {
    size: 0,
    run: async (_driver, _context, _input, callbacks) => {
      runCount += 1;
      if (runCount === 1) {
        await callbacks.onSandboxFallback({ sandbox: metadata.sandbox, warning, metadata });
        await gate;
        return Result.err(error);
      }
      if (runCount === 2)
        return Result.ok({ providerSessionId: "thread-sandboxed", finalResponse: "sandboxed response" });
      throw new Error("provider callback exploded");
    },
    close: async () => undefined,
    evictIdle: async () => undefined,
  };
  const manager = new LocalAgentManager({
    store,
    drivers: [{ provider: "codex", runtimeKey: () => "test", createRuntime: async () => Result.ok(undefined) }],
    pool,
    loadProfiles: async () => [],
    agentDir: "/tmp",
    logger: undefined,
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true }] },
  });
  const started = manager.begin(state, "hello", { writeMode: "allowed" });
  assert.equal(started.isOk(), true);
  for (let attempt = 0; attempt < 20 && stored.metadata === undefined; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const runningObservation = presentAgentObservation(stored);
  assert.deepEqual(runningObservation.metadata, metadata);
  assert.equal(runningObservation.previouslyUnsandboxed, true);
  assert.equal(typeof runningObservation.lastUnsandboxedAt, "string");
  assert.match(formatAgentObservation(runningObservation), /Warning: Codex is running WITHOUT an OS sandbox\./);
  assert.match(formatAgentObservation(runningObservation), /previouslyUnsandboxed=true/);
  release();
  for (let attempt = 0; attempt < 100 && manager.activeTurnCount > 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(stored.metadata, metadata, "failed fallback metadata must remain on the error record");
  const failedObservation = presentAgentObservation(stored);
  assert.deepEqual(failedObservation.metadata, metadata);
  assert.equal(failedObservation.previouslyUnsandboxed, true, "fallback exposure must survive provider errors");
  const lastUnsandboxedAt = failedObservation.lastUnsandboxedAt;
  assert.match(formatAgentObservation(failedObservation), /Warning: Codex is running WITHOUT an OS sandbox\./);

  const sandboxed = manager.begin(stored, "sandboxed", { writeMode: "allowed" });
  assert.equal(sandboxed.isOk(), true);
  for (let attempt = 0; attempt < 100 && manager.activeTurnCount > 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(stored.metadata, undefined, "sandboxed turns replace current-turn fallback metadata");
  assert.equal(stored.previouslyUnsandboxed, true, "sandboxed turns must not clear sticky exposure");
  assert.equal(stored.lastUnsandboxedAt, lastUnsandboxedAt);
  const sandboxedObservation = presentAgentObservation(stored);
  assert.equal(sandboxedObservation.previouslyUnsandboxed, true);
  assert.equal(sandboxedObservation.lastUnsandboxedAt, lastUnsandboxedAt);
  assert.match(formatAgentObservation(sandboxedObservation), /previouslyUnsandboxed=true/);

  const internalFailure = manager.begin(stored, "internal error", { writeMode: "allowed" });
  assert.equal(internalFailure.isOk(), true);
  for (let attempt = 0; attempt < 100 && manager.activeTurnCount > 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(stored.status, "error");
  assert.equal(stored.previouslyUnsandboxed, true, "internal errors must not clear sticky exposure");
  assert.equal(stored.lastUnsandboxedAt, lastUnsandboxedAt);

  const tempState = tempDir("devspace-store-");
  const localStore = new LocalAgentStore(tempState);
  const record = localStore.create({ workspaceRoot: tempState, profileName: "codex", provider: "codex" });
  const unknownMetadata = { sandbox: "worktree-embedded", warnings: ["w"], unknown: { keep: true } };
  localStore.update(record.id, {
    metadata: unknownMetadata,
    previouslyUnsandboxed: true,
    lastUnsandboxedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.deepEqual(localStore.getById(record.id).metadata, unknownMetadata);
  assert.equal(localStore.getById(record.id).previouslyUnsandboxed, true);
  assert.equal(localStore.getById(record.id).lastUnsandboxedAt, "2026-01-01T00:00:01.000Z");
  const decoded = decodeAgentRecord({ ...localStore.getById(record.id), metadata: { unknown: "preserve", nested: { yes: true } } });
  assert.deepEqual(decoded.metadata, { unknown: "preserve", nested: { yes: true } });
  assert.equal(decoded.previouslyUnsandboxed, true);
  assert.equal(decoded.lastUnsandboxedAt, "2026-01-01T00:00:01.000Z");
  localStore.close();
}

async function stopAndStatusCases() {
  const stopRequest = { requestId: "stop-1", protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION, authToken: "secret", method: "daemon.stop" };
  assert.equal(decodeLocalAgentDaemonRequest(stopRequest).params.force, true, "legacy stop without params remains forceful");
  assert.equal(decodeLocalAgentDaemonRequest({ ...stopRequest, params: { force: false } }).params.force, false);
  const raceRoot = tempDir("devspace-admission-");
  let profilesStarted = false;
  let releaseProfiles;
  const profilesGate = new Promise((resolve) => { releaseProfiles = resolve; });
  let raceRecord;
  let raceRuns = 0;
  const raceStore = {
    createResult: (input) => {
      raceRecord = {
        id: "agt_race",
        ...input,
        status: "starting",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      return Result.ok(raceRecord);
    },
    getByIdResult: () => Result.ok(raceRecord),
    updateResult: (_id, patch) => {
      raceRecord = { ...raceRecord, ...patch };
      return Result.ok(raceRecord);
    },
    reconcileActiveRunsResult: () => Result.ok(0),
    close: () => undefined,
  };
  const raceManager = new LocalAgentManager({
    store: raceStore,
    drivers: [{ provider: "codex", runtimeKey: () => "race", createRuntime: async () => Result.ok(undefined) }],
    pool: {
      size: 0,
      run: async () => {
        raceRuns += 1;
        return Result.ok({ finalResponse: "must not run" });
      },
      close: async () => undefined,
      evictIdle: async () => undefined,
    },
    loadProfiles: async () => {
      profilesStarted = true;
      await profilesGate;
      return [];
    },
    agentDir: "/tmp",
    logger: undefined,
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true }] },
  });
  const racedStart = raceManager.start({ target: "codex", prompt: "race", workspaceRoot: raceRoot, writeMode: "allowed" });
  for (let attempt = 0; attempt < 100 && !profilesStarted; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(profilesStarted, true);
  raceManager.stopAdmission();
  releaseProfiles();
  const racedResult = await racedStart;
  assert.equal(racedResult.isErr(), true, "a start admitted before stop must be rejected before begin");
  assert.equal(racedResult.error.code, "AGENT_CONFLICT");
  assert.equal(raceRuns, 0, "a rejected raced start must not enter the provider pool");

  const stateDir = tempDir("devspace-daemon-");
  let activeTurns = 0;
  let admissionStops = 0;
  const manager = {
    get activeTurnCount() { return activeTurns; },
    runtimeCount: 0,
    stopAdmission: () => { admissionStops += 1; },
    evictIdle: async () => undefined,
    close: async () => undefined,
  };
  const daemon = new LocalAgentDaemon({
    stateDir,
    manager,
    idleShutdownMs: 60_000,
    buildVersion: "1.0.8-r13-test",
    sandboxFallback: "worktree-embedded",
    getSandboxProbeState: () => ({ outcome: "denied", at: "2026-01-01T00:00:00.000Z" }),
  });
  await daemon.start();
  const client = new LocalAgentClient({ stateDir, requestTimeoutMs: 2_000 });
  const status = await client.status();
  assert.equal(status.isOk(), true);
  assert.deepEqual(status.value.sandboxProbe, { outcome: "denied", at: "2026-01-01T00:00:00.000Z" });
  assert.equal(status.value.version, "1.0.8-r13-test");
  assert.equal(status.value.sandboxFallback, "worktree-embedded");
  assert.deepEqual(decodeDaemonStatus(status.value), status.value);

  activeTurns = 1;
  const busy = await client.stop();
  assert.equal(busy.isErr(), true);
  assert.equal(busy.error instanceof AgentDaemonBusyError, true);
  assert.equal(daemon.status().state, "ready", "non-force stop must leave daemon alive");
  activeTurns = 0;
  const stopped = await client.stop(true);
  assert.equal(stopped.isOk(), true);
  assert.equal(admissionStops > 0, true, "daemon stop must close manager admission before shutdown");
  for (let attempt = 0; attempt < 100 && daemon.server; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(daemon.server, undefined, "force stop must stop the daemon");
}

await probeCases();
await sandboxDecisionCases();
await errorAndMetadataCases();
await stopAndStatusCases();
console.log("sandbox fallback behavior: PASS (probe, policy, Result, metadata, transport, resume, daemon guard, status)");
