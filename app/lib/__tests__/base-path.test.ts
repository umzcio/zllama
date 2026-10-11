import { describe, it, expect, beforeEach, vi } from "vitest";

describe("base-path", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the path unchanged when NEXT_PUBLIC_BASE_PATH is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const { withBasePath, basePath } = await import("@/lib/base-path");
    expect(basePath).toBe("");
    expect(withBasePath("/api/foo")).toBe("/api/foo");
    expect(withBasePath("/")).toBe("/");
    vi.unstubAllEnvs();
  });

  it("prepends the base path to absolute paths", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/zllama");
    const { withBasePath, basePath } = await import("@/lib/base-path");
    expect(basePath).toBe("/zllama");
    expect(withBasePath("/api/dashboard")).toBe("/zllama/api/dashboard");
    expect(withBasePath("/setup")).toBe("/zllama/setup");
    expect(withBasePath("/")).toBe("/zllama/");
    vi.unstubAllEnvs();
  });

  it("does not double-prefix paths that already include the base path", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/zllama");
    const { withBasePath } = await import("@/lib/base-path");
    expect(withBasePath("/zllama/api/foo")).toBe("/zllama/api/foo");
    expect(withBasePath("/zllama")).toBe("/zllama");
    vi.unstubAllEnvs();
  });

  it("leaves relative paths and absolute URLs unchanged", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/zllama");
    const { withBasePath } = await import("@/lib/base-path");
    expect(withBasePath("api/foo")).toBe("api/foo");
    expect(withBasePath("https://example.com/api/foo")).toBe("https://example.com/api/foo");
    expect(withBasePath("http://localhost:3000/api/foo")).toBe("http://localhost:3000/api/foo");
    vi.unstubAllEnvs();
  });

  it("normalizes a value without a leading slash", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "zllama");
    const { withBasePath, basePath } = await import("@/lib/base-path");
    expect(basePath).toBe("/zllama");
    expect(withBasePath("/api/foo")).toBe("/zllama/api/foo");
    vi.unstubAllEnvs();
  });

  it("strips a trailing slash from the configured value", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/zllama/");
    const { withBasePath, basePath } = await import("@/lib/base-path");
    expect(basePath).toBe("/zllama");
    expect(withBasePath("/api/foo")).toBe("/zllama/api/foo");
    vi.unstubAllEnvs();
  });
});
