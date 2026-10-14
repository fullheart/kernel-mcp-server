# Local mode

Local mode runs this MCP server against [kernel-images](https://github.com/kernel/kernel-images) browser containers on your own Linux host. It needs no Kernel account, no Clerk and no Redis. Each browser is one Docker container that the server starts and removes. `KERNEL_MODE=local` switches it on. Without it, cloud mode works as before.

A coding agent such as Claude Code, Codex, Cursor or T3 Code uses it to test a web app in a real browser, the kernel.sh use case without the cloud.

Status: implemented on branch `feat/local-mode`. The first half of this file is the how-to. The [spec](#spec) half is what reviewers check the code against. Evidence for the verified facts lives in `.cache/facts/` (gitignored, local only).

## Quick start

### 1. Prerequisites

- A Linux x86_64 host with Docker Engine 20.10 or newer, which `host-gateway` needs.
- Your user can run `docker` without sudo. The server calls the Docker CLI.
- Bun. `bun install` adds the Bun 1.3.3 binary that `bun run build` checks for.
- The browser image, 2.8 GB, pulled once:

  ```bash
  docker pull onkernel/chromium-headful:c1128b7
  ```

- Per browser, about 0.5 GB RAM idle and more on heavy pages. Docker caps each container at 8 GB, and its 2 GB `/dev/shm` tmpfs counts toward that. Disk use starts around 10 MB per container and grows with the Chromium cache and recordings, each recording up to 500 MB.

### 2. Configure

```bash
cp .env.local-mode.example .env.local
```

Replace `change-me` with a long random string, for example the output of `openssl rand -hex 24`. Next.js reads `.env.local` for `dev`, `build` and `start`, so this replaces a cloud `.env.local` if you have one. Local mode needs no 1Password and no `make` targets.

| Variable                      | Default                             | Meaning                                                                                                     |
| ----------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `KERNEL_MODE`                 | unset                               | `local` switches local mode on.                                                                             |
| `LOCAL_MCP_TOKENS`            | unset                               | `name:token` pairs, comma separated, so tokens cannot contain commas. The token decides who owns a browser. |
| `KERNEL_LOCAL_IMAGE`          | `onkernel/chromium-headful:c1128b7` | Browser image. It must be pulled.                                                                           |
| `KERNEL_LOCAL_DATA_DIR`       | `./.local-data`                     | Profiles go to `<dir>/profiles/`. Relative to the server's working directory. Gitignored.                   |
| `KERNEL_LOCAL_PUBLIC_HOST`    | `localhost`                         | Host name in `cdp_ws_url`. Nothing else.                                                                    |
| `KERNEL_LOCAL_MAX_BROWSERS`   | `5`                                 | Cap on running browsers across all tokens.                                                                  |
| `KERNEL_MCP_ENABLED_TOOLSETS` | the local toolsets                  | An explicit value wins. Cloud-only toolsets then fail with 501 or 404.                                      |
| `KERNEL_PROJECT`              | unset                               | Leave unset or set to `local`. Any other value fails every request.                                         |
| `TZ`                          | the host time zone                  | Passed to every browser.                                                                                    |

### 3. Start the server

```bash
bun install
bun run dev -H 127.0.0.1
```

For a production build, run `bun run build && bun run start -H 127.0.0.1` instead. The MCP endpoint is `http://127.0.0.1:3002/mcp`.

Keep `-H 127.0.0.1`. Next.js listens on `0.0.0.0` by default, and a valid token is root on this host. Browsers run as `--privileged` containers, and `exec_command` runs as root inside them. Use an [SSH tunnel](#remote-use-over-ssh) for remote access.

### 4. Connect your agent

Export the token in the shell that starts the agent:

```bash
export KERNEL_LOCAL_TOKEN=<token from LOCAL_MCP_TOKENS>
```

Claude Code stores the expanded token. Add `--scope user` to use the server in every project, then check with `/mcp`:

```bash
claude mcp add --transport http kernel-local http://127.0.0.1:3002/mcp \
  --header "Authorization: Bearer $KERNEL_LOCAL_TOKEN"
```

Codex reads the token from the variable when it connects. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.kernel-local]
url = "http://127.0.0.1:3002/mcp"
bearer_token_env_var = "KERNEL_LOCAL_TOKEN"
```

Cursor reads `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project. It resolves `${env:...}` from its own environment, so start Cursor from that shell or paste the token in:

```json
{
  "mcpServers": {
    "kernel-local": {
      "url": "http://127.0.0.1:3002/mcp",
      "headers": {
        "Authorization": "Bearer ${env:KERNEL_LOCAL_TOKEN}"
      }
    }
  }
}
```

### 5. Check that it works

With the server up and no other local browsers running:

```bash
TOKEN=<your token> scripts/local-smoke.sh
```

The script needs `curl`, `python3` and `docker`. It serves a test page on `0.0.0.0`, runs `manage_profiles setup`, sets a cookie and a localStorage value through `host.docker.internal`, takes a screenshot and runs `ls /`. Then it deletes the browser, creates a new one with the same profile and checks that both values survived. It prints `PASS` or `FAIL` per step and removes everything it created. It fails if more than 2 local browser containers run at once. Set `MCP_URL` if the server is not on `http://localhost:3002/mcp`. With `LOCAL_MCP_TOKENS` exported, `TOKEN` defaults to its first token.

The adapter unit tests run without Docker: `bun test src/lib/mcp/local`.

## Using local mode

### Reaching apps on the host

Inside a browser container, `localhost` is the container. Open host apps at `http://host.docker.internal:<port>`. The server starts every container with `--add-host=host.docker.internal:host-gateway`, which points that name at the host.

The app must listen on an address the container can reach:

- `0.0.0.0` works. It also exposes the app to your network.
- The `docker0` address works without that exposure. `ip -4 addr show docker0` prints it.
- `127.0.0.1` does not work.

Dev servers that check the `Host` header reject `host.docker.internal`. For Vite, run `vite --host 0.0.0.0` and add `host.docker.internal` to `server.allowedHosts`. If the browser still cannot connect, check whether a host firewall such as ufw blocks traffic from Docker networks.

### Profiles and saving

A profile is two files under `$KERNEL_LOCAL_DATA_DIR/profiles/`: `<id>.json` with the metadata and, once saved, `<id>.tar.zst` with Chromium's user data. All tokens share all profiles.

The server saves a profile only when a browser created with save changes on goes away, through `manage_browsers delete` or the idle reaper. Before it downloads the user data, it closes Chromium over CDP so recent cookies and localStorage reach the disk.

1. `manage_profiles setup` with a `profile_name` creates the profile and a browser with save changes on and a 300 s idle timeout.
2. There is no live view, so the agent signs in with `execute_playwright_code` or `computer_action`.
3. `manage_browsers delete` on that session saves the profile.
4. `manage_browsers create` with `profile_name` loads it. Such a browser saves again only with `save_profile_changes: true`.

To change a saved profile, run setup again with `update_existing: true`. If a save fails, the server keeps the browser and the delete returns an error, so run the delete again. When two browsers save the same profile, the last one wins.

When the server stops, its browsers keep running and nothing is saved. A restarted server reaps them after their timeout and saves them then. Removing them by hand with `docker rm -f` drops unsaved changes.

### Idle timeout and limits

- `timeout_seconds` is an idle timeout, as in the cloud. Default 60, minimum 10, maximum 259200.
- Any tool call for a browser counts as activity. Direct CDP traffic to `cdp_ws_url` does not.
- The reaper runs on every request and every 60 s. After a restart, idle time starts fresh and the reaper starts with the first request.
- At `KERNEL_LOCAL_MAX_BROWSERS` running browsers, create fails with 429.
- Each token sees only its own browsers. Browser names are unique per token.
- Run one MCP server process per Docker host. Activity, the create lock and the reaper live in process memory, so a second process sees the first one's browsers as idle and deletes them. That includes `next dev` and `next start` side by side, or two checkouts.

### Recordings

`manage_replays` start, stop and list work. A recording lives in its container at `/recordings/<replay_id>.mp4` and disappears with the container. Read it with `manage_browser_files` and base64 encoding before you delete the browser. There is no `replay_view_url`.

### Remote use over SSH

Forward only the MCP port from your laptop:

```bash
ssh -N -L 3002:127.0.0.1:3002 you@docker-host
```

The client configs above then work unchanged, and every tool runs through that port. Each browser publishes CDP on a random port on the Docker host's `127.0.0.1`, so `cdp_ws_url` only works on that host or after you forward that browser's port as well.

`host.docker.internal` is the Docker host, not your laptop. Run the app under test on the Docker host.

## Troubleshooting

| Symptom                                                                                   | Fix                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker run failed: ... No such image: onkernel/chromium-headful:c1128b7`                 | The server runs containers with `--pull never`. Pull the image.                                                                                           |
| `docker run failed: ... permission denied ... docker.sock`                                | Add your user to the `docker` group and log in again.                                                                                                     |
| `EADDRINUSE` on port 3002                                                                 | Stop the other process, or start with `bunx next dev -H 127.0.0.1 -p 3003` and change the client URL.                                                     |
| `no space left on device`                                                                 | Free disk. `docker system df` shows usage. `docker rm -f $(docker ps -aq --filter label=kernel.local)` removes all local browsers and their unsaved data. |
| 401 `invalid_token`, "The Kernel API rejected this credential"                            | The token is not in `LOCAL_MCP_TOKENS`. Restart the server after you edit `.env.local`.                                                                   |
| 401 `invalid_token`, "Missing or invalid access token"                                    | The client sends no `Authorization: Bearer <token>` header. Skip any OAuth login the client offers. Local mode has none.                                  |
| `Unable to resolve Kernel connection scope`                                               | Unset `KERNEL_PROJECT` or set it to `local`.                                                                                                              |
| 429 `local browser limit reached`                                                         | Delete a browser or raise `KERNEL_LOCAL_MAX_BROWSERS`.                                                                                                    |
| 400 `viewport ... is not supported in local mode. supported: ...`                         | Pick a size from the list. The image only has fixed display modes.                                                                                        |
| 400 `<field> is not supported in local mode`, or 501 `... is not available in local mode` | The feature needs the Kernel cloud. See the next section.                                                                                                 |
| `profile save failed, browser kept`                                                       | Run the delete again. `docker logs <container>` shows what Chromium did.                                                                                  |
| The page says "Blocked request" or does not load                                          | See [reaching apps on the host](#reaching-apps-on-the-host).                                                                                              |

## What is not supported and why

Every feature that behaves differently from the cloud costs more than it brings, so local mode drops it instead of faking it.

| Feature                                                                                                                                                        | Why                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live view                                                                                                                                                      | The image has no noVNC. The only live view is WebRTC through neko, which needs UDP ports and its own setup. `manage_profiles setup` tells the agent to sign in itself.                                                            |
| `browser_curl`                                                                                                                                                 | Cloud curl runs in Chrome's network stack with the profile's cookie jar. kernel-images has no curl route, and a curl from the host would behave differently.                                                                      |
| Proxies                                                                                                                                                        | kernel-images has no proxy auth and no hot swap, and a proxy check from the host would test the host's network, not the browser's.                                                                                                |
| Extensions                                                                                                                                                     | No tool uploads an extension, and activation through kernel-images is unverified.                                                                                                                                                 |
| Browser pools, apps, deployments, invocations, projects, API keys, config registry, managed auth, credentials, vaults, wallets, cards, web search, docs search | They need Kernel cloud services. Their toolsets stay off, and their API calls return 501.                                                                                                                                         |
| Create params `proxy_id`, `proxy`, `extensions`, `vaults`, `pool`, `network`, `tags`                                                                           | They need cloud resources, so create fails with 400. `stealth`, `headless`, `gpu`, `region`, `memory`, `telemetry` and `invocation_id` are accepted with no effect, and the browser shows `stealth: false` and `headless: false`. |
| Browser updates other than `viewport`                                                                                                                          | Only `viewport` maps to a kernel-images call, `PATCH /display`. Other fields fail with 400.                                                                                                                                       |
| Telemetry events                                                                                                                                               | kernel-images can receive events but not list them, so the list is always empty.                                                                                                                                                  |
| `replay_view_url`, recordings after delete                                                                                                                     | Recordings are files inside the container.                                                                                                                                                                                        |
| `local_forward`, `remote_forward` on `manage_browsers create`                                                                                                  | They print a cloud `kernel browsers ssh` command. Use `host.docker.internal` instead.                                                                                                                                             |
| macOS, Docker Desktop, arm64, Unikraft                                                                                                                         | The image is Linux x86_64, and host networking was only verified on Linux with Docker Engine.                                                                                                                                     |
| Isolation between developers, TLS, reverse proxy                                                                                                               | Personal use first. Tokens separate browsers, but profiles, the browser cap and the host are shared.                                                                                                                              |

## Spec

### How kernel-images works (verified)

- One browser per container. The published image `onkernel/chromium-headful:<sha7>` on Docker Hub already contains the API. No build step, no `WITH_KERNEL_IMAGES_API` (nothing reads it).
- `:10001` REST API, no auth. `:9222` CDP proxy. `/json/version` rewrites the WebSocket host from the request `Host` header, and any WebSocket path reaches the browser target.
- Ready about 3 to 4 s after `docker run`. `:10001` only listens once Chromium is up, so any 2xx from `GET /spec.yaml` means ready.
- Needs `--privileged` for the Chromium sandbox and `--tmpfs /dev/shm:size=2g`. Idle Chromium uses about 0.5 GB.
- No noVNC. Without `ENABLE_WEBRTC=true` there is no live view at all. WebRTC needs neko plus UDP ports.
- `WIDTH`/`HEIGHT` env vars do nothing. The screen boots at 3840x2160. `POST /configure` (multipart) sets display, Chromium flags, policies, a profile archive, extensions and `start_url` with one Chromium restart of about 4 s. Display sizes must be modes listed in the image's xorg.conf, at a listed refresh rate.
- The Kernel SDK calls the same per-browser endpoints with a `/browsers/{id}` prefix. 45 of 52 per-browser paths match after stripping the prefix. The rest: replays (`/recording/*` with other shapes), `GET telemetry/events` (kernel-images only has POST), `curl` (no route), `extensions` (other path and multipart names).
- Inside the container `localhost` is the container. With `--add-host=host.docker.internal:host-gateway`, the browser reaches a host app at `http://host.docker.internal:<port>` if the app listens on `0.0.0.0` or the `docker0` address.
- Chromium is stopped with SIGKILL. A profile saved after a plain stop loses recent cookies and localStorage. CDP `Browser.close` first keeps them.

### Decisions

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
| 12  | `timeout_seconds` is an idle timeout, as in the cloud (default 60, min 10, max 259200). Activity = any adapter call for that browser. A reaper removes idle containers on every adapter call and every 60 s (one interval per process, started on the first call, guarded on `globalThis` for HMR). `KERNEL_LOCAL_MAX_BROWSERS` (default 5) caps running containers across all owners. Direct CDP traffic to `cdp_ws_url` bypasses the adapter and does not count.                                                                        |
| 13  | Image: `KERNEL_LOCAL_IMAGE`, default `onkernel/chromium-headful:c1128b7`. The user pulls it once (`docker pull`). `docker run --pull never` fails fast instead of pulling 2.7 GB inside an SDK request. No Makefile, no source build.                                                                                                                                                                                                                                                                                                     |
| 14  | Done means: unit tests for the adapter, route tests for local auth, a green smoke script against a real server and real containers, this doc rewritten into a how-to, `.env.local-mode.example`.                                                                                                                                                                                                                                                                                                                                          |
| 15  | Work on `feat/local-mode`, draft PR against `main` of `fullheart/kernel-mcp-server`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 16  | The browser reaches host apps through `host.docker.internal` (`--add-host=host.docker.internal:host-gateway` on every container). Documented, including the bind address requirement.                                                                                                                                                                                                                                                                                                                                                     |
| 17  | `manage_profiles setup` normally tells the user to open the live view. In local mode, when `browser_live_view_url` is missing, it instead tells the agent to sign in with `execute_playwright_code` or `computer_action` and then delete the browser to save the profile. This is the only tool text change.                                                                                                                                                                                                                              |

### Request flow

1. `src/proxy.ts` skips `clerkMiddleware`. It throws without a publishable key under `next start` and in CI.
2. `src/lib/const.ts` skips the `KERNEL_CLI_*_CLIENT_ID` checks, which `next build` hits through `/authorize` and `/token`.
3. `src/app/[transport]/route.ts` never calls Clerk `verifyToken` and treats every bearer as a local token. Transport session signing and the MCP Apps auth subject fall back to a per-process HMAC secret when `CLERK_SECRET_KEY` is unset. A session id minted before a restart then verifies as no session, which is harmless because sessions carry no server state here. The MCP Apps marker store is a no-op.
4. The adapter answers `GET /auth/context` with a schema-valid context (`src/lib/mcp/auth-context.ts`): organization `local`, project `local`, principal the token owner. `resolveMcpConnectionContext` then yields `{kind: "project", projectId: "local"}`. Unknown token: 401 `{"message": "invalid local token"}`, which `route.ts` turns into 401 `invalid_token`.
5. `GET /org/entitlements` returns `{"features": {}}`, which hides vault and search tools.
6. OAuth routes stay in the code but are unused.

### Fetch adapter

Module `src/lib/mcp/local/`. `createKernelClient` passes `fetch: localKernelFetch` and baseURL `http://kernel.local` when `KERNEL_MODE=local`. The owner comes from the `Authorization: Bearer` header of each request, so no call site changes.

SDK contract (verified in SDK source):

- Synthetic JSON responses send `content-type: application/json`, or the SDK returns a string.
- Never put `base_url` or a `jwt` into a browser object. The SDK would route per-browser calls to that URL and bypass the adapter.
- Every adapter-generated response sets `x-should-retry: false`. The SDK retries 5xx, 408, 409 and 429 otherwise, and a retried create would start a second container.
- List endpoints return a bare JSON array with no pagination headers (one page).
- Path ids are decoded with `decodeURIComponent`.
- Honor `init.signal`: if a create is aborted after `docker run`, remove the container and rethrow the abort.

Routing:

| SDK request                           | Local handler                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /browsers`                      | Validate params, reap, then in an in-process lock enforce max browsers and name uniqueness and `docker run`. Wait for ready, `POST /configure`, return the browser object                  |
| `GET /browsers`                       | `docker ps` with `label=kernel.local.owner=<owner>`, map to browser objects                                                                                                                |
| `GET /browsers/{id}`                  | Same, by id or name                                                                                                                                                                        |
| `PATCH /browsers/{id}`                | `viewport` via `PATCH /display` with the resolved refresh rate and `require_idle: !force`. Any other field: 400                                                                            |
| `DELETE /browsers/{id}`               | Save profile if `save_changes`, then `docker rm -f`                                                                                                                                        |
| `GET /browsers/{id}/telemetry/events` | `[]`                                                                                                                                                                                       |
| `/browsers/{id}/replays*`             | Map to `/recording/*` (below)                                                                                                                                                              |
| `/browsers/{id}/<rest>`               | Owner check, touch activity, strip prefix, forward to `http://127.0.0.1:<api port>/<rest>` with method, query, headers minus `authorization`, and body. Stream the response back unchanged |
| `/profiles*`                          | Local profile store (below)                                                                                                                                                                |
| `/auth/context`, `/org/entitlements`  | Synthetic, see request flow                                                                                                                                                                |
| anything else                         | 501 `{"message": "<method> <path> is not available in local mode"}`                                                                                                                        |

#### docker run

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

Host ports and labels come back from one `docker ps --format` call per lookup, with each label read through `.Label` so names with commas stay safe. One parser serves list, get and port lookup. After ready, `POST /configure` with:

- `display`: the requested viewport, else the cloud default 1920x1080@25. Without `refresh_rate`, use the highest rate xorg.conf lists for that size. Sizes not listed: 400 with the supported sizes. The mode list comes from `/etc/neko/xorg.conf` via `/fs/read_file`, cached per image. The first create per image labels the viewport before the list is known.
- `chromium_flags`: `--kiosk` when `kiosk_mode`.
- `profile_archive`: the stored archive when a profile with data is requested.
- `chrome_policies`: the `chrome_policy` create param, when not empty.
- `start_url` when given.

If anything after `docker run` fails, remove the container and return the error.

#### Browser object

Fields: `session_id`, `name`, `created_at`, `timeout_seconds`, `cdp_ws_url`, `viewport {width, height, refresh_rate}`, `kiosk_mode`, `headless: false`, `stealth: false`, plus `profile {id, name}` and `profile_save_changes` when a profile is used. Omit fields with no local meaning: `browser_live_view_url`, `base_url`, `webdriver_ws_url`, `region`, `memory`, `telemetry`, `pool`, `proxy_id`. The type is a `Pick` of the SDK type so `tsc` catches drift.

#### Create params

- No local effect, accepted: `stealth` and `headless` (always false in the response), `gpu`, `region`, `memory`, `telemetry`, `invocation_id`.
- Accepted with effect: `name`, `timeout_seconds`, `viewport`, `kiosk_mode`, `profile`, `start_url`, `chrome_policy`. Any other key gets 400 `<key> is not supported in local mode`, including `proxy_id`, `proxy`, `extensions`, `vaults`, `pool`, `network` and `tags`.
- `timeout_seconds` outside 10 to 259200 or not an integer: 400. Unknown profile: 404.
- `name` must be unique per owner (409). At `KERNEL_LOCAL_MAX_BROWSERS`: 429.

#### Replays

- `start`: generate a UUID, `POST /recording/start {"id", "framerate", "maxDurationInSeconds", "recordAudio"}`, return `{replay_id}`.
- `stop`: `POST /recording/stop {"id"}`, return 204.
- `list`: `GET /recording/list`, map `{id, started_at, finished_at}` to `{replay_id, started_at, finished_at}`.
- `download` (`GET /browsers/{id}/replays/{replay_id}`): `GET /recording/download?id=`.
- No `replay_view_url`. Recordings live in the container under `/recordings/<id>.mp4` and disappear with it.

#### Profiles

Store under `$KERNEL_LOCAL_DATA_DIR/profiles/`: `<id>.json` (`{id, name, created_at, updated_at, last_used_at}`) and `<id>.tar.zst` once saved. Ids are 24 random lowercase hex chars. Names are unique, matched case-insensitively (409 on duplicate). `create`, `list` (filters `name` and `query`), `retrieve` (id or name), `update` (rename) and `delete` follow the SDK shapes. Lookups go through the parsed list, so a caller-supplied id never becomes part of a file path.

- Load: `POST /configure` with `profile_archive` = the `.tar.zst` file, and set `last_used_at`. A profile without an archive starts empty.
- Save, on delete or idle reap with `save_changes`: CDP `Browser.close` on `ws://127.0.0.1:<cdp port>/`, then `/process/exec` `supervisorctl -c /etc/supervisor/supervisord.conf stop chromium`, both best effort. Then `GET /fs/download_dir_zstd?path=/home/kernel/user-data`, written atomically (temp file plus rename). Then remove the container. If the download fails, the container stays and delete returns 500, so the profile data is not lost. A profile deleted in the meantime is skipped.
- Last writer wins, no locking, same as the cloud.

### Acceptance

1. `bun test` unit tests for the adapter with an injected Docker runner and a fake container API, following the `new Kernel({ fetch })` pattern in `src/lib/mcp/vaults.test-fixtures.ts`. They cover prefix strip and pass-through, create (lock, max browsers, unsupported params, configure body, cleanup on failure and abort), owner-scoped list and get, delete with and without profile save, viewport update, idle reap, replays, telemetry, profiles CRUD, auth context, entitlements, and the 501 fallback with `x-should-retry: false`.
2. `bun test` for the local branch in `route.ts` and `src/proxy.ts`: valid token, unknown token 401, no Clerk call, no Redis call.
3. `scripts/local-smoke.sh` green against `next dev` with `KERNEL_MODE=local` and the real image, as described in [check that it works](#5-check-that-it-works). `tools/list` must return exactly the local tools plus `get_connection_context`, `get_more_tools` and `submit_feedback`. Never more than 2 containers at once, because host disk is tight.
4. `bunx tsc --noEmit` passes. Existing tests stay green. `bun run format:check` passes for changed files (`AGENTS.md` already fails on `main`, leave it).
5. This file is a how-to: setup, env, MCP client config for Claude Code, Codex and Cursor, reaching host apps, limits, what is not supported and why.

### Review loop

After implementation, loop at most 4 rounds until no valid Critical or Major finding remains:

1. `coderabbit review --agent --base main`. The free tier allows 150 files and 3 reviews per hour, so run `coderabbit auth status` first and chunk if needed.
2. Skill `mattpocock-skills:code-review` against `main`, axes Standards (AGENTS.md, local style) and Spec (this file). From round 2 on, use the last reviewed commit as the fixed point.
3. Check each finding against the current code. Fix valid ones in parallel subagents, never two agents on one file. Reject invalid ones with a one-line reason.
4. One commit per fix.

List leftovers in the PR description and post a summary of the review rounds as a PR comment.
