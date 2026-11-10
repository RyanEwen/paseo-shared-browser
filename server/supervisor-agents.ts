import { AsyncLocalStorage } from "node:async_hooks";
import type { ZodType } from "zod";
import type { BrowserFrame, BrowserState } from "../shared/browser";
import {
  applyDevicePresetRpc,
  browserTabCloseScopeSchema,
  navigateBrowserRpc,
  printBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
} from "../shared/browser";
import { DEFAULT_CAPTURE_QUALITY } from "../shared/capture-settings";
import type { AgentBindingStore } from "./agent-binding-store";
import { FirstPageNavigationError, type SessionManager } from "./browser-policy";
import { AGENT_VIEWER_POLICY } from "./browser-viewer-policy";
import {
  isJsonObject,
  type JsonValue,
  jsonObjectOrEmpty,
  RuntimeProtocolError,
} from "./runtime-protocol";
import { asObject, requireText, stateFromPolicyResult } from "./supervisor-input";

const AGENT_TICKET_TTL_MS = 10 * 60_000;
const MAX_UNBOUND_AGENT_TICKETS = 256;

/**
 * Agent requests that observe, attach or acquire control. They construct shared session state
 * whose late viewer is removed explicitly, so they run without a native publication fence.
 */
const UNFENCED_AGENT_OPERATIONS = new Set(["status", "capture", "acquire-control", "tabs.list"]);

/** The runtime identity an agent publication fence pairs with; only identity matters here. */
interface PublishedRuntime {
  runtimeId: string;
}

interface AgentBinding {
  issuedAt: number;
  ticket: string;
  agentId: string | null;
  workspaceId: string | null;
  tabId: string | null;
  selectionRevision: number;
  viewerToken: string | null;
  controlToken: string | null;
  lastState: BrowserState | null;
  lastFrame: BrowserFrame | null;
}

/** Pair cleanup with a down acknowledged in this exact request/runtime. */
export interface AgentPublicationContext {
  binding: AgentBinding;
  selectionRevision: number;
  keys: Map<string, PublishedRuntime>;
  buttons: Map<string, PublishedRuntime>;
  channels: Map<string, PublishedRuntime>;
}

/** The fence every controlled agent mutation sends with its request. */
interface ExpectedAgentState {
  sessionId: string;
  navigationGeneration: number;
  viewportGeneration: number;
  runtimeId: string;
  bridgeEpoch: number;
}

/** Everything a controlled mutation needs: held credentials, its fence and the raw input. */
interface ControlledAgentRequest {
  binding: AgentBinding;
  viewerToken: string;
  controlToken: string;
  expected: ExpectedAgentState;
  data: Record<string, JsonValue>;
  input: JsonValue;
}

type AgentOperation = (
  binding: AgentBinding,
  data: Record<string, JsonValue>,
) => Promise<JsonValue>;

type ControlledAgentOperation = (
  request: ControlledAgentRequest,
) => Promise<{ state: BrowserState }>;

/** The supervisor state agent authority reads but does not own. */
export interface AgentAuthorityHost {
  now(): number;
  /** Refuse unless this exact bridge lease is active. */
  assertActiveBridge(bridgeId: string, epoch: number): void;
  /** The currently active bridge, if any. */
  activeBridge(): { bridgeId: string; epoch: number } | null;
  /** Refuse while no unexpired plugin bridge is connected. */
  assertPluginAvailable(): void;
  /** Refuse an archived workspace. */
  assertWorkspaceOpen(workspaceId: string): void;
}

/**
 * Agent tickets, their bindings to agents and workspaces, and every agent browser request.
 *
 * Each binding owns at most one viewer and one control lease. Revocation removes credentials
 * synchronously; every awaited step rechecks that its binding is still the registered one and
 * that the agent's tab selection has not changed, so a revoked or reselected agent can never
 * publish a late mutation.
 */
export class AgentAuthority {
  private readonly publicationContext = new AsyncLocalStorage<AgentPublicationContext>();
  private readonly bindings = new Map<string, AgentBinding>();
  private readonly tickets = new Map<string, Set<string>>();

  /**
   * @param host Supervisor bridge and workspace state.
   * @param browserPolicy The supervisor's session policy every agent request goes through.
   * @param bindingStore Durable ticket registrations for explicit recovery, when configured.
   */
  constructor(
    private readonly host: AgentAuthorityHost,
    private readonly browserPolicy: SessionManager,
    private readonly bindingStore: AgentBindingStore | undefined,
  ) {}

