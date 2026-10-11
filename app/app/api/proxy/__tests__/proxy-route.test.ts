import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    endpoint: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/validate-api-key", () => ({
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/log-async", () => ({
  logAsync: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  applyDbRateLimitConfig: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 59, resetMs: 1000 })),
}));

import { prisma } from "@/lib/prisma";
import { validateApiKey } from "@/lib/validate-api-key";
import { logAsync } from "@/lib/log-async";

const activeServer = {
  id: "s1",
  name: "primary",
  url: "http://192.168.1.10:11434",
  active: true,
  createdAt: new Date(),
  engine: "ollama",
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.endpoint.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(activeServer);
  (prisma.endpoint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(activeServer);
});

describe("GET /api/proxy/[...path]", () => {
  it("returns 401 for an invalid API key and never calls upstream", async () => {
    (validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false });
    global.fetch = vi.fn() as unknown as typeof fetch;

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const req = new NextRequest("http://localhost/api/proxy/api/tags", {
      headers: { authorization: "Bearer zl-bad" },
    });
    const res = await GET(req, {});
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data).toEqual({ error: "Invalid or revoked API key" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards a valid API key request upstream and logs with the key id", async () => {
    (validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
      keyId: "k1",
    });
    global.fetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const req = new NextRequest("http://localhost/api/proxy/api/tags", {
      headers: { authorization: "Bearer zl-good" },
    });
    const res = await GET(req, {});

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `${activeServer.url}/api/tags`
    );
    expect(logAsync).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: "k1" })
    );
  });

  it("returns 404 when no server is found", async () => {
    (prisma.endpoint.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    global.fetch = vi.fn() as unknown as typeof fetch;

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const req = new NextRequest("http://localhost/api/proxy/api/tags");
    const res = await GET(req, {});

    expect(res.status).toBe(404);
  });

  it("returns 403 for an inactive server and never calls upstream", async () => {
    (prisma.endpoint.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...activeServer,
      active: false,
    });
    global.fetch = vi.fn() as unknown as typeof fetch;

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const req = new NextRequest("http://localhost/api/proxy/api/tags");
    const res = await GET(req, {});

    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 502 when the upstream fetch rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("connection refused")) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const req = new NextRequest("http://localhost/api/proxy/api/tags");
    const res = await GET(req, {});

    expect(res.status).toBe(502);
    expect(logAsync).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 502 })
    );
  });

  it("rejects a path that is not allowlisted for the engine", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const { POST } = await import("@/app/api/proxy/[...path]/route");
    const req = new NextRequest("http://localhost/api/proxy/collective_rpc", {
      method: "POST",
      body: "{}",
    });
    const res = await POST(req, {});

    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still forwards an allowlisted path", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;
    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const req = new NextRequest("http://localhost/api/proxy/api/tags");
    const res = await GET(req, {});

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
