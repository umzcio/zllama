import { describe, it, expect } from "vitest";
import { computeDrift, STALE_AFTER_MS, type DriftInput, type HostFacts } from "@/lib/drift";
import type { Declaration } from "@/lib/desired-state";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function makeHost(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    nodeName: "node-01",
    roleId: "role-1",
    converge: true,
    approvalState: "approved",
    lastCheckInAt: NOW,
    runtimes: [],
    gpus: [],
    ...overrides,
  };
}

function makeDeclaration(overrides: Partial<Declaration> = {}): Declaration {
  return { runtimes: {}, ...overrides };
}

function makeInput(overrides: Partial<DriftInput> = {}): DriftInput {
  return {
    host: makeHost(),
    declaration: makeDeclaration(),
    now: NOW,
    ...overrides,
  };
}

describe("computeDrift", () => {
  it("case 1: declared present 0.32.13, actual 0.32.13 -> in_sync", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "0.32.13" }] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("in_sync");
    expect(result.runtimes).toEqual([
      {
        kind: "ollama",
        state: "in_sync",
        desiredVersion: "0.32.13",
        actualVersion: "0.32.13",
        models: [],
      },
    ]);
  });

  it("case 2: declared 0.32.13, actual 0.32.3 -> drifted, both versions surfaced", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "0.32.3" }] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("drifted");
    expect(result.runtimes[0]).toMatchObject({
      kind: "ollama",
      state: "drifted",
      desiredVersion: "0.32.13",
      actualVersion: "0.32.3",
    });
  });

  it("case 3: declared present with no version, actual any version -> in_sync", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "9.9.9" }] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("in_sync");
  });

  it("case 4: declared absent, runtime not installed -> in_sync", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "absent", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("in_sync");
  });

  it("case 5: declared absent, runtime installed -> drifted", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "0.32.13" }] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "absent", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("drifted");
  });

  it("case 6: declared present, runtime not installed -> drifted", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("drifted");
  });

  it("case 7: no role assigned -> unmanaged, regardless of what is installed", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ roleId: null, runtimes: [{ kind: "ollama", version: "0.32.13" }] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "absent", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("unmanaged");
  });

  it("case 8: converge false with a role and real drift -> unmanaged (host veto wins)", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ converge: false, runtimes: [] }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("unmanaged");
  });

  it("case 9: approvalState pending -> unmanaged", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ approvalState: "pending" }),
      })
    );
    expect(result.state).toBe("unmanaged");
  });

  it("case 10: lastCheckInAt older than STALE_AFTER_MS -> stale, outranks drift", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          lastCheckInAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1),
          runtimes: [],
        }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("stale");
  });

  it("case 11: lastCheckInAt exactly at the boundary -> not stale", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          lastCheckInAt: new Date(NOW.getTime() - STALE_AFTER_MS),
        }),
      })
    );
    expect(result.state).not.toBe("stale");
  });

  it("case 12: failed GPU driver plus real drift -> blocked, with a reason naming the driver", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [],
          gpus: [{ driverStatus: "failed" }],
        }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );
    expect(result.state).toBe("blocked");
    expect(result.runtimes[0].state).toBe("blocked");
    expect(result.runtimes[0].reason).toMatch(/driver/i);
  });

  it("case 13: one runtime in_sync, one drifted -> host state is drifted (worst wins)", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [
            { kind: "ollama", version: "0.32.13" },
            { kind: "vllm", version: "0.5.0" },
          ],
        }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [] },
            vllm: { state: "present", version: "0.6.0", models: [] },
          },
        }),
      })
    );
    expect(result.state).toBe("drifted");
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    const vllm = result.runtimes.find((r) => r.kind === "vllm");
    expect(ollama?.state).toBe("in_sync");
    expect(vllm?.state).toBe("drifted");
  });

  it("case 14: version comparison is exact string equality, never semver", () => {
    const inSync = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [{ kind: "vllm", version: "0.1.dev1+g53420169e.d20260724" }],
        }),
        declaration: makeDeclaration({
          runtimes: { vllm: { state: "present", version: "0.1.dev1+g53420169e.d20260724", models: [] } },
        }),
      })
    );
    expect(inSync.state).toBe("in_sync");

    const drifted = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [{ kind: "vllm", version: "0.1.dev2+gabc.d20260725" }],
        }),
        declaration: makeDeclaration({
          runtimes: { vllm: { state: "present", version: "0.1.dev1+g53420169e.d20260724", models: [] } },
        }),
      })
    );
    expect(drifted.state).toBe("drifted");
  });

  it("case 15: computeDrift is synchronous, no I/O", () => {
    const result = computeDrift(makeInput());
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
  });
});

