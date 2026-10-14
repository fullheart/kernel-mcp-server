import { execFile } from "node:child_process";
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

export async function listContainers(
  docker: DockerRunner,
  ...labels: string[]
): Promise<LocalContainer[]> {
  const filters = ["kernel.local=1", ...labels].flatMap((label) => [
    "--filter",
    `label=${label}`,
  ]);
  const list = async () => {
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
      .map((line) => JSON.parse(line));
  };
  let rows = await list();
  // A Docker or host restart leaves browsers exited. Starting them again
  // makes them behave like browsers of a restarted server: the reaper saves
  // and removes them after their timeout.
  // ponytail: a container that dies on every start is started again on every
  // call. Remember failed ids if that ever happens.
  const exited = rows.filter((row) => row.state === "exited");
  if (exited.length) {
    await docker(["start", ...exited.map((row) => row.containerId)]).catch(
      (error) => console.error("Failed to start stopped local browsers", error),
    );
    rows = await list();
  }
  // Created containers may belong to a `docker run` that is still starting.
  return rows
    .filter(
      (row) => !["created", "exited", "dead", "removing"].includes(row.state),
    )
    .map((row) => {
      const port = (inner: number) =>
        Number(row.ports.match(new RegExp(`:(\\d+)->${inner}/tcp`))?.[1]);
      return {
        containerId: row.containerId,
        image: row.image,
        apiPort: port(10001),
        cdpPort: port(9222),
        labels: Object.fromEntries(
          LABELS.map((label) => [label, row[label] ?? ""]),
        ) as LocalContainer["labels"],
      };
    });
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
