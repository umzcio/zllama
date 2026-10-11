import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    role: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    host: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

const mockRole = {
  id: "role_1",
  name: "gpu-worker",
  description: "GPU inference worker",
  desiredState: JSON.stringify({ runtimes: { ollama: { state: "present", models: [] } } }),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function jsonReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "admin_1",
    role: "admin",
  });
});

describe("GET /api/roles", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { GET } = await import("@/app/api/roles/route");
    const res = await GET(jsonReq("http://localhost/api/roles", "GET"));
    expect(res.status).toBe(403);
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });

  it("returns roles for an admin", async () => {
    (prisma.role.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockRole]);
    const { GET } = await import("@/app/api/roles/route");
    const res = await GET(jsonReq("http://localhost/api/roles", "GET"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("gpu-worker");
  });
});

describe("POST /api/roles", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { POST } = await import("@/app/api/roles/route");
    const res = await POST(
      jsonReq("http://localhost/api/roles", "POST", { name: "x", desiredState: "{}" })
    );
    expect(res.status).toBe(403);
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it("stores a valid declaration and returns 201", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.role.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockRole);

    const { POST } = await import("@/app/api/roles/route");
    const res = await POST(
      jsonReq("http://localhost/api/roles", "POST", {
        name: "gpu-worker",
        description: "GPU inference worker",
        desiredState: mockRole.desiredState,
      })
    );
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.name).toBe("gpu-worker");
    expect(prisma.role.create).toHaveBeenCalled();
  });

  it("rejects a declaration with an unknown key, naming it", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { POST } = await import("@/app/api/roles/route");
    const res = await POST(
      jsonReq("http://localhost/api/roles", "POST", {
        name: "bad-role",
        desiredState: JSON.stringify({ runtimes: { ollama: { state: "present", bogus: true } } }),
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/bogus/);
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it("returns 400 for a vLLM model declared with the Ollama name form", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { POST } = await import("@/app/api/roles/route");
    const res = await POST(
      jsonReq("http://localhost/api/roles", "POST", {
        name: "spark-node",
        desiredState: JSON.stringify({
          runtimes: { vllm: { state: "present", models: [{ name: "Qwen/Qwen3-32B" }] } },
        }),
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/repo/);
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an Ollama model declared with the vLLM repo form", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { POST } = await import("@/app/api/roles/route");
    const res = await POST(
      jsonReq("http://localhost/api/roles", "POST", {
        name: "x86-ollama-node",
        desiredState: JSON.stringify({
          runtimes: { ollama: { state: "present", models: [{ repo: "Qwen/Qwen3-32B" }] } },
        }),
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/name/);
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it("returns 409 on a duplicate role name", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRole);

    const { POST } = await import("@/app/api/roles/route");
    const res = await POST(
      jsonReq("http://localhost/api/roles", "POST", {
        name: "gpu-worker",
        desiredState: "{}",
      })
    );

    expect(res.status).toBe(409);
    expect(prisma.role.create).not.toHaveBeenCalled();
  });
});

describe("PUT /api/roles/[id]", () => {
  const params = () => Promise.resolve({ id: "role_1" });

  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { PUT } = await import("@/app/api/roles/[id]/route");
    const res = await PUT(
      jsonReq("http://localhost/api/roles/role_1", "PUT", { desiredState: "{}" }),
      { params: params() }
    );
    expect(res.status).toBe(403);
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  it("replaces the declaration and re-validates", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRole);
    const newState = JSON.stringify({ runtimes: { vllm: { state: "present", models: [] } } });
    (prisma.role.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockRole,
      desiredState: newState,
    });

    const { PUT } = await import("@/app/api/roles/[id]/route");
    const res = await PUT(
      jsonReq("http://localhost/api/roles/role_1", "PUT", { desiredState: newState }),
      { params: params() }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.desiredState).toBe(newState);
    expect(prisma.role.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ desiredState: newState }) })
    );
  });

  it("rejects an invalid declaration on update", async () => {
    (prisma.role.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockRole);

    const { PUT } = await import("@/app/api/roles/[id]/route");
    const res = await PUT(
      jsonReq("http://localhost/api/roles/role_1", "PUT", {
        desiredState: JSON.stringify({ runtimes: { mystery: { state: "present" } } }),
      }),
      { params: params() }
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/mystery/);
    expect(prisma.role.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/roles/[id]", () => {
  const params = () => Promise.resolve({ id: "role_1" });

  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { DELETE } = await import("@/app/api/roles/[id]/route");
    const res = await DELETE(jsonReq("http://localhost/api/roles/role_1", "DELETE"), {
      params: params(),
    });
    expect(res.status).toBe(403);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it("deletes only the role row, relying on the schema's onDelete: SetNull to null Host.roleId rather than deleting hosts", async () => {
    (prisma.role.delete as ReturnType<typeof vi.fn>).mockResolvedValue(mockRole);

    const { DELETE } = await import("@/app/api/roles/[id]/route");
    const res = await DELETE(jsonReq("http://localhost/api/roles/role_1", "DELETE"), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: "role_1" } });

    // The route must never explicitly delete or bulk-update hosts when a
    // role is removed — the FK's onDelete: SetNull already nulls
    // Host.roleId at the database level, and the route deleting hosts here
    // would defeat that guarantee.
    expect(prisma.host.delete).not.toHaveBeenCalled();
    expect(prisma.host.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown role id", async () => {
    (prisma.role.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Record not found")
    );
    const { DELETE } = await import("@/app/api/roles/[id]/route");
    const res = await DELETE(jsonReq("http://localhost/api/roles/nope", "DELETE"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
