# Local patches to @waishnav/devspace (compiled dist JS)

Applied by hand; a package update (npm update / reinstall) will overwrite these.
Each entry: file, what, why, backup, revert.

## 2026-09-04 (rev 2) — ~ expansion for all tools + 5 MB read guard

- Files: `~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist/roots.js`, `~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist/pi-tools.js`
- What:
  - `roots.js` `resolveAllowedPath`: applies the package's existing `expandHomePath` to its input before `resolve(cwd, ...)` — leading `~/` (or bare `~`) now resolves via `os.homedir()` for ALL tools (read, write, edit, grep, find, ls) and `workspaces.resolvePath`. Previously `~/x` mangled to `<workspace>/~/x` → ENOENT. Absolute and relative paths pass through unchanged (expandHomePath is idempotent); outside-root paths still get the normal AccessDeniedError.
  - `pi-tools.js` `readFileTool`: `statSync` guard; files > 5 MB (`MAX_READ_FILE_BYTES`) return the normal error shape (`{content:[{type:"text"}], isError:true}`, no throw) with exact bytes + human-readable MB and bash-tool advice (`tail -n N`, `head -c N`, `rg --max-count PATTERN`). Prevents the pi read tool reading whole huge files ("Cannot create a string longer than 0x1fffffe8 characters"). Missing files still ENOENT cleanly (from statSync).
- Why: client-facing read-tool huge-file crash; `~` paths broken for all file tools.
- Backups: `dist/roots.js.bak2-20260904`, `dist/pi-tools.js.bak2-20260904` (pre-rev2 state of pi-tools includes rev-1 guard);
  `dist/server.js.bak-20260904` (pristine upstream) and `dist/server.js.bak2-20260904` (rev-1 patched state).
- Note: rev 1 patched the read dispatch in `server.js` (expandHomePath there); rev 2 moved expansion to the single owner `roots.js` and reverted `server.js` to pristine upstream (byte-identical to `.bak-20260904`). No other files are patched.
- Revert: `cd ~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist && cp roots.js.bak2-20260904 roots.js && cp pi-tools.js.bak2-20260904 pi-tools.js && sudo systemctl restart devspace.service`
  (full pristine restore: also `cp server.js.bak-20260904 server.js`; pi-tools pristine is `pi-tools.js.bak-20260904`)
- Applied by: agent session 2026-09-04; validated with `node --check` (roots.js, pi-tools.js, server.js), direct tests (300 MB sparse file → size-bearing isError; small file → success; expandHomePath/resolveAllowedPath `~` unit checks incl. double-expansion), service restarted and serving reads.

## 2026-09-04 (rev 3) — 30 min MCP session idle sweep + 45s hard default bash timeout

- File: `~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist/server.js` (only file touched)
- What:
  - Session idle timeout: line 34 `const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;` → `const MCP_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;`. Sole consumer is the sweep at the bottom (`setInterval` every `MCP_SESSION_CLEANUP_INTERVAL_MS` (5 min) → `transports.closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)` → `McpSessionRegistry.closeIdle` closes transports idle past the cutoff). Abandoned MCP sessions are now reaped after 30 minutes instead of 24 hours.
  - bash tool hard default 45s: new constant after line 35 `const BASH_TOOL_DEFAULT_TIMEOUT_SECONDS = 45;`. In the `bash` tool handler (the `registerAppTool(server, toolNames.shell, ...)` callback, ~line 1253): when the caller omits `timeout`, `bashInput = { ...input, timeout: BASH_TOOL_DEFAULT_TIMEOUT_SECONDS }` is built and passed to `runShellTool(bashInput, ...)`; an explicit caller `timeout` (including larger values up to the schema max 300) is passed through untouched. The timeout flows to the actual process owner — `pi-tools.runShellTool` → `createBashTool` (@earendil-works/pi-coding-agent) local bash ops — where `resolveTimeoutMs` schedules the kill, `killProcessTree(child.pid)` kills the spawned tree, and the tool throws with the captured stdout/stderr plus `Command timed out after N seconds`; `runTool` in pi-tools converts that to the normal `{content:[{type:"text"}], isError:true}` shape. Schema description (line ~1248) updated `"Defaults to 30, max 300."` → `"Defaults to 45, max 300."`. New helper `appendShellTimeoutGuidance(content)` (after `logFailedToolResponse`, ~line 216) appends `"\n\nThe command was killed by the DevSpace bash timeout (45 seconds when the caller omits \`timeout\`). For long-running processes, use exec_command instead: it returns a sessionId you can poll with write_stdin."` to the text content when the error text contains `Command timed out after`; called at the top of the handler's `if (response.isError)` branch before `logFailedToolResponse`. `exec_command`/`write_stdin` and `process-sessions.js` are untouched.