  /** The agent request whose native publication the current async context belongs to, if any. */
  currentPublication(): AgentPublicationContext | undefined {
    return this.publicationContext.getStore();
  }

  /** Drop every agent's leases and observations when the supervisor stops; tickets survive. */
  clearLeases(): void {
    for (const binding of this.bindings.values()) {
      binding.viewerToken = null;
      binding.controlToken = null;
      binding.lastState = null;
      binding.lastFrame = null;
    }
  }

  /** Register an unbound ticket for a trusted agent launch, bounded in count and lifetime. */
  issueAgentTicket(bridgeId: string, epoch: number, ticket: string): JsonValue {
    this.host.assertActiveBridge(bridgeId, epoch);
    this.expireUnboundTickets();
    assertOpaqueToken(ticket, "ticket");
    if (this.bindings.has(ticket))
      throw new RuntimeProtocolError("INVALID_REQUEST", "Agent ticket is already registered");
    if (
      [...this.bindings.values()].filter((binding) => binding.agentId === null).length >=
      MAX_UNBOUND_AGENT_TICKETS
    )
      throw new RuntimeProtocolError(
        "RUNTIME_BUSY",
        "Shared Browser ticket capacity is temporarily full",
      );
    this.bindings.set(ticket, {
      ticket,
      issuedAt: this.host.now(),
      agentId: null,
      workspaceId: null,
      tabId: null,
      selectionRevision: 0,
      viewerToken: null,
      controlToken: null,
      lastState: null,
      lastFrame: null,
    });
    return { issued: true };
  }

  /**
   * Bind a ticket to one agent and workspace, restoring a saved tab selection when a trusted
   * launch resumes. A ticket can never be rebound to a different identity.
   */
  bindAgentTicket(
    bridgeId: string,
    epoch: number,
    ticket: string,
    agentId: string,
    workspaceId: string,
  ): JsonValue {
    this.host.assertActiveBridge(bridgeId, epoch);
    this.expireUnboundTickets();
    const binding = this.bindings.get(ticket);
    if (!binding) throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Unknown agent ticket");
    this.host.assertWorkspaceOpen(workspaceId);
    if (binding.agentId && (binding.agentId !== agentId || binding.workspaceId !== workspaceId))
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket is already bound");
    const saved = this.bindingStore?.get(ticket);
    if (saved && (saved.agentId !== agentId || saved.workspaceId !== workspaceId)) {
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket is already bound");
    }
    // A resumed trusted launch renews identity without forgetting its saved tab.
    if (!binding.agentId && saved) binding.tabId = saved.tabId;
    this.bindingStore?.set(ticket, {
      agentId,
      workspaceId,
      tabId: binding.tabId,
    });
    binding.agentId = agentId;
    binding.workspaceId = workspaceId;
    let tickets = this.tickets.get(agentId);
    if (!tickets) {
      tickets = new Set();
      this.tickets.set(agentId, tickets);
    }
    tickets.add(ticket);
    return { bound: true };
  }

  /** Remove every ticket an agent holds, durably, then detach their viewers. */
  async revokeAgent(bridgeId: string, epoch: number, agentId: string): Promise<JsonValue> {
    this.host.assertActiveBridge(bridgeId, epoch);
    this.bindingStore?.revokeAgent(agentId);
    const tickets = this.tickets.get(agentId);
    if (!tickets) return { revoked: 0 };
    const viewers: string[] = [];
    let revoked = 0;
    // Remove every credential synchronously before waiting on viewer cleanup.
    for (const ticket of tickets) {
      const binding = this.bindings.get(ticket);
      if (!binding) continue;
      this.bindings.delete(ticket);
      revoked += 1;
      if (binding.viewerToken) viewers.push(binding.viewerToken);
    }
    this.tickets.delete(agentId);
    await Promise.allSettled(viewers.map((viewerToken) => this.browserPolicy.detach(viewerToken)));
    return { revoked };
  }

  /** Carry exact ticket identity through awaited policy and native publication. */
  async requestAgent(ticket: string, operation: string, input: JsonValue): Promise<JsonValue> {
    this.host.assertPluginAvailable();
    if (operation === "reconnect" || operation === "open") {
      return this.agentReply(await this.reconnectAgent(ticket, operation === "open"));
    }
    const binding = this.requireAgentBinding(ticket);
    const execute = async () =>
      this.agentReply(await this.executeAgentRequest(binding, operation, input));
    // Only actionable requests carry a native publication fence.
    if (UNFENCED_AGENT_OPERATIONS.has(operation)) {
      return execute();
    }
    return this.publicationContext.run(
      {
        binding,
        selectionRevision: binding.selectionRevision,
        keys: new Map(),
        buttons: new Map(),
        channels: new Map(),
      },
      execute,
    );
  }

