export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";
import { parseDateParam } from "@/lib/query-params";
import { csvRow } from "@/lib/csv";
import { MAX_EXPORT_ROWS } from "@/lib/constants";

export async function GET(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const format = req.nextUrl.searchParams.get("format") || "json";
  const serverId = req.nextUrl.searchParams.get("serverId");

  const from = parseDateParam(req.nextUrl.searchParams.get("from"));
  if (from === null) {
    return NextResponse.json(
      { error: "Invalid from parameter" },
      { status: 400 }
    );
  }

  const to = parseDateParam(req.nextUrl.searchParams.get("to"));
  if (to === null) {
    return NextResponse.json(
      { error: "Invalid to parameter" },
      { status: 400 }
    );
  }

  const where: Record<string, unknown> = {};
  if (serverId) where.endpointId = serverId;
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  const logs = await prisma.log.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: MAX_EXPORT_ROWS,
    include: { endpointRef: { select: { name: true } } },
  });

  const truncated = logs.length === MAX_EXPORT_ROWS;

  if (format === "csv") {
    const header = csvRow([
      "timestamp",
      "server",
      "model",
      "endpoint",
      "prompt_tokens",
      "completion_tokens",
      "latency_ms",
      "status_code",
      "user_id",
      "ip",
    ]);
    const rows = logs.map((l) =>
      csvRow([
        l.createdAt.toISOString(),
        l.endpointRef.name,
        l.model,
        l.endpoint,
        l.promptTokens || 0,
        l.completionTokens || 0,
        l.latencyMs,
        l.statusCode,
        l.userId || "",
        l.ip || "",
      ])
    );
    const csv = [header, ...rows].join("\r\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=zllama-logs.csv",
        ...(truncated ? { "X-Export-Truncated": "true" } : {}),
      },
    });
  }

  // Preserve the pre-rename API contract: clients expect `server: { name }`,
  // not the Prisma relation name `endpointRef`.
  const logsOut = logs.map(({ endpointRef, ...rest }) => ({
    ...rest,
    server: endpointRef,
  }));

  return NextResponse.json(logsOut, {
    headers: {
      "Content-Disposition": "attachment; filename=zllama-logs.json",
      ...(truncated ? { "X-Export-Truncated": "true" } : {}),
    },
  });
}
