// Upstream release awareness for the fleet's runtime engines.
//
// Ollama: checks GitHub's "latest release" endpoint and caches the result in
// the `Settings` table (key-value, `String` columns — Prisma `Json` is
// unsupported on SQLite). Versions are opaque strings everywhere in this
// codebase (see `lib/desired-state.ts`, `lib/drift.ts`) — this module strips
// exactly one leading "v" from the GitHub tag and nothing else. It never
// parses, compares, or sorts versions as semver; "differs from the pin" is
// decided by the caller with plain string inequality.
//
// vLLM: deliberately out of scope. vLLM is frequently run as an externally
// managed container or dev build (`0.1.dev1+g…`), not a PyPI release — a
// PyPI-latest comparison against that string would be pure noise, so no vLLM
// upstream check exists here.

import { prisma } from "@/lib/prisma";

const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/ollama/ollama/releases/latest";
const SETTINGS_KEY = "upstream.ollama";

// Same convention as the other upstream-fetch budgets in this codebase
// (`ENGINE_PROBE_TIMEOUT_MS`, `lib/catalogs/huggingface.ts`'s
// `UPSTREAM_TIMEOUT_MS`): an explicit, named timeout passed as an
// `AbortSignal`, never a bare unbounded `fetch`.
const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FORCE_GUARD_MS = 60_000;

export interface UpstreamRelease {
  latest: string;
  htmlUrl: string;
  publishedAt: string;
  checkedAt: number;
  stale?: boolean;
  error?: string;
}

interface StoredUpstreamOllama {
  latest: string;
  htmlUrl: string;
  publishedAt: string;
  /** Epoch ms of the last *successful* fetch — drives the TTL. */
  checkedAt: number;
  /** Epoch ms of the last fetch *attempt*, success or failure — drives the once-per-minute force guard. */
  lastAttemptAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStored(raw: string | undefined): StoredUpstreamOllama | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isPlainObject(parsed) &&
      typeof parsed.latest === "string" &&
      typeof parsed.htmlUrl === "string" &&
      typeof parsed.publishedAt === "string" &&
      typeof parsed.checkedAt === "number" &&
      typeof parsed.lastAttemptAt === "number"
    ) {
      return {
        latest: parsed.latest,
        htmlUrl: parsed.htmlUrl,
        publishedAt: parsed.publishedAt,
        checkedAt: parsed.checkedAt,
        lastAttemptAt: parsed.lastAttemptAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeStored(value: StoredUpstreamOllama): Promise<void> {
  const data = JSON.stringify(value);
  await prisma.settings.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: data },
    update: { value: data },
  });
}

function toPublic(stored: StoredUpstreamOllama, extra?: { stale?: boolean; error?: string }): UpstreamRelease {
  return {
    latest: stored.latest,
    htmlUrl: stored.htmlUrl,
    publishedAt: stored.publishedAt,
    checkedAt: stored.checkedAt,
    ...(extra?.stale !== undefined ? { stale: extra.stale } : {}),
    ...(extra?.error !== undefined ? { error: extra.error } : {}),
  };
}

async function fetchLatestRelease(): Promise<{ latest: string; htmlUrl: string; publishedAt: string }> {
  const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub's REST API rejects unauthenticated requests with no User-Agent.
      "User-Agent": "zllama-upstream-check",
    },
    signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`GitHub API responded with ${res.status}`);
  }

  const data: unknown = await res.json();
  if (!isPlainObject(data) || typeof data.tag_name !== "string") {
    throw new Error("Unexpected GitHub API response shape");
  }

  // Strip a single leading "v" — no other transformation, and never any
  // semver parsing. A tag like "v0.33.0+build" survives past the "v" as-is.
  const latest = data.tag_name.startsWith("v") ? data.tag_name.slice(1) : data.tag_name;
  const htmlUrl = typeof data.html_url === "string" ? data.html_url : "";
  const publishedAt = typeof data.published_at === "string" ? data.published_at : "";

  return { latest, htmlUrl, publishedAt };
}

/**
 * Returns the latest upstream Ollama release, cached in the `Settings`
 * table with a 6-hour TTL.
 *
 * - Within the TTL, serves the stored value with no network call.
 * - On an expired TTL, refetches and rewrites the stored value.
 * - On fetch failure, serves the stored value (however stale) with
 *   `stale: true` and the error message — an unreachable GitHub must never
 *   break or slow a page. With nothing stored and a failed fetch, returns
 *   `null`.
 * - `force: true` bypasses the TTL (for a "check now" button), but is
 *   itself throttled to once per minute via a guard persisted in the same
 *   Settings row, so rapid repeat clicks don't burn the unauthenticated
 *   GitHub rate limit.
 */
export async function getLatestOllamaVersion(force = false): Promise<UpstreamRelease | null> {
  const now = Date.now();
  const row = await prisma.settings.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = parseStored(row?.value);

  const withinTtl = stored !== null && now - stored.checkedAt < CACHE_TTL_MS;
  const guardActive = stored !== null && now - stored.lastAttemptAt < FORCE_GUARD_MS;

  const shouldFetch = force ? !guardActive : !withinTtl;

  if (!shouldFetch) {
    return stored ? toPublic(stored) : null;
  }

  try {
    const { latest, htmlUrl, publishedAt } = await fetchLatestRelease();
    const updated: StoredUpstreamOllama = { latest, htmlUrl, publishedAt, checkedAt: now, lastAttemptAt: now };
    await writeStored(updated);
    return toPublic(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!stored) {
      return null;
    }
    // Record the failed attempt (for the force guard) without disturbing
    // the last known-good data or its `checkedAt`.
    const updated: StoredUpstreamOllama = { ...stored, lastAttemptAt: now };
    await writeStored(updated);
    return toPublic(updated, { stale: true, error: message });
  }
}
