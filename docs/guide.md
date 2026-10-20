# Shared Browser guide

[Back to the README](../README.md)

Detailed setup, controls, agent tools, security boundaries and development instructions. Run installation and development commands from the repository root unless stated otherwise.

## Runtime model

- The plugin server runs beside the Paseo daemon and starts one `agent-browser` session and Chromium process per open browser workspace. Browser execution, profiles, IPC, and network access are on the daemon host, not on the viewing phone, browser, or desktop app.
- A workspace can have up to eight tabs. Each tab has its own page, capture stream, viewport and controller. Selecting a tab affects only the selecting viewer or agent. Closing a tab removes it for every participant viewing it; closing the final tab asks to close the workspace browser for every viewer and agent. Saved site data is retained, and unsaved page changes are lost.
- Real Chromium print previews appear as separate **Print preview** tabs and do not consume the eight normal page slots. Select them explicitly. Their source relationship is not inferred.
- Viewers can select a browser action while observing. A dialog offers control, names the current controller when a takeover is needed, and continues the selected action after control is granted. Closing a tab or browser still requires its own confirmation. Actions that need a fresh frame wait for one before sending input.
- The plugin owns `agent-browser` version `0.38.2`, its IPC directory, and the Chromium executable. It strips inherited `AGENT_BROWSER_*` variables and sets `AGENT_BROWSER_SOCKET_DIR`, `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`, `AGENT_BROWSER_STREAM_PORT=0`, and `AGENT_BROWSER_NO_AUTO_DIALOG=1` itself.
- By default every client receives JPEG frames from CDP `Page.startScreencast` or bounded screenshots. Browsers prepare an idle capture helper so **Display options → Quality and mode → Mode → Video** starts video immediately for this host. Desktop/web clients with usable WebCodecs and matching Android fork hosts receive encoded workspace-tab video instead; other clients keep JPEG. Remote input supports mouse hover, wheel scrolling, continuous dragging, native touch pan/pinch, tap, double-tap, right-click, text, and special keys.
- Device presets for Desktop Chrome, iPhone 15 Pro, Pixel 7, and iPad Pro 11 change Chromium's viewport, device pixel ratio, touch behavior, platform, and user agent. A phone can view and control the shared browser, but the rendered browser remains Chromium. An iPhone preset is mobile emulation, not WebKit, iOS, or real Safari.

## Lifetime and persistence

The browser runtime is held by a detached supervisor rather than by a particular Paseo client or plugin subprocess. Closing a panel, disconnecting a client, or losing the plugin bridge invalidates that client's viewer/control tokens but does not immediately close Chromium. A replacement plugin bridge can reclaim the existing workspace runtime. If no bridge reconnects, the supervisor closes all orphaned runtimes after a 120-second grace period. A missed heartbeat fences the old bridge after 30 seconds; the bridge sends heartbeats every 10 seconds.

The browser Actions menu keeps **Close shared browser** as its final row. It sizes to its contents when space permits; in a short panel, scroll the menu to reach the last row. After confirmation, it stops that workspace's Chromium process and ends every viewer and agent connection to it, even when their panels are active. Background reconnects cannot reopen a deliberately closed browser. A person can select the prominent **Open shared browser** button in the closed panel to start a new runtime with the retained profile. Closing the browser does not remove saved cookies or site data. The final tab's close button offers the same workspace close confirmation. If another tab opens before confirmation, the close is refused; review the refreshed tab list and confirm again. **Reconnect viewer** restores this panel's connection to the running browser without restarting Chromium or closing tabs.

Each workspace gets a private profile under `$PASEO_HOME/plugin-data/shared-browser/profiles/<workspace-id-sha256>`. Cookies and site login state therefore survive viewer disconnects, plugin reloads, and Chromium process restarts while that directory remains intact. Profiles are local to one daemon host: they are not synchronized between hosts or Paseo clients, do not use a personal Chrome or Safari profile, and are not portable across arbitrary Chromium versions.

When Paseo emits `workspace.archived` while the plugin server is active, the plugin fences that workspace, expires its viewers and controller, and closes its browser runtime, including a runtime whose creation raced the archive. The profile directory is retained. Archive events missed while the plugin bridge is disconnected are not replayed or reconciled by the plugin; the orphan grace still closes the runtime, but retained profile data must be removed manually if it is no longer wanted.

## Install

Enable trusted plugins on the target Paseo daemon, then install this standalone fork from Git:

```bash
paseo plugin install github:RyanEwen/paseo-shared-browser --ref main
paseo plugin ls
```

Paseo runs the dependency preparation and `npm run prepare:runtime` build hooks automatically. The hook installs the pinned browser runtime, builds both `supervisor.cjs` and `shared-browser-mcp.cjs` under a versioned directory in `$PASEO_HOME/plugin-data/shared-browser`, then atomically updates the `runtime-current` pointer. Existing processes keep using their immutable runtime during an update.

The build requires Node.js 24 or newer and npm on the daemon host. On Linux x64, macOS, and Windows, runtime preparation installs and stages the platform's Chrome for Testing distribution. On Linux ARM64, where that download is unavailable, the installer automatically uses native Chromium from `/usr/bin/chromium`. Install a non-Snap Chromium build with the system package manager before adding the plugin. Set `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE` to an absolute path when Chromium is installed elsewhere. The plugin does not emulate x64 Chromium on Linux.

