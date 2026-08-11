#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor"
PKG_NAME="@earendil-works/pi-coding-agent"

cd "$REPO_ROOT"

CURRENT_URL="$(node -e 'const p=require("./package.json");process.stdout.write(p.dependencies["@earendil-works/pi-coding-agent"]||"")')"

if [[ "$CURRENT_URL" == file:* ]]; then
  echo "already vendored: $CURRENT_URL"
  exit 0
fi

if [[ "$CURRENT_URL" != http* ]]; then
  echo "unexpected dependency spec for $PKG_NAME: $CURRENT_URL" >&2
  exit 1
fi

TARBALL_NAME="$(basename "$CURRENT_URL")"
mkdir -p "$VENDOR_DIR"

echo "==> fetching $TARBALL_NAME"
if [[ ! -f "$VENDOR_DIR/$TARBALL_NAME" ]]; then
  curl -fL --retry 5 --retry-delay 3 -o "$VENDOR_DIR/$TARBALL_NAME" "$CURRENT_URL"
else
  echo "    already present, skipping download"
fi

echo "==> recording sha256 for the deviation log"
sha256sum "$VENDOR_DIR/$TARBALL_NAME" | tee "$VENDOR_DIR/$TARBALL_NAME.sha256"

echo "==> repointing package.json at vendor/$TARBALL_NAME"
node -e '
const fs = require("node:fs");
const name = process.argv[1];
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.dependencies["@earendil-works/pi-coding-agent"] = "file:vendor/" + name;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$TARBALL_NAME"

echo "==> regenerating package-lock.json"
npm install --package-lock-only

echo
echo "done. vendor/$TARBALL_NAME is now the dependency source."
echo "Record this in the fork deviation log: package.json + package-lock.json now differ from upstream."
echo "vendor/ is not excluded by .dockerignore, so the core image build context includes it."
