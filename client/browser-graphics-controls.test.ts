import { expect, it, vi } from "vitest";
import type { BrowserGraphicsState } from "../shared/browser-graphics";

vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("./browser-toolbar-menu", () => ({
  BrowserMenuItem: (props: Record<string, unknown>) => ({
    type: "Pressable",
    props: {
      ...props,
      accessibilityLabel: props.accessibilityLabel ?? props.label,
      children: props.label,
    },
  }),
  BrowserMenuHeading: (props: Record<string, unknown>) => ({ type: "Text", props }),
}));

const { BrowserGraphicsControls, describeBrowserGraphics } = await import(
  "./browser-graphics-controls"
);
type Element = {
  type?: string | ((props: Record<string, unknown>) => unknown);
  props?: Record<string, unknown>;
};
function expand(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  if (typeof element.type === "function") return expand(element.type(element.props ?? {}));
  return [element, ...expand(element.props?.children)];
}
const graphics: BrowserGraphicsState = {
  preference: "host-default",
  mode: "default",
  platform: "linux",
  hardware: false,
  renderer: "ANGLE (Google, SwiftShader)",
};
function props() {
  return {
    compact: false,
    theme: {
      colors: {
        foreground: "#111",
        foregroundMuted: "#666",
        accent: "#26f",
        border: "#bbb",
        surface1: "#fff",
        surface2: "#eee",
      },
    } as Parameters<typeof BrowserGraphicsControls>[0]["theme"],
    preference: "host-default" as const,
    graphics,
    disabled: false,
    applyDisabled: false,
    onChange: vi.fn(),
    onApply: vi.fn(),
  };
}
it("saves an explicit choice without applying it and offers apply only when startup differs", () => {
  const p = props();
  const choices = expand(BrowserGraphicsControls(p));
  const choice = choices.find(
    (e) => e.props?.accessibilityLabel === "Graphics mode: Vulkan GPU · Linux",
  )!;
  (choice.props!.onPress as () => void)();
  expect(p.onChange).toHaveBeenCalledExactlyOnceWith("vulkan");
  expect(p.onApply).not.toHaveBeenCalled();
  expect(choices.some((e) => e.props?.accessibilityLabel === "Apply graphics mode")).toBe(false);
  const pending = expand(BrowserGraphicsControls({ ...p, preference: "vulkan" }));
  expect(
    pending.some(
      (e) => e.props?.children === "Selected graphics mode is not active in this browser.",
    ),
  ).toBe(true);
  expect(pending.some((e) => e.props?.children === "Browser started with software rendering")).toBe(
    true,
  );
  expect(
    pending.some((e) => String(e.props?.children).includes("closes its tabs for every viewer")),
  ).toBe(true);
  (
    pending.find((e) => e.props?.accessibilityLabel === "Apply graphics mode")!.props!
      .onPress as () => void
  )();
  expect(p.onApply).toHaveBeenCalledOnce();
  expect(
    describeBrowserGraphics("vulkan", {
      ...graphics,
      preference: "vulkan",
      mode: "vulkan",
      hardware: true,
    }).title,
  ).toBe("Browser started with hardware GPU");
});
it("disables unsupported and busy choices and does not invent missing startup status", () => {
  const p = props();
  const nodes = expand(
    BrowserGraphicsControls({ ...p, graphics: { ...graphics, platform: "darwin" } }),
  );
  expect(
    nodes.find((e) => e.props?.accessibilityLabel === "Graphics mode: Vulkan GPU · Linux")?.props
      ?.disabled,
  ).toBe(true);
  const pending = expand(
    BrowserGraphicsControls({ ...p, preference: "vulkan", applyDisabled: true }),
  );
  expect(
    pending.find((e) => e.props?.accessibilityLabel === "Apply graphics mode")?.props?.disabled,
  ).toBe(true);
  const saving = expand(BrowserGraphicsControls({ ...p, disabled: true }));
  expect(
    saving
      .filter((e) => String(e.props?.accessibilityLabel).startsWith("Graphics mode:"))
      .every((e) => e.props?.disabled === true),
  ).toBe(true);
  expect(describeBrowserGraphics("vulkan", null)).toEqual({
    pending: false,
    title: "Browser graphics status not reported",
  });
  expect(describeBrowserGraphics("host-default", { ...graphics, hardware: null }).title).toBe(
    "Browser graphics status not reported",
  );
});

it("offers private desktop through the existing picker without applying it implicitly", () => {
  const p = props();
  const choices = expand(BrowserGraphicsControls({ ...p, preference: "private-desktop" }));
  const choice = choices.find(
    (node) => node.props?.accessibilityLabel === "Graphics mode: Private desktop · Linux",
  )!;
  (choice.props!.onPress as () => void)();
  expect(p.onChange).toHaveBeenCalledExactlyOnceWith("private-desktop");
  expect(p.onApply).not.toHaveBeenCalled();
  expect(choices.some((node) => String(node.props?.children).includes("Requires Xvfb"))).toBe(true);
});
