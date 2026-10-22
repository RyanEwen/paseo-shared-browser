# Shared Browser project handoff

Shared Browser is maintained in this standalone repository. The previous local `paseo-plugins` project and its feature worktrees were retired at the owner's request on 2026-10-16. The upstream monorepo and the original GitHub fork were not deleted. See [standalone migration](standalone-migration.md) for the original commit mapping and instructions for future upstream contributions.

## Feature decisions

Keep all existing fork features active, including Android video, direct native keyboard input, the agent device tool, WSL graphics, explicit agent recovery, and independent browser tabs. Adopt compatible upstream fixes and defaults; upstream deferral of a feature is not permission to remove it here.

Trusted agent attachment selects a 60-second screenshot receipt and five-minute idle control and viewer leases. Public viewer attachment keeps its existing 5-second frame, 30-second control, and 45-second heartbeat policy. Never infer agent trust from a label. Receipt authority is separated between human and agent observations of the same cached frame. Human takeover remains immediate, and navigation, viewport, document, runtime, attachment, and control fences still apply. Native gesture cleanup has a separate five-second idle timer; it does not reduce the agent screenshot lifetime. Effective policy is exposed in agent state and descriptions.

## Independent native windows and tab closing

Ryan approved one invisible native window per content tab to satisfy browser-side WebAuthn visibility without changing independent viewer selections. The hidden window manager uses exact debugger/native-tab identity, preserves existing browsing contexts and opener relationships, and excludes capture helpers and print previews. No new extension permissions are required. Headless and owned private displays are supported; real-desktop headed launches are rejected before starting Chromium. Keep image-only raster policy separate from idle extension availability.

Safe identity/state/tab observations can recreate the hidden manager and its browser-management connection only while the original nonce-owned browser is alive. This remains possible after the launch content tab closes. Never adopt a survivor as the root page, replace the process, or replay an uncertain action during recovery. Input fails closed until native target readiness is known.

Ordinary tab closure requires an active viewer and exact runtime/tab/selection fences, with explicit human confirmation, but does not require control. Final-tab closure still requires control and explicit `last-tab` scope, and preview survivors still refuse browser shutdown. Cleanup before close publication must be reversible if authority expires; permanent controller retirement follows confirmed target disappearance.

The [focus investigation](page-focus-investigation.md) records Linux Chrome 155 headless/Xvfb/Wayland admission, popup identity, independent capture, management-loss recovery and real print/close evidence. It also records the immediate-script popup race, untested real passkey enrollment and native cross-platform limits, zero measured colour change from HEAD without a fidelity claim, and an unchanged-HEAD forced-screencast recovery failure. Do not describe that full retained smoke suite as passing.

## Frame freshness and error recovery

Healthy empty video reads cannot renew painted-frame input authority. The existing 2.5-second watchdog requests fresh image/video pixels before the human five-second receipt expires, keeping old video visible only until the exact replacement decodes. Do not extend frame TTLs, relabel source timestamps or replay clicks to hide freshness failures. The [frame investigation](stale-frame-investigation.md) records the exact age5126 reproduction, layered native/policy/mounted proofs and unresolved live capture trigger.

Notices are dismissible per occurrence and panel scope. Relevant successful actions clear only the failure they observed at publication; old success must never hide a newer failure. Dismissal changes presentation only. Native passkey chooser capture/input remains a separate pending decision; focus admission alone does not qualify complete passkey interaction.

## Mobile tab placement

View size (Fit to panel or Actual size) is a client-session choice for each exact host/workspace pair. The installation's query cache retains it across panel remounts without fetching or saving host settings. Other connected clients keep independent choices. Unloading the plugin or restarting the app clears this session-only preference. Keep view size separate from browser viewport/device dimensions and the explicitly controlled Fill viewport action.

The mounted `--fixture view-size` check in `scripts/test-panel-video-mounted.mjs` covers workspace leave/return and prop-only switches, both Actual and Fit, host/client isolation, and retention with immediate collection of ordinary inactive queries. It runs the production panel/menu/cache without browser mutations. Use the same `--tooling-root` convention as the layout fixture below.

