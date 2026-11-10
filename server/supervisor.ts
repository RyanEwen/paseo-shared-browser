/**
 * The runtime supervisor: one active plugin bridge lease, one runtime per workspace with a
 * serialized operation tail, and the browser session policy over them. Agent tickets and
 * requests live in `supervisor-agents.ts`; the socket server and startup lock live in
 * `supervisor-server.ts`.
 */
import {
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  closeBrowserTabRpc,
  endBrowserGestureRpc,
  MAX_BROWSER_PAGE_TARGETS,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "../shared/browser";
import { browserDisplayDemandRpc } from "../shared/browser-display-demand";
import { readBrowserVideoRpc } from "../shared/browser-video";
import type { AgentBindingStore } from "./agent-binding-store";
import { type BrowserRuntimeMutationGuard, SessionManager } from "./browser-policy";
import { CdpUnknownOutcomeError } from "./cdp";
import { withLegacyEmptyWorkspaceHint } from "./empty-workspace";
import {
  type BridgeLease,
  DEFAULT_BRIDGE_HEARTBEAT_MS,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  DEFAULT_ORPHAN_GRACE_MS,
  type JsonValue,
  type RuntimeDescriptor,
  RuntimeLostError,
  RuntimeProtocolError,
  type RuntimeRequest,
  type RuntimeResult,
} from "./runtime-protocol";
import { AgentAuthority, AgentRuntimeOperation } from "./supervisor-agents";
import { asObject, requireText, stateFromPolicyResult } from "./supervisor-input";

const MAX_SUPERVISOR_WORKSPACES = 8;
type SupervisorTimer = NodeJS.Timeout;

export interface RuntimeInstance {
  runtimeId: string;
}

/** Per-launch options that must not outlive the launch that received them. */
export interface RuntimeLaunchOptions {
  /** Recheck the explicit opener after launch preparation, immediately before native publication. */
  beforeLaunch?: () => void;
}

export interface RuntimeOwner<Runtime extends RuntimeInstance = RuntimeInstance> {
  create(workspaceId: string, launch?: RuntimeLaunchOptions): Promise<Runtime>;
  /** Invoke beforeMutation after awaited preparation and immediately before publishing a guarded mutation. */
  request(
    runtime: Runtime,
    operation: string,
    input: JsonValue,
    beforeMutation?: () => void,
  ): Promise<JsonValue>;
  stop(runtime: Runtime): Promise<void>;
}

export interface RuntimeSupervisorOptions<Runtime extends RuntimeInstance> {
  owner: RuntimeOwner<Runtime>;
  agentBindingStore?: AgentBindingStore;
  now?: () => number;
  orphanGraceMs?: number;
  heartbeatIntervalMs?: number;
  bridgeTimeoutMs?: number;
  maxWorkspaces?: number;
  schedule?: (callback: () => void, delayMs: number) => SupervisorTimer;
  cancel?: (timer: SupervisorTimer) => void;
}

interface WorkspaceEntry<Runtime extends RuntimeInstance> {
  createdAt: number;
  lost?: boolean;
  runtime: Runtime;
}

interface ActiveBridge {
  bridgeId: string;
  epoch: number;
  expiresAt: number;
  ready: Promise<void>;
}

export class RuntimeSupervisor<Runtime extends RuntimeInstance = RuntimeInstance> {
  private readonly owner: RuntimeOwner<Runtime>;
  private readonly agentBindingStore: AgentBindingStore | undefined;
  private readonly now: () => number;
  private readonly orphanGraceMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly bridgeTimeoutMs: number;
  private readonly maxWorkspaces: number;
  private readonly schedule: (callback: () => void, delayMs: number) => SupervisorTimer;
  private readonly cancel: (timer: SupervisorTimer) => void;
  private readonly workspaces = new Map<string, WorkspaceEntry<Runtime>>();
  private readonly creations = new Map<string, Promise<WorkspaceEntry<Runtime>>>();
  private readonly workspaceOperations = new Map<string, Promise<void>>();
  private readonly archived = new Set<string>();
  private readonly browserPolicy: SessionManager;
  private readonly agents: AgentAuthority;
  private activeBridge: ActiveBridge | null = null;
  private nextEpoch = 0;
  private bridgeTimer: SupervisorTimer | null = null;
  private orphanTimer: SupervisorTimer | null = null;
  private stopping: Promise<void> | null = null;

  constructor(options: RuntimeSupervisorOptions<Runtime>) {
    this.owner = options.owner;
    this.agentBindingStore = options.agentBindingStore;
    this.now = options.now ?? Date.now;
    this.orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_BRIDGE_HEARTBEAT_MS;
    this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    this.maxWorkspaces = options.maxWorkspaces ?? MAX_SUPERVISOR_WORKSPACES;
    if (!Number.isInteger(this.maxWorkspaces) || this.maxWorkspaces < 1)
      throw new Error("maxWorkspaces must be a positive integer");
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.browserPolicy = new SessionManager({
      validateWorkspace: async (workspaceId) => !this.archived.has(workspaceId),
      client: {
        connect: async () => ({ epoch: this.nextEpoch }),
        ensureWorkspace: (workspaceId, options) =>
          this.ensureWorkspaceLocal(workspaceId, options?.replaceLost === true),
        requestWorkspace: (workspaceId, operation, input, guard) =>
          this.requestWorkspaceLocal(workspaceId, operation, input, guard),
        archiveWorkspace: (workspaceId) => this.archiveWorkspaceLocal(workspaceId).then(() => {}),
        closeWorkspace: (workspaceId, runtimeId) =>
          this.closeWorkspaceLocal(workspaceId, runtimeId),
        closeLastTab: (workspaceId, runtimeId, tabId, onClosing) =>
          this.closeWorkspaceLocal(workspaceId, runtimeId, { tabId, onClosing }),
        disconnect: () => {},
      },
      now: this.now,
      // Each workspace owns one Chromium runtime but may have several
      // independent page sessions with separate viewers and control leases.
      maxSessions: this.maxWorkspaces * MAX_BROWSER_PAGE_TARGETS,
    });
    this.agents = new AgentAuthority(
      {
        now: () => this.now(),
        assertActiveBridge: (bridgeId, epoch) => {
          this.assertActiveBridge(bridgeId, epoch);
        },
        activeBridge: () => this.activeBridge,
        assertPluginAvailable: () => {
          if (!this.activeBridge || this.activeBridge.expiresAt <= this.now())
            throw new RuntimeProtocolError("BRIDGE_FENCED", "Shared Browser plugin is unavailable");
        },
        assertWorkspaceOpen: (workspaceId) => {
          if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
        },
      },
      this.browserPolicy,
      options.agentBindingStore,
    );
  }

  claimBridge(bridgeId: string, takeover = false): BridgeLease {
    const active = this.activeBridge;
    if (active && active.expiresAt > this.now() && active.bridgeId !== bridgeId && !takeover)
      throw new RuntimeProtocolError(
        "BRIDGE_FENCED",
        "A Shared Browser plugin bridge is already active; explicit administrative takeover is required",
      );
    this.nextEpoch += 1;
    const pending = [...this.workspaceOperations.values()];
    this.browserPolicy.setBridgeEpoch(this.nextEpoch);
    const bridge: ActiveBridge = {
      bridgeId,
      epoch: this.nextEpoch,
      expiresAt: this.now() + this.bridgeTimeoutMs,
      ready: Promise.allSettled(pending).then(() => undefined),
    };
    this.activeBridge = bridge;
    this.cancelOrphanStop();
    this.armBridgeTimeout(bridge);
    return this.bridgeLease(bridge);
  }

  heartbeat(bridgeId: string, epoch: number): BridgeLease {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    bridge.expiresAt = this.now() + this.bridgeTimeoutMs;
    this.armBridgeTimeout(bridge);
    return this.bridgeLease(bridge);
  }

  /** Read-only admission for the reserved lane; dispatch still verifies the lease again. */
  isCurrentBridgeLease(bridgeId: string, epoch: number): boolean {
    const bridge = this.activeBridge;
    return Boolean(
      bridge &&
        bridge.bridgeId === bridgeId &&
        bridge.epoch === epoch &&
        bridge.expiresAt > this.now(),
    );
  }

  bridgeDisconnected(bridgeId: string, epoch: number): void {
    if (this.activeBridge?.bridgeId !== bridgeId || this.activeBridge.epoch !== epoch) return;
    this.activeBridge = null;
    this.clearBridgeTimer();
    this.armOrphanStop();
  }

  async ensureWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
  ): Promise<RuntimeDescriptor> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const descriptor = await this.ensureWorkspaceLocal(workspaceId);
    this.assertActiveBridge(bridgeId, epoch);
    return descriptor;
  }

  async requestWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const result = await this.requestWorkspaceLocal(workspaceId, operation, input);
    this.assertActiveBridge(bridgeId, epoch);
    return result;
  }

  async archiveWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
  ): Promise<{ archived: true }> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    this.archived.add(workspaceId);
    await bridge.ready;
    const result = await this.archiveWorkspaceLocal(workspaceId);
    this.assertActiveBridge(bridgeId, epoch);
    return result;
  }

  async closeWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
    runtimeId: string,
  ): Promise<void> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    await this.closeWorkspaceLocal(workspaceId, runtimeId);
    this.assertActiveBridge(bridgeId, epoch);
  }

  private ensureWorkspaceLocal(
    workspaceId: string,
    replaceLost = false,
  ): Promise<RuntimeDescriptor> {
    return this.runWorkspaceOperation(workspaceId, async () => {
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      let entry = this.workspaces.get(workspaceId);
      if (entry?.lost) {
        // Only the in-process explicit human attach carries this authority; protocol
        // workspace.ensure and implicit agent paths observe the loss instead.
        if (!replaceLost)
          throw new RuntimeProtocolError(
            "RUNTIME_LOST",
            "Workspace runtime was lost; reconnect explicitly to replace it",
          );
        // Fail closed: release the dead runtime before any replacement exists.
        // Stop first: if the daemon's exit cannot be confirmed the entry stays lost and
        // no replacement is created behind a possibly live session.
        await this.owner.stop(entry.runtime);
        this.workspaces.delete(workspaceId);
        entry = undefined;
      }
      if (!entry) {
        let creation = this.creations.get(workspaceId);
        if (!creation) {
          if (this.workspaces.size + this.creations.size >= this.maxWorkspaces) {
            throw new RuntimeProtocolError(
              "RUNTIME_FAILURE",
              `Runtime supervisor workspace limit (${this.maxWorkspaces}) reached`,
            );
          }
          creation = this.createWorkspace(workspaceId);
          this.creations.set(workspaceId, creation);
        }
        entry = await creation;
      }
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      return {
        workspaceId,
        runtimeId: entry.runtime.runtimeId,
        createdAt: entry.createdAt,
      };
    });
  }

  private requestWorkspaceLocal(
    workspaceId: string,
    operation: string,
    input: JsonValue,
    guard?: BrowserRuntimeMutationGuard,
  ): Promise<JsonValue> {
    // Capture the caller before entering the workspace tail. Revocation must
    // fence queued native publication, not only the initial ticket lookup.
    const agent = this.agents.currentPublication();
    const execute = async () => {
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      const entry = this.workspaces.get(workspaceId);
      if (!entry)
        throw new RuntimeProtocolError(
          "WORKSPACE_NOT_FOUND",
          `Workspace runtime not found: ${workspaceId}`,
        );
      const publication = agent
        ? new AgentRuntimeOperation(this.agents, agent, operation, input, entry.runtime)
        : null;
      publication?.admit();
      try {
        const beforeMutation = () => {
          if (guard) {
            if (
              this.workspaces.get(workspaceId) !== entry ||
              entry.runtime.runtimeId !== guard.runtimeId
            )
              throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser runtime was replaced");
            guard.assertCurrent();
          }
          publication?.assertPublication();
        };
        if (guard) beforeMutation();
        const result = await this.owner.request(
          entry.runtime,
          operation,
          input,
          guard ? beforeMutation : undefined,
        );
        publication?.settle();
        if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
        if (this.workspaces.get(workspaceId) !== entry)
          throw new RuntimeProtocolError("RUNTIME_FAILURE", "Video runtime was replaced");
        return result;
      } catch (error) {
        if (error instanceof RuntimeProtocolError) throw error;
        if (error instanceof RuntimeLostError) {
          entry.lost = true;
          throw new RuntimeProtocolError("RUNTIME_LOST", error.message);
        }
        if (error instanceof CdpUnknownOutcomeError)
          throw new RuntimeProtocolError(
            "UNKNOWN_OUTCOME",
            "Browser mutation outcome is unknown; observe the browser before sending another mutation. If you opened print, inspect the tab list for Print preview and select it explicitly. Do not repeat the print action.",
          );
        throw new RuntimeProtocolError(
          "RUNTIME_FAILURE",
          `Workspace runtime ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        publication?.finish();
      }
    };
    return operation === "video.read"
      ? execute()
      : this.runWorkspaceOperation(workspaceId, execute);
  }

  private archiveWorkspaceLocal(workspaceId: string): Promise<{ archived: true }> {
    this.archived.add(workspaceId);
    this.agentBindingStore?.revokeWorkspace(workspaceId);
    return this.runWorkspaceOperation(workspaceId, async () => {
      const creation = this.creations.get(workspaceId);
      if (creation) await creation.catch(() => undefined);
      const entry = this.workspaces.get(workspaceId);
      if (entry) {
        this.workspaces.delete(workspaceId);
        await this.owner.stop(entry.runtime);
      }
      return { archived: true };
    });
  }

  /** Stop the exact runtime confirmed by the viewer while keeping the workspace reusable. */
  private closeWorkspaceLocal(
    workspaceId: string,
    runtimeId: string,
    finalTab?: { tabId: string; onClosing(): void },
  ): Promise<void> {
    const agent = this.agents.currentPublication();
    return this.runWorkspaceOperation(workspaceId, async () => {
      const entry = this.workspaces.get(workspaceId);
      if (!entry || entry.runtime.runtimeId !== runtimeId)
        throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser runtime was replaced");
      if (finalTab) {
        // This check and stop share the same tail as tab creation/removal.
        // Count every real page target, including transient print previews.
        const targets = await this.owner.request(entry.runtime, "tabs.list", null);
        const sole = Array.isArray(targets) && targets.length === 1 ? targets[0] : null;
        if (
          !sole ||
          typeof sole !== "object" ||
          Array.isArray(sole) ||
          sole.targetId !== finalTab.tabId
        )
          throw new RuntimeProtocolError(
            "INVALID_REQUEST",
            "Browser tabs changed; refresh the tab list and confirm closing again",
          );
      }
      if (agent) this.agents.assertAgentPublication(agent);
      finalTab?.onClosing();
      this.agents.invalidateAgentObservations(workspaceId);
      this.agents.revokeAgentControl(workspaceId);
      await this.owner.stop(entry.runtime);
      if (this.workspaces.get(workspaceId) === entry) this.workspaces.delete(workspaceId);
    });
  }

  private async requestBrowser(
    bridgeId: string,
    epoch: number,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const data = asObject(input);
    let result: unknown;
    switch (operation) {
      case "attach":
        result = await this.browserPolicy.attach(
          requireText(data, "workspaceId"),
          requireText(data, "viewerLabel"),
          typeof data.tabId === "string" ? data.tabId : undefined,
          // Only this bridge-authorised human attach may replace a lost runtime.
          { replaceLost: true },
        );
        break;
      case "detach":
        result = await this.browserPolicy.detach(requireText(data, "viewerToken"));
        break;
      case "status":
        result = await this.browserPolicy.status(requireText(data, "viewerToken"));
        break;
      case "video.read":
        result = await this.browserPolicy.readVideo(readBrowserVideoRpc.input.parse(data));
        break;
      case "capture": {
        const capture = captureBrowserRpc.input.parse(data);
        result = await this.browserPolicy.capture(
          capture.viewerToken,
          capture.quality,
          capture.knownFrameId,
        );
        break;
      }
      case "display-demand":
        result = await this.browserPolicy.reportDisplayDemand(
          browserDisplayDemandRpc.input.parse(data),
        );
        break;
      case "capture.density":
        result = await this.browserPolicy.setCaptureDensity(setCaptureDensityRpc.input.parse(data));
        break;
      case "acquire-control": {
        result = await this.browserPolicy.acquireControl(
          requireText(data, "viewerToken"),
          data.takeover === true,
        );
        const state = stateFromPolicyResult(result);
        if (data.takeover === true) this.agents.revokeAgentControl(state.workspaceId, state.tabId);
        break;
      }
      case "release-control":
        result = await this.browserPolicy.releaseControl(
          requireText(data, "viewerToken"),
          requireText(data, "controlToken"),
        );
        break;
      case "navigate":
        result = await this.browserPolicy.navigate(data as never);
        this.agents.invalidateAgentObservationsForState(result);
        break;
      case "print":
        result = await this.browserPolicy.print(data as never);
        this.agents.invalidateAgentObservationsForState(result);
        break;
      case "viewport":
        result = await this.browserPolicy.resize(data as never);
        this.agents.invalidateAgentObservationsForState(result);
        break;
      case "device":
        result = await this.browserPolicy.applyDevicePreset(data as never);
        this.agents.invalidateAgentObservationsForState(result);
        break;
      case "input":
        result = await this.browserPolicy.sendInput(data as never);
        this.agents.invalidateAgentObservationsForState(result);
        break;
      case "gesture.begin":
        result = await this.browserPolicy.beginGesture(beginBrowserGestureRpc.input.parse(data));
        break;
      case "gesture.update":
        result = await this.browserPolicy.updateGesture(updateBrowserGestureRpc.input.parse(data));
        this.agents.invalidateAgentObservationsForState(result);
        break;
      case "gesture.end":
        result = await this.browserPolicy.endGesture(endBrowserGestureRpc.input.parse(data));
        this.agents.invalidateAgentObservationsForState(result);
        break;
      case "list":
        result = {
          workspaceIds: await this.browserPolicy.listOpenWorkspaceIds(),
        };
        break;
      case "tabs.list":
        result = await this.browserPolicy.listTabsForViewer(requireText(data, "viewerToken"));
        break;
      case "tabs.create":
        result = await this.browserPolicy.createTab(requireText(data, "viewerToken"));
        break;
      case "tabs.close":
        result = await this.browserPolicy.closeTab(closeBrowserTabRpc.input.parse(data));
        break;
      case "close":
        result = await this.browserPolicy.closeBrowser(closeBrowserRpc.input.parse(data));
        break;
      case "reopen":
        result = await this.browserPolicy.reopenBrowser(requireText(data, "workspaceId"));
        break;
      case "archive": {
        const workspaceId = requireText(data, "workspaceId");
        await this.agents.revokeWorkspace(workspaceId);
        await this.browserPolicy.archiveWorkspace(workspaceId);
        result = { archived: true };
        break;
      }
      default:
        throw new RuntimeProtocolError(
          "INVALID_REQUEST",
          `Unknown browser operation: ${operation}`,
        );
    }
    this.assertActiveBridge(bridgeId, epoch);
    return result as JsonValue;
  }

  async stopAll(): Promise<void> {
    if (this.stopping) return this.stopping;
    const operation = (async () => {
      this.activeBridge = null;
      this.clearBridgeTimer();
      this.cancelOrphanStop();
      this.browserPolicy.reset();
      this.agents.clearLeases();
      await Promise.allSettled(this.workspaceOperations.values());
      await Promise.allSettled(this.creations.values());
      const entries = [...this.workspaces.values()];
      this.workspaces.clear();
      const results = await Promise.allSettled(
        entries.map((entry) => this.owner.stop(entry.runtime)),
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "One or more workspace runtimes failed to stop",
        );
    })();
    this.stopping = operation;
    try {
      await operation;
    } finally {
      if (this.stopping === operation) this.stopping = null;
    }
  }

  async dispatch(request: RuntimeRequest): Promise<RuntimeResult> {
    switch (request.method) {
      case "bridge.claim":
        return this.claimBridge(request.bridgeId, request.takeover);
      case "bridge.heartbeat":
        return this.heartbeat(request.bridgeId, request.epoch);
      case "workspace.ensure":
        return this.ensureWorkspace(request.bridgeId, request.epoch, request.workspaceId);
      case "workspace.request":
        return this.requestWorkspace(
          request.bridgeId,
          request.epoch,
          request.workspaceId,
          request.operation,
          request.input,
        );
      case "workspace.archive":
        return this.archiveWorkspace(request.bridgeId, request.epoch, request.workspaceId);
      case "workspace.close":
        return this.closeWorkspace(
          request.bridgeId,
          request.epoch,
          request.workspaceId,
          request.runtimeId,
        ).then(() => ({ closed: true }));
      case "browser.request":
        return this.requestBrowser(
          request.bridgeId,
          request.epoch,
          request.operation,
          request.input,
        );
      case "ticket.issue":
        return this.agents.issueAgentTicket(request.bridgeId, request.epoch, request.ticket);
      case "ticket.bind":
        return this.agents.bindAgentTicket(
          request.bridgeId,
          request.epoch,
          request.ticket,
          request.agentId,
          request.workspaceId,
        );
      case "agent.revoke":
        return this.agents.revokeAgent(request.bridgeId, request.epoch, request.agentId);
      case "agent.request": {
        const reply = await this.agents.requestAgent(
          request.ticket,
          request.operation,
          request.input,
        );
        return request.legacyAdapter ? withLegacyEmptyWorkspaceHint(reply) : reply;
      }
    }
  }

  private runWorkspaceOperation<Result>(
    workspaceId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.workspaceOperations.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceOperations.set(workspaceId, tail);
    void tail.finally(() => {
      if (this.workspaceOperations.get(workspaceId) === tail)
        this.workspaceOperations.delete(workspaceId);
    });
    return result;
  }

  private async createWorkspace(workspaceId: string): Promise<WorkspaceEntry<Runtime>> {
    try {
      const runtime = await this.owner.create(workspaceId);
      const entry = { runtime, createdAt: this.now() };
      if (this.archived.has(workspaceId)) {
        await this.owner.stop(runtime);
        this.workspaceArchived(workspaceId);
      }
      this.workspaces.set(workspaceId, entry);
      return entry;
    } finally {
      this.creations.delete(workspaceId);
    }
  }

  private assertActiveBridge(bridgeId: string, epoch: number): ActiveBridge {
    const bridge = this.activeBridge;
    if (
      !bridge ||
      bridge.bridgeId !== bridgeId ||
      bridge.epoch !== epoch ||
      bridge.expiresAt <= this.now()
    ) {
      throw new RuntimeProtocolError("BRIDGE_FENCED", "Plugin bridge lease is no longer active");
    }
    return bridge;
  }

  private bridgeLease(bridge: ActiveBridge): BridgeLease {
    return {
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      expiresAt: bridge.expiresAt,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    };
  }

  private workspaceArchived(workspaceId: string): never {
    throw new RuntimeProtocolError("WORKSPACE_ARCHIVED", `Workspace is archived: ${workspaceId}`);
  }

  private armBridgeTimeout(bridge: ActiveBridge): void {
    this.clearBridgeTimer();
    const delay = Math.max(0, bridge.expiresAt - this.now());
    this.bridgeTimer = this.schedule(() => {
      if (this.activeBridge !== bridge) return;
      if (bridge.expiresAt > this.now()) {
        this.armBridgeTimeout(bridge);
        return;
      }
      this.activeBridge = null;
      this.bridgeTimer = null;
      this.armOrphanStop();
    }, delay);
  }

  private clearBridgeTimer(): void {
    if (!this.bridgeTimer) return;
    this.cancel(this.bridgeTimer);
    this.bridgeTimer = null;
  }

  private armOrphanStop(): void {
    this.cancelOrphanStop();
    this.orphanTimer = this.schedule(() => {
      this.orphanTimer = null;
      if (!this.activeBridge) void this.stopAll().catch(() => undefined);
    }, this.orphanGraceMs);
  }

  private cancelOrphanStop(): void {
    if (!this.orphanTimer) return;
    this.cancel(this.orphanTimer);
    this.orphanTimer = null;
  }
}
