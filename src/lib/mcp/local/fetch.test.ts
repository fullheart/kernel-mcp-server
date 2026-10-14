import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIError, APIUserAbortError, Kernel } from "@onkernel/sdk";
import { connectionScopeFromAuthContext } from "@/lib/mcp/auth-context";
import type { DockerRunner } from "@/lib/mcp/local/docker";
import { createLocalKernelFetch } from "@/lib/mcp/local/fetch";

const XORG = [
  "1920x1080_60",
  "1920x1080_30",
  "1920x1080_25",
  "1920x1080_10",
  "1280x720_60",
  "1280x720_30",
  "1024x768_60",
]
  .map((mode) => `  Modeline "${mode}.00" 0 0 0 0`)
  .join("\n");

type ContainerRequest = {
  method: string;
  path: string;
  headers: Headers;
  body?: unknown;
  form?: Record<string, string>;
};

// One fake kernel-images container: REST API and CDP WebSocket on one port.
const fake = {
  ready: true,
  configureStatus: 200,
  archive: "ARCHIVE-1",
  events: [] as string[],
  requests: [] as ContainerRequest[],
  recordings: [] as Array<Record<string, unknown>>,
};

const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    if (req.headers.get("upgrade") === "websocket") {
      srv.upgrade(req);
      return undefined;
    }
    const url = new URL(req.url);
    const record: ContainerRequest = {
      method: req.method,
      path: url.pathname + url.search,
      headers: req.headers,
    };
    if (url.pathname === "/configure") {
      const form = await req.formData();
      record.form = {};
      for (const [key, value] of form.entries()) {
        record.form[key] = await new Response(value).text();
      }
    } else {
      const text = await req.text();
      if (text) record.body = JSON.parse(text);
    }
    if (url.pathname !== "/spec.yaml") {
      fake.requests.push(record);
      fake.events.push(`${req.method} ${url.pathname}`);
    }
    switch (url.pathname) {
      case "/spec.yaml":
        return new Response("openapi", { status: fake.ready ? 200 : 503 });
      case "/fs/read_file":
        return new Response(
          url.searchParams.get("path") === "/etc/neko/xorg.conf"
            ? XORG
            : "hello",
        );
      case "/configure":
        return fake.configureStatus === 200
          ? Response.json({ ok: true })
          : Response.json(
              { message: "boom", phase: "configure_phase" },
              { status: fake.configureStatus },
            );
      case "/display":
        return Response.json(record.body);
      case "/process/exec":
        return Response.json({ exit_code: 0, stdout_b64: "Lwo=" });
      case "/fs/download_dir_zstd":
        return new Response(fake.archive);
      case "/recording/start":
        fake.recordings.push({
          id: (record.body as { id: string }).id,
          isRecording: true,
          started_at: "2026-10-14T00:00:00Z",
        });
        return new Response(null, { status: 201 });
      case "/recording/stop":
        return new Response(null, { status: 200 });
      case "/recording/list":
        return Response.json(fake.recordings);
    }
    return new Response("404 page not found", { status: 404 });
  },
  websocket: {
    message(ws, message) {
      fake.events.push(`ws ${JSON.parse(String(message)).method}`);
      ws.send(JSON.stringify({ id: 1, result: {} }));
      ws.close();
    },
  },
});
const port = server.port;

