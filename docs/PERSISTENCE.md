# Persistent DeepSeek Harness container on Avrea

This project now runs DeepSeek Harness inside a restored Ubuntu 24.04 Docker
container. The Avrea job is still an **ephemeral VM**: the host kernel, host
packages, Docker daemon, other host containers, memory, and running processes
are **not** preserved between jobs.

## Where the durable state goes

- Image: ghcr.io/hnrie/myrepo-environment:current
- Image registry: GitHub Container Registry (GHCR).
- Source: Dockerfile.environment (Ubuntu 24.04 + Node 22 + developer tools).
- Container name: deepseek-environment.
- Workspace: /workspace (INCLUDING uncommitted changes and .git).
- DeepSeek home: /state/dsh (sessions, settings, history and local config).
- Global binaries /usr/local, root files /root, installed apt packages in
  /usr and /var/lib/dpkg, and other container directories are saved as well.

On startup the workflow signs into GHCR using its temporary GITHUB_TOKEN.
If a saved image exists it is pulled and run. If no image exists, it builds
the Ubuntu base and clones the agent/workspace branch once. If GHCR fails for
other reasons, startup aborts rather than resetting the working environment.

All user operations should happen INSIDE the DeepSeek Harness terminal or
agent running inside the container, **not** on the temporary Avrea host.

## Saving

- A checkpoint commits the full container filesystem and pushes the new image
  every 20 minutes while the session is running.
- A normal session ending performs an additional push.
- A workflow finalizer attempts a checkpoint after crashes where the Docker
  container is still running.
- The local container's writable layer includes uncommitted files. A git
  commit is NOT required for Docker persistence.
- The latest successfully published image is the restart point.

GHCR image pushes can fail due to size, network, permission or account limits.
A hard Avrea shutdown or workflow cancellation cannot guarantee a final push;
changes made after the last successful checkpoint can be lost. Check the logs
for "GHCR CHECKPOINT UPLOADED" before trusting a save. A running process and
its RAM are never restored; tools and applications start fresh, with files
intact.

Docker commit pauses the container briefly. Don't run long package
installations or database transactions while taking a critical snapshot.
Databases can require application-aware backups for guaranteed consistency.

## Set up and launch

1. Keep existing GitHub Actions secrets: CUSTOM_API_KEY,
   HARNESS_ACCESS_PASSWORD, TUNNL_SSH_PRIVATE_KEY.
2. Go to GitHub Actions > DeepSeek Harness Web Session > Run workflow on main.
3. The workflow logs into GHCR using its GITHUB_TOKEN (no registry PAT needed).
4. Watch the "Restore complete container filesystem from GHCR" step.
5. Open the same stable tunnl.gg URL and log in with username agent and your
   HARNESS_ACCESS_PASSWORD.
6. Work inside the GUI. System packages, Python/Node installs, chat history,
   project files and uncommitted edits become part of the next image.
7. Look for a successful GHCR upload before ending. Re-run to restore.

The container starts from the previous image even if its repository branch
differs from current main. The host controller scripts always load from main.
The container filesystem snapshot, rather than the public Git branch, is
the authority for your uncommitted work.

## Security: read this before storing anything private

GHCR new packages are PRIVATE by default, but verify
github.com/users/hnrie/packages/container/myrepo-environment/settings and
keep the package PRIVATE. Your underlying source repository is public.
A Docker snapshot can include chat messages, project files, credentials
entered into terminals, browser authentication signing keys and other data.
The workflow deliberately does NOT copy CUSTOM_API_KEY, the tunnel SSH key
or the Web password into container files or image environment variables.
However, arbitrary tools run inside the container and may themselves write
sensitive values to disk. Docker images are NOT encrypted client-side.

Only the **host** runs the SSH tunnel and password proxy, and it injects the
model key through docker exec when the agent starts. No secrets are baked into
Dockerfile or image Config.Env.

Never make the snapshot GHCR package public, even though the repo is public.
Avoid supplying provider keys to commands that save them to /workspace or
/root. Rotate the API key previously pasted into chat.

## Limits and costs

- GHCR currently provides free container-image storage/bandwidth, but this
  policy is subject to change, and image upload/pull size and timeout limits
  apply. Large image layers may fail to publish.
- Avrea runner minutes and account caps are independent. This architecture
  does not make 32-vCPU compute free indefinitely.
- Docker commit does not include bind mounts, volumes or host directories.
  This deployment intentionally uses NO volume or source bind mounts.
- It does not resume RAM, CPU state, the VM kernel, host changes, Docker
  daemon or any outside services. It is NOT a 760-GB full VM snapshot.
- It does not preserve data if the remote image push fails and the runner
  is destroyed before another successful snapshot.

Reference documentation:
- https://docs.docker.com/reference/cli/docker/container/commit/
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- https://docs.avrea.com/runners/

## Automated tests

The independent "Persistent Environment Snapshot Tests" workflow builds the
Ubuntu image, installs a synthetic program, writes uncommitted files in
/workspace, stores mock agent state in /state/dsh, snapshots the container,
deletes it, and restores from the snapshot. The tests also verify a temporary
injected API key did not enter the saved image's Config.Env.

This test does not guarantee GHCR connectivity or quotas: the first Avrea run
must still successfully push a real checkpoint to the registry.
