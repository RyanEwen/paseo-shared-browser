import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../server/browser-policy";
import type { CdpSession } from "../server/cdp";
import { createRuntimeOwner } from "../server/runtime-owner";

/** Actual Chromium pixels and input qualify the existing expired-receipt refusal
 * followed by a fresh-image recovery. No account, modal or action replay is involved. */
it("refuses an expired quiet-video press and recovers through fresh JPEG pixels", async () => {
  if (
    !process.env.PASEO_HOME ||
    !process.env.PASEO_HOST ||
    !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
    !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE
  ) {
    throw new Error("Freshness smoke requires explicit isolated home, host and binaries");
  }
  const home = await mkdtemp(join(tmpdir(), "sb-frame-freshness-"));
  const fixture = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><title>Freshness fixture</title><button style="position:absolute;left:20px;top:20px;width:200px;height:50px" onclick="window.clicks++">Click witness</button><input style="position:absolute;top:100px" value="retained draft"><script>window.clicks=0</script>`,
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no port");
  vi.stubEnv("PASEO_HOME", home);
  const owner = await createRuntimeOwner({
    initialUrl: `http://localhost:${address.port}/`,
    nativeVideo: true,
    virtualDisplay: false,
  });
  const runtime = await owner.create("freshness");
  const manager = new SessionManager({
    validateWorkspace: async () => true,
    client: {
      connect: async () => ({ epoch: 1 }),
      ensureWorkspace: async (workspaceId) => ({
        workspaceId,
        runtimeId: runtime.runtimeId,
        createdAt: Date.now(),
      }),
      archiveWorkspace: async () => {},
      closeWorkspace: async () => {},
      disconnect() {},
      requestWorkspace: (_workspace, operation, input, guard) =>
        owner.request(runtime, operation, input, guard ? () => guard.assertCurrent() : undefined),
    },
  });
  try {
    await manager.connect();
    const { viewerToken } = await manager.attach("freshness", "Fixture");
    const { controlToken } = await manager.acquireControl(viewerToken);
    let read = await manager.readVideo({
      viewerToken,
      quality: "high",
      streamId: null,
      afterSequence: 0,
      waitMs: 500,
      requestKeyFrame: true,
    });
    await vi.waitFor(
      async () => {
        if (read.packets.length) return;
        read = await manager.readVideo({
          viewerToken,
          quality: "high",
          streamId: read.streamId,
          afterSequence: 0,
          waitMs: 500,
          requestKeyFrame: true,
        });
        expect(read.packets.length).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    const expected = {
      sessionId: read.state.sessionId,
      runtimeId: read.state.runtimeId!,
      bridgeEpoch: read.state.bridgeEpoch!,
      navigationGeneration: read.state.navigationGeneration,
      viewportGeneration: read.state.viewportGeneration,
    };
    const first = read.packets[0]!.frame;
    const begin = await manager.beginGesture({
      viewerToken,
      controlToken,
      expected,
      target: first,
      pointerKind: "mouse",
    });
    if (!("gestureId" in begin) || typeof begin.nextSequence !== "number")
      throw new Error("Fixture did not admit initial pixels");
    const point = { x: 100, y: 40, ...read.state.viewport };
    let sequence = begin.nextSequence;
    const started = performance.now();
    while (performance.now() - started < 5300) {
      await manager.updateGesture({
        viewerToken,
        controlToken,
        expected,
        gestureId: begin.gestureId,
        sequence: sequence++,
        event: { kind: "move", point },
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await expect(
      manager.updateGesture({
        viewerToken,
        controlToken,
        expected,
        gestureId: begin.gestureId,
        sequence,
        target: first,
        event: { kind: "down", point, button: "left", clickCount: 1 },
      }),
    ).rejects.toThrow(/stage=admission; reason=expired/);
    const page = (runtime.runtime as unknown as { page: CdpSession }).page;
    const inspect = async () => {
      const reply = await page.send<{ result: { value: { clicks: number; draft: string } } }>(
        "Runtime.evaluate",
        {
          expression: "({clicks:window.clicks,draft:document.querySelector('input').value})",
          returnByValue: true,
        },
      );
      return reply.result.value;
    };
    expect(await inspect()).toEqual({ clicks: 0, draft: "retained draft" });
    const fresh = await manager.capture(viewerToken, "medium");
    expect(fresh.frame?.byteLength).toBeGreaterThan(0);
    const recovered = await manager.beginGesture({
      viewerToken,
      controlToken,
      expected,
      target: fresh.frame!,
      pointerKind: "mouse",
    });
    if (!("gestureId" in recovered) || typeof recovered.nextSequence !== "number")
      throw new Error("Fresh JPEG not admitted");
    await manager.updateGesture({
      viewerToken,
      controlToken,
      expected,
      gestureId: recovered.gestureId,
      sequence: recovered.nextSequence,
      target: fresh.frame!,
      event: { kind: "down", point, button: "left", clickCount: 1 },
    });
    await manager.updateGesture({
      viewerToken,
      controlToken,
      expected,
      gestureId: recovered.gestureId,
      sequence: recovered.nextSequence + 1,
      event: { kind: "up", point, button: "left", clickCount: 1 },
    });
    expect(await inspect()).toEqual({ clicks: 1, draft: "retained draft" });
  } finally {
    manager.disconnect();
    await owner.stop(runtime);
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
