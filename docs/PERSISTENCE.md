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

## Saving — graceful Save & Stop or normal shutdown

**There are no periodic backups.** The runner saves its container filesystem
to GHCR when the session duration expires, the launcher exits normally, or
the finalizer is reached during GitHub's native Cancel workflow handling.

For an early shutdown **with the best chance of saving data**, go to
**Actions > Save and Stop DeepSeek Harness > Run workflow** on `main`.
The active launcher polls GitHub for this workflow-dispatch request roughly
every 15 seconds. It exits normally, allowing the existing finalizer to
perform a single `docker commit --pause=true` and `docker push`, then
remove the container after upload success. The request workflow itself does
not save the image: watch the **original DeepSeek Harness Web Session run**
for `BACKUP CONFIRMED: GHCR CHECKPOINT UPLOADED`.

The job-level condition is `if: ${{ !cancelled() }}`, allowing native
**Cancel workflow** to interrupt the long-running step rather than keep the
job running indefinitely. The finalizer retains step-level `if: always()`.
GitHub may still terminate the job before an image finishes uploading,
especially on large pushes or runner outages. Native cancellation is thus
**best effort only**; prefer Save and Stop.

**Emergency Force Cancel Stuck Run** is available by manual dispatch with
the numeric run ID. It bypasses the usual cancellation conditions and
**does not guarantee any backup**. Only use it if you accept losing every
container change since the previous successful checkpoint.

All these controls apply only to sessions launched from a version of the
workflow containing the control code. Editing the repository cannot
retroactively alter a running Actions job.

A successful backup is confirmed only by
`BACKUP CONFIRMED: GHCR CHECKPOINT UPLOADED` in the original run.
If that message is absent, only the previous successfully pushed
`:current` image should be relied on. With no periodic checkpoints,
losing a final upload can lose the **entire current session's** work.

### Cancellation tested against GHCR

A real GitHub REST `Cancel workflow` request was issued against a test run.
The protected cleanup step successfully saved the unsaved container filesystem
to the **actual GHCR registry** and restored it from a fresh pull:
https://github.com/hnrie/myrepo/actions/runs/38234473491

As expected, the run's final status was **Cancelled**, while the save step
itself succeeded. The test also exposed that GitHub can allow the current
foreground step to finish after cancellation. The `always()` finalizer
does not guarantee prompt shutdown of a busy step, unlimited time to push, or
protection against force-cancel. Follow the finalizer logs before restarting.

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
7. For an early safe exit, dispatch **Save and Stop DeepSeek Harness** on main. Wait for `BACKUP CONFIRMED` in the original run before restarting.

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
