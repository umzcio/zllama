import { describe, it, expect } from "vitest";
import { parseIntParam, parseDateParam } from "@/lib/query-params";

describe("parseIntParam", () => {
  it("returns fallback when raw is null", () => {
    expect(parseIntParam(null, 5, 1, 10)).toBe(5);
  });

  it("returns fallback when raw is empty", () => {
    expect(parseIntParam("", 5, 1, 10)).toBe(5);
  });

  it("returns null for non-numeric input", () => {
    expect(parseIntParam("abc", 5, 1, 10)).toBeNull();
  });

  it("returns null when below min", () => {
    expect(parseIntParam("0", 5, 1, 10)).toBeNull();
  });

  it("returns null when above max", () => {
    expect(parseIntParam("11", 5, 1, 10)).toBeNull();
  });

  it("returns the parsed integer when within range", () => {
    expect(parseIntParam("7", 5, 1, 10)).toBe(7);
  });

  it("returns null for a non-integer value", () => {
    expect(parseIntParam("3.5", 5, 1, 10)).toBeNull();
  });

  it("returns null for a negative value", () => {
    expect(parseIntParam("-1", 5, -10, 10)).not.toBeNull();
    expect(parseIntParam("-1", 5, 0, 10)).toBeNull();
  });
});

describe("parseDateParam", () => {
  it("returns undefined when raw is null", () => {
    expect(parseDateParam(null)).toBeUndefined();
  });

  it("returns undefined when raw is empty", () => {
    expect(parseDateParam("")).toBeUndefined();
  });

  it("returns a Date for a valid ISO date string", () => {
    const result = parseDateParam("2026-01-01T00:00:00.000Z");
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for an invalid date string", () => {
    expect(parseDateParam("garbage")).toBeNull();
  });
});
