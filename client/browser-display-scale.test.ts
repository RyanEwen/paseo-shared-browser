import { expect, it, vi } from "vitest";
import {
  type BrowserDisplayScaleSource,
  observeBrowserDisplayScale,
  readBrowserDisplayScale,
} from "./browser-display-scale";

it("keeps native fallback distinct from live browser scale and local viewport zoom", () => {
  expect(readBrowserDisplayScale(3, {})).toBe(3);
  expect(readBrowserDisplayScale(1, { devicePixelRatio: 2, visualViewport: { scale: 1.5 } })).toBe(
    3,
  );
  expect(
    readBrowserDisplayScale(2, { devicePixelRatio: Number.NaN, visualViewport: { scale: 0 } }),
  ).toBe(2);
});

it("updates demand when moving monitors without a window resize, then rearms and cleans up", () => {
  const queries: Array<{
    scale: string;
    change?: () => void;
    remove: ReturnType<typeof vi.fn<() => void>>;
  }> = [];
  const windowResize = new Set<() => void>();
  const zoomResize = new Set<() => void>();
  const source: BrowserDisplayScaleSource = {
    devicePixelRatio: 1,
    addEventListener: (_type, fn) => {
      windowResize.add(fn);
    },
    removeEventListener: (_type, fn) => {
      windowResize.delete(fn);
    },
    visualViewport: {
      scale: 1,
      addEventListener: (_type, fn) => {
        zoomResize.add(fn);
      },
      removeEventListener: (_type, fn) => {
        zoomResize.delete(fn);
      },
    },
    matchMedia(scale) {
      const entry = { scale, remove: vi.fn<() => void>() } as (typeof queries)[number];
      queries.push(entry);
      return {
        addEventListener: (_type, fn) => {
          entry.change = fn;
        },
        removeEventListener: entry.remove,
      };
    },
  };
  const changed = vi.fn();
  const dispose = observeBrowserDisplayScale(1, changed, source);
  expect(changed).toHaveBeenLastCalledWith(1);
  source.devicePixelRatio = 2;
  queries[0]!.change!();
  expect(changed).toHaveBeenLastCalledWith(2);
  expect(queries[1]!.scale).toBe("(resolution: 2dppx)");
  expect(queries[0]!.remove).toHaveBeenCalledOnce();
  source.visualViewport!.scale = 1.5;
  for (const fn of zoomResize) fn();
  expect(changed).toHaveBeenLastCalledWith(3);
  expect(queries).toHaveLength(2);
  dispose();
  expect(windowResize.size).toBe(0);
  expect(zoomResize.size).toBe(0);
  expect(queries[1]!.remove).toHaveBeenCalledOnce();
  changed.mockClear();
  queries[1]!.change!();
  expect(changed).not.toHaveBeenCalled();
});
