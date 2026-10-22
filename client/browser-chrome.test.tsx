import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock("react", () => ({
  useRef(initial: unknown) {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useState(initial: unknown) {
    const index = hooks.index++;
    hooks.slots[index] ??= initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = next;
      },
    ];
  },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Icon: () => null,
  TextInput: () => null,
}));
vi.mock("react-native", () => ({ Text: () => null, View: () => null }));

import { ErrorNotice } from "./browser-chrome";

type Notice = ReturnType<typeof ErrorNotice>;
function render(message: string, noticeId: unknown, noticeScope = "first") {
  hooks.index = 0;
  return ErrorNotice({
    message,
    noticeId,
    noticeScope,
    styles: {} as never,
    theme: { colors: { statusDanger: "red" } } as never,
  });
}
function dismiss(notice: Notice) {
  const children = notice!.props.children as { props?: { label?: string; onPress(): void } }[];
  const button = children.find((child) => child?.props?.label === "Dismiss message");
  if (!button?.props) throw new Error("Dismiss control missing");
  return button.props.onPress;
}
beforeEach(() => {
  hooks.index = 0;
  hooks.slots = [];
});

it("shows the same viewing failure again after recovery through a retained notice", () => {
  const failure = new Error("Viewing failed");
  dismiss(render("Viewing failed", failure))();
  expect(render("Viewing failed", failure)).toBeNull();
  expect(render("Browser information", "information")).not.toBeNull();
  expect(render("Viewing failed", failure)).not.toBeNull();
});
it("does not carry dismissal into a different panel scope", () => {
  dismiss(render("Viewing failed", "same failure", "old"))();
  expect(render("Viewing failed", "same failure", "new")).not.toBeNull();
});
it("a retained dismissal cannot hide a newer notice", () => {
  const oldDismiss = dismiss(render("Old failure", 1));
  expect(render("New failure", 2)).not.toBeNull();
  oldDismiss();
  expect(render("New failure", 2)).not.toBeNull();
});
