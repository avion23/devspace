#!/usr/bin/env bash
# Install a release tag on this host and restart the service. Also the revert
# path: run it with the previous tag.
# Usage: scripts/deploy.sh v1.0.8-rN
set -euo pipefail

tag=${1:?usage: scripts/deploy.sh <tag>}
repo_url=https://github.com/avion23/devspace
unit=devspace.service

git ls-remote --exit-code --tags "$repo_url" "refs/tags/$tag" >/dev/null || { echo "tag $tag not on $repo_url" >&2; exit 1; }

npm i -g --no-audit --no-fund "$repo_url/archive/refs/tags/$tag.tar.gz"
pkg="$(npm root -g)/@waishnav/devspace"
installed=$(sed -n 's/^export const FORK_REVISION = "\(.*\)";$/\1/p' "$pkg/dist/fork-revision.js")
[[ "$tag" == *"-$installed" ]] || { echo "installed revision $installed does not match $tag" >&2; exit 1; }

since=$(date '+%F %T')
sudo systemctl restart "$unit"
for _ in $(seq 1 50); do
    port=$(journalctl -u "$unit" --since "$since" -o cat | sed -n 's|^devspace listening on http://[^:]*:\([0-9]*\)/mcp$|\1|p' | tail -1)
    [[ -n "$port" ]] && break
    sleep 0.2
done
[[ -n "${port:-}" ]] || { echo "$unit did not log listening" >&2; journalctl -u "$unit" --since "$since" -o cat | tail -20 >&2; exit 1; }
public=$(journalctl -u "$unit" --since "$since" -o cat | sed -n 's|^public base url: ||p' | tail -1)

check() {
    local want=$1 url=$2 got
    got=$(curl -s -o /dev/null -w '%{http_code}' "$url")
    [[ "$got" == "$want" ]] || { echo "FAIL $url returned $got, expected $want" >&2; exit 1; }
    echo "PASS $url $got"
}
check 200 "http://127.0.0.1:$port/healthz"
check 200 "$public/healthz"
check 405 "$public/mcp"
echo "deployed $tag ($(ps -o comm= -p "$(systemctl show -p MainPID --value "$unit")"))"
