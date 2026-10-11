import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { pullManager } from "@/lib/pull-manager";
import { capabilityRefusal } from "@/lib/engines";
import { logger } from "@/lib/logger";
import { requireAdmin } from "@/lib/require-admin";

export async function POST(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { serverId, name } = await req.json();

  if (!serverId || !name) {
    return NextResponse.json(
      { error: "serverId and name are required" },
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

  // The endpoint's engine decides whether this call is even meaningful. This
  // route talks Ollama's model API; firing it at a vLLM endpoint produces a
  // confusing upstream 404 instead of a clear refusal.
  const refusal = capabilityRefusal(server.engine, "pullModel", "pulling models");
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  logger.info("Pull requested", { model: name, server: server.name });

  // Delegate to PullManager (used by Discover page)
  const job = pullManager.startPull(serverId, server.url, name);
  return NextResponse.json(
    { id: job.id, model: job.model, tag: job.tag, status: job.status },
    { status: 202 }
  );
}
