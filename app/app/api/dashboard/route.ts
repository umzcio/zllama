export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth } from "@/lib/require-auth";
import { getAdapter } from "@/lib/engines";
import type { EngineKind } from "@/lib/engines";
import {
  collectFleetGpus,
  fleetGpuHostSelect,
  type FleetGpuInfo,
  type FleetHost,
  type GpuUnavailableReason,
} from "@/lib/fleet-gpu";

interface RunningModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at: string;
}

type GpuInfo = FleetGpuInfo;

interface ServerStatus {
  id: string;
  name: string;
  url: string;
  status: "online" | "offline";
  version?: string;
  runningModels: RunningModel[];
  gpu: GpuInfo[] | null;
  gpuReason: GpuUnavailableReason | null;
  gpuStaleSince: string | null;
}

export async function GET(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const start24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [logsToday, logsYesterday, logs24h, servers] = await Promise.all([
    prisma.log.findMany({
      where: { createdAt: { gte: startOfToday } },
      select: {
        latencyMs: true,
        statusCode: true,
        promptTokens: true,
        completionTokens: true,
        model: true,
        createdAt: true,
      },
    }),
    prisma.log.count({
      where: { createdAt: { gte: startOfYesterday, lt: startOfToday } },
    }),
    prisma.log.findMany({
      where: { createdAt: { gte: start24hAgo } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.endpoint.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      include: { hosts: fleetGpuHostSelect },
    }),
  ]);

  // KPIs from today's logs
  const errorCount = logsToday.filter((l) => l.statusCode >= 400).length;
  const tokensToday = logsToday.reduce(
    (sum, l) => sum + (l.promptTokens ?? 0) + (l.completionTokens ?? 0),
    0
  );

  const latencies = logsToday.map((l) => l.latencyMs).sort((a, b) => a - b);
  const avgLatencyMs =
    latencies.length > 0 ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
  const p95LatencyMs =
    latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] ?? 0 : 0;

  // Top 5 models today
  const modelCounts: Record<string, number> = {};
  for (const log of logsToday) {
    modelCounts[log.model] = (modelCounts[log.model] ?? 0) + 1;
  }
  const topModels = Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([model, count]) => ({ model, count }));

  // Requests per hour — last 24 buckets
  const hourBuckets: Record<string, number> = {};
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}`;
    hourBuckets[key] = 0;
  }
  for (const log of logs24h) {
    const d = log.createdAt;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}`;
    if (key in hourBuckets) hourBuckets[key]++;
  }
  const requestsPerHour = Object.entries(hourBuckets).map(([hour, count]) => ({ hour, count }));

  // Server health + running models + GPU
  const serverStatuses: ServerStatus[] = await Promise.all(
    servers.map(async (endpoint) => {
      // GPU facts come from the fleet agents' stored check-ins — no live probe.
      const fleet = collectFleetGpus((endpoint.hosts ?? []) as FleetHost[], now);

      const result: ServerStatus = {
        id: endpoint.id,
        name: endpoint.name,
        url: endpoint.url,
        status: "offline",
        runningModels: [],
        gpu: fleet.gpuInfo,
        gpuReason: fleet.gpuReason,
        gpuStaleSince: fleet.gpuStaleSince,
      };

      try {
        const adapter = getAdapter(endpoint.engine as EngineKind);
        result.version = await adapter.getVersion(endpoint.url);
        result.status = "online";
      } catch {
        logger.warn("Endpoint version check failed", { endpoint: endpoint.name });
      }

      if (result.status === "online") {
        const adapter = getAdapter(endpoint.engine as EngineKind);
        if (adapter.capabilities.runningModels) {
          try {
            const psRes = await fetch(`${endpoint.url}/api/ps`, {
              signal: AbortSignal.timeout(4000),
            });
            if (psRes.ok) {
              const data = await psRes.json();
              result.runningModels = data.models ?? [];
            }
          } catch {
            // not critical
          }
        }
      }

      return result;
    })
  );

  const serversOnline = serverStatuses.filter((s) => s.status === "online").length;

  return NextResponse.json({
    kpis: {
      serversOnline,
      serversTotal: servers.length,
      requestsToday: logsToday.length,
      requestsYesterday: logsYesterday,
      tokensToday,
      avgLatencyMs,
      p95LatencyMs,
      errorCount,
      errorRate:
        logsToday.length > 0 ? ((errorCount / logsToday.length) * 100).toFixed(1) : "0.0",
    },
    requestsPerHour,
    topModels,
    servers: serverStatuses,
  });
}
