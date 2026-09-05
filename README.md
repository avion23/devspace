# devspace (patched fork)

Maintained fork of [`@waishnav/devspace`](https://www.npmjs.com/package/@waishnav/devspace) 1.0.8 (MIT) with six operational patches for ChatGPT-connector use: 5 MB read guard with size-bearing errors, `~` path expansion, 30-min MCP session idle sweep, 45 s default bash timeout with guidance text, explicit timeout max 900 s, ChatGPT strict-discovery GET aliases, 256-session cap with evict-oldest-on-cap. The patched files are `dist/server.js`, `dist/pi-tools.js`, and `dist/roots.js`; see [`PATCHES.md`](PATCHES.md) for per-patch details. The package `name` and `bin` entries are unchanged, so this fork is a drop-in replacement installed at the same paths.

## Install

```
npm i -g https://github.com/avion23/devspace/archive/refs/tags/v1.0.8-r6.tar.gz
```

## Upgrade to a new tag

```
npm i -g https://github.com/avion23/devspace/archive/refs/tags/<new-tag>.tar.gz
```

## WARNING

Never run `npm install -g @waishnav/devspace` on a host running this fork — it overwrites the patched files. Upgrades come ONLY from this repo's tags.

## License

MIT. Original © the upstream @waishnav/devspace author; patches © 2026 avion23.
