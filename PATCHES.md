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
- The image/text split reimplements the dependency's signature sniff (magic
  bytes for JPEG, PNG/APNG, GIF, WEBP, BMP) locally in `dist/pi-tools.js`
  instead of importing its non-exported `utils/mime.js` internal (the
  package's `exports` map only publishes `.` and `./rpc-entry`); a dependency
  bump that moves that internal path no longer breaks server start.

## File tools (`dist/pi-tools.js`, registered from `dist/server.js`)

- `delete` and `move` (`deletePathsTool`, `movePathTool`) have been removed
  from `dist/pi-tools.js`; use the `bash` tool (`rm`, `mv`) instead.
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

## MCP transport (`dist/server.js`)

- Stateless Streamable HTTP: each `POST /mcp` gets its own transport and MCP
  server, closed when the response ends. ChatGPT opens one MCP session per
  tool call, so durable state is keyed by `workspaceId` and process
  `sessionId` only. `GET`/`DELETE /mcp` return 405.
- Tool results carry the output text once, in `content`; `structuredContent`
  holds only small typed metadata.
- `http_response_incomplete` is logged (request id, path, status, duration;
  no bodies or credentials) when a response closes before completion.
- `trust proxy` defaults to one hop (`DEVSPACE_TRUST_PROXY=0` disables it).
- `serve` sets the process title `devspace-serve`, so host OOM policies that
  match `node` do not target the server.
- `serve` exits 1 when it cannot bind (`app.listen` error), so systemd
  `Restart=on-failure` restarts it.
- Shutdown (`dist/server-shutdown.js`) stops accepting connections, closes
  idle keep-alive sockets, lets in-flight requests finish (35 s deadline),
  and only then closes the OAuth and workspace stores.

## Git subprocesses (`dist/git.js`, `dist/git-worktrees.js`)

- Every git call has an explicit timeout (10 s default; `add` 15 s,
  `diff` 20 s, `worktree add` 15 s), `SIGTERM` on expiry and
  `GIT_TERMINAL_PROMPT=0`. A timeout fails with
  `git <args> timed out after <ms>ms`.
- Every git call also runs with `LC_ALL=C`, so `isNotAGitRepositoryError`'s
  match against git's English `"fatal: not a git repository"` wording stays
  correct regardless of the host's configured locale (e.g.
  `LC_ALL=de_DE.UTF-8`).

## Process output (`dist/process-sessions.js`)

- Default output budget is 3000 tokens per call (override `maxOutputTokens`,
  max 100000). Over budget, the model gets head + tail and a marker with the
  absolute path of the full log under `$DEVSPACE_STATE_DIR/process-logs`
  (default `~/.local/share/devspace/process-logs`), kept 15 minutes after
  the process exits.

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

## Defaults and CLI additions (`dist/config.js`, `dist/onboarding.js`, `dist/cli.js`)

- `DEVSPACE_WIDGETS` (and the matching `config.json` field) default to `off`;
  pristine upstream defaults to `full`. ChatGPT Apps iframe widgets are
  opt-in on this fork.
- Onboarding (`updateOnboardingSubagentsConfig`) defaults a fresh
  `subagents.sandboxFallback` to `"fail"`, matching the config schema's own
  default (`resolveSubagentsConfig`); pristine upstream has no
  `sandboxFallback` concept.
- `devspace agents daemon stop` takes an additional `--force` flag (not in
  pristine). Without it, the daemon refuses to stop while any turn is active;
  `--force` bypasses that guard.

## Nested instruction file discovery (`dist/workspaces.js`)

`findAvailableAgentsFiles` finds `AGENTS.md`/`CLAUDE.md` (and upper-case
variants) outside the initially loaded set, to surface as "available nested
instructions".

- `isInsideGitWorkTree` (`dist/git.js`, one `rev-parse --is-inside-work-tree`)
  selects the strategy. Only git's "not a git repository" error, or `false`
  (root inside `.git`), selects the walk; any other git failure (git
  missing, timeout, dubious ownership) propagates. `getGitEligibility`
  uses the same check.
- Inside a git work tree, discovery runs `git ls-files -co --exclude-standard`
  with a `:(glob)**/<name>` pathspec per exact `CONTEXT_FILE_NAMES` entry,
  scoped to `root`. This honors `.gitignore` and never recurses into a
  nested repo or worktree. Index entries that are not regular files on disk
  (deleted tracked files, symlinks to directories) are dropped. A root that
  is itself gitignored inside a parent repo discovers nothing. No directory
  walk runs in this case.
- Outside a git work tree, a directory walk (`walkWorkspace`) still runs,
  but now also skips any subdirectory that is itself a repository or
  worktree root (contains a `.git` entry; ENOENT means absent), on top of the
  existing `SKIPPED_CONTEXT_DIRS` name-based skips. A non-git root with large
  ignored trees (`node_modules`, build output, etc.) outside those skipped
  names is still walked in full; this is a partial mitigation, not a fix,
  for that case.
- Both the `.git` stat probe and the directory read (`opendir`) in that walk
  skip an entry they have no permission to inspect (`EACCES`/`EPERM`) instead
  of throwing, so a root like `/tmp` that contains directories owned by other
  users (e.g. `systemd-private-*`) does not abort discovery; any other error
  still propagates.

## Releases (`scripts/`)

- `dist/fork-revision.js` holds the revision reported by the daemon
  (`<package version>-<FORK_REVISION>`, e.g. `1.0.8-r20`).
- `scripts/release.sh rN` cuts a release from a clean `main` equal to
  `origin/main`: bumps the revision in `dist/fork-revision.js`, `README.md`,
  `PATCHES.md` and `docs/local-agent-daemon.md`, runs `npm ci`, `npm test`
  and `scripts/smoke.mjs` against a packed install, commits, tags
  `v<version>-rN`, pushes, and runs `scripts/deploy.sh`.
- `scripts/deploy.sh <tag>` installs a tag globally, restarts
  `devspace.service`, and checks local and public `/healthz` and `GET /mcp`
  (405). Revert: run it with the previous tag.
- `scripts/smoke.mjs [package-dir]` starts `serve` on a free port with a
  temporary HOME and checks OAuth, the stateless transport, the 30 s yield,
  bounded output with the full log kept, and the shutdown drain.
- CI (`.github/workflows/test.yml`) runs `npm test` and `scripts/smoke.mjs`
  on every push to `main` and on pull requests.
