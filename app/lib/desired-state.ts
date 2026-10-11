// Declaration schema and validator for `Role.desiredState`.
//
// `Role.desiredState` is a `String` column holding JSON text (SQLite has no
// native JSON type). `parseDeclaration` takes that raw string and returns a
// validated, typed `Declaration`, or throws with a message naming the exact
// offending key. Unknown keys are errors, not warnings — a typo here will
// later drive host changes, so it must fail loudly rather than silently
// falling back to a default. Versions are opaque strings; this module never
// interprets them as semver.

export type RuntimeKind = "ollama" | "vllm";
export type PresenceState = "present" | "absent";

export interface ModelDeclaration {
  name?: string;
  repo?: string;
  state: PresenceState;
  /**
   * The expected download size in bytes, when the catalog that produced
   * this declaration reported one. The agent's disk precondition treats an
   * absent size as unknown and never assumes it fits — see
   * `agent/zllama_agent/models.py`'s `check_disk` — so a hand-written
   * declaration with no `sizeBytes` is still valid; it will simply block
   * on the disk check rather than being rejected here.
   */
  sizeBytes?: number;
}

export interface RuntimeDeclaration {
  state: PresenceState;
  version?: string;
  models: ModelDeclaration[];
}

export interface Declaration {
  runtimes: Partial<Record<RuntimeKind, RuntimeDeclaration>>;
  agentVersion?: string;
}

const RUNTIME_KINDS: readonly RuntimeKind[] = ["ollama", "vllm"];
const PRESENCE_STATES: readonly PresenceState[] = ["present", "absent"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresenceState(value: unknown): value is PresenceState {
  return typeof value === "string" && (PRESENCE_STATES as readonly string[]).includes(value);
}

function isRuntimeKind(value: string): value is RuntimeKind {
  return (RUNTIME_KINDS as readonly string[]).includes(value);
}

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(`Invalid declaration: unknown key "${path}.${key}"`);
    }
  }
}

function parseModelDeclaration(kind: string, index: number, raw: unknown): ModelDeclaration {
  const path = `runtimes.${kind}.models[${index}]`;

  if (!isPlainObject(raw)) {
    throw new Error(`Invalid declaration: "${path}" must be an object`);
  }
  assertNoUnknownKeys(raw, ["name", "repo", "state", "sizeBytes"], path);

  const hasName = "name" in raw;
  const hasRepo = "repo" in raw;

  if (hasName && hasRepo) {
    throw new Error(
      `Invalid declaration: "${path}" has both "name" and "repo" — these are different engines' forms and mean different things`
    );
  }
  if (!hasName && !hasRepo) {
    throw new Error(`Invalid declaration: "${path}" must have either "name" or "repo"`);
  }
  // The form is engine-specific: `name` is an Ollama tag,
  // `repo` is a HuggingFace repo id. Accepting either for either kind is not
  // permissive, it is a silent break — a vLLM model declared with `name`
  // validates, is stored, is served, and reaches the agent's `_vllm_pull`
  // with no repo id at all, which used to raise into main.py's bare
  // `except Exception` so no convergence report was ever sent: the console
  // showed neither a failure nor a run.
  if (kind === "ollama" && !hasName) {
    throw new Error(
      `Invalid declaration: "${path}" must use "name" (an Ollama tag, e.g. "qwen3:32b") — "repo" is the vLLM/HuggingFace form`
    );
  }
  if (kind === "vllm" && !hasRepo) {
    throw new Error(
      `Invalid declaration: "${path}" must use "repo" (a HuggingFace repo id, e.g. "Qwen/Qwen3-32B-Instruct") — "name" is the Ollama tag form`
    );
  }

  let name: string | undefined;
  if (hasName) {
    if (typeof raw.name !== "string") {
      throw new Error(`Invalid declaration: "${path}.name" must be a string`);
    }
    name = raw.name;
  }

  let repo: string | undefined;
  if (hasRepo) {
    if (typeof raw.repo !== "string") {
      throw new Error(`Invalid declaration: "${path}.repo" must be a string`);
    }
    repo = raw.repo;
  }

  let state: PresenceState = "present";
  if ("state" in raw) {
    if (!isPresenceState(raw.state)) {
      throw new Error(`Invalid declaration: "${path}.state" must be "present" or "absent"`);
    }
    state = raw.state;
  }

  let sizeBytes: number | undefined;
  if ("sizeBytes" in raw) {
    if (typeof raw.sizeBytes !== "number" || !Number.isFinite(raw.sizeBytes) || raw.sizeBytes <= 0) {
      throw new Error(`Invalid declaration: "${path}.sizeBytes" must be a positive number`);
    }
    sizeBytes = raw.sizeBytes;
  }

  return { name, repo, state, sizeBytes };
}

