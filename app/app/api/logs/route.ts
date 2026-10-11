export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireAdminAuth } from "@/lib/require-auth";
import { parseIntParam, parseDateParam } from "@/lib/query-params";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/constants";

export async function GET(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serverId = req.nextUrl.searchParams.get("serverId");
  const model = req.nextUrl.searchParams.get("model");
  const status = req.nextUrl.searchParams.get("status");

  const page = parseIntParam(
    req.nextUrl.searchParams.get("page"),
    1,
    1,
    1_000_000
  );
  if (page === null) {
    return NextResponse.json(
      { error: "Invalid page parameter" },
      { status: 400 }
    );
  }

  const limit = parseIntParam(
    req.nextUrl.searchParams.get("limit"),
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );
  if (limit === null) {
    return NextResponse.json(
      { error: "Invalid limit parameter" },
      { status: 400 }
    );
  }

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
  if (model) where.model = { contains: model };
  if (status === "success") where.statusCode = { lt: 400 };
  if (status === "error") where.statusCode = { gte: 400 };
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.log.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { endpointRef: { select: { name: true } } },
    }),
    prisma.log.count({ where }),
  ]);

  // Preserve the pre-rename API contract: clients expect `server: { name }`,
  // not the Prisma relation name `endpointRef`.
  const logs = rows.map(({ endpointRef, ...rest }) => ({
    ...rest,
    server: endpointRef,
  }));

  return NextResponse.json({ logs, total, page, limit });
}

export async function DELETE(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const beforeRaw = req.nextUrl.searchParams.get("before");
  if (!beforeRaw) {
    return NextResponse.json(
      { error: "before parameter is required" },
      { status: 400 }
    );
  }

  const before = parseDateParam(beforeRaw);
  if (before === null) {
    return NextResponse.json(
      { error: "Invalid before parameter" },
      { status: 400 }
    );
  }

  const result = await prisma.log.deleteMany({
    where: { createdAt: { lt: before } },
  });

  return NextResponse.json({ deleted: result.count });
}
