import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  Compose: () => null,
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void) => fixture.effects.push(effect),
}));
vi.mock("react-native", () => ({ TextInput: () => null }));
vi.mock("./browser-compose-controls", () => ({ ComposeTextControls: fixture.Compose }));

import { NativeKeyboardControls } from "./browser-native-keyboard-controls";

beforeEach(() => {
  fixture.effects = [];
});

/** Inspect the host typing sink and delegated Compose props without mounting a native app. */
function render(kind: "keyboard" | "compose", currentOwner = "owner") {
  const relay = {
    inputRef: { current: { blur: vi.fn() } },
    inputProps: {},
    inputKey: "input",
    focus: vi.fn(),
    reset: vi.fn(),
    composeText: vi.fn(),
  };
  const cancelInput = vi.fn();
  const handled = vi.fn();
  const tree = NativeKeyboardControls({
    relay: relay as never,
    cancelInput,
    styles: {} as never,
    theme: {} as never,
    enabled: true,
    ownershipKey: currentOwner,
    documentKey: "document",
    request: { id: 1, kind, ownershipKey: "owner" },
    onRequestHandled: handled,
    canRequestControl: false,
    onRequestControlForCompose: vi.fn(),
  }) as unknown as { props: { children: Array<{ props: Record<string, unknown> }> } };
  for (const effect of fixture.effects) effect();
  return { relay, cancelInput, handled, compose: tree.props.children[1]!.props };
}

it("keeps the Keyboard action live without replacing the upstream Compose sheet", () => {
  const { relay, handled, compose } = render("keyboard");
  expect(relay.focus).toHaveBeenCalledOnce();
  expect(handled).toHaveBeenCalledWith(1);
  expect(compose.request).toBeNull();
});

it("does not focus a typing sink for a request from the previous controller", () => {
  const { relay } = render("keyboard", "replacement-owner");
  expect(relay.focus).not.toHaveBeenCalled();
});

it("delegates Compose unchanged and cancels live typing before opening its draft", () => {
  const { relay, cancelInput, handled, compose } = render("compose");
  expect(handled).not.toHaveBeenCalled();
  expect(compose.request).toEqual({ id: 1, kind: "compose", ownershipKey: "owner" });
  expect(compose.composeText).toBe(relay.composeText);
  (compose.cancelInput as () => void)();
  expect(relay.inputRef.current.blur).toHaveBeenCalledOnce();
  expect(relay.reset).toHaveBeenCalledOnce();
  expect(cancelInput).toHaveBeenCalledOnce();
});
