#!/usr/bin/env bash
# Reapply ChatGPT strict-discovery GET aliases to @waishnav/devspace dist/server.js.
# Why: upstream mcpAuthMetadataRouter (SDK auth/router.js:96-99) serves only
#   /.well-known/oauth-protected-resource/mcp  (path-specific PRM, RFC 9728)
#   /.well-known/oauth-authorization-server     (bare AS, RFC 8414)
#   ChatGPT strict discovery also probes the complementary forms:
#   /.well-known/oauth-protected-resource      (bare PRM)
#   /.well-known/oauth-authorization-server/mcp (suffixed AS)
# What: inserts a pure-GET req.url rewrite BEFORE app.use(mcpAuthRouter(...))
#   in createServer() so the canonical SDK metadataHandler serves both forms
#   (identical body, content-type, CORS, query passthrough). No auth/token/
#   funnel/firewall changes. Idempotent: exits 0 with "already applied" if present.
# Upgrade-clobber risk: any `npm i -g @waishnav/devspace` overwrites dist/server.js.
#   After upgrade: run this script, then restart devspace serve gracefully.
# Usage: ~/.devspace/reapply-wellknown-aliases.sh [--check]
set -euo pipefail
TARGET="$HOME/.local/npm-global/lib/node_modules/@waishnav/devspace/dist/server.js"
MARKER="strict-discovery GET aliases"
if grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "already applied: $TARGET"
  exit 0
fi
if [[ "${1:-}" == "--check" ]]; then
  echo "MISSING: $TARGET does not contain $MARKER" >&2
  exit 1
fi
python3 - "$TARGET" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()
old = "        next();\n    });\n    app.use(mcpAuthRouter({"
new = """        next();
    });
    // Local patch (not upstream): ChatGPT strict-discovery GET aliases.
    // Bare PRM serves the identical doc as PRM/mcp; AS/mcp serves the
    // identical doc as bare AS. Pure GET req.url rewrite before the SDK auth
    // router, so canonical metadataHandler serves both (identical body,
    // content-type, CORS, query passthrough). No auth/token/funnel change.
    // Upgrade-clobber risk: npm upgrade overwrites dist/server.js; reapply
    // via ~/.devspace/reapply-wellknown-aliases.sh. See router.js:96-99
    // (mcpAuthMetadataRouter serves only path-specific PRM + bare AS).
    app.use((req, _res, next) => {
        if (req.method !== "GET")
            return next();
        const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        if (req.path === "/.well-known/oauth-protected-resource")
            req.url = "/.well-known/oauth-protected-resource/mcp" + q;
        else if (req.path === "/.well-known/oauth-authorization-server/mcp")
            req.url = "/.well-known/oauth-authorization-server" + q;
        next();
    });
    app.use(mcpAuthRouter({"""
assert src.count(old) == 1, f"anchor found {src.count(old)}x, expected 1x"
open(p, "w").write(src.replace(old, new))
print("patched: " + p)
PYEOF
node --check "$TARGET" && echo "syntax OK: $TARGET"
