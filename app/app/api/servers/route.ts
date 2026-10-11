export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAdminAuth } from "@/lib/require-auth";

export async function GET(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const all = req.nextUrl.searchParams.get("all") === "true";
  const servers = await prisma.endpoint.findMany({
    ...(!all && { where: { active: true } }),
    orderBy: { createdAt: "asc" },
    include: { hosts: { select: { id: true, nodeName: true, status: true } } },
  });
  return NextResponse.json(servers);
}

export async function POST(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  // The legacy GPU-agent URL field is deprecated: GPU stats now come from
  // fleet-agent check-ins. Old clients may still send it — it is ignored
  // rather than rejected.
  const { name, url, active } = body;

  if (!name || !url) {
    return NextResponse.json(
      { error: "Name and URL are required" },
      { status: 400 }
    );
  }

  const server = await prisma.endpoint.create({
    data: {
      name: name.trim(),
      url: url.trim().replace(/\/$/, ""),
      active: active ?? true,
    },
  });

  logger.info("Server added", { name, url });
  return NextResponse.json(server, { status: 201 });
}
