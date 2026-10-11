// End-to-end model convergence, driven through both real routes.
//
// Every other model test injects `HostModelFacts` by hand, which is exactly
// how nothing-writes-HostModel survived five review rounds: the read side
// (`/api/drift`) and the classifier (`computeDrift`) were fully covered while
// the write side did not exist, so `installed_models` was always empty, every
// declared model was re-planned as a `pull_model` forever, and `unmanaged` was
// unreachable in production.
//
// This test therefore refuses to hand-build a HostModel row. The only way a
// row exists here is that the check-in route wrote it, and the only thing the
// drift route reads is what the check-in route wrote.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

interface StoredModel {
  hostId: string;
  runtimeKind: string;
  name: string;
  sizeBytes: number | null;
  digest: string | null;
  managed: boolean;
  lastSeenAt: Date;
}

const { store } = vi.hoisted(() => ({
  store: { rows: [] as StoredModel[], host: null as Record<string, unknown> | null },
}));

vi.mock("@/lib/prisma", () => {
  const key = (r: { hostId: string; runtimeKind: string; name: string }) =>
    `${r.hostId} ${r.runtimeKind} ${r.name}`;

  const prisma = {
    host: {
      upsert: vi.fn(async () => store.host),
      // The drift route reads back exactly the rows the check-in wrote.
      findMany: vi.fn(async () => [
        {
          ...store.host,
          models: store.rows.map((r) => ({
            runtimeKind: r.runtimeKind,
            name: r.name,
            sizeBytes: r.sizeBytes,
          })),
        },
      ]),
    },
    gpu: { upsert: vi.fn() },
    runtime: { upsert: vi.fn() },
    hostModel: {
      upsert: vi.fn(
        async (args: {
          where: { hostId_runtimeKind_name: StoredModel };
          create: StoredModel;
        }) => {
          const target = args.where.hostId_runtimeKind_name;
          const existing = store.rows.findIndex((r) => key(r) === key(target));
          const row = { ...args.create } as StoredModel;
          if (existing >= 0) {
            store.rows[existing] = row;
          } else {
            store.rows.push(row);
          }
          return row;
        }
      ),
      deleteMany: vi.fn(
        async (args: {
          where: { hostId: string; runtimeKind: string; name: { notIn: string[] } };
        }) => {
          const { hostId, runtimeKind, name } = args.where;
          store.rows = store.rows.filter(
            (r) =>
              !(
                r.hostId === hostId &&
                r.runtimeKind === runtimeKind &&
                !name.notIn.includes(r.name)
              )
          );
          return { count: 0 };
        }
      ),
    },
    convergenceRun: { create: vi.fn() },
    $transaction: vi.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
  };
  return { prisma };
});

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(async () => ({ kind: "user", userId: "admin_1", role: "admin" })),
}));

const ENROLL_TOKEN = "test-enroll-token-0123456789";

const DECLARATION = JSON.stringify({
  runtimes: {
    ollama: {
      state: "present",
      version: "0.32.13",
      models: [{ name: "qwen3:32b", state: "present" }],
    },
  },
});

function checkinRequest(models: Array<Record<string, unknown>> | null) {
  return new Request("http://localhost/api/agent/checkin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ENROLL_TOKEN}`,
    },
    body: JSON.stringify({
      node_name: "node-a",
      agent_version: "0.19.0",
      host: { arch: "aarch64", os: "Linux" },
      gpus: [],
      runtimes: [
        {
          kind: "ollama",
          version: "0.32.13",
          install_method: "binary",
          service_state: "active",
          models,
        },
      ],
    }),
  });
}

async function driftForHost() {
  const { GET } = await import("@/app/api/drift/route");
  const res = await GET(new NextRequest("http://localhost/api/drift"));
  expect(res.status).toBe(200);
  const data = (await res.json()) as Array<{
    nodeName: string;
    state: string;
    runtimes: Array<{
      kind: string;
      state: string;
      models: Array<{ name: string; state: string }>;
    }>;
  }>;
  return data[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_ENROLL_TOKEN = ENROLL_TOKEN;
  store.rows = [];
  store.host = {
    id: "host_1",
    nodeName: "node-a",
    arch: "aarch64",
    os: "Linux",
    roleId: "role_1",
    converge: true,
    approvalState: "approved",
    lastCheckInAt: new Date(),
    runtimes: [{ kind: "ollama", version: "0.32.13" }],
    gpus: [],
    role: { id: "role_1", name: "x86-ollama-node", desiredState: DECLARATION },
  };
});

