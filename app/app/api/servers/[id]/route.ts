export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

export async function GET(
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
    include: { hosts: { select: { id: true, nodeName: true, status: true } } },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  return NextResponse.json(server);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  // The legacy GPU-agent URL field is deprecated: GPU stats now come from
  // fleet-agent check-ins. Old clients may still send it — it is ignored
  // rather than rejected.
  const { name, url, active, hostIds } = body;

  const data: {
    name?: string;
    url?: string;
    active?: boolean;
    hosts?: { set: { id: string }[] };
  } = {
    ...(name !== undefined && { name: name.trim() }),
    ...(url !== undefined && { url: url.trim().replace(/\/$/, "") }),
    ...(active !== undefined && { active }),
  };

  if (hostIds !== undefined) {
    if (!Array.isArray(hostIds) || !hostIds.every((hostId) => typeof hostId === "string")) {
      return NextResponse.json(
        { error: "hostIds must be an array of strings" },
        { status: 400 }
      );
    }

    if (hostIds.length > 0) {
      const matched = await prisma.host.findMany({
        where: { id: { in: hostIds } },
        select: { id: true },
      });
      if (matched.length !== hostIds.length) {
        const matchedIds = new Set(matched.map((h) => h.id));
        const unknownId = hostIds.find((hostId) => !matchedIds.has(hostId));
        return NextResponse.json(
          { error: `Unknown host id: ${unknownId}` },
          { status: 400 }
        );
      }
    }

    data.hosts = { set: hostIds.map((hostId: string) => ({ id: hostId })) };
  }

  try {
    const server = await prisma.endpoint.update({
      where: { id: id },
      data,
      include: { hosts: { select: { id: true, nodeName: true, status: true } } },
    });
    return NextResponse.json(server);
  } catch {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  try {
    await prisma.endpoint.delete({ where: { id: id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
}
