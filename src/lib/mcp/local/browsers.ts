import { randomBytes } from "node:crypto";
import type {
  BrowserCreateParams,
  BrowserRetrieveResponse,
  BrowserUpdateParams,
  Profile,
} from "@onkernel/sdk/resources/browsers/browsers";
import type { BrowserViewport } from "@onkernel/sdk/resources/shared";
import {
  apiBase,
  errorText,
  listContainers,
  LocalError,
  type DockerRunner,
  type LocalContainer,
} from "@/lib/mcp/local/docker";
import {
  findProfile,
  loadProfileArchive,
  saveProfile,
} from "@/lib/mcp/local/profiles";

type Viewport = Required<BrowserViewport>;

// Fields without a local meaning (live view, base_url, region, memory, ...)
// are left out. base_url would also make the SDK bypass this adapter.
export type LocalBrowser = Pick<
  BrowserRetrieveResponse,
  | "session_id"
  | "name"
  | "created_at"
  | "timeout_seconds"
  | "cdp_ws_url"
  | "viewport"
  | "kiosk_mode"
  | "headless"
  | "stealth"
  | "profile_save_changes"
> & { profile?: Pick<Profile, "id" | "name"> };

export type LocalRuntime = {
  docker: DockerRunner;
  now: () => number;
  // Session id to last adapter call. Lost on restart; idle time starts fresh.
  activity: Map<string, number>;
  // Viewport after PATCH. Lost on restart; falls back to the label.
  viewports: Map<string, Viewport>;
  modes: Map<string, Promise<Viewport[]>>;
  lock: Promise<unknown>;
  reaping?: Promise<void>;
};

const DEFAULT_IMAGE = "onkernel/chromium-headful:c1128b7";
const DEFAULT_VIEWPORT = { width: 1920, height: 1080, refresh_rate: 25 };

// No local effect, but accepted so cloud habits keep working. Anything else
// (proxies, extensions, vaults, network, tags, ...) gets a 400.
const CREATE_KEYS = new Set<string>([
  "name",
  "timeout_seconds",
  "viewport",
  "kiosk_mode",
  "profile",
  "start_url",
  "chrome_policy",
  "stealth",
  "headless",
  "gpu",
  "region",
  "memory",
  "telemetry",
  "invocation_id",
] satisfies Array<keyof BrowserCreateParams>);

const formatViewport = (v: BrowserViewport) =>
  `${v.width}x${v.height}${v.refresh_rate ? `@${v.refresh_rate}` : ""}`;

function parseViewport(label: string): BrowserViewport | undefined {
  const match = label.match(/^(\d+)x(\d+)(?:@(\d+))?$/);
  if (!match) return undefined;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    ...(match[3] && { refresh_rate: Number(match[3]) }),
  };
}

// xrandr only switches to modes predefined in the image's xorg.conf, at
// exactly the listed refresh rate.
function modesFor(rt: LocalRuntime, container: LocalContainer) {
  let modes = rt.modes.get(container.image);
  if (!modes) {
    modes = fetch(
      `${apiBase(container)}/fs/read_file?path=/etc/neko/xorg.conf`,
    ).then(async (response) => {
      if (!response.ok) {
        throw new Error(`cannot read xorg.conf: ${await errorText(response)}`);
      }
      const text = await response.text();
      return (text.match(/Modeline\s+"\d+x\d+_\d+/g) ?? []).map((mode) => {
        const [width, height, refresh_rate] = mode.match(/\d+/g)!.map(Number);
        return { width, height, refresh_rate };
      });
    });
    rt.modes.set(container.image, modes);
    modes.catch(() => rt.modes.delete(container.image));
  }
  return modes;
}

function resolveViewport(modes: Viewport[], requested: BrowserViewport) {
  const rates = modes
    .filter((m) => m.width === requested.width && m.height === requested.height)
    .map((m) => m.refresh_rate);
  const refresh_rate = requested.refresh_rate ?? Math.max(...rates);
  if (rates.indexOf(refresh_rate) === -1) {
    const sizes = new Map<string, number[]>();
    for (const m of modes) {
      const size = `${m.width}x${m.height}`;
      sizes.set(size, [...(sizes.get(size) ?? []), m.refresh_rate]);
    }
    const supported = [...sizes].map(
      ([size, list]) => `${size}@${list.join("/")}`,
    );
    throw new LocalError(
      400,
      `viewport ${formatViewport(requested)} is not supported in local mode. supported: ${supported.join(", ")}`,
    );
  }
  return { width: requested.width, height: requested.height, refresh_rate };
}