  /** Report the enforcing runtime's effective policy even to an already-running MCP process. */
  private agentReply(result: JsonValue): JsonValue {
    const reply = asObject(result);
    const agentPolicy = { ...AGENT_VIEWER_POLICY, humanTakeover: "immediate" };
    const state = reply.state;
    return {
      ...reply,
      agentPolicy,
      ...(isJsonObject(state)
        ? {
            state: {
              ...state,
              agentPolicy,
              ...(typeof reply.frameExpiresAt === "string"
                ? { frameExpiresAt: reply.frameExpiresAt }
                : {}),
            },
          }
        : {}),
    };
  }

  /** Explicit recovery never replays inputs or inherits a control lease/frame. */
  private async reconnectAgent(ticket: string, openBrowser: boolean): Promise<JsonValue> {
    this.host.assertPluginAvailable();
    let binding = this.bindings.get(ticket);
    if (!binding?.agentId || !binding.workspaceId) {
      const saved = this.bindingStore?.get(ticket);
      if (!saved) {
        throw new RuntimeProtocolError(
          "AUTHENTICATION_FAILED",
          "Agent ticket is invalid or unbound and has no recovery registration. Resume through a trusted launch or create a fresh agent.",
        );
      }
      const bridge = this.host.activeBridge()!;
      if (!binding) this.issueAgentTicket(bridge.bridgeId, bridge.epoch, ticket);
      this.bindAgentTicket(bridge.bridgeId, bridge.epoch, ticket, saved.agentId, saved.workspaceId);
      binding = this.requireAgentBinding(ticket);
      binding.tabId = saved.tabId;
      this.saveAgentSelection(binding);
    }
    this.assertAgentBindingCurrent(binding);
    const viewerToken = binding.viewerToken;
    // Fence any outstanding input before asynchronous viewer cleanup.
    binding.selectionRevision += 1;
    binding.viewerToken = null;
    binding.controlToken = null;
    binding.lastFrame = null;
    binding.lastState = null;
    if (viewerToken) await this.browserPolicy.detach(viewerToken);
    this.assertAgentBindingCurrent(binding);
    if (openBrowser) {
      await this.browserPolicy.reopenBrowser(binding.workspaceId!);
      this.assertAgentBindingCurrent(binding);
      // Explicit reopen may create a new Chromium runtime whose tab IDs are different.
      // Preserve a surviving selection, otherwise attach to its new launch page.
      if (
        binding.tabId &&
        !(await this.browserPolicy.listTabs(binding.workspaceId!)).tabs.some(
          (tab) => tab.id === binding.tabId,
        )
      ) {
        this.assertAgentBindingCurrent(binding);
        binding.tabId = null;
        this.saveAgentSelection(binding);
      }
    }
    return (await this.requestAgentObservation(binding, "status", {})) as unknown as JsonValue;
  }

  /**
   * Operations that observe or select tabs. They manage their own viewer recovery and run
   * outside the controlled-mutation error handling below.
   */
  private readonly selectionOperations = new Map<string, AgentOperation>([
    ["status", (binding, data) => this.observe(binding, "status", data)],
    ["capture", (binding, data) => this.observe(binding, "capture", data)],
    ["dom.snapshot", (binding) => this.domSnapshot(binding)],
    ["tabs.list", (binding) => this.listAgentTabs(binding)],
    ["tabs.select", (binding, data) => this.selectRequestedTab(binding, data)],
    ["tabs.create", (binding) => this.createAgentTab(binding)],
    ["tabs.close", (binding, data) => this.closeAgentTab(binding, data)],
  ]);

