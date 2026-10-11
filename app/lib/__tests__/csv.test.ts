import { describe, it, expect } from "vitest";
import { csvField, csvRow } from "@/lib/csv";

describe("csvField", () => {
  it("passes a plain value through unquoted", () => {
    expect(csvField("hello")).toBe("hello");
  });

  it("quotes a value containing a comma", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("quotes a value containing a double quote and doubles it", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a value containing a newline", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("prefixes an apostrophe for a leading =", () => {
    expect(csvField("=cmd")).toBe("'=cmd");
  });

  it("prefixes an apostrophe for a leading +", () => {
    expect(csvField("+1")).toBe("'+1");
  });

  it("prefixes an apostrophe for a leading -", () => {
    expect(csvField("-1")).toBe("'-1");
  });

  it("prefixes an apostrophe for a leading @", () => {
    expect(csvField("@x")).toBe("'@x");
  });

  it("converts null to an empty string", () => {
    expect(csvField(null)).toBe("");
  });

  it("converts undefined to an empty string", () => {
    expect(csvField(undefined)).toBe("");
  });
});

describe("csvRow", () => {
  it("joins fields with commas", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("quotes fields that need it within a row", () => {
    expect(csvRow(["a,b", "c"])).toBe('"a,b",c');
  });
});
