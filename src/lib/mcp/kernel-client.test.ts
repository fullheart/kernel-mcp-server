import { describe, expect, test } from "bun:test";
import { createKernelClient } from "@/lib/mcp/kernel-client";

describe("createKernelClient", () => {
  test("disables SDK payload logging even when KERNEL_LOG requests debug", () => {
    const previous = process.env.KERNEL_LOG;
    process.env.KERNEL_LOG = "debug";
    try {
      expect(createKernelClient("test-key").logLevel).toBe("off");
    } finally {
      if (previous === undefined) delete process.env.KERNEL_LOG;
      else process.env.KERNEL_LOG = previous;
    }
  });
  test("routes to the in-process local adapter only in local mode", () => {
    const previous = process.env.KERNEL_MODE;
    try {
      process.env.KERNEL_MODE = "local";
      expect(createKernelClient("test-key").baseURL).toBe(
        "http://kernel.local",
      );
      delete process.env.KERNEL_MODE;
      expect(createKernelClient("test-key").baseURL).not.toBe(
        "http://kernel.local",
      );
    } finally {
      if (previous === undefined) delete process.env.KERNEL_MODE;
      else process.env.KERNEL_MODE = previous;
    }
  });
  test("uses an explicit project before the server default", () => {
    const previous = process.env.KERNEL_PROJECT;
    process.env.KERNEL_PROJECT = "proj_default";
    try {
      expect(createKernelClient("test-key", "proj_explicit").project).toBe(
        "proj_explicit",
      );
      expect(createKernelClient("test-key", "proj_explicit").projectID).toBe(
        null,
      );
      expect(createKernelClient("test-key").project).toBe("proj_default");
    } finally {
      if (previous === undefined) {
        delete process.env.KERNEL_PROJECT;
      } else {
        process.env.KERNEL_PROJECT = previous;
      }
    }
  });
});
