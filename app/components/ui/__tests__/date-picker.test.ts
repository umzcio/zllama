import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  buildMonthMatrix,
  dateToISO,
  isDateInRange,
  isoToDate,
} from "../date-picker";

describe("isoToDate", () => {
  it("parses a valid yyyy-mm-dd string", () => {
    const date = isoToDate("2026-07-06");
    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(6);
    expect(date?.getDate()).toBe(6);
  });

  it("rejects malformed input", () => {
    expect(isoToDate("")).toBeNull();
    expect(isoToDate("2026-7-6")).toBeNull();
    expect(isoToDate("07/06/2026")).toBeNull();
  });

  it("rejects non-existent calendar dates", () => {
    expect(isoToDate("2026-02-31")).toBeNull();
    expect(isoToDate("2026-13-01")).toBeNull();
  });
});

describe("dateToISO", () => {
  it("serializes a local date with zero padding", () => {
    expect(dateToISO(new Date(2026, 0, 3))).toBe("2026-01-03");
  });

  it("round-trips with isoToDate", () => {
    const iso = "2024-11-30";
    expect(dateToISO(isoToDate(iso) as Date)).toBe(iso);
  });
});

describe("addDays / addMonths", () => {
  it("adds and subtracts days across month boundaries", () => {
    expect(dateToISO(addDays(new Date(2026, 0, 31), 1))).toBe("2026-02-01");
    expect(dateToISO(addDays(new Date(2026, 0, 1), -1))).toBe("2025-12-31");
  });

  it("clamps the day when the target month is shorter", () => {
    expect(dateToISO(addMonths(new Date(2026, 0, 31), 1))).toBe("2026-02-28");
  });

  it("subtracts months across a year boundary", () => {
    expect(dateToISO(addMonths(new Date(2026, 0, 15), -1))).toBe("2025-12-15");
  });
});

describe("buildMonthMatrix", () => {
  it("returns six Sunday-first weeks of seven days", () => {
    const matrix = buildMonthMatrix(new Date(2026, 6, 6));
    expect(matrix).toHaveLength(6);
    matrix.forEach((week) => expect(week).toHaveLength(7));
    matrix.forEach((week) => expect(week[0].getDay()).toBe(0));
  });

  it("starts on the Sunday on or before the first of the month", () => {
    const matrix = buildMonthMatrix(new Date(2026, 6, 1));
    expect(dateToISO(matrix[0][0])).toBe("2026-06-28");
  });
});

describe("isDateInRange", () => {
  const date = new Date(2026, 6, 6);

  it("is true with no bounds", () => {
    expect(isDateInRange(date)).toBe(true);
  });

  it("respects the min bound inclusively", () => {
    expect(isDateInRange(date, "2026-07-06")).toBe(true);
    expect(isDateInRange(date, "2026-07-07")).toBe(false);
  });

  it("respects the max bound inclusively", () => {
    expect(isDateInRange(date, undefined, "2026-07-06")).toBe(true);
    expect(isDateInRange(date, undefined, "2026-07-05")).toBe(false);
  });
});
