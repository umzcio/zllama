import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const prisma = {
    host: {
      upsert: vi.fn(),
    },
    gpu: {
      upsert: vi.fn(),
    },
    runtime: {
      upsert: vi.fn(),
    },
    hostModel: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    convergenceRun: {
      create: vi.fn(),
    },
    // Mirror the top-level client back as the transactional client, since
    // these tests don't need real transactional isolation — just the same
    // upsert calls to assert against.
    $transaction: vi.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
  };
  return { prisma };
});

import { prisma } from "@/lib/prisma";

const ENROLL_TOKEN = "test-enroll-token-0123456789";

const mockHost = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "host_1",
  nodeName: "node-a",
  arch: "x86_64",
  os: "Linux",
  approvalState: "pending",
  converge: false,
  roleId: null,
  role: null,
  ...overrides,
});

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      keys.add(key);
      collectKeys(val, keys);
    }
  }
  return keys;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/agent/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function authedRequest(body: unknown) {
  return request(body, { Authorization: `Bearer ${ENROLL_TOKEN}` });
}

const basePayload = {
  node_name: "node-a",
  agent_version: "0.1.0",
  host: {
    arch: "x86_64",
    os: "Linux",
    kernel: "6.8.0-generic",
    cpu_model: "AMD Threadripper",
    cpu_count: 20,
    ram_total_bytes: 128849018880,
  },
  gpus: [
    {
      index: 0,
      vendor: "nvidia",
      name: "NVIDIA GB10",
      memory_total_bytes: null,
      memory_used_bytes: 0,
      memory_source: "unified",
      driver_version: "580.65.06",
      driver_status: "ok",
      util_pct: 0,
      temp_c: 47,
      power_w: 11.37,
    },
  ],
  runtimes: [
    {
      kind: "ollama",
      version: "0.32.13",
      install_method: "binary",
      service_state: "active",
      model_path: "/root/.ollama/models",
      disk_total_bytes: 0,
      disk_free_bytes: 0,
    },
  ],
};

const hostUpsert = () => prisma.host.upsert as ReturnType<typeof vi.fn>;
const gpuUpsert = () => prisma.gpu.upsert as ReturnType<typeof vi.fn>;
const runtimeUpsert = () => prisma.runtime.upsert as ReturnType<typeof vi.fn>;
const convergenceRunCreate = () => prisma.convergenceRun.create as ReturnType<typeof vi.fn>;
const hostModelDeleteMany = () => prisma.hostModel.deleteMany as ReturnType<typeof vi.fn>;
const hostModelUpsert = () => prisma.hostModel.upsert as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_ENROLL_TOKEN = ENROLL_TOKEN;
});

