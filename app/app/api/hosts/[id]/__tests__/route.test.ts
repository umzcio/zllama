import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    host: {
      update: vi.fn(),
    },
    role: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

const params = () => Promise.resolve({ id: "host_1" });

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/hosts/host_1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const mockHost = {
  id: "host_1",
  nodeName: "node-a",
  roleId: null,
  converge: false,
  approvalState: "pending",
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "admin_1",
    role: "admin",
  });
});

describe("PATCH /api/hosts/[id]", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/hosts/[id]/route");
    const res = await PATCH(patchReq({ roleId: "role_1" }), { params: params() });
    expect(res.status).toBe(403);
    expect(prisma.host.update).not.toHaveBeenCalled();
  });

  it("assigns a roleId", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "role_1" });
    (prisma.host.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockHost,
      roleId: "role_1",
    });

    const { PATCH } = await import("@/app/api/hosts/[id]/route");
    const res = await PATCH(patchReq({ roleId: "role_1" }), { params: params() });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.roleId).toBe("role_1");
    expect(prisma.host.update).toHaveBeenCalledWith({
      where: { id: "host_1" },
      data: { roleId: "role_1" },
    });
  });

  it("sets converge to true", async () => {
    (prisma.host.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockHost,
      converge: true,
    });

    const { PATCH } = await import("@/app/api/hosts/[id]/route");
    const res = await PATCH(patchReq({ converge: true }), { params: params() });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.converge).toBe(true);
    expect(prisma.host.update).toHaveBeenCalledWith({
      where: { id: "host_1" },
      data: { converge: true },
    });
  });

  it("returns 400, not a foreign-key 500, for an unknown roleId", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { PATCH } = await import("@/app/api/hosts/[id]/route");
    const res = await PATCH(patchReq({ roleId: "does-not-exist" }), { params: params() });

    expect(res.status).toBe(400);
    expect(prisma.host.update).not.toHaveBeenCalled();
  });

  it("ignores approvalState if supplied — cannot bypass the approval gate", async () => {
    (prisma.host.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockHost,
      converge: true,
    });

    const { PATCH } = await import("@/app/api/hosts/[id]/route");
    await PATCH(patchReq({ converge: true, approvalState: "approved" }), {
      params: params(),
    });

    expect(prisma.host.update).toHaveBeenCalledWith({
      where: { id: "host_1" },
      data: { converge: true },
    });
    const call = (prisma.host.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty("approvalState");
  });

  it("returns 404 for an unknown host id", async () => {
    (prisma.host.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Record not found")
    );

    const { PATCH } = await import("@/app/api/hosts/[id]/route");
    const res = await PATCH(patchReq({ converge: true }), {
      params: Promise.resolve({ id: "nope" }),
    });

    expect(res.status).toBe(404);
  });
});