describe("check-in -> HostModel -> drift", () => {
  it("writes a HostModel row for every installed model the agent reports", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      checkinRequest([
        { name: "qwen3:32b", size_bytes: 20_000_000_000, digest: "sha256:aaa" },
        { name: "stray:latest", size_bytes: 42, digest: "sha256:bbb" },
      ]) as never
    );

    expect(res.status).toBe(200);
    expect(store.rows.map((r) => r.name).sort()).toEqual(["qwen3:32b", "stray:latest"]);
    const declared = store.rows.find((r) => r.name === "qwen3:32b");
    expect(declared?.sizeBytes).toBe(20_000_000_000);
    expect(declared?.digest).toBe("sha256:aaa");
    expect(declared?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("sets managed from the role declaration, not a default", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(
      checkinRequest([
        { name: "qwen3:32b", size_bytes: 1 },
        { name: "stray:latest", size_bytes: 2 },
      ]) as never
    );

    // `managed` is what makes never-delete-undeclared enforceable, so a
    // declared model must be true and an undeclared one false.
    expect(store.rows.find((r) => r.name === "qwen3:32b")?.managed).toBe(true);
    expect(store.rows.find((r) => r.name === "stray:latest")?.managed).toBe(false);
  });

  it("reports in_sync for a declared-and-installed model and unmanaged for an installed-but-undeclared one", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(
      checkinRequest([
        { name: "qwen3:32b", size_bytes: 1 },
        { name: "stray:latest", size_bytes: 2 },
      ]) as never
    );

    const drift = await driftForHost();
    const ollama = drift.runtimes.find((r) => r.kind === "ollama");

    expect(ollama?.models).toEqual(
      expect.arrayContaining([
        { name: "qwen3:32b", state: "in_sync" },
        { name: "stray:latest", state: "unmanaged" },
      ])
    );
  });

  it("reports drifted, not in_sync, for a declared model the check-in did not report as installed", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(checkinRequest([]) as never);

    const drift = await driftForHost();
    const ollama = drift.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.models).toEqual([{ name: "qwen3:32b", state: "drifted" }]);
  });

  it("stops reporting a model once the agent no longer lists it — HostModel is a snapshot, not a log", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(checkinRequest([{ name: "qwen3:32b", size_bytes: 1 }]) as never);
    expect(store.rows.map((r) => r.name)).toEqual(["qwen3:32b"]);

    // The operator removed it out of band; the next check-in reports nothing.
    await POST(checkinRequest([]) as never);
    expect(store.rows).toEqual([]);

    const drift = await driftForHost();
    const ollama = drift.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.models).toEqual([{ name: "qwen3:32b", state: "drifted" }]);
  });

  it("model names are matched case-sensitively — Qwen3:32B does not satisfy a qwen3:32b declaration", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(checkinRequest([{ name: "Qwen3:32B", size_bytes: 1 }]) as never);

    expect(store.rows.find((r) => r.name === "Qwen3:32B")?.managed).toBe(false);

    const drift = await driftForHost();
    const ollama = drift.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.models).toEqual(
      expect.arrayContaining([
        { name: "qwen3:32b", state: "drifted" },
        { name: "Qwen3:32B", state: "unmanaged" },
      ])
    );
  });

  it("writes no HostModel row and does not prune when the agent reports no inventory at all", async () => {
    // An older agent omits `models` entirely. That is not evidence that the
    // host has none, so previously-recorded rows must survive untouched.
    store.rows = [
      {
        hostId: "host_1",
        runtimeKind: "ollama",
        name: "qwen3:32b",
        sizeBytes: 1,
        digest: null,
        managed: true,
        lastSeenAt: new Date(),
      },
    ];

    const req = new Request("http://localhost/api/agent/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ENROLL_TOKEN}` },
      body: JSON.stringify({
        node_name: "node-a",
        host: { arch: "aarch64", os: "Linux" },
        runtimes: [{ kind: "ollama", version: "0.32.13" }],
      }),
    });

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(store.rows.map((r) => r.name)).toEqual(["qwen3:32b"]);
  });

  it("writes no HostModel row and does not prune when the agent reports models: null", async () => {
    // A current agent sends `null` rather than omitting the key when its own
    // probe (e.g. Ollama's `/api/tags`) failed — a transient hiccup, not a
    // report that nothing is installed. It must be treated identically to
    // the omitted-key case above: previously-recorded rows survive.
    store.rows = [
      {
        hostId: "host_1",
        runtimeKind: "ollama",
        name: "qwen3:32b",
        sizeBytes: 1,
        digest: null,
        managed: true,
        lastSeenAt: new Date(),
      },
    ];

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(checkinRequest(null) as never);

    expect(res.status).toBe(200);
    expect(store.rows.map((r) => r.name)).toEqual(["qwen3:32b"]);
  });
});

describe("check-in installed-model validation", () => {
  const malformedModels: Array<[string, unknown]> = [
    ["a string models", "qwen3:32b"],
    ["an object models", {}],
    ["a non-object model entry", ["qwen3:32b"]],
    ["a model with no name", [{ size_bytes: 1 }]],
    ["a model with an empty name", [{ name: "" }]],
    ["a model with a non-string name", [{ name: 42 }]],
    ["a model with a non-numeric size_bytes", [{ name: "qwen3:32b", size_bytes: "20GB" }]],
    ["a model with a non-string digest", [{ name: "qwen3:32b", digest: 7 }]],
  ];

  for (const [label, models] of malformedModels) {
    it(`returns 400, not 500, for ${label}`, async () => {
      const req = new Request("http://localhost/api/agent/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ENROLL_TOKEN}` },
        body: JSON.stringify({
          node_name: "node-a",
          host: { arch: "aarch64", os: "Linux" },
          runtimes: [{ kind: "ollama", version: "0.32.13", models }],
        }),
      });

      const { POST } = await import("@/app/api/agent/checkin/route");
      const res = await POST(req as never);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/models/);
      expect(store.rows).toEqual([]);
    });
  }
});
