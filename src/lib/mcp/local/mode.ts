export function isLocalMode() {
  return process.env.KERNEL_MODE === "local";
}

export const LOCAL_TOOLSETS = [
  "browsers",
  "shell",
  "computer",
  "browser_files",
  "playwright",
  "repl",
  "webmcp",
  "replays",
  "profiles",
] as const;
