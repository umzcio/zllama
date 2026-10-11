export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { lookupGpuSpecs } from "@/lib/gpu-specs";
import { requireAuth } from "@/lib/require-auth";
import { collectFleetGpus, fleetGpuHostSelect, type FleetHost } from "@/lib/fleet-gpu";

export async function GET(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const serverId = searchParams.get("serverId");

  const server = serverId
    ? await prisma.endpoint.findUnique({
        where: { id: serverId },
        include: { hosts: fleetGpuHostSelect },
      })
    : await prisma.endpoint.findFirst({
        where: { active: true },
        include: { hosts: fleetGpuHostSelect },
      });

  if (!server) return NextResponse.json(null);

  // GPU facts come from the fleet agents' stored check-ins — no live probe.
  const { gpuInfo } = collectFleetGpus((server.hosts ?? []) as FleetHost[]);

  // Bandwidth lookup needs a known VRAM total; an unknown total is not zero.
  const gpu = gpuInfo?.find((g) => g.memoryTotal !== null && g.memoryTotal > 0);
  if (!gpu || gpu.memoryTotal === null) return NextResponse.json(null);

  const vramGB = gpu.memoryTotal / 1024 ** 3;
  const specs = lookupGpuSpecs(gpu.name, vramGB);

  return NextResponse.json({
    gpuName: gpu.name,
    vramGB,
    bandwidthGBs: specs?.bw ?? null,
  });
}