export async function toBrowser(
  rt: LocalRuntime,
  container: LocalContainer,
): Promise<LocalBrowser> {
  const { labels } = container;
  const profile = labels.profile
    ? await findProfile(labels.profile).catch(() => null)
    : null;
  return {
    session_id: labels.id,
    ...(labels.name && { name: labels.name }),
    created_at: labels.created,
    timeout_seconds: Number(labels.timeout),
    cdp_ws_url: `ws://${process.env.KERNEL_LOCAL_PUBLIC_HOST ?? "localhost"}:${container.cdpPort}/`,
    viewport: rt.viewports.get(labels.id) ?? parseViewport(labels.viewport),
    kiosk_mode: labels.kiosk === "true",
    headless: false,
    stealth: false,
    ...(labels.profile && {
      profile: { id: labels.profile, name: profile?.name ?? null },
      profile_save_changes: labels.save_profile === "true",
    }),
  };
}

export async function listBrowsers(rt: LocalRuntime, owner: string) {
  const containers = await listContainers(
    rt.docker,
    `kernel.local.owner=${owner}`,
  );
  return Promise.all(containers.map((container) => toBrowser(rt, container)));
}

export async function findBrowser(
  rt: LocalRuntime,
  owner: string,
  idOrName: string,
) {
  const containers = await listContainers(
    rt.docker,
    `kernel.local.owner=${owner}`,
  );
  const container =
    containers.find((c) => c.labels.id === idOrName) ??
    containers.find((c) => c.labels.name === idOrName);
  if (!container) throw new LocalError(404, "browser not found");
  rt.activity.set(container.labels.id, rt.now());
  return container;
}

// The in-process lock is a promise chain: count, name check and docker run
// happen for one create at a time, so parallel creates cannot overshoot the
// cap. ponytail: one lock per process; several MCP processes can still race.
function withLock<T>(rt: LocalRuntime, fn: () => Promise<T>) {
  const run = rt.lock.then(fn);
  rt.lock = run.catch(() => undefined);
  return run;
}