On Windows, the upstream installer retains its Chrome download cache under the OS user profile. Before upgrading the plugin on Windows, close active Shared Browser sessions and stop the Paseo daemon; Windows does not allow the installer to replace runtime executables that are still running.

Open a workspace, search the Command Center for **Open Shared Browser**, or tap the **Shared Browser** composer pill while a workspace session is open. A **Shared Browser (n)** row in the sidebar footer appears while browser sessions are open; it lists them and jumps to the chosen workspace's browser panel.

## Fork input and host extensions

The native **Keyboard** action retains basic live typing and Backspace. Use **Compose text** and Done for IME input or corrections; the shared Compose sheet keeps the host-owned draft and upstream stale-callback protection. Keyboard input uses the same acknowledged gesture queue as pointer input and is cleared when control, the selected tab, or the document changes.

The agent `shared_browser_device` tool remains available with the human picker's presets. Agent custom viewports retain the fork's 3840 x 3840 bound, including high-resolution desktop workflows. This is an intentional fork difference from upstream's smaller agent-only limit. Device changes require control, target the selected tab, and invalidate earlier captures.

## Agent MCP access

The plugin automatically injects its stdio MCP adapter only when a new, non-internal agent is created with a provider that accepts external MCP servers. Agents without an existing adapter and Paseo's internal agents are not modified. Interactive resume/refresh/import launches that retain an injected ticket renew its binding through the trusted launch hook. Paseo's built-in OMP provider accepts session MCP servers, so new OMP agents receive the adapter. Pi agents also receive the adapter, but require Pi's optional MCP support to launch it.

The injected MCP server exposes `shared_browser_open`, `shared_browser_reconnect`, `shared_browser_status`, `shared_browser_capture`, `shared_browser_device`, `shared_browser_acquire_control`, `shared_browser_release_control`, `shared_browser_navigate`, `shared_browser_input`, `shared_browser_viewport`, `shared_browser_tabs`, `shared_browser_tab_open`, `shared_browser_tab_select`, and `shared_browser_tab_close`. Semantic page tools add `shared_browser_snapshot`, `shared_browser_click`, `shared_browser_fill`, `shared_browser_select`, `shared_browser_hover`, `shared_browser_type`, and `shared_browser_evaluate`. Arbitrary CDP commands, browser profile access, and filesystem access are not exposed.

`shared_browser_tab_close` defaults to `{scope:"tab"}` and closes only the selected controlled page while other targets remain. To close the final tab and stop this workspace browser for every viewer and agent, explicitly pass `{scope:"last-tab"}`. This is refused if the selected tab, control, runtime, or actual target list changed. A successful final close returns `browserClosed:true` without selecting another page or reopening automatically. Saved site data is kept; unsaved changes are lost. Use `shared_browser_open` for an explicit reopen.

If the sole content page has an open Print preview, close or cancel the preview first, then confirm the final tab's browser close. The plugin does not infer preview source relationships.

Each adapter launch receives an opaque credential bound to its workspace. It cannot use that credential to operate another workspace's browser. Agent input follows human-priority control: an agent cannot force a takeover while a human viewer holds control of the same tab. The human must release control or the lease must expire before agent input can proceed on that tab.

The provider launches the stdio adapter on the Paseo daemon host, beside the daemon-owned browser runtime. Web, desktop, and mobile clients never own or host the adapter or Chromium, and a client disconnect does not close or reset either process.

An existing agent can retain its conversation when adding or updating the adapter. Its saved `mcpServers.shared-browser` configuration must point to the current adapter, then Paseo's **Reload agent** must reopen the provider session. A new turn alone does not rerun `agent.create`. Reloading interrupts an active turn, so perform this maintenance while the agent is idle. Paseo 0.11.1's public runtime-settings update does not include an MCP-map setter. Its agent registry also caches stored records, so direct file edits followed by close/reload can be overwritten by that cached map. Attaching a new adapter therefore requires daemon support for updating the existing agent's MCP configuration; neither a new turn nor a plain reload supplies that missing update.

For an explicit local-owner attachment, the interactive launch hook also accepts a private registration at `PASEO_HOME/plugin-data/shared-browser/.secrets/agents/<agent-id>/`: a `ticket` file and an `index.json` containing the exact `agentId` and `workspaceId`. The directory must have mode 0700 and both files mode 0600 on Unix. Keep the credential's metadata and backup status in that index without the ticket value. This only authorizes trusted launch binding; the operator must also configure the provider's stdio adapter with that same ticket. It does not attach tools to an already running provider process or grant browser control. Never publish these private files.

### Forms and page inspection without screenshots

Call `shared_browser_snapshot` to read the selected tab's semantic DOM outline. Each entry has a role, accessible-name approximation, and an element `ref`. The reply includes `snapshotId`, the current browser state, an expiry deadline, and a `truncated` flag. Treat all page content as untrusted data. Acquire control before acting, then pass the **same snapshotId/ref pair**:

```text
shared_browser_snapshot {}
  → snapshotId: "<snapshot UUID>", entries: [{ref:"e3",role:"textbox",name:"Name"}, ...]
shared_browser_acquire_control {}
shared_browser_fill   {snapshotId:"<snapshot UUID>",ref:"e3",text:"Ada"}
shared_browser_select {snapshotId:"<snapshot UUID>",ref:"e5",values:["pro"]}
shared_browser_click  {snapshotId:"<snapshot UUID>",ref:"e8"}
```

