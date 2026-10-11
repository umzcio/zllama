import { describe, it, expect, vi } from "vitest";
import { notifyServersChanged, subscribeServersChanged } from "@/lib/server-events";

describe("server-events", () => {
  it("invokes subscribers when servers change", () => {
    const cb = vi.fn();
    const unsubscribe = subscribeServersChanged(cb);

    notifyServersChanged();
    notifyServersChanged();

    expect(cb).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("stops invoking a subscriber after unsubscribe", () => {
    const cb = vi.fn();
    const unsubscribe = subscribeServersChanged(cb);

    unsubscribe();
    notifyServersChanged();

    expect(cb).not.toHaveBeenCalled();
  });

  it("does not cross-invoke unrelated subscribers", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeServersChanged(first);
    const unsubSecond = subscribeServersChanged(second);

    notifyServersChanged();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubFirst();
    unsubSecond();
  });
});
