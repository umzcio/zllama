import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { PRISMA_MUTATION_METHODS } = vi.hoisted(() => ({
  PRISMA_MUTATION_METHODS: [
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ] as const,
}));

vi.mock("@/lib/prisma", () => {
  const mutations = Object.fromEntries(
    PRISMA_MUTATION_METHODS.map((m) => [m, vi.fn()])
  );
  return {
    prisma: {
      host: {
        findMany: vi.fn(),
        ...mutations,
      },
    },
  };
});

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

const driftReq = () => new NextRequest("http://localhost/api/drift");

const okDeclaration = JSON.stringify({
  runtimes: { ollama: { state: "present", version: "0.5.1", models: [] } },
});

const inSyncHost = {
  id: "host_1",
  nodeName: "node-in-sync",
  roleId: "role_1",
  converge: true,
  approvalState: "approved",
  lastCheckInAt: new Date(),
  runtimes: [{ kind: "ollama", version: "0.5.1" }],
  gpus: [],
  role: { id: "role_1", desiredState: okDeclaration },
};

const unmanagedHost = {
  id: "host_2",
  nodeName: "node-unmanaged",
  roleId: null,
  converge: false,
  approvalState: "approved",
  lastCheckInAt: new Date(),
  runtimes: [],
  gpus: [],
  role: null,
};

const hostWithModel = {
  id: "host_4",
  nodeName: "node-with-model",
  roleId: "role_1",
  converge: true,
  approvalState: "approved",
  lastCheckInAt: new Date(),
  runtimes: [{ kind: "ollama", version: "0.5.1" }],
  gpus: [],
  models: [{ runtimeKind: "ollama", name: "stray-model:latest", sizeBytes: 999 }],
  role: { id: "role_1", desiredState: okDeclaration },
};

const staleHost = {
  id: "host_3",
  nodeName: "node-stale",
  roleId: "role_1",
  converge: true,
  approvalState: "approved",
  lastCheckInAt: new Date(Date.now() - 10 * 60 * 1000),
  runtimes: [{ kind: "ollama", version: "0.5.1" }],
  gpus: [],
  role: { id: "role_1", desiredState: okDeclaration },
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    kind: "user",
    userId: "admin_1",
    role: "admin",
  });
});

describe("GET /api/drift", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { GET } = await import("@/app/api/drift/route");
    const res = await GET(driftReq());
    expect(res.status).toBe(403);
    expect(prisma.host.findMany).not.toHaveBeenCalled();
  });

  it("returns one entry per host with its computed state", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      inSyncHost,
      unmanagedHost,
      staleHost,
    ]);

    const { GET } = await import("@/app/api/drift/route");
    const res = await GET(driftReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveLength(3);
    expect(data.map((d: { nodeName: string }) => d.nodeName)).toEqual([
      "node-in-sync",
      "node-unmanaged",
      "node-stale",
    ]);
  });

  it("reports unmanaged for a host with no role", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([unmanagedHost]);
    const { GET } = await import("@/app/api/drift/route");
    const res = await GET(driftReq());
    const data = await res.json();
    expect(data[0].state).toBe("unmanaged");
  });

  it("reports stale for a host past the check-in window", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([staleHost]);
    const { GET } = await import("@/app/api/drift/route");
    const res = await GET(driftReq());
    const data = await res.json();
    expect(data[0].state).toBe("stale");
  });

  it("surfaces a host's HostModel rows as per-model drift, scoped to the matching runtime kind", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([hostWithModel]);

    const { GET } = await import("@/app/api/drift/route");
    const res = await GET(driftReq());
    const data = await res.json();

    const ollamaRuntime = data[0].runtimes.find(
      (r: { kind: string }) => r.kind === "ollama"
    );
    expect(ollamaRuntime.models).toEqual([
      { name: "stray-model:latest", state: "unmanaged" },
    ]);
    // An installed-but-undeclared model is unmanaged, never drifted — it
    // must never surface as a reason to remove it.
    expect(data[0].state).toBe("unmanaged");
  });

  it("performs no writes — no Prisma mutation method is called", async () => {
    (prisma.host.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      inSyncHost,
      unmanagedHost,
      staleHost,
    ]);

    const { GET } = await import("@/app/api/drift/route");
    await GET(driftReq());

    for (const method of PRISMA_MUTATION_METHODS) {
      expect(
        (prisma.host as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]
      ).not.toHaveBeenCalled();
    }
  });
});
