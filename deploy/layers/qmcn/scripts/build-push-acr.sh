#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
LAYER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${ACR_REGISTRY:?set ACR_REGISTRY, e.g. registry.cn-hangzhou.aliyuncs.com/your-namespace}"
QM_IMAGE_TAG="${QM_IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
PLATFORM="${PLATFORM:-linux/amd64}"
SERVICES="${SERVICES:-core web-ui admin portal auth}"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

cd "$REPO_ROOT"

if [[ "$(node -e 'const p=require("./package.json");process.stdout.write(p.dependencies["@earendil-works/pi-coding-agent"]||"")')" == http* ]]; then
  echo "refusing to build: @earendil-works/pi-coding-agent still points at a GitHub URL." >&2
  echo "run scripts/vendor-pi.sh first, or the core image build will fail on npm ci." >&2
  exit 1
fi

echo "==> tag: $QM_IMAGE_TAG   platform: $PLATFORM   registry: $ACR_REGISTRY"

for service in $SERVICES; do
  ref="$ACR_REGISTRY/qm-$service:$QM_IMAGE_TAG"
  echo
  echo "==> building $ref"
  docker build --platform "$PLATFORM" \
    -f "deploy/$service/Dockerfile" \
    --build-arg "GIT_SHA=$GIT_SHA" \
    -t "$ref" .
  echo "==> pushing $ref"
  docker push "$ref"
  docker inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null || true
done

echo
echo "==> building the agent sandbox image (local backend)"
LOCAL_SANDBOX_IMAGE="${LOCAL_SANDBOX_IMAGE:-qm-sandbox-local:latest}"
LOCAL_SANDBOX_IMAGE="$LOCAL_SANDBOX_IMAGE" bash scripts/local-sandbox-build.sh

echo
echo "done."
echo "Write these into $LAYER_DIR/.env:"
echo "  ACR_REGISTRY=$ACR_REGISTRY"
echo "  QM_IMAGE_TAG=$QM_IMAGE_TAG"
echo "  LOCAL_SANDBOX_IMAGE=$LOCAL_SANDBOX_IMAGE"