describe("POST /api/agent/checkin", () => {
  it("creates a pending, non-converging host for an unknown node_name", async () => {
    hostUpsert().mockResolvedValue(mockHost());

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);

    expect(res.status).toBe(200);
    expect(prisma.host.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { nodeName: "node-a" },
        create: expect.objectContaining({
          nodeName: "node-a",
          approvalState: "pending",
          converge: false,
        }),
      })
    );
    const data = await res.json();
    expect(data.status).toBe("pending");
  });

  it("upserts the host in one call rather than reading then branching", async () => {
    // findUnique-then-create loses the race between two concurrent first
    // check-ins from the same node: both read null and the second create
    // violates nodeName's unique constraint. A single upsert cannot.
    hostUpsert().mockResolvedValue(mockHost());

    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(authedRequest(basePayload) as never);

    expect(prisma.host.upsert).toHaveBeenCalledTimes(1);
    expect(hostUpsert().mock.calls[0][0].where).toEqual({ nodeName: "node-a" });
  });

  it("updates facts and lastCheckInAt for an existing host without resetting approvalState or roleId", async () => {
    hostUpsert().mockResolvedValue(
      mockHost({ id: "host_1", approvalState: "approved", roleId: "role_1" })
    );

    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(authedRequest(basePayload) as never);

    expect(prisma.host.upsert).toHaveBeenCalledTimes(1);
    const call = hostUpsert().mock.calls[0][0];
    expect(call.update).toHaveProperty("lastCheckInAt");
    expect(call.update).not.toHaveProperty("approvalState");
    expect(call.update).not.toHaveProperty("converge");
    expect(call.update).not.toHaveProperty("roleId");
  });

  it("sets approvalState and converge on create only, never on update", async () => {
    hostUpsert().mockResolvedValue(mockHost({ approvalState: "approved" }));

    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(authedRequest(basePayload) as never);

    const call = hostUpsert().mock.calls[0][0];
    const updateKeys = Object.keys(call.update);
    for (const operatorOwned of ["approvalState", "converge", "roleId"]) {
      expect(updateKeys).not.toContain(operatorOwned);
    }
    expect(call.create.approvalState).toBe("pending");
    expect(call.create.converge).toBe(false);
    expect(call.create).not.toHaveProperty("roleId");
  });

  it("returns no desired state whatsoever for a pending host", async () => {
    hostUpsert().mockResolvedValue(mockHost({ approvalState: "pending" }));

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);
    const data = await res.json();

    expect(data).not.toHaveProperty("role");
    expect(data).not.toHaveProperty("desiredState");
    expect(data).not.toHaveProperty("roleId");
    expect(data).not.toHaveProperty("config");
    expect(Object.keys(data)).toEqual(["status"]);
  });

  it("upserts GPU rows by [hostId, index] rather than creating duplicates", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    gpuUpsert().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(authedRequest(basePayload) as never);
    await POST(authedRequest(basePayload) as never);

    expect(prisma.gpu.upsert).toHaveBeenCalledTimes(2);
    const call = gpuUpsert().mock.calls[0][0];
    expect(call.where).toEqual({ hostId_index: { hostId: "host_1", index: 0 } });
  });

  it("stores a null memory_total_bytes as null, not 0, for a unified-memory GPU", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    gpuUpsert().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(authedRequest(basePayload) as never);

    const call = gpuUpsert().mock.calls[0][0];
    expect(call.create.memoryTotalBytes).toBeNull();
    expect(call.update.memoryTotalBytes).toBeNull();
    expect(call.create.memoryTotalBytes).not.toBe(0);
  });

  it("returns 401 for a missing Authorization header", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(request(basePayload) as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed Authorization header", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      request(basePayload, { Authorization: "Bearer wrong-token" }) as never
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token has a different length than expected (no exception)", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      request(basePayload, { Authorization: "Bearer short" }) as never
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong token of the exact same length as the expected one", async () => {
    // A same-length wrong token is the only input that actually reaches
    // timingSafeEqual with a mismatch. The other wrong-token tests differ in
    // length, so they short-circuit on the length check and would still pass
    // even if the comparison itself always returned true.
    const sameLengthWrongToken = "x".repeat(ENROLL_TOKEN.length);
    expect(sameLengthWrongToken).toHaveLength(ENROLL_TOKEN.length);
    expect(sameLengthWrongToken).not.toBe(ENROLL_TOKEN);

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      request(basePayload, {
        Authorization: `Bearer ${sameLengthWrongToken}`,
      }) as never
    );
    expect(res.status).toBe(401);
  });

  it("performs the whole check-in inside a single transaction", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    gpuUpsert().mockResolvedValue({});
    runtimeUpsert().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);

    expect(res.status).toBe(200);
    // Host + GPU + runtime writes must be atomic: a partial check-in would
    // leave a host with this check-in's GPUs and no runtimes at all.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("returns desired state for an approved host with a role, matching its parsed declaration", async () => {
    const desiredState = JSON.stringify({
      runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
    });
    hostUpsert().mockResolvedValue(
      mockHost({
        approvalState: "approved",
        converge: true,
        roleId: "role_1",
        role: { id: "role_1", name: "gpu-workers", desiredState },
      })
    );

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);
    const data = await res.json();

    expect(data.status).toBe("approved");
    expect(data.converge).toBe(true);
    expect(data.desired).toEqual({
      runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
    });
  });

  it("returns no desired state for an approved host with no role assigned", async () => {
    hostUpsert().mockResolvedValue(
      mockHost({ approvalState: "approved", roleId: null, role: null })
    );

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);
    const data = await res.json();

    expect(data).not.toHaveProperty("desired");
  });

  it("still returns desired state for a host with converge disabled, but reflects converge:false so the agent can veto locally", async () => {
    const desiredState = JSON.stringify({
      runtimes: { ollama: { state: "present", models: [] } },
    });
    hostUpsert().mockResolvedValue(
      mockHost({
        approvalState: "approved",
        converge: false,
        roleId: "role_1",
        role: { id: "role_1", name: "gpu-workers", desiredState },
      })
    );

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);
    const data = await res.json();

    expect(data.converge).toBe(false);
    expect(data.desired).toBeDefined();
  });

  it("carries a declared model's sizeBytes to the agent as size_bytes, the key models.py reads", async () => {
    const desiredState = JSON.stringify({
      runtimes: {
        ollama: {
          state: "present",
          models: [{ name: "qwen3:32b", state: "present", sizeBytes: 20_000_000_000 }],
        },
      },
    });
    hostUpsert().mockResolvedValue(
      mockHost({
        approvalState: "approved",
        converge: true,
        roleId: "role_1",
        role: { id: "role_1", name: "gpu-workers", desiredState },
      })
    );

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);
    const data = await res.json();

    expect(data.desired.runtimes.ollama.models).toEqual([
      { name: "qwen3:32b", state: "present", size_bytes: 20_000_000_000 },
    ]);
    // The TS-idiomatic camelCase name must never leak onto the wire; the
    // agent only ever reads the snake_case form.
    expect(JSON.stringify(data.desired)).not.toContain("sizeBytes");
  });

  it("omits desired state and does not 500 when a role's desiredState is invalid JSON", async () => {
    hostUpsert().mockResolvedValue(
      mockHost({
        approvalState: "approved",
        roleId: "role_1",
        role: { id: "role_1", name: "broken", desiredState: "{ not valid json" },
      })
    );

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).not.toHaveProperty("desired");
  });

  it("never serializes a command, script, exec, or sh key anywhere in the response, even with models declared", async () => {
    const desiredState = JSON.stringify({
      runtimes: {
        ollama: {
          state: "present",
          version: "0.32.13",
          models: [{ name: "llama3", state: "present" }],
        },
        vllm: { state: "absent", models: [] },
      },
    });
    hostUpsert().mockResolvedValue(
      mockHost({
        approvalState: "approved",
        converge: true,
        roleId: "role_1",
        role: { id: "role_1", name: "gpu-workers", desiredState },
      })
    );

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);
    const data = await res.json();

    const keys = collectKeys(data);
    for (const forbidden of ["command", "script", "exec", "sh"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("returns 400 when node_name is missing", async () => {
    const { POST } = await import("@/app/api/agent/checkin/route");
    const payloadWithoutNodeName: Record<string, unknown> = { ...basePayload };
    delete payloadWithoutNodeName.node_name;
    const res = await POST(authedRequest(payloadWithoutNodeName) as never);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/agent/checkin installed-model inventory pruning", () => {
  // The finding this guards: `_ollama_models()` used to return `[]` on every
  // probe failure — connection refused, malformed body, whatever — which is
  // indistinguishable from "genuinely nothing installed." This route's
  // deleteMany must fire only on the latter. See
  // `agent/zllama_agent/facts.py`.
  const runtimeWithModels = (models: unknown) => ({
    ...basePayload,
    runtimes: [{ ...basePayload.runtimes[0], models }],
  });

  it("does not prune existing HostModel rows when the runtime omits models entirely", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    runtimeUpsert().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);

    expect(res.status).toBe(200);
    expect(hostModelDeleteMany()).not.toHaveBeenCalled();
    expect(hostModelUpsert()).not.toHaveBeenCalled();
  });

  it("does not prune existing HostModel rows when the runtime reports models: null", async () => {
    // `null` is what a current agent sends when its own probe failed — it
    // must be treated exactly like `undefined`, never like a real `[]`.
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    runtimeUpsert().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(runtimeWithModels(null)) as never);

    expect(res.status).toBe(200);
    expect(hostModelDeleteMany()).not.toHaveBeenCalled();
    expect(hostModelUpsert()).not.toHaveBeenCalled();
  });

  it("prunes existing HostModel rows when the runtime reports a real empty models: []", async () => {
    // An empty array is a genuine report of "nothing installed" — the only
    // shape that may trigger the prune.
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    runtimeUpsert().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(runtimeWithModels([])) as never);

    expect(res.status).toBe(200);
    expect(hostModelDeleteMany()).toHaveBeenCalledTimes(1);
    expect(hostModelDeleteMany()).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          hostId: "host_1",
          runtimeKind: "ollama",
          name: { notIn: [] },
        }),
      })
    );
  });
});

