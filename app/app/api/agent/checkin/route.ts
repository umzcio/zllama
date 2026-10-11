export const dynamic = "force-dynamic";
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parseDeclaration, type Declaration, type RuntimeKind } from "@/lib/desired-state";

interface CheckinHost {
  arch: string;
  os: string;
  kernel?: string | null;
  cpu_model?: string | null;
  cpu_count?: number | null;
  ram_total_bytes?: number | null;
}

interface CheckinGpu {
  index: number;
  vendor: string;
  name: string;
  memory_total_bytes?: number | null;
  memory_used_bytes?: number | null;
  memory_source: string;
  driver_version?: string | null;
  driver_status?: string | null;
  util_pct?: number | null;
  temp_c?: number | null;
  power_w?: number | null;
}

// One installed model as the agent observed it. `name` is the engine's own
// identifier — an Ollama tag, or a HuggingFace repo id for vLLM — reported
// verbatim: model names are case-sensitive and are never normalized here.
interface CheckinModel {
  name: string;
  size_bytes?: number | null;
  digest?: string | null;
}

interface CheckinRuntime {
  kind: string;
  version?: string | null;
  install_method?: string | null;
  service_state?: string | null;
  model_path?: string | null;
  disk_total_bytes?: number | null;
  disk_free_bytes?: number | null;
  // Absent, or explicitly `null`, means "this agent did not report an
  // inventory" — an older agent that never sends the key, or a current one
  // whose probe failed (see `agent/zllama_agent/facts.py::_ollama_models`).
  // Neither is the same as `[]`, which means "nothing is installed". Only
  // the latter prunes previously-recorded rows.
  models?: CheckinModel[] | null;
}

// The vocabulary a `ConvergenceRun.status` can ever hold is closed — it must
// match exactly what the agent's `converge()` can report (see
// `agent/zllama_agent/converge.py`'s `ConvergenceResult.status`). An unknown
// status is rejected with 400 rather than stored: silently accepting a novel
// status would let a compromised or buggy agent write anything here.
const CONVERGENCE_STATUSES = [
  "no_changes",
  "vetoed",
  "vetoed_remote",
  "dry_run",
  "busy",
  "succeeded",
  "failed",
  "blocked",
  "cooling_down",
] as const;
type ConvergenceStatus = (typeof CONVERGENCE_STATUSES)[number];

interface CheckinConvergenceAction {
  kind: string;
  runtime: string;
  target_version?: string | null;
  reason?: string;
}

// `exit_code` is optional because an action skipped by failure backoff never
// ran and therefore has no exit status. Reporting `0` for it would read as
// "this succeeded" — the opposite of the truth — so the agent omits the
// field entirely and sends `outcome: "backed_off"` instead. Every outcome
// that *did* run still must carry a numeric exit_code; see validatePayload.
interface CheckinConvergenceOutcome {
  action?: unknown;
  exit_code?: number;
  outcome?: string;
  next_retry_at?: number;
  consecutive_failures?: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
  blocked?: boolean;
  shortfall_bytes?: number;
}

interface CheckinConvergence {
  status: ConvergenceStatus;
  actions?: CheckinConvergenceAction[];
  outcomes?: CheckinConvergenceOutcome[];
  current_action?: string | null;
  progress_pct?: number | null;
  error?: string | null;
}

interface CheckinPayload {
  node_name: string;
  agent_version?: string;
  host: CheckinHost;
  gpus?: CheckinGpu[];
  runtimes?: CheckinRuntime[];
  convergence?: CheckinConvergence;
}

// Captured stdout/stderr is attacker- or bug-controlled: a failing installer
// can emit megabytes of output. Truncate each captured stream to 64 KiB
// before it ever reaches the database — comfortably enough to diagnose a
// failure, small enough that a runaway installer can't grow this table
// without bound. A truncation marker is appended so it's never mistaken for
// the full output.
const MAX_CAPTURED_OUTPUT_CHARS = 64 * 1024;

function truncateCapturedOutput(value: string): string {
  if (value.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return value;
  }
  const omitted = value.length - MAX_CAPTURED_OUTPUT_CHARS;
  return `${value.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n...[truncated, ${omitted} more characters]`;
}