  /** Mutations that require held control and a current observation of the selected tab. */
  private readonly controlledOperations = new Map<string, ControlledAgentOperation>([
    [
      "dom.action",
      ({ viewerToken, controlToken, input }) =>
        this.browserPolicy.domOperation(viewerToken, controlToken, "dom.action", input),
    ],
    [
      "dom.evaluate",
      ({ viewerToken, controlToken, input }) =>
        this.browserPolicy.domOperation(viewerToken, controlToken, "dom.evaluate", input),
    ],
    [
      "print",
      ({ viewerToken, controlToken, expected }) =>
        this.browserPolicy.print(
          parseAgentInput(printBrowserRpc.input, { viewerToken, controlToken, expected }),
        ),
    ],
    [
      "navigate",
      ({ viewerToken, controlToken, expected, data }) =>
        this.browserPolicy.navigate(
          parseAgentInput(navigateBrowserRpc.input, {
            viewerToken,
            controlToken,
            expected,
            action: data.action,
          }),
        ),
    ],
    [
      "viewport",
      ({ viewerToken, controlToken, expected, data }) => {
        const resize = parseAgentInput(resizeBrowserRpc.input, {
          viewerToken,
          controlToken,
          expected,
          viewport: data.viewport,
        });
        // The fork keeps the shared viewport range so its agent device and
        // high-resolution capture workflows remain available. Schema validation
        // still rejects out-of-range requests before native mutation.
        return this.browserPolicy.resize(resize);
      },
    ],
    [
      "device",
      ({ viewerToken, controlToken, expected, data }) =>
        this.browserPolicy.applyDevicePreset(
          parseAgentInput(applyDevicePresetRpc.input, {
            viewerToken,
            controlToken,
            expected,
            presetId: data.presetId,
          }),
        ),
    ],
    ["input", (request) => this.sendAgentInput(request)],
  ]);

  /**
   * Run one admitted agent operation against its binding.
   *
   * Selection operations run directly. Control acquisition, release and every controlled
   * mutation share the error handling that follows a first page or forgets observations after
   * an unknown outcome.
   */
  private async executeAgentRequest(
    binding: AgentBinding,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    this.assertAgentBindingCurrent(binding);
    const data = asObject(input);
    const selectionOperation = this.selectionOperations.get(operation);
    if (selectionOperation) return selectionOperation(binding, data);

    try {
      if (operation === "acquire-control") return await this.acquireAgentControl(binding);

      const viewerToken = binding.viewerToken;
      const controlToken = binding.controlToken;
      if (!viewerToken || !controlToken)
        throw new RuntimeProtocolError(
          "AUTHENTICATION_FAILED",
          "Agent does not hold browser control",
        );
      if (operation === "release-control") {
        return await this.releaseAgentControl(binding, viewerToken, controlToken);
      }
      return await this.runControlledOperation(binding, operation, {
        viewerToken,
        controlToken,
        data,
        input,
      });
    } catch (error) {
      // The first page opened even though its navigation failed: follow it, so the agent's next
      // action targets that page rather than the empty session it started from.
      if (error instanceof FirstPageNavigationError) this.followAgentState(binding, error.state);
      if (error instanceof RuntimeProtocolError && error.code === "UNKNOWN_OUTCOME")
        this.invalidateAgentObservations(binding.workspaceId!);
      throw error;
    }
  }

  /** Observe the selected tab, returning the policy's state (and frame for capture). */
  private async observe(
    binding: AgentBinding,
    operation: "status" | "capture",
    data: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    return (await this.requestAgentObservation(binding, operation, data)) as unknown as JsonValue;
  }

  /** Snapshot the selected tab's DOM, refusing a result from a tab selected meanwhile. */
  private async domSnapshot(binding: AgentBinding): Promise<JsonValue> {
    const revision = binding.selectionRevision;
    await this.requestAgentObservation(binding, "status", {});
    const result = await this.browserPolicy.domSnapshot(await this.ensureAgentViewer(binding));
    this.assertAgentBindingCurrent(binding);
    if (binding.selectionRevision !== revision)
      throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during snapshot");
    binding.lastState = result.state;
    return result as unknown as JsonValue;
  }

  /** List the workspace's tabs together with this agent's own selection. */
  private async listAgentTabs(binding: AgentBinding): Promise<JsonValue> {
    await this.ensureAgentViewer(binding);
    const listed = await this.browserPolicy.listTabs(binding.workspaceId!);
    return { ...listed, selectedTabId: binding.tabId };
  }

  /** Move this agent's viewer to the requested tab. */
  private async selectRequestedTab(
    binding: AgentBinding,
    data: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const tabId = requireText(data, "tabId");
    return {
      state: await this.selectAgentTab(binding, tabId),
    } as unknown as JsonValue;
  }