- Why: MCP clients never close sessions, so the 24h idle sweep let memory grow to ~29G. ChatGPT's connector gives up on tool calls around 60s; bash calls without an effective bound ran 190s+ and "succeeded" server-side after the client died. Long-running work belongs in `exec_command` (yields a `sessionId` for `write_stdin` polling).
- Backups: `dist/server.js.bak3-20260904` (pre-rev3 state; pristine upstream, byte-identical to `.bak-20260904`). Prior revs' files (`pi-tools.js`, `roots.js`, their `.bak*`) untouched.
- Revert: `cd ~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist && cp server.js.bak3-20260904 server.js` (then let the orchestrator restart `devspace.service`; no systemd interaction from agent sessions).
- Applied by: agent session 2026-09-04; validated with `node --check dist/server.js`, `diff server.js.bak3-20260904 server.js` (only the regions above), and a live probe of the installed `createBashTool` (echo + `sleep 30` with `timeout: 2` → killed at ~2.0s, captured stdout preserved, message `Command timed out after 2 seconds`, no stray process).

## 2026-09-04 (rev 4) — timeout guidance fix + MCP session-count cap

- File: `~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist/server.js` (only file touched)
- What:
  - `appendShellTimeoutGuidance` (line ~222): appended guidance text no longer references `exec_command`/`write_stdin` (those tools are not in the exposed 5-tool set: `bash`, `edit`, `open_workspace`, `read`, `write`). New text: `"\n\nThe command was killed by the bash tool timeout (45 seconds when the caller omits \`timeout\`). To run longer work, either split it into shorter commands, or re-run passing an explicit \`timeout\` in seconds (max 300) and wait for the result."`
  - Session-count cap: new constant at lines 40-41 `const MAX_MCP_SESSIONS = 256;` (next to `BASH_TOOL_DEFAULT_TIMEOUT_SECONDS`). In the `app.all("/mcp", ...)` initialize branch (before `new StreamableHTTPServerTransport`, line ~1477): if `transports.size >= MAX_MCP_SESSIONS`, log warn event `mcp_session_limit_rejected` with `requestId`, `currentSessions`, `limit`, plus `requestLogFields`, set `Retry-After: 5`, respond `sendJsonRpcError(res, 503, -32000, "Session limit reached, retry shortly")`, and return without constructing the transport. Bounds session count; the rev-3 30 min idle TTL (`MCP_SESSION_IDLE_TIMEOUT_MS`) only bounds age.
- Why: rev-3 guidance told the model to use tools the client cannot call; the TTL sweep left unbounded zombie-session accumulation inside the window.
- Backups: `dist/server.js.bak4-20260904` (pre-rev4 state, includes rev 3). No other files touched.
- Revert: `cd ~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist && cp server.js.bak4-20260904 server.js` (then let the orchestrator restart `devspace.service`; no systemd interaction from agent sessions).
- Applied by: agent session 2026-09-04; validated with `node --check dist/server.js` and `diff server.js.bak4-20260904 server.js` (only the three regions above: constant, guidance string, initialize-branch guard).

## 2026-09-04 (rev 5) — evict-oldest-on-cap replaces initialize 503

- File: `~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist/server.js` (only file touched)
- What: the rev-4 initialize-branch guard (`transports.size >= MAX_MCP_SESSIONS`, ~line 1479) no longer 503s by default. When at cap it finds the session with the smallest `lastActivityAt` by iterating `transports.sessions`, logs info event `mcp_session_evicted` (`requestId`, `evictedSessionIdPrefix`, `idleSeconds`, `currentSessions`, `limit`, plus `requestLogFields`), then `await entry.transport.close()` in try/catch followed by `transports.remove(oldestKey)` (delete is a no-op if `onclose` already removed it), and falls through to create the new transport (no return). The 503 (`mcp_session_limit_rejected`, `Retry-After: 60`, up from 5) remains only for the impossible case where the map yielded no entry (concurrent change).
- Why: rev 4 was arithmetically broken — the sole client creates ~14.6 sessions/min and never closes them; the 30-min idle sweep (every 5 min) leaves ~470 steady-state zombies > 256, so the registry pinned at cap and every new client run got 503'd. Evicting the oldest-idle zombie is the same class as the idle sweep and never blocks the live client.
- Backups: `dist/server.js.bak5-20260904` (pre-rev5 state, includes rev 4). No other files touched.
- Revert: `cd ~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist && cp server.js.bak5-20260904 server.js` (then let the orchestrator restart `devspace.service`; no systemd interaction from agent sessions).
- Applied by: agent session 2026-09-04; validated with `node --check dist/server.js` and `diff server.js.bak5-20260904 server.js` (only the initialize-branch guard region).

## 2026-09-05 (rev 6) — bash timeout max 300 -> 900 (explicit opt-in)

- File: `~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist/server.js` (only file touched)
- What: three single-token/string changes. (1) bash tool zod schema `timeout` (line ~1248): `.max(300)` → `.max(900)`; (2) same schema `describe` (line ~1250): `"Timeout in seconds. Defaults to 45, max 300."` → `"...max 900."`; (3) `appendShellTimeoutGuidance` appended text (line ~222): `"(max 300)"` → `"(max 900)"` in the killed-by-timeout guidance. The 45s default (`BASH_TOOL_DEFAULT_TIMEOUT_SECONDS`) is unchanged; 900s applies only when the caller passes an explicit `timeout`. The underlying pi bash tool already enforces whatever value arrives and kills the process tree on expiry (rev-3 probe), so no executor change is needed.
- Why: operator decision — keep the 45s default (protects against the ChatGPT client abandoning long calls) while allowing explicit opt-in waits up to 15 minutes; 300s capped legitimate long builds/installs.
- Backups: `dist/server.js.bak6-20260905` (pre-rev6 state, includes rev 5). Rev-5 state also preserved in `dist/server.js.bak5-20260904`. No other files touched.
- Revert: `cd ~/.local/npm-global/lib/node_modules/@waishnav/devspace/dist && cp server.js.bak6-20260905 server.js` (then let the orchestrator restart `devspace.service`; no systemd interaction from agent sessions).
- Applied by: agent session 2026-09-05; validated with `node --check dist/server.js` and `diff server.js.bak6-20260905 server.js` (only the three regions above).

