import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const realFetch = global.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

afterEach(() => {
  global.fetch = realFetch;
  vi.useRealTimers();
});

function mockFetchOk(body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("searchHuggingFace", () => {
  it("maps HuggingFace results into CatalogEntry with source: huggingface", async () => {
    mockFetchOk([
      { id: "meta-llama/Llama-3.1-8B", pipeline_tag: "text-generation", usedStorage: 16_000_000_000 },
      { id: "Qwen/Qwen3-32B" },
    ]);

    const { searchHuggingFace } = await import("@/lib/catalogs/huggingface");
    const results = await searchHuggingFace("llama");

    expect(results).toEqual([
      {
        id: "meta-llama/Llama-3.1-8B",
        name: "meta-llama/Llama-3.1-8B",
        description: "text-generation",
        sizeBytes: 16_000_000_000,
        source: "huggingface",
      },
      {
        id: "Qwen/Qwen3-32B",
        name: "Qwen/Qwen3-32B",
        source: "huggingface",
      },
    ]);
  });

  it("queries the HuggingFace API with the search term", async () => {
    mockFetchOk([]);
    const { searchHuggingFace } = await import("@/lib/catalogs/huggingface");
    await searchHuggingFace("qwen3");

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toContain("huggingface.co/api/models");
    expect(calledUrl.searchParams.get("search")).toBe("qwen3");
  });

  it("returns an empty list and logs, without throwing, on a non-OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const { searchHuggingFace } = await import("@/lib/catalogs/huggingface");
    const results = await searchHuggingFace("llama");

    expect(results).toEqual([]);
  });

  it("returns an empty list and logs, without throwing, when fetch itself rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network unreachable"));

    const { searchHuggingFace } = await import("@/lib/catalogs/huggingface");
    const results = await searchHuggingFace("llama");

    expect(results).toEqual([]);
  });

  it("carries an explicit timeout on every request", async () => {
    mockFetchOk([]);
    const { searchHuggingFace } = await import("@/lib/catalogs/huggingface");
    await searchHuggingFace("llama");

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honors CATALOG_RATE_LIMIT_MS between successive requests", async () => {
    // Asserted logically against fake timers, not wall-clock elapsed time —
    // a real setTimeout can fire a hair early, and singleFork:true shares
    // the event loop with every other test file, so a wall-clock assertion
    // here was observed to flake under load.
    vi.useFakeTimers();
    vi.doMock("@/lib/constants", () => ({ CATALOG_RATE_LIMIT_MS: 200 }));
    mockFetchOk([]);

    const { searchHuggingFace } = await import("@/lib/catalogs/huggingface");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    await searchHuggingFace("a");
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = searchHuggingFace("b");

    // One tick short of the full limit: still inside the rate-limit
    // window, so the second request must not have reached fetch yet. This
    // boundary (limit - 1ms) is what actually proves the wait is enforced
    // — advancing all the way to the limit in one step would pass even if
    // the rate limit were a no-op, since draining fake timers also drains
    // any already-resolved microtask chain regardless of delay.
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    // Crossing the full 200ms releases it.
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst + 1);

    vi.doUnmock("@/lib/constants");
  });
});
