#!/usr/bin/env bash
set -euo pipefail

IMAGE="dsh-persistence-test:$(date +%s)"
NAME="dsh-persistence-ci"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

echo "Building real Ubuntu 24.04 + Node 22 development image..."
docker build -f Dockerfile.environment -t "$IMAGE" .
docker run -d --name "$NAME" --network host "$IMAGE" sleep infinity >/dev/null
docker exec "$NAME" sh -euc '
  mkdir -p /workspace /state/dsh /root/projects
  printf "unsaved-code-edit\n" > /workspace/UNCOMMITTED.txt
  printf "private-chat-history\n" > /state/dsh/session.txt
  printf "installed-app\n" > /root/projects/config.txt
  printf "#!/bin/sh\necho my-installed-app-works\n" > /usr/local/bin/my-installed-app
  chmod 755 /usr/local/bin/my-installed-app
  node --version
  npm --version
  my-installed-app
'

# Execute a secret-bearing command without putting the secret into run Config.Env.
CUSTOM_API_KEY="never-commit-this-synthetic-test-key" \
  docker exec -e CUSTOM_API_KEY "$NAME" sh -c 'test -n "$CUSTOM_API_KEY"'

echo "Installing the actual npm latest DeepSeek Harness inside the durable container..."
docker exec "$NAME" npm install -g @deepseek-ai/dsh@latest
docker exec "$NAME" sh -ec 'dsh web --help > /tmp/dsh-cli-help.txt; grep -Fq -- "--port" /tmp/dsh-cli-help.txt'

docker commit --pause=true "$NAME" "$IMAGE-snapshot" >/dev/null
if docker image inspect "$IMAGE-snapshot" -f '{{json .Config.Env}}' | grep -Fq 'never-commit-this-synthetic-test-key'; then
  echo "::error::Secret leaked into Docker image configuration"
  exit 1
fi
docker rm -f "$NAME" >/dev/null

docker run -d --name "$NAME" --network host "$IMAGE-snapshot" sleep infinity >/dev/null
docker exec "$NAME" sh -euc '
  grep -Fxq "unsaved-code-edit" /workspace/UNCOMMITTED.txt
  grep -Fxq "private-chat-history" /state/dsh/session.txt
  grep -Fxq "installed-app" /root/projects/config.txt
  test "$(my-installed-app)" = "my-installed-app-works"
  test "$(node --version | cut -c1-3)" = "v22"
  dsh web --help > /tmp/dsh-cli-help-restored.txt
  grep -Fq -- "--no-open" /tmp/dsh-cli-help-restored.txt
'
echo "SNAPSHOT ROUNDTRIP PASSED: uncommitted project files, chat data, installed applications, real DeepSeek Harness CLI, /root and Node 22 restored."