## 2026-09-05 (aliases) — ChatGPT strict-discovery GET aliases (now versioned)

- File: `dist/server.js` (~18-line `app.use` before `app.use(mcpAuthRouter(...))`, lines ~1396-1413 in the r6 tag)
- What: pure-GET `req.url` rewrite so the canonical SDK `metadataHandler` serves both discovery forms with identical body, content-type, CORS, and query passthrough: bare `/.well-known/oauth-protected-resource` rewrites to `/.well-known/oauth-protected-resource/mcp`, and `/.well-known/oauth-authorization-server/mcp` rewrites to `/.well-known/oauth-authorization-server`. Non-GET requests pass through untouched. No auth/token/funnel/firewall change. Upstream `mcpAuthMetadataRouter` (SDK `auth/router.js:96-99`) serves only path-specific PRM (RFC 9728) + bare AS (RFC 8414); ChatGPT strict discovery also probes the complementary bare-PRM and suffixed-AS forms.
- Why: ChatGPT connector strict discovery failed without the complementary metadata URLs.
- Reapply script: canonical copy is now `scripts/reapply-wellknown-aliases.sh` in this repo (idempotent; exits 0 with "already applied" if the `strict-discovery GET aliases` marker is present; `--check` mode exits 1 when missing). Previously the script lived only outside the repo at `~/.devspace/reapply-wellknown-aliases.sh` (the path referenced by the code comment); that outside copy remains a deployment convenience but the repo copy is authoritative.
- Revert: delete the `app.use((req, _res, next) => { ... })` alias block (the one containing the `strict-discovery GET aliases` marker) and restart the service.
- Applied by: pre-rev7 session; validated by strict-discovery probes serving identical docs on both forms.

## 2026-09-05 (rev 7) — timeout single-source, incumbent grace, reproducible installs

- Files: `dist/pi-tools.js`, `dist/server.js`, `package.json` (`files` += `package-lock.json`), `package-lock.json` (new), `README.md` (WARNING + install tag), `scripts/reapply-wellknown-aliases.sh` (new, versioned from `~/.devspace/reapply-wellknown-aliases.sh`), `PATCHES.md` (this entry + aliases entry above)
- What:
  - Timeout single-source (F1): `dist/pi-tools.js` now owns `export const BASH_TOOL_DEFAULT_TIMEOUT_SECONDS = 45` and `export const BASH_TOOL_MAX_TIMEOUT_SECONDS = 900` at module scope. `runShellTool` uses `input.timeout === undefined ? BASH_TOOL_DEFAULT_TIMEOUT_SECONDS : Math.min(input.timeout, BASH_TOOL_MAX_TIMEOUT_SECONDS)` (was hardcoded `30` / `300`, the rev-6 split-brain that silently clamped explicit 301-900 to 300). `dist/server.js` imports both consts: the zod schema uses `.positive().max(BASH_TOOL_MAX_TIMEOUT_SECONDS)` with describe text generated from the consts (`` `Timeout in seconds. Defaults to ${BASH_TOOL_DEFAULT_TIMEOUT_SECONDS}, max ${BASH_TOOL_MAX_TIMEOUT_SECONDS}.` ``), the bash handler default uses the imported default const, and `appendShellTimeoutGuidance` interpolates both consts. Out-of-range explicit values (e.g. 901) are REJECTED by the schema (400/-32602), never silently clamped; the executor `Math.min` is defense-in-depth only. Startup logs the effective values alongside existing lines (`bash timeout: default 45s, max 900s`; `mcp sessions: max 256, idle timeout 1800s, limit Retry-After 60s, incumbent grace enabled/disabled`).
  - Incumbent grace (F2): at cap (`transports.size >= MAX_MCP_SESSIONS`, still the single cap const `256`) the initialize branch computes `oldestIdleMs = Date.now() - oldestEntry.lastActivityAt` and `idleSeconds` via the new module-scope `MS_PER_SECOND = 1_000`. If `MCP_SESSION_INCUMBENT_GRACE_ENABLED` (new module-scope revert flag, default true) and `oldestIdleMs < MCP_SESSION_IDLE_TIMEOUT_MS`, the newcomer is REJECTED with the existing `503 Retry-After` path (`MCP_SESSION_LIMIT_RETRY_AFTER_SECONDS = 60`, `String(...)`, `mcp_session_limit_rejected` warn with `idleSeconds`) instead of evicting a possibly-live incumbent (next call would have been `404 -32000 "Unknown MCP session"`). This makes the rev-5-dead `503` path live. Otherwise evict-oldest proceeds as before, but the victim's `lastActivityAt` is captured before `await transport.close()` and re-validated after (`transports.sessions.get(oldestKey)`; skip `transports.remove` if it became active during the await, logging `mcp_session_evict_skipped` at debug). The empty `catch {}` is replaced with a warn `mcp_session_evict_close_failed` carrying the error message. No new per-admission info logs (evict path keeps its existing info `mcp_session_evicted`; new steady-state signal is debug-only).
  - Reproducible installs + upgrade (F4/F5): `npm install --package-lock-only` output `package-lock.json` committed and added to `package.json` `files` so the tarball ships it. Deps remain `^` ranges in `package.json` but the lockfile pins the resolved tree for reproducible installs.
  - WARNING (F4/F5): `README.md` WARNING now covers all overwrite paths — `npm install -g @waishnav/devspace`, `npm i -g` shorthand, `npm update -g` / `npm upgrade` (PROVEN by dry-run: `npm update -g --dry-run` shows `change @waishnav/devspace 1.0.8 => 1.0.8` from the registry, so tag installs are NOT immune), and the future upstream-1.0.9 registry-takeover event. Install tag bumped to `v1.0.8-r7`. Also fixes the "six patches" count nit (seven items listed).
  - Evidence hygiene (F6/F7): aliases patch documented above; reapply script versioned into the repo; no `.bak*`/`.pre-patch*` files are committed (they live only in deployed `dist/` dirs and must be moved to `~/.devspace/baks/` before reinstall, or the reinstall wipes them).
