# devspace (patched fork)

Maintained fork of [`@waishnav/devspace`](https://www.npmjs.com/package/@waishnav/devspace) 1.0.8 (MIT) with tracked runtime, filesystem, sandbox, and local-agent fixes. See [`PATCHES.md`](PATCHES.md) for revision details. The package `name` and `bin` entries are unchanged, so this fork is a drop-in replacement installed at the same paths.

## Install

```
npm i -g https://github.com/avion23/devspace/archive/refs/tags/v1.0.8-r17.tar.gz
```

## Command and read behavior

Commands return within 30 seconds. If `running` is true, poll `write_stdin` with
the returned `workspaceId` and `sessionId`; do not rerun the command. Bash's
`timeout` remains the process execution deadline across polls. Send `chars="\u0003"`
to cancel the owned process group; intentionally detached groups are outside
cancellation scope. `exec_command` and `write_stdin` are available in every tool mode.

Text reads stream only the requested range, with bounded output. A large file
can be read with `offset` and `limit`; the whole-file 5 MiB guard applies only
to images. In every tool mode, `read` also accepts the exact
`~/.claude/CLAUDE.md` file (or its absolute home path), read-only. This does not
allow its directory, siblings, or symlink redirection to another canonical path;
write tools remain workspace-confined. The file is not automatically loaded.
Workspace instructions name the execution and file-write tools.
This does not override ChatGPT's connector-side tool selection.

## Upgrade to a new tag

```
npm i -g https://github.com/avion23/devspace/archive/refs/tags/<new-tag>.tar.gz
```

## WARNING

Do NOT run any of these on a host running this fork — each overwrites the patched files with upstream registry code:

- `npm install -g @waishnav/devspace`
- `npm i -g @waishnav/devspace` (shorthand, same overwrite)
- `npm update -g`, `npm upgrade`, `npm update -g @waishnav/devspace` — PROVEN by dry-run to reinstall 1.0.8 from the registry even when the installed version is already 1.0.8 (`npm update -g --dry-run` shows `change @waishnav/devspace 1.0.8 => 1.0.8`); tag installs are NOT immune
- a future upstream 1.0.9 release would let any of the above replace this fork with registry 1.0.9 (registry-takeover)

Upgrades come ONLY from this repo's tags: `npm i -g https://github.com/avion23/devspace/archive/refs/tags/<new-tag>.tar.gz`.

## License

MIT. Original © the upstream @waishnav/devspace author; patches © 2026 avion23.
