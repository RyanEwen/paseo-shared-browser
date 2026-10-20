import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readAgentAdapterRegistration } from "./server/agent-adapter-registration";
import {
  bindAgentTicket,
  cleanupBrowserServer,
  handleAcquireControl,
  handleApplyDevicePreset,
  handleAttachBrowser,
  handleBeginBrowserGesture,
  handleCaptureBrowser,
  handleCloseBrowser,
  handleCloseBrowserTab,
  handleCreateBrowserTab,
  handleDetachBrowser,
  handleEndBrowserGesture,
  handleListBrowserTabs,
  handleListOpenBrowserWorkspaces,
  handleNavigateBrowser,
  handlePrintBrowser,
  handleReadBrowserState,
  handleReadBrowserVideo,
  handleReleaseControl,
  handleReopenBrowser,
  handleReportDisplayDemand,
  handleResizeBrowser,
  handleSendBrowserInput,
  handleSetCaptureDensity,
  handleUpdateBrowserGesture,
  handleWorkspaceArchived,
  issueAgentTicket,
  revokeAgentBrowserAccess,
} from "./server/browser";
import { createBrowserMediaBroker } from "./server/browser-media-broker";
import { createRuntimeGraphicsSettings } from "./server/runtime-graphics-settings";
import { readRuntimeMediaAssets } from "./server/runtime-media-assets";
import { resolveBrowserRuntimeRoot } from "./server/runtime-path";
import { createRuntimeVideoSettings } from "./server/runtime-video-settings";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  closeBrowserTabRpc,
  createBrowserTabRpc,
  detachBrowserRpc,
  endBrowserGestureRpc,
  listBrowserTabsRpc,
  listOpenBrowserWorkspacesRpc,
  navigateBrowserRpc,
  printBrowserRpc,
  releaseControlRpc,
  reopenBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "./shared/browser";
import { browserDisplayDemandRpc } from "./shared/browser-display-demand";
import { browserDisplayPreferences } from "./shared/browser-display-preferences";
import {
  browserMediaCapabilitiesRpc,
  closeBrowserMediaRpc,
  openBrowserMediaRpc,
  pollBrowserMediaRpc,
} from "./shared/browser-media";
import { readBrowserVideoRpc } from "./shared/browser-video";

const TICKET_ENV = "PASEO_SHARED_BROWSER_TICKET";
const MCP_SERVER_ID = "shared-browser";
const TICKET_ISSUE_TIMEOUT_MS = 2_000;

