import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { gzip } from "zlib";

const gzipAsync = promisify(gzip);

const BLOCK_SIZE = 512;

const EXCLUDED_DIRS = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "venv",
]);

const EXCLUDED_EXTENSIONS = [".pyc", ".pyo"];

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.endsWith(".egg-info");
}

function isExcludedFile(name: string): boolean {
  return EXCLUDED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function octalField(value: number, size: number): Buffer {
  return Buffer.from(
    `${value.toString(8).padStart(size - 1, "0")}\0`,
    "ascii"
  );
}

// POSIX ustar header. Written by hand rather than pulled from a dependency:
// the agent tarball is a handful of small text files and the format is fixed.
function ustarHeader(entry: {
  name: string;
  mode: number;
  size: number;
  mtimeSeconds: number;
  typeflag: "0" | "5";
}): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(entry.name, 0, 100, "utf-8");
  octalField(entry.mode, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108);
  octalField(0, 8).copy(header, 116);
  octalField(entry.size, 12).copy(header, 124);
  octalField(entry.mtimeSeconds, 12).copy(header, 136);
  // The checksum is computed with its own field filled with spaces.
  header.fill(0x20, 148, 156);
  header.write(entry.typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "utf-8");
  header.write("root", 297, 32, "utf-8");

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function padToBlock(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

async function collect(
  absoluteDir: string,
  archivePrefix: string,
  blocks: Buffer[]
): Promise<void> {
  const dirStat = await stat(absoluteDir);
  blocks.push(
    ustarHeader({
      name: `${archivePrefix}/`,
      mode: 0o755,
      size: 0,
      mtimeSeconds: Math.floor(dirStat.mtimeMs / 1000),
      typeflag: "5",
    })
  );

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  // Sorted so the same source tree always yields the same archive.
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const archivePath = `${archivePrefix}/${entry.name}`;

    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) {
        continue;
      }
      await collect(absolutePath, archivePath, blocks);
      continue;
    }

    if (!entry.isFile() || isExcludedFile(entry.name)) {
      continue;
    }

    const [content, fileStat] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath),
    ]);
    blocks.push(
      ustarHeader({
        name: archivePath,
        // Preserve only the executable bit; everything else is a plain file.
        mode: fileStat.mode & 0o111 ? 0o755 : 0o644,
        size: content.length,
        mtimeSeconds: Math.floor(fileStat.mtimeMs / 1000),
        typeflag: "0",
      }),
      content,
      padToBlock(content.length)
    );
  }
}

// Builds a gzipped tar of the agent source tree, rooted at `archiveRoot` so
// unpacking yields a single directory rather than scattering files.
export async function createAgentTarball(
  agentDir: string,
  archiveRoot = "agent"
): Promise<Buffer> {
  const blocks: Buffer[] = [];
  await collect(agentDir, archiveRoot, blocks);
  // Two zero blocks terminate a tar archive.
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return gzipAsync(Buffer.concat(blocks));
}
