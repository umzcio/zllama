import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

const SUPPORTED_LOCALES = ["en", "es", "ca", "fr", "ja", "zh", "hi"];

export async function POST(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { locale } = await req.json();

  if (!locale || !SUPPORTED_LOCALES.includes(locale)) {
    return NextResponse.json(
      { error: `Supported locales: ${SUPPORTED_LOCALES.join(", ")}` },
      { status: 400 }
    );
  }

  const res = NextResponse.json({ locale });
  res.cookies.set("locale", locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  return res;
}
