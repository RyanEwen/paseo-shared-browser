import { expect, it } from "vitest";
import { withLegacyEmptyWorkspaceHint } from "./empty-workspace";

it("tells wire 2 adapters how to open the first page of an empty workspace", () => {
  const reply = withLegacyEmptyWorkspaceHint({ state: { status: "empty" }, agentPolicy: {} });
  expect(reply).toMatchObject({
    state: { status: "empty" },
    hint: expect.stringContaining("shared_browser_navigate"),
  });
});

it("leaves replies about an open page unchanged", () => {
  const reply = { state: { status: "ready" } };
  expect(withLegacyEmptyWorkspaceHint(reply)).toBe(reply);
  expect(withLegacyEmptyWorkspaceHint(null)).toBeNull();
});
