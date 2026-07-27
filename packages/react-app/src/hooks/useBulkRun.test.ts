// useBulkRun tests — the sequential bulk-write machine shared by all 3 Linking modes
// (v1.72, ADR-083). Keyless/offline: perItem is a plain vi.fn, no client/module mocks.

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { useBulkRun } from "./useBulkRun";

afterEach(() => cleanup());

interface Item {
  id: string;
  label: string;
}

describe("useBulkRun — run() sequencing", () => {
  it("processes items SEQUENTIALLY in array order — item 2 doesn't start until item 1 settles", async () => {
    const callOrder: string[] = [];
    let resolve1!: (v: string) => void;
    let resolve2!: (v: string) => void;
    const p1 = new Promise<string>((res) => {
      resolve1 = res;
    });
    const p2 = new Promise<string>((res) => {
      resolve2 = res;
    });

    const perItem = vi.fn((item: Item) => {
      callOrder.push(item.id);
      return item.id === "1" ? p1 : p2;
    });

    const { result } = renderHook(() => useBulkRun<Item, string>(perItem));

    act(() => {
      void result.current.run([
        { id: "1", label: "One" },
        { id: "2", label: "Two" },
      ]);
    });

    // Only item 1 has been invoked so far — item 2 must wait for item 1 to settle.
    await waitFor(() => expect(perItem).toHaveBeenCalledTimes(1));
    expect(callOrder).toEqual(["1"]);

    await act(async () => {
      resolve1("done-1");
      await p1;
    });

    await waitFor(() => expect(perItem).toHaveBeenCalledTimes(2));
    expect(callOrder).toEqual(["1", "2"]);

    await act(async () => {
      resolve2("done-2");
      await p2;
    });

    await waitFor(() => expect(result.current.done).toBe(true));
  });

  it("mixed results produce correct okCount/errCount and per-row status/error, with done true at the end", async () => {
    const perItem = vi.fn(async (item: Item) => {
      if (item.id === "2") throw { code: "UPSTREAM", message: "boom" };
      return `detail-${item.id}`;
    });

    const { result } = renderHook(() => useBulkRun<Item, string>(perItem));

    await act(async () => {
      await result.current.run([
        { id: "1", label: "One" },
        { id: "2", label: "Two" },
        { id: "3", label: "Three" },
      ]);
    });

    expect(result.current.done).toBe(true);
    expect(result.current.okCount).toBe(2);
    expect(result.current.errCount).toBe(1);
    expect(result.current.rows).toEqual([
      { id: "1", label: "One", status: "ok", detail: "detail-1" },
      { id: "2", label: "Two", status: "error", error: "boom" },
      { id: "3", label: "Three", status: "ok", detail: "detail-3" },
    ]);
  });
});

describe("useBulkRun — retryFailed()", () => {
  it("re-runs ONLY the error rows — perItem is not called again for rows that already succeeded", async () => {
    const attempts: Record<string, number> = {};
    const perItem = vi.fn(async (item: Item) => {
      attempts[item.id] = (attempts[item.id] ?? 0) + 1;
      if (item.id === "2" && attempts[item.id] === 1) {
        throw { code: "UPSTREAM", message: "boom" };
      }
      return `detail-${item.id}-${attempts[item.id]}`;
    });

    const { result } = renderHook(() => useBulkRun<Item, string>(perItem));

    await act(async () => {
      await result.current.run([
        { id: "1", label: "One" },
        { id: "2", label: "Two" },
      ]);
    });

    expect(result.current.okCount).toBe(1);
    expect(result.current.errCount).toBe(1);

    perItem.mockClear();

    await act(async () => {
      await result.current.retryFailed();
    });

    // Only row 2 (the failed one) was replayed — row 1 (already "ok") was untouched.
    expect(perItem).toHaveBeenCalledTimes(1);
    expect(perItem).toHaveBeenCalledWith({ id: "2", label: "Two" });
    expect(result.current.okCount).toBe(2);
    expect(result.current.errCount).toBe(0);
  });
});

describe("useBulkRun — reset()", () => {
  it("clears rows, counters, and done/running back to their initial state", async () => {
    const perItem = vi.fn(async (item: Item) => `ok-${item.id}`);
    const { result } = renderHook(() => useBulkRun<Item, string>(perItem));

    await act(async () => {
      await result.current.run([{ id: "1", label: "One" }]);
    });
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.done).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.rows).toEqual([]);
    expect(result.current.okCount).toBe(0);
    expect(result.current.errCount).toBe(0);
    expect(result.current.done).toBe(false);
    expect(result.current.running).toBe(false);
  });
});
