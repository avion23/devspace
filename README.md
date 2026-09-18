# devspace (patched fork)

Maintained fork of [`@waishnav/devspace`](https://www.npmjs.com/package/@waishnav/devspace) 1.0.8 (MIT) with nine operational patches for ChatGPT-connector use: 5 MB read guard with size-bearing isError errors, `~` path expansion, 30-min MCP session idle sweep, 300 s default bash timeout with guidance text, explicit timeout max 900 s, ChatGPT strict-discovery GET aliases, 8192-session cap with evict-oldest-on-cap and a 300 s incumbent-activity grace, quiet eviction logging, and production startup logs. The patched files are `dist/server.js`, `dist/pi-tools.js`, and `dist/roots.js`; see [`PATCHES.md`](PATCHES.md) for per-patch details. The package `name` and `bin` entries are unchanged, so this fork is a drop-in replacement installed at the same paths.

## Install

```
npm i -g https://github.com/avion23/devspace/archive/refs/tags/v1.0.8-r11.tar.gz
```

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
