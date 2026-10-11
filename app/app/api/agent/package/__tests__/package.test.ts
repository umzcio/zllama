import { execFile } from "child_process";
import { mkdtemp, rm, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const execFileAsync = promisify(execFile);

describe("GET /api/agent/package", () => {
  it("serves a gzipped tarball", async () => {
    const { GET } = await import("@/app/api/agent/package/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    // gzip magic number.
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
  });

  it("produces an archive that GNU tar can unpack, containing the installable agent tree", async () => {
    const { GET } = await import("@/app/api/agent/package/route");
    const res = await GET();
    const body = Buffer.from(await res.arrayBuffer());

    const dir = await mkdtemp(path.join(tmpdir(), "zllama-agent-pkg-"));
    try {
      const tarball = path.join(dir, "agent.tar.gz");
      await writeFile(tarball, body);
      await execFileAsync("tar", ["-xzf", tarball, "-C", dir]);

      for (const relative of [
        "agent/install.sh",
        "agent/pyproject.toml",
        "agent/systemd/zllama-agent.service",
        "agent/zllama_agent/main.py",
        "agent/zllama_agent/checkin.py",
      ]) {
        const extracted = await stat(path.join(dir, relative));
        expect(extracted.isFile()).toBe(true);
      }

      const installer = await stat(path.join(dir, "agent/install.sh"));
      expect(installer.mode & 0o111).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never includes a token in the served package", async () => {
    const { GET } = await import("@/app/api/agent/package/route");
    const res = await GET();
    const body = Buffer.from(await res.arrayBuffer());

    const dir = await mkdtemp(path.join(tmpdir(), "zllama-agent-pkg-"));
    try {
      const tarball = path.join(dir, "agent.tar.gz");
      await writeFile(tarball, body);
      await execFileAsync("tar", ["-xzf", tarball, "-C", dir]);
      const { stdout } = await execFileAsync("cat", [
        path.join(dir, "agent/install.sh"),
      ]);
      expect(stdout).toContain('TOKEN=""');
      expect(stdout).not.toMatch(/TOKEN="[^$"][^"]*"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes Python bytecode caches", async () => {
    const { GET } = await import("@/app/api/agent/package/route");
    const res = await GET();
    const body = Buffer.from(await res.arrayBuffer());

    const dir = await mkdtemp(path.join(tmpdir(), "zllama-agent-pkg-"));
    try {
      const tarball = path.join(dir, "agent.tar.gz");
      await writeFile(tarball, body);
      const { stdout } = await execFileAsync("tar", ["-tzf", tarball]);
      expect(stdout).not.toContain("__pycache__");
      expect(stdout).not.toContain(".pyc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("agent packaging (both public endpoints)", () => {
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

  // Both routes read the agent/ tree off disk, so a packaging regression that
  // leaves agent/ out of the deployed image turns them into 500s. Catch that
  // here rather than during an enrollment.
  it("serves a non-empty body from /api/agent/install and /api/agent/package", async () => {
    const install = await import("@/app/api/agent/install/route");
    const pkg = await import("@/app/api/agent/package/route");

    const installRes = await install.GET();
    expect(installRes.status).toBe(200);
    expect((await installRes.text()).length).toBeGreaterThan(0);

    const packageRes = await pkg.GET();
    expect(packageRes.status).toBe(200);
    expect((await packageRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