- Why: adversarial review must-fix F1/F2/F3/F4/F5/F6/F7 bundle (F3 rollout is procedural: restart required since Node loads dist once at startup; `healthz` proves liveness only).
- Reverts (one const/flag each, then reinstall + restart):
  - Timeout: set both pi-tools consts back (`45`/`900`) or re-pin schema `.max(...)` + describe string; executor and schema move together via the shared import.
  - Incumbent grace: `MCP_SESSION_INCUMBENT_GRACE_ENABLED = false` restores rev-5 pure evict-oldest; `MAX_MCP_SESSIONS` remains the single cap const.
  - Lockfile/WARNING: `git show v1.0.8-r6:package.json` `files` (drop `package-lock.json`) + delete `package-lock.json`; README WARNING previous single-line form is in `git show v1.0.8-r6:README.md`.
  - Aliases: delete the marker `app.use` block in `dist/server.js` (or run no reapply script on next install).
- Applied by: agent session 2026-09-05; validated with `node --check dist/server.js dist/pi-tools.js`, a `node --test` script under `/tmp` (13 tests: const values 45/900, executor semantics incl. 500 passthrough, zod 901-rejected/900-accepted + describe text, startup-log presence, magic-number naming, grace/503-live/re-validation/logged-catch assertions, adversarial arrival-order selection incl. boundary), and `git diff` review (minimal, no dead code, no new per-admission info logs).

## 2026-09-05 (rev 8) — hotfix released 2026-09-05 as `v1.0.8-r8` (300 s default timeout, 300 s incumbent grace, 8192-session cap, quiet eviction logs, read-guard error shape, production startup logs)

- Released: tag `v1.0.8-r8`, 2026-09-05. Rev 8 = `v1.0.8-r7` + (a) + (b1) + (b2)
  + (c) + (d) + (e) below, byte-identical to the previously live hotfix
  (verified by md5 before and after the tagged install on BOTH hosts). Revert =
  reinstall the previous tag:
  `npm i -g https://github.com/avion23/devspace/archive/refs/tags/v1.0.8-r7.tar.gz`
  + restart (`sudo -n systemctl restart devspace` netcup /
  `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart devspace-serve`
  instance2).
- Date: 2026-09-05. Applied identically on BOTH hosts (netcup
  `~/.local/npm-global/.../@waishnav/devspace/dist/`, instance2 same path;
  host-vs-host `diff` clean on all three files).
- Base: `v1.0.8-r7` tag tree — tag-tree md5s were byte-identical to live BEFORE
  patching (`cli.js 2182a6fecedbc769e34f717559cf01c0`,
  `server.js 33978ab1c45c97d44b63a769b934afc6`,
  `pi-tools.js 8c3e3ec9a5039245004ace8331f53cf0`,
  `roots.js 8ea6bda1f4da8295c83805f11e5cb03d`). `dist/roots.js` untouched.
- Change (a) production startup logs (`dist/cli.js`): imports rev-7
  `BASH_TOOL_DEFAULT_TIMEOUT_SECONDS`/`BASH_TOOL_MAX_TIMEOUT_SECONDS` from
  `./pi-tools.js` (leaf module, no cycle) and logs
  `bash timeout: default 45s, max 900s` in `serve()`; MCP cap values duplicated
  as literals with pointer comment (`mcp sessions: max 256, idle timeout 1800s,
  limit Retry-After 60s, incumbent grace enabled`) because `server.js` does not
  export those consts and statically importing `server.js` would eagerly load
  the heavy server module for every cli command. Same format as the
  `server.js` isMainModule path.
