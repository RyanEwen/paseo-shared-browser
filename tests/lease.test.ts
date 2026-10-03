import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../server/browser";
import type { JsonValue } from "../server/runtime-protocol";
import type { SupervisorClient } from "../server/supervisor-client";

interface FakeWorkspace {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  userAgent: string;
  stopped: boolean;
  mouseUpCalls: number;
  navigateOnMouseDown: boolean;
}

class FakeSupervisorClient {
  connected = false;
  disconnected = false;
  readonly workspaces = new Map<string, FakeWorkspace>();
  readonly operations: Array<{
    workspaceId: string;
    operation: string;
    input: JsonValue;
  }> = [];
  archiveCalls: string[] = [];
  failOperation: string | null = null;
  ensureGate: Promise<void> | null = null;
  ensureStarted: (() => void) | null = null;

  async connect() {
    this.connected = true;
    return {
      bridgeId: "fake",
      epoch: 1,
      expiresAt: 60_000,
      heartbeatIntervalMs: 10_000,
    };
  }

  async ensureWorkspace(workspaceId: string) {
    let workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.stopped) {
      workspace = {
        url: "https://paseo.sh/",
        title: "Shared test page",
        viewport: { width: 1280, height: 800 },
        userAgent: "Fake Chromium",
        stopped: false,
        mouseUpCalls: 0,
        navigateOnMouseDown: false,
      };
      this.workspaces.set(workspaceId, workspace);
    }
    this.ensureStarted?.();
    if (this.ensureGate) await this.ensureGate;
    return { workspaceId, runtimeId: `runtime-${workspaceId}`, createdAt: 1 };
  }

  async requestWorkspace(
    workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    if (operation === this.failOperation) throw new Error(`Failed ${operation}`);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.stopped)
      throw new Error(`Workspace runtime not found: ${workspaceId}`);
    this.operations.push({ workspaceId, operation, input });
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    switch (operation) {
      case "identity":
        return { userAgent: workspace.userAgent };
      case "state":
        return {
          url: workspace.url,
          title: workspace.title,
          canGoBack: false,
          canGoForward: false,
        };
      case "navigate":
        workspace.url = String(data.url);
        return null;
      case "reload":
      case "screencast.start":
      case "screencast.stop":
      case "mouse.move":
      case "mouse.wheel":
      case "text.insert":
      case "key.down":
      case "key.up":
        return null;
      case "emulate":
        workspace.viewport = {
          width: Number(data.width),
          height: Number(data.height),
        };
        workspace.userAgent = String(data.userAgent);
        return null;
      case "frame": {
        const bytes = Buffer.from("fake-jpeg-frame");
        return {
          transport: "cdp-screencast",
          dataBase64: bytes.toString("base64"),
          byteLength: bytes.byteLength,
          width: workspace.viewport.width,
          height: workspace.viewport.height,
          capturedAt: "2026-01-01T00:00:00.000Z",
        };
      }
      case "mouse.down":
        if (workspace.navigateOnMouseDown) workspace.url = "https://navigated.example/";
        return null;
      case "mouse.up":
        workspace.mouseUpCalls += 1;
        return null;
      default:
        throw new Error(`Unexpected fake runtime operation: ${operation}`);
    }
  }

  async archiveWorkspace(workspaceId: string) {
    this.archiveCalls.push(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) workspace.stopped = true;
  }

  disconnect() {
    this.disconnected = true;
  }
}

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.disconnect();
});

function createManager(
  options: { now?: () => number; frameCacheMs?: number; maxSessions?: number } = {},
) {
  let token = 0;
  const client = new FakeSupervisorClient();
  const manager = new SessionManager({
    client: client as unknown as SupervisorClient,
    validateWorkspace: async (workspaceId) => workspaceId.startsWith("workspace-"),
    issueToken: () => `token_${String(++token).padStart(40, "0")}`,
    controlLeaseMs: 1_000,
    viewerTtlMs: 10_000,
    ...options,
  });
  managers.push(manager);
  return { manager, client };
}

function expected(state: {
  sessionId: string;
  navigationGeneration: number;
  viewportGeneration: number;
}) {
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  };
}