describe("POST /api/agent/checkin external vllm runtime", () => {
  // The finding this guards: on a host with weights bind-mounted from a
  // container but no host-installed `vllm` package, the agent now reports a
  // vllm runtime with `install_method: "external"` and `version: null`
  // rather than omitting the runtime entirely (see
  // `agent/zllama_agent/facts.py::_vllm_runtime`). The route must accept and
  // upsert that shape cleanly rather than rejecting a null version.
  const externalVllmPayload = {
    ...basePayload,
    runtimes: [
      {
        kind: "vllm",
        version: null,
        install_method: "external",
        service_state: null,
        model_path: "/model",
        disk_total_bytes: 800_000_000_000,
        disk_free_bytes: 100_000_000_000,
        models: [{ name: "model", size_bytes: 75_000_000_000, digest: null }],
      },
    ],
  };

  it("upserts an external vllm runtime with a null version cleanly", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    runtimeUpsert().mockResolvedValue({});
    hostModelUpsert().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(externalVllmPayload) as never);

    expect(res.status).toBe(200);
    expect(prisma.runtime.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hostId_kind: { hostId: "host_1", kind: "vllm" } },
        create: expect.objectContaining({
          hostId: "host_1",
          kind: "vllm",
          version: null,
          installMethod: "external",
          serviceState: null,
          modelPath: "/model",
        }),
      })
    );
    expect(prisma.hostModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          hostId: "host_1",
          runtimeKind: "vllm",
          name: "model",
        }),
      })
    );
  });
});

