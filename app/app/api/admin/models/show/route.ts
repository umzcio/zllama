import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { showModel } from "@/lib/ollama";
import { capabilityRefusal } from "@/lib/engines";
import { requireAuth } from "@/lib/require-auth";

export async function POST(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  const refusal = capabilityRefusal(server.engine, "showModel", "showing model details");
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  try {
    const data = await showModel(server.url, name);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to show model";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
