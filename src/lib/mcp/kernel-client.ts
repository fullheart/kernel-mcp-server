import { Kernel } from "@onkernel/sdk";
import { localKernelFetch } from "@/lib/mcp/local/fetch";
import { isLocalMode } from "@/lib/mcp/local/mode";

export function createKernelClient(apiKey: string, project?: string) {
  const local = isLocalMode();
  return new Kernel({
    apiKey,
    // SDK debug logging includes request bodies, which can contain vault secrets.
    logLevel: "off",
    project: project ?? process.env.KERNEL_PROJECT,
    // Local mode answers every SDK call in-process from Docker containers.
    baseURL: local ? "http://kernel.local" : process.env.API_BASE_URL,
    fetch: local ? localKernelFetch : undefined,
    defaultHeaders: {
      "X-Source": "mcp-server",
      "X-Referral-Source": "mcp.onkernel.com",
    },
  });
}

export type KernelClient = ReturnType<typeof createKernelClient>;
