import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("advertises recovery tools even when the initial supervisor connection is unavailable", async () => {
  const home = await mkdtemp(join(tmpdir(), "shared-browser-mcp-recovery-"));
  const bundle = join(home, "adapter.cjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../server/mcp-entry.ts", import.meta.url))],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { PASEO_HOME: home, PASEO_SHARED_BROWSER_TICKET: "synthetic-private-ticket-" + "x".repeat(40) },
    stderr: "pipe",
  });
  const client = new Client({ name: "isolated-recovery-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "shared_browser_reconnect", "shared_browser_open", "shared_browser_status",
    ]));
    const result = await client.callTool({ name: "shared_browser_reconnect", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-ticket");
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
});
