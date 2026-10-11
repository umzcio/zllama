import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("GET /api/agent/install", () => {
  const originalUrl = process.env.NEXTAUTH_URL;

  beforeEach(() => {
    process.env.NEXTAUTH_URL = "https://zllama.example";
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.NEXTAUTH_URL;
    } else {
      process.env.NEXTAUTH_URL = originalUrl;
    }
  });

  it("serves the installer as text/plain", async () => {
    const { GET } = await import("@/app/api/agent/install/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("templates the server URL from NEXTAUTH_URL", async () => {
    const { GET } = await import("@/app/api/agent/install/route");
    const res = await GET();
    const text = await res.text();

    expect(text).toContain('SERVER="https://zllama.example"');
  });

  it("never templates a token into the script", async () => {
    const { GET } = await import("@/app/api/agent/install/route");
    const res = await GET();
    const text = await res.text();

    expect(text).toContain('TOKEN=""');
    expect(text).not.toMatch(/TOKEN="[^$"][^"]*"/);
  });

  it("still requires --token and --server at runtime", async () => {
    const { GET } = await import("@/app/api/agent/install/route");
    const res = await GET();
    const text = await res.text();

    expect(text).toContain('-z "$TOKEN"');
  });

  it("sets strict shell mode", async () => {
    const { GET } = await import("@/app/api/agent/install/route");
    const res = await GET();
    const text = await res.text();

    expect(text).toContain("set -euo pipefail");
  });

  it("documents bash, not sh, for the piped one-liner", async () => {
    // `set -euo pipefail` above is bash-only: piping this script to a plain
    // POSIX shell (`| sudo sh -s --`) fails immediately on Ubuntu (dash)
    // with "set: Illegal option -o pipefail". The served script must tell
    // operators to use bash, and must not tell them to use `sh`.
    const { GET } = await import("@/app/api/agent/install/route");
    const res = await GET();
    const text = await res.text();

    expect(text).toContain("bash -s --");
    expect(text).not.toContain("sudo sh -s");
    expect(text).not.toMatch(/\|\s*sh\s/);
  });
});