// Actions and outcomes are reported as two parallel arrays (outcomes only
// as far as execution got before the first failure, or not at all for
// no_changes/vetoed/dry_run/busy). The agent keeps them aligned by walking
// its own action list — including entries for actions it blocked on disk or
// skipped for failure backoff — so the positional merge below stays correct
// even when some actions never reached an executor. Merge them into one
// array for storage, truncating any captured output along the way.
function buildStoredActions(convergence: CheckinConvergence): unknown[] {
  const actions = convergence.actions ?? [];
  const outcomes = convergence.outcomes ?? [];

  return actions.map((action, index) => {
    const outcome = outcomes[index];
    if (!outcome) {
      return action;
    }
    return {
      ...action,
      // Only ever present when the executor actually ran (see the
      // interface comment). Spread conditionally rather than written as
      // `undefined`, so a backed-off entry has no exit_code key at all
      // after JSON.stringify rather than a missing-but-implied zero.
      ...(outcome.exit_code !== undefined ? { exit_code: outcome.exit_code } : {}),
      ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : {}),
      ...(outcome.next_retry_at !== undefined
        ? { next_retry_at: outcome.next_retry_at }
        : {}),
      ...(outcome.consecutive_failures !== undefined
        ? { consecutive_failures: outcome.consecutive_failures }
        : {}),
      stdout:
        typeof outcome.stdout === "string"
          ? truncateCapturedOutput(outcome.stdout)
          : outcome.stdout,
      stderr:
        typeof outcome.stderr === "string"
          ? truncateCapturedOutput(outcome.stderr)
          : outcome.stderr,
      duration_ms: outcome.duration_ms,
      ...(outcome.blocked !== undefined ? { blocked: outcome.blocked } : {}),
      ...(outcome.shortfall_bytes !== undefined
        ? { shortfall_bytes: outcome.shortfall_bytes }
        : {}),
    };
  });
}

// The wire shape sent to the agent. `zllama_agent.models.plan_model_actions`
// reads `size_bytes` (the same snake_case convention as the rest of the
// check-in payload, e.g. `disk_free_bytes`) — never the TS-side `sizeBytes`.
// `toAgentDeclaration` is the one place that renames it for the wire; the
// app's own internal `Declaration`/`ModelDeclaration` types (used by the
// drift engine, the roles UI, etc.) keep the idiomatic camelCase name.
interface WireModelDeclaration {
  name?: string;
  repo?: string;
  state: "present" | "absent";
  size_bytes?: number;
}

interface WireRuntimeDeclaration {
  state: "present" | "absent";
  version?: string;
  models: WireModelDeclaration[];
}

interface WireDeclaration {
  runtimes: Partial<Record<RuntimeKind, WireRuntimeDeclaration>>;
  agent?: { version: string };
}

function toAgentDeclaration(declaration: Declaration): WireDeclaration {
  const runtimes: WireDeclaration["runtimes"] = {};

  for (const kind of Object.keys(declaration.runtimes) as RuntimeKind[]) {
    const runtime = declaration.runtimes[kind];
    if (!runtime) {
      continue;
    }
    runtimes[kind] = {
      state: runtime.state,
      version: runtime.version,
      models: runtime.models.map((model) => ({
        name: model.name,
        repo: model.repo,
        state: model.state,
        ...(model.sizeBytes !== undefined ? { size_bytes: model.sizeBytes } : {}),
      })),
    };
  }

  return {
    runtimes,
    ...(declaration.agentVersion !== undefined
      ? { agent: { version: declaration.agentVersion } }
      : {}),
  };
}