  /** Open a new tab and select it for this agent. */
  private async createAgentTab(binding: AgentBinding): Promise<JsonValue> {
    const create = async () => this.browserPolicy.createTab(await this.ensureAgentViewer(binding));
    let created: { tabId: string };
    try {
      created = await create();
    } catch (error) {
      // Only a refusal before dispatch is recoverable: the lapsed agent viewer is replaced
      // once. A lease that ends after the page was created is a distinct, non-retried error.
      if (!isInvalidViewer(error)) throw error;
      binding.viewerToken = null;
      binding.controlToken = null;
      created = await create();
    }
    return {
      tabId: created.tabId,
      state: await this.selectAgentTab(binding, created.tabId),
    } as unknown as JsonValue;
  }

  /**
   * Close the agent's observed tab, then follow the first remaining tab unless the whole
   * browser closed.
   */
  private async closeAgentTab(
    binding: AgentBinding,
    data: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const viewerToken = binding.viewerToken;
    const controlToken = binding.controlToken;
    const tabId = binding.tabId;
    if (!viewerToken || !tabId) {
      throw new RuntimeProtocolError(
        "AUTHENTICATION_FAILED",
        "Observe the selected browser tab first",
      );
    }
    const current = binding.lastState;
    if (!current?.runtimeId)
      throw new RuntimeProtocolError("INVALID_REQUEST", "Observe the selected browser tab first");
    const result = await this.browserPolicy.closeTab({
      viewerToken,
      ...(controlToken ? { controlToken } : {}),
      tabId,
      sessionId: current.sessionId,
      runtimeId: current.runtimeId,
      scope: browserTabCloseScopeSchema.parse(data.scope ?? "tab"),
    });
    binding.viewerToken = null;
    binding.tabId = null;
    binding.controlToken = null;
    binding.lastState = null;
    binding.lastFrame = null;
    if (result.browserClosed) return result;

    const { tabs } = await this.browserPolicy.listTabs(binding.workspaceId!);
    const next = tabs[0];
    if (!next) throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser has no remaining tab");
    return {
      state: await this.selectAgentTab(binding, next.id),
    } as unknown as JsonValue;
  }

  /**
   * Acquire control for the agent's current selection. A grant that arrives after the agent
   * selected another tab is released rather than published.
   */
  private async acquireAgentControl(binding: AgentBinding): Promise<JsonValue> {
    const selectionRevision = binding.selectionRevision;
    await this.requestAgentObservation(binding, "status", {});
    this.assertAgentBindingCurrent(binding);
    if (binding.selectionRevision !== selectionRevision) {
      throw new RuntimeProtocolError(
        "INVALID_REQUEST",
        "Agent tab changed during control acquisition",
      );
    }
    const viewerToken = binding.viewerToken!;
    const result = await this.browserPolicy.acquireControl(viewerToken, false);
    this.assertAgentBindingCurrent(binding);
    if (binding.selectionRevision !== selectionRevision) {
      await this.browserPolicy
        .releaseControl(viewerToken, result.controlToken)
        .catch(() => undefined);
      throw new RuntimeProtocolError(
        "INVALID_REQUEST",
        "Agent tab changed during control acquisition",
      );
    }
    binding.controlToken = result.controlToken;
    binding.lastState = result.state;
    return { state: result.state } as unknown as JsonValue;
  }

  /** Release held control; the agent forgets its control token even when release fails. */
  private async releaseAgentControl(
    binding: AgentBinding,
    viewerToken: string,
    controlToken: string,
  ): Promise<JsonValue> {
    try {
      const result = await this.browserPolicy.releaseControl(viewerToken, controlToken);
      binding.lastState = result.state;
      return result as unknown as JsonValue;
    } finally {
      binding.controlToken = null;
    }
  }

  /**
   * Run one controlled mutation against the agent's last observation, then follow the state it
   * produced. A selection change while it ran refuses the result.
   */
  private async runControlledOperation(
    binding: AgentBinding,
    operation: string,
    request: Omit<ControlledAgentRequest, "binding" | "expected">,
  ): Promise<JsonValue> {
    this.assertAgentBindingCurrent(binding);
    const selectionRevision = binding.selectionRevision;
    const expected = expectedState(binding);
    const controlledOperation = this.controlledOperations.get(operation);
    if (!controlledOperation) {
      throw new RuntimeProtocolError("INVALID_REQUEST", `Unknown agent operation: ${operation}`);
    }
    const result = await controlledOperation({ ...request, binding, expected });
    this.assertAgentBindingCurrent(binding);
    if (binding.selectionRevision !== selectionRevision) {
      throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during action");
    }
    this.followAgentState(binding, result.state);
    return result as unknown as JsonValue;
  }

