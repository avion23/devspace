#!/usr/bin/env bash
# Cut, verify, push, and deploy a fork release from a clean, current main.
# Usage: scripts/release.sh rN
set -euo pipefail

rev=${1:?usage: scripts/release.sh rN}
[[ "$rev" =~ ^r[0-9]+$ ]] || { echo "revision must look like r20" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
version=$(node -p 'require("./package.json").version')
tag="v$version-$rev"

[[ "$(git branch --show-current)" == main ]] || { echo "release from main only" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "working tree is not clean" >&2; exit 1; }
git fetch -q origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "main differs from origin/main" >&2; exit 1; }
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null && { echo "tag $tag already exists" >&2; exit 1; }

old=$(sed -n 's/^export const FORK_REVISION = "\(.*\)";$/\1/p' src/fork-revision.ts)
sed -i "s/\"$old\"/\"$rev\"/" src/fork-revision.ts
sed -i "s/$version-$old/$version-$rev/g" README.md PATCHES.md docs/local-agent-daemon.md

npm ci --no-audit --no-fund
npm test

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tarball=$(npm pack --silent --pack-destination "$work" | tail -1)
npm i -g --no-audit --no-fund --prefix "$work/prefix" "$work/$tarball"
node scripts/smoke.mjs "$work/prefix/lib/node_modules/@waishnav/devspace"

git commit -qam "Release $rev"
git tag "$tag"
git push -q origin main "$tag"
scripts/deploy.sh "$tag"
