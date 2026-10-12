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

## Saving — only on stop or workflow cancellation

**There are no periodic backups or 20-minute checkpoints.** The runner saves
the entire container writable filesystem to GHCR only when:

- The selected session duration ends normally.
- The agent exits or the launcher fails after the container is restored.
- GitHub reaches the protected finalizer after **Cancel workflow** is clicked.

The workflow's harness job has `if: always()` and its final checkpoint step
also has `if: always()`. This is based on GitHub's documented cancellation
semantics: the finalizer remains eligible to run after a normal cancellation
request. It calls `scripts/environment-checkpoint.sh` once, uses
`docker commit --pause=true` and `docker push`, then removes the running
container after a successful upload. The full writable layer contains
uncommitted project edits, installed applications and DeepSeek chat data.

**This is a best-effort cleanup, not a guaranteed transactional backup.**
GitHub can forcibly stop jobs after cancellation, an Avrea VM can disappear,
or an image push can fail or exceed a service limit. The GitHub **Cancel
workflow** command still marks the run `cancelled`, and protected jobs may
continue their current action before running cleanup; it is not necessarily
immediate. A forced cancellation or host failure can leave changes unsaved.

You can confirm a successful backup only when the log shows
`BACKUP CONFIRMED: GHCR CHECKPOINT UPLOADED`. If you do not see that, the
previous successfully pushed `:current` image remains the available restore
point. With **no periodic checkpoints**, a failed final save can lose the
**entire session's** unsaved container changes.

A container image is not a VM snapshot. It never saves host applications,
RAM, running processes or mounted volumes. This container intentionally
uses no volumes or bind mounts to maximize captured filesystem state.

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
7. Wait for the finalizer to log `BACKUP CONFIRMED` after normal shutdown or cancellation. Re-run to restore.

The container starts from the previous image even if its repository branch
differs from current main. The host controller scripts always load from main.
The container filesystem snapshot, rather than the public Git branch, is
the authority for your uncommitted work.

## Security: read this before storing anything private

GHCR new packages are PRIVATE by default, but verify
your GitHub profile > Packages > myrepo-environment > Package settings and
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

These tests have additionally been run against GHCR itself. The `registry-smoke`
tag was pushed, removed locally, pulled back and verified successfully:
https://github.com/hnrie/myrepo/actions/runs/38232530099

The clean `:current` image was then initialized without touching any user
snapshot and successfully pulled by the production restore script, which
also cloned the agent workspace in a fresh container:
https://github.com/hnrie/myrepo/actions/runs/38233159198

The first Avrea job still has to complete its own live final snapshot upload.
Large files, external services, and Avrea limits can cause failures.
