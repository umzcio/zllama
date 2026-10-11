import { describe, it, expect } from "vitest";
import { parseDeclaration, serializeDeclaration } from "@/lib/desired-state";

describe("parseDeclaration", () => {
  it("parses a full valid declaration, preserving the exact version string", () => {
    const declaration = parseDeclaration(
      JSON.stringify({
        runtimes: {
          ollama: {
            state: "present",
            version: "0.32.13",
            // Ollama takes tags; the HuggingFace repo form belongs under vllm.
            models: [{ name: "qwen3:32b", state: "present" }, { name: "llama3.3:70b" }],
          },
          vllm: {
            state: "present",
            version: "0.11.2",
            models: [{ repo: "Qwen/Qwen3-32B" }],
          },
        },
        agent: { version: "0.1.0" },
      })
    );

    expect(declaration.runtimes.ollama?.state).toBe("present");
    expect(declaration.runtimes.ollama?.version).toBe("0.32.13");
    expect(declaration.runtimes.ollama?.models).toEqual([
      { name: "qwen3:32b", repo: undefined, state: "present" },
      { name: "llama3.3:70b", repo: undefined, state: "present" },
    ]);
    expect(declaration.runtimes.vllm?.models).toEqual([
      { name: undefined, repo: "Qwen/Qwen3-32B", state: "present" },
    ]);
    expect(declaration.agentVersion).toBe("0.1.0");
  });

  it("rejects a vLLM model declared with the Ollama name form", () => {
    // This is the silent-total-failure case: `name` used to validate for
    // vllm, be stored, be served, and reach the agent's `_vllm_pull` with no
    // repo id, whose TypeError main.py's bare `except Exception` swallowed —
    // so no convergence report was ever sent and the console showed nothing
    // at all: not a failure, not a run.
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: {
            vllm: { state: "present", models: [{ name: "Qwen/Qwen3-32B" }] },
          },
        })
      )
    ).toThrow(/must use "repo"/);
  });

  it("rejects an Ollama model declared with the vLLM repo form", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: {
            ollama: { state: "present", models: [{ repo: "Qwen/Qwen3-32B" }] },
          },
        })
      )
    ).toThrow(/must use "name"/);
  });

  it("names the offending path when the form does not match the engine", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: {
            vllm: {
              state: "present",
              models: [{ repo: "Qwen/Qwen3-32B" }, { name: "qwen3:32b" }],
            },
          },
        })
      )
    ).toThrow(/runtimes\.vllm\.models\[1\]/);
  });

  it("parses state: absent", () => {
    const declaration = parseDeclaration(
      JSON.stringify({ runtimes: { ollama: { state: "absent" } } })
    );
    expect(declaration.runtimes.ollama?.state).toBe("absent");
  });

  it("parses a missing version as 'any version'", () => {
    const declaration = parseDeclaration(
      JSON.stringify({ runtimes: { ollama: { state: "present" } } })
    );
    expect(declaration.runtimes.ollama?.version).toBeUndefined();
  });

  it("throws on an unknown top-level key, naming it", () => {
    expect(() =>
      parseDeclaration(JSON.stringify({ runtimez: {} }))
    ).toThrow(/runtimez/);
  });

  it("throws on an unknown key inside a runtime, naming it", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: { ollama: { state: "present", versoin: "0.32.13" } },
        })
      )
    ).toThrow(/versoin/);
  });

  it("throws on an unknown runtime kind", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({ runtimes: { llamacpp: { state: "present" } } })
      )
    ).toThrow(/llamacpp/);
  });

  it("throws on an invalid state value", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({ runtimes: { ollama: { state: "installed" } } })
      )
    ).toThrow(/state/);
  });

  it("throws when a model entry has neither name nor repo", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: { ollama: { state: "present", models: [{ state: "present" }] } },
        })
      )
    ).toThrow(/name.*repo|repo.*name/);
  });

  it("throws when a model entry has both name and repo", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: {
            ollama: {
              state: "present",
              models: [{ name: "qwen3:32b", repo: "Qwen/Qwen3-32B" }],
            },
          },
        })
      )
    ).toThrow(/name.*repo|repo.*name/);
  });

  it("parses an empty declaration when runtimes is absent entirely", () => {
    const declaration = parseDeclaration(JSON.stringify({ agent: { version: "0.1.0" } }));
    expect(declaration.runtimes).toEqual({});
    expect(declaration.agentVersion).toBe("0.1.0");
  });

  it("throws a clear error on malformed JSON, not a bare SyntaxError", () => {
    expect(() => parseDeclaration("{not valid json")).toThrow(/JSON/);
  });

  it("throws when a version is given as a number", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({ runtimes: { ollama: { state: "present", version: 0.32 } } })
      )
    ).toThrow(/version/);
  });

  it("parses a model's sizeBytes from a catalog-sourced declaration", () => {
    const declaration = parseDeclaration(
      JSON.stringify({
        runtimes: {
          ollama: {
            state: "present",
            models: [{ name: "qwen3:32b", state: "present", sizeBytes: 20_000_000_000 }],
          },
        },
      })
    );
    expect(declaration.runtimes.ollama?.models[0].sizeBytes).toBe(20_000_000_000);
  });

  it("still validates a hand-written declaration with no sizeBytes at all", () => {
    // A model size is optional: the agent's disk precondition treats an
    // absent size as unknown and blocks the pull as a fail-safe, but a
    // declaration with no size must not be rejected outright.
    const declaration = parseDeclaration(
      JSON.stringify({
        runtimes: {
          ollama: { state: "present", models: [{ name: "qwen3:32b", state: "present" }] },
        },
      })
    );
    expect(declaration.runtimes.ollama?.models[0].sizeBytes).toBeUndefined();
  });

  it("rejects a non-positive sizeBytes", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: {
            ollama: { state: "present", models: [{ name: "qwen3:32b", sizeBytes: 0 }] },
          },
        })
      )
    ).toThrow(/sizeBytes/);
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: {
            ollama: { state: "present", models: [{ name: "qwen3:32b", sizeBytes: -5 }] },
          },
        })
      )
    ).toThrow(/sizeBytes/);
  });

  it("serializeDeclaration round-trips through parseDeclaration, including agent.version", () => {
    const raw = JSON.stringify({
      runtimes: {
        ollama: {
          state: "present",
          version: "0.32.13",
          models: [{ name: "qwen3:32b", state: "present", sizeBytes: 20_000_000_000 }],
        },
      },
      agent: { version: "0.1.0" },
    });

    const roundTripped = serializeDeclaration(parseDeclaration(raw));

    // Re-parsing must not throw "unknown key agentVersion" — the naive
    // `JSON.stringify(declaration)` would produce exactly that, since
    // `agentVersion` only exists on the parsed TS side.
    const reparsed = parseDeclaration(roundTripped);
    expect(reparsed.agentVersion).toBe("0.1.0");
    expect(reparsed.runtimes.ollama?.models[0].sizeBytes).toBe(20_000_000_000);
  });

  it("rejects a non-numeric sizeBytes", () => {
    expect(() =>
      parseDeclaration(
        JSON.stringify({
          runtimes: {
            ollama: { state: "present", models: [{ name: "qwen3:32b", sizeBytes: "20GB" }] },
          },
        })
      )
    ).toThrow(/sizeBytes/);
  });
});
