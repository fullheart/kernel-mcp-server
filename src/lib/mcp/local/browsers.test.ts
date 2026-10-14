import { describe, expect, test } from "bun:test";
import {
  createBrowser,
  listBrowsers,
  reapIdle,
  removeBrowser,
  trackCall,
  type LocalRuntime,
} from "@/lib/mcp/local/browsers";
import type { DockerRunner, LocalContainer } from "@/lib/mcp/local/docker";

const labels = { id: "b1", owner: "alice", timeout: "10" };

function runtime(docker: DockerRunner) {
  let clock = 0;
  const rt: LocalRuntime = {
    docker,
    now: () => clock,
    activity: new Map(),
    viewports: new Map(),
    modes: new Map(),
    lock: Promise.resolve(),
  };
  return { rt, tick: (ms: number) => (clock += ms) };
}

// One running browser until `docker rm`.
function oneBrowser() {
  const calls: string[][] = [];
  let running = true;
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "rm") running = false;
    if (args[0] !== "ps" || !running) return "";
    return JSON.stringify({ containerId: "c1", image: "img", ports: "" });
  };
  const removed = () => calls.filter((c) => c[0] === "rm");
  return { docker, removed };
}

// listContainers reads labels as top-level fields of the ps JSON.
const withLabels =
  (docker: DockerRunner): DockerRunner =>
  async (args) => {
    const out = await docker(args);
    return out && JSON.stringify({ ...JSON.parse(out), ...labels });
  };

describe("local browser lifecycle", () => {
  test("the reaper keeps a browser while a call runs and its body is read", async () => {
    const { docker, removed } = oneBrowser();
    const { rt, tick } = runtime(withLabels(docker));
    rt.activity.set("b1", 0);

    let respond!: (response: Response) => void;
    const call = trackCall(
      rt,
      "b1",
      new Promise<Response>((resolve) => (respond = resolve)),
    );
    tick(11_000);
    await reapIdle(rt);
    expect(removed()).toEqual([]);

    let push!: ReadableStreamDefaultController<Uint8Array>;
    respond(new Response(new ReadableStream({ start: (c) => (push = c) })));
    const reader = (await call).body!.getReader();
    tick(9_000);
    push.enqueue(new Uint8Array([1]));
    await reader.read();
    tick(9_000);
    await reapIdle(rt);
    expect(removed()).toEqual([]);

    // A body nobody reads or cancels no longer holds the browser.
    tick(2_000);
    await reapIdle(rt);
    expect(removed()).toEqual([["rm", "-f", "c1"]]);
  });

  test("a delete and the reaper share one removal", async () => {
    const { docker, removed } = oneBrowser();
    const { rt } = runtime(docker);
    const container = {
      containerId: "c1",
      labels: { ...labels, save_profile: "false" },
    } as LocalContainer;
    await Promise.all([
      removeBrowser(rt, container),
      removeBrowser(rt, container),
    ]);
    expect(removed()).toHaveLength(1);
  });

  test("a failed docker run removes the container it created", async () => {
    const calls: string[][] = [];
    const { rt } = runtime(async (args) => {
      calls.push(args);
      if (args[0] === "run") throw new Error("docker run failed: oci");
      return args.includes("-aq") ? "created1\n" : "";
    });
    await expect(createBrowser(rt, "alice", {})).rejects.toThrow("oci");
    expect(calls.at(-1)).toEqual(["rm", "-f", "created1"]);
  });

  test("an abort ends a create that waits on a stuck reaper", async () => {
    const calls: string[][] = [];
    const { rt } = runtime(async (args) => {
      calls.push(args);
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const create = createBrowser(rt, "alice", {}, controller.signal);
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    controller.abort();
    await expect(create).rejects.toThrow();
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  test("a browser restarted by Docker gets its last viewport back", async () => {
    const patched: unknown[] = [];
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/fs/read_file") {
          return new Response(
            'Modeline "1280x720_30.00"\nModeline "1280x720_60.00"\nModeline "1024x768_60.00"',
          );
        }
        if (req.method === "PATCH") patched.push(await req.json());
        return new Response("ok");
      },
    });
    const state: Record<string, string> = { r1: "exited", r2: "exited" };
    const { rt } = runtime(async (args) => {
      if (args[0] === "start") state[args[1]] = "running";
      if (args[0] !== "ps") return "";
      return Object.entries(state)
        .map(([id, s]) =>
          JSON.stringify({
            containerId: id,
            state: s,
            image: "restore-img",
            ports: s === "running" ? `127.0.0.1:${api.port}->10001/tcp` : "",
            id,
            owner: "alice",
            timeout: "60",
            viewport: "1280x720",
          }),
        )
        .join("\n");
    });
    // r1 was updated after create; r2 only has its label, without a rate.
    rt.viewports.set("r1", { width: 1024, height: 768, refresh_rate: 60 });
    // next dev tees GET bodies and keeps one branch unread, so cancelling
    // the other never settles.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const response = await realFetch(input, init);
      if (init?.method || !response.body) return response;
      const [, branch] = response.body.tee();
      return new Response(branch, response);
    }) as typeof fetch;
    const browsers = await listBrowsers(rt, "alice").finally(() => {
      globalThis.fetch = realFetch;
      api.stop();
    });
    const r1 = { width: 1024, height: 768, refresh_rate: 60 };
    const r2 = { width: 1280, height: 720, refresh_rate: 60 };
    expect(patched).toHaveLength(2);
    expect(patched).toEqual(expect.arrayContaining([r1, r2]));
    expect(browsers.map((b) => b.viewport)).toEqual([r1, r2]);
  });
});
