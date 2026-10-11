import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  collectFleetGpus,
  GPU_STALE_AFTER_MS,
  type FleetGpuRow,
  type FleetHost,
} from "@/lib/fleet-gpu";

const now = new Date("2026-08-22T12:00:00.000Z");
const fresh = new Date(now.getTime() - 30_000);

const gpu = (overrides: Partial<FleetGpuRow> = {}): FleetGpuRow => ({
  index: 0,
  name: "RTX 4090",
  memoryTotalBytes: 24_000_000_000,
  memorySource: "nvml",
  driverStatus: "ok",
  lastUtilPct: 45,
  lastTempC: 65,
  lastPowerW: 180,
  lastMemoryUsedBytes: 8_000_000_000,
  ...overrides,
});

const host = (
  nodeName: string,
  gpus: FleetGpuRow[],
  lastCheckInAt: Date | null = fresh
): FleetHost => ({ nodeName, lastCheckInAt, gpus });

describe("collectFleetGpus", () => {
  it("maps a stored GPU row onto the response shape", () => {
    const result = collectFleetGpus([host("gpu-node-2", [gpu()])], now);

    expect(result.gpuReason).toBeNull();
    expect(result.gpuInfo).toEqual([
      {
        hostNodeName: "gpu-node-2",
        index: 0,
        name: "RTX 4090",
        memorySource: "nvml",
        memoryTotal: 24_000_000_000,
        memoryUsed: 8_000_000_000,
        memoryFree: 16_000_000_000,
        temperature: 65,
        utilization: 45,
        powerDraw: 180,
      },
    ]);
  });

  it("returns every linked host's GPUs, attributed and ordered by index", () => {
    const result = collectFleetGpus(
      [
        host("spark-1", [gpu({ index: 1, name: "GB10" }), gpu({ index: 0, name: "GB10" })]),
        host("spark-2", [gpu({ name: "GB10" })]),
      ],
      now
    );

    expect(result.gpuInfo?.map((g) => [g.hostNodeName, g.index])).toEqual([
      ["spark-1", 0],
      ["spark-1", 1],
      ["spark-2", 0],
    ]);
  });

  it("keeps an unknown memory total null — zero is not unknown", () => {
    const result = collectFleetGpus(
      [
        host("spark-1", [
          gpu({
            name: "GB10",
            memorySource: "unified",
            memoryTotalBytes: null,
            lastMemoryUsedBytes: null,
          }),
        ]),
      ],
      now
    );

    expect(result.gpuInfo?.[0].memoryTotal).toBeNull();
    expect(result.gpuInfo?.[0].memoryUsed).toBeNull();
    expect(result.gpuInfo?.[0].memoryFree).toBeNull();
    expect(result.gpuInfo?.[0].memorySource).toBe("unified");
  });

  it("keeps a real zero measurement as zero", () => {
    const result = collectFleetGpus(
      [host("gpu-node-2", [gpu({ lastUtilPct: 0, lastPowerW: 0, lastMemoryUsedBytes: 0 })])],
      now
    );

    expect(result.gpuInfo?.[0].utilization).toBe(0);
    expect(result.gpuInfo?.[0].powerDraw).toBe(0);
    expect(result.gpuInfo?.[0].memoryUsed).toBe(0);
    expect(result.gpuInfo?.[0].memoryFree).toBe(24_000_000_000);
  });

  it("reports no_linked_hosts when the endpoint has no hosts", () => {
    expect(collectFleetGpus([], now)).toEqual({
      gpuInfo: null,
      gpuReason: "no_linked_hosts",
      gpuStaleSince: null,
    });
  });

  it("reports stale, with the last check-in, once check-ins age past the cutoff", () => {
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const result = collectFleetGpus([host("gpu-node-3", [gpu()], tenMinutesAgo)], now);

    expect(result.gpuInfo).toBeNull();
    expect(result.gpuReason).toBe("stale");
    expect(result.gpuStaleSince).toBe(tenMinutesAgo.toISOString());
  });

  it("reports stale with a null timestamp for a host that never checked in", () => {
    const result = collectFleetGpus([host("gpu-node-3", [gpu()], null)], now);

    expect(result.gpuReason).toBe("stale");
    expect(result.gpuStaleSince).toBeNull();
  });

  it("treats a check-in exactly at the cutoff as still fresh", () => {
    const atCutoff = new Date(now.getTime() - GPU_STALE_AFTER_MS);
    const result = collectFleetGpus([host("gpu-node-2", [gpu()], atCutoff)], now);

    expect(result.gpuReason).toBeNull();
    expect(result.gpuInfo).toHaveLength(1);
  });

  it("ignores stale hosts but still reports the fresh ones", () => {
    const result = collectFleetGpus(
      [
        host("stale-node", [gpu({ name: "Stale GPU" })], new Date(now.getTime() - 600_000)),
        host("fresh-node", [gpu({ name: "Fresh GPU" })]),
      ],
      now
    );

    expect(result.gpuInfo?.map((g) => g.hostNodeName)).toEqual(["fresh-node"]);
    expect(result.gpuReason).toBeNull();
  });

  it("distinguishes a failed driver from a host with no GPUs at all", () => {
    expect(
      collectFleetGpus([host("gpu-node-2", [gpu({ driverStatus: "failed" })])], now).gpuReason
    ).toBe("driver_failed");
    expect(collectFleetGpus([host("gpu-node-2", [])], now).gpuReason).toBe("no_gpus");
  });
});

/**
 * The containerized gpu-agent sidecar is gone; nothing may read or write the
 * legacy endpoint column again. The column itself has been dropped from the
 * schema (see migration `drop_gpu_agent_url`); historical migration SQL still
 * mentions it, so the prisma/ directory remains exempt.
 */
describe("legacy GPU agent column", () => {
  const appRoot = join(__dirname, "..", "..");
  const skipDirs = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);
  const legacyField = ["gpu", "Agent", "Url"].join("");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, out);
      } else if (/\.(ts|tsx|js|jsx|json)$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  it("is referenced nowhere outside the Prisma schema and its migrations", () => {
    const offenders = walk(appRoot)
      .filter((file) => {
        const rel = relative(appRoot, file);
        return !rel.startsWith(`prisma${sep}`) && rel !== relative(appRoot, __filename);
      })
      .filter((file) => readFileSync(file, "utf8").includes(legacyField))
      .map((file) => relative(appRoot, file));

    expect(offenders).toEqual([]);
  });
});
