import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deleteModel } from "@/lib/ollama";
import { capabilityRefusal } from "@/lib/engines";
import { logger } from "@/lib/logger";
import { requireAdminAuth } from "@/lib/require-auth";

export async function DELETE(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
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
  const refusal = capabilityRefusal(server.engine, "deleteModel", "deleting models");
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  try {
    await deleteModel(server.url, name);
    logger.info("Model deleted", { model: name, server: server.name });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete model";
    logger.error("Failed to delete model", { model: name, error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
