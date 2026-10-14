import { randomUUID } from "node:crypto";
import {
  createBrowser,
  findBrowser,
  listBrowsers,
  reapIdle,
  removeBrowser,
  toBrowser,
  trackCall,
  updateBrowser,
  type LocalRuntime,
} from "@/lib/mcp/local/browsers";
import {
  apiBase,
  errorText,
  LocalError,
  runDocker,
  type DockerRunner,
  type LocalContainer,
} from "@/lib/mcp/local/docker";
import {
  createProfile,
  deleteProfile,
  findProfile,
  listProfiles,
  renameProfile,
} from "@/lib/mcp/local/profiles";
import { ownerForToken } from "@/lib/mcp/local/tokens";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// The SDK parses only application/json bodies as JSON and retries 5xx (and
// 408/409/429) unless told not to; a retried create would start a second
// container.
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "x-should-retry": "false" } });
const noContent = () => new Response(null, { status: 204 });

// One page with no pagination headers, so has_more stays unknown.
const page = <T>(items: T[], params: URLSearchParams) => {
  const offset = Number(params.get("offset") ?? 0);
  const limit = params.get("limit");
  return items.slice(
    offset,
    limit === null ? undefined : offset + Number(limit),
  );
};

async function readJson(request: Request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

async function replays(
  container: LocalContainer,
  request: Request,
  rest: string[],
  signal?: AbortSignal,
) {
  const base = apiBase(container);
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      signal,
    });
    if (!response.ok) {
      throw new LocalError(response.status, await errorText(response));
    }
    return response;
  };
  const replayId = rest[1] && decodeURIComponent(rest[1]);

  if (rest.length === 1 && request.method === "POST") {
    const params = await readJson(request);
    // Recording ids are single-use per container, so each start gets a new one.
    const replay_id = randomUUID();
    await call("/recording/start", {
      id: replay_id,
      framerate: params.framerate,
      maxDurationInSeconds: params.max_duration_in_seconds,
      recordAudio: params.record_audio,
    }).then((response) => response.body?.cancel());
    return json({ replay_id });
  }
  if (rest.length === 1 && request.method === "GET") {
    const recordings = (await (await call("/recording/list")).json()) as Array<{
      id: string;
      started_at?: string | null;
      finished_at?: string | null;
    }>;
    return json(
      recordings.map((recording) => ({
        replay_id: recording.id,
        started_at: recording.started_at ?? null,
        finished_at: recording.finished_at ?? null,
      })),
    );
  }
  if (rest.length === 3 && rest[2] === "stop" && request.method === "POST") {
    await call("/recording/stop", { id: replayId }).then((response) =>
      response.body?.cancel(),
    );
    return noContent();
  }
  if (rest.length === 2 && request.method === "GET") {
    return call(`/recording/download?id=${encodeURIComponent(replayId)}`);
  }
  return null;
}

async function forward(
  container: LocalContainer,
  request: Request,
  rest: string,
  signal?: AbortSignal,
) {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return fetch(`${apiBase(container)}${rest}`, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
    signal,
  });
}