describe("POST /api/agent/checkin payload validation", () => {
  // Each of these shapes used to reach Prisma with a missing required column,
  // or hit a for...of over a non-iterable, and surface as a 500.
  const malformed: Array<[string, unknown]> = [
    ["a non-object body", "node-a"],
    ["an array body", []],
    ["an empty node_name", { ...basePayload, node_name: "" }],
    ["a non-string node_name", { ...basePayload, node_name: 42 }],
    ["a missing host", { node_name: "node-a" }],
    ["a non-object host", { node_name: "node-a", host: "x86_64" }],
    ["a host without arch", { node_name: "node-a", host: { os: "Linux" } }],
    ["a host without os", { node_name: "node-a", host: { arch: "x86_64" } }],
    ["a string gpus", { ...basePayload, gpus: "x" }],
    ["an object gpus", { ...basePayload, gpus: {} }],
    ["a non-object gpu element", { ...basePayload, gpus: ["x"] }],
    [
      "a gpu without an index",
      {
        ...basePayload,
        gpus: [{ vendor: "nvidia", name: "GB10", memory_source: "unified" }],
      },
    ],
    [
      "a gpu without a vendor",
      {
        ...basePayload,
        gpus: [{ index: 0, name: "GB10", memory_source: "unified" }],
      },
    ],
    [
      "a gpu with a non-numeric memory_total_bytes",
      {
        ...basePayload,
        gpus: [
          {
            index: 0,
            vendor: "nvidia",
            name: "GB10",
            memory_source: "unified",
            memory_total_bytes: "128GB",
          },
        ],
      },
    ],
    ["a string runtimes", { ...basePayload, runtimes: "x" }],
    ["an object runtimes", { ...basePayload, runtimes: {} }],
    ["a non-object runtime element", { ...basePayload, runtimes: ["ollama"] }],
    [
      "a runtime without a kind",
      { ...basePayload, runtimes: [{ version: "0.32.13" }] },
    ],
  ];

  for (const [label, body] of malformed) {
    it(`returns 400 with an actionable message for ${label}`, async () => {
      hostUpsert().mockResolvedValue(mockHost());
      gpuUpsert().mockResolvedValue({});
      runtimeUpsert().mockResolvedValue({});

      const { POST } = await import("@/app/api/agent/checkin/route");
      const res = await POST(authedRequest(body) as never);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(typeof data.error).toBe("string");
      expect(data.error.length).toBeGreaterThan(0);
      // A rejected payload must not touch the database at all.
      expect(prisma.host.upsert).not.toHaveBeenCalled();
    });
  }
});

