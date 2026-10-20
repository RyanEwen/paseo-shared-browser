import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserVideoTestMetadata, browserVideoTestState } from "../tests/fixtures/browser-video";

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  cleanup: [] as (() => void)[],
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: value };
    return hooks.slots[index];
  },
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => (() => void) | undefined) =>
    hooks.effects.push(() => {
      const cleanup = effect();
      if (cleanup) hooks.cleanup.push(cleanup);
    }),
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text" }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));

import { BrowserAgentPointer } from "./browser-agent-pointer";

beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.effects = [];
  vi.useFakeTimers();
});
afterEach(() => {
  hooks.cleanup.splice(0).forEach((cleanup) => {
    cleanup();
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const state = browserVideoTestState();
  state.agentPointer = {
    x: 640,
    y: 400,
    source: "native",
    label: "Agent fixture",
    remainingMs: 5000,
    clickRemainingMs: 900,
  };
  const props = {
    state,
    frame: browserVideoTestMetadata().frame,
    rect: { x: 10, y: 20, width: 640, height: 400 },
    theme: { colors: { accent: "blue", accentForeground: "white" } } as Parameters<
      typeof BrowserAgentPointer
    >[0]["theme"],
  };
  const render = () => {
    hooks.index = 0;
    const tree = BrowserAgentPointer(props);
    hooks.effects.splice(0).forEach((effect) => {
      effect();
    });
    return tree;
  };
  return { props, render };
}

it("maps CSS points into the displayed frame and never intercepts input", () => {
  const f = fixture();
  const tree = f.render()!;
  expect(tree.props.pointerEvents).toBe("none");
  expect(tree.props.style).toMatchObject({ left: 10, top: 20, width: 640, height: 400 });
  const cursor = tree.props.children[1];
  expect(cursor.props.style).toMatchObject({ left: 317, top: 197 });
  expect(cursor.props.children[1].props.children.props.children).toBe("Agent fixture");
});

it("expires the pulse and presence using the local elapsed clock despite host wall-clock skew", () => {
  let elapsed = 100;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  vi.setSystemTime(new Date("2040-01-01"));
  const f = fixture();
  expect(f.render()!.props.children[0]).toBeTruthy();
  elapsed += 901;
  vi.setSystemTime(new Date("2000-01-01"));
  expect(f.render()!.props.children[0]).toBeNull();
  elapsed = 5100;
  expect(f.render()).toBeNull();
});

it.each(["navigationGeneration", "viewportGeneration", "runtimeId", "captureEpoch"] as const)(
  "hides activity over pixels from another %s",
  (key) => {
    const f = fixture();
    if (key === "runtimeId") f.props.frame.runtimeId = "different-runtime";
    else f.props.frame[key] = 999;
    expect(f.render()).toBeNull();
  },
);

it("uses a target marker for semantic actions and removes released ownership", () => {
  const f = fixture();
  f.props.state.agentPointer!.source = "semantic";
  expect(f.render()!.props.children[1].props.style).toMatchObject({ left: 310, top: 190 });
  expect(f.render()!.props.children[1].props.children[0].props.name).toBe("Crosshair");
  f.props.state.controller = "none";
  expect(f.render()).toBeNull();
});
