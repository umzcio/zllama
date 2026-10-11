export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { lookupGpuSpecs } from "@/lib/gpu-specs";
import { scoreModel, type ModelScore } from "@/lib/model-scoring";
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

export type GpuInfo = FleetGpuInfo;

export interface ModelCompatibility extends ModelScore {
  name: string;
  sizeGB: number;
}

interface ServerGpuData {
  serverId: string;
  serverName: string;
  runningModels: RunningModel[];
  gpuInfo: GpuInfo[] | null;
  gpuReason: GpuUnavailableReason | null;
  gpuStaleSince: string | null;
  modelCompatibility: ModelCompatibility[] | null;
  error?: string;
}

function buildCompatibility(
  models: Array<{ name: string; sizeBytes: number }>,
  gpuInfo: GpuInfo[]
): ModelCompatibility[] {
  // Scoring needs a known VRAM total; a GPU whose total is unknown (null) is
  // not scoreable and must not be treated as a zero-VRAM card.
  const gpu = gpuInfo.find((g) => g.memoryTotal !== null && g.memoryTotal > 0);
  if (!gpu || gpu.memoryTotal === null) return [];

  const vramGB = gpu.memoryTotal / 1024 ** 3;
  const specs = lookupGpuSpecs(gpu.name, vramGB);

  return models
    .map(({ name, sizeBytes }) => {
      const sizeGB = sizeBytes / 1024 ** 3;
      const score = scoreModel(sizeGB, vramGB, specs?.bw);
      return { name, sizeGB, ...score };
    })
    .sort((a, b) => {
      const gradeOrder = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };
      const gDiff = gradeOrder[a.grade] - gradeOrder[b.grade];
      return gDiff !== 0 ? gDiff : b.tps - a.tps;
    });
}

export async function GET(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const servers = await prisma.endpoint.findMany({
    where: { active: true },
    include: { hosts: fleetGpuHostSelect },
  });

  const now = new Date();

  const results: ServerGpuData[] = await Promise.all(
    servers.map(async (server) => {
      // GPU facts come from the fleet agents' stored check-ins — no live probe.
      const fleet = collectFleetGpus((server.hosts ?? []) as FleetHost[], now);

      const result: ServerGpuData = {
        serverId: server.id,
        serverName: server.name,
        runningModels: [],
        gpuInfo: fleet.gpuInfo,
        gpuReason: fleet.gpuReason,
        gpuStaleSince: fleet.gpuStaleSince,
        modelCompatibility: null,
      };

      let adapter;
      try {
        adapter = getAdapter(server.engine as EngineKind);
      } catch (err) {
        result.error = err instanceof Error ? err.message : "Unknown engine";
        logger.warn("Unrecognized engine", { server: server.name, engine: server.engine });
      }

      if (adapter?.capabilities.runningModels) {
        try {
          const psRes = await fetch(`${server.url}/api/ps`, {
            signal: AbortSignal.timeout(5000),
          });
          if (psRes.ok) {
            const data = await psRes.json();
            result.runningModels = data.models || [];
          }
        } catch {
          result.error = "Could not connect to Ollama server";
          logger.warn("Cannot reach Ollama", { server: server.name, url: server.url });
        }
      }

      // Fetch available models and compute compatibility scores
      if (result.gpuInfo && !result.error) {
        try {
          const tagsRes = await fetch(`${server.url}/api/tags`, {
            signal: AbortSignal.timeout(5000),
          });
          if (tagsRes.ok) {
            const tagsData = await tagsRes.json();
            const models: Array<{ name: string; size: number }> =
              tagsData.models || [];
            result.modelCompatibility = buildCompatibility(
              models.map((m) => ({ name: m.name, sizeBytes: m.size })),
              result.gpuInfo
            );
          }
        } catch {
          // model compatibility unavailable, not critical
        }
      }

      return result;
    })
  );

  return NextResponse.json(results);
}
