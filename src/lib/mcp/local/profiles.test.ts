import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalContainer } from "@/lib/mcp/local/docker";
import {
  createProfile,
  deleteProfile,
  findProfile,
  listProfiles,
  renameProfile,
  saveProfile,
} from "@/lib/mcp/local/profiles";

let downloadStarted = () => {};
let gate = Promise.resolve();
let stopExitCode = 0;
let downloads = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/process/exec") {
      return Response.json({ exit_code: stopExitCode });
    }
    if (path !== "/fs/download_dir_zstd") return Response.json({});
    downloads++;
    downloadStarted();
    await gate;
    return new Response("ARCHIVE");
  },
});

const dataDir = await mkdtemp(join(tmpdir(), "local-profiles-"));
const dir = join(dataDir, "profiles");
process.env.KERNEL_LOCAL_DATA_DIR = dataDir;

beforeEach(async () => {
  gate = Promise.resolve();
  stopExitCode = 0;
  downloads = 0;
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  server.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

// The CDP port is the API port, which refuses the WebSocket, so the close
// step fails fast and the save goes on.
const container = (profile: string) =>
  ({
    apiPort: server.port,
    cdpPort: server.port,
    labels: { profile },
  }) as LocalContainer;

// Holds the download until the returned release function runs.
async function startBlockedSave(profile: string) {
  let release = () => {};
  gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (downloadStarted = resolve));
  const save = saveProfile(container(profile));
  await started;
  return { save, release };
}

test("a stray or empty json file does not break profiles", async () => {
  const profile = await createProfile("Shop");
  await writeFile(join(dir, "notes.json"), "");
  await writeFile(join(dir, "other.json"), "{}");
  expect((await listProfiles({})).map((p) => p.id)).toEqual([profile.id]);
  await saveProfile(container(profile.id));
  expect(await readdir(dir)).toContain(`${profile.id}.tar.zst`);
});

test("a read error fails the save instead of skipping it", async () => {
  const profile = await createProfile("Shop");
  await mkdir(join(dir, "broken.json"));
  await expect(saveProfile(container(profile.id))).rejects.toThrow();
});

test("a delete during the download is not undone", async () => {
  const profile = await createProfile("Shop");
  const { save, release } = await startBlockedSave(profile.id);
  await deleteProfile(profile.id);
  release();
  await save;
  expect(await readdir(dir)).toEqual([]);
});

test("a rename during the download is kept", async () => {
  const profile = await createProfile("old-name");
  const { save, release } = await startBlockedSave(profile.id);
  await renameProfile(profile.id, "new-name");
  release();
  await save;
  expect((await findProfile(profile.id)).name).toBe("new-name");
  expect(await readdir(dir)).toContain(`${profile.id}.tar.zst`);
});

test("a failed archive write leaves no temp file", async () => {
  const profile = await createProfile("Shop");
  // A non-empty directory in the way makes the rename fail.
  await mkdir(join(dir, `${profile.id}.tar.zst`, "x"), { recursive: true });
  await expect(saveProfile(container(profile.id))).rejects.toThrow();
  expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("a save fails before the download when chromium did not stop", async () => {
  const profile = await createProfile("Shop");
  stopExitCode = 1;
  await expect(saveProfile(container(profile.id))).rejects.toThrow(
    "exit code 1",
  );
  expect(downloads).toBe(0);
  expect(await readdir(dir)).toEqual([`${profile.id}.json`]);
});

test("parallel creates and renames cannot share a name", async () => {
  const other = await createProfile("other");
  const results = await Promise.allSettled([
    createProfile("Shop"),
    createProfile("shop"),
    renameProfile(other.id, "SHOP"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await listProfiles({ name: "shop" })).toHaveLength(1);
});
