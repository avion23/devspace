# Fork deltas vs upstream `@waishnav/devspace` 1.0.8

This file describes what this fork currently changes, not how each change was
applied over time. Revision-by-revision history (dates, md5s, per-host deploy
steps, `.bak` files) lives in `git log`; this repo's `dist/` is the hand-patched
source of truth, so a prior revision is `git show <rev-tag-or-sha>:dist/<file>`,
not a backup file on disk.

## Path and filesystem confinement (`dist/roots.js`, `dist/pi-tools.js`)

- `resolveAllowedPath` expands `~` for every file tool, canonicalizes through
  the closest existing ancestor, and re-checks containment against both the
  lexical and realpathed root. This blocks intermediate-symlink escapes
  (`workspace/evil -> /etc`) for every tool, not only destructive ones.
- Read, write, and edit follow the final path segment's symlink only after
  containment is validated (`followFinal`); `delete` and `move` use leaf
  semantics (`lstat`/`link(2)`) and operate on the link itself.
- `read` additionally permits the exact file `~/.claude/CLAUDE.md` (operator's
  global Claude instructions) in every tool mode, with no directory, sibling,
  or symlink-redirected access, and no write access.
- `read` rejects files over 5 MiB only for the whole-file image path; text
  reads stream the requested `offset`/`limit` range or output cap instead of
  rejecting every large file.

## File tools (`dist/pi-tools.js`, registered from `dist/server.js`)

- `delete` (`deletePathsTool`): validates every path against the workspace
  root, refuses directories (points the caller at `bash rm -r`), refuses
  symlink targets it shouldn't follow, and reports exactly which paths were
  removed vs failed.
- `move` (`movePathTool`): root-validates `from`/`to`, refuses directories and
  any existing destination (including dangling symlinks), and is atomic via
  `link(2)` + `unlink` (no lstat-then-rename race); falls back to checked
  `rename` on `EXDEV`.
- `repo_status` (`dist/server.js`): one read-only call returning `{branch,
  detached, head, upstream, ahead, behind, dirtyCount, dirtyPaths, branchLine,
  worktrees}` via `git -C <root>`, replacing repeated shell `git`
  reconstruction. Runs with `--no-optional-locks` and fsmonitor disabled;
  handles an unborn `HEAD`; caps `worktrees` at 50.
- `bash` (`dist/server.js`, timeout constants from `dist/pi-tools.js`):
  default timeout 300s when the caller omits one, max 900s.
  `exec_command`/`write_stdin` are available in every tool mode for
  long-running work (return a `sessionId` to poll). Bash itself returns after
  a bounded initial yield and caps poll duration; both route through the
  shared process-session manager in `dist/process-sessions.js`.

## MCP session lifecycle (`dist/server.js`, `dist/mcp-sessions.js`)

- Sessions idle-sweep after 30 minutes (not the upstream 24h default).
- A session cap evicts the oldest idle session on admission instead of
  rejecting new connections with 503.
- In-flight session reservations prevent a concurrent admission burst from
  exceeding the cap or evicting a session reactivated mid-admission.
- `http_response_incomplete` is logged (request id, path, status, duration;
  no bodies or credentials) when a response closes before completion.

## OAuth (`dist/oauth-provider.js`, `dist/server.js`)

- RFC 9207: `iss` is included in both the metadata document and every
  `/authorize` redirect (success and error).
- ChatGPT's strict discovery also probes the bare `/.well-known/oauth-protected-resource`
  and the suffixed `/.well-known/oauth-authorization-server/mcp`, in addition
  to the RFC 9728/8414 paths the SDK serves natively. A GET-only `req.url`
  rewrite aliases both to the canonical SDK handler before
  `mcpAuthMetadataRouter` runs (no auth/token logic change). Reapply after an
  upstream-overwriting reinstall with `scripts/reapply-wellknown-aliases.sh`.

## Codex-only subagents (`dist/local-agent-*.js`)

Only the `codex` provider is supported; `LOCAL_AGENT_PROVIDERS` and the
profile schema reject any other value.

- Sandbox: an async, cached (60s) tri-state bwrap probe (`ok`/`denied`/
  `indeterminate`) replaces a synchronous check. Indeterminate results are
  rejected; an explicit per-provider `sandboxMode: "full-access"` opts a
  provider out of OS sandboxing entirely (default `auto` keeps it). Fallback
  exposure (`previouslyUnsandboxed`) is carried through errors, daemon
  transport, and later turns' observations.
- Model policy: `gpt-5.6-terra` and any `gpt-<version>` below `gpt-5.6` are
  refused at start/continue/persisted/profile load. Reasoning effort
  (including `max`) passes through to Codex unmodified.
- One Codex app-server runs per `(executable, CODEX_HOME)` and is shared
  across agents (`CodexLocalAgentDriver.runtimeKey` ignores agent identity).

## Current fork revision

`dist/fork-revision.js` holds the revision tag reported by the daemon
(`<package version>-<FORK_REVISION>`, e.g. `1.0.8-r17`) and installed by
`README.md`'s install command. Bump both together when cutting a release.
