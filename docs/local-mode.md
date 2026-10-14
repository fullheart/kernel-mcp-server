# Local mode spec

Run this MCP server against self-hosted [kernel-images](https://github.com/kernel/kernel-images) containers on the same host. No Kernel cloud account, no Clerk, no Redis. Cloud mode keeps working unchanged. `KERNEL_MODE=local` switches local mode on.

Goal: a coding agent (T3 Code, Claude Code, Cursor) tests web apps in a real browser through this server, the kernel.sh use case, fully offline and without the T3 Code built-in browser. Keep it straightforward. Every feature that needs explaining or behaves differently from the cloud costs more than it brings.

Status: spec, not implemented. Branch `feat/local-mode`.

## Why this needs more than a base URL

kernel-images runs one browser per container. Each container exposes:

- `:10001` REST API (process, fs, computer, playwright, repl, webmcp, recording, chromium flags). No auth.
- `:9222` CDP
- `:443` live view (noVNC when `ENABLE_WEBRTC=false`)

The Kernel SDK calls the same per-browser endpoints with a `/browsers/{id}` prefix, for example `/browsers/{id}/process/exec` maps to `/process/exec`. Everything above a single browser (create, list, delete, profiles, proxies, pools, vaults, auth connections, apps, projects) lives only in the cloud control plane. Local mode fakes the small part of that control plane we need.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope: everything kernel-images can back. No SSO or OAuth. Personal use first.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | The MCP server starts one kernel-images container per `browsers.create` through the Docker CLI. `delete` runs `docker rm -f`. Parallel sessions work like in the cloud.                                                                                                                                                                                                                                                                                                                                    |
| 3   | Transport stays HTTP `/mcp`. Clerk and Redis are bypassed in local mode.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Local mode sits next to cloud mode behind `KERNEL_MODE=local`. Keep the diff small and isolated so upstream rebases stay cheap. Do not delete cloud code.                                                                                                                                                                                                                                                                                                                                                  |
| 5   | MCP server and browsers run on this host via Docker, image `chromium-headful`. No Unikraft. A shared server for several developers may come later.                                                                                                                                                                                                                                                                                                                                                         |
| 6   | Adapter: a custom `fetch` passed to `new Kernel({ fetch })` in `src/lib/mcp/kernel-client.ts`. Tool code stays untouched so upstream descriptions and steering text survive.                                                                                                                                                                                                                                                                                                                               |
| 7   | Cloud-only toolsets are not registered in local mode (default toolset list, see below).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | As much as possible, nothing invented. Candidates in priority order: profiles, replays, browser_curl, extensions, proxies. Build a candidate only if its cloud behavior is pinned down by the `@onkernel/sdk` types plus kernel.sh docs and kernel-images can do the same thing. Otherwise drop it and list why in this file. Simplicity beats coverage. Always skip: browser_pools, apps, projects, api_keys, config_registry, auth_connections, credentials, credential_providers, vaults, search, docs. |
| 9   | Browser state lives in Docker labels on the container. Profiles, proxies and extensions live as files under `KERNEL_LOCAL_DATA_DIR`. No database.                                                                                                                                                                                                                                                                                                                                                          |
| 10  | Auth: `LOCAL_MCP_TOKENS=alice:tok1,bob:tok2`. The bearer token picks the owner. Containers carry an owner label. list, get and delete only see the caller's browsers. Real isolation (network, quotas per developer) waits for the shared server.                                                                                                                                                                                                                                                          |
| 11  | Live view via noVNC (`ENABLE_WEBRTC=false`), no UDP port ranges. Containers bind to `127.0.0.1` on random ports. URLs handed to the agent use `KERNEL_LOCAL_PUBLIC_HOST` (default `localhost`). Remote access goes through an SSH tunnel for now.                                                                                                                                                                                                                                                          |
| 12  | Honor `timeout_seconds`. A reaper removes expired containers on each request and every 60s. `KERNEL_LOCAL_MAX_BROWSERS` caps concurrency (default 5, each Chromium takes 1 to 2 GB RAM).                                                                                                                                                                                                                                                                                                                   |
| 13  | `make local-image` clones kernel-images into `.cache/kernel-images` and builds `chromium-headful` with the kernel-images API. `KERNEL_LOCAL_IMAGE` overrides the tag. No submodule.                                                                                                                                                                                                                                                                                                                        |
| 14  | Done means: unit tests for the fetch adapter, a green smoke script against the real server, this doc updated into a how-to, `.env.local-mode.example`.                                                                                                                                                                                                                                                                                                                                                     |
| 15  | Work on `feat/local-mode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Environment

```bash
KERNEL_MODE=local
LOCAL_MCP_TOKENS=me:change-me            # name:token pairs, comma separated
KERNEL_LOCAL_IMAGE=kernel-images/chromium-headful:local
KERNEL_LOCAL_DATA_DIR=./.local-data      # profiles/, proxies.json, extensions/
KERNEL_LOCAL_PUBLIC_HOST=localhost
KERNEL_LOCAL_MAX_BROWSERS=5
KERNEL_MCP_ENABLED_TOOLSETS=browsers,shell,computer,browser_files,playwright,repl,webmcp,replays,browser_curl,profiles,proxies,extensions
CLERK_SECRET_KEY=local-dummy             # only used as an HMAC secret
```

## Request flow in local mode

`src/app/[transport]/route.ts`, `handleAuthenticatedRequest` and `handleMcpRequestWithIdentity`:

1. Match the bearer token against `LOCAL_MCP_TOKENS`. Unknown token returns 401. No Clerk `verifyToken`.
2. Skip `resolveMcpConnectionContext` (`auth.context.retrieve`). Return a synthetic context: org `local`, project `local`, user = token owner.
3. Skip `resolveMcpEntitlements` and force all entitlements off, so vault and search tools stay hidden.
4. Skip the Redis MCP Apps marker store (treat as "no MCP Apps").
5. Pass the token owner to `createKernelClient` so the fetch adapter can scope by owner.

OAuth routes (`/authorize`, `/token`, `/register`, `/.well-known/*`, `/select-org`, `/oauth/*`) and `managed-auth-proxy` stay in the code but are unused. Check that the app boots in local mode without `REDIS_URL` and without real Clerk keys. If a module throws at import time, guard it with `KERNEL_MODE`.

## Fetch adapter

New module `src/lib/mcp/local/` (keep it to a few files). `createKernelClient` passes `fetch: localKernelFetch(owner)` and a dummy `baseURL` when `KERNEL_MODE=local`.

Routing:

| SDK request                               | Local handler                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /browsers`                          | Enforce max browsers, `docker run` (see below), wait for `:10001` health, return a cloud-shaped browser object                                                                                   |
| `GET /browsers`, `GET /browsers/{id}`     | `docker ps --filter label=kernel.local.owner=<owner>`, map labels to the cloud shape (`session_id`, `cdp_ws_url`, `browser_live_view_url`, viewport, `profile`, `timeout_seconds`, `created_at`) |
| `DELETE /browsers/{id}`                   | Optional profile save (see profiles), then `docker rm -f`                                                                                                                                        |
| `PATCH /browsers/{id}`                    | Map viewport to `/display`, flags to `/chromium/flags`. Return 400 for fields we can't map                                                                                                       |
| `/browsers/{id}/replays*`                 | Map to `/recording/start`, `/recording/stop`, `/recording/list`, `/recording/download`. Translate response shapes                                                                                |
| `POST /browsers/{id}/curl`                | Run `curl` through `/process/exec` inside the container, return the cloud response shape                                                                                                         |
| `/browsers/{id}/<anything else>`          | Strip `/browsers/{id}`, forward to `http://127.0.0.1:<api port>/<rest>` with method, headers, body and streaming intact                                                                          |
| `/profiles*`, `/proxies*`, `/extensions*` | Local handlers backed by `KERNEL_LOCAL_DATA_DIR`                                                                                                                                                 |
| `/auth/context`, `/org/entitlements`      | Synthetic responses (defense in depth, route.ts should already skip them)                                                                                                                        |
| anything else                             | 501 with `{"message": "not available in local mode"}`                                                                                                                                            |

Use the SDK's own response types from `@onkernel/sdk` for the cloud shapes, so `tsc` catches drift after an SDK bump.

### docker run

Follow `images/chromium-headful/run-docker.sh` in kernel-images:

- `--privileged --tmpfs /dev/shm:size=2g --memory 8192m`
- publish `127.0.0.1::10001`, `127.0.0.1::9222`, `127.0.0.1::443` (random host ports, read back with `docker port`)
- `-e ENABLE_WEBRTC=false -e WIDTH -e HEIGHT -e TZ`
- write a flags file `{"flags":[...]}` per container and bind-mount it to `/chromium/flags`. Start from the default flags in `run-docker.sh` (`--user-data-dir=/home/kernel/user-data ...`), add `--proxy-server` for proxies and the requested extensions
- labels: `kernel.local=1`, `kernel.local.id`, `kernel.local.owner`, `kernel.local.expires`, `kernel.local.profile`, `kernel.local.save_profile`, `kernel.local.proxy`
- `stealth`, `headless`, `kiosk_mode`: map what kernel-images supports, ignore the rest and say so in the returned object or a warning log

Call Docker with `execFile("docker", [...])` from `node:child_process`. No new dependency, no shell string building.

### Profiles

- Store at `$KERNEL_LOCAL_DATA_DIR/profiles/<name>/`
- Create with a profile: copy the profile dir to a per-container work dir and bind-mount that to `/home/kernel/user-data`. The original stays untouched until a save. Match the cloud `save_changes` semantics from the SDK types and docs
- `save_changes: true`: on delete, copy the user-data dir back into the profile dir. Chromium must be stopped or the copy is corrupt. Stop the container first, then copy, then remove
- `profiles.list/retrieve/create/delete/update` work on the directory

### Proxies

Lowest priority. Cloud proxy types other than `custom` (datacenter, ISP, residential, mobile) are Kernel-managed and cannot exist locally. If built, support only `custom`.

- `$KERNEL_LOCAL_DATA_DIR/proxies.json`, CRUD through the proxies API shape
- Applied at browser create as `--proxy-server`. Proxy auth via an extension or Chromium policy if kernel-images supports it. Otherwise only unauthenticated proxies, documented
- `proxies.check`: run `curl -x` from the host

### Extensions

- `$KERNEL_LOCAL_DATA_DIR/extensions/<name>/`
- list and delete work on the directory. At create time upload through `/chromium/upload-extensions-and-restart` or load via flags, whichever kernel-images supports cleanly

### Reaper

Runs at the start of each local request (cheap `docker ps` with label filter) and on a 60s `setInterval` started once per process. Removes containers whose `kernel.local.expires` is in the past. Saves the profile first when `save_profile` is set.

## Image build

`Makefile` target `local-image`:

```make
local-image:
	test -d .cache/kernel-images || git clone --depth 1 https://github.com/kernel/kernel-images .cache/kernel-images
	cd .cache/kernel-images/images/chromium-headful && IMAGE=$${KERNEL_LOCAL_IMAGE:-kernel-images/chromium-headful:local} ./build-docker.sh
```

Add `.cache/` and `.local-data/` to `.gitignore`. Check whether the image needs `WITH_KERNEL_IMAGES_API=true` at build or run time and wire it in.

## Tests and acceptance

1. `bun test` unit tests for the fetch adapter with a fake Docker runner (inject `execFile`): path rewrite, create, list scoped by owner, delete, max browsers, expiry, replays mapping, curl mapping, 501 fallback.
2. `bun test` for the local branch in `route.ts`: valid token, unknown token 401, no Clerk call, no Redis call.
3. `scripts/local-smoke.sh` against `bun run dev` with `KERNEL_MODE=local` and the built image, using curl JSON-RPC as in AGENTS.md:
   - `initialize`, `tools/list` contains only local toolsets
   - `manage_browsers` create with profile `smoke` and `save_changes`
   - `execute_playwright_code`: `goto https://example.com`, set a cookie or localStorage value
   - `computer_action` screenshot returns an image
   - `exec_command` `ls /` works
   - delete, create again with profile `smoke`, the value is still there
   - delete, `docker ps --filter label=kernel.local` is empty
4. `bun run format:check` and `bunx tsc --noEmit` pass. Existing tests stay green in cloud mode.
5. This file becomes a how-to (setup, env, MCP client config for Claude Code and Cursor, SSH tunnel for live view, limits).

## Review loop

After implementation, loop at most 4 rounds until no valid Critical or Major finding remains:

1. `coderabbit review --agent --base main` (free tier: 150 files, 3 reviews per hour; run `coderabbit auth status` first and chunk if needed)
2. Skill `mattpocock-skills:code-review` against `main`, axes Standards (AGENTS.md, local style) and Spec (this file). From round 2 on, use the last reviewed commit as the fixed point
3. Check each finding against the current code. Fix valid ones in parallel subagents, never two agents on one file. Reject invalid ones with a one-line reason
4. One commit per fix

List leftovers in the PR description.

## Out of scope

- Browser pools, apps, deployments, invocations, projects, API keys, config registry, managed auth, credentials, vaults, wallets, cards, web search, docs search
- WebRTC live view, reverse proxy, TLS
- Per-developer network or resource isolation
- Unikraft
- macOS, Docker Desktop, arm64. Linux x86_64 host only
