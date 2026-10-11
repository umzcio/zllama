import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getSystemSettings } from "@/lib/system-settings";
import { LOG_RETENTION_DAYS } from "@/lib/constants";

const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let lastPurgeAt = 0;

export function shouldPurge(now: number, last: number): boolean {
  return now - last >= PURGE_INTERVAL_MS;
}

export function resetPurgeState(): void {
  lastPurgeAt = 0;
}

export async function maybePurgeOldLogs(): Promise<void> {
  const now = Date.now();
  if (!shouldPurge(now, lastPurgeAt)) return;
  lastPurgeAt = now;

  let days = LOG_RETENTION_DAYS;
  try {
    const settings = await getSystemSettings();
    days = settings.logRetentionDays;
  } catch {
    // Fall back to the env-derived constant.
  }

  try {
    const cutoff = new Date(now - days * MS_PER_DAY);
    const result = await prisma.log.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      logger.info("Purged old logs", { deleted: result.count, olderThanDays: days });
    }
  } catch (err) {
    logger.error("Log purge failed", { error: String(err) });
  }
}
