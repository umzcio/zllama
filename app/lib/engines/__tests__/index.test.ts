import { describe, it, expect } from "vitest";
import { capabilityRefusal, getAdapter, isEngineKind } from "@/lib/engines";

describe("getAdapter", () => {
  it("returns the ollama adapter", () => {
    expect(getAdapter("ollama").kind).toBe("ollama");
  });

  it("returns the vllm adapter", () => {
    expect(getAdapter("vllm").kind).toBe("vllm");
  });

  it("throws on an unknown engine rather than defaulting", () => {
    expect(() => getAdapter("mystery" as never)).toThrow(/unknown engine/i);
  });
});

describe("isEngineKind", () => {
  it("recognizes the registered engines and nothing else", () => {
    expect(isEngineKind("ollama")).toBe(true);
    expect(isEngineKind("vllm")).toBe(true);
    expect(isEngineKind("mystery")).toBe(false);
    // Never confuse an inherited Object property for a registered engine.
    expect(isEngineKind("constructor")).toBe(false);
    expect(isEngineKind("toString")).toBe(false);
  });
});

describe("capabilityRefusal", () => {
  it("allows a capability the engine declares true", () => {
    expect(capabilityRefusal("ollama", "pullModel", "pulling models")).toBeNull();
    expect(capabilityRefusal("ollama", "deleteModel", "deleting models")).toBeNull();
  });

  it("refuses every model-management capability vLLM declares false", () => {
    for (const capability of ["pullModel", "deleteModel", "copyModel", "showModel"] as const) {
      const refusal = capabilityRefusal("vllm", capability, "the operation");
      expect(refusal).toContain("vllm");
      // Actionable: says where the operation actually belongs.
      expect(refusal).toMatch(/role/);
    }
  });

  it("refuses an unrecognized engine rather than defaulting to Ollama", () => {
    expect(capabilityRefusal("mystery", "pullModel", "pulling models")).toMatch(/mystery/);
  });
});
