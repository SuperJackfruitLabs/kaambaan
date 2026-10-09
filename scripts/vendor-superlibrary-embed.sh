#!/usr/bin/env bash
# scripts/vendor-superlibrary-embed.sh
# Vendor @superlibrary/embed (superlibrary plan decision O3): build it in a superlibrary checkout,
# copy the module and its types here, and pin each by SHA-256 with the commit it came from.
# apps/web/src/lib/vendor/superlibrary-embed/vendored.test.ts fails if a file differs from its pin.
set -euo pipefail
src="${1:?usage: scripts/vendor-superlibrary-embed.sh <path to a superlibrary checkout at the commit to vendor>}"
dest="$(cd "$(dirname "$0")/.." && pwd)/apps/web/src/lib/vendor/superlibrary-embed"
git -C "$src" diff --quiet HEAD -- packages/embed packages/contract || { echo "the superlibrary checkout has uncommitted changes in packages/embed or packages/contract" >&2; exit 1; }
commit="$(git -C "$src" rev-parse HEAD)"
pnpm -C "$src" install --frozen-lockfile >/dev/null
pnpm -C "$src" --filter @superlibrary/embed bundle
mkdir -p "$dest"
cp "$src/packages/embed/dist/superlibrary-embed.js" "$src/packages/embed/dist/superlibrary-embed.d.ts" "$dest/"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
cat > "$dest/VENDORED.json" <<JSON
{
  "source": "SuperJackfruitLabs/superlibrary packages/embed",
  "commit": "$commit",
  "files": {
    "superlibrary-embed.d.ts": "$(sha "$dest/superlibrary-embed.d.ts")",
    "superlibrary-embed.js": "$(sha "$dest/superlibrary-embed.js")"
  }
}
JSON
echo "vendored @superlibrary/embed at $commit"
