import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    log: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    endpoint: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
}));

// Mock fetch for server health/ps/gpu calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/require-auth";

const dashboardReq = () => new NextRequest("http://localhost/api/dashboard");

const now = new Date();

const makeLog = (overrides: Partial<{
  model: string;
  statusCode: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  createdAt: Date;
}> = {}) => ({
  id: "log_1",
  model: "llama3.1:8b",
  statusCode: 200,
  latencyMs: 500,
  promptTokens: 100,
  completionTokens: 200,
  createdAt: now,
  ...overrides,
});

const mockServer = {
  id: "srv_1",
  name: "Local",
  url: "http://localhost:11434",
  engine: "ollama",
  hosts: [],
};

const makeGpu = (overrides: Record<string, unknown> = {}) => ({
  index: 0,
  name: "RTX 4090",
  memoryTotalBytes: 24_000_000_000,
  memorySource: "nvml",
  driverStatus: "ok",
  lastUtilPct: 45,
  lastTempC: 65,
  lastPowerW: 180,
  lastMemoryUsedBytes: 8_000_000_000,
  ...overrides,
});

const makeHost = (
  nodeName: string,
  gpus: ReturnType<typeof makeGpu>[],
  lastCheckInAt: Date | null = new Date(Date.now() - 5_000)
) => ({ nodeName, lastCheckInAt, gpus });

/** Every fetch this route is still allowed to make. */
const ALLOWED_FETCH = /\/api\/(version|ps|tags)$|\/version$/;

beforeEach(() => {
  vi.clearAllMocks();
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "u1",
    role: "admin",
  });
  // Default: server offline (fetch rejects)
  mockFetch.mockRejectedValue(new Error("Connection refused"));
});

describe("GET /api/dashboard", () => {
  it("returns correct KPIs for today's logs", async () => {
    const logs = [
      makeLog({ model: "llama3.1:8b", latencyMs: 400, promptTokens: 100, completionTokens: 200 }),
      makeLog({ model: "llama3.1:8b", latencyMs: 600, promptTokens: 50, completionTokens: 100 }),
      makeLog({ model: "mistral", latencyMs: 1200, statusCode: 500, promptTokens: 80, completionTokens: 0 }),
    ];

    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(logs);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockServer]);

    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(dashboardReq());
    const data = await res.json();

    expect(data.kpis.requestsToday).toBe(3);
    expect(data.kpis.requestsYesterday).toBe(2);
    expect(data.kpis.errorCount).toBe(1);
    expect(parseFloat(data.kpis.errorRate)).toBeCloseTo(33.3, 0);
    expect(data.kpis.tokensToday).toBe(530); // (100+200) + (50+100) + (80+0)
    expect(data.kpis.avgLatencyMs).toBe(733); // (400+600+1200)/3
  });

  it("calculates p95 latency correctly", async () => {
    const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 5000];
    const logs = latencies.map((l) => makeLog({ latencyMs: l }));

    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(logs);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(dashboardReq());
    const data = await res.json();

    // p95 index = floor(11 * 0.95) = 10 => 5000
    expect(data.kpis.p95LatencyMs).toBe(5000);
  });

  it("returns top 5 models sorted by usage", async () => {
    const logs = [
      ...Array(5).fill(null).map(() => makeLog({ model: "llama3.1:8b" })),
      ...Array(3).fill(null).map(() => makeLog({ model: "mistral" })),
      ...Array(2).fill(null).map(() => makeLog({ model: "codellama" })),
      ...Array(1).fill(null).map(() => makeLog({ model: "phi3" })),
      ...Array(1).fill(null).map(() => makeLog({ model: "gemma" })),
      ...Array(1).fill(null).map(() => makeLog({ model: "deepseek" })),
    ];

    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(logs);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(dashboardReq());
    const data = await res.json();

    expect(data.topModels).toHaveLength(5);
    expect(data.topModels[0]).toEqual({ model: "llama3.1:8b", count: 5 });
    expect(data.topModels[1]).toEqual({ model: "mistral", count: 3 });
  });

  it("returns 24 hourly buckets always", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(dashboardReq());
    const data = await res.json();

    expect(data.requestsPerHour).toHaveLength(24);
    data.requestsPerHour.forEach((b: { hour: string; count: number }) => {
      expect(b.count).toBe(0);
    });
  });

  it("handles empty state gracefully", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(dashboardReq());
    const data = await res.json();

    expect(data.kpis.requestsToday).toBe(0);
    expect(data.kpis.tokensToday).toBe(0);
    expect(data.kpis.avgLatencyMs).toBe(0);
    expect(data.kpis.errorRate).toBe("0.0");
    expect(data.topModels).toHaveLength(0);
    expect(data.servers).toHaveLength(0);
  });

  it("marks server as online when health check succeeds", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockServer]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: "0.5.1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(dashboardReq());
    const data = await res.json();

    expect(data.servers[0].status).toBe("online");
    expect(data.servers[0].version).toBe("0.5.1");
    expect(data.kpis.serversOnline).toBe(1);
  });

  it("marks server as offline when health check fails", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockServer]);

    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(dashboardReq());
    const data = await res.json();

    expect(data.servers[0].status).toBe("offline");
    expect(data.kpis.serversOnline).toBe(0);
  });

  it("sources the gpu field from linked hosts' stored check-ins", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...mockServer, hosts: [makeHost("gpu-node-2", [makeGpu()])] },
    ]);
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const { GET } = await import("@/app/api/dashboard/route");
    const data = await (await GET(dashboardReq())).json();

    expect(data.servers[0].gpu).toHaveLength(1);
    expect(data.servers[0].gpu[0]).toMatchObject({
      name: "RTX 4090",
      hostNodeName: "gpu-node-2",
      memorySource: "nvml",
      memoryTotal: 24_000_000_000,
      memoryUsed: 8_000_000_000,
      utilization: 45,
    });
    expect(data.servers[0].gpuReason).toBeNull();
  });

  it("keeps a unified-memory GPU's unknown total as null and flags unlinked endpoints", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockServer,
        id: "srv_spark",
        hosts: [
          makeHost("spark-1", [
            makeGpu({
              name: "GB10",
              memorySource: "unified",
              memoryTotalBytes: null,
              lastMemoryUsedBytes: null,
            }),
          ]),
        ],
      },
      { ...mockServer, id: "srv_bare" },
    ]);
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const { GET } = await import("@/app/api/dashboard/route");
    const data = await (await GET(dashboardReq())).json();

    expect(data.servers[0].gpu[0].memoryTotal).toBeNull();
    expect(data.servers[0].gpu[0].memorySource).toBe("unified");
    expect(data.servers[1].gpu).toBeNull();
    expect(data.servers[1].gpuReason).toBe("no_linked_hosts");
  });

  it("never probes a GPU agent — GPU stats are read from the database only", async () => {
    (prisma.log.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.log.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...mockServer, hosts: [makeHost("gpu-node-2", [makeGpu()])] },
    ]);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: "0.5.1", models: [] }) });

    const { GET } = await import("@/app/api/dashboard/route");
    await GET(dashboardReq());

    expect(mockFetch).toHaveBeenCalled();
    for (const call of mockFetch.mock.calls) {
      expect(String(call[0])).toMatch(ALLOWED_FETCH);
    }
  });
});