async function waitReady(container: LocalContainer, signal?: AbortSignal) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    signal?.throwIfAborted();
    const response = await fetch(`${apiBase(container)}/spec.yaml`, {
      signal,
    }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) return;
    if (Date.now() > deadline) {
      throw new Error("browser container did not become ready within 30s");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function createBrowser(
  rt: LocalRuntime,
  owner: string,
  params: BrowserCreateParams,
  signal?: AbortSignal,
) {
  const unsupported = Object.keys(params).find((key) => !CREATE_KEYS.has(key));
  if (unsupported) {
    throw new LocalError(400, `${unsupported} is not supported in local mode`);
  }
  const timeout = params.timeout_seconds ?? 60;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 259200) {
    throw new LocalError(400, "timeout_seconds must be between 10 and 259200");
  }
  const profileRef = params.profile?.id ?? params.profile?.name;
  if (params.profile && !profileRef) {
    throw new LocalError(400, "profile needs an id or a name");
  }
  const profile = profileRef ? await findProfile(profileRef) : null;
  const image = process.env.KERNEL_LOCAL_IMAGE ?? DEFAULT_IMAGE;
  const requested = params.viewport ?? DEFAULT_VIEWPORT;
  // The mode list comes from a running container, so the first create per
  // image may label a viewport without its resolved refresh rate.
  const knownModes = await rt.modes.get(image)?.catch(() => undefined);
  const labelViewport = knownModes
    ? resolveViewport(knownModes, requested)
    : requested;
  const id = randomBytes(12).toString("hex");
  const labels = {
    "kernel.local": "1",
    "kernel.local.id": id,
    "kernel.local.owner": owner,
    "kernel.local.name": params.name ?? "",
    "kernel.local.timeout": String(timeout),
    "kernel.local.created": new Date(rt.now()).toISOString(),
    "kernel.local.viewport": formatViewport(labelViewport),
    "kernel.local.kiosk": String(params.kiosk_mode === true),
    "kernel.local.profile": profile?.id ?? "",
    "kernel.local.save_profile": String(
      !!profile && params.profile?.save_changes === true,
    ),
  };

  await reapIdle(rt);
  const containerId = await withLock(rt, async () => {
    const running = await listContainers(rt.docker);
    const max = Number(process.env.KERNEL_LOCAL_MAX_BROWSERS) || 5;
    if (running.length >= max) {
      throw new LocalError(
        429,
        `local browser limit reached (${max}). delete a browser or raise KERNEL_LOCAL_MAX_BROWSERS`,
      );
    }
    if (
      params.name &&
      running.some(
        (c) => c.labels.owner === owner && c.labels.name === params.name,
      )
    ) {
      throw new LocalError(409, `browser "${params.name}" already exists`);
    }
    const tz =
      process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Not passed the signal: killing the CLI mid-run can still leave a
    // container behind, so cleanup happens below instead.
    const output = await rt.docker([
      "run",
      "-d",
      "--pull",
      "never",
      "--privileged",
      "--tmpfs",
      "/dev/shm:size=2g",
      "--memory",
      "8192m",
      "--add-host=host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::10001",
      "-p",
      "127.0.0.1::9222",
      "-e",
      "ENABLE_WEBRTC=false",
      "-e",
      `TZ=${tz}`,
      ...Object.entries(labels).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
      image,
    ]);
    return output.trim();
  });

  try {
    signal?.throwIfAborted();
    const [container] = await listContainers(
      rt.docker,
      `kernel.local.id=${id}`,
    );
    if (!container) throw new Error("browser container exited during start");
    await waitReady(container, signal);
    const viewport = resolveViewport(await modesFor(rt, container), requested);
    const form = new FormData();
    form.append("display", JSON.stringify(viewport));
    if (params.kiosk_mode) {
      form.append("chromium_flags", JSON.stringify({ flags: ["--kiosk"] }));
    }
    if (params.chrome_policy && Object.keys(params.chrome_policy).length) {
      form.append("chrome_policies", JSON.stringify(params.chrome_policy));
    }
    const archive = profile && (await loadProfileArchive(profile));
    if (archive) form.append("profile_archive", archive, "profile.tar.zst");
    if (params.start_url) form.append("start_url", params.start_url);
    const response = await fetch(`${apiBase(container)}/configure`, {
      method: "POST",
      body: form,
      signal,
    });
    if (!response.ok) {
      throw new LocalError(
        response.status === 400 ? 400 : 500,
        `browser configure failed: ${await errorText(response)}`,
      );
    }
    rt.viewports.set(id, viewport);
    rt.activity.set(id, rt.now());
    return toBrowser(rt, container);
  } catch (error) {
    await rt
      .docker(["rm", "-f", containerId])
      .catch((rmError) =>
        console.error("Failed to remove local browser container", rmError),
      );
    throw error;
  }
}

export async function updateBrowser(
  rt: LocalRuntime,
  container: LocalContainer,
  params: BrowserUpdateParams,
) {
  const { viewport, ...rest } = params;
  const other = Object.keys(rest)[0];
  if (other || !viewport) {
    throw new LocalError(
      400,
      `${other ?? "this update"} is not supported in local mode. only viewport can be updated`,
    );
  }
  const resolved = resolveViewport(await modesFor(rt, container), viewport);
  const response = await fetch(`${apiBase(container)}/display`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...resolved, require_idle: !viewport.force }),
  });
  if (!response.ok) {
    throw new LocalError(
      response.status,
      `viewport update failed: ${await errorText(response)}`,
    );
  }
  rt.viewports.set(container.labels.id, resolved);
  return toBrowser(rt, container);
}

export async function removeBrowser(
  rt: LocalRuntime,
  container: LocalContainer,
) {
  if (container.labels.save_profile === "true") {
    // A failed save keeps the container so the profile data is not lost.
    await saveProfile(container).catch((error) => {
      throw new Error(`profile save failed, browser kept: ${error.message}`);
    });
  }
  await rt.docker(["rm", "-f", container.containerId]);
  rt.activity.delete(container.labels.id);
  rt.viewports.delete(container.labels.id);
}

// Runs at the start of each local request and every 60 s. Concurrent calls
// share one pass.
export function reapIdle(rt: LocalRuntime) {
  rt.reaping ??= (async () => {
    try {
      const now = rt.now();
      for (const container of await listContainers(rt.docker)) {
        const id = container.labels.id;
        if (!rt.activity.has(id)) rt.activity.set(id, now);
        const idleMs = now - rt.activity.get(id)!;
        if (idleMs < Number(container.labels.timeout) * 1000) continue;
        await removeBrowser(rt, container).catch((error) =>
          console.error("Failed to remove idle local browser", error),
        );
      }
    } catch (error) {
      console.error("Local browser reaper failed", error);
    } finally {
      rt.reaping = undefined;
    }
  })();
  return rt.reaping;
}