describe("computeDrift — model drift", () => {
  it("model case 1: declared present, actually present -> in_sync", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [{ kind: "ollama", version: "0.32.13", models: [{ name: "qwen3:32b", sizeBytes: 1 }] }],
        }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "present" }] },
          },
        }),
      })
    );
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.state).toBe("in_sync");
    expect(ollama?.models).toEqual([{ name: "qwen3:32b", state: "in_sync" }]);
  });

  it("model case 2: declared present, absent locally -> drifted", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "0.32.13", models: [] }] }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "present" }] },
          },
        }),
      })
    );
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.state).toBe("drifted");
    expect(ollama?.models).toEqual([{ name: "qwen3:32b", state: "drifted" }]);
  });

  it("model case 3: declared absent, present locally -> drifted", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [{ kind: "ollama", version: "0.32.13", models: [{ name: "qwen3:32b", sizeBytes: 1 }] }],
        }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "absent" }] },
          },
        }),
      })
    );
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.state).toBe("drifted");
    expect(ollama?.models).toEqual([{ name: "qwen3:32b", state: "drifted" }]);
  });

  it("model case 4: declared absent, absent locally -> in_sync", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "0.32.13", models: [] }] }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "absent" }] },
          },
        }),
      })
    );
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.state).toBe("in_sync");
    expect(ollama?.models).toEqual([{ name: "qwen3:32b", state: "in_sync" }]);
  });

  it("model case 5: present but undeclared -> unmanaged, never drifted, and never dropped from the report", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [
            {
              kind: "ollama",
              version: "0.32.13",
              models: [{ name: "stray-model:latest", sizeBytes: 42 }],
            },
          ],
        }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.models).toEqual([{ name: "stray-model:latest", state: "unmanaged" }]);
    expect(ollama?.models[0].state).not.toBe("drifted");
  });

  it("model case 6: runtime in_sync on version but drifted on a model -> runtime drifted, model state visible", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "0.32.13", models: [] }] }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "present" }] },
          },
        }),
      })
    );
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.state).toBe("drifted");
    expect(ollama?.models).toEqual([{ name: "qwen3:32b", state: "drifted" }]);
    expect(result.state).toBe("drifted");
  });

  it("model case 7: comparison is exact-string, case-sensitive — qwen3:32b != qwen3:32B", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [{ kind: "ollama", version: "0.32.13", models: [{ name: "qwen3:32B", sizeBytes: 1 }] }],
        }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "present" }] },
          },
        }),
      })
    );
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    // The declared "qwen3:32b" was not found (only "qwen3:32B" is installed),
    // so it is drifted; the installed "qwen3:32B" is itself unmanaged.
    expect(ollama?.models).toEqual(
      expect.arrayContaining([
        { name: "qwen3:32b", state: "drifted" },
        { name: "qwen3:32B", state: "unmanaged" },
      ])
    );
  });

  it("model case 8: a stale host reports no model drift at all", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          lastCheckInAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1),
          runtimes: [{ kind: "ollama", version: "0.32.13", models: [] }],
        }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "present" }] },
          },
        }),
      })
    );
    expect(result.state).toBe("stale");
    const ollama = result.runtimes.find((r) => r.kind === "ollama");
    expect(ollama?.state).toBe("stale");
    expect(ollama?.models).toEqual([]);
  });

  it("model case 9: computeDrift with model drift remains synchronous, no I/O", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({ runtimes: [{ kind: "ollama", version: "0.32.13", models: [] }] }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [{ name: "qwen3:32b", state: "present" }] },
          },
        }),
      })
    );
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
  });
});