  /** Send screenshot-coordinate input against the frame this agent last captured. */
  private sendAgentInput({
    binding,
    viewerToken,
    controlToken,
    expected,
    data,
  }: ControlledAgentRequest): Promise<{ state: BrowserState }> {
    if (!binding.lastFrame)
      throw new RuntimeProtocolError("INVALID_REQUEST", "Capture a frame before sending input");
    return this.browserPolicy.sendInput(
      parseAgentInput(sendBrowserInputRpc.input, {
        viewerToken,
        controlToken,
        expected,
        target: binding.lastFrame,
        event: data.event,
      }),
    );
  }

  /** Record a state the agent's viewer moved to, bumping its selection when the tab changed. */
  private followAgentState(binding: AgentBinding, state: BrowserState): void {
    binding.lastState = state;
    binding.lastFrame = null;
    if (binding.tabId === (state.tabId ?? null)) return;
    binding.tabId = state.tabId ?? null;
    binding.selectionRevision += 1;
    this.saveAgentSelection(binding);
  }

  /**
   * Status or capture through the agent's viewer, replacing an expired viewer once. Refuses the
   * result if the binding was revoked or its tab selection changed while it was in flight.
   */
  private async requestAgentObservation(
    binding: AgentBinding,
    operation: "status" | "capture",
    input: Record<string, JsonValue>,
  ): Promise<{ state: BrowserState; frame?: BrowserFrame | null }> {
    const selectionRevision = binding.selectionRevision;
    const run = async (viewerToken: string) =>
      operation === "status"
        ? await this.browserPolicy.status(viewerToken)
        : await this.browserPolicy.capture(
            viewerToken,
            input.quality === "low" || input.quality === "medium" || input.quality === "high"
              ? input.quality
              : DEFAULT_CAPTURE_QUALITY,
            null,
          );
    let result: { state: BrowserState; frame?: BrowserFrame | null };
    try {
      result = await run(await this.ensureAgentViewer(binding));
    } catch (error) {
      if (!isInvalidViewer(error)) throw error;
      binding.viewerToken = null;
      binding.controlToken = null;
      result = await run(await this.ensureAgentViewer(binding));
    }
    this.assertAgentBindingCurrent(binding);
    if (binding.selectionRevision !== selectionRevision) {
      throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during observation");
    }
    binding.lastState = result.state;
    binding.tabId = result.state.tabId ?? null;
    this.saveAgentSelection(binding);
    if (operation === "capture") binding.lastFrame = result.frame ?? null;
    return result;
  }

  /** Move only this agent's viewer to a page, preserving every other viewer's selection. */
  private async selectAgentTab(binding: AgentBinding, tabId: string): Promise<BrowserState> {
    this.assertAgentBindingCurrent(binding);
    if (binding.tabId === tabId && binding.viewerToken) {
      // Same-tab selection needs the same expiry recovery as status/capture.
      const current = await this.requestAgentObservation(binding, "status", {});
      if (binding.tabId !== tabId) {
        throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during selection");
      }
      binding.lastState = current.state;
      return current.state;
    }
    const revision = ++binding.selectionRevision;
    const requestContext = this.publicationContext.getStore();
    if (requestContext?.binding === binding) requestContext.selectionRevision = revision;
    const previousViewer = binding.viewerToken;
    binding.controlToken = null;
    binding.lastState = null;
    binding.lastFrame = null;
    const attached = await this.browserPolicy.attachAgent(
      binding.workspaceId!,
      `Agent ${binding.agentId!.slice(0, 48)}`,
      tabId,
    );
    try {
      this.assertAgentBindingCurrent(binding);
      if (binding.selectionRevision !== revision) {
        throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab selection was replaced");
      }
      if (previousViewer) {
        try {
          await this.browserPolicy.detach(previousViewer);
        } catch (error) {
          // Another viewer may have closed the preview. Its retired lease must
          // not prevent this explicit selection of an independently valid page.
          if (
            !isInvalidViewer(error) &&
            !(error instanceof Error && error.message === "Browser tab is closed")
          )
            throw error;
        }
      }
      this.assertAgentBindingCurrent(binding);
      binding.viewerToken = attached.viewerToken;
      binding.tabId = attached.state.tabId ?? tabId;
      this.saveAgentSelection(binding);
      binding.controlToken = null;
      binding.lastState = attached.state;
      binding.lastFrame = null;
      return attached.state;
    } catch (error) {
      await this.browserPolicy.detach(attached.viewerToken).catch(() => undefined);
      throw error;
    }
  }

