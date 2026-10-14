# Local mode spec

Run this MCP server against self-hosted [kernel-images](https://github.com/kernel/kernel-images) containers on the same Linux host. No Kernel cloud account, no Clerk, no Redis. Cloud mode keeps working unchanged. `KERNEL_MODE=local` switches local mode on.

Goal: a coding agent (T3 Code, Claude Code, Cursor) tests web apps in a real browser through this server, the kernel.sh use case, fully offline and without the T3 Code built-in browser. Keep it straightforward. Every feature that needs explaining or behaves differently from the cloud costs more than it brings.

Status: spec v2, not implemented. Branch `feat/local-mode`. v2 replaces guesses from v1 with facts verified against kernel-images source, the `@onkernel/sdk` 0.121.0 source, the kernel.sh docs and probes against `onkernel/chromium-headful:c1128b7`. Evidence lives in `.cache/facts/` (gitignored, local only).

## How kernel-images works (verified)

- One browser per container. The published image `onkernel/chromium-headful:<sha7>` on Docker Hub already contains the API. No build step, no `WITH_KERNEL_IMAGES_API` (nothing reads it).
- `:10001` REST API, no auth. `:9222` CDP proxy. `/json/version` rewrites the WebSocket host from the request `Host` header, and any WebSocket path reaches the browser target.
- Ready about 3 to 4 s after `docker run`. `:10001` only starts listening once Chromium is up, so any 2xx from `GET /spec.yaml` means ready.
- Needs `--privileged` (Chromium sandbox) and `--tmpfs /dev/shm:size=2g`. Idle Chromium uses about 435 MiB.
- No noVNC. Without `ENABLE_WEBRTC=true` there is no live view at all. WebRTC needs neko plus UDP ports.
- `WIDTH`/`HEIGHT` env vars do nothing. The screen boots at 3840x2160. `POST /configure` (multipart) sets display, Chromium flags, policies, a profile archive, extensions and `start_url` with one Chromium restart (about 4 s). Display sizes must be modes listed in the image's xorg.conf, at a listed refresh rate.
- The Kernel SDK calls the same per-browser endpoints with a `/browsers/{id}` prefix. 45 of 52 per-browser paths match after stripping the prefix. The rest: replays (`/recording/*` with other shapes), `GET telemetry/events` (kernel-images only has POST), `curl` (no route), `extensions` (other path and multipart names).
- Inside the container `localhost` is the container. With `--add-host=host.docker.internal:host-gateway`, the browser reaches a host app at `http://host.docker.internal:<port>` if the app listens on `0.0.0.0`.
- Chromium is stopped with SIGKILL. A profile saved after a plain stop loses recent cookies and localStorage. CDP `Browser.close` first keeps them.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope: everything kernel-images can back with the same behavior as the cloud. No SSO or OAuth. Personal use first.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | The MCP server starts one container per `browsers.create` through the Docker CLI (`execFile`, no shell). `deleteByID` removes it. Parallel sessions work.                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Transport stays HTTP `/mcp`. Clerk and Redis are bypassed in local mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | Local mode sits next to cloud mode behind `KERNEL_MODE=local`. Keep the diff small and isolated so upstream rebases stay cheap. Do not delete cloud code.                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | Linux x86_64 host with Docker. MCP server and browsers on the same host. No Unikraft, no macOS.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | Adapter: a custom `fetch` passed to `new Kernel({ fetch })` in `src/lib/mcp/kernel-client.ts`. Tool code stays untouched, with one exception (decision 17).                                                                                                                                                                                                                                                                                                                                                                               |
| 7   | In local mode the default toolset list is the local one, so no `KERNEL_MCP_ENABLED_TOOLSETS` is needed. An explicit env value still wins.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | Built: browsers, shell, computer, browser_files, playwright, repl, webmcp, replays (start/stop/list), profiles. Dropped because kernel-images cannot match the cloud behavior: browser_curl (cloud curl runs in Chrome's network stack with the profile cookie jar), proxies (no proxy auth, no hot swap, host-side check lies), extensions (no upload tool, activation unverified). Always skipped: browser_pools, apps, projects, api_keys, config_registry, auth_connections, credentials, credential_providers, vaults, search, docs. |
| 9   | Create-time browser facts live in Docker labels. Mutable state (viewport after update, last activity) lives in an in-memory map. After an MCP restart the viewport falls back to the label and idle time starts fresh. Profiles live as files under `KERNEL_LOCAL_DATA_DIR`. No database.                                                                                                                                                                                                                                                 |
| 10  | Auth: `LOCAL_MCP_TOKENS=alice:tok1,bob:tok2`. The bearer token picks the owner. Containers carry an owner label. Every browser operation (list, get, update, delete, every forwarded `/browsers/{id}/*` call, replays) only sees the caller's browsers; others get 404. Profiles are shared by all tokens.                                                                                                                                                                                                                                |
| 11  | No live view. `browser_live_view_url` is omitted. Containers publish 10001 and 9222 on `127.0.0.1` with random host ports. `cdp_ws_url` is `ws://${KERNEL_LOCAL_PUBLIC_HOST}:<port>/` (default host `localhost`).                                                                                                                                                                                                                                                                                                                         |
| 12  | `timeout_seconds` is an idle timeout, as in the cloud (default 60, min 10, max 259200). Activity = any adapter call for that browser. A reaper removes idle containers at the start of each local request and every 60 s (one interval per process, guarded on `globalThis` for HMR). `KERNEL_LOCAL_MAX_BROWSERS` (default 5) caps running containers across all owners. Direct CDP traffic to `cdp_ws_url` bypasses the adapter and does not count.                                                                                      |
| 13  | Image: `KERNEL_LOCAL_IMAGE`, default `onkernel/chromium-headful:c1128b7`. The user pulls it once (`docker pull`). `docker run --pull never` fails fast instead of pulling 2.7 GB inside an SDK request. No Makefile, no source build.                                                                                                                                                                                                                                                                                                     |
| 14  | Done means: unit tests for the adapter, route tests for local auth, a green smoke script against a real server and real containers, this doc rewritten into a how-to, `.env.local-mode.example`.                                                                                                                                                                                                                                                                                                                                          |
| 15  | Work on `feat/local-mode`, draft PR against `main` of `fullheart/kernel-mcp-server`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 16  | The browser reaches host apps through `host.docker.internal` (`--add-host=host.docker.internal:host-gateway` on every container). Documented, including the `0.0.0.0` bind requirement.                                                                                                                                                                                                                                                                                                                                                   |
| 17  | `manage_profiles setup` normally tells the user to open the live view. In local mode, when `browser_live_view_url` is missing, it instead tells the agent to sign in with `execute_playwright_code` or `computer_action` and then delete the browser to save the profile. This is the only tool text change.                                                                                                                                                                                                                              |

## Environment

```bash
KERNEL_MODE=local
LOCAL_MCP_TOKENS=me:change-me            # name:token pairs, comma separated. Tokens must not look like a JWT (no two dots)
KERNEL_LOCAL_IMAGE=onkernel/chromium-headful:c1128b7
KERNEL_LOCAL_DATA_DIR=./.local-data      # profiles/
KERNEL_LOCAL_PUBLIC_HOST=localhost
KERNEL_LOCAL_MAX_BROWSERS=5
```

`KERNEL_PROJECT` must stay unset (or `local`). Anything that cloud mode needs at import time (`CLERK_SECRET_KEY` for HMAC, Clerk publishable key in `src/proxy.ts`) must either get a local fallback or be skipped in local mode, so the env block above is all a user sets. Verify with `next dev` and `next start`.

## Request flow in local mode

1. `src/proxy.ts`: skip `clerkMiddleware` in local mode. It throws without a publishable key under `next start` and in CI.
2. `src/app/[transport]/route.ts`: in local mode never call Clerk `verifyToken`. Treat every bearer as a local token. Use a local HMAC secret fallback where `CLERK_SECRET_KEY` is required (transport session signing, MCP Apps auth subject). Use a no-op MCP Apps marker store (`src/lib/mcp-apps-request.ts` already takes a store parameter).
3. The fetch adapter answers `GET /auth/context` with a schema-valid context (`src/lib/mcp/auth-context.ts:10-27`) where org, project and user are `local` / the token owner, so `resolveMcpConnectionContext` yields `{kind: "project", projectId: "local"}`. Unknown token: 401 `{"message": "invalid local token"}`, which route.ts turns into 401 `invalid_token`.
4. `GET /org/entitlements` returns `{"features": {}}`, which hides vault and search tools.
5. OAuth routes stay in the code but are unused.

## Fetch adapter

Module `src/lib/mcp/local/`, a few files. `createKernelClient` passes `fetch: localKernelFetch` and baseURL `http://kernel.local` when `KERNEL_MODE=local`. The owner comes from the `Authorization: Bearer` header of each request, so no call site changes.

SDK contract (verified in SDK source):

- Synthetic JSON responses must send `content-type: application/json`, or the SDK returns a string.
- Never put `base_url` or a `jwt` into a browser object. The SDK would route per-browser calls to that URL and bypass the adapter.
- Every adapter-generated error sets `x-should-retry: false`. The SDK retries any 5xx twice otherwise.
- List endpoints return a bare JSON array with no pagination headers (one page).
- Decode the path id with `decodeURIComponent`.
- Honor `init.signal`: if a create is aborted after `docker run`, remove the container.

Routing:

| SDK request                           | Local handler                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /browsers`                      | In-process lock, enforce max browsers, reject unsupported params, `docker run`, wait for ready, `POST /configure`, return the browser object                        |
| `GET /browsers`                       | `docker ps` with `label=kernel.local.owner=<owner>`, map to browser objects                                                                                         |
| `GET /browsers/{id}`                  | Same, by id or name                                                                                                                                                 |
| `PATCH /browsers/{id}`                | `viewport` via `PATCH /display` with the resolved refresh rate. Any other field: 400                                                                                |
| `DELETE /browsers/{id}`               | Save profile if `save_changes`, then `docker rm -f`                                                                                                                 |
| `GET /browsers/{id}/telemetry/events` | `[]`                                                                                                                                                                |
| `/browsers/{id}/replays*`             | Map to `/recording/*` (below)                                                                                                                                       |
| `/browsers/{id}/<rest>`               | Owner check, touch activity, strip prefix, forward to `http://127.0.0.1:<api port>/<rest>` with method, query, headers and body. Stream the response back unchanged |
| `/profiles*`                          | Local profile store (below)                                                                                                                                         |
| `/auth/context`, `/org/entitlements`  | Synthetic, see request flow                                                                                                                                         |
| anything else                         | 501 `{"message": "<method> <path> is not available in local mode"}`                                                                                                 |

### docker run

```
docker run -d --pull never --privileged --tmpfs /dev/shm:size=2g --memory 8192m
  --add-host=host.docker.internal:host-gateway
  -p 127.0.0.1::10001 -p 127.0.0.1::9222
  -e ENABLE_WEBRTC=false -e TZ=<host TZ>
  --label kernel.local=1 --label kernel.local.id=<id> --label kernel.local.owner=<owner>
  --label kernel.local.name=<name> --label kernel.local.timeout=<seconds>
  --label kernel.local.created=<iso> --label kernel.local.viewport=<WxH@R> --label kernel.local.kiosk=<bool>
  --label kernel.local.profile=<profile id> --label kernel.local.save_profile=<bool>
  <KERNEL_LOCAL_IMAGE>
```

Read the host ports back with `docker port`. After ready, `POST /configure` with:

- `display`: the requested viewport, else the cloud default 1920x1080@25. When `refresh_rate` is omitted, use the highest rate xorg.conf lists for that size. Sizes not listed: 400 with the list of supported sizes. Read the mode list from the image's xorg.conf via `/fs/read_file` (path from the facts), cached per image.
- `chromium_flags`: `--kiosk` when `kiosk_mode`.
- `profile_archive`: the stored archive when a profile with data is requested.
- `start_url` when given.

If anything after `docker run` fails, remove the container and return the error.

### Browser object

Fields: `session_id`, `name`, `created_at`, `timeout_seconds`, `cdp_ws_url`, `viewport {width, height, refresh_rate}`, `kiosk_mode`, `headless: false`, `stealth: false`, `profile {id, name}` when used. Omit fields with no local meaning: `browser_live_view_url`, `base_url`, `webdriver_ws_url`, `region`, `memory`, `telemetry`, `pool`, `proxy_id`. Type it from the SDK types with `Omit`/`Pick` so `tsc` catches drift.

### Create params

- No local effect, accepted and reflected truthfully in the response: `stealth` (always false), `headless` (always false), `gpu`, `region`, `memory`, `telemetry`, `invocation_id`.
- Need cloud resources, 400 with a clear message: `proxy_id`, `extensions`, `vaults`, `pool`, `network`.
- `name` must be unique per owner (409).

### Replays

- `start`: generate a UUID, `POST /recording/start {"id": uuid}` (plus mapped options), return `{replay_id}`.
- `stop`: `POST /recording/stop {"id"}`, return 204.
- `list`: `GET /recording/list`, map `{id, started_at, finished_at}` to `{replay_id, started_at, finished_at}`.
- No `replay_view_url`. Recordings live in the container under `/recordings/<id>.mp4` and disappear with it. Document that `manage_browser_files` can read the file while the browser exists.

### Profiles

Store under `$KERNEL_LOCAL_DATA_DIR/profiles/`: `<id>.json` (`{id, name, created_at, updated_at, last_used_at}`) and `<id>.tar.zst` once saved. Ids are 24 random lowercase hex chars. Names are unique, matched case-insensitively (409 on duplicate). `create`, `list`, `retrieve` (id or name), `update` (rename), `delete` follow the SDK shapes.

- Load: `POST /configure` with `profile_archive` = the `.tar.zst` file. A profile without an archive starts empty.
- Save (delete or idle reap with `save_changes`): CDP `Browser.close` on `ws://127.0.0.1:<cdp port>/` (Node 24 global `WebSocket`), then `/process/exec` `supervisorctl -c /etc/supervisor/supervisord.conf stop chromium`, then `GET /fs/download_dir_zstd?path=/home/kernel/user-data`, written atomically (temp file plus rename). Then remove the container.
- Last writer wins, no locking, same as the cloud.

## Tests and acceptance

1. `bun test` unit tests for the adapter, with an injected Docker runner and a fake container API: prefix strip and pass-through, create (lock, max browsers, unsupported params, configure body, cleanup on failure and abort), list and get scoped by owner, delete with and without profile save, update viewport, idle reap, replays mapping, telemetry, profiles CRUD, auth context, entitlements, 501 fallback with `x-should-retry: false`. Follow the `new Kernel({ fetch })` pattern in `src/lib/mcp/vaults.test-fixtures.ts`.
2. `bun test` for the local branch in `route.ts` and `src/proxy.ts`: valid token, unknown token 401, no Clerk call, no Redis call.
3. `scripts/local-smoke.sh` against `next dev` with `KERNEL_MODE=local` and the real image, curl JSON-RPC as in AGENTS.md:
   - `initialize`, `tools/list` has exactly the local tools plus the always-on ones (`get_connection_context`, `get_more_tools`, `submit_feedback`)
   - `manage_profiles setup` or `manage_browsers` create with profile `smoke` and `save_changes`
   - `execute_playwright_code`: open a page served by a tiny host server on `0.0.0.0` via `host.docker.internal`, set a cookie and a localStorage value
   - `computer_action` screenshot returns an image
   - `exec_command` `ls /` works
   - delete, create again with profile `smoke`, both values are still there
   - delete, `docker ps --filter label=kernel.local` is empty
   - never more than 2 containers at once (host disk is tight)
4. `bunx tsc --noEmit` passes. Existing tests stay green. `bun run format:check` passes for changed files (`AGENTS.md` already fails on `main`, leave it).
5. This file becomes a how-to: setup, env, MCP client config for Claude Code, Codex and Cursor, reaching host apps, limits, what is not supported and why.

## Review loop

After implementation, loop at most 4 rounds until no valid Critical or Major finding remains:

1. `coderabbit review --agent --base main` (free tier: 150 files, 3 reviews per hour; run `coderabbit auth status` first and chunk if needed)
2. Skill `mattpocock-skills:code-review` against `main`, axes Standards (AGENTS.md, local style) and Spec (this file). From round 2 on, use the last reviewed commit as the fixed point
3. Check each finding against the current code. Fix valid ones in parallel subagents, never two agents on one file. Reject invalid ones with a one-line reason
4. One commit per fix

List leftovers in the PR description and post a summary of the review rounds as a PR comment.

## Out of scope

- Live view (WebRTC/neko spike, maybe later for the shared server)
- browser_curl, proxies, extensions (see decision 8)
- Browser pools, apps, deployments, invocations, projects, API keys, config registry, managed auth, credentials, vaults, wallets, cards, web search, docs search
- Reverse proxy, TLS, per-developer network or resource isolation
- Unikraft, macOS, Docker Desktop, arm64