async function route(
  rt: LocalRuntime,
  owner: string,
  request: Request,
  signal?: AbortSignal,
): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;
  const id = parts[1] && decodeURIComponent(parts[1]);

  if (url.pathname === "/auth/context" && method === "GET") {
    return json({
      authentication: {
        credential_id: null,
        method: "api_key",
        source: "api_key",
      },
      authorization: {
        credential_scope: { project_id: "local" },
        effective_scope: { project_id: "local" },
      },
      organization: { id: "local" },
      principal: { id: owner, type: "user" },
    });
  }
  if (url.pathname === "/org/entitlements" && method === "GET") {
    return json({ features: {} });
  }

  // Profiles are shared by all tokens. Lists are one bare page.
  if (parts[0] === "profiles" && parts.length === 1) {
    if (method === "GET") {
      const profiles = await listProfiles({
        name: url.searchParams.get("name") ?? undefined,
        query: url.searchParams.get("query") ?? undefined,
      });
      return json(page(profiles, url.searchParams));
    }
    if (method === "POST") {
      return json(await createProfile((await readJson(request)).name));
    }
  }
  if (parts[0] === "profiles" && parts.length === 2) {
    if (method === "GET") return json(await findProfile(id));
    if (method === "PATCH") {
      return json(await renameProfile(id, (await readJson(request)).name));
    }
    if (method === "DELETE") {
      await deleteProfile(id);
      return noContent();
    }
  }

  if (parts[0] !== "browsers") return null;
  if (parts.length === 1) {
    if (method === "GET") {
      const params = url.searchParams;
      const query = params.get("query")?.toLowerCase();
      // Delete removes the container and create rejects tags, so neither
      // filter can match a local browser.
      const none =
        params.get("status") === "deleted" ||
        [...params.keys()].some((key) => key.startsWith("tags"));
      const browsers = none ? [] : await listBrowsers(rt, owner);
      const matches = browsers.filter(
        (b) =>
          !query ||
          [b.session_id, b.name, b.profile?.id, b.profile?.name].some((v) =>
            v?.toLowerCase().includes(query),
          ),
      );
      return json(page(matches, params));
    }
    if (method === "POST") {
      return json(
        await createBrowser(rt, owner, await readJson(request), signal),
      );
    }
    return null;
  }

  // Every per-browser call is scoped to the caller and counts as activity.
  const container = await findBrowser(rt, owner, id);
  if (parts.length === 2) {
    if (method === "GET") return json(await toBrowser(rt, container));
    if (method === "PATCH") {
      return json(await updateBrowser(rt, container, await readJson(request)));
    }
    if (method === "DELETE") {
      await removeBrowser(rt, container);
      return noContent();
    }
    return null;
  }
  const rest = parts.slice(2);
  // kernel-images only publishes telemetry events; the cloud reads them from
  // its control plane.
  if (rest.join("/") === "telemetry/events" && method === "GET") {
    return json([]);
  }
  // The reaper skips the browser until the response arrives; each body read
  // then counts as activity.
  const browserId = container.labels.id;
  if (rest[0] === "replays") {
    return trackCall(rt, browserId, replays(container, request, rest, signal));
  }
  const prefix = `/browsers/${parts[1]}`;
  return trackCall(
    rt,
    browserId,
    forward(
      container,
      request,
      url.pathname.slice(prefix.length) + url.search,
      signal,
    ),
  );
}

async function handle(
  rt: LocalRuntime,
  input: string | URL | Request,
  init?: RequestInit,
) {
  const signal = init?.signal ?? undefined;
  try {
    const request = new Request(input, init);
    const token = request.headers
      .get("authorization")
      ?.replace(/^Bearer /i, "");
    const owner = ownerForToken(token ?? "");
    if (!owner) throw new LocalError(401, "invalid local token");
    void reapIdle(rt);
    const response = await route(rt, owner, request, signal);
    if (response) return response;
    const path = new URL(request.url).pathname;
    throw new LocalError(
      501,
      `${request.method} ${path} is not available in local mode`,
    );
  } catch (error) {
    // An aborted create already removed its container; let the SDK see the
    // abort. Any other throw would look like a network error and be retried.
    if (signal?.aborted) throw error;
    if (error instanceof LocalError) {
      return json({ message: error.message }, error.status);
    }
    return json(
      { message: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}

function newRuntime(docker: DockerRunner, now = Date.now): LocalRuntime {
  return {
    docker,
    now,
    activity: new Map(),
    viewports: new Map(),
    modes: new Map(),
    lock: Promise.resolve(),
  };
}

// For tests: an isolated runtime with no reaper interval.
export function createLocalKernelFetch(deps: {
  docker: DockerRunner;
  now?: () => number;
}): Fetch {
  const rt = newRuntime(deps.docker, deps.now);
  return (input, init) => handle(rt, input, init);
}

// State lives on globalThis so next dev HMR does not fork it or start a
// second reaper interval.
const local = globalThis as typeof globalThis & {
  kernelLocalRuntime?: LocalRuntime;
  kernelLocalReaper?: ReturnType<typeof setInterval>;
};

export const localKernelFetch: Fetch = (input, init) => {
  const rt = (local.kernelLocalRuntime ??= newRuntime(runDocker));
  if (!local.kernelLocalReaper) {
    local.kernelLocalReaper = setInterval(() => void reapIdle(rt), 60_000);
    (local.kernelLocalReaper as { unref?: () => void }).unref?.();
  }
  return handle(rt, input, init);
};