async function issueTicketWithinDeadline(ticket: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      issueAgentTicket(ticket),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Shared Browser ticket issuance timed out")),
          TICKET_ISSUE_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

function mcpBundlePath(): string {
  return join(resolveBrowserRuntimeRoot(paseoHome()), "shared-browser-mcp.cjs");
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(browserDisplayPreferences);
  const videoSettings = createRuntimeVideoSettings(paseoHome());
  const graphicsSettings = createRuntimeGraphicsSettings(paseoHome());
  let liveVideoEnabled = false;
  const mediaAssets = readRuntimeMediaAssets(paseoHome());
  const media = createBrowserMediaBroker({
    assets: async () => (await mediaAssets)?.worker ?? null,
    enabled: () => liveVideoEnabled,
    readState: handleReadBrowserState,
    readVideo: handleReadBrowserVideo,
  });
  const syncRuntimeSettings = async (state: Awaited<ReturnType<typeof settings.read>>) => {
    liveVideoEnabled = state.status === "ready" && state.values.liveVideoEnabled;
    await Promise.all([
      videoSettings.update(state.status === "ready" && state.values.liveVideoEnabled),
      graphicsSettings.update(
        state.status === "ready"
          ? (state.values.graphicsPreference ?? "host-default")
          : "host-default",
      ),
    ]);
  };
  const syncSettings = async () => {
    const state = await settings.read();
    await syncRuntimeSettings(state);
  };
  const unsubscribeSettings = settings.subscribe(syncRuntimeSettings);
  server.handle(attachBrowserRpc, async (input, context) => {
    await syncSettings();
    return handleAttachBrowser(input, context);
  });
  server.handle(detachBrowserRpc, handleDetachBrowser);
  server.handle(closeBrowserRpc, handleCloseBrowser);
  server.handle(closeBrowserTabRpc, handleCloseBrowserTab);
  server.handle(createBrowserTabRpc, handleCreateBrowserTab);
  server.handle(listBrowserTabsRpc, handleListBrowserTabs);
  server.handle(reopenBrowserRpc, async (input, context) => {
    await syncSettings();
    return handleReopenBrowser(input, context);
  });
  server.handle(captureBrowserRpc, handleCaptureBrowser);
  server.handle(setCaptureDensityRpc, handleSetCaptureDensity);
  server.handle(browserDisplayDemandRpc, handleReportDisplayDemand);
  server.handle(readBrowserVideoRpc, async (input) => {
    await videoSettings.flush();
    return handleReadBrowserVideo(input);
  });
  server.handle(browserMediaCapabilitiesRpc, () => media.capabilities());
  server.handle(openBrowserMediaRpc, async (input) => {
    await syncSettings();
    return media.open(input);
  });
  server.handle(pollBrowserMediaRpc, (input) => media.poll(input));
  server.handle(closeBrowserMediaRpc, (input) => media.closeViewer(input));
  server.handle(listOpenBrowserWorkspacesRpc, handleListOpenBrowserWorkspaces);
  server.handle(acquireControlRpc, handleAcquireControl);
  server.handle(releaseControlRpc, handleReleaseControl);
  server.handle(beginBrowserGestureRpc, handleBeginBrowserGesture);
  server.handle(updateBrowserGestureRpc, handleUpdateBrowserGesture);
  server.handle(endBrowserGestureRpc, handleEndBrowserGesture);
  server.handle(navigateBrowserRpc, handleNavigateBrowser);
  server.handle(printBrowserRpc, handlePrintBrowser);
  server.handle(resizeBrowserRpc, handleResizeBrowser);
  server.handle(applyDevicePresetRpc, handleApplyDevicePreset);
  server.handle(sendBrowserInputRpc, handleSendBrowserInput);
  server.before("agent.create", async ({ request }) => {
    if (request.config.internal) return request;
    await syncSettings();
    const ticket = randomBytes(32).toString("base64url");
    if (!(await issueTicketWithinDeadline(ticket))) return request;
    return {
      ...request,
      env: { ...request.env, [TICKET_ENV]: ticket },
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [MCP_SERVER_ID]: {
            type: "stdio",
            command: process.execPath,
            args: [mcpBundlePath()],
            env: {
              PASEO_HOME: paseoHome(),
              [TICKET_ENV]: ticket,
              ELECTRON_RUN_AS_NODE: "1",
            },
          },
        },
      },
    };
  });

  server.before("agent.session_open", async ({ request }) => {
    if (request.purpose !== "interactive" || !request.workspaceId) return request;
    await syncSettings();
    const ticket =
      request.env[TICKET_ENV] ??
      (await readAgentAdapterRegistration(paseoHome(), request.agentId, request.workspaceId));
    if (!ticket) return request;
    // Trusted interactive launches re-register after supervisor replacement.
    // Retain the override so resume/refresh hooks can renew the same binding.
    try {
      await bindAgentTicket(ticket, request.agentId, request.workspaceId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Unknown agent ticket") throw error;
      await issueAgentTicket(ticket);
      await bindAgentTicket(ticket, request.agentId, request.workspaceId);
    }
    return request.env[TICKET_ENV] === ticket
      ? request
      : { ...request, env: { ...request.env, [TICKET_ENV]: ticket } };
  });

  server.on("agent.archived", ({ agent }) => revokeAgentBrowserAccess(agent.id));

  server.on("workspace.archived", ({ workspace }) => handleWorkspaceArchived(workspace.id));

  return async () => {
    unsubscribeSettings();
    await media.close();
    await videoSettings.flush().catch(() => {});
    await graphicsSettings.flush().catch(() => {});
    await cleanupBrowserServer();
  };
}
