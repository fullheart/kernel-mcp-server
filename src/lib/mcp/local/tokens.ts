import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

// LOCAL_MCP_TOKENS="alice:tok1,bob:tok2". The bearer token picks the owner.
export function ownerForToken(token: string): string | null {
  for (const pair of (process.env.LOCAL_MCP_TOKENS ?? "").split(",")) {
    const separator = pair.indexOf(":");
    const owner = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (
      separator > 0 &&
      owner &&
      value &&
      timingSafeEqual(digest(value), digest(token))
    ) {
      return owner;
    }
  }
  return null;
}
