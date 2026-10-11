export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { createAgentTarball } from "@/lib/agent-package";
import { resolveAgentDir } from "@/lib/agent-source";

// Public and read-only, like /api/agent/install: it serves the agent source
// tree so install.sh can fetch it from the server it will report to. No
// token is templated in — the operator passes --token on the command line.
export async function GET() {
  const agentDir = resolveAgentDir();
  if (!agentDir) {
    return new NextResponse("agent source not found", { status: 500 });
  }

  const tarball = await createAgentTarball(agentDir);

  return new NextResponse(new Uint8Array(tarball), {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="zllama-agent.tar.gz"',
      "Content-Length": String(tarball.length),
    },
  });
}
