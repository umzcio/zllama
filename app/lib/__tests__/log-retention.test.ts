import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    log: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/system-settings", () => ({
  getSystemSettings: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getSystemSettings } from "@/lib/system-settings";
import { maybePurgeOldLogs, shouldPurge, resetPurgeState } from "@/lib/log-retention";

beforeEach(() => {
  vi.clearAllMocks();
  resetPurgeState();
  (getSystemSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
    allowRegistration: false,
    logRetentionDays: 30,
    rateLimitMax: 60,
    rateLimitWindow: 60,
  });
  (prisma.log.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shouldPurge", () => {
  it("is false before an hour has elapsed", () => {
    expect(shouldPurge(1_000, 0)).toBe(false);
    expect(shouldPurge(60 * 60 * 1000 - 1, 0)).toBe(false);
  });

  it("is true once an hour has elapsed", () => {
    expect(shouldPurge(60 * 60 * 1000, 0)).toBe(true);
  });
});

describe("maybePurgeOldLogs", () => {
  it("purges on first call and deletes logs older than the retention window", async () => {
    const now = new Date("2026-07-06T12:00:00Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await maybePurgeOldLogs();

    expect(prisma.log.deleteMany).toHaveBeenCalledTimes(1);
    const arg = (prisma.log.deleteMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const cutoff = arg.where.createdAt.lt as Date;
    expect(cutoff.getTime()).toBe(now - 30 * 24 * 60 * 60 * 1000);
  });

  it("does not purge again within the same hour", async () => {
    const now = new Date("2026-07-06T12:00:00Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await maybePurgeOldLogs();
    vi.setSystemTime(now + 30 * 60 * 1000);
    await maybePurgeOldLogs();

    expect(prisma.log.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("purges again after an hour has passed", async () => {
    const now = new Date("2026-07-06T12:00:00Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await maybePurgeOldLogs();
    vi.setSystemTime(now + 60 * 60 * 1000);
    await maybePurgeOldLogs();

    expect(prisma.log.deleteMany).toHaveBeenCalledTimes(2);
  });
});
