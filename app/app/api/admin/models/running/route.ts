export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listRunningModels } from "@/lib/ollama";
import { capabilityRefusal } from "@/lib/engines";
import { requireAuth } from "@/lib/require-auth";

export async function GET(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serverId = req.nextUrl.searchParams.get("serverId");

  if (!serverId) {
    return NextResponse.json(
      { error: "serverId is required" },
      { status: 400 }
    );
  }

  const server = await prisma.endpoint.findUnique({ where: { id: serverId } });
  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  if (!server.active) {
    return NextResponse.json({ error: "Server is inactive" }, { status: 403 });
  }

  // This route talks Ollama's /api/ps, which has no vLLM equivalent — the
  // capability matrix declares runningModels: false for vLLM, so refuse
  // clearly instead of 404ing upstream.
  const refusal = capabilityRefusal(server.engine, "runningModels", "listing running models");
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  try {
    const data = await listRunningModels(server.url);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list running models";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