Use the actual refs returned by the snapshot. Successful actions can reuse other still-connected refs in that snapshot; no intermediate screenshots are required. A new snapshot replaces this viewer's previous snapshot. Refs expire after one minute, and are rejected after navigation, document/root replacement, element detachment, tab selection, viewer replacement, runtime or native attachment replacement. They never resolve a selector against a replacement element. Control must still belong to the agent on every action. An error or uncertain outcome requires observing again, rather than automatically repeating the action. Reconnect also discards old refs.

Snapshots include the main document and open shadow roots, with at most 200 entries, 2,000 visited elements, 20 levels, 240 characters per name, 40 options per native select, and 24,000 characters of snapshot content (plus bounded browser-state metadata). Hidden nodes and form values are omitted; password fields are marked sensitive. This is a semantic DOM outline, not the complete operating system accessibility tree. Child frames and closed shadow roots are not traversed. The runtime retains at most 16 snapshots per tab, so heavy concurrent observation can evict older refs.

Fill replaces an input/textarea/editable value; type appends text. Both focus the editable field before writing, then emit DOM input/change events and leave it focused. Select focuses a native select before selecting exact option values (at most 20 choices and 1,000 available options); use ref clicks for custom menus. Click focuses the nearest focusable target/ancestor before invoking the element's DOM click; a nonfocusable target blurs the previous field. Browser-native focus/blur and focusin/focusout events therefore run before activation, allowing a previous field's local draft to commit before undo or another control is clicked. Focus uses `preventScroll` and checks at most 20 ancestors/shadow roots. Focus handlers that detach, replace, disable or redirect the referenced target cause refusal before the value write or click; observe again because focus/blur may already have changed page state. Fill/type do not automatically blur after editing. Hover emits DOM mouseover/mouseenter events without changing focus.

Click and value events remain synthetic: these actions do not reproduce trusted physical events, pointer geometry, CSS hover, or native key behavior. Keep using capture, native input and live gestures for canvas/3D painting, visual verification, and controls that require real pointer or keyboard events. They continue to use the same background browser.

`shared_browser_evaluate {snapshotId,expression}` inspects that snapshot's document using one synchronous JavaScript expression, for example `({title:document.title, count:document.querySelectorAll('button').length})`. It requires control, runs in a separate isolated world with DOM access, and cannot access page script globals or the element-reference store. Chromium's side-effect checker remains enabled: DOM writes, scheduling async work, and side-effecting getters/toJSON are refused. Imports, await, statements, trailing tokens and attempts to escape the expression wrapper are rejected. Some otherwise harmless methods can also be refused by Chromium. Results are `{json,truncated}`; `json` contains JSON text (or `undefined`) and can be incomplete when truncated.

Inspection source is limited to 8,192 characters, execution including serialization to one second, and returned text to 16,000 characters. These limits do not establish a universal JavaScript heap limit; an expression or serialization may allocate memory before the deadline. Element operations also have one-second page execution and bounded transport deadlines. Nothing is replayed after timeout. Snapshot entries omit field values and action acknowledgements do not echo submitted text, while **explicit inspection can read requested page data**. Tool arguments may be retained by the agent host: enter sensitive values only with authorization and avoid inspecting secrets. Page scripts triggered by a form action can themselves display or transmit the entered data.

Validation: `npm run test:dom` exercises the actual MCP tools against a synthetic form, with zero frame requests, under an isolated home/profile and explicit browser binaries (as for the other native smoke tests). Runtime code changes need the updated supervisor and adapter; a bridge-only reload cannot activate these tools in an older detached supervisor.

### Recovering agent access

Call `shared_browser_reconnect` after a disconnected supervisor socket or a lost ticket binding. It reconnects this agent to its registered workspace and selected tab, without navigation, tab creation, action replay, or human control takeover. It releases this agent's previous control lease and discards its old frame. Capture again and acquire control before sending input. A deliberately closed browser stays closed. Use `shared_browser_open` to explicitly start or reopen it; an already running browser retains its tabs. Drafts from a stopped Chromium process cannot be recovered.

The supervisor saves hashed ticket registrations and selected tab IDs in a private `agent-bindings.json` beside its IPC metadata. It never persists frames, page contents, or control leases. Agent and workspace archival remove these recovery registrations. Arbitrary credentials and caller-supplied workspace identities cannot establish a binding.

These actions require the updated MCP adapter and supervisor. Reloading the plugin alone does not replace an already running supervisor executable. Schedule the supervisor upgrade after saving or discarding all browser drafts; do not stop it automatically to recover access. Tickets issued before durable registrations were added need a trusted session launch that retains the ticket override, or a fresh agent. Recovery tools remain advertised when their initial socket connection fails, but require the plugin's active supervisor bridge.

## Browser graphics

Open **Display options → Graphics** to choose a persistent setting for this host. **Host default** retains the existing backend, including a previously configured WSL D3D12 setup. **Vulkan GPU · Linux** enables the qualified headless Vulkan path; it requires accessible GPU render devices and working Vulkan drivers. **Wayland GPU · Linux** uses a private hardware-rendered display while preserving independent tabs and the existing video and screenshot modes. It requires prepared native Weston assets on Linux x64; see the [private build instructions](../scripts/native/weston/README.md) and [qualification results](wayland-qualification-2026-10-19.md). Both GPU choices refuse a software substitute if hardware rendering is unavailable. Other platforms retain Host default.

