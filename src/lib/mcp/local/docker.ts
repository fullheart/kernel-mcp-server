import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export type DockerRunner = (args: string[]) => Promise<string>;

// Errors the local adapter turns into JSON responses with this status.
export class LocalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const execFileAsync = promisify(execFile);

export const runDocker: DockerRunner = async (args) => {
  try {
    const { stdout } = await execFileAsync("docker", args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      `docker ${args[0]} failed: ${stderr || (error as Error).message}`,
    );
  }
};

export const LABELS = [
  "id",
  "owner",
  "name",
  "timeout",
  "created",
  "viewport",
  "kiosk",
  "profile",
  "save_profile",
] as const;

export type LocalContainer = {
  containerId: string;
  image: string;
  apiPort: number;
  cdpPort: number;
  labels: Record<(typeof LABELS)[number], string>;
};

// Labels are read one by one: `docker ps` joins all labels into one string
// that cannot be split safely when a browser name contains a comma.
const PS_FORMAT = `{"containerId":{{json .ID}},"image":{{json .Image}},"state":{{json .State}},"ports":{{json .Ports}}${LABELS.map(
  (label) => `,"${label}":{{json (.Label "kernel.local.${label}")}}`,
).join("")}}`;

type Row = LocalContainer & { state: string };

// One restart pass at a time, so no pass copies over the socket of a browser
// that another pass has already started.
let restarting: Promise<void> = Promise.resolve();

export async function listContainers(
  docker: DockerRunner,
  ...labels: string[]
): Promise<LocalContainer[]> {
  const filters = ["kernel.local=1", ...labels].flatMap((label) => [
    "--filter",
    `label=${label}`,
  ]);
  const list = async (): Promise<Row[]> => {
    const output = await docker([
      "ps",
      "-a",
      "--no-trunc",
      ...filters,
      "--format",
      PS_FORMAT,
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line);
        const port = (inner: number) =>
          Number(row.ports.match(new RegExp(`:(\\d+)->${inner}/tcp`))?.[1]);
        return {
          containerId: row.containerId,
          image: row.image,
          state: row.state,
          apiPort: port(10001),
          cdpPort: port(9222),
          labels: Object.fromEntries(
            LABELS.map((label) => [label, row[label] ?? ""]),
          ) as LocalContainer["labels"],
        };
      });
  };
  let rows = await list();
  if (rows.some((row) => row.state === "exited")) {
    restarting = restarting
      .then(() => startExited(docker, list))
      .catch((error) =>
        console.error("Failed to start stopped local browsers", error),
      );
    await restarting;
    rows = await list();
  }
  // Created containers may belong to a `docker run` that is still starting.
  return rows.filter(
    (row) => !["created", "exited", "dead", "removing"].includes(row.state),
  );
}

// A Docker or host restart leaves browsers exited. Starting them again
// makes them behave like browsers of a restarted server: the reaper saves
// and removes them after their timeout.
// ponytail: a container that dies on every start is started again on every
// call. Remember failed ids if that ever happens.
async function startExited(docker: DockerRunner, list: () => Promise<Row[]>) {
  const exited = (await list()).filter((row) => row.state === "exited");
  if (!exited.length) return;
  // The image's wrapper waits for supervisord's socket file. The file left
  // by the last run is there at once, so the wrapper calls supervisorctl
  // before supervisord listens, and Xorg and the API never start. A plain
  // file is not a socket, so the wrapper waits; supervisord replaces it.
  // ponytail: tied to the wrapper of the pinned image. Drop it once
  // kernel-images removes the stale socket itself.
  const dir = await mkdtemp(join(tmpdir(), "kernel-local-"));
  const placeholder = join(dir, "supervisor.sock");
  const started = new Set<string>();
  try {
    await writeFile(placeholder, "");
    await Promise.all(
      exited.map(async ({ containerId }) => {
        try {
          await docker([
            "cp",
            placeholder,
            `${containerId}:/var/run/supervisor.sock`,
          ]);
          await docker(["start", containerId]);
          started.add(containerId);
        } catch (error) {
          console.error("Failed to start stopped local browser", error);
        }
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // The ports change on start, so list again.
  const rows = (await list()).filter((row) => started.has(row.containerId));
  await Promise.all(
    rows.map((row) =>
      restoreViewport(row).catch((error) =>
        console.error("Failed to restore local browser viewport", error),
      ),
    ),
  );
}

// Xorg comes back at its 3840x2160 boot mode, so the labeled viewport is set
// again. Retrying until the API answers also keeps the browser out of use
// until it is ready.
async function restoreViewport(container: LocalContainer) {
  const [, width, height, rate] =
    container.labels.viewport.match(/^(\d+)x(\d+)(?:@(\d+))?$/) ?? [];
  const body = JSON.stringify({
    width: Number(width),
    height: Number(height),
    ...(rate && { refresh_rate: Number(rate) }),
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${apiBase(container)}/display`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => null);
    if (response) {
      if (!response.ok) throw new Error(await errorText(response));
      await response.body?.cancel();
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("browser did not become ready within 30s");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export const apiBase = (container: LocalContainer) =>
  `http://127.0.0.1:${container.apiPort}`;

// kernel-images errors are JSON {message} for declared responses and plain
// text otherwise (router 404, bad JSON).
export async function errorText(response: Response) {
  const text = await response.text();
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text || `status ${response.status}`;
  }
}
