export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";
import { parseDeclaration } from "@/lib/desired-state";

export async function GET(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const roles = await prisma.role.findMany({
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(roles);
}

export async function POST(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, description, desiredState } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const raw = typeof desiredState === "string" ? desiredState : "{}";
  try {
    parseDeclaration(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid declaration";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const existing = await prisma.role.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: "Role name already exists" }, { status: 409 });
  }

  const role = await prisma.role.create({
    data: {
      name: name.trim(),
      description: description?.trim() || null,
      desiredState: raw,
    },
  });

  return NextResponse.json(role, { status: 201 });
}
