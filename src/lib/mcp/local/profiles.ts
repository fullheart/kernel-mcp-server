import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Profile } from "@onkernel/sdk/resources/browsers/browsers";
import {
  apiBase,
  errorText,
  LocalError,
  type LocalContainer,
} from "@/lib/mcp/local/docker";

const profilesDir = () =>
  join(process.env.KERNEL_LOCAL_DATA_DIR ?? "./.local-data", "profiles");
const metaPath = (id: string) => join(profilesDir(), `${id}.json`);
const archivePath = (id: string) => join(profilesDir(), `${id}.tar.zst`);

async function writeAtomic(path: string, data: string | Uint8Array) {
  await mkdir(profilesDir(), { recursive: true });
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// Read-then-write steps run one at a time so a slow save cannot undo a
// rename or bring back a deleted profile.
// ponytail: one queue for all profiles; per-id queues if saves block others.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

const writeProfile = (profile: Profile) =>
  writeAtomic(metaPath(profile.id), JSON.stringify(profile, null, 2));

const sameName = (a: string | null | undefined, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase();

const missing = (error: NodeJS.ErrnoException) =>
  error.code === "ENOENT" ? null : Promise.reject(error);

// A stray or truncated file is skipped so it cannot break every profile
// operation.
function parseProfile(file: string, text: string) {
  try {
    const profile = JSON.parse(text);
    if (
      typeof profile?.id === "string" &&
      typeof profile.created_at === "string"
    ) {
      return profile as Profile;
    }
  } catch {}
  console.warn("Skipping unreadable local profile file", file);
  return null;
}

export async function listProfiles(filter: { name?: string; query?: string }) {
  const files = (await readdir(profilesDir()).catch(missing)) ?? [];
  const profiles = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        readFile(join(profilesDir(), file), "utf8").then(
          (text) => parseProfile(file, text),
          // Deleted between readdir and readFile.
          missing,
        ),
      ),
  );
  const query = filter.query?.toLowerCase();
  return profiles
    .filter((profile): profile is Profile => profile !== null)
    .filter((profile) => !filter.name || sameName(profile.name, filter.name))
    .filter(
      (profile) =>
        !query ||
        profile.id.includes(query) ||
        !!profile.name?.toLowerCase().includes(query),
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Lookups go through the parsed list so a caller-supplied id never becomes
// part of a file path.
export async function findProfile(idOrName: string) {
  const profiles = await listProfiles({});
  const profile =
    profiles.find((p) => p.id === idOrName) ??
    profiles.find((p) => sameName(p.name, idOrName));
  if (!profile) throw new LocalError(404, "profile not found");
  return profile;
}

// Null only for a deleted profile; read errors reject.
const findById = async (id: string) =>
  (await listProfiles({})).find((profile) => profile.id === id) ?? null;

async function assertNameFree(name: string, exceptId?: string) {
  const taken = await listProfiles({ name });
  if (taken.some((profile) => profile.id !== exceptId)) {
    throw new LocalError(409, `profile "${name}" already exists`);
  }
}

export function createProfile(name?: string) {
  return serialized(async () => {
    if (name) await assertNameFree(name);
    const now = new Date().toISOString();
    const profile: Profile = {
      id: randomBytes(12).toString("hex"),
      name: name ?? null,
      created_at: now,
      updated_at: now,
    };
    await writeProfile(profile);
    return profile;
  });
}

export async function renameProfile(idOrName: string, name: unknown) {
  if (typeof name !== "string" || !name) {
    throw new LocalError(400, "name is required");
  }
  return serialized(async () => {
    const profile = await findProfile(idOrName);
    await assertNameFree(name, profile.id);
    const renamed = { ...profile, name, updated_at: new Date().toISOString() };
    await writeProfile(renamed);
    return renamed;
  });
}

export function deleteProfile(idOrName: string) {
  return serialized(async () => {
    const { id } = await findProfile(idOrName);
    await rm(metaPath(id), { force: true });
    await rm(archivePath(id), { force: true });
  });
}

// A profile that was never saved has no archive and starts empty.
export async function loadProfileArchive(profile: Profile) {
  const archive = await readFile(archivePath(profile.id)).catch(missing);
  await serialized(async () => {
    const current = await findById(profile.id);
    if (current) {
      await writeProfile({
        ...current,
        last_used_at: new Date().toISOString(),
      });
    }
  });
  return archive && new Blob([new Uint8Array(archive)]);
}

// Chromium is stopped with SIGKILL, which drops recent cookie and
// localStorage writes. CDP Browser.close flushes them first; supervisord
// restarts Chromium at once, so stop it right after the close.
function closeChromium(cdpPort: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${cdpPort}/`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Browser.close timed out"));
    }, 10_000);
    let sent = false;
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      sent = true;
    };
    // Chromium often drops the socket while closing, which Node reports as
    // an error before the close event. Only a close before the send failed.
    socket.onclose = () => {
      clearTimeout(timer);
      if (sent) resolve();
      else reject(new Error("cdp connection failed"));
    };
  });
}

export async function saveProfile(container: LocalContainer) {
  const id = container.labels.profile;
  if (!(await findById(id))) {
    console.warn("Skipping save for deleted local profile");
    return;
  }
  // Best effort: a retried delete finds Chromium already stopped.
  await closeChromium(container.cdpPort).catch((error) =>
    console.warn("Local profile save: Browser.close failed", error.message),
  );
  // Chromium must be stopped: a file that grows during the download ends the
  // archive early, yet the response is still a 200 that would replace the
  // good one. `stop` also exits 0 when Chromium is not running.
  const stop = await fetch(`${apiBase(container)}/process/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "supervisorctl",
      args: ["-c", "/etc/supervisor/supervisord.conf", "stop", "chromium"],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!stop.ok) {
    throw new Error(`stopping chromium failed: ${await errorText(stop)}`);
  }
  const { exit_code } = (await stop.json()) as { exit_code?: number };
  if (exit_code !== 0) {
    throw new Error(`stopping chromium failed: exit code ${exit_code}`);
  }
  // Timeouts keep a hung container from stalling every reaper pass.
  const response = await fetch(
    `${apiBase(container)}/fs/download_dir_zstd?path=/home/kernel/user-data`,
    { signal: AbortSignal.timeout(300_000) },
  );
  if (!response.ok) {
    throw new Error(`profile download failed: ${await errorText(response)}`);
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  // Read again: the profile may have been renamed or deleted meanwhile.
  await serialized(async () => {
    const profile = await findById(id);
    if (!profile) {
      console.warn("Skipping save for deleted local profile");
      return;
    }
    await writeAtomic(archivePath(id), archive);
    await writeProfile({ ...profile, updated_at: new Date().toISOString() });
  });
}
