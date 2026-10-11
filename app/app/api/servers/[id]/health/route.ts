export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdapter } from "@/lib/engines";
import type { EngineKind } from "@/lib/engines";
import { requireAuth } from "@/lib/require-auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const server = await prisma.endpoint.findUnique({
    where: { id: id },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  try {
    const adapter = getAdapter(server.engine as EngineKind);
    const version = await adapter.getVersion(server.url);
    return NextResponse.json({
      id: server.id,
      status: "online",
      version,
    });
  } catch {
    return NextResponse.json({
      id: server.id,
      status: "offline",
    });
  }
}