- Change (b1/F10) quiet per-event logging (`dist/server.js` only):
  `mcp_session_evicted` `info` → `debug`. `mcp_session_evict_skipped` already
  `debug`; `mcp_session_evict_close_failed` stays `warn`. Pre-existing upstream
  lines (`mcp_session_created`, `mcp_request`, `http_request`) untouched.
- Change (b2/F11) read-guard (`dist/pi-tools.js` `readFileTool`): `statSync`
  inside try/catch returning `{ content: formatToolError(error), isError: true }`
  (same shape as the `runTool` catch) so missing files return upstream `isError`
  instead of MCP `-32603`; `!stats.isFile()` rejects non-regular files
  (directories, FIFOs, sockets, size-0 specials) with a clean client-facing
  `isError` before reading. 5 MB guard semantics unchanged. Residual TOCTOU
  (size-check-then-read race) intentionally stays — see `pending-rev8/NOTES.md`.
- New md5s (BOTH hosts, identical): `cli.js 646524b6be6f3ee464a80e289e902621`,
  `server.js 10d1271d3c131a5b429041cb74b1c3d8`,
  `pi-tools.js 6213176af614a0e9c18f6e43ad020062`.
- Backups: `~/.devspace/baks/{cli,server,pi-tools}.js-hotfix-20260905` (pre-hotfix
  = `v1.0.8-r7` state) on BOTH hosts.
- Revert: reinstall the `v1.0.8-r7` tarball + restart (`sudo systemctl restart
  devspace` on netcup / `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user
  restart devspace-serve` on instance2).
- Evidence: `node --check` clean on all three files both hosts; throwaway local
  `serve` + OAuth + MCP round-trip `tools/list` shows bash `timeout`
  `{ "description": "Timeout in seconds. Defaults to 45, max 900.", "maximum": 900 }`;
  `readFileTool` probe (missing → ENOENT `isError`, dir → not-regular-file
  `isError`, small file → success); both services restarted post-mtime with
  healthz 200 and the new `bash timeout:` / `mcp sessions:` lines in the
  production journals.
- Rev-8 source: `/home/admin/.devspace/pending-rev8/` (`hotfix.diff` =
  `git diff v1.0.8-r7 -- dist/` over scratch clone `/tmp/ds-r8`, plus NOTES.md).
- Addendum 2026-09-05 (bash default timeout 45→300):
  `dist/pi-tools.js:9` `BASH_TOOL_DEFAULT_TIMEOUT_SECONDS` 45 → 300 (one const,
  single source; `dist/server.js` schema describe + kill message and
  `dist/cli.js` startup log import it so all user-facing strings update
  automatically). Rationale: operator-approved; clients omitting `timeout` were
  killed at 45s. `BASH_TOOL_MAX_TIMEOUT_SECONDS`, the 900 schema max, and the
  incumbent-grace logic untouched. Stale-`45` grep over both live trees: no
  user-facing `45` remains (only residual `server.js:47` code comment
  `defaults to 45s`, intentionally untouched). New md5s (BOTH hosts, identical):
  `pi-tools.js 23639cc13ed22becf0969e025d4ebbe1`,
  `server.js 10d1271d3c131a5b429041cb74b1c3d8` (unchanged),
  `cli.js 646524b6be6f3ee464a80e289e902621` (unchanged); host-vs-host diff
  clean. Backups: `~/.devspace/baks/pi-tools.js-hotfix2-20260905` (pre-change
  45s state) on BOTH hosts. Revert: same procedure —
  `cp ~/.devspace/baks/pi-tools.js-hotfix2-20260905` over live `dist/pi-tools.js`
  + restart (`sudo -n systemctl restart devspace` netcup /
  `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart devspace-serve`
  instance2), or reinstall the `v1.0.8-r7` tarball (reverts whole rev-8 hotfix).
  Evidence: `node --check` clean both hosts; throwaway `serve` + OAuth +
  `tools/list` shows `Timeout in seconds. Defaults to 300, max 900.` with
  `maximum: 900` on BOTH hosts; production journals show
  `bash timeout: default 300s, max 900s`; `pending-rev8/hotfix.diff` regenerated
  to include (a)/(b1)/(b2)+(c).
