export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listModels } from "@/lib/ollama";
import { getAdapter } from "@/lib/engines";
import type { EngineKind } from "@/lib/engines";
import { requireAuth } from "@/lib/require-auth";

interface EngineModelListItem {
  name: string;
  model: string;
  modified_at: string | null;
  size: number | null;
  digest: string | null;
  contextLength: number | null;
  servedPath: string | null;
  details: null;
}

interface HostModelInventoryItem {
  hostNodeName: string;
  name: string;
  sizeBytes: number | null;
}

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

  const server = await prisma.endpoint.findUnique({
    where: { id: serverId },
    include: {
      hosts: {
        include: {
          models: { where: { runtimeKind: "vllm" } },
        },
      },
    },
  });
  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  if (!server.active) {
    return NextResponse.json({ error: "Server is inactive" }, { status: 403 });
  }

  try {
    // Ollama's /api/tags returns rich per-model detail (size, digest,
    // modified_at, family/parameter_size/quantization_level) that the admin
    // models page renders directly. Only that engine can supply this shape,
    // so it keeps calling lib/ollama directly rather than going through the
    // adapter, which normalizes down to the leaner cross-engine ModelSummary.
    if (server.engine === "ollama") {
      const data = await listModels(server.url);
      return NextResponse.json(data);
    }

    const adapter = getAdapter(server.engine as EngineKind);
    const summaries = await adapter.listModels(server.url);
    const models: EngineModelListItem[] = summaries.map((m) => ({
      name: m.name,
      model: m.name,
      modified_at: null,
      size: m.sizeBytes ?? null,
      digest: m.digest ?? null,
      contextLength: m.contextLength ?? null,
      servedPath: m.servedPath ?? null,
      details: null,
    }));

    // Host-reported on-disk inventory, surfaced only for vLLM: it installs
    // nothing into itself, so what a linked host's agent found
    // sitting in its scan paths is the only ground truth for "what's really
    // on disk" — distinct from, and never joined by name against, the
    // served models above (in practice models are often served under a name
    // that doesn't match their on-disk directory at all).
    if (server.engine === "vllm") {
      const hostModels: HostModelInventoryItem[] = server.hosts.flatMap((host) =>
        host.models.map((m) => ({
          hostNodeName: host.nodeName,
          name: m.name,
          sizeBytes: m.sizeBytes ?? null,
        }))
      );
      return NextResponse.json({ models, hostModels });
    }

    return NextResponse.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list models";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