function parseRuntimeDeclaration(kind: string, raw: unknown): RuntimeDeclaration {
  const path = `runtimes.${kind}`;

  if (!isPlainObject(raw)) {
    throw new Error(`Invalid declaration: "${path}" must be an object`);
  }
  assertNoUnknownKeys(raw, ["state", "version", "models"], path);

  if (!isPresenceState(raw.state)) {
    throw new Error(`Invalid declaration: "${path}.state" must be "present" or "absent"`);
  }
  const state = raw.state;

  let version: string | undefined;
  if ("version" in raw) {
    if (typeof raw.version !== "string") {
      throw new Error(`Invalid declaration: "${path}.version" must be a string, not a number`);
    }
    version = raw.version;
  }

  let models: ModelDeclaration[] = [];
  if ("models" in raw) {
    if (!Array.isArray(raw.models)) {
      throw new Error(`Invalid declaration: "${path}.models" must be an array`);
    }
    models = raw.models.map((entry, index) => parseModelDeclaration(kind, index, entry));
  }

  return { state, version, models };
}

/**
 * Parses and validates the raw JSON text stored in `Role.desiredState`.
 * Throws `Error` with a message naming the offending key or value on any
 * invalid input, including malformed JSON and unknown keys.
 */
export function parseDeclaration(raw: string): Declaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid declaration: not valid JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Invalid declaration: expected a JSON object");
  }

  assertNoUnknownKeys(parsed, ["runtimes", "agent"], "declaration");

  const declaration: Declaration = { runtimes: {} };

  if ("agent" in parsed) {
    const agent = parsed.agent;
    if (!isPlainObject(agent)) {
      throw new Error('Invalid declaration: "agent" must be an object');
    }
    assertNoUnknownKeys(agent, ["version"], "agent");

    if ("version" in agent) {
      if (typeof agent.version !== "string") {
        throw new Error('Invalid declaration: "agent.version" must be a string, not a number');
      }
      declaration.agentVersion = agent.version;
    }
  }

  if ("runtimes" in parsed) {
    const runtimes = parsed.runtimes;
    if (!isPlainObject(runtimes)) {
      throw new Error('Invalid declaration: "runtimes" must be an object');
    }

    for (const [kind, value] of Object.entries(runtimes)) {
      if (!isRuntimeKind(kind)) {
        throw new Error(`Invalid declaration: unknown runtime kind "${kind}" (expected "ollama" or "vllm")`);
      }
      declaration.runtimes[kind] = parseRuntimeDeclaration(kind, value);
    }
  }

  return declaration;
}

/**
 * The inverse of `parseDeclaration`: turns a `Declaration` back into the
 * raw JSON text `Role.desiredState` stores. Not a bare `JSON.stringify` —
 * `agentVersion` must be re-nested under `agent.version`, the one place
 * this type's shape doesn't already match the raw wire format, or writing
 * a declaration back (e.g. from the Discover page's "add to role" action)
 * would round-trip into a declaration `parseDeclaration` itself rejects as
 * an unknown key.
 */
export function serializeDeclaration(declaration: Declaration): string {
  return JSON.stringify({
    runtimes: declaration.runtimes,
    ...(declaration.agentVersion !== undefined ? { agent: { version: declaration.agentVersion } } : {}),
  });
}