The tab row follows the panel's existing touch-first policy: `layout.platform !== "web" || layout.compact`. All iOS and Android hosts, including wide tablets, place the page title and display status bar above the canvas, followed by tabs and then the address toolbar below the canvas. Compact web layouts do the same; other web layouts keep tabs above the address toolbar and the title/display status below the canvas. The host supplies `layout.compact`; this plugin does not introduce a width breakpoint or infer mobile from the remote browser's emulation settings.

Touch-first tabs fill the available list width and shrink as tabs are added, stopping at their existing compact/regular minimum widths (132/176 for other tabs, 200/230 for the selected tab and its actions). The list scrolls only when those minimums no longer fit; the new-tab button stays outside the scroll area. Desktop tabs retain their fixed widths.

Bottom tabs and toolbar stay in the panel's normal flex flow, with a top separator on the tabs. Toolbar menus use the existing measured placement to open upward when there is more room above the trigger. Their height does not shrink, and the mobile canvas can shrink below its usual minimum when the host assigns a shorter panel, including keyboard-driven resizing. The tab row does not pin to the physical screen or add its own safe-area inset: host panel bounds remain responsible for system safe areas and keyboard avoidance. The SDK supplies no panel inset value. Existing native typing and Compose controls retain their lifecycle and ownership checks. Actual keyboard overlay/resizing and device safe-area behavior still require host/device verification.

The isolated mounted harness checks title/display, canvas, tab and toolbar order, separator/minimum-height styles, selected-tab accessibility, and available actions with production panel logic and DOM leaf doubles. Run `node scripts/test-panel-video-mounted.mjs --tooling-root <existing-host-tooling-root> --fixture tab-layout`, adding `--compact` and/or `--platform ios|android` for touch-first cases. It does not connect to a daemon or browser session, and JSDOM cannot qualify physical layout or native safe areas.

## Runtime and deployment lessons

Plugin reload replaces the bridge, then reconnects to an existing detached supervisor. It does not activate supervisor or capture implementation changes. A runtime replacement can close browser sessions and lose unsaved page state; obtain explicit approval for that concrete disruption after inventorying all supervisor-owned sessions. Never restart Paseo or unrelated agents to activate this plugin.

A previous JPEG failure followed a resolution change: the current schema allowed 800,000 bytes while an older detached supervisor emitted larger frames under the same protocol version. Validate the exact plugin/runtime combination in an isolated home. A protocol compatibility preflight before disconnecting the working bridge remains a future safeguard, not a completed migration feature.

The retirement source cutover changed only the registered plugin directory. It verified the same daemon, supervisor, immutable runtime, browser processes, and tab identities and URLs before and after bridge reload. Future development must use the isolated helper documented in AGENTS.md; this one approved cutover does not authorize further production lifecycle operations.

## Validation baseline

The standalone baseline passed 784 unit tests, five script tests, build, typecheck, lint, and shrinkwrap checks. Linux, macOS, and Windows CI passed, including Linux native-video capture/decode. The exact GitHub-install path was also exercised on an isolated daemon and cleaned up.

- [Standalone CI run](https://github.com/RyanEwen/paseo-shared-browser/actions/runs/38944617359)
- Baseline commit: `adfee6820601412eb3fda5f9a252da63de1e431f`
- Original snapshot commit: `c72ef42331d2476961da3a06421a56e5662ef991`

The old fork's two OMP compatibility nightlies were disabled at the owner's request. Do not transplant those unrelated workflows into this repository. Package identity and runtime ID remain compatible; no npm release was requested.

## Local recovery and conversation history

The ignored `.local-history/paseo-plugins-2026-10-16/` directory holds a verified Git bundle of all old references and both unfinished-merge parents, binary staged/unstaged patches, untracked source archives for all six old checkouts, provenance, policy verification receipts, and private project handoff details. It includes unfinished Feature Kickstart work, which is not part of this plugin. The bundle was independently cloned and its commit connectivity checked. This archive is local recovery data and must never be committed or uploaded.

Old workspace and agent conversations remain archived in Paseo. Their IDs and restoration instructions are recorded in the private handoff. Use the new Shared Browser project for future work, and recover a monorepo checkout from the bundle only when a separate task requires it.