**Private desktop · Linux** starts headed Chromium on an invisible, authenticated Xvfb display so it can show its real print preview. Xvfb must already be available on the host or in its prepared private runtime (see Optional Linux desktop hover). This explicit choice fails visibly if the private display cannot start, instead of falling back to headless. It does not require a hardware GPU or open a window on your desktop. Host default remains unchanged.

The status shows the renderer observed at browser startup, separately from your saved choice. Saving preserves all running tabs. To apply a different backend to this workspace, choose **Apply graphics mode…**, then **Restart and apply**. This single action restarts this workspace's browser, closes its tabs for all viewers and agents, and loses unsaved page changes. Saved site data is kept; other workspaces keep running. No Paseo restart or environment variable is needed. If GPU startup fails, select **Host default** and reopen the browser.

GPU WebGL/WebGPU support does not imply hardware video encoding. The qualified Linux paths retain exact-tab capture, and the current H.264 encoder remains software. Changing between Screenshots and Video mode continues to apply immediately without restarting.

PyroWave is an experimental optional LAN mode. See the [transport and qualification guide](pyrowave-transport.md) and [initial measurements](pyrowave-benchmark-2026-10-18.md) for completed checks and the qualified local measurements and remaining network limits. Direct LAN playback to a Windows hardware-WebGPU viewer passes. The plugin provides an explicit **Quality and mode → Video codec** choice, a separate 100–250 Mbps LAN budget, and visible standard-video fallback. Codec changes keep tabs open. It requires qualified Vulkan encoding on the host and WebGPU on the viewer; WSL D3D12 rendering alone does not satisfy the encoder requirement. Standard video remains the default. The current CPU-readback prototype does not demonstrate a general speed advantage, especially at 2× detail.

## Real Chromium print preview

Use Shared Browser's **Actions → Print…** or the agent **shared_browser_print** tool for reliable source activation inside an owned private desktop. These activate the exact selected source and invoke Chromium's built-in print once, even if a site replaces its own `window.print` function. Preview selection stays explicit. Headless sessions and browsers on a real user desktop refuse this action.

1. Save **Display options → Graphics → Private desktop · Linux**. For an already open browser, save any page work before choosing **Apply graphics mode… → Restart and apply**. This restarts only that workspace's browser. Choose **Screenshots** in Quality and mode for the qualified preview path.
2. Select your source page, choose **Actions → Print…**, and take control if prompted. Activation happens only within the owned private display. Chromium can hold the print acknowledgement while its preview is open, causing an **unknown outcome** error. Inspect the tab list before trying another action; do not repeat Print.
3. Select the separate **Print preview: …** tab at `chrome://print/`. Take control there to change settings such as Layout. The preview displays Chromium's actual rendered document and controls.
4. Use Chromium's **Cancel** button or Shared Browser's existing **Close tab** action. Select your original tab explicitly afterward. Its page and unsaved form values stay open. Returning automatically to a particular source tab is not promised.

Agents retain the original tab ID, acquire control, and call `shared_browser_print` once. Then call `shared_browser_tabs`, use `shared_browser_tab_select` with the preview ID, and acquire control there. Take a fresh `shared_browser_snapshot` to use the preview's setting refs and Cancel button, or capture before native input. An acknowledgement alone does not prove a preview opened. If Print reports an unknown outcome, list/select the preview without replaying Print. After Cancel or `shared_browser_tab_close`, explicitly reselect the saved original ID and reacquire control before further input.

The user Print route and shipped agent tool were verified with eight content tabs on Linux with Chrome 155 in private Xvfb: a hidden source, real preview capture, Layout change, Cancel/Close, and explicit source return preserving its unsaved draft. Cancel itself can lose its acknowledgement when its preview disappears; observe the tab list before retrying. **Existing site Print buttons remain subject to a limitation:** printing from a source behind other native Chromium tabs can open a hidden preview whose capture stalls. Selecting the source in Shared Browser alone does not activate it in Chromium. Use the controlled Print action for that case. This is real Chromium preview, not print CSS emulation or a replacement PDF export. Video preview capture, every printer setting, other operating systems, and operating-system print/save dialogs are not qualified. Do not invoke the preview's **Save**, **Print**, or **Print using system dialog** to test an OS dialog through page tools. No physical printing is needed to test the preview lifecycle.

## Runtime environment overrides

The plugin recognizes only these deployment overrides:

