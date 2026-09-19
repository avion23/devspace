import assert from "node:assert/strict";
import { Result } from "better-result";
import { buildLocalAgentCatalog, buildLocalAgentProviderStatuses } from "../dist/local-agent-catalog.js";
import { resolveCodexSandbox } from "../dist/local-agent-codex.js";
import { LocalAgentManager } from "../dist/local-agent-manager.js";
import {
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_MODEL,
  blockedModelReason,
  isBlockedLocalAgentModel,
  resolveLocalAgentTarget,
} from "../dist/local-agent-targets.js";

function fakeManager(loadProfiles = async () => []) {
  const records = new Map();
  let nextId = 1;
  const poolCalls = [];
  const store = {
    createResult(input) {
      const now = new Date().toISOString();
      const record = {
        id: `agt_policy_${nextId++}`,
        ...input,
        status: "starting",
        createdAt: now,
        updatedAt: now,
      };
      records.set(record.id, record);
      return Result.ok(record);
    },
    getByIdResult(id) {
      return Result.ok(records.get(id));
    },
    updateResult(id, patch) {
      const current = records.get(id);
      if (!current)
        return Result.err(new Error(`Unknown record ${id}`));
      const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
      records.set(id, updated);
      return Result.ok(updated);
    },
    reconcileActiveRunsResult: () => Result.ok(0),
    close: () => undefined,
  };
  const manager = new LocalAgentManager({
    store,
    drivers: [{ provider: "codex" }],
    pool: {
      size: 0,
      run: async (_driver, _context, input) => {
        poolCalls.push(input);
        return Result.ok({ finalResponse: "ok" });
      },
      close: async () => undefined,
      evictIdle: async () => undefined,
    },
    loadProfiles,
    agentDir: "/tmp",
    subagents: {
      enabled: true,
      providers: [{ id: "codex", enabled: true }],
    },
  });
  return { manager, records, poolCalls };
}

const providerConfigs = [{ id: "codex", enabled: true }];
for (const model of [
  "gpt-5.6-terra",
  "gpt-5-6-terra",
  "openai/gpt-5.6-terra",
  "openai:gpt-5-6-terra",
]) {
  assert.equal(isBlockedLocalAgentModel(model), true, model);
  const target = resolveLocalAgentTarget("codex", [], model, undefined, providerConfigs);
  assert.equal(target.model, model);
}

for (const model of ["gpt-5.4", "gpt-5.4-mini", "gpt-4o", "gpt-4", "gpt-5", "gpt-3.5-turbo", "openai:gpt-5-4"]) {
  assert.equal(isBlockedLocalAgentModel(model), true, model);
  assert.equal(blockedModelReason(model), "below-minimum", model);
}
for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "claude-sonnet-4-5", "o3", "o4-mini"]) {
  assert.equal(isBlockedLocalAgentModel(model), false, model);
}
const blockedMessage = (() => {
  let message;
  try { blockedModelReason; } catch { /* noop */ }
  return undefined;
})();

const explicit = resolveLocalAgentTarget("codex", [], "gpt-5.6-custom", "high", providerConfigs);
assert.deepEqual(
  { model: explicit.model, effort: explicit.effort },
  { model: "gpt-5.6-custom", effort: "high" },
);
const defaults = resolveLocalAgentTarget("codex", [], undefined, undefined, providerConfigs);
assert.deepEqual(
  { model: defaults.model, effort: defaults.effort },
  { model: CODEX_DEFAULT_MODEL, effort: CODEX_DEFAULT_EFFORT },
);
assert.equal(
  resolveLocalAgentTarget("claude", [], undefined, undefined, [{ id: "claude", enabled: true }]),
  undefined,
);

const catalogProviders = buildLocalAgentProviderStatuses(
  {
    enabled: true,
    providers: [
      { id: "codex", enabled: true },
    ],
  },
  [
    { name: "codex", available: true },
  ],
);
assert.deepEqual(
  catalogProviders.find((provider) => provider.id === "codex"),
  {
    id: "codex",
    enabled: true,
    available: true,
    usable: true,
    model: CODEX_DEFAULT_MODEL,
    effort: CODEX_DEFAULT_EFFORT,
    reason: undefined,
    note: undefined,
  },
);
assert.equal(catalogProviders.length, 1);
const catalog = buildLocalAgentCatalog(
  { enabled: true, providers: catalogProviders },
  [
    { name: "luna", description: "Luna", provider: "codex" },
    { name: "terra", description: "Terra", provider: "codex", model: "openai/gpt-5-6-terra" },
  ],
  catalogProviders,
);
assert.equal(catalog.providers.find((provider) => provider.id === "codex").model, CODEX_DEFAULT_MODEL);
assert.deepEqual(catalog.profiles, [{
  name: "luna",
  description: "Luna",
  provider: "codex",
  model: CODEX_DEFAULT_MODEL,
  effort: CODEX_DEFAULT_EFFORT,
}]);

