import { prisma } from "@/lib/prisma";
import { LOG_RETENTION_DAYS } from "@/lib/constants";

export interface SystemSettings {
  allowRegistration: boolean;
  logRetentionDays: number;
  rateLimitMax: number;
  rateLimitWindow: number;
}

const CACHE_TTL_MS = 30_000;

let cache: { value: SystemSettings; at: number } | null = null;

export function invalidateSystemSettings(): void {
  cache = null;
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getSystemSettings(): Promise<SystemSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const rows = await prisma.settings.findMany();
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;

  const value: SystemSettings = {
    allowRegistration: map.allowRegistration === "true",
    logRetentionDays: positiveIntOr(map.logRetentionDays, LOG_RETENTION_DAYS),
    rateLimitMax: positiveIntOr(map.rateLimitMax, 60),
    rateLimitWindow: positiveIntOr(map.rateLimitWindow, 60),
  };

  cache = { value, at: Date.now() };
  return value;
}
