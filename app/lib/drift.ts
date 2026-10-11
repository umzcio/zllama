// Drift engine: classifies a host's actual runtime state against its role's
// declared state.
//
// `computeDrift` is a pure, synchronous function — it takes already-loaded
// host facts plus a parsed `Declaration` and returns a verdict. No Prisma
// import, no `await`, no I/O. All database access lives in the caller (the
// route/job that loads the Host, its Gpus, its Runtimes, and its Role, then
// calls this function). That purity is what makes it testable without a
// database.
//
// Versions are opaque strings — compared with exact string equality, never
// parsed as semver (see `lib/desired-state.ts`).

import type { Declaration, ModelDeclaration, RuntimeKind } from "@/lib/desired-state";

export type DriftState = "in_sync" | "drifted" | "blocked" | "unmanaged" | "stale";

/**
 * Per-model drift verdict. A model present on a host but absent from the
 * declaration is `unmanaged`, never `drifted` — removal is only ever
 * planned for a model an operator explicitly named `state: "absent"`.
 */
export interface ModelDrift {
  name: string;
  state: DriftState;
  reason?: string;
}

export interface RuntimeDrift {
  kind: string;
  state: DriftState;
  desiredVersion?: string;
  actualVersion?: string;
  reason?: string;
  models: ModelDrift[];
}

export interface HostDrift {
  nodeName: string;
  state: DriftState; // the worst of its runtimes, by the precedence below
  runtimes: RuntimeDrift[];
}

/**
 * Six times the agent's 30-second default check-in interval, so a single
 * missed check-in never shows as stale.
 */
export const STALE_AFTER_MS = 180_000;

/** A model actually observed installed under a runtime on a host. */
export interface HostModelFacts {
  name: string;
  sizeBytes: number | null;
}

/** A runtime actually observed installed on a host. */
export interface HostRuntimeFacts {
  kind: string;
  version: string | null;
  models?: HostModelFacts[];
}

/** A GPU actually observed on a host. */
export interface HostGpuFacts {
  driverStatus: string;
}

/** Already-loaded facts about a single host — no Prisma types leak in here. */
export interface HostFacts {
  nodeName: string;
  roleId: string | null;
  converge: boolean;
  approvalState: string;
  lastCheckInAt: Date | null;
  runtimes: HostRuntimeFacts[];
  gpus: HostGpuFacts[];
}

export interface DriftInput {
  host: HostFacts;
  declaration: Declaration;
  /** Reference "current time" for the staleness check, injected for purity. */
  now: Date;
}

// Precedence order, worst first, used to roll a runtime's models up into the
// runtime's state and the runtimes up into the host's.
//
// "stale" outranks everything: a host that stopped reporting invalidates
// every other verdict about it. But "unmanaged" ranks *below* "blocked" and
// "drifted", because it means "not our business" — an undeclared model is
// reported, never acted on — and that is not worse than "differs from
// intent". Ranking it above them let one stray model escalate its runtime
// and its whole host to "unmanaged" and hide a real version drift
// underneath.
//
// The host-level "unmanaged" determination (no role, converge off, not
// approved) is a separate decision made in `computeDrift` before any runtime
// is inspected, and is unaffected by this ordering.
const STATE_PRECEDENCE: readonly DriftState[] = ["stale", "blocked", "drifted", "unmanaged", "in_sync"];

function worseOf(a: DriftState, b: DriftState): DriftState {
  return STATE_PRECEDENCE.indexOf(a) <= STATE_PRECEDENCE.indexOf(b) ? a : b;
}

function runtimeDiffers(
  desiredState: "present" | "absent",
  desiredVersion: string | undefined,
  actual: HostRuntimeFacts | undefined
): boolean {
  if (desiredState === "absent") {
    return actual !== undefined;
  }
  // desiredState === "present"
  if (actual === undefined) {
    return true;
  }
  if (desiredVersion === undefined) {
    // No version declared means "any version" — presence alone is enough.
    return false;
  }
  return actual.version !== desiredVersion;
}

