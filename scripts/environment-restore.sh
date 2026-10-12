#!/usr/bin/env bash
set -euo pipefail

: "$GITHUB_REPOSITORY"
: "$ENV_IMAGE"
CONTAINER_NAME="deepseek-environment"
error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

if docker pull "$ENV_IMAGE" 2>"$error_file"; then
  echo "Restored saved development filesystem from $ENV_IMAGE"
else
  # Never reset a known snapshot on network or credential failures.
  if grep -Eiq 'manifest unknown|name unknown|not found|404 Not Found' "$error_file"; then
    echo "No snapshot image exists; building first Ubuntu development environment."
    docker build -f Dockerfile.environment -t "$ENV_IMAGE" .
  else
    echo "::error::Cannot restore GHCR snapshot. Refusing fresh build to prevent data loss."
    cat "$error_file" >&2
    exit 1
  fi
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "::error::Refusing to overwrite an existing $CONTAINER_NAME container"
  exit 1
fi

docker run -d --name "$CONTAINER_NAME" --init --network host \
  --label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY" \
  "$ENV_IMAGE" sleep infinity >/dev/null

# No mounts: project, software installations and DSH_HOME will be snapshotted.
docker exec -e GITHUB_REPOSITORY="$GITHUB_REPOSITORY" "$CONTAINER_NAME" sh -euc '
  mkdir -p /workspace /state/dsh
  if [ ! -d /workspace/.git ]; then
    repo="https://github.com/$GITHUB_REPOSITORY.git"
    if git ls-remote --exit-code --heads "$repo" agent/workspace >/dev/null; then
      git clone --single-branch --branch agent/workspace "$repo" /workspace
    else
      git clone --single-branch --branch main "$repo" /workspace
      git -C /workspace switch -c agent/workspace
    fi
  fi
  echo "Workspace: /workspace; DeepSeek data: /state/dsh"
'
echo "Restored environment ready; no volumes or host directories are mounted."
