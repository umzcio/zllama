/**
 * GPU facts sourced from fleet-agent check-ins.
 *
 * The agents on every enrolled host report their GPU inventory (and the last
 * sampled utilisation/temperature/power/memory figures) into `Host.gpus` on
 * every check-in. Endpoints are linked to the hosts they run on, so anything
 * that wants to show GPU stats for an endpoint reads those stored rows instead
 * of probing a per-endpoint sidecar over HTTP. No live GPU probe is ever made.
 *
 * `null` means "not known" and is preserved as `null` all the way to the UI —
 * zero is a real measurement, not a stand-in for missing data.
 */

/** A host that has not checked in for this long is considered stale. */
export const GPU_STALE_AFTER_MS = 180_000;

export type GpuUnavailableReason =
  /** The endpoint has no linked hosts — the operator must link one. */
  | "no_linked_hosts"
  /** Linked hosts exist but their agents stopped reporting. */
  | "stale"
  /** Fresh check-ins, but every reported GPU has a failed driver. */
  | "driver_failed"
  /** Fresh check-ins, but the hosts report no GPUs at all. */
  | "no_gpus";

/** The subset of `Gpu` columns this module needs. */
export interface FleetGpuRow {
  index: number;
  name: string;
  memoryTotalBytes: number | null;
  memorySource: string;
  driverStatus: string;
  lastUtilPct: number | null;
  lastTempC: number | null;
  lastPowerW: number | null;
  lastMemoryUsedBytes: number | null;
}

/** The subset of `Host` columns this module needs. */
export interface FleetHost {
  nodeName: string;
  lastCheckInAt: Date | string | null;
  gpus: FleetGpuRow[];
}

/** Prisma select clause that produces a `FleetHost[]` on an endpoint query. */
export const fleetGpuHostSelect = {
  select: {
    nodeName: true,
    lastCheckInAt: true,
    gpus: {
      select: {
        index: true,
        name: true,
        memoryTotalBytes: true,
        memorySource: true,
        driverStatus: true,
        lastUtilPct: true,
        lastTempC: true,
        lastPowerW: true,
        lastMemoryUsedBytes: true,
      },
      orderBy: { index: "asc" },
    },
  },
} as const;

export interface FleetGpuInfo {
  /** Which host reported this GPU — endpoints may span several machines. */
  hostNodeName: string;
  index: number;
  name: string;
  /** `"nvml"` for driver-reported totals, `"unified"` for derived ones. */
  memorySource: string;
  memoryTotal: number | null;
  memoryUsed: number | null;
  memoryFree: number | null;
  temperature: number | null;
  utilization: number | null;
  powerDraw: number | null;
}

export interface FleetGpuResult {
  gpuInfo: FleetGpuInfo[] | null;
  /** Why `gpuInfo` is null; `null` when GPU data is present. */
  gpuReason: GpuUnavailableReason | null;
  /** ISO timestamp of the most recent check-in when `gpuReason === "stale"`. */
  gpuStaleSince: string | null;
}

function toMillis(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toGpuInfo(host: FleetHost, gpu: FleetGpuRow): FleetGpuInfo {
  const memoryTotal = gpu.memoryTotalBytes;
  const memoryUsed = gpu.lastMemoryUsedBytes;
  return {
    hostNodeName: host.nodeName,
    index: gpu.index,
    name: gpu.name,
    memorySource: gpu.memorySource,
    memoryTotal,
    memoryUsed,
    memoryFree:
      memoryTotal !== null && memoryUsed !== null ? memoryTotal - memoryUsed : null,
    temperature: gpu.lastTempC,
    utilization: gpu.lastUtilPct,
    powerDraw: gpu.lastPowerW,
  };
}

/**
 * Collect the GPUs of an endpoint's linked hosts from stored check-in data.
 *
 * Hosts whose last check-in is older than {@link GPU_STALE_AFTER_MS} are
 * dropped — their figures no longer describe the machine. GPUs whose driver
 * failed are dropped too, since they carry no usable numbers.
 */
export function collectFleetGpus(
  hosts: FleetHost[],
  now: Date = new Date()
): FleetGpuResult {
  if (hosts.length === 0) {
    return { gpuInfo: null, gpuReason: "no_linked_hosts", gpuStaleSince: null };
  }

  const cutoff = now.getTime() - GPU_STALE_AFTER_MS;
  const fresh = hosts.filter((host) => {
    const ms = toMillis(host.lastCheckInAt);
    return ms !== null && ms >= cutoff;
  });

  if (fresh.length === 0) {
    const latest = hosts
      .map((host) => toMillis(host.lastCheckInAt))
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => b - a)[0];
    return {
      gpuInfo: null,
      gpuReason: "stale",
      gpuStaleSince: latest === undefined ? null : new Date(latest).toISOString(),
    };
  }

  const usable: FleetGpuInfo[] = [];
  let sawAnyGpu = false;
  for (const host of fresh) {
    for (const gpu of [...host.gpus].sort((a, b) => a.index - b.index)) {
      sawAnyGpu = true;
      if (gpu.driverStatus === "failed") continue;
      usable.push(toGpuInfo(host, gpu));
    }
  }

  if (usable.length === 0) {
    return {
      gpuInfo: null,
      gpuReason: sawAnyGpu ? "driver_failed" : "no_gpus",
      gpuStaleSince: null,
    };
  }

  return { gpuInfo: usable, gpuReason: null, gpuStaleSince: null };
}