  /** Publish an attached viewer only while its original credential still exists. */
  private async ensureAgentViewer(binding: AgentBinding): Promise<string> {
    this.assertAgentBindingCurrent(binding);
    if (binding.viewerToken) return binding.viewerToken;
    const selectionRevision = binding.selectionRevision;
    const attached = await this.browserPolicy.attachAgent(
      binding.workspaceId!,
      `Agent ${binding.agentId!.slice(0, 48)}`,
      binding.tabId ?? undefined,
    );
    try {
      this.assertAgentBindingCurrent(binding);
      if (binding.selectionRevision !== selectionRevision) {
        throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during attachment");
      }
    } catch (error) {
      // Cleanup must run outside the revoked caller's publication fence.
      await this.publicationContext
        .exit(() => this.browserPolicy.detach(attached.viewerToken))
        .catch(() => undefined);
      throw error;
    }
    if (binding.viewerToken) {
      // Parallel observations may both attach. Keep the first published viewer.
      await this.publicationContext.exit(() => this.browserPolicy.detach(attached.viewerToken));
      this.assertAgentBindingCurrent(binding);
      return binding.viewerToken;
    }
    binding.viewerToken = attached.viewerToken;
    binding.lastState = attached.state;
    binding.tabId = attached.state.tabId ?? null;
    this.saveAgentSelection(binding);
    return attached.viewerToken;
  }

  /** Persist selection only when it changes; runtime content and leases stay volatile. */
  private saveAgentSelection(binding: AgentBinding): void {
    if (!this.bindingStore || !binding.agentId || !binding.workspaceId) return;
    const previous = this.bindingStore.get(binding.ticket);
    if (previous?.tabId === binding.tabId) return;
    this.bindingStore.set(binding.ticket, {
      agentId: binding.agentId,
      workspaceId: binding.workspaceId,
      tabId: binding.tabId,
    });
  }

  /** A deleted or replaced ticket cannot regain authority after an awaited step. */
  private assertAgentBindingCurrent(binding: AgentBinding): void {
    this.host.assertPluginAvailable();
    if (this.bindings.get(binding.ticket) !== binding) {
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket was revoked");
    }
    this.host.assertWorkspaceOpen(binding.workspaceId!);
  }

  /**
   * Immediately before an agent's native publication: its ticket must still be bound and its
   * tab selection must be the one the request was admitted for.
   */
  assertAgentPublication(agent: AgentPublicationContext): void {
    this.assertAgentBindingCurrent(agent.binding);
    if (agent.binding.selectionRevision !== agent.selectionRevision)
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent tab selection changed");
  }

  private requireAgentBinding(ticket: string): AgentBinding {
    const binding = this.bindings.get(ticket);
    if (!binding?.agentId || !binding.workspaceId)
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket is invalid or unbound");
    this.host.assertWorkspaceOpen(binding.workspaceId);
    return binding;
  }

  /** Forget agents' control and observations in a workspace, or only on one of its tabs. */
  revokeAgentControl(workspaceId: string, tabId?: string): void {
    for (const binding of this.bindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      if (tabId && binding.tabId !== tabId) continue;
      binding.controlToken = null;
      binding.lastState = null;
      binding.lastFrame = null;
    }
  }

  /** Forget agents' observations of the tab a human mutation just changed. */
  invalidateAgentObservationsForState(result: unknown): void {
    const state = stateFromPolicyResult(result);
    this.invalidateAgentObservations(state.workspaceId, state.tabId);
  }

  /** Forget agents' observations in a workspace, or only on one of its tabs. */
  invalidateAgentObservations(workspaceId: string, tabId?: string): void {
    for (const binding of this.bindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      if (tabId && binding.tabId !== tabId) continue;
      binding.lastState = null;
      binding.lastFrame = null;
    }
  }

  /** Remove every agent binding in an archived workspace, durably, then detach their viewers. */
  async revokeWorkspace(workspaceId: string): Promise<void> {
    this.bindingStore?.revokeWorkspace(workspaceId);
    const viewers: string[] = [];
    for (const [ticket, binding] of this.bindings) {
      if (binding.workspaceId !== workspaceId) continue;
      this.bindings.delete(ticket);
      if (binding.viewerToken) viewers.push(binding.viewerToken);
      if (binding.agentId) {
        const tickets = this.tickets.get(binding.agentId);
        tickets?.delete(ticket);
        if (tickets?.size === 0) this.tickets.delete(binding.agentId);
      }
    }
    await Promise.allSettled(viewers.map((viewerToken) => this.browserPolicy.detach(viewerToken)));
  }