| Variable                                    | Meaning                                                                                                                                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_HOME`                                | Paseo data root. Defaults to `~/.paseo`; browser runtime, supervisor IPC, and profiles live below `plugin-data/shared-browser`.                                                                                                                                       |
| `PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY` | Absolute path to the pinned `agent-browser` executable. Defaults to the active runtime's `node_modules/.bin/agent-browser` (`agent-browser.exe` on Windows). |
| `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE`  | Absolute path to Chromium. Defaults to the active runtime's `chromium/chrome` (`chrome.exe` on Windows). On Linux ARM64, installation automatically links `/usr/bin/chromium`; use this override for another compatible, non-Snap location. |
| `PASEO_SHARED_BROWSER_CHROMIUM_ARGS`        | Optional Chromium arguments passed through the managed runtime. Intended for host requirements such as `--no-sandbox` in an already-isolated CI runner; do not disable the browser sandbox on a general-purpose host.                                                 |
| `PASEO_SHARED_BROWSER_GRAPHICS` | `default` keeps Chromium's normal graphics selection. `wsl-d3d12` enables hardware WebGL through WSL's Mesa Direct3D 12 driver, including with the private display. Requires WSL GPU access, a compatible Windows GPU driver, Mesa's D3D12 driver, and the WSL libraries in `/usr/lib/wsl/lib`. Startup fails if Chromium selects software rendering. |

User-supplied `AGENT_BROWSER_*` variables are deliberately ignored.

Set `PASEO_SHARED_BROWSER_GRAPHICS=wsl-d3d12` in the daemon host's environment to opt into hardware rendering on WSL. It supplies the driver and library settings only to the managed browser processes. It does not install drivers or change host display settings. The setting takes effect when a new supervisor/browser runtime starts; an already-running browser keeps its existing graphics backend. Other platforms should keep `default`. Hardware rendering does not imply hardware video encoding, which remains a separate browser capability.

For a persistent selection without changing the daemon's environment, put `{"mode":"wsl-d3d12"}` in `$PASEO_HOME/plugin-data/shared-browser/graphics.json`. New browser runtimes read this file; already-running browsers keep their backend. Use `{"mode":"default"}` or remove the file to return to normal selection. An explicit `PASEO_SHARED_BROWSER_GRAPHICS` environment value overrides this legacy file. These legacy options are read under **Host default**; the explicit UI Vulkan choice takes precedence over them. Use the UI for new graphics selections.

## Controls

- Toolbar: back, forward, reload, address bar, a combined monitor menu, mobile emulation toggle and a vertical-dots browser actions menu. The controller can close the shared browser from that menu after confirmation. Icon controls expose their action name as a hover tooltip on desktop/web and retain native accessibility labels.
- **Custom** supports 320 to 3840 pixels wide and 480 to 3840 pixels high. Invalid sizes show their error in the menu.
- Desktop presets also include 1280 × 800 (16:10) and 1280 × 1280 (1:1).
- Pixel 7 (high resolution) keeps the same 412 × 839 phone layout and input coordinates. Capture detail adjusts automatically for the active viewers.
- Desktop presets include 1920 × 1080 and 2560 × 1440 (16:9), 1920 × 1200 and 2560 × 1600 (16:10), and 1920 × 1920 and 2560 × 2560 (1:1).
- Desktop choices use height names such as 720p, 1080p, 1200p and 1440p, with dimensions shown alongside. Square choices name their width explicitly. The 1440-wide choices are 1440 × 810, 1440 × 900 and 1440 × 1440.
- Open the monitor toolbar icon, then **Display Size** for all desktop resolutions in one list, sorted by width and height. Mobile devices stay in their own submenu. Favorites and **Custom** are also available here. Filled stars mark favorites; starring a size keeps the current page size. **Quality and mode** groups live video, JPEG quality, bitrate, and frame rate. **Graphics** keeps the saved startup choice separate from the running renderer and Apply action.
- **Fill viewport** resizes the shared browser to the visible panel and follows panel size changes while this viewer controls it. It preserves mobile behavior. Following pauses when the panel is hidden, control is released, or its dimensions exceed the supported display size. Choosing a preset or custom resolution stops following; a failed resize also stops it and displays an error.
- Monitor and browser actions open anchored menus. Desktop groups use flyouts; narrow panes and native clients use Back navigation. Back stays visible while lists scroll. Menus stay within the pane and dismiss with an outside press, Escape or native Back.
- The monitor menu offers **Fit to panel** (default) and **Actual size (100%)**. Actual size uses browser layout pixels, not the larger JPEG dimensions of sharper phone captures. This choice affects only the current viewer, without resizing the shared browser. Desktop local scrollbars reveal overflow while wheel events on a controlled frame go to the remote page. Phone viewers can pan while observing; controlling sends swipes to the page instead. Fitting images stay centered without empty scroll ranges; a scrollbar on one axis does not force one on the other. Returning to Fit resets local offsets without reloading the page or image.
- With **Display options → Quality and mode → Mode → Video** saved, desktop and web clients with WebCodecs play genuine encoded tab video (H264 when supported, otherwise VP8). The bundled capture helper, which holds `tabCapture` and `debugger` permissions, is prepared when a workspace browser starts and captures the exact workspace tab when enabled, not a screenshot loop or title-selected window. Live video is off by default and is a persistent host setting, shared across that host's workspaces. No video environment variable is used. Changes take effect in the running browser without closing tabs, reloading pages or losing unsaved work. The UI shows whether video is starting, active or unavailable. Screenshots mode uses screenshots and stops unused capture; no capture page, stream or encoder is created until Video mode is selected. The helper stays installed and idle so it can start again. Video-ready browsers retain headless operation, independent of desktop focus and lock state. Optional private-display desktop hover remains available. A host can supply Xvfb privately under `plugin-data/shared-browser/native-display/usr/bin/Xvfb`; runtime preparation retains that directory and its license files with the immutable runtime. System Xvfb is also supported. Android clients running the matching Paseo fork retain acknowledged host-canvas video. This is an optional fork-host extension, not an export of the published SDK. Stock Android clients and other native apps retain JPEG. Input authority waits for the exact host paint acknowledgement and still follows the upstream source and receipt checks.
- The monitor menu's **Quality and mode** page includes **Mode: Screenshots / Video** and separates JPEG quality (40%, 65%, 85%, or 100%), video bitrate (2, 5, 12, 24, 48, or 96 Mbps), and video frame rate (15, 30, or 60 FPS). Defaults are JPEG65 (Medium) and, when video is enabled, 12 Mbps at 30 FPS. Old saved quality choices keep their corresponding video bitrate when upgraded. These are encoder targets, not measured bandwidth or guaranteed frame rates. Higher video budgets preserve more detail during movement and require a faster connection. Large JPEGs may reduce quality to stay within the 800 KB frame bound. Preferences persist on the connected Paseo host. Image detail automatically follows the highest pixel detail needed by visible clients, accounting for each device’s display scaling, image size, and local zoom. There is no manual setting. A lower-scaled client does not reduce detail needed by another active client. Hidden or disconnected clients stop contributing. Higher detail can increase bandwidth; captures use the smallest supported 1× or 2× source within the physical image limit. This changes real source pixels without changing page size, touch behavior, or user agent. Video compression and Fit resizing can still soften detail. The 3840-pixel physical bound still applies. Quality changes do not navigate or reload. See the [desktop sharpness investigation](desktop-sharpness-2026-10-19.md).

- Video packets travel through the existing authenticated Paseo RPC connection, including its relay. No extra video port or unauthenticated media server is opened. This is encoded video delivered in bounded request/reply batches, not WebRTC or a custom push subscription.
- Animated native capture supports a source ceiling of 60 frames per second. Ordinary frames follow each encoder's requested rate; a recovery keyframe can use the next eligible frame without waiting for that interval. Quiet tabs produce genuine frames around once per second; repeated packets never acquire a newer source capture timestamp. At most three bitrate/frame-rate cohorts share one source. Changing quality never evicts another active cohort. If all three are occupied, another profile uses JPEG fallback and retries video after 2.5 seconds while visible. Hiding or unmounting cancels that viewing-only retry; the soft error clears after a fresh video frame paints. Idle encoders release their buffers and codecs after two seconds without an active read; when no video consumer remains, the native track and helper also close. A returning video viewer can reacquire the source safely. Higher rates/bitrates and multiple encoders cost more host CPU and bandwidth; pixel density and the host's native codecs also affect cost.
- Hidden documents, page-cache suspension, inactive native AppState and panel unmount stop this viewer's video reads and release decoding resources. Resuming requests a fresh keyframe. One already-issued bounded RPC may finish, but cannot restore old input authority. Video remains video when the page is quiet; no idle still-image overlay or static-page polling is used. Keyframes restore decoding after a gap but do not make video lossless.
- Initial human control requires decoded and painted geometry. Once admitted, the controller's ordered input channel continues while video catches up. A click may reach a page ahead of the displayed image, as in remote desktop. Agent commands retain strict fresh-frame targeting. Document, viewport, runtime, bridge and controller changes invalidate the human admission. Dropped packets recover at a keyframe rather than decoding a broken delta chain. Video reads wait outside the input queues.
- If no fresh video is painted for 2.5 seconds, the viewer revokes video input authority and requests JPEG fallback and a fresh keyframe. The retained video remains visible until a current image has decoded, so a delayed fallback cannot flash an older view. Decoder/capture failures also retain fallback. The Video, CDP and fallback labels describe the displayed transport.
- JPEG captures refresh after input. A stalled screencast falls back to a fresh screenshot. Healthy painted video suppresses redundant JPEG polling and focus captures. Media reads use source generations without repeatedly querying page metadata inside the control queue; ordinary status checks still reconcile navigation state. Shared JPEG screencasting starts on image demand and stops after three seconds without demand. Phone/image viewers and agent captures restart it lazily; video reads alone do not keep it running. An image fallback after retirement may wait for stream startup or use the existing screenshot fallback. Repeated reads of the exact cached JPEG send metadata only; image source age still expires within one second. The last decoded image remains visible while its replacement loads.
- Reconnecting or switching browser tabs restores the selected device viewport, capture density, touch and user agent before accepting new frames.
- Actual video and JPEG dimensions must match the selected capture resolution before a frame is accepted. The fallback captures the complete visible viewport, preserves scroll position, and accounts for device pixel ratio and capture scale so inputs still use the original layout coordinates.
- The last decoded frame stays visible while its replacement loads, with native image fading disabled. Initial human admission and agent commands use the painted frame; admitted human input retains its qualified geometry while pixels catch up. Obsolete image callbacks cannot replace the displayed frame.
- Status row: session state, viewer count, controller, and lease expiry.
- Returning after viewer expiry reattaches viewing once automatically while preserving the page. Expired control is cleared; take control again to send input. Expected expiry is not shown as an action failure; a failed reattachment still offers manual retry.
- Clicking a link or submitting a form may navigate before its input reply arrives. A completed input returns the new viewing state without a false failure or repeating the action. Replaced controls, targets and uncertain sends remain rejected.
- A document change during metadata reads discards both partial observations and permits one fresh read on the same attachment within the original timeout. Repeated changes, failed reads and replacement attachments remain errors; browser input is never replayed to obtain metadata.
- Agent stale-frame errors identify initial admission or a context change during admitted input. Known receipt age is bounded to 60 seconds and uses its original clock; missing receipts report missing-or-revoked without inventing an age. These diagnostics contain no page content or authority identifiers and do not authorize replay. Initial frame admission expires after one minute for trusted agent screenshots and after five seconds for human viewer receipts. Agent viewer and idle control leases last five minutes; humans can take over immediately. Status and capture responses expose the effective agent policy, and captures include the actual frameExpiresAt deadline.
- Human control: **Take control**, **Release**, and **Take over** for explicit handoff. Agent MCP calls have no forced-takeover operation.
- With control, mouse movement forwards real hover effects and standard browser cursor changes. Wheel scrolling stays inside the browser canvas; held drags update before release. Leaving the canvas clears remote hover, while dragging beyond its edges still releases the held button.
- Hidden Linux browsers are headless by default. Opting in to a private virtual display (see Optional Linux desktop hover) supplies native desktop pointer/hover capabilities, including after switching back from phone mode.
- Native touch forwards active fingers continuously, including pan and pinch on desktop and mobile presets. Physical mouse buttons and double clicks retain their natural actions; touch never changes into a synthetic mouse gesture. Losing control, changing page or resizing cancels held input; old contacts must lift before a fresh touch can target the replacement page. No uncertain input is replayed after a failure.
- Desktop viewports show native scrollbars. Dragging a scrollbar thumb scrolls the page continuously before release. Wheel scrolling and touch panning remain available; mobile emulation retains its normal mobile scrollbar behavior.
- Click the controlled canvas to type directly on desktop and web. Shortcuts, repeat, modifier clicks and committed composition text are forwarded; other Paseo inputs stay local.
- The address-bar Browser menu contains a Send keys submenu and reconnect actions. On desktop, keys open beside the menu; on compact screens, Back returns to the parent menu. Extra keys are no longer shown below the canvas or in a separate dialog.
- On native phones and compact web layouts, Compose text in that menu opens an explicit local draft for keyboard or IME text, inserted once into the focused page field when you choose Done. Native phones have no live software-keyboard relay; compact web also keeps canvas typing. Extra keys remain available in the Send keys submenu.
- Local plain-text paste is forwarded; remote copy/cut are not synchronized to the local clipboard.
- The address-bar mobile toggle changes shared emulation while preserving the current display dimensions and capture density. Choose a resolution explicitly to change the display. Your device default applies the first time you take control, never while observing, and also preserves the current display. Narrow desktop layouts do not count as phones.
- The mobile address field keeps a full text line with compact padding. Read-only addresses stay legible while observing; taking control is still required to edit or navigate.
- Mode changes preserve the current page and unsaved fields. Sites that select layouts only at page load may need an explicit Reload. There are no click, swipe or scroll mode controls.

## Security boundary

- Paseo plugins are trusted, unsandboxed code. The plugin server, detached supervisor, `agent-browser`, Chromium, and other processes running as the daemon OS user share one trust boundary and can reach that user's files, processes, credentials, and network.
- Supervisor IPC uses a user-private Unix socket on Linux and macOS or an installation-specific named pipe on Windows, plus a token file under Paseo's user data root for every connection. On Windows, file privacy relies on the ACL inherited from `PASEO_HOME`; custom locations must remain private to the daemon user. `agent-browser` uses loopback TCP for its command and stream services on Windows, so Windows support assumes a trusted single-user host; these services are not an isolation boundary between local OS users.
- `agent-browser` IPC metadata and workspace profile directories are owner-only on POSIX systems. The plugin rejects a non-loopback CDP endpoint.
- Viewer and control tokens coordinate clients already paired to the same Paseo daemon. Plugin RPC callbacks expose no authenticated caller identity, so these human-viewer tokens are a workflow safeguard, not an authorization boundary. The stdio MCP adapter separately uses an opaque, workspace-bound credential.
- The bundled trusted video helper has tabCapture/debugger access to capture the exact workspace tab. It exposes no content scripts, site messages, network host permissions or web-accessible resources. User-supplied extensions and page media permissions remain unavailable.
- Downloads, uploads, clipboard synchronization, native passkeys and platform authenticators are not exposed by this plugin.
- Browser navigation uses the daemon OS user's network access, including local development servers. It is therefore a trusted-agent capability; this plugin deliberately does not apply a blanket loopback or RFC1918 navigation ban.

## Develop

Follow the repository's `AGENTS.md`. Runtime verification must use an isolated Paseo home, never the default daemon, active plugin installation, or signed-in profile. Install dependencies and run the following checks from this repository root:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run check
bun run test:scripts
bun run test:unit
```

