import { describe, it, expect, vi } from "vitest";
import { ollamaFetch } from "@/lib/ollama";

describe("ollamaFetch", () => {
  it("calls the correct URL and returns JSON", async () => {
    const mockResponse = { version: "0.3.0" };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await ollamaFetch("http://localhost:11434", "/api/version");
    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/version",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("throws on non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(
      ollamaFetch("http://localhost:11434", "/api/version")
    ).rejects.toThrow("Ollama API error: 500 Internal Server Error");
  });

  it("strips trailing slash from base URL", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await ollamaFetch("http://localhost:11434/", "/api/tags");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything()
    );
  });

  it("passes no signal when called without a timeout, unchanged for existing callers", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await ollamaFetch("http://localhost:11434", "/api/version");
    const [, options] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(options.signal).toBeUndefined();
  });

  it("binds an AbortSignal when a timeout is explicitly given", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await ollamaFetch("http://localhost:11434", "/api/version", undefined, 4000);
    const [, options] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
