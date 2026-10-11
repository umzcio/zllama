// HuggingFace catalog source: searches HuggingFace's public model listing
// API for vLLM-servable repos. No credential is required for this endpoint
// — it is the same unauthenticated search HuggingFace's own model hub page
// uses. If that ever changes, this must be reported rather than having a
// token invented or hardcoded here.

import { logger } from "@/lib/logger";
import { CATALOG_RATE_LIMIT_MS } from "@/lib/constants";
import type { CatalogEntry } from "./index";

const HUGGINGFACE_SEARCH_URL = "https://huggingface.co/api/models";
const SEARCH_LIMIT = 20;
const UPSTREAM_TIMEOUT_MS = 10_000;

// Its own rate-limit clock, independent of the ollama.com scrape's — each
// upstream source paces its own successive requests.
let lastRequestAt = 0;

async function waitForRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  const remaining = CATALOG_RATE_LIMIT_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  lastRequestAt = Date.now();
}

interface HuggingFaceModel {
  id?: unknown;
  modelId?: unknown;
  pipeline_tag?: unknown;
  usedStorage?: unknown;
}

function toCatalogEntry(model: HuggingFaceModel): CatalogEntry | null {
  const id = typeof model.id === "string" ? model.id : model.modelId;
  if (typeof id !== "string" || !id) {
    return null;
  }

  const description = typeof model.pipeline_tag === "string" ? model.pipeline_tag : undefined;
  const sizeBytes =
    typeof model.usedStorage === "number" && model.usedStorage > 0
      ? model.usedStorage
      : undefined;

  return {
    id,
    name: id,
    ...(description !== undefined ? { description } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    source: "huggingface",
  };
}

/**
 * Searches HuggingFace's model listing API for vLLM-servable repos.
 *
 * Never throws: a failed request or an unexpected response shape is
 * logged and produces an empty list, so a HuggingFace outage degrades the
 * Discover page's vLLM tab rather than breaking it.
 */
export async function searchHuggingFace(query: string): Promise<CatalogEntry[]> {
  await waitForRateLimit();

  const url = new URL(HUGGINGFACE_SEARCH_URL);
  if (query) {
    url.searchParams.set("search", query);
  }
  url.searchParams.set("limit", String(SEARCH_LIMIT));

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("HuggingFace catalog search failed", { status: res.status });
      return [];
    }

    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      logger.warn("HuggingFace catalog search returned an unexpected shape");
      return [];
    }

    const entries: CatalogEntry[] = [];
    for (const model of data as HuggingFaceModel[]) {
      const entry = toCatalogEntry(model);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  } catch (error) {
    logger.warn("HuggingFace catalog search errored", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