function fakeDocker() {
  const containers = new Map<string, Record<string, string>>();
  const calls: string[][] = [];
  let count = 0;
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    const values = (flag: string) =>
      args.filter((_, i) => args[i - 1] === flag);
    if (args[0] === "ps") {
      const filters = values("--filter").map((f) => f.slice("label=".length));
      return [...containers]
        .filter(([, labels]) =>
          filters.every((filter) => {
            const at = filter.indexOf("=");
            return labels[filter.slice(0, at)] === filter.slice(at + 1);
          }),
        )
        .map(([containerId, labels]) =>
          JSON.stringify({
            containerId,
            image: labels.image,
            ports: `127.0.0.1:${port}->10001/tcp, 127.0.0.1:${port}->9222/tcp`,
            ...Object.fromEntries(
              Object.entries(labels).map(([k, v]) => [
                k.replace("kernel.local.", ""),
                v,
              ]),
            ),
          }),
        )
        .join("\n");
    }
    if (args[0] === "run") {
      const labels: Record<string, string> = { image: args.at(-1)! };
      for (const label of values("--label")) {
        const at = label.indexOf("=");
        labels[label.slice(0, at)] = label.slice(at + 1);
      }
      const containerId = `container-${++count}`;
      containers.set(containerId, labels);
      return `${containerId}\n`;
    }
    if (args[0] === "rm") {
      containers.delete(args[2]);
      return "";
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { docker, containers, calls };
}

const savedEnv = { ...process.env };
let dataDir = "";
let clock = 0;
let docker = fakeDocker();
let adapter = createLocalKernelFetch({ docker: docker.docker });
let adapterCalls = 0;

function client(token = "tok-alice") {
  return new Kernel({
    apiKey: token,
    baseURL: "http://kernel.local",
    fetch: (input, init) => {
      adapterCalls++;
      return adapter(input, init);
    },
  });
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(APIError);
  return error as APIError;
}

const runs = () => docker.calls.filter((call) => call[0] === "run");
const removed = () =>
  docker.calls.filter((call) => call[0] === "rm").map((call) => call[2]);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kernel-local-test-"));
  process.env.LOCAL_MCP_TOKENS = "alice:tok-alice, bob:tok-bob";
  process.env.KERNEL_LOCAL_DATA_DIR = dataDir;
  process.env.KERNEL_SUPPRESS_BUN_WARNING = "1";
  delete process.env.KERNEL_LOCAL_MAX_BROWSERS;
  delete process.env.KERNEL_LOCAL_IMAGE;
  delete process.env.KERNEL_LOCAL_PUBLIC_HOST;
  delete process.env.KERNEL_PROJECT;
});

afterAll(async () => {
  process.env = savedEnv;
  server.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  Object.assign(fake, {
    ready: true,
    configureStatus: 200,
    archive: "ARCHIVE-1",
    events: [],
    requests: [],
    recordings: [],
  });
  clock = Date.parse("2026-10-14T00:00:00Z");
  docker = fakeDocker();
  adapter = createLocalKernelFetch({ docker: docker.docker, now: () => clock });
  adapterCalls = 0;
  await rm(join(dataDir, "profiles"), { recursive: true, force: true });
});

describe("local auth and fallbacks", () => {
  test("answers auth context with a local project scope", async () => {
    const context = await client().auth.context.retrieve();
    expect(context.principal).toEqual({ id: "alice", type: "user" });
    expect(connectionScopeFromAuthContext(context)).toEqual({
      kind: "project",
      organizationId: "local",
      projectId: "local",
      source: "credential",
    });
    expect(await client().get<unknown>("/org/entitlements")).toEqual({
      features: {},
    });
  });

  test("rejects unknown tokens with 401 and no retry", async () => {
    const error = await rejection(client("nope").auth.context.retrieve());
    expect(error.status).toBe(401);
    expect(error.message).toBe("401 invalid local token");
    expect(adapterCalls).toBe(1);
  });

  test("refuses the public placeholder token", async () => {
    process.env.LOCAL_MCP_TOKENS = "alice:tok-alice, me:change-me";
    try {
      const error = await rejection(
        client("change-me").auth.context.retrieve(),
      );
      expect(error.status).toBe(401);
    } finally {
      process.env.LOCAL_MCP_TOKENS = "alice:tok-alice, bob:tok-bob";
    }
  });

  test("answers routes without a local backend with a non-retried 501", async () => {
    const error = await rejection(client().proxies.list());
    expect(error.status).toBe(501);
    expect(error.message).toBe(
      "501 GET /proxies is not available in local mode",
    );
    expect(error.headers?.get("x-should-retry")).toBe("false");
    expect(adapterCalls).toBe(1);
  });
});

