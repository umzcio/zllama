import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    host: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

const mockHost = {
  id: "host_1",
  nodeName: "node-a",
  approvalState: "pending",
  gpus: [{ id: "gpu_1", index: 0 }],
  runtimes: [{ id: "rt_1", kind: "ollama" }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/hosts", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/hosts/route");
    const req = new NextRequest("http://localhost/api/hosts");
    const res = await GET(req);

    expect(res.status).toBe(403);
    expect(prisma.host.findMany).not.toHaveBeenCalled();
  });

  it("returns hosts with their gpus and runtimes for an admin", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "user",
      userId: "admin_1",
      role: "admin",
    });
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockHost,
    ]);

    const { GET } = await import("@/app/api/hosts/route");
    const req = new NextRequest("http://localhost/api/hosts");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].gpus).toEqual(mockHost.gpus);
    expect(data[0].runtimes).toEqual(mockHost.runtimes);
    expect(prisma.host.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { gpus: true, runtimes: true },
      })
    );
  });
});

describe("POST /api/hosts/[id]/approve", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { POST } = await import("@/app/api/hosts/[id]/approve/route");
    const req = new NextRequest("http://localhost/api/hosts/host_1/approve", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "host_1" }) });

    expect(res.status).toBe(403);
    expect(prisma.host.update).not.toHaveBeenCalled();
  });

  it("flips approvalState to approved for an admin", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "user",
      userId: "admin_1",
      role: "admin",
    });
    (prisma.host.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockHost,
      approvalState: "approved",
    });

    const { POST } = await import("@/app/api/hosts/[id]/approve/route");
    const req = new NextRequest("http://localhost/api/hosts/host_1/approve", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "host_1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.approvalState).toBe("approved");
    expect(prisma.host.update).toHaveBeenCalledWith({
      where: { id: "host_1" },
      data: { approvalState: "approved" },
    });
  });

  it("returns 404 for an unknown host id", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "user",
      userId: "admin_1",
      role: "admin",
    });
    (prisma.host.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Record not found")
    );

    const { POST } = await import("@/app/api/hosts/[id]/approve/route");
    const req = new NextRequest("http://localhost/api/hosts/nope/approve", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "nope" }) });

    expect(res.status).toBe(404);
  });
});
