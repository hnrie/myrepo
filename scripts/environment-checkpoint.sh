#!/usr/bin/env bash
set -euo pipefail
: "$ENV_IMAGE"
CONTAINER_NAME="deepseek-environment"
if ! docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "::error::No running container to snapshot: $CONTAINER_NAME"
  exit 1
fi
echo "Flushing disk writes and saving complete container filesystem..."
docker exec "$CONTAINER_NAME" sync
docker commit --pause=true "$CONTAINER_NAME" "$ENV_IMAGE" >/dev/null
image_bytes="$(docker image inspect -f '{{.Size}}' "$ENV_IMAGE")"
echo "Image size (uncompressed): $image_bytes bytes"
docker push "$ENV_IMAGE"
echo "GHCR CHECKPOINT UPLOADED: $ENV_IMAGE"