- Addendum 2026-09-05 (incumbent grace 30min→300s):
  `dist/server.js` eviction-block grace check at cap compared the oldest
  session's idle ms against the FULL idle TTL
  (`oldestIdleMs < MCP_SESSION_IDLE_TIMEOUT_MS`, 30 min). Defect (proven): under
  this client's zombie-session flood (~5-14 new sessions/min, never closed), at
  cap the oldest session is always 17-30 min idle → permanently "just inside"
  the grace → every new initialize got 503
  (`mcp_session_limit_rejected … currentSessions:256, idleSeconds:1794`,
  Retry-After 60) — total admission wedge (pre-fix journal lines show
  `idleSeconds:1791/1792` pinned under the 1800 s TTL). Fix: new module-scope
  const `MCP_SESSION_INCUMBENT_GRACE_MS = 5 * 60 * 1_000` (300 s
  RECENT-ACTIVITY window: never evict a session active within this window);
  the at-cap decision now compares against it — oldest idle > 300 s →
  evict-oldest + admit (same zombie class as the idle sweep), oldest active
  within 300 s → 503 Retry-After (live incumbent protected). Reject and evict
  paths unchanged; ONLY the threshold const is new. `dist/cli.js` startup
  literal → `incumbent grace 300s`; `dist/server.js` startup line renders the
  const. MAX 256, default 300, idle sweep 30 min, Retry-After 60 untouched.
  Evidence: scratch decision check over the real patched block (cap full):
  1794 s → EVICT/admit (was: reject), 200 s → REJECT 503, 299 s → REJECT 503,
  301 s → EVICT, below-cap → ADMIT (all PASS). New md5s (BOTH hosts, identical):
  `server.js c91cd3d5ce3488602a178d042a679693`,
  `cli.js a8f56a251c5cd4be867a11b27609cdc3`, `pi-tools.js` unchanged
  (`23639cc13ed22becf0969e025d4ebbe1`); host-vs-host diff clean. Backups:
  `~/.devspace/baks/{server,cli}.js-hotfix3-20260905` (pre-grace-fix state) on
  BOTH hosts. Restarts approved: netcup 21:18:04 CEST, instance2 19:17:47 UTC;
  both startup lines `mcp sessions: max 256, idle timeout 1800s, limit
  Retry-After 60s, incumbent grace 300s`; service starts newer than file
  mtimes; healthz 200 (netcup local + https://nety3.duckdns.org/healthz,
  instance2 local). Post-restart 10-min window (netcup 21:18:04→21:28:38 CEST,
  instance2 19:17:47→19:28:38 CEST): `mcp_session_limit_rejected` = 0 on BOTH
  hosts; `mcp_session_created` = 41 (netcup) / 1 (instance2) — new sessions
  admitted again. Revert: `cp ~/.devspace/baks/server.js-hotfix3-20260905
  ~/.devspace/baks/cli.js-hotfix3-20260905` over live `dist/` + restart (same
  per-host restart commands), or reinstall the `v1.0.8-r7` tarball (reverts the
  whole rev-8 hotfix). `pending-rev8/hotfix.diff` regenerated to include
  (a)/(b1)/(b2)+(c)+(d); `pending-rev8/NOTES.md` has the full Change (d)
  section.
- Addendum 2026-09-05 (MCP session cap 256→2048):
  `dist/server.js` module-scope const `MAX_MCP_SESSIONS` 256 → 2048 (one const;
  at-cap comparisons, 503 body `limit`, and the `isMainModule` startup line all
  render it). `dist/cli.js` startup literal → `max 2048` (pointer comment
  mirrored). Idle timeout 30 min, incumbent grace 300 s, Retry-After 60, bash
  timeout 300/900 untouched. Rationale: operator-approved capacity headroom;
  after the (d) grace fix the cap is a backstop again, not a gate; ~440
  steady-state sessions at current churn; ~50-100 KB/session → ≤200 MB worst
  case. New md5s (BOTH hosts, identical):
  `server.js f0f4d87d1402a0b9fe8121b7c72132a4`,
  `cli.js f7863125a1ea7c4dfad4b59fe133f12c`, `pi-tools.js` unchanged
  (`23639cc13ed22becf0969e025d4ebbe1`); host-vs-host diff clean. Backups:
  `~/.devspace/baks/{server,cli}.js-hotfix4-20260905` (pre-cap state = the (d)
  md5s) on BOTH hosts. Restarts approved: netcup 21:32:47 CEST, instance2
  19:32:50 UTC; both startup lines `mcp sessions: max 2048, idle timeout 1800s,
  limit Retry-After 60s, incumbent grace 300s`; service starts newer than file
  mtimes; healthz 200 (netcup local + https://nety3.duckdns.org/healthz,
  instance2 local). Post-restart 10-min window (netcup 21:32:47→21:43:14 CEST,
  instance2 19:32:50→19:43:14 UTC): `mcp_session_limit_rejected` = 0 on BOTH
  hosts; `mcp_session_created` = 128 (netcup) / 17 (instance2); node RSS
  169176 KB (netcup) / 160760 KB (instance2). Revert:
  `cp ~/.devspace/baks/server.js-hotfix4-20260905
  ~/.devspace/baks/cli.js-hotfix4-20260905` over live `dist/` + restart (same
  per-host restart commands), or reinstall the `v1.0.8-r7` tarball (reverts the
  whole rev-8 hotfix). `pending-rev8/hotfix.diff` regenerated to include
  (a)/(b1)/(b2)+(c)+(d)+(e); `pending-rev8/NOTES.md` has the full Change (e)
  section.