/** A declared model's own identifier: its `name` (Ollama) or `repo` (vLLM). */
function modelIdentifier(declared: ModelDeclaration): string | undefined {
  return declared.name ?? declared.repo;
}

/**
 * Classifies drift for every model under one runtime, by exact-string
 * identifier — never normalized, never semver-parsed.
 *
 * Declared models are compared against what is actually installed:
 * present-and-found or absent-and-missing is `in_sync`; anything else
 * declared is `drifted`. A model actually installed but never named in the
 * declaration is `unmanaged` — it is reported, not treated as drift, so it
 * is never a candidate for implicit removal.
 */
function computeModelDrift(
  declaredModels: ModelDeclaration[],
  actualModels: HostModelFacts[]
): ModelDrift[] {
  const models: ModelDrift[] = [];
  const matchedActualNames = new Set<string>();

  for (const declared of declaredModels) {
    const identifier = modelIdentifier(declared);
    if (identifier === undefined) {
      continue;
    }

    const actual = actualModels.find((m) => m.name === identifier);
    if (actual !== undefined) {
      matchedActualNames.add(actual.name);
    }

    const isDeclaredAbsent = declared.state === "absent";
    const isPresentOnHost = actual !== undefined;
    const state: DriftState = isDeclaredAbsent === isPresentOnHost ? "drifted" : "in_sync";

    models.push({ name: identifier, state });
  }

  for (const actual of actualModels) {
    if (!matchedActualNames.has(actual.name)) {
      models.push({ name: actual.name, state: "unmanaged" });
    }
  }

  return models;
}

export function computeDrift(input: DriftInput): HostDrift {
  const { host, declaration, now } = input;

  const isStale =
    host.lastCheckInAt === null || now.getTime() - host.lastCheckInAt.getTime() > STALE_AFTER_MS;
  const isUnmanaged = host.roleId === null || !host.converge || host.approvalState !== "approved";
  const failedGpu = host.gpus.find((gpu) => gpu.driverStatus === "failed");

  const declaredKinds = Object.keys(declaration.runtimes) as RuntimeKind[];

  const runtimes: RuntimeDrift[] = declaredKinds.map((kind) => {
    const runtimeDeclaration = declaration.runtimes[kind];
    if (!runtimeDeclaration) {
      // Unreachable: declaredKinds comes from Object.keys(declaration.runtimes).
      throw new Error(`Invalid declaration: missing runtime declaration for "${kind}"`);
    }

    const actual = host.runtimes.find((r) => r.kind === kind);
    const desiredVersion = runtimeDeclaration.version;
    const actualVersion = actual?.version ?? undefined;

    // Stale and unmanaged hosts are not being watched at all: there is
    // nothing to report about their models either, so precedence stops
    // the per-model computation before it starts.
    if (isStale) {
      return { kind, state: "stale", desiredVersion, actualVersion, models: [] };
    }
    if (isUnmanaged) {
      return { kind, state: "unmanaged", desiredVersion, actualVersion, models: [] };
    }

    const models = computeModelDrift(runtimeDeclaration.models, actual?.models ?? []);
    const worstModelState = models.reduce<DriftState>(
      (worst, model) => worseOf(worst, model.state),
      "in_sync"
    );

    const differs = runtimeDiffers(runtimeDeclaration.state, desiredVersion, actual);
    if (!differs) {
      return { kind, state: worseOf("in_sync", worstModelState), desiredVersion, actualVersion, models };
    }
    if (failedGpu) {
      return {
        kind,
        state: worseOf("blocked", worstModelState),
        desiredVersion,
        actualVersion,
        models,
        reason: `host cannot converge: GPU driver is in "${failedGpu.driverStatus}" state`,
      };
    }
    return { kind, state: worseOf("drifted", worstModelState), desiredVersion, actualVersion, models };
  });

  let state: DriftState;
  if (isStale) {
    state = "stale";
  } else if (isUnmanaged) {
    state = "unmanaged";
  } else {
    state = runtimes.reduce<DriftState>((worst, runtime) => worseOf(worst, runtime.state), "in_sync");
  }

  return { nodeName: host.nodeName, state, runtimes };
}
