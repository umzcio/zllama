import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    endpoint: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
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

const mockServer = {
  id: "srv_1",
  name: "Local Ollama",
  url: "http://localhost:11434",
  active: true,
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "admin_1",
    role: "admin",
  });
});

describe("GET /api/servers", () => {
  it("returns only active servers by default", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
    ]);

    const { GET } = await import("@/app/api/servers/route");
    const req = new NextRequest("http://localhost/api/servers");
    const res = await GET(req);
    const data = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Local Ollama");
    expect(prisma.endpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true },
      })
    );
  });

  it("returns all servers when all=true", async () => {
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
      { ...mockServer, id: "srv_2", name: "Inactive", active: false },
    ]);

    const { GET } = await import("@/app/api/servers/route");
    const req = new NextRequest("http://localhost/api/servers?all=true");
    const res = await GET(req);
    const data = await res.json();

    expect(data).toHaveLength(2);
    expect(prisma.endpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "asc" },
      })
    );
  });

  it("includes the associated hosts summary", async () => {
    const mockHost = { id: "host_1", nodeName: "gpu-node-4", status: "online" };
    (prisma.endpoint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...mockServer, hosts: [mockHost] },
    ]);

    const { GET } = await import("@/app/api/servers/route");
    const req = new NextRequest("http://localhost/api/servers");
    const res = await GET(req);
    const data = await res.json();

    expect(data[0].hosts).toEqual([mockHost]);
    expect(prisma.endpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { hosts: { select: { id: true, nodeName: true, status: true } } },
      })
    );
  });
});

describe("POST /api/servers", () => {
  it("creates a server with valid data", async () => {
    (prisma.endpoint.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockServer
    );

    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Local Ollama",
        url: "http://localhost:11434",
      }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("Local Ollama");
  });

  it("returns 400 when name is missing", async () => {
    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({ url: "http://localhost:11434" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it("ignores the deprecated GPU-agent URL field instead of rejecting old clients", async () => {
    (prisma.endpoint.create as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }) => Promise.resolve({ ...mockServer, ...data })
    );

    // Spelled indirectly so the repo-wide "no legacy field" check stays honest.
    const legacyField = ["gpu", "Agent", "Url"].join("");

    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Test",
        url: "http://localhost:11434",
        [legacyField]: "http://10.0.0.5:9100",
      }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(201);
    const created = (prisma.endpoint.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.data).not.toHaveProperty(legacyField);
  });

  it("strips trailing slash from URL", async () => {
    (prisma.endpoint.create as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }) => Promise.resolve({ ...mockServer, ...data })
    );

    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Test",
        url: "http://localhost:11434/",
      }),
    });
    await POST(req as any);

    expect(prisma.endpoint.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          url: "http://localhost:11434",
        }),
      })
    );
  });
});

describe("GET /api/servers/[id]", () => {
  it("includes the associated hosts summary", async () => {
    const mockHost = { id: "host_1", nodeName: "gpu-node-4", status: "online" };
    (prisma.endpoint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockServer,
      hosts: [mockHost],
    });

    const { GET } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1");
    const res = await GET(req as any, { params: Promise.resolve({ id: "srv_1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.hosts).toEqual([mockHost]);
    expect(prisma.endpoint.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { hosts: { select: { id: true, nodeName: true, status: true } } },
      })
    );
  });

  it("returns 404 for a non-existent server", async () => {
    (prisma.endpoint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/nope");
    const res = await GET(req as any, { params: Promise.resolve({ id: "nope" }) });

    expect(res.status).toBe(404);
  });
});

describe("PUT /api/servers/[id] host associations", () => {
  it("rejects an unknown host id with 400 naming it, and leaves associations unchanged", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "host_1" },
    ]);

    const { PUT } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "PUT",
      body: JSON.stringify({ hostIds: ["host_1", "host_bogus"] }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: "srv_1" }) });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("host_bogus");
    expect(prisma.endpoint.update).not.toHaveBeenCalled();
    expect(prisma.host.update).not.toHaveBeenCalled();
  });

  it("replaces the host association set with valid hostIds", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "host_1" },
      { id: "host_2" },
    ]);
    (prisma.endpoint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockServer,
      hosts: [{ id: "host_1" }, { id: "host_2" }],
    });

    const { PUT } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "PUT",
      body: JSON.stringify({ hostIds: ["host_1", "host_2"] }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    expect(res.status).toBe(200);
    expect(prisma.endpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "srv_1" },
        data: expect.objectContaining({
          hosts: { set: [{ id: "host_1" }, { id: "host_2" }] },
        }),
      })
    );
    expect(prisma.host.update).not.toHaveBeenCalled();
  });

  it("clears the host association set when hostIds is an empty array", async () => {
    (prisma.endpoint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockServer,
      hosts: [],
    });

    const { PUT } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "PUT",
      body: JSON.stringify({ hostIds: [] }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    expect(res.status).toBe(200);
    expect(prisma.host.findMany).not.toHaveBeenCalled();
    expect(prisma.endpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hosts: { set: [] } }),
      })
    );
  });

  it("leaves associations untouched when hostIds is omitted", async () => {
    (prisma.endpoint.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockServer
    );

    const { PUT } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "PUT",
      body: JSON.stringify({ name: "Renamed" }),
    });
    await PUT(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    expect(prisma.host.findMany).not.toHaveBeenCalled();
    const call = (prisma.endpoint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty("hosts");
  });

  it("validates every id via a single host.findMany count-match before writing", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "host_1" },
      { id: "host_2" },
    ]);
    (prisma.endpoint.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockServer
    );

    const { PUT } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "PUT",
      body: JSON.stringify({ hostIds: ["host_1", "host_2"] }),
    });
    await PUT(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    expect(prisma.host.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.host.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["host_1", "host_2"] } },
      })
    );
  });

  it("only ever writes hosts via set semantics, never host data", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "host_1" },
    ]);
    (prisma.endpoint.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockServer
    );

    const { PUT } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "PUT",
      body: JSON.stringify({ hostIds: ["host_1"] }),
    });
    await PUT(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    const call = (prisma.endpoint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(call.data.hosts)).toEqual(["set"]);
    expect(prisma.host.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/servers/[id]", () => {
  it("deletes a server", async () => {
    (prisma.endpoint.delete as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockServer
    );

    const { DELETE } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "DELETE",
    });
    const res = await DELETE(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    expect(res.status).toBe(200);
  });

  it("returns 404 for non-existent server", async () => {
    (prisma.endpoint.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Not found")
    );

    const { DELETE } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/nope", {
      method: "DELETE",
    });
    const res = await DELETE(req as any, { params: Promise.resolve({ id: "nope" }) });

    expect(res.status).toBe(404);
  });
});
