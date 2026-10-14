import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

let handleRequest: (
  auth: { protect: () => Promise<void> },
  request: NextRequest,
) => Promise<void>;
const clerkProxy = mock(async () => {});
const clerk = await import("@clerk/nextjs/server");
mock.module("@clerk/nextjs/server", () => ({
  ...clerk,
  clerkMiddleware: (handler: typeof handleRequest) => {
    handleRequest = handler;
    return clerkProxy;
  },
}));
const { default: proxy } = await import("./proxy");

describe("MCP discovery through middleware", () => {
  test.each(["GET", "POST", "OPTIONS"])(
    "lets unauthenticated %s /mcp reach the bearer-token gate",
    async (method) => {
      const protect = mock(async () => {});
      await handleRequest(
        { protect },
        new NextRequest("https://mcp.example.test/mcp", { method }),
      );
      expect(protect).not.toHaveBeenCalled();
    },
  );

  test("lets API keys reach the MCP route's credential validation", async () => {
    const protect = mock(async () => {});
    await handleRequest(
      { protect },
      new NextRequest("https://mcp.example.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer sk_test_key" },
      }),
    );
    expect(protect).not.toHaveBeenCalled();
  });

  test.each(["GET", "POST", "OPTIONS"])(
    "does not bypass Clerk for %s on other /mcp-prefixed paths",
    async (method) => {
      const protect = mock(async () => {});
      await handleRequest(
        { protect },
        new NextRequest("https://mcp.example.test/mcp-other", {
          method,
          headers: { Authorization: "Bearer sk_test_key" },
        }),
      );
      expect(protect).toHaveBeenCalledTimes(1);
    },
  );

  test("keeps organization selection protected by Clerk", async () => {
    const protect = mock(async () => {});
    await handleRequest(
      { protect },
      new NextRequest("https://mcp.example.test/select-org"),
    );
    expect(protect).toHaveBeenCalledTimes(1);
  });
});

describe("local mode", () => {
  const mcpRequest = () =>
    new NextRequest("https://mcp.example.test/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token" },
    });

  test("passes /mcp through without running Clerk", async () => {
    const previous = process.env.KERNEL_MODE;
    process.env.KERNEL_MODE = "local";
    clerkProxy.mockClear();
    try {
      expect(await proxy(mcpRequest(), {} as never)).toBeUndefined();
      expect(clerkProxy).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.KERNEL_MODE;
      else process.env.KERNEL_MODE = previous;
    }
  });

  test("keeps Clerk in front of every request in cloud mode", async () => {
    const previous = process.env.KERNEL_MODE;
    delete process.env.KERNEL_MODE;
    clerkProxy.mockClear();
    try {
      await proxy(mcpRequest(), {} as never);
      expect(clerkProxy).toHaveBeenCalledTimes(1);
    } finally {
      if (previous !== undefined) process.env.KERNEL_MODE = previous;
    }
  });
});