- Addendum 2026-09-05 (MCP session cap 2048→8192;
  supersedes the 256→2048 addendum above — 2048 was live ~15 min
  (netcup 21:32:47→21:47:59 CEST) and was raised the same day):
  `dist/server.js` module-scope const `MAX_MCP_SESSIONS` 2048 → 8192 (one const;
  at-cap comparisons, 503 body `limit`, and the `isMainModule` startup line all
  render it). `dist/cli.js` startup literal → `max 8192` (pointer comment
  mirrored: `MAX_MCP_SESSIONS=8192`). Idle timeout 30 min, incumbent grace
  300 s, Retry-After 60, bash timeout 300/900 untouched. Rationale:
  operator-approved capacity headroom; after the (d) grace fix the cap is a
  backstop, and the 30-min idle sweep still bounds the real count to churn ×
  30 min; ~50-100 KB/session → 0.4-0.8 GB anon worst case at 8192, explicitly
  accepted by the operator. New md5s (BOTH hosts, identical):
  `server.js 0659389c16da8d7445b5f5a78cdde4b7`,
  `cli.js 9f9546c1436a25f8fc0be523002287b5`, `pi-tools.js` unchanged
  (`23639cc13ed22becf0969e025d4ebbe1`); host-vs-host diff clean. Backups:
  `~/.devspace/baks/{server,cli}.js-hotfix5-20260905` (pre-8192 state = the
  2048 md5s f0f4d87d…/f7863125… above) on BOTH hosts; `*-hotfix4-20260905`
  still hold the pre-2048 (d) state. Restarts approved: netcup 21:47:59 CEST,
  instance2 19:47:56 UTC; both startup lines `mcp sessions: max 8192, idle
  timeout 1800s, limit Retry-After 60s, incumbent grace 300s` + `bash timeout:
  default 300s, max 900s`; service starts newer than file mtimes (netcup
  21:47:59 > 21:47:20-22; instance2 19:47:56 > 19:47:33) and disk grep
  `MAX_MCP_SESSIONS = 8192` = 1 on both; PIDs unchanged through the window;
  healthz 200 (netcup local + https://nety3.duckdns.org/healthz, instance2
  local). Post-restart 10-min window (netcup 21:47:59→21:58:28 CEST, instance2
  19:47:56→19:58:28 UTC): `mcp_session_limit_rejected` = 0 on BOTH hosts;
  `mcp_session_created` = 240 (netcup) / 37 (instance2); node RSS 186432 KB
  (netcup) / 159700 KB (instance2). `pending-rev8/hotfix.diff` regenerated
  (supersedes the 2048 hunks — diff shows 8192, no residual 2048 additions;
  reproducibility: clean `v1.0.8-r7` worktree + `git apply` → byte-identical
  to live on `server.js`/`cli.js`/`pi-tools.js`/`roots.js`, `node --check`
  clean). `pending-rev8/NOTES.md` Change (e) updated to 8192. Revert (8192
  step only, back to 2048): `cp ~/.devspace/baks/server.js-hotfix5-20260905
  ~/.devspace/baks/cli.js-hotfix5-20260905` over live `dist/` + restart (same
  per-host restart commands). Full (e) revert (back to 256): use the
  `*-hotfix4-20260905` backups the same way. Reinstalling the `v1.0.8-r7`
  tarball reverts the whole rev-8 hotfix.

## 2026-09-11 (rev 9) — delete/move/repo_status file tools + RFC 9207 OAuth issuer

- Files: `dist/server.js`, `dist/pi-tools.js`, `dist/oauth-provider.js` (oauth = the 2026-09-10 live-only patch, now folded into the tag).
- What:
  - New MCP tool `delete` (`deletePathsTool`, pi-tools.js): `paths[]` validated via `resolveAllowedPath` (workspace-root scoped), files and symlinks only — refuses directories with a pointer to `bash rm -r`; unlink proceeds per-path after all validations, failures report how many were already deleted; outside-root paths return the normal `{isError:true}` shape (no thrown protocol error).
  - New MCP tool `move` (`movePathTool`): `from`/`to` both root-validated; refuses directories and any existing destination (including dangling symlinks, checked with non-throwing `lstat`); never overwrites.
  - New MCP tool `repo_status`: one read-only call returning JSON {branch, detached, head, upstream, ahead, behind, dirtyCount, dirtyPaths (cap 200 + truncation flag), branchLine, worktrees} via `git -C <workspace.root>` execFile (10s timeout, 1MB buffer). Replaces repeated shell `rev-parse`/`status`/`rev-list`/`worktree list` reconstruction.
  - `serverInstructions` (standard mode): mentions delete/move; shell contract now states git state changes (add/commit/merge/rebase/push) are expected shell work and that generated build artifacts (target/, caches, coverage, reports) are expected mutations — resolves the "shell must not modify files but git rm/deletion needs shell" contradiction reported by ChatGPT audit sessions.
  - OAuth (from the 2026-09-10 live patch, now official): `authorization_response_iss_parameter_supported`, `iss` callback parameter, `createOAuthMetadata`, bare PRM `OPTIONS` 204.
- Why: ChatGPT audit sessions could not delete the seven obsolete tombstone scripts (no delete primitive; bash contract forbade file mutation), reconstructed repo state via repeated shell git, and strict MCP clients needed RFC 9207. Minimal set that fixes real, observed friction; larger asks (git mutation tool family, image/HTML viewing, transactional multi-file patch, SQL/call-graph/subagent-health tools) deliberately deferred.
- Backups: pre-rev9 `pi-tools.js` is byte-exact at `git show 8319861:dist/pi-tools.js` (hash matches the r8-era manifest 008b8431). Pre-rev9 `server.js`/`oauth-provider.js` (r8+OAuth) were overwritten before backup (orchestrator sequencing error, 2026-09-11); preserved instead: `~/.devspace/baks/oauth-delta-r8-to-r9-20260910.patch` (pure oauth-provider.js delta) and `~/.devspace/baks/server.js-r8-to-r9-full-20260911.patch` (full mixed delta, rev-9 hunks are the three registration blocks + toolNames/instructions lines). instance2 retains a related but divergent OAuth variant (server fb620fd1, oauth 90ff3fd1) as reference only.
- Revert: reinstall `v1.0.8-r8` tarball, re-apply the OAuth patch per the 2026-09-10 entry (or restore server.js by reverse-applying the rev-9 hunks from the saved full delta), then regenerate `/etc/devspace-fork.sha256`.
- Applied by: orchestrator session 2026-09-11; validated with `node --check` (both files) and a live behavior matrix (delete one/multi/outside-root/dir-refusal-with-partial-state/symlink/nonexistent; move fresh/dangling-dest/dir/outside-root; no root escapes).

