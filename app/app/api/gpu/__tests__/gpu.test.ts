import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    endpoint: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/require-auth";

const gpuReq = () => new NextRequest("http://localhost/api/gpu");

const fresh = () => new Date(Date.now() - 5_000);

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
  lastCheckInAt: Date | null = fresh()
) => ({ nodeName, lastCheckInAt, gpus });

const mockServer = {
  id: "srv_1",
  name: "Local Ollama",
  url: "http://localhost:11434",
  active: true,
  engine: "ollama",
  hosts: [],
};

const mockServerWithGpu = {
  ...mockServer,
  id: "srv_2",
  name: "GPU Server",
  hosts: [makeHost("gpu-node-2", [makeGpu()])],
};

/** Every fetch this route is still allowed to make. */
const ALLOWED_FETCH = /\/api\/(ps|tags)$/;

const mockVllmServer = {
  ...mockServer,
  id: "srv_3",
  name: "vLLM Server",
  engine: "vllm",
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "u1",
    role: "admin",
  });
});

describe("GET /api/gpu", () => {
  it("returns running models from server", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [
            { name: "llama3:latest", size: 4_000_000_000, size_vram: 3_500_000_000, expires_at: "2025-12-31T00:00:00Z" },
          ],
        }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const res = await GET(gpuReq());
    const data = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].serverName).toBe("Local Ollama");
    expect(data[0].runningModels).toHaveLength(1);
    expect(data[0].runningModels[0].name).toBe("llama3:latest");
  });

  it("handles server connection error", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
    ]);
    fetchMock.mockRejectedValue(new Error("Connection refused"));

    const { GET } = await import("@/app/api/gpu/route");
    const res = await GET(gpuReq());
    const data = await res.json();

    expect(data[0].error).toBe("Could not connect to Ollama server");
    expect(data[0].runningModels).toHaveLength(0);
  });

  it("serves GPU stats from the linked host's stored check-in", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServerWithGpu,
    ]);

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const res = await GET(gpuReq());
    const data = await res.json();

    expect(data[0].gpuInfo).toHaveLength(1);
    expect(data[0].gpuInfo[0]).toMatchObject({
      name: "RTX 4090",
      hostNodeName: "gpu-node-2",
      memorySource: "nvml",
      memoryTotal: 24_000_000_000,
      memoryUsed: 8_000_000_000,
      memoryFree: 16_000_000_000,
      temperature: 65,
      utilization: 45,
      powerDraw: 180,
    });
    expect(data[0].gpuReason).toBeNull();
  });

  it("returns every linked host's GPUs, attributed by host node name", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockServer,
        id: "srv_spark",
        name: "Spark cluster",
        hosts: [
          makeHost("spark-1", [makeGpu({ name: "GB10" })]),
          makeHost("spark-2", [makeGpu({ name: "GB10" })]),
        ],
      },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const data = await (await GET(gpuReq())).json();

    expect(data[0].gpuInfo).toHaveLength(2);
    expect(data[0].gpuInfo.map((g: { hostNodeName: string }) => g.hostNodeName)).toEqual([
      "spark-1",
      "spark-2",
    ]);
  });

  it("keeps a unified-memory GPU's unknown total as null rather than zero", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockServer,
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
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const data = await (await GET(gpuReq())).json();

    expect(data[0].gpuInfo[0].memorySource).toBe("unified");
    expect(data[0].gpuInfo[0].memoryTotal).toBeNull();
    expect(data[0].gpuInfo[0].memoryUsed).toBeNull();
    expect(data[0].gpuInfo[0].memoryFree).toBeNull();
  });

  it("reports no_linked_hosts for an endpoint with no linked hosts", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const data = await (await GET(gpuReq())).json();

    expect(data[0].gpuInfo).toBeNull();
    expect(data[0].gpuReason).toBe("no_linked_hosts");
  });

  it("reports stale, with the last check-in time, when the agent stopped reporting", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockServer,
        hosts: [makeHost("gpu-node-3", [makeGpu()], tenMinutesAgo)],
      },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const data = await (await GET(gpuReq())).json();

    expect(data[0].gpuInfo).toBeNull();
    expect(data[0].gpuReason).toBe("stale");
    expect(data[0].gpuStaleSince).toBe(tenMinutesAgo.toISOString());
  });

  it("reports driver_failed when the only linked GPU has a failed driver", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockServer,
        hosts: [makeHost("gpu-node-2", [makeGpu({ driverStatus: "failed" })])],
      },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const data = await (await GET(gpuReq())).json();

    expect(data[0].gpuInfo).toBeNull();
    expect(data[0].gpuReason).toBe("driver_failed");
  });

  it("never probes a GPU agent — GPU stats are read from the database only", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServerWithGpu,
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    await GET(gpuReq());

    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(ALLOWED_FETCH);
    }
  });

  it("returns empty array when no active servers", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { GET } = await import("@/app/api/gpu/route");
    const res = await GET(gpuReq());
    const data = await res.json();

    expect(data).toHaveLength(0);
  });

  it("isolates a host with an unrecognized engine so the rest of the fleet still reports", async () => {
    const brokenServer = { ...mockServer, id: "srv_bad", name: "Mystery Server", engine: "mystery" };
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
      brokenServer,
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const { GET } = await import("@/app/api/gpu/route");
    const res = await GET(gpuReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveLength(2);

    const healthy = data.find((d: { serverId: string }) => d.serverId === mockServer.id);
    const bad = data.find((d: { serverId: string }) => d.serverId === brokenServer.id);

    expect(healthy.error).toBeUndefined();
    expect(bad.error).toBeTruthy();
  });

  it("does not fetch /api/ps for a vLLM endpoint, whose adapter suppresses runningModels", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockVllmServer,
    ]);

    const { GET } = await import("@/app/api/gpu/route");
    const res = await GET(gpuReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].runningModels).toHaveLength(0);
    const psCalls = fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("/api/ps")
    );
    expect(psCalls).toHaveLength(0);
  });
});
