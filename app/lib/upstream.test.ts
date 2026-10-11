import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let settingsRow: { key: string; value: string } | null = null;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn(async () => settingsRow),
      upsert: vi.fn(async ({ create, update }: { create: { key: string; value: string }; update: { value: string } }) => {
        settingsRow = settingsRow
          ? { key: settingsRow.key, value: update.value }
          : { key: create.key, value: create.value };
        return settingsRow;
      }),
    },
  },
}));

const realFetch = global.fetch;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  vi.clearAllMocks();
  settingsRow = null;
});

afterEach(() => {
  global.fetch = realFetch;
});

function mockFetchOk(
  tagName: string,
  htmlUrl = "https://github.com/ollama/ollama/releases/tag/latest",
  publishedAt = "2026-01-01T00:00:00Z"
) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: tagName, html_url: htmlUrl, published_at: publishedAt }),
  }) as unknown as typeof fetch;
}

function seedStored(overrides: {
  latest?: string;
  htmlUrl?: string;
  publishedAt?: string;
  checkedAt?: number;
  lastAttemptAt?: number;
}) {
  const value = {
    latest: "0.32.0",
    htmlUrl: "https://github.com/ollama/ollama/releases/tag/v0.32.0",
    publishedAt: "2025-01-01T00:00:00Z",
    checkedAt: Date.now(),
    lastAttemptAt: Date.now(),
    ...overrides,
  };
  settingsRow = { key: "upstream.ollama", value: JSON.stringify(value) };
  return value;
}

describe("getLatestOllamaVersion", () => {
  it("strips a single leading v from the tag and nothing else", async () => {
    mockFetchOk("v0.33.0");
    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    const result = await getLatestOllamaVersion();
    expect(result?.latest).toBe("0.33.0");
  });

  it("leaves a +build suffix on the tag untouched", async () => {
    mockFetchOk("v0.33.0+build.42");
    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    const result = await getLatestOllamaVersion();
    expect(result?.latest).toBe("0.33.0+build.42");
  });

  it("captures html_url and published_at verbatim", async () => {
    mockFetchOk(
      "v0.33.0",
      "https://github.com/ollama/ollama/releases/tag/v0.33.0",
      "2026-02-01T12:00:00Z"
    );
    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    const result = await getLatestOllamaVersion();
    expect(result?.htmlUrl).toBe("https://github.com/ollama/ollama/releases/tag/v0.33.0");
    expect(result?.publishedAt).toBe("2026-02-01T12:00:00Z");
  });

  it("serves the stored value without any network call when within the TTL", async () => {
    seedStored({ latest: "0.32.0", checkedAt: Date.now(), lastAttemptAt: Date.now() });
    global.fetch = vi.fn();
    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    const result = await getLatestOllamaVersion();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result?.latest).toBe("0.32.0");
    expect(result?.stale).toBeUndefined();
  });

  it("refetches and rewrites the Settings row once the TTL has expired", async () => {
    const past = Date.now() - (CACHE_TTL_MS + 1000);
    seedStored({ latest: "0.31.0", checkedAt: past, lastAttemptAt: past });
    mockFetchOk("v0.33.0");

    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    const result = await getLatestOllamaVersion();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result?.latest).toBe("0.33.0");
    expect(settingsRow?.value).toContain("0.33.0");
    expect(settingsRow?.value).not.toContain("0.31.0");
  });

  it("serves the stale stored value with stale:true and the error message on fetch failure", async () => {
    const past = Date.now() - (CACHE_TTL_MS + 1000);
    seedStored({ latest: "0.31.0", checkedAt: past, lastAttemptAt: past });
    global.fetch = vi.fn().mockRejectedValue(new Error("network unreachable"));

    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    const result = await getLatestOllamaVersion();

    expect(result).toEqual(
      expect.objectContaining({ latest: "0.31.0", stale: true, error: "network unreachable" })
    );
  });

  it("returns null when nothing is stored and the fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    const result = await getLatestOllamaVersion();
    expect(result).toBeNull();
  });

  it("force bypasses the TTL, but a second immediate force is guarded to one fetch", async () => {
    // Fresh (within-TTL) stored value, so a non-forced call would not fetch,
    // and its last attempt was over a minute ago, so the guard is not yet
    // active going into the first forced call.
    seedStored({ latest: "0.32.0", checkedAt: Date.now(), lastAttemptAt: Date.now() - 61_000 });
    mockFetchOk("v0.33.0");

    const { getLatestOllamaVersion } = await import("@/lib/upstream");

    const first = await getLatestOllamaVersion(true);
    expect(first?.latest).toBe("0.33.0");
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const second = await getLatestOllamaVersion(true);
    expect(second?.latest).toBe("0.33.0");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes an explicit timeout signal on every request", async () => {
    mockFetchOk("v0.33.0");
    const { getLatestOllamaVersion } = await import("@/lib/upstream");
    await getLatestOllamaVersion();

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("exports no version-comparison helper — differs is plain string inequality left to callers", async () => {
    const mod = await import("@/lib/upstream");
    expect(Object.keys(mod)).toEqual(["getLatestOllamaVersion"]);
  });
});
