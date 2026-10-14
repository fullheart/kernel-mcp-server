import { describe, expect, test } from "bun:test";
import {
  createBrowser,
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
});
