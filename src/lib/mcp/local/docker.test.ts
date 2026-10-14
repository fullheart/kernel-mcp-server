import { expect, test } from "bun:test";
import { type DockerRunner, listContainers } from "@/lib/mcp/local/docker";

const displays: unknown[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    displays.push([req.method, new URL(req.url).pathname, await req.json()]);
    return Response.json({});
  },
});

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
          ports: `127.0.0.1:${server.port}->10001/tcp`,
          id: containerId,
          viewport: "1920x1080@25",
        }),
      )
      .join("\n");
  };

  const containers = await listContainers(docker);

  const restart = calls.filter((call) => call[0] !== "ps");
  expect(restart.map((call) => call[0])).toEqual(["cp", "start"]);
  expect(restart[0][2]).toBe("exited:/var/run/supervisor.sock");
  expect(restart[1]).toEqual(["start", "exited"]);
  expect(displays).toEqual([
    ["PATCH", "/display", { width: 1920, height: 1080, refresh_rate: 25 }],
  ]);
  expect(calls[0]).toContain("-a");
  expect(containers.map((c) => c.containerId)).toEqual(["running", "exited"]);
  expect(containers[1].apiPort).toBe(server.port!);
});
