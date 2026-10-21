/** Render production confirmation controls with existing DOM tooling and the host's real focus scope. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
  options: { "tooling-root": { type: "string" }, "host-root": { type: "string" } },
});
const toolingRoot = resolve(values["tooling-root"] ?? repository);
const tooling = createRequire(join(toolingRoot, "package.json"));
const hostRoot = resolve(values["host-root"] ?? toolingRoot);
const { JSDOM } = tooling("jsdom");
const dom = new JSDOM('<button id="opener">Open</button><div id="root"></div>', {
  url: "http://127.0.0.1/",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  ShadowRoot: dom.window.ShadowRoot,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// JSDOM has no layout. The host filters invisible focus targets using client rects.
dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
const React = tooling("react");
const { createRoot } = tooling("react-dom/client");
const output = await mkdtemp(join(tmpdir(), "dialog-focus-mounted-"));
const localRequire = createRequire(import.meta.url);
let root;
try {
  await tooling("esbuild").build({
    entryPoints: [join(repository, "tests/fixtures/dialog-focus-mounted.fixture.tsx")],
    outfile: join(output, "fixture.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    alias: {
      react: tooling.resolve("react"),
      "react/jsx-runtime": tooling.resolve("react/jsx-runtime"),
      "react-native": tooling.resolve("react-native-web"),
      "fixture-host-overlay": join(hostRoot, "packages/app/src/lib/overlay-root.ts"),
      "@getpaseo/plugin/client/react-native": join(
        repository,
        "tests/fixtures/dialog-focus-modal.fixture.tsx",
      ),
    },
    external: [
      tooling.resolve("react"),
      tooling.resolve("react/jsx-runtime"),
      tooling.resolve("react-native-web"),
    ],
  });
  const { Fixture, HostScopeFixture } = localRequire(join(output, "fixture.cjs"));
  root = createRoot(document.getElementById("root"));
  const opener = document.getElementById("opener");
  // Compare retained-close behavior with the host alone. This adapter cannot qualify native restoration.
  await React.act(async () => opener.focus());
  const baseline = (open) =>
    React.createElement(
      HostScopeFixture,
      { open, onOpenChange() {} },
      React.createElement("button", { id: "baseline" }, "Baseline"),
    );
  await React.act(async () => root.render(baseline(true)));
  await React.act(async () => document.getElementById("baseline").focus());
  await React.act(async () => root.render(baseline(false)));
  const hostRetainsRestoration = document.activeElement === opener;
  await React.act(async () => root.render(null));
  const primary = () =>
    document.querySelector(
      '[aria-label="Take control"], [aria-label="Take over"], [aria-label="Close browser"]',
    );
  const cancel = () => document.querySelector('[aria-label="Cancel"]');
  let calls = 0;
  let cancels = 0;
  const props = {
    open: true,
    disabled: false,
    takeover: false,
    close: false,
    onConfirm: () => {
      calls++;
    },
    onCancel: () => {
      cancels++;
    },
  };
  const render = async (changes = {}) => {
    Object.assign(props, changes);
    await React.act(async () => {
      root.render(React.createElement(Fixture, props));
      await new Promise((done) => setTimeout(done, 25));
    });
  };
  const key = async (name, options = {}) => {
    await React.act(async () => {
      document.activeElement.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: name,
          code: name,
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      );
    });
  };
  for (const mode of [{}, { takeover: true }, { close: true }]) {
    await React.act(async () => opener.focus());
    await render({ open: true, ...mode });
    assert.ok(document.activeElement === primary(), "enabled primary receives focus");
    await React.act(async () => cancel().focus());
    await render();
    assert.ok(document.activeElement === cancel(), "rerenders preserve user focus");
    await React.act(async () => primary().focus());
    await key("Tab");
    assert.ok(document.activeElement === cancel(), "host wraps Tab to cancel");
    await key("Tab", { shiftKey: true });
    assert.ok(document.activeElement === primary(), "host wraps Shift+Tab to primary");
    const before = calls;
    await React.act(async () => primary().click());
    assert.equal(calls, before + 1, "primary activation confirms once");
    await render({ disabled: true });
    await React.act(async () => primary().click());
    assert.equal(calls, before + 1, "pending primary cannot submit again");
    await React.act(async () => document.querySelector('[role="dialog"]').focus());
    await render({ disabled: false });
    assert.ok(
      document.activeElement === document.querySelector('[role="dialog"]'),
      "settling pending does not steal focus",
    );
    await React.act(async () => cancel().click());
    const beforeEscape = cancels;
    await key("Escape");
    assert.equal(cancels, beforeEscape + 1, "host Escape invokes dismissal");
    await render({ open: false });
    assert.equal(
      document.activeElement === opener,
      hostRetainsRestoration,
      "retained close matches host-only restoration baseline",
    );
    await render({ open: true });
    assert.ok(document.activeElement === primary(), "retained content refocuses on reopen");
    await render({ open: false });
  }
  await React.act(async () => opener.focus());
  await render({ open: true, disabled: true });
  assert.ok(document.activeElement !== primary(), "disabled initial primary is skipped");
  await render({ disabled: false });
  assert.ok(
    document.activeElement === primary(),
    "initially unavailable action focuses when enabled",
  );
  await render({ mounted: false, open: false });
  await React.act(async () => opener.focus());
  await render({ mounted: true, open: true });
  assert.ok(document.activeElement === primary(), "unmounted content focuses when mounted again");
  console.log(`Host-only retained restoration remains on opener: ${hostRetainsRestoration}`);
  console.log(
    "PASS: control, takeover and close controls; activation, pending guards, Tab, Escape, host restoration baseline, retained reopen and remount (DOM fixture, real RN web and host overlay scope)",
  );
} finally {
  if (root) await React.act(async () => root.unmount());
  dom.window.close();
  await rm(output, { recursive: true, force: true });
}
