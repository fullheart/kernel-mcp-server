import { expect, test } from "bun:test";
import { type DockerRunner, listContainers } from "@/lib/mcp/local/docker";

test("listContainers starts exited browsers and hides created ones", async () => {
  const states: Record<string, string> = {
    running: "running",
    exited: "exited",
    created: "created",
  };
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
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
          ports: "127.0.0.1:1234->10001/tcp",
          id: containerId,
        }),
      )
      .join("\n");
  };

  const containers = await listContainers(docker);

  expect(calls.filter((call) => call[0] === "start")).toEqual([
    ["start", "exited"],
  ]);
  expect(calls[0]).toContain("-a");
  expect(containers.map((c) => c.containerId)).toEqual(["running", "exited"]);
  expect(containers[1].apiPort).toBe(1234);
});
