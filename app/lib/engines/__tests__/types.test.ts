import { describe, it, expect } from "vitest";
import { assertProxyable } from "@/lib/engines/types";

describe("assertProxyable", () => {
  const allow = ["/api/tags", "/api/generate"];

  it("allows an exact allowlisted path", () => {
    expect(assertProxyable(allow, "/api/tags")).toBe(true);
  });

  it("rejects a path that is not allowlisted", () => {
    expect(assertProxyable(allow, "/collective_rpc")).toBe(false);
  });

  it("rejects a path that merely starts with an allowlisted prefix", () => {
    expect(assertProxyable(allow, "/api/tagsextra")).toBe(false);
  });

  it("ignores a query string when matching", () => {
    expect(assertProxyable(allow, "/api/tags?x=1")).toBe(true);
  });

  it("rejects traversal attempts", () => {
    expect(assertProxyable(allow, "/api/tags/../collective_rpc")).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(assertProxyable(allow, "")).toBe(false);
  });
});
