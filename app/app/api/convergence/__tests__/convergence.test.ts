import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    convergenceRun: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

const findMany = () => prisma.convergenceRun.findMany as ReturnType<typeof vi.fn>;

const convergenceReq = (query = "") =>
  new NextRequest(`http://localhost/api/convergence${query}`);

const mockRun = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "run_1",
  hostId: "host_1",
  trigger: "checkin",
  status: "succeeded",
  startedAt: new Date("2026-08-20T10:00:00.000Z"),
  finishedAt: new Date("2026-08-20T10:00:05.000Z"),
  currentAction: null,
  progressPct: null,
  actions: "[]",
  error: null,
  host: { nodeName: "node-a" },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "admin_1",
    role: "admin",
  });
});

describe("GET /api/convergence", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/convergence/route");
    const res = await GET(convergenceReq());

    expect(res.status).toBe(403);
    expect(prisma.convergenceRun.findMany).not.toHaveBeenCalled();
  });

  it("returns recent runs across the fleet when no hostId is given", async () => {
    findMany().mockResolvedValue([mockRun()]);

    const { GET } = await import("@/app/api/convergence/route");
    const res = await GET(convergenceReq());

    expect(res.status).toBe(200);
    expect(findMany().mock.calls[0][0].where).toBeUndefined();
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].nodeName).toBe("node-a");
    expect(data[0].status).toBe("succeeded");
  });

  it("filters by hostId and orders newest first", async () => {
    findMany().mockResolvedValue([mockRun({ id: "run_2" }), mockRun({ id: "run_1" })]);

    const { GET } = await import("@/app/api/convergence/route");
    const res = await GET(convergenceReq("?hostId=host_1"));

    expect(res.status).toBe(200);
    const call = findMany().mock.calls[0][0];
    expect(call.where).toEqual({ hostId: "host_1" });
    expect(call.orderBy).toEqual({ startedAt: "desc" });
    const data = await res.json();
    expect(data.map((r: { id: string }) => r.id)).toEqual(["run_2", "run_1"]);
  });

  it("parses the stored actions JSON text back into an array", async () => {
    const actions = [{ kind: "install_runtime", runtime: "ollama", exit_code: 0 }];
    findMany().mockResolvedValue([mockRun({ actions: JSON.stringify(actions) })]);

    const { GET } = await import("@/app/api/convergence/route");
    const res = await GET(convergenceReq());
    const data = await res.json();

    expect(data[0].actions).toEqual(actions);
  });

  it("falls back to an empty actions array rather than 500ing on malformed stored JSON", async () => {
    findMany().mockResolvedValue([mockRun({ actions: "{ not valid json" })]);

    const { GET } = await import("@/app/api/convergence/route");
    const res = await GET(convergenceReq());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data[0].actions).toEqual([]);
  });

  it("surfaces the failure message for a failed run", async () => {
    findMany().mockResolvedValue([
      mockRun({ status: "failed", error: "install_runtime for ollama exited 1: boom" }),
    ]);

    const { GET } = await import("@/app/api/convergence/route");
    const res = await GET(convergenceReq());
    const data = await res.json();

    expect(data[0].status).toBe("failed");
    expect(data[0].error).toBe("install_runtime for ollama exited 1: boom");
  });
});
