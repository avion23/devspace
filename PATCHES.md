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
