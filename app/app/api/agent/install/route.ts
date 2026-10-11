export const dynamic = "force-dynamic";
import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { resolveAgentDir } from "@/lib/agent-source";

// The generated install.sh defaults to an empty --server value that the
// operator must supply. This route pre-fills that default with this
// server's own URL so the operator only has to pass --token. The token
// itself is never templated here — this endpoint is public, and baking a
// token into it would hand fleet enrollment to anyone who can reach it.
const SERVER_DEFAULT = 'SERVER=""';

export async function GET() {
  const agentDir = resolveAgentDir();
  if (!agentDir) {
    return new NextResponse("install.sh not found", { status: 500 });
  }

  let script: string;
  try {
    script = await readFile(path.join(agentDir, "install.sh"), "utf-8");
  } catch {
    return new NextResponse("install.sh not found", { status: 500 });
  }

  const serverUrl = (process.env.NEXTAUTH_URL || "").replace(/\/+$/, "");
  const templated = script.replace(SERVER_DEFAULT, `SERVER="${serverUrl}"`);

  return new NextResponse(templated, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="install.sh"',
    },
  });
}
