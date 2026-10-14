import { expect, test } from "bun:test";
import {
  type DockerRunner,
  type LocalContainer,
  listContainers,
} from "@/lib/mcp/local/docker";

const noRestore = async () => {};

test("listContainers restarts exited browsers and hides created ones", async () => {
  const states: Record<string, string> = {
    running: "running",
    exited: "exited",
    created: "created",
  };
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "cp") return "";
    if (args[0] === "start") {
      for (const id of args.slice(1)) states[id] = "running";
      return "";
    }
    return Object.entries(states)
      .map(([containerId, state]) =>
        JSON.stringify({
          containerId,
          state,
          image: "img",
          ports: state === "running" ? "127.0.0.1:4000->10001/tcp" : "",
          id: containerId,
          viewport: "1920x1080@25",
        }),
      )
      .join("\n");
  };

  const restored: LocalContainer[] = [];
  const containers = await listContainers(docker, async (c) => {
    restored.push(c);
  });

  const restart = calls.filter((call) => call[0] !== "ps");
  expect(restart.map((call) => call[0])).toEqual(["cp", "start"]);
  expect(restart[0][2]).toBe("exited:/var/run/supervisor.sock");
  expect(restart[1]).toEqual(["start", "exited"]);
  // Restored with the ports of the new start.
  expect(restored.map((c) => [c.containerId, c.apiPort])).toEqual([
    ["exited", 4000],
  ]);
  expect(calls[0]).toContain("-a");
  expect(containers.map((c) => c.containerId)).toEqual(["running", "exited"]);
});

test("listContainers gives up on a browser that exits again after start", async () => {
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] !== "ps") return "";
    return JSON.stringify({
      containerId: "crashing",
      state: "exited",
      image: "img",
      ports: "",
      id: "crashing",
      viewport: "1920x1080@25",
    });
  };

  // Each call used to wait 30 s for the API, past the test timeout.
  expect(await listContainers(docker, noRestore)).toEqual([]);
  expect(await listContainers(docker, noRestore)).toEqual([]);
  expect(calls.filter((call) => call[0] === "start")).toEqual([
    ["start", "crashing"],
  ]);
});

test("listContainers waits for a pass that is still restoring", async () => {
  let state = "exited";
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const docker: DockerRunner = async (args) => {
    if (args[0] === "start") state = "running";
    if (args[0] !== "ps") return "";
    return JSON.stringify({
      containerId: "slow",
      state,
      image: "img",
      ports: "127.0.0.1:4000->10001/tcp",
      id: "slow",
      viewport: "1920x1080@25",
    });
  };

  const first = listContainers(docker, () => gate);
  while (state !== "running") await Bun.sleep(5);
  let done = false;
  const second = listContainers(docker, noRestore).then(() => (done = true));
  await Bun.sleep(100);
  expect(done).toBe(false);
  open();
  await Promise.all([first, second]);
});