describe("SessionManager control leases", () => {
  it("shares one runtime, excludes a second controller, and supports takeover", async () => {
    const { manager, client } = createManager();
    await manager.connect();
    const first = await manager.attach("workspace-one", "First client");
    const second = await manager.attach("workspace-one", "Second client");

    expect(first.state.sessionId).toBe(second.state.sessionId);
    expect(second.state.viewerCount).toBe(2);
    expect(first.state).toMatchObject({
      runtimeId: "runtime-workspace-one",
      runtimeCreatedAt: 1,
      bridgeEpoch: 1,
    });
    expect((await manager.capture(first.viewerToken, "medium", null)).frame).toMatchObject({
      runtimeId: "runtime-workspace-one",
      captureEpoch: 1,
    });
    expect(client.workspaces.size).toBe(1);

    const firstControl = await manager.acquireControl(first.viewerToken, false);
    await expect(manager.acquireControl(second.viewerToken, false)).rejects.toThrow(
      "held by another viewer",
    );
    const secondControl = await manager.acquireControl(second.viewerToken, true);
    expect(secondControl.state.controller).toBe("self");
    await expect(
      manager.navigate({
        viewerToken: first.viewerToken,
        controlToken: firstControl.controlToken,
        expected: expected(firstControl.state),
        action: { kind: "reload" },
      }),
    ).rejects.toThrow("lease is invalid or expired");

    manager.disconnect();
    expect(client.disconnected).toBe(true);
    expect(client.workspaces.get("workspace-one")?.stopped).toBe(false);
    await expect(manager.capture(first.viewerToken, "medium", null)).rejects.toThrow(
      "invalid or expired",
    );
  });

  it("expires abandoned control and viewer leases deterministically", async () => {
    let now = 1_000;
    const { manager } = createManager({ now: () => now });
    const viewer = await manager.attach("workspace-one", "Client");
    await manager.acquireControl(viewer.viewerToken, false);
    now += 1_001;
    expect((await manager.capture(viewer.viewerToken, "medium", null)).state.controller).toBe(
      "none",
    );
    now += 10_001;
    await expect(manager.capture(viewer.viewerToken, "medium", null)).rejects.toThrow(
      "invalid or expired",
    );
  });

  it("expired viewing reattaches to the preserved page without taking another viewer's control or replaying input", async () => {
    let now = 1_000;
    const { manager, client } = createManager({ now: () => now });
    const returning = await manager.attach("workspace-one", "Returning client");
    const observer = await manager.attach("workspace-one", "Other client");
    now += 10_001;
    await expect(manager.capture(returning.viewerToken, "medium", null)).rejects.toThrow(
      "Viewer token is invalid or expired",
    );
    const other = await manager.attach("workspace-one", "Other current client");
    await manager.acquireControl(other.viewerToken, false);
    const previousCalls = client.operations.length;
    const recovered = await manager.attach("workspace-one", "Returning client");
    expect(recovered.viewerToken).not.toBe(returning.viewerToken);
    expect(recovered.state.sessionId).toBe(returning.state.sessionId);
    expect(recovered.state.runtimeId).toBe(returning.state.runtimeId);
    expect(recovered.state.url).toBe(returning.state.url);
    expect(recovered.state.controller).toBe("other");
    expect((await manager.status(other.viewerToken)).state.controller).toBe("self");
    expect(client.workspaces.size).toBe(1);
    expect(client.archiveCalls).toEqual([]);
    expect(client.operations.slice(previousCalls).map((call) => call.operation)).not.toContain(
      "navigate",
    );
    expect(client.operations.slice(previousCalls).map((call) => call.operation)).not.toContain(
      "mouse.down",
    );
    expect(await manager.detach(observer.viewerToken)).toEqual({ detached: false });
  });

  it("accepts a shared recent frame and rejects it after viewport invalidation", async () => {
    const { manager } = createManager({ frameCacheMs: 0 });
    const first = await manager.attach("workspace-one", "First client");
    const second = await manager.attach("workspace-one", "Second client");
    const control = await manager.acquireControl(first.viewerToken, false);
    const frame = (await manager.capture(second.viewerToken, "medium", null)).frame!;

    await expect(
      manager.sendInput({
        viewerToken: first.viewerToken,
        controlToken: control.controlToken,
        expected: expected(control.state),
        target: frame,
        event: {
          kind: "click",
          point: { x: 50, y: 25, width: 100, height: 50 },
          button: "left",
          clickCount: 1,
        },
      }),
    ).resolves.toBeDefined();

    const current = await manager.capture(first.viewerToken, "medium", null);
    const resized = await manager.resize({
      viewerToken: first.viewerToken,
      controlToken: control.controlToken,
      expected: expected(current.state),
      viewport: { width: 1024, height: 768 },
    });
    await expect(
      manager.sendInput({
        viewerToken: first.viewerToken,
        controlToken: control.controlToken,
        expected: expected(resized.state),
        target: frame,
        event: {
          kind: "click",
          point: { x: 50, y: 25, width: 100, height: 50 },
          button: "left",
          clickCount: 1,
        },
      }),
    ).rejects.toThrow("frame is stale");
  });

  it("rejects stale navigation, viewport, runtime, and bridge generations", async () => {
    const { manager } = createManager();
    const viewer = await manager.attach("workspace-one", "Client");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    const current = {
      sessionId: control.state.sessionId,
      navigationGeneration: control.state.navigationGeneration,
      viewportGeneration: control.state.viewportGeneration,
      runtimeId: control.state.runtimeId,
      bridgeEpoch: control.state.bridgeEpoch,
    };
    const navigate = (expectedState: typeof current) =>
      manager.navigate({
        viewerToken: viewer.viewerToken,
        controlToken: control.controlToken,
        expected: expectedState,
        action: { kind: "reload" },
      });

    await expect(
      navigate({
        ...current,
        navigationGeneration: current.navigationGeneration + 1,
      }),
    ).rejects.toThrow("navigation state is stale");
    await expect(
      navigate({
        ...current,
        viewportGeneration: current.viewportGeneration + 1,
      }),
    ).rejects.toThrow("viewport state is stale");
    await expect(navigate({ ...current, runtimeId: "different-runtime" })).rejects.toThrow(
      "runtime is stale",
    );
    await expect(navigate({ ...current, bridgeEpoch: current.bridgeEpoch! + 1 })).rejects.toThrow(
      "bridge state is stale",
    );
  });

  it("releases a compound gesture when navigation makes its frame stale", async () => {
    const { manager, client } = createManager();
    const viewer = await manager.attach("workspace-one", "Client");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    const capture = await manager.capture(viewer.viewerToken, "medium", null);
    client.workspaces.get("workspace-one")!.navigateOnMouseDown = true;

    await expect(
      manager.sendInput({
        viewerToken: viewer.viewerToken,
        controlToken: control.controlToken,
        expected: expected(capture.state),
        target: capture.frame!,
        event: {
          kind: "drag",
          start: { x: 10, y: 10, width: 640, height: 400 },
          end: { x: 50, y: 50, width: 640, height: 400 },
          button: "left",
        },
      }),
    ).rejects.toThrow("frame is stale");
    expect(client.workspaces.get("workspace-one")?.mouseUpCalls).toBe(1);
  });

  it("applies device state through the supervisor runtime", async () => {
    const { manager, client } = createManager();
    const viewer = await manager.attach("workspace-one", "Client");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    const result = await manager.applyDevicePreset({
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: expected(control.state),
      presetId: "pixel-7",
    });

    expect(result.state.viewport).toEqual({ width: 412, height: 839 });
    expect(result.state.devicePresetId).toBe("pixel-7");
    expect(result.state.userAgent).toContain("Pixel 7");
    const emulate = client.operations.filter(({ operation }) => operation === "emulate").at(-1);
    expect(emulate?.input).toMatchObject({
      mobile: true,
      touch: true,
      width: 412,
      height: 839,
    });
  });

  it("switches mobile and desktop behavior while preserving the current custom display", async () => {
    const { manager, client } = createManager();
    const viewer = await manager.attach("workspace-mode", "Client");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    const resized = await manager.resize({
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: expected(control.state),
      viewport: { width: 1920, height: 1200 },
    });
    const capture = await manager.capture(viewer.viewerToken, "high", null);
    const mobile = await manager.applyDevicePreset({
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: expected(resized.state),
      presetId: "pixel-7-sharp",
      preserveDisplay: true,
    });
    expect(mobile.state.viewport).toEqual({ width: 1920, height: 1200 });
    expect(mobile.state.captureScale).toBe(1);
    expect(mobile.state.viewportGeneration).toBeGreaterThan(resized.state.viewportGeneration);
    expect(mobile.state.navigationGeneration).toBe(resized.state.navigationGeneration);
    expect(
      client.operations.filter((op) => op.operation === "emulate").at(-1)?.input,
    ).toMatchObject({ width: 1920, height: 1200, captureScale: 1, mobile: true, touch: true });
    await expect(
      manager.sendInput({
        viewerToken: viewer.viewerToken,
        controlToken: control.controlToken,
        expected: expected(capture.state),
        target: capture.frame!,
        event: { kind: "key", key: "Enter" },
      }),
    ).rejects.toThrow("viewport");
    const desktop = await manager.applyDevicePreset({
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: expected(mobile.state),
      presetId: "desktop-chrome",
      preserveDisplay: true,
    });
    expect(desktop.state.viewport).toEqual({ width: 1920, height: 1200 });
    expect(desktop.state.captureScale).toBe(1);
    expect(
      client.operations.filter((op) => op.operation === "emulate").at(-1)?.input,
    ).toMatchObject({ width: 1920, height: 1200, captureScale: 1, mobile: false, touch: false });
    expect(client.operations.some((op) => ["reload", "navigate"].includes(op.operation))).toBe(
      false,
    );
  });

  it("preserves sharp capture density during a mode-only desktop switch", async () => {
    const { manager, client } = createManager();
    const viewer = await manager.attach("workspace-sharp-mode", "Client");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    const mobile = await manager.applyDevicePreset({
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: expected(control.state),
      presetId: "pixel-7-sharp",
    });
    const desktop = await manager.applyDevicePreset({
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: expected(mobile.state),
      presetId: "desktop-chrome",
      preserveDisplay: true,
    });
    expect(desktop.state.viewport).toEqual(mobile.state.viewport);
    expect(desktop.state.captureScale).toBe(2);
    expect(
      client.operations.filter((op) => op.operation === "emulate").at(-1)?.input,
    ).toMatchObject({ width: 412, height: 839, captureScale: 2, mobile: false, touch: false });
  });

  it("archives and tears down the workspace runtime", async () => {
    const { manager, client } = createManager();
    const viewer = await manager.attach("workspace-archive", "Client");
    await manager.archiveWorkspace("workspace-archive");

    expect(client.workspaces.get("workspace-archive")?.stopped).toBe(true);
    await expect(manager.capture(viewer.viewerToken, "medium", null)).rejects.toThrow(
      "invalid or expired",
    );
    await expect(manager.attach("workspace-archive", "Late client")).rejects.toThrow("archived");
  });

  it("cannot create a runtime after disconnect begins", async () => {
    let resolveValidation!: (valid: boolean) => void;
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => (validationStarted = resolve));
    const client = new FakeSupervisorClient();
    const manager = new SessionManager({
      client: client as unknown as SupervisorClient,
      validateWorkspace: async () => {
        validationStarted();
        return await new Promise<boolean>((resolve) => (resolveValidation = resolve));
      },
    });
    managers.push(manager);

    const attaching = manager.attach("workspace-one", "Late client");
    await started;
    manager.disconnect();
    resolveValidation(true);

    await expect(attaching).rejects.toThrow("manager is closed");
    expect(client.workspaces.size).toBe(0);
  });

  it("reports only workspaces with attached viewers and bounds live sessions", async () => {
    const { manager } = createManager({ maxSessions: 1 });
    expect(await manager.listOpenWorkspaceIds()).toEqual([]);
    const viewer = await manager.attach("workspace-one", "Client");
    expect(await manager.listOpenWorkspaceIds()).toEqual(["workspace-one"]);
    await manager.detach(viewer.viewerToken);
    expect(await manager.listOpenWorkspaceIds()).toEqual([]);
    await expect(manager.attach("workspace-two", "Second client")).rejects.toThrow(
      "session limit (1) reached",
    );
  });

  it("lets archive win while workspace startup is in flight", async () => {
    let releaseEnsure!: () => void;
    let markEnsureStarted!: () => void;
    const ensureStarted = new Promise<void>((resolve) => (markEnsureStarted = resolve));
    const { manager, client } = createManager();
    client.ensureStarted = markEnsureStarted;
    client.ensureGate = new Promise<void>((resolve) => (releaseEnsure = resolve));

    const attaching = manager.attach("workspace-racing", "Client");
    await ensureStarted;
    const archiving = manager.archiveWorkspace("workspace-racing");
    releaseEnsure();

    await expect(archiving).resolves.toBeUndefined();
    await expect(attaching).rejects.toThrow("archived");
    expect(client.workspaces.get("workspace-racing")?.stopped).toBe(true);
    await expect(manager.attach("workspace-racing", "Late client")).rejects.toThrow("archived");
  });

  it("archives an ensured runtime when session initialization fails", async () => {
    const { manager, client } = createManager();
    client.failOperation = "identity";

    await expect(manager.attach("workspace-failed", "Client")).rejects.toThrow("Failed identity");
    expect(client.archiveCalls).toEqual(["workspace-failed"]);
    expect(client.workspaces.get("workspace-failed")?.stopped).toBe(true);
  });
});