const { manager, records, poolCalls } = fakeManager();
const blockedStart = await manager.start({
  target: "codex",
  model: "openai/gpt-5-6-terra",
  prompt: "blocked",
  workspaceRoot: "/tmp/model-policy",
});
assert.equal(blockedStart.isErr(), true);
assert.equal(blockedStart.error.code, "MODEL_BLOCKED");
assert.equal(poolCalls.length, 0);

const persisted = {
  id: "agt_persisted",
  workspaceRoot: "/tmp/model-policy",
  profileName: "codex",
  provider: "codex",
  model: "gpt-5.6-terra",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
records.set(persisted.id, persisted);
const blockedContinue = await manager.continue(
  persisted.id,
  "blocked",
  {},
  { workspaceRoot: persisted.workspaceRoot },
);
assert.equal(blockedContinue.isErr(), true);
assert.equal(blockedContinue.error.code, "MODEL_BLOCKED");
assert.equal(records.get(persisted.id).status, "idle");

const legacy = {
  id: "agt_legacy",
  workspaceRoot: "/tmp/model-policy",
  profileName: "codex",
  provider: "codex",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
records.set(legacy.id, legacy);
const continued = await manager.continue(
  legacy.id,
  "default",
  {},
  { workspaceRoot: legacy.workspaceRoot },
);
assert.equal(continued.isOk(), true);
assert.equal(continued.value.model, CODEX_DEFAULT_MODEL);
assert.equal(continued.value.effort, CODEX_DEFAULT_EFFORT);

const { manager: profileManager, records: profileRecords } = fakeManager(async () => [{
  name: "terra-profile",
  description: "Terra",
  provider: "codex",
  model: "gpt-5.6-terra",
  body: "",
}]);
const profileRecord = {
  id: "agt_profile",
  workspaceRoot: "/tmp/model-policy",
  profileName: "terra-profile",
  provider: "codex",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
profileRecords.set(profileRecord.id, profileRecord);
const blockedProfile = await profileManager.continue(
  profileRecord.id,
  "blocked",
  {},
  { workspaceRoot: profileRecord.workspaceRoot },
);
assert.equal(blockedProfile.isErr(), true);
assert.equal(blockedProfile.error.code, "MODEL_BLOCKED");

const started = await manager.start({
  target: "codex",
  prompt: "default",
  workspaceRoot: "/tmp/model-policy",
});
assert.equal(started.isOk(), true);
assert.equal(started.value.model, CODEX_DEFAULT_MODEL);
assert.equal(started.value.effort, CODEX_DEFAULT_EFFORT);

// Effort is passed through verbatim: the app-server model catalog advertises
// `max` as a supported reasoning level for gpt-5.6-luna (low/medium/high/xhigh/max).
assert.equal(CODEX_DEFAULT_EFFORT, "max");
const fullAccessSandbox = await resolveCodexSandbox(
  { prompt: "x", workspaceRoot: "/tmp/model-policy", writeMode: "read_only" },
  { sandboxMode: "full-access", sandboxProbe: async () => ({ outcome: "ok" }) },
);
assert.equal(fullAccessSandbox.sandbox, "danger-full-access");
const autoSandbox = await resolveCodexSandbox(
  { prompt: "x", workspaceRoot: "/tmp/model-policy", writeMode: "read_only" },
  { sandboxMode: "auto", sandboxProbe: async () => ({ outcome: "ok" }) },
);
assert.equal(autoSandbox.sandboxPolicy.type, "readOnly");
await manager.close();
await profileManager.close();
console.log("model policy behavior: ok");

// Full-access mode records the same unsandboxed audit trail the fallback path does.
{
  const events = [];
  const fullAccess = await resolveCodexSandbox(
    { prompt: "x", workspaceRoot: "/tmp/model-policy", writeMode: "read_only" },
    { sandboxMode: "full-access", onSandboxFallback: (e) => events.push(e) },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].sandbox, "full-access");
  assert.match(events[0].warning, /WITHOUT an OS sandbox/);
  assert.equal(fullAccess.metadata.sandbox, "full-access");
}
