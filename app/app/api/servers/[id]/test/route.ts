import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdapter } from "@/lib/engines";
import type { EngineKind } from "@/lib/engines";
import { requireAdminAuth } from "@/lib/require-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      status: "online",
      version,
      url: server.url,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({
      status: "offline",
      error: message,
      url: server.url,
    });
  }
}
