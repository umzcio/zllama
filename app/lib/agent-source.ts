import { existsSync } from "fs";
import path from "path";

// In the repo, agent/ is a sibling of app/. In the container image it is
// copied to /app/agent, next to the server bundle. Both layouts must work:
// the install and package endpoints are the only way the agent source
// reaches a target host.
export function resolveAgentDir(): string | null {
  const candidates = [
    path.join(process.cwd(), "agent"),
    path.join(process.cwd(), "..", "agent"),
  ];
  return (
    candidates.find((dir) => existsSync(path.join(dir, "install.sh"))) ?? null
  );
}
