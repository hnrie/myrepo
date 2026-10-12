# DeepSeek Harness on Avrea + tunnl.gg

On-demand **DeepSeek Harness Web UI** on the Avrea GitHub Actions runner
`avrea-ubuntu-latest-32-vcpu` (32 vCPUs, 128 GB RAM).

- Free tunnl.gg **stable HTTPS address** (same domain across workflow runs when using the same SSH key; no tunnl.gg account).
- **Custom BYOK OpenAI Responses API** at `https://clever-moon-f3ca15b3.tunnl.gg/v1`.
- Model: `oc/muse-spark-1.3-contributor-free` with default reasoning effort **xhigh**.
- HTTP Basic password at the tunnel edge **plus** DeepSeek Harness's native signed-session authentication.
- The SSH tunnel reconnects while a workflow job is running. The compute **does not run forever**; sessions default to 330 minutes and the platform may impose limits or charge for usage.

## Initial setup

In **Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret | What to enter |
| --- | --- |
| `CUSTOM_API_KEY` | Your gateway's API key (rotate any API key posted into chats or public places before using it). |
| `HARNESS_ACCESS_PASSWORD` | A strong unique password of at least 16 characters for the web login. |
| `TUNNL_SSH_PRIVATE_KEY` | The full text of a reusable, **unencrypted** SSH private key used *only* for tunnl.gg stable addresses. |

Generate the tunnl.gg key **locally**, not on GitHub Actions, once:

```sh
ssh-keygen -t ed25519 -N "" -f ./tunnl_harness_key -C "tunnl-stable-harness"
```

Copy the contents of `tunnl_harness_key` into the GitHub Actions secret
`TUNNL_SSH_PRIVATE_KEY`. Keep the file private; never commit either key file.
It is separate from a GitHub authentication key. To use the **same hostname**
later, keep using the **same private key**. GitHub does not provide that key.

## Start

1. Go to **Actions → DeepSeek Harness Web Session → Run workflow**.
2. Select the duration and click **Run workflow**.
3. Open the running job's logs and find `Stable tunnl.gg URL:`.
4. Visit that HTTPS URL. The first browser visit may show tunnl.gg's warning page.
5. Enter username `agent` and the password from `HARNESS_ACCESS_PASSWORD`.
6. Wait for `Harness ready` in the logs, then refresh if necessary.

The native DeepSeek Harness login token is exchanged privately by the proxy and
**never printed in the public workflow logs**. The API key is read from the
secret at runtime, not included in configuration files.

## Working on code and persistence

The workflow checks out `agent/workspace`, creating the branch on the first
run. It periodically pushes **already committed** changes to that branch.
Commit your work before the job ends. **Uncommitted edits and browser session
history are lost** when the ephemeral runner is destroyed. The tunnel hostname
remains the same on future runs, but there will be downtime between runs.

The workflow file has **no** `timeout-minutes` setting. The launcher does
stop each session after the selected duration (10–330 minutes). Avrea and
GitHub can impose independent job limits and usage charges. There is no
zero-cost promise for uninterrupted hosting.

## Security

This is a publicly reachable reverse tunnel to a code-executing agent. Never
remove the password gate or publish API keys and private keys. Give the
`agent/workspace` branch only code you're comfortable placing in a public
repository. The script deliberately **does not auto-stage** generated files or
secret-bearing artifacts for commit.

The custom gateway must actually support OpenAI Responses API requests and
`reasoning_effort: xhigh` for the specified model. The model's declared
context size and output cap are guidance, **not live verification** of gateway
limits.

Official docs: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
[tunnl.gg stable URLs](https://tunnl.gg/stable-urls),
[tunnl.gg CI scripting](https://tunnl.gg/guides/ai-coding-agents).