describe("computeDrift — state precedence", () => {
  it("model case 10: one drifted runtime plus one undeclared model -> host is drifted, not unmanaged", () => {
    // The regression this exists for: "unmanaged" used to outrank "drifted",
    // so a single model nobody declared escalated its runtime *and* its host
    // to "unmanaged" and hid a real version drift underneath it. "Not our
    // business" is not worse than "differs from intent".
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [
            { kind: "ollama", version: "0.32.3", models: [] },
            {
              kind: "vllm",
              version: "0.11.2",
              models: [{ name: "someone-elses/model", sizeBytes: 42 }],
            },
          ],
        }),
        declaration: makeDeclaration({
          runtimes: {
            ollama: { state: "present", version: "0.32.13", models: [] },
            vllm: { state: "present", version: "0.11.2", models: [] },
          },
        }),
      })
    );

    expect(result.state).toBe("drifted");
    expect(result.runtimes.find((r) => r.kind === "ollama")?.state).toBe("drifted");
    // The undeclared model is still reported, just not escalated past drift.
    const vllm = result.runtimes.find((r) => r.kind === "vllm");
    expect(vllm?.state).toBe("unmanaged");
    expect(vllm?.models).toEqual([{ name: "someone-elses/model", state: "unmanaged" }]);
  });

  it("model case 11: an undeclared model never masks a blocked runtime either", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          gpus: [{ driverStatus: "failed" }],
          runtimes: [
            {
              kind: "ollama",
              version: "0.32.3",
              models: [{ name: "someone-elses/model", sizeBytes: 42 }],
            },
          ],
        }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );

    expect(result.state).toBe("blocked");
    expect(result.runtimes[0].state).toBe("blocked");
  });

  it("model case 12: an undeclared model still escalates a runtime that is otherwise in_sync", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          runtimes: [
            {
              kind: "ollama",
              version: "0.32.13",
              models: [{ name: "someone-elses/model", sizeBytes: 42 }],
            },
          ],
        }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );

    expect(result.state).toBe("unmanaged");
    expect(result.runtimes[0].state).toBe("unmanaged");
  });

  it("model case 13: a host with no role still reports unmanaged overall, whatever its runtimes drift", () => {
    // The host-level determination is made before any runtime is inspected,
    // so reordering the per-model/per-runtime rollup must not touch it.
    const result = computeDrift(
      makeInput({
        host: makeHost({
          roleId: null,
          runtimes: [{ kind: "ollama", version: "0.32.3", models: [] }],
        }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );

    expect(result.state).toBe("unmanaged");
    expect(result.runtimes[0].state).toBe("unmanaged");
  });

  it("model case 14: converge:false and approvalState:pending still report unmanaged over real drift", () => {
    for (const override of [{ converge: false }, { approvalState: "pending" }]) {
      const result = computeDrift(
        makeInput({
          host: makeHost({
            ...override,
            runtimes: [{ kind: "ollama", version: "0.32.3", models: [] }],
          }),
          declaration: makeDeclaration({
            runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
          }),
        })
      );
      expect(result.state).toBe("unmanaged");
    }
  });

  it("model case 15: stale still outranks everything, including a drifted runtime", () => {
    const result = computeDrift(
      makeInput({
        host: makeHost({
          lastCheckInAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1),
          runtimes: [{ kind: "ollama", version: "0.32.3", models: [] }],
        }),
        declaration: makeDeclaration({
          runtimes: { ollama: { state: "present", version: "0.32.13", models: [] } },
        }),
      })
    );

    expect(result.state).toBe("stale");
  });
});