The `test:tabs` and `test:graphics` native checks require explicit `PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY` and `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE` paths. Both create and clean up their own temporary Paseo home and browser profile. The hardware check also requires `PASEO_SHARED_BROWSER_GRAPHICS=wsl-d3d12`; it verifies both WebGL versions render the expected pixel on a D3D12 GPU and that the page can be captured. Run native GPU checks sequentially to avoid competing for graphics resources.

`node scripts/test-image-capture-mounted.mjs --tooling-root /path/to/test-workspace` opt-in checks the real React/React Query image scheduling and viewing recovery hooks in JSDOM. The tooling workspace must already provide compatible React, react-dom, jsdom, React Query and esbuild. The plugin intentionally does not add these DOM test dependencies or install missing packages. Omitting `--tooling-root` uses this checkout if its dependencies include them. The command owns and removes temporary hook bundles; it never launches or accesses a browser/runtime or profile. For reproducible mounted checks, create a disposable tooling workspace with React and react-dom 19.1.0 (matching this repository's React version), jsdom 30.1.1, React Query 5.102.3 and esbuild 0.28.2. jsdom requires Node 24.15 or newer on the supported Node 24 line. These are test-only dependencies, not plugin runtime dependencies. For example:

```bash
npm install --prefix /tmp/shared-browser-dom-tools --ignore-scripts --no-save \
  react@19.1.0 react-dom@19.1.0 jsdom@30.1.1 \
  @tanstack/react-query@5.102.3 esbuild@0.28.2
node scripts/test-image-capture-mounted.mjs --tooling-root /tmp/shared-browser-dom-tools
node scripts/test-panel-video-mounted.mjs --tooling-root /tmp/shared-browser-dom-tools --fixture settlement
```

The panel fixture also accepts `handoff`, `rapid`, `continuous` and `admission`. Run each variant for changes to media handoff or input policy. The `settlement` fixture checks late replies across viewer and controller replacement. Delete the tooling directory when done.

Automatic display reporting is covered by `client/browser-display-demand.test.ts` and `client/browser-display-scale.test.ts`, including observer demand, attachment replacement, unmount cleanup, local zoom, and monitor scaling changes without a window resize.

Prepare runtime assets with an explicit temporary `PASEO_HOME` before either browser gate. Keep that directory outside the default Paseo home. For example, on POSIX systems:

```bash
export PASEO_HOME="$(mktemp -d -t shared-browser-verification-XXXXXX)"
bun run prepare:runtime
bun run test:smoke
bun run test:video
```

Remove the temporary directory after verification. On Windows, use a new explicit temporary directory in `$env:PASEO_HOME` instead. Tests manage their own browser teardown; do not run daemon lifecycle commands against the default host to recover a test failure.

`bun run test:smoke` launches the configured real Chromium runtime and exercises two viewers, control handoff, reconnect, stale-frame rejection, viewport changes, device emulation, profile persistence, and archive teardown.

`bun run test:video` is an optional real video gate. It opts its own runtime into encoded video and reads prepared Chromium/CLI assets, then creates its own temporary Paseo home, browser profile, Unix socket and local fixture pages. It checks the production video decoder and canvas at 1280x800, sharp Pixel and 2560x2560, including all four corner markers. It never uses the live browser. This gate requires usable WebCodecs/tab capture and the local runtime assets; it is separate from unit tests. Linux CI requires Xvfb and runs this video gate without skipping unsupported capture. macOS and Windows run the image/browser smoke; their native video hardware and remote-network performance require separate qualification. CI also runs the actual Paseo compiler on both plugin entries.

This repository preserves the upstream package version and changelog. CI validates this fork; it does not publish npm packages or create releases. See [migration notes](standalone-migration.md) for source history and upstream contribution instructions.

Both the Paseo daemon and app must satisfy `^0.11.0` or the retained explicit `0.11.0-beta.3`, `0.11.0-beta.4`, or `0.11.0-beta.5` allowances. Encoded video is opt-in on the daemon and requires WebCodecs in a web client or the matching Android fork-host surface; JPEG is always available. The client surface uses React Native primitives and works in desktop, web, iOS, and Android Paseo clients.

Every independent press (mouse down or first touch contact) carries the decoded frame receipt that was visible when it was made. Human receipts last five seconds and are spent by acknowledged input, so a stalled or superseded presentation cannot admit a later click; held drags, releases and keys continue on their channel. A wheel capture can finish decoding after input revoked its frame token. The server returns a known non-admission receipt before creating a new channel; the canvas waits for another decoded frame before admitting that still-unsent gesture. Recovery allows up to three admission attempts within one four-second decoded-frame wait budget. Published input, unknown outcomes, expired leases, and replaced contexts are never retried.


## Maintainer references

[Streaming design](../STREAMING_DESIGN.md) documents media ownership, resource bounds, input admission and recovery. [Remote-control research](../REMOTE_BROWSER_RESEARCH.md) records primary-source comparisons and the trade-offs behind continuous human input. These describe the implementation's guarantees, not a promise of a particular frame rate or remote-network latency.


## Optional Linux desktop hover

Production browsers prepare live-video capability in modern headless Chromium, including while Screenshots mode is selected. Capture remains idle until Video mode is selected. No visible window opens, and switching video does not change display mode or depend on desktop focus or lock state. Default graphics mode retains the software WebGL fallback used by image-only headless Chromium; explicit WSL hardware mode still requires its selected GPU renderer.

For Linux desktop pointer/hover behavior, the existing `PASEO_SHARED_BROWSER_XVFB=1` opt-in and trusted `virtualDisplay: true` embedding override retain a private, authenticated display. An explicit `virtualDisplay: false` overrides that opt-in. System Xvfb and the host's privately supplied Xvfb runtime are supported. The display is stopped with its browser; no visible window, TCP or pathname listener is created, and the plugin never changes host display settings.

If the display cannot start, the browser falls back to headless and the viewer shows a short notice (for example "Private display unavailable: Xvfb was not found."). The notice never contains paths or credentials. If an opted-in display dies while running, requests fail and the viewer shows an error; use **Reconnect viewer** to replace the browser. Reconnect discards the old runtime and starts a new one, so the page reloads from its initial URL, and old viewer, control and input attachments are rejected. Nothing is replayed automatically.

Known limitation: if the supervisor is killed with SIGKILL it cannot stop its child, so an orphaned Xvfb process and its private authority directory under the temporary directory can remain until removed manually.
