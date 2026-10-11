export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

// Convergence runs can report a failing installer's output; that alone is
// reason enough to keep this fleet-wide (no-hostId) view admin-only and
// bounded, rather than an unbounded historical log.
const RECENT_RUNS_LIMIT = 100;

interface ConvergenceRunResponse {
  id: string;
  hostId: string;
  nodeName: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  currentAction: string | null;
  progressPct: number | null;
  actions: unknown[];
  error: string | null;
}

// `actions` is stored as JSON text (SQLite has no native JSON type). A row
// written by a future, differently-shaped agent report must not 500 this
// endpoint for every other host's history — fall back to an empty array
// rather than throwing.
function parseActions(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const hostId = req.nextUrl.searchParams.get("hostId") ?? undefined;

  const runs = await prisma.convergenceRun.findMany({
    where: hostId ? { hostId } : undefined,
    include: { host: { select: { nodeName: true } } },
    orderBy: { startedAt: "desc" },
    take: RECENT_RUNS_LIMIT,
  });

  const response: ConvergenceRunResponse[] = runs.map((run) => ({
    id: run.id,
    hostId: run.hostId,
    nodeName: run.host.nodeName,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    currentAction: run.currentAction,
    progressPct: run.progressPct,
    actions: parseActions(run.actions),
    error: run.error,
  }));

  return NextResponse.json(response);
}
