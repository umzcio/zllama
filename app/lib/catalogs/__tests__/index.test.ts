import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const realFetch = global.fetch;

const SEARCH_PAGE_HTML = `
  <a href="/library/llama3">
    <h2>llama3</h2>
    <p>Meta's Llama 3</p>
    <span x-test-size>8b</span>
    <span x-test-capability>tools</span>
    <span x-test-pull-count>5M</span>
    <span x-test-updated>2 weeks ago</span>
  </a>
`;
const EMPTY_PAGE_HTML = "<html><body>no more results</body></html>";

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

afterEach(() => {
  global.fetch = realFetch;
  vi.useRealTimers();
  vi.doUnmock("@/lib/constants");
});

function mockScrapePages(pages: string[]) {
  let call = 0;
  global.fetch = vi.fn().mockImplementation(async () => {
    const html = pages[call] ?? EMPTY_PAGE_HTML;
    call += 1;
    return { ok: true, status: 200, text: async () => html };
  }) as unknown as typeof fetch;
}

describe("searchCatalog", () => {
  it("uses the existing ollama.com scrape path for the ollama engine", async () => {
    vi.doMock("@/lib/constants", () => ({
      CATALOG_RATE_LIMIT_MS: 0,
      CATALOG_REFRESH_ENABLED: true,
    }));
    mockScrapePages([SEARCH_PAGE_HTML]);

    const { searchCatalog } = await import("@/lib/catalogs");
    const results = await searchCatalog("ollama", "llama");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "llama3", name: "llama3", source: "ollama" });
  });

  it("queries the HuggingFace API for the vllm engine", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "Qwen/Qwen3-32B" }],
    }) as unknown as typeof fetch;

    const { searchCatalog } = await import("@/lib/catalogs");
    const results = await searchCatalog("vllm", "qwen");

    expect(results).toEqual([
      { id: "Qwen/Qwen3-32B", name: "Qwen/Qwen3-32B", source: "huggingface" },
    ]);
    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toContain("huggingface.co/api/models");
  });
});

describe("scrapeAllModels", () => {
  it("carries an explicit timeout on every upstream request", async () => {
    vi.doMock("@/lib/constants", () => ({
      CATALOG_RATE_LIMIT_MS: 0,
      CATALOG_REFRESH_ENABLED: true,
    }));
    mockScrapePages([SEARCH_PAGE_HTML]);
    const { scrapeAllModels } = await import("@/lib/catalogs");
    await scrapeAllModels();

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honors CATALOG_RATE_LIMIT_MS between successive page requests", async () => {
    // Asserted logically against fake timers, not wall-clock elapsed time —
    // a real setTimeout can fire a hair early, and singleFork:true shares
    // the event loop with every other test file, so a wall-clock assertion
    // here was observed to flake under load.
    vi.useFakeTimers();
    vi.doMock("@/lib/constants", () => ({
      CATALOG_RATE_LIMIT_MS: 150,
      CATALOG_REFRESH_ENABLED: true,
    }));
    // Page 1 has a result (so the loop continues); page 2 is empty (so it
    // stops there) — exactly two fetches, one rate-limit wait between them.
    mockScrapePages([SEARCH_PAGE_HTML, EMPTY_PAGE_HTML]);

    const { scrapeAllModels } = await import("@/lib/catalogs");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    const promise = scrapeAllModels();

    // Page 1 fetches immediately — nothing to pace against yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBe(1);

    // One tick short of the full limit: page 2 must not have fetched yet.
    // This boundary (limit - 1ms) is what actually proves the wait is
    // enforced — advancing straight to the limit would pass even if the
    // rate limit were a no-op, since draining fake timers also drains any
    // already-resolved microtask chain regardless of delay.
    await vi.advanceTimersByTimeAsync(149);
    expect(fetchMock.mock.calls.length).toBe(1);

    // Crossing the full 150ms releases page 2.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls.length).toBe(2);

    await promise;
  });

  it("serves the cache on a second call within the TTL, making no second upstream request", async () => {
    vi.doMock("@/lib/constants", () => ({
      CATALOG_RATE_LIMIT_MS: 0,
      CATALOG_REFRESH_ENABLED: true,
    }));
    mockScrapePages([SEARCH_PAGE_HTML]);
    const { scrapeAllModels } = await import("@/lib/catalogs");

    await scrapeAllModels();
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await scrapeAllModels();
    const callsAfterSecond = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it("CATALOG_REFRESH_ENABLED=false serves the cache only and makes no upstream request", async () => {
    vi.doMock("@/lib/constants", () => ({
      CATALOG_RATE_LIMIT_MS: 0,
      CATALOG_REFRESH_ENABLED: false,
    }));
    global.fetch = vi.fn() as unknown as typeof fetch;

    const { scrapeAllModels } = await import("@/lib/catalogs");
    const results = await scrapeAllModels();

    expect(results).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