## 2026-09-11 (rev 10) — root confinement, git-config hardening, atomic move (astra review fix-forward)

- Files: `dist/roots.js`, `dist/pi-tools.js`, `dist/server.js`; new `behavior-tests/rev10-conformance.mjs` (17 checks, all runnable standalone).
- What, per adversarial review findings (blocker first):
  1. BLOCKER fixed in the owner (`roots.js`): `resolveAllowedPath` now canonicalizes through the closest existing ancestor (realpath) and re-asserts containment against lexical AND realpathed roots. Intermediate-symlink escapes (`wk/evil -> /etc` then `evil/passwd`) are refused for ALL tools; final-symlink leaf semantics preserved (read follows, delete/move lstat). Fixes the pre-existing read/write/edit hole too, not just rev 9's destructive verbs.
  2. repo_status: git runs with `--no-optional-locks -c core.fsmonitor=false -c core.fsmonitorDaemon=false` and `status --ignore-submodules=all` — repository-configured command execution (core.fsmonitor probe reproduced by the review) and optional-lock writes are disabled. Unborn HEAD handled (branch parsed from the status line, `unborn: true`); maxBuffer 1MB→8MB; worktrees capped at 50 with `worktreesError` instead of silent `[]`.
  3. move: no-overwrite is now atomic via `link(2)` (EEXIST refusal) + `unlink`, replacing the lstat-then-rename race; EXDEV falls back to checked rename. Linux link(2) does not dereference symlinks, so moved symlinks stay symlinks.
  4. delete: true preflight (dedupe + full existence/type validation before the first unlink); dir refusal now means nothing deleted; failures report deleted-vs-failed paths explicitly; duplicates reported and ignored.
  5. OAuth RFC 9207: `iss` is now added to authorization ERROR redirects too (res.redirect wrapper on /authorize), matching the metadata claim `authorization_response_iss_parameter_supported`.
  6. delete/move/repo_status no longer advertise the workspace widget (responses carry no card; the app rejected them with "No result card is available").
- Review artifacts: adversarial review by astra subagent (blocker + 2 major + 4 minor, all reproduced with proofs; claims a/b/c/f falsified, d/e partly true). All 6 code findings fixed in this rev; review's regression checks encoded in `behavior-tests/rev10-conformance.mjs` (17/17 pass).
- Backups: revert = reinstall `v1.0.8-r9` tag; `behavior-tests/` is additive.

## 2026-09-11 (rev 10 hotfix) — `_meta: {}` required by ext-apps registerAppTool

- `@modelcontextprotocol/ext-apps` `registerAppTool` dereferences `config._meta.ui` unconditionally; removing the widget descriptor for delete/move/repo_status (rev 10 widget finding) left `_meta` undefined and every session initialize 500'd (`mcp_request_error: Cannot read properties of undefined (reading 'ui')`), locking the ChatGPT connector out until restart with the fix. All three tools now carry `_meta: {}` (valid, advertises no widget). No-cards finding stands; widget stays unadvertised.

## 2026-09-11 (rev 10 hotfix 2) — iss wrapper broke res.redirect(302, url)

- The rev 10 iss middleware treated Express's two-argument form `res.redirect(302, url)` as `redirect(url)` with url=302, redirecting OAuth authorize clients to `/302?iss=...` (observed live as "Cannot GET /302?iss=..."). The wrapper now passes both forms through and appends `iss` to the URL argument only; unit-checked against five call shapes. Found by the operator hitting the authorize flow immediately after r10 shipped.

## 2026-09-18 (rev 12) — async Codex sandbox probe, safe fallback, and daemon visibility

- Files: `dist/local-agent-codex.js`, local-agent manager/pool/protocol/client/daemon files, `behavior-tests/sandbox-fallback.mjs`, and docs.
- What: replace the synchronous Linux `unshare -Ur true` check with a 5-second async tri-state probe cached for 60 seconds; reject indeterminate probes, permit only explicitly configured worktree fallback for denied probes, retain fallback metadata through errors and presentation, preserve it over daemon transport, and refuse read-only fallback. Add daemon status probe/build fields, structured busy-stop handling, and older-daemon stop compatibility.
- Validation: both standalone behavior suites pass (`sandbox fallback behavior: PASS`; rev10 `17 passed, 0 failed`); modified JavaScript files pass `node --check`.
- Revert: restore the pre-rev12 local-agent files/docs and remove the additive behavior coverage; no live installs/services were changed.