describe("POST /api/agent/checkin convergence reporting", () => {
  const convergencePayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
    ...basePayload,
    convergence: {
      status: "succeeded",
      actions: [
        { kind: "install_runtime", runtime: "ollama", target_version: "0.32.13", reason: "x" },
      ],
      outcomes: [
        {
          action: { kind: "install_runtime", runtime: "ollama" },
          exit_code: 0,
          stdout: "ok",
          stderr: "",
          duration_ms: 5,
        },
      ],
      error: null,
      ...overrides,
    },
  });

  it("creates a ConvergenceRun with the reported status and actions serialized as JSON text", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(convergencePayload()) as never);

    expect(res.status).toBe(200);
    expect(prisma.convergenceRun.create).toHaveBeenCalledTimes(1);
    const call = convergenceRunCreate().mock.calls[0][0];
    expect(call.data.hostId).toBe("host_1");
    expect(call.data.status).toBe("succeeded");
    expect(typeof call.data.actions).toBe("string");
    expect(JSON.parse(call.data.actions)).toEqual([
      {
        kind: "install_runtime",
        runtime: "ollama",
        target_version: "0.32.13",
        reason: "x",
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        duration_ms: 5,
      },
    ]);
  });

  it("creates no run when the check-in carries no convergence key — absence is not an empty run", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(basePayload) as never);

    expect(res.status).toBe(200);
    expect(prisma.convergenceRun.create).not.toHaveBeenCalled();
  });

  it("rejects a convergence report with an unknown status with 400 and touches no table", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      authedRequest(convergencePayload({ status: "in_progress" })) as never
    );

    expect(res.status).toBe(400);
    expect(prisma.host.upsert).not.toHaveBeenCalled();
    expect(prisma.convergenceRun.create).not.toHaveBeenCalled();
  });

  it.each([
    "no_changes",
    "vetoed",
    "vetoed_remote",
    "dry_run",
    "busy",
    "succeeded",
    "failed",
    "blocked",
    "cooling_down",
  ])(
    "accepts the closed status %s",
    async (status) => {
      hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
      convergenceRunCreate().mockResolvedValue({});

      const { POST } = await import("@/app/api/agent/checkin/route");
      const res = await POST(
        authedRequest(convergencePayload({ status, actions: [], outcomes: [] })) as never
      );

      expect(res.status).toBe(200);
      expect(convergenceRunCreate().mock.calls[0][0].data.status).toBe(status);
    }
  );

  it("truncates a 10 MB stdout rather than writing it verbatim", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const hugeStdout = "x".repeat(10 * 1024 * 1024);
    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      authedRequest(
        convergencePayload({
          outcomes: [
            {
              action: { kind: "install_runtime", runtime: "ollama" },
              exit_code: 0,
              stdout: hugeStdout,
              stderr: "",
              duration_ms: 1,
            },
          ],
        })
      ) as never
    );

    expect(res.status).toBe(200);
    const storedActions = JSON.parse(convergenceRunCreate().mock.calls[0][0].data.actions);
    expect(storedActions[0].stdout.length).toBeLessThan(hugeStdout.length);
    expect(storedActions[0].stdout).not.toBe(hugeStdout);
  });

  it("stores captured output unchanged exactly at the 64 KiB truncation boundary", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const exactlyAtLimit = "y".repeat(64 * 1024);
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(
      authedRequest(
        convergencePayload({
          outcomes: [
            {
              action: { kind: "install_runtime", runtime: "ollama" },
              exit_code: 0,
              stdout: exactlyAtLimit,
              stderr: "",
              duration_ms: 1,
            },
          ],
        })
      ) as never
    );

    const storedActions = JSON.parse(convergenceRunCreate().mock.calls[0][0].data.actions);
    expect(storedActions[0].stdout).toBe(exactlyAtLimit);
  });

  it("truncates captured output one character past the 64 KiB boundary", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const oneOverLimit = "z".repeat(64 * 1024 + 1);
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(
      authedRequest(
        convergencePayload({
          outcomes: [
            {
              action: { kind: "install_runtime", runtime: "ollama" },
              exit_code: 0,
              stdout: oneOverLimit,
              stderr: "",
              duration_ms: 1,
            },
          ],
        })
      ) as never
    );

    const storedActions = JSON.parse(convergenceRunCreate().mock.calls[0][0].data.actions);
    expect(storedActions[0].stdout).not.toBe(oneOverLimit);
    expect(storedActions[0].stdout.startsWith("z".repeat(64 * 1024))).toBe(true);
    expect(storedActions[0].stdout).toContain("truncated");
  });

  it("stores a backed-off action with its next_retry_at and no fabricated exit code", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      authedRequest(
        convergencePayload({
          status: "cooling_down",
          actions: [
            {
              kind: "install_runtime",
              runtime: "ollama",
              target_version: "0.32.13",
              reason: "declared present but not installed",
            },
          ],
          outcomes: [
            {
              action: { kind: "install_runtime", runtime: "ollama" },
              outcome: "backed_off",
              next_retry_at: 1_700_000_665,
              consecutive_failures: 2,
              stdout: "",
              stderr: "",
              duration_ms: 0,
            },
          ],
        })
      ) as never
    );

    expect(res.status).toBe(200);
    const call = convergenceRunCreate().mock.calls[0][0];
    expect(call.data.status).toBe("cooling_down");
    const storedActions = JSON.parse(call.data.actions);
    expect(storedActions).toHaveLength(1);
    expect(storedActions[0].outcome).toBe("backed_off");
    expect(storedActions[0].next_retry_at).toBe(1_700_000_665);
    expect(storedActions[0].consecutive_failures).toBe(2);
    expect(storedActions[0].kind).toBe("install_runtime");
    // The action never ran, so there is no exit status to report. A stored
    // `exit_code: 0` would read as "this succeeded" — the opposite of true.
    expect("exit_code" in storedActions[0]).toBe(false);
  });

  it("still truncates captured output on a backed-off entry's stream", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const hugeStderr = "q".repeat(10 * 1024 * 1024);
    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(
      authedRequest(
        convergencePayload({
          status: "cooling_down",
          outcomes: [
            {
              action: { kind: "install_runtime", runtime: "ollama" },
              outcome: "backed_off",
              next_retry_at: 1_700_000_665,
              consecutive_failures: 1,
              stdout: "",
              stderr: hugeStderr,
              duration_ms: 0,
            },
          ],
        })
      ) as never
    );

    const storedActions = JSON.parse(convergenceRunCreate().mock.calls[0][0].data.actions);
    expect(storedActions[0].stderr.length).toBeLessThan(hugeStderr.length);
    expect(storedActions[0].stderr).toContain("truncated");
  });

  it("rejects an outcome that omits exit_code without claiming to be backed off", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      authedRequest(
        convergencePayload({
          outcomes: [{ action: { kind: "install_runtime", runtime: "ollama" }, stdout: "" }],
        })
      ) as never
    );

    expect(res.status).toBe(400);
    expect(prisma.convergenceRun.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown outcome label rather than storing it", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      authedRequest(
        convergencePayload({
          outcomes: [
            {
              action: { kind: "install_runtime", runtime: "ollama" },
              outcome: "gave_up",
              exit_code: 0,
            },
          ],
        })
      ) as never
    );

    expect(res.status).toBe(400);
    expect(prisma.convergenceRun.create).not.toHaveBeenCalled();
  });

  it("cannot alter approvalState, converge, or roleId via the convergence report", async () => {
    hostUpsert().mockResolvedValue(
      mockHost({ id: "host_1", approvalState: "pending", converge: false, roleId: null })
    );
    convergenceRunCreate().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(
      authedRequest(
        convergencePayload({
          approvalState: "approved",
          converge: true,
          roleId: "role_evil",
        })
      ) as never
    );

    // The only host write is the upsert already covered above; its create/
    // update objects never read from payload.convergence.
    const call = hostUpsert().mock.calls[0][0];
    expect(call.update).not.toHaveProperty("approvalState");
    expect(call.update).not.toHaveProperty("converge");
    expect(call.update).not.toHaveProperty("roleId");
    expect(call.create.approvalState).toBe("pending");
    expect(call.create.converge).toBe(false);

    // And the stored convergence run itself never carries those keys either.
    const storedData = convergenceRunCreate().mock.calls[0][0].data;
    expect(storedData).not.toHaveProperty("approvalState");
    expect(storedData).not.toHaveProperty("converge");
    expect(storedData).not.toHaveProperty("roleId");
  });

  it("accepts a blocked convergence status — the agent reports this when a pull's disk check fails", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(authedRequest(convergencePayload({ status: "blocked" })) as never);

    expect(res.status).toBe(200);
    const call = convergenceRunCreate().mock.calls[0][0];
    expect(call.data.status).toBe("blocked");
  });

  it("stores current_action and progress_pct when the report includes them", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    const res = await POST(
      authedRequest(
        convergencePayload({ current_action: "pulling qwen3:32b", progress_pct: 42 })
      ) as never
    );

    expect(res.status).toBe(200);
    const call = convergenceRunCreate().mock.calls[0][0];
    expect(call.data.currentAction).toBe("pulling qwen3:32b");
    expect(call.data.progressPct).toBe(42);
  });

  it("stores null for current_action and progress_pct when the report omits them", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    await POST(authedRequest(convergencePayload()) as never);

    const call = convergenceRunCreate().mock.calls[0][0];
    expect(call.data.currentAction).toBeNull();
    expect(call.data.progressPct).toBeNull();
  });

  it.each([-1, 100.01, 140])(
    "rejects a progress_pct of %s with 400 and never writes it",
    async (progressPct) => {
      hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));

      const { POST } = await import("@/app/api/agent/checkin/route");
      const res = await POST(
        authedRequest(convergencePayload({ progress_pct: progressPct })) as never
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/progress_pct/);
      expect(prisma.convergenceRun.create).not.toHaveBeenCalled();
    }
  );

  it("accepts the boundary values 0 and 100 for progress_pct", async () => {
    hostUpsert().mockResolvedValue(mockHost({ id: "host_1" }));
    convergenceRunCreate().mockResolvedValue({});

    const { POST } = await import("@/app/api/agent/checkin/route");
    for (const progressPct of [0, 100]) {
      const res = await POST(
        authedRequest(convergencePayload({ progress_pct: progressPct })) as never
      );
      expect(res.status).toBe(200);
    }
  });
});