describe("local browsers", () => {
  test("create runs docker, configures the browser and returns the local shape", async () => {
    const browser = await client().browsers.create({
      name: "web",
      kiosk_mode: true,
      start_url: "https://example.com",
      viewport: { width: 1280, height: 720 },
      stealth: true,
      headless: true,
      timeout_seconds: 120,
    });

    const run = runs()[0];
    expect(run).toEqual(
      expect.arrayContaining([
        "-d",
        "--pull",
        "never",
        "--privileged",
        "/dev/shm:size=2g",
        "--add-host=host.docker.internal:host-gateway",
        "127.0.0.1::10001",
        "127.0.0.1::9222",
        "ENABLE_WEBRTC=false",
        "kernel.local=1",
        "kernel.local.owner=alice",
        "kernel.local.name=web",
        "kernel.local.timeout=120",
        "kernel.local.kiosk=true",
        "kernel.local.save_profile=false",
      ]),
    );
    expect(run.at(-1)).toBe("onkernel/chromium-headful:c1128b7");
    expect(fake.requests.find((r) => r.path === "/configure")?.form).toEqual({
      display: JSON.stringify({ width: 1280, height: 720, refresh_rate: 60 }),
      chromium_flags: JSON.stringify({ flags: ["--kiosk"] }),
      start_url: "https://example.com",
    });
    expect(browser as unknown).toEqual({
      session_id: expect.stringMatching(/^[0-9a-f]{24}$/),
      name: "web",
      created_at: "2026-10-14T00:00:00.000Z",
      timeout_seconds: 120,
      cdp_ws_url: `ws://localhost:${port}/`,
      viewport: { width: 1280, height: 720, refresh_rate: 60 },
      kiosk_mode: true,
      headless: false,
      stealth: false,
    });

    // Later creates know the modes and label the resolved default viewport.
    await client().browsers.create({});
    expect(runs()[1]).toContain("kernel.local.viewport=1920x1080@25");
  });

  test("rejects params that need cloud resources before docker run", async () => {
    for (const params of [
      { proxy_id: "p" },
      { extensions: [{ name: "x" }] },
      { vaults: [{ name: "v" }] },
      { network: { allowed_hosts: ["a"] } },
    ]) {
      const error = await rejection(client().browsers.create(params));
      expect(error.status).toBe(400);
      expect(error.message).toContain(
        `${Object.keys(params)[0]} is not supported in local mode`,
      );
    }
    expect(runs()).toHaveLength(0);
  });

  test("an unsupported viewport is a 400 that lists the supported modes", async () => {
    const error = await rejection(
      client().browsers.create({ viewport: { width: 1280, height: 800 } }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain(
      "supported: 1920x1080@60/30/25/10, 1280x720@60/30, 1024x768@60",
    );
    expect(removed()).toEqual(["container-1"]);
  });

  test("the lock keeps parallel creates under the max", async () => {
    process.env.KERNEL_LOCAL_MAX_BROWSERS = "2";
    try {
      const results = await Promise.allSettled(
        [1, 2, 3].map(() => client().browsers.create({})),
      );
      const failed = results.filter((r) => r.status === "rejected");
      expect(failed).toHaveLength(1);
      expect(
        ((failed[0] as PromiseRejectedResult).reason as APIError).status,
      ).toBe(429);
      expect(runs()).toHaveLength(2);
    } finally {
      delete process.env.KERNEL_LOCAL_MAX_BROWSERS;
    }
  });

  test("names are unique per owner", async () => {
    await client().browsers.create({ name: "a" });
    adapterCalls = 0;
    const error = await rejection(client().browsers.create({ name: "a" }));
    expect(error.status).toBe(409);
    expect(adapterCalls).toBe(1);
    await client("tok-bob").browsers.create({ name: "a" });
    expect(runs()).toHaveLength(2);
  });

  test("a failed configure removes the container and is not retried", async () => {
    fake.configureStatus = 500;
    const error = await rejection(client().browsers.create({}));
    expect(error.status).toBe(500);
    expect(error.message).toContain("browser configure failed: boom");
    expect(runs()).toHaveLength(1);
    expect(removed()).toEqual(["container-1"]);
  });

  test("an aborted create removes the container", async () => {
    fake.ready = false;
    const controller = new AbortController();
    const pending = client().browsers.create({}, { signal: controller.signal });
    while (runs().length === 0) await Bun.sleep(5);
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect(removed()).toEqual(["container-1"]);
  });

  test("list, get and per-browser calls only see the caller's browsers", async () => {
    const mine = await client().browsers.create({ name: "mine" });
    expect(
      (await client("tok-bob").browsers.list()).getPaginatedItems(),
    ).toEqual([]);
    const listed = await client().browsers.list();
    expect(listed.getPaginatedItems().map((b) => b.session_id)).toEqual([
      mine.session_id,
    ]);
    expect(listed.hasNextPage()).toBe(false);
    expect((await client().browsers.retrieve("mine")).session_id).toBe(
      mine.session_id,
    );

    const bob = client("tok-bob");
    for (const call of [
      bob.browsers.retrieve(mine.session_id),
      bob.browsers.process.exec(mine.session_id, { command: "ls" }),
      bob.browsers.replays.list(mine.session_id),
      bob.browsers.deleteByID(mine.session_id),
    ]) {
      expect((await rejection(call)).status).toBe(404);
    }
    expect(fake.requests.some((r) => r.path === "/process/exec")).toBe(false);
    expect(removed()).toEqual([]);
  });

  test("list honors status, query, tags, offset and limit", async () => {
    await client().browsers.create({ name: "alpha" });
    await client().browsers.create({ name: "beta" });
    const names = async (query: Parameters<Kernel["browsers"]["list"]>[0]) =>
      (await client().browsers.list(query))
        .getPaginatedItems()
        .map((b) => b.name);
    expect(await names({ status: "deleted" })).toEqual([]);
    expect(await names({ tags: { team: "x" } })).toEqual([]);
    expect(await names({ query: "LPH" })).toEqual(["alpha"]);
    expect(await names({ status: "all" })).toHaveLength(2);
    expect(await names({ offset: 1 })).toHaveLength(1);
    expect(await names({ limit: 1 })).toHaveLength(1);
  });

  test("forwards per-browser calls with the prefix stripped", async () => {
    const { session_id } = await client().browsers.create({});
    const result = await client().browsers.process.exec(session_id, {
      command: "ls",
      args: ["/"],
    });
    expect(result).toEqual({ exit_code: 0, stdout_b64: "Lwo=" });
    const exec = fake.requests.find((r) => r.path === "/process/exec")!;
    expect(exec.method).toBe("POST");
    expect(exec.body).toEqual({ command: "ls", args: ["/"] });
    expect(exec.headers.get("authorization")).toBeNull();

    const file = await client().browsers.fs.readFile(session_id, {
      path: "/tmp/a b",
    });
    expect(await file.text()).toBe("hello");
    expect(fake.requests.at(-1)?.path).toBe(
      "/fs/read_file?path=%2Ftmp%2Fa%20b",
    );
  });

  test("telemetry events are an empty single page", async () => {
    const { session_id } = await client().browsers.create({});
    const page = await client().browsers.telemetry.events(session_id);
    expect(page.getPaginatedItems()).toEqual([]);
    expect(page.hasNextPage()).toBe(false);
  });

  test("replays map to the recording endpoints", async () => {
    const { session_id } = await client().browsers.create({});
    const replay = await client().browsers.replays.start(session_id, {
      framerate: 10,
    });
    expect(replay.replay_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.requests.at(-1)?.body).toEqual({
      id: replay.replay_id,
      framerate: 10,
    });
    expect(await client().browsers.replays.list(session_id)).toEqual([
      {
        replay_id: replay.replay_id,
        started_at: "2026-10-14T00:00:00Z",
        finished_at: null,
      },
    ]);
    await client().browsers.replays.stop(replay.replay_id, {
      id_or_name: session_id,
    });
    expect(fake.requests.at(-1)).toMatchObject({
      path: "/recording/stop",
      body: { id: replay.replay_id },
    });
  });

  test("update changes only the viewport, through PATCH /display", async () => {
    const { session_id } = await client().browsers.create({});
    const updated = await client().browsers.update(session_id, {
      viewport: { width: 1024, height: 768 },
    });
    expect(fake.requests.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/display",
      body: { width: 1024, height: 768, refresh_rate: 60, require_idle: true },
    });
    expect(updated.viewport).toEqual({
      width: 1024,
      height: 768,
      refresh_rate: 60,
    });
    expect((await client().browsers.retrieve(session_id)).viewport).toEqual(
      updated.viewport,
    );
    const error = await rejection(
      client().browsers.update(session_id, { name: "x" }),
    );
    expect(error.status).toBe(400);
  });

  test("delete without a profile only removes the container", async () => {
    const { session_id } = await client().browsers.create({});
    await client().browsers.deleteByID(session_id);
    expect(removed()).toEqual(["container-1"]);
    expect(fake.events.some((e) => e.startsWith("ws"))).toBe(false);
    expect(fake.requests.some((r) => r.path.startsWith("/fs/download"))).toBe(
      false,
    );
  });

  test("profiles load on create and save on delete after Browser.close", async () => {
    const profile = await client().profiles.create({ name: "Shop" });
    const first = await client().browsers.create({
      profile: { name: "shop", save_changes: true },
    });
    expect(first.profile as unknown).toEqual({ id: profile.id, name: "Shop" });
    expect(first.profile_save_changes).toBe(true);
    expect(
      fake.requests.find((r) => r.path === "/configure")?.form,
    ).not.toHaveProperty("profile_archive");

    fake.events = [];
    await client().browsers.deleteByID(first.session_id);
    expect(fake.events).toEqual([
      "ws Browser.close",
      "POST /process/exec",
      "GET /fs/download_dir_zstd",
    ]);
    expect(fake.requests.find((r) => r.path === "/process/exec")?.body).toEqual(
      {
        command: "supervisorctl",
        args: ["-c", "/etc/supervisor/supervisord.conf", "stop", "chromium"],
      },
    );
    const dir = join(dataDir, "profiles");
    expect(await readFile(join(dir, `${profile.id}.tar.zst`), "utf8")).toBe(
      "ARCHIVE-1",
    );
    expect((await readdir(dir)).sort()).toEqual([
      `${profile.id}.json`,
      `${profile.id}.tar.zst`,
    ]);

    fake.requests = [];
    await client().browsers.create({ profile: { id: profile.id } });
    expect(
      fake.requests.find((r) => r.path === "/configure")?.form?.profile_archive,
    ).toBe("ARCHIVE-1");
    expect((await client().profiles.retrieve(profile.id)).last_used_at).toEqual(
      expect.any(String),
    );
  });

  test("the reaper removes idle browsers, saving profiles, and keeps active ones", async () => {
    await client().profiles.create({ name: "idle" });
    const idle = await client().browsers.create({
      timeout_seconds: 10,
      profile: { name: "idle", save_changes: true },
    });
    const busy = await client().browsers.create({ timeout_seconds: 60 });

    clock += 8_000;
    await client().browsers.process.exec(idle.session_id, { command: "true" });
    clock += 8_000;
    await client().browsers.create({});
    expect(removed()).toEqual([]);

    clock += 11_000;
    await client().browsers.create({});
    expect(removed()).toEqual(["container-1"]);
    expect(fake.events).toContain("ws Browser.close");
    const ids = (await client().browsers.list())
      .getPaginatedItems()
      .map((b) => b.session_id);
    expect(ids).toContain(busy.session_id);
    expect(ids).not.toContain(idle.session_id);

    // A restarted server has no activity history: idle time starts fresh.
    adapter = createLocalKernelFetch({
      docker: docker.docker,
      now: () => clock,
    });
    clock += 1_000_000;
    await client().browsers.list();
    await client().browsers.create({});
    expect(removed()).toEqual(["container-1"]);
  });
});

describe("local profiles", () => {
  test("create, list, retrieve, rename and delete follow the SDK shapes", async () => {
    const alpha = await client().profiles.create({ name: "Alpha" });
    expect(alpha).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      name: "Alpha",
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(
      (await rejection(client().profiles.create({ name: "alpha" }))).status,
    ).toBe(409);

    const byName = [];
    for await (const p of client().profiles.list({ name: "ALPHA" }))
      byName.push(p.id);
    expect(byName).toEqual([alpha.id]);
    const byQuery = await client().profiles.list({ query: "lph" });
    expect(byQuery.getPaginatedItems().map((p) => p.id)).toEqual([alpha.id]);
    expect((await client("tok-bob").profiles.retrieve("alpha")).id).toBe(
      alpha.id,
    );

    const beta = await client().profiles.update(alpha.id, { name: "Beta" });
    expect(beta.name).toBe("Beta");
    await client().profiles.create({ name: "Gamma" });
    expect(
      (await rejection(client().profiles.update("Gamma", { name: "beta" })))
        .status,
    ).toBe(409);

    await client().profiles.delete("beta");
    expect((await rejection(client().profiles.retrieve(alpha.id))).status).toBe(
      404,
    );
  });
});
