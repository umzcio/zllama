export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";
import { parseDeclaration } from "@/lib/desired-state";
import { computeDrift, type HostFacts, type HostDrift } from "@/lib/drift";
import type { Declaration } from "@/lib/desired-state";

const EMPTY_DECLARATION: Declaration = { runtimes: {} };

export async function GET(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const hosts = await prisma.host.findMany({
    include: { gpus: true, runtimes: true, models: true, role: true },
    orderBy: { createdAt: "asc" },
  });

  const now = new Date();
  const results: HostDrift[] = hosts.map((host) => {
    const facts: HostFacts = {
      nodeName: host.nodeName,
      roleId: host.roleId,
      converge: host.converge,
      approvalState: host.approvalState,
      lastCheckInAt: host.lastCheckInAt,
      runtimes: host.runtimes.map((r) => ({
        kind: r.kind,
        version: r.version,
        models: (host.models ?? [])
          .filter((m) => m.runtimeKind === r.kind)
          .map((m) => ({ name: m.name, sizeBytes: m.sizeBytes ?? null })),
      })),
      gpus: host.gpus.map((g) => ({ driverStatus: g.driverStatus })),
    };

    const declaration = host.role ? parseDeclaration(host.role.desiredState) : EMPTY_DECLARATION;
    return computeDrift({ host: facts, declaration, now });
  });

  return NextResponse.json(results);
}
