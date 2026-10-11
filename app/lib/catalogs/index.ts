// Catalog sources: ollama.com (scraped) and HuggingFace (searched via its
// public API). `searchCatalog` is the one entry point the Discover UI and
// the `/api/catalog` route call — it hides which upstream a given engine
// uses behind one shape, `CatalogEntry`.
//
// Every upstream request here carries an explicit timeout and is paced by
// `CATALOG_RATE_LIMIT_MS`; `CATALOG_REFRESH_ENABLED=false` serves the
// in-memory cache only and never makes an upstream request at all — see
// the module-level note below `scrapeAllModels` for the trade-off that
// implies on a cold start.

import * as cheerio from "cheerio";
import { ProxyAgent } from "undici";
import { CATALOG_RATE_LIMIT_MS, CATALOG_REFRESH_ENABLED } from "@/lib/constants";
import { searchHuggingFace } from "./huggingface";

export type EngineKind = "ollama" | "vllm";

export interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  sizeBytes?: number;
  source: "ollama" | "huggingface";
}

export interface ScrapedModel {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PAGES = 100;
const UPSTREAM_TIMEOUT_MS = 10_000;

const KNOWN_CAPABILITIES = ["tools", "vision", "embedding", "thinking", "cloud", "text"];

let cache: { data: ScrapedModel[]; timestamp: number } | null = null;
let lastUpstreamRequestAt = 0;

async function waitForRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastUpstreamRequestAt;
  const remaining = CATALOG_RATE_LIMIT_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  lastUpstreamRequestAt = Date.now();
}

function getProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (!proxyUrl) return undefined;
  return new ProxyAgent(proxyUrl);
}

async function fetchPage(url: string): Promise<string> {
  await waitForRateLimit();

  const dispatcher = getProxyDispatcher();
  const options: RequestInit & { dispatcher?: ProxyAgent } = {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (dispatcher) options.dispatcher = dispatcher;

  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function parseModelsFromHtml(html: string): ScrapedModel[] {
  const $ = cheerio.load(html);
  const models: ScrapedModel[] = [];

  $('a[href^="/library/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";
    const id = href.replace("/library/", "");
    if (!id || id.includes("/")) return;

    const heading = $el.find("h2").first().text().trim();
    const description = $el.find("p").first().text().trim();

    const capabilities: string[] = [];
    const sizes: string[] = [];
    let pulls = "";
    let updated = "";

    $el.find("span[x-test-size]").each((_, span) => {
      const text = $(span).text().trim().toLowerCase();
      if (text) sizes.push(text);
    });

    $el.find("span[x-test-capability]").each((_, span) => {
      const text = $(span).text().trim().toLowerCase();
      if (text && KNOWN_CAPABILITIES.includes(text)) capabilities.push(text);
    });

    const pullSpan = $el.find("span[x-test-pull-count]").first().text().trim();
    if (pullSpan) pulls = pullSpan;

    const updatedSpan = $el.find("span[x-test-updated]").first().text().trim();
    if (updatedSpan) updated = updatedSpan;

    models.push({ id, name: heading || id, description, capabilities, sizes, pulls, updated });
  });

  return models;
}

// `CATALOG_REFRESH_ENABLED=false` means "serve the cache only, never make
// an upstream request" — taken literally, including on a cold start with
// no cache yet, where this returns an empty list rather than ever
// scraping. That is a real, deliberate trade-off of honoring the flag
// exactly (an operator who sets it before the first request accepts an
// empty Discover page until they either seed the cache another way or
// re-enable refresh), not an oversight; see the group report for this
// branch.
export async function scrapeAllModels(): Promise<ScrapedModel[]> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }

  if (!CATALOG_REFRESH_ENABLED) {
    return cache?.data ?? [];
  }

  const modelMap = new Map<string, ScrapedModel>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? "https://ollama.com/search" : `https://ollama.com/search?page=${page}`;
    try {
      const html = await fetchPage(url);
      const models = parseModelsFromHtml(html);
      if (models.length === 0) break;
      for (const model of models) {
        if (!modelMap.has(model.id)) {
          modelMap.set(model.id, model);
        }
      }
    } catch {
      break;
    }
  }

  const models = Array.from(modelMap.values()).filter((m) => {
    if (m.capabilities.length === 1 && m.capabilities[0] === "cloud") return false;
    return m.sizes.length > 0 || m.capabilities.length > 0;
  });

  for (const model of models) {
    model.capabilities = model.capabilities.filter((c) => c !== "cloud");
    if (!model.capabilities.includes("embedding")) {
      model.capabilities.unshift("text");
    }
  }

  models.sort((a, b) => {
    const parseCount = (s: string) => {
      if (!s) return 0;
      const num = parseFloat(s);
      if (s.includes("M")) return num * 1_000_000;
      if (s.includes("K")) return num * 1_000;
      return num;
    };
    return parseCount(b.pulls) - parseCount(a.pulls);
  });

  cache = { data: models, timestamp: Date.now() };
  return models;
}

/** Exposed only for tests: cache/rate-limit state is module-level and must
 * be reset between test cases that exercise it. */
export function _resetCatalogStateForTests(): void {
  cache = null;
  lastUpstreamRequestAt = 0;
}

// A Q4-quantized model's on-disk size is roughly 0.55 bytes per declared
// parameter (matching the same heuristic the Discover page already uses
// for GPU-fit scoring, `parseTagToSizeGB` in
// `app/(discover)/discover/page.tsx`). ollama.com's size tags ("7b", "70b")
// are parameter counts, not byte sizes — this is the best estimate
// available from this catalog, not a size ollama.com reports directly.
function estimateOllamaSizeBytes(sizes: string[]): number | undefined {
  const tag = sizes[0];
  if (!tag) return undefined;

  const normalized = tag.toLowerCase().replace(/^\d+x/, "").replace(/^e(\d)/, "$1");
  const bMatch = normalized.match(/^(\d+(?:\.\d+)?)b$/);
  if (bMatch) return parseFloat(bMatch[1]) * 0.55 * 1_000_000_000;
  const mMatch = normalized.match(/^(\d+(?:\.\d+)?)m$/);
  if (mMatch) return (parseFloat(mMatch[1]) / 1000) * 0.55 * 1_000_000_000;
  return undefined;
}

async function searchOllamaCatalog(query: string): Promise<CatalogEntry[]> {
  const all = await scrapeAllModels();
  const needle = query.toLowerCase();
  const filtered = needle
    ? all.filter(
        (m) => m.name.toLowerCase().includes(needle) || m.description.toLowerCase().includes(needle)
      )
    : all;

  return filtered.map((m) => {
    const sizeBytes = estimateOllamaSizeBytes(m.sizes);
    return {
      id: m.id,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      source: "ollama" as const,
    };
  });
}

/**
 * Searches the catalog for the given engine. `ollama` uses the existing
 * ollama.com scrape (cached, rate-limited, timed-out); `vllm` searches
 * HuggingFace. Neither ever throws — a HuggingFace failure logs and
 * returns an empty list (see `searchHuggingFace`), and the ollama scrape
 * already degrades to a partial/cached/empty result on any upstream
 * failure.
 */
export async function searchCatalog(engine: EngineKind, query: string): Promise<CatalogEntry[]> {
  if (engine === "vllm") {
    return searchHuggingFace(query);
  }
  return searchOllamaCatalog(query);
}