  private expireUnboundTickets(): void {
    const deadline = this.host.now() - AGENT_TICKET_TTL_MS;
    for (const [ticket, binding] of this.bindings)
      if (binding.agentId === null && binding.issuedAt <= deadline) this.bindings.delete(ticket);
  }
}

/**
 * The agent publication fence for one runtime operation inside an agent request.
 *
 * Revocation blocks new publication, but never strands a possibly published press: a down or
 * gesture begin records its runtime immediately before publication, and only its paired release
 * on that same runtime may pass a revoked fence.
 */
export class AgentRuntimeOperation {
  private readonly key: string;
  private readonly button: string;
  private readonly channelId: string;

  /**
   * @param agents Authority that checks the request's binding and selection.
   * @param agent The agent request this operation belongs to.
   * @param operation Runtime operation name, such as `key.down` or `input.end`.
   * @param input Raw runtime input; only its key, button and gesture ID are read.
   * @param runtime The exact runtime instance receiving the operation.
   */
  constructor(
    private readonly agents: AgentAuthority,
    private readonly agent: AgentPublicationContext,
    private readonly operation: string,
    input: JsonValue,
    private readonly runtime: PublishedRuntime,
  ) {
    const data = jsonObjectOrEmpty(input);
    this.key = typeof data.key === "string" ? data.key : "";
    this.button = typeof data.button === "string" ? data.button : "";
    this.channelId = typeof data.gestureId === "string" ? data.gestureId : "";
  }

  /**
   * Check the fence unless this is the paired release of a press this request published, then
   * record a new press. A lost down/begin ACK still requires cleanup, so intent is recorded only
   * after the current binding fence, immediately before native publication.
   */
  admit(): void {
    const { agent, operation, runtime } = this;
    const pairedRelease =
      (operation === "key.up" && agent.keys.get(this.key) === runtime) ||
      (operation === "mouse.up" && agent.buttons.get(this.button) === runtime) ||
      (operation === "input.end" && agent.channels.get(this.channelId) === runtime);
    if (!pairedRelease) {
      this.agents.assertAgentPublication(agent);
    }
    if (operation === "key.down") agent.keys.set(this.key, runtime);
    if (operation === "mouse.down") agent.buttons.set(this.button, runtime);
    if (operation === "input.begin") agent.channels.set(this.channelId, runtime);
  }

  /** Recheck the fence immediately before the runtime publishes a guarded mutation. */
  assertPublication(): void {
    this.agents.assertAgentPublication(this.agent);
  }

  /**
   * After the runtime acknowledged the operation, forget a press its release completed. These
   * records allow only the policy-generated paired release, on the original runtime, before the
   * outer request refuses its revoked result.
   */
  settle(): void {
    if (this.operation === "key.up") this.agent.keys.delete(this.key);
    if (this.operation === "mouse.up") this.agent.buttons.delete(this.button);
  }

  /** A gesture end retires its channel whether or not the runtime acknowledged it. */
  finish(): void {
    if (this.operation === "input.end") this.agent.channels.delete(this.channelId);
  }
}

/** Raw agent sockets reuse the public mutation contract. Never expose parser
 * issues or submitted values in errors from this trusted-ticket boundary. */
function parseAgentInput<Value>(schema: ZodType<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeProtocolError("INVALID_REQUEST", "Invalid agent browser request");
  }
  return parsed.data;
}

/** Refuse a ticket or other opaque credential outside the issued shape. */
function assertOpaqueToken(value: string, label: string): void {
  if (value.length < 32 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new RuntimeProtocolError("INVALID_REQUEST", `${label} is invalid`);
}

/** Build a mutation fence from the agent's last observation; mutating needs one. */
function expectedState(binding: AgentBinding): ExpectedAgentState {
  const state = binding.lastState;
  if (!state)
    throw new RuntimeProtocolError("INVALID_REQUEST", "Observe the browser before mutating it");
  if (!state.runtimeId || state.bridgeEpoch === undefined)
    throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser observation lacks runtime identity");
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
    runtimeId: state.runtimeId,
    bridgeEpoch: state.bridgeEpoch,
  };
}

/** Whether the policy refused a lapsed viewer lease, which agents replace once. */
function isInvalidViewer(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Viewer token is invalid or expired");
}
