import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    log: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
  requireAdminAuth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAuth, requireAdminAuth } from "@/lib/require-auth";

beforeEach(() => {
  vi.clearAllMocks();
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "u1",
    role: "user",
  });
  (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "admin_1",
    role: "admin",
  });
});

describe("DELETE /api/logs", () => {
  it("purges logs before a given date", async () => {
    (prisma.log.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 42,
    });

    const { DELETE } = await import("@/app/api/logs/route");
    const req = new NextRequest(
      "http://localhost/api/logs?before=2025-01-01T00:00:00Z",
      { method: "DELETE" }
    );
    const res = await DELETE(req);
    const data = await res.json();

    expect(data.deleted).toBe(42);
    expect(prisma.log.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2025-01-01T00:00:00Z") } },
    });
  });

  it("returns 400 when before parameter is missing", async () => {
    const { DELETE } = await import("@/app/api/logs/route");
    const req = new NextRequest("http://localhost/api/logs", {
      method: "DELETE",
    });
    const res = await DELETE(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 when before parameter is invalid", async () => {
    const { DELETE } = await import("@/app/api/logs/route");
    const req = new NextRequest(
      "http://localhost/api/logs?before=garbage",
      { method: "DELETE" }
    );
    const res = await DELETE(req);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/logs", () => {
  it("returns 400 for a non-numeric limit parameter", async () => {
    const { GET } = await import("@/app/api/logs/route");
    const req = new NextRequest("http://localhost/api/logs?limit=abc");
    const res = await GET(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 when limit exceeds the ceiling", async () => {
    const { GET } = await import("@/app/api/logs/route");
    const req = new NextRequest("http://localhost/api/logs?limit=100000");
    const res = await GET(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 when page is below the minimum", async () => {
    const { GET } = await import("@/app/api/logs/route");
    const req = new NextRequest("http://localhost/api/logs?page=0");
    const res = await GET(req);

    expect(res.status).toBe(400);
  });

  it("returns 200 with the expected shape for a valid request", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const { GET } = await import("@/app/api/logs/route");
    const req = new NextRequest("http://localhost/api/logs");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ logs: [], total: 0, page: 1, limit: 50 });
  });

  it("exposes the endpoint relation as `server`, not `endpointRef`", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "log_1",
        endpointId: "endpoint_1",
        model: "llama3",
        endpoint: "/api/generate",
        promptTokens: 10,
        completionTokens: 20,
        latencyMs: 123,
        statusCode: 200,
        userId: "u1",
        apiKeyId: null,
        ip: "192.168.1.1",
        createdAt: new Date("2025-01-01T00:00:00Z"),
        endpointRef: { name: "gpu-box-1" },
      },
    ]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const { GET } = await import("@/app/api/logs/route");
    const req = new NextRequest("http://localhost/api/logs");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.logs[0].server).toEqual({ name: "gpu-box-1" });
    expect(data.logs[0].endpointRef).toBeUndefined();
  });
});
