import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateApiKey } from "@/lib/validate-api-key";

export type Principal =
  | { kind: "user"; userId: string; role: string }
  | { kind: "apiKey"; keyId: string };

export async function requireAuth(req: NextRequest): Promise<Principal | null> {
  if (process.env.AUTH_DISABLED === "true") {
    return { kind: "user", userId: "dev", role: "admin" };
  }

  const authHeader = req.headers.get("authorization");
  const hasApiKey =
    !!authHeader &&
    (authHeader.startsWith("Bearer zl-") || authHeader.startsWith("Bearer oa-"));

  if (hasApiKey) {
    const result = await validateApiKey(req);
    if (!result.valid || !result.keyId) {
      return null;
    }
    return { kind: "apiKey", keyId: result.keyId };
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return null;
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { active: true, role: true },
  });
  if (!dbUser || !dbUser.active) {
    return null;
  }

  return { kind: "user", userId: session.user.id, role: dbUser.role };
}

export async function requireAdminAuth(req: NextRequest): Promise<Principal | null> {
  const principal = await requireAuth(req);
  if (!principal || principal.kind !== "user" || principal.role !== "admin") {
    return null;
  }
  return principal;
}