// A `pending` host must be told nothing about its desired state: no
// `desired`, and no `converge` either (both are only meaningful once a host
// has been approved). `desired` is further gated on the host actually
// having a role assigned — an approved host with no role gets no `desired`
// key. This is the entire point of the enrollment gate.
type CheckinResponse = {
  status: string;
  converge?: boolean;
  desired?: WireDeclaration;
};

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.AGENT_ENROLL_TOKEN;
  if (!expected) {
    return false;
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  const provided = Buffer.from(authHeader.slice(7));
  const expectedBuf = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch rather than returning false,
  // so the length check must happen first.
  if (provided.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(provided, expectedBuf);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "number";
}

type Validated =
  | { ok: true; payload: CheckinPayload }
  | { ok: false; error: string };

// The agent is the only client of this route, but an unvalidated payload
// reaches Prisma with missing required columns (or a non-iterable `gpus`) and
// surfaces as a 500. A malformed check-in is the client's fault: answer 400
// naming the field that is wrong.
function validatePayload(body: unknown): Validated {
  if (!isRecord(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  if (!isNonEmptyString(body.node_name)) {
    return {
      ok: false,
      error: "node_name is required and must be a non-empty string",
    };
  }

  if (
    body.agent_version !== undefined &&
    typeof body.agent_version !== "string"
  ) {
    return { ok: false, error: "agent_version must be a string when present" };
  }

  const host = body.host;
  if (!isRecord(host)) {
    return {
      ok: false,
      error: "host is required and must be an object with arch and os",
    };
  }
  if (!isNonEmptyString(host.arch)) {
    return {
      ok: false,
      error: "host.arch is required and must be a non-empty string",
    };
  }
  if (!isNonEmptyString(host.os)) {
    return {
      ok: false,
      error: "host.os is required and must be a non-empty string",
    };
  }

  if (body.gpus !== undefined) {
    if (!Array.isArray(body.gpus)) {
      return { ok: false, error: "gpus must be an array when present" };
    }
    for (const [i, gpu] of body.gpus.entries()) {
      if (!isRecord(gpu)) {
        return { ok: false, error: `gpus[${i}] must be an object` };
      }
      if (typeof gpu.index !== "number" || !Number.isInteger(gpu.index)) {
        return { ok: false, error: `gpus[${i}].index must be an integer` };
      }
      if (!isNonEmptyString(gpu.vendor)) {
        return {
          ok: false,
          error: `gpus[${i}].vendor must be a non-empty string`,
        };
      }
      if (!isNonEmptyString(gpu.name)) {
        return { ok: false, error: `gpus[${i}].name must be a non-empty string` };
      }
      if (!isNonEmptyString(gpu.memory_source)) {
        return {
          ok: false,
          error: `gpus[${i}].memory_source must be a non-empty string`,
        };
      }
      if (!isNullableNumber(gpu.memory_total_bytes)) {
        return {
          ok: false,
          error: `gpus[${i}].memory_total_bytes must be a number or null`,
        };
      }
    }
  }

  if (body.runtimes !== undefined) {
    if (!Array.isArray(body.runtimes)) {
      return { ok: false, error: "runtimes must be an array when present" };
    }
    for (const [i, runtime] of body.runtimes.entries()) {
      if (!isRecord(runtime)) {
        return { ok: false, error: `runtimes[${i}] must be an object` };
      }
      if (!isNonEmptyString(runtime.kind)) {
        return {
          ok: false,
          error: `runtimes[${i}].kind must be a non-empty string`,
        };
      }
      // The installed-model inventory is validated as strictly as the rest
      // of the payload: it is written straight to HostModel, whose
      // [hostId, runtimeKind, name] key cannot tolerate a missing or
      // non-string name (Prisma would reject it as a 500 rather than a
      // client error). `null` is accepted here alongside `undefined` — the
      // agent sends it when its own probe failed — and handled identically
      // below: neither prunes.
      if (runtime.models !== undefined && runtime.models !== null) {
        if (!Array.isArray(runtime.models)) {
          return {
            ok: false,
            error: `runtimes[${i}].models must be an array or null when present`,
          };
        }
        for (const [j, model] of runtime.models.entries()) {
          if (!isRecord(model)) {
            return { ok: false, error: `runtimes[${i}].models[${j}] must be an object` };
          }
          if (!isNonEmptyString(model.name)) {
            return {
              ok: false,
              error: `runtimes[${i}].models[${j}].name must be a non-empty string`,
            };
          }
          if (!isNullableNumber(model.size_bytes)) {
            return {
              ok: false,
              error: `runtimes[${i}].models[${j}].size_bytes must be a number or null`,
            };
          }
          if (
            model.digest !== undefined &&
            model.digest !== null &&
            typeof model.digest !== "string"
          ) {
            return {
              ok: false,
              error: `runtimes[${i}].models[${j}].digest must be a string or null`,
            };
          }
        }
      }
    }
  }

  if (body.convergence !== undefined) {
    const convergence = body.convergence;
    if (!isRecord(convergence)) {
      return { ok: false, error: "convergence must be an object when present" };
    }

    if (
      typeof convergence.status !== "string" ||
      !(CONVERGENCE_STATUSES as readonly string[]).includes(convergence.status)
    ) {
      return {
        ok: false,
        error: `convergence.status must be one of ${CONVERGENCE_STATUSES.join(", ")}`,
      };
    }

    if (convergence.actions !== undefined) {
      if (!Array.isArray(convergence.actions)) {
        return { ok: false, error: "convergence.actions must be an array when present" };
      }
      for (const [i, action] of convergence.actions.entries()) {
        if (!isRecord(action)) {
          return { ok: false, error: `convergence.actions[${i}] must be an object` };
        }
        if (!isNonEmptyString(action.kind)) {
          return {
            ok: false,
            error: `convergence.actions[${i}].kind must be a non-empty string`,
          };
        }
        if (!isNonEmptyString(action.runtime)) {
          return {
            ok: false,
            error: `convergence.actions[${i}].runtime must be a non-empty string`,
          };
        }
      }
    }

    if (convergence.outcomes !== undefined) {
      if (!Array.isArray(convergence.outcomes)) {
        return { ok: false, error: "convergence.outcomes must be an array when present" };
      }
      for (const [i, outcome] of convergence.outcomes.entries()) {
        if (!isRecord(outcome)) {
          return { ok: false, error: `convergence.outcomes[${i}] must be an object` };
        }
        // An action skipped by failure backoff never ran, so it reports
        // `outcome: "backed_off"` and no exit code at all. Anything else
        // must still carry a numeric exit_code — a run report with a
        // missing exit status is unreadable, and a fabricated zero worse.
        const backedOff = outcome.outcome === "backed_off";
        if (
          outcome.outcome !== undefined &&
          (typeof outcome.outcome !== "string" || !backedOff)
        ) {
          return {
            ok: false,
            error: `convergence.outcomes[${i}].outcome must be "backed_off" when present`,
          };
        }
        if (!backedOff && typeof outcome.exit_code !== "number") {
          return {
            ok: false,
            error: `convergence.outcomes[${i}].exit_code must be a number`,
          };
        }
        if (
          outcome.next_retry_at !== undefined &&
          (typeof outcome.next_retry_at !== "number" ||
            !Number.isFinite(outcome.next_retry_at))
        ) {
          return {
            ok: false,
            error: `convergence.outcomes[${i}].next_retry_at must be a finite number when present`,
          };
        }
        if (
          outcome.consecutive_failures !== undefined &&
          (typeof outcome.consecutive_failures !== "number" ||
            !Number.isInteger(outcome.consecutive_failures) ||
            outcome.consecutive_failures < 1)
        ) {
          return {
            ok: false,
            error: `convergence.outcomes[${i}].consecutive_failures must be a positive integer when present`,
          };
        }
        if (outcome.stdout !== undefined && typeof outcome.stdout !== "string") {
          return {
            ok: false,
            error: `convergence.outcomes[${i}].stdout must be a string when present`,
          };
        }
        if (outcome.stderr !== undefined && typeof outcome.stderr !== "string") {
          return {
            ok: false,
            error: `convergence.outcomes[${i}].stderr must be a string when present`,
          };
        }
      }
    }

    if (
      convergence.current_action !== undefined &&
      convergence.current_action !== null &&
      typeof convergence.current_action !== "string"
    ) {
      return {
        ok: false,
        error: "convergence.current_action must be a string or null when present",
      };
    }

    // A malformed percentage (out of range, or not a number at all) is
    // rejected outright rather than stored — "blocked" without a real
    // number is useless, but so is a fabricated one.
    if (convergence.progress_pct !== undefined && convergence.progress_pct !== null) {
      if (
        typeof convergence.progress_pct !== "number" ||
        !Number.isFinite(convergence.progress_pct) ||
        convergence.progress_pct < 0 ||
        convergence.progress_pct > 100
      ) {
        return {
          ok: false,
          error: "convergence.progress_pct must be a number between 0 and 100 when present",
        };
      }
    }

    if (
      convergence.error !== undefined &&
      convergence.error !== null &&
      typeof convergence.error !== "string"
    ) {
      return {
        ok: false,
        error: "convergence.error must be a string or null when present",
      };
    }
  }

  // Every field the handler below reads has been checked above.
  return { ok: true, payload: body as unknown as CheckinPayload };
}

// The set of models a host's role actually names, keyed by
// `runtimeKind\u0000identifier`. This is what `HostModel.managed` is derived
// from, and it is the flag that makes "never delete a model nobody declared"
// enforceable — so it has to reflect the declaration rather than default to
// anything. A model declared `state: "absent"` still counts as *named*: the
// operator asked for it to be gone, which is very much zllama's business.
//
// The identifier is a declaration's `name` (Ollama tag) or `repo` (vLLM
// HuggingFace repo id), matched against the agent-reported name by exact
// string equality — model names are case-sensitive and never normalized.
function declaredModelKeys(declaration: Declaration | null): Set<string> {
  const keys = new Set<string>();
  if (!declaration) {
    return keys;
  }
  for (const kind of Object.keys(declaration.runtimes) as RuntimeKind[]) {
    const runtime = declaration.runtimes[kind];
    if (!runtime) {
      continue;
    }
    for (const model of runtime.models) {
      const identifier = model.name ?? model.repo;
      if (identifier !== undefined) {
        keys.add(`${kind}\u0000${identifier}`);
      }
    }
  }
  return keys;
}

// One role with a corrupt desiredState must not break check-in for the hosts
// assigned to it. Parsing is therefore attempted once per check-in and a
// failure logged and turned into `null`, which means both "no `desired` in
// the response" and "nothing is declared, so nothing is managed".
function parseRoleDeclaration(
  role: { id: string; desiredState: string } | null
): Declaration | null {
  if (!role) {
    return null;
  }
  try {
    return parseDeclaration(role.desiredState);
  } catch (error) {
    logger.error("Failed to parse role desiredState", {
      roleId: role.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validatePayload(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const payload = validated.payload;
  const nodeName = payload.node_name;
  const host = payload.host;
  const gpus = payload.gpus ?? [];
  const runtimes = payload.runtimes ?? [];

  const checkinResult = await prisma.$transaction(async (tx) => {
    const hostFacts = {
      arch: host.arch,
      os: host.os,
      kernel: host.kernel ?? null,
      cpuModel: host.cpu_model ?? null,
      cpuCount: host.cpu_count ?? null,
      ramTotalBytes: host.ram_total_bytes ?? null,
      agentVersion: payload.agent_version ?? null,
      lastCheckInAt: new Date(),
    };

    // A single upsert, not findUnique-then-create/update: two concurrent
    // first check-ins from the same node both read null, and the second
    // create then violates nodeName's unique constraint (P2002 -> 500).
    //
    // approvalState/converge/roleId are operator decisions. They appear only
    // in `create`, at their inert defaults, and never in `update` — a
    // check-in must not be able to approve itself, enable convergence, or
    // assign itself a role.
    const hostRecord = await tx.host.upsert({
      where: { nodeName },
      create: {
        nodeName,
        ...hostFacts,
        approvalState: "pending",
        converge: false,
      },
      update: hostFacts,
      include: { role: true },
    });

    for (const gpu of gpus) {
      const gpuData = {
        vendor: gpu.vendor,
        name: gpu.name,
        // `null` means "not measurable on this hardware" (unified memory);
        // it must never collapse to 0, which would read as a real reading.
        memoryTotalBytes: gpu.memory_total_bytes ?? null,
        memorySource: gpu.memory_source,
        driverVersion: gpu.driver_version ?? null,
        driverStatus: gpu.driver_status ?? "ok",
        lastUtilPct: gpu.util_pct ?? null,
        lastTempC: gpu.temp_c ?? null,
        lastPowerW: gpu.power_w ?? null,
        lastMemoryUsedBytes: gpu.memory_used_bytes ?? null,
      };
      await tx.gpu.upsert({
        where: { hostId_index: { hostId: hostRecord.id, index: gpu.index } },
        create: { hostId: hostRecord.id, index: gpu.index, ...gpuData },
        update: gpuData,
      });
    }

    // Parsed once, and used for two things: `HostModel.managed` below, and
    // the `desired` block of the response further down.
    const declaration = parseRoleDeclaration(hostRecord.role);
    const declaredModels = declaredModelKeys(declaration);

    for (const runtime of runtimes) {
      const runtimeData = {
        version: runtime.version ?? null,
        installMethod: runtime.install_method ?? null,
        serviceState: runtime.service_state ?? null,
        modelPath: runtime.model_path ?? null,
        diskTotalBytes: runtime.disk_total_bytes ?? null,
        diskFreeBytes: runtime.disk_free_bytes ?? null,
      };
      await tx.runtime.upsert({
        where: { hostId_kind: { hostId: hostRecord.id, kind: runtime.kind } },
        create: { hostId: hostRecord.id, kind: runtime.kind, ...runtimeData },
        update: { ...runtimeData, lastCheckedAt: new Date() },
      });

      // The installed-model inventory. Without these rows nothing on the
      // read side can tell a declared-and-installed model from a missing
      // one, and the agent re-plans a `pull_model` for every declared model
      // on every cycle forever.
      //
      // `undefined` and `null` are both "this check-in reports no inventory
      // for this runtime" — an older agent that omits the key, or a current
      // one whose probe itself failed — and neither may prune. Only a real
      // `[]` ("the probe succeeded and found nothing installed") reaches the
      // deleteMany below. Silence must not mean "nothing installed".
      if (runtime.models === undefined || runtime.models === null) {
        continue;
      }
      const seenNames: string[] = [];
      for (const model of runtime.models) {
        seenNames.push(model.name);
        const modelData = {
          sizeBytes: model.size_bytes ?? null,
          digest: model.digest ?? null,
          managed: declaredModels.has(`${runtime.kind}\u0000${model.name}`),
          lastSeenAt: new Date(),
        };
        await tx.hostModel.upsert({
          where: {
            hostId_runtimeKind_name: {
              hostId: hostRecord.id,
              runtimeKind: runtime.kind,
              name: model.name,
            },
          },
          create: {
            hostId: hostRecord.id,
            runtimeKind: runtime.kind,
            name: model.name,
            ...modelData,
          },
          update: modelData,
        });
      }

      // HostModel is a snapshot of what is installed *now*: a model the
      // agent no longer reports has been removed from the host, and leaving
      // its row behind would make the drift view claim it is still there
      // forever. Scoped to this runtime kind only — a runtime the check-in
      // said nothing about is not evidence about its models.
      await tx.hostModel.deleteMany({
        where: {
          hostId: hostRecord.id,
          runtimeKind: runtime.kind,
          name: { notIn: seenNames },
        },
      });
    }

    // A convergence report is optional and its absence is not an empty
    // run — no `convergence` key on the payload means no row is written.
    // Reporting is the only thing this write touches: it goes to
    // ConvergenceRun, never to the Host record, so a report can never
    // alter approvalState/converge/roleId (those are set exclusively in
    // the `hostRecord.upsert` above, which reads nothing from
    // `payload.convergence`).
    if (payload.convergence) {
      const convergence = payload.convergence;
      const startedAt = new Date();
      await tx.convergenceRun.create({
        data: {
          hostId: hostRecord.id,
          trigger: "checkin",
          status: convergence.status,
          startedAt,
          finishedAt: startedAt,
          currentAction: convergence.current_action ?? null,
          progressPct: convergence.progress_pct ?? null,
          actions: JSON.stringify(buildStoredActions(convergence)),
          error: convergence.error ?? null,
        },
      });
    }

    return {
      approvalState: hostRecord.approvalState,
      converge: hostRecord.converge,
      role: hostRecord.role,
      declaration,
    };
  });

  const response: CheckinResponse = { status: checkinResult.approvalState };

  // Only an approved host learns its converge setting or desired state. A
  // pending host must stay at exactly `{ status }` — that is the entire
  // point of the enrollment gate.
  if (checkinResult.approvalState === "approved") {
    response.converge = checkinResult.converge;

    // A corrupt `desiredState` already logged and became `null` in
    // `parseRoleDeclaration`; `desired` is simply omitted and the host
    // reports drift against nothing this cycle rather than the check-in
    // failing for every host assigned to that role.
    if (checkinResult.declaration) {
      response.desired = toAgentDeclaration(checkinResult.declaration);
    }
  }

  return NextResponse.json(response);
}
