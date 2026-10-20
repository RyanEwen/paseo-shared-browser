# Agent cursor and print preview investigation

Investigation date: October 20, 2026. Production Shared Browser, its supervisor, and the user desktop were not changed. No version, dependency lock, or release changes were made.

## Agent cursor verification

Agent presence is display-only and uses the trusted controlling agent label. Native acknowledgements report the real pointer position. Semantic click/hover acknowledgements report the measured visible target point, with a target marker rather than fabricated mouse travel. Offscreen or obscured semantic targets produce no point. Click pulses clear when the pointer moves away. Presence expires after five idle seconds and clears when ownership, document, geometry, runtime, or bridge changes.

The existing JPEG capture and video replies carry presence to observing clients. JPEG normally polls every 250 ms; native video waits at most 500 ms before returning state, with a 40 ms pause on empty reads. Focused policy tests verify that observers receive a 900 ms click pulse through both paths. A real Chromium test verifies native clicks, a separate image observer, clipped semantic targets, offscreen suppression, video observer state, and navigation clearing.

The [rendered cursor component fixture](cursor-component.png) uses the production component with existing React Native Web and a Lucide icon adapter in isolated Chromium. It shows native activity on the left and semantic activity on the right. This is component-level visual proof, not full Paseo host or native mobile acceptance. Client tests also verify frame-coordinate mapping, obsolete-frame rejection, local elapsed-clock expiry despite wall-clock skew, and ownership clearing.

Validation: frozen dependency install, check, build, typecheck, 14 script tests, and 1,017 unit tests passed. Two real MCP DOM/focus smoke tests and one focused real pointer smoke test passed. The finished source was staged through `scripts/dev-daemon.sh` into a fresh isolated daemon, where the plugin reported running without an error. The isolated daemon and private compositor were stopped after verification. Changes remain uncommitted.

## Real print preview

Isolated Chrome 155.0.8059.84 was prepared through `scripts/dev-daemon.sh up` using a separate Paseo home and an explicit loopback host. Headless `window.print()` produced no preview target; the browser stayed connected and its original page remained readable and capturable. This did not reproduce a browser crash.

A headed browser on an invisible private Wayland compositor produced the [real Chromium preview](chromium-print-preview.png), including its rendered page and destination, pages, layout, and cancel controls. The compositor used the existing `shared-browser-weston-qualification:20261019` container image, with no host dependency installation or shared display/input. This image is local test infrastructure, not a deployment dependency.

The preview is a `page` target at `chrome://print/`, with a child PDF `iframe` at `chrome-untrusted://print/.../print.pdf`. Therefore, the existing page-target filter does not omit this preview. Both the original page and preview acknowledged direct CDP screenshot requests. Existing runtime attachment, viewport emulation, and native mouse movement also acknowledged on the explicitly selected preview target.

The preview has neither `openerId` nor a source `parentId`, and `window.opener` is null. Requesting all targets, including `tab` targets, adds no source relationship. `Browser.getWindowForTarget` returns `Browser window not found` for the preview. Selecting a preview by its title, URL, or creation order would guess the source relationship when independent tabs print concurrently.

Chromium maintains the initiator relationship internally in [`PrintPreviewDialogController`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/printing/print_preview_dialog_controller.cc). The [CDP Target contract](https://chromedevtools.github.io/devtools-protocol/tot/Target/) describes target metadata; these observations apply to the tested binary rather than all Chromium versions.

## Accepted preview selection

Ryan approved explicit real-preview selection in an opted-in private headed session. The existing Graphics picker now includes Private desktop on Linux, backed by authenticated Xvfb. Default headless behavior is retained. Explicit private-desktop startup fails if the display is unavailable. Preview targets receive a clear title in the existing tab list and agent tools. Up to eight normal pages plus their transient previews fit the bounded list contract.

Native click opening synchronous `window.print()` withheld its acknowledgement until the existing 15-second CDP bound, returning UNKNOWN_OUTCOME. Chromium remained alive and the preview could then be listed and explicitly selected. Semantic snapshots were extended to traverse rendered slots because Chromium supplies its preview selects through open shadow-root slots. Preview selection, screenshot, Landscape selection, and Cancel acknowledged on the native-front source setup. Neither unknown input nor a visible preview is treated as proof that the triggering input succeeded, and no action is replayed.

The [lifecycle screenshot](lifecycle-preview.jpg) was captured through the public human-viewer route on private Xvfb. Chromium's printed date header uses the isolated browser's UTC clock. The shipped stdio MCP entrypoint passed agent list/select/control/snapshot, Layout change with `landscape` readback, Cancel, explicit source return, a second agent-triggered print, second preview capture, and return after a human Close tab action. The original unsaved draft remained intact and its counter recorded exactly two openings for the two requested prints. Cancel can destroy its target before the action reply arrives; the test observes exact target removal without replaying the uncertain action. Close tab uses Chromium's real Cancel control and confirms removal before releasing its controller, including a previously unattached preview.

Current validation: frozen install, check, build, typecheck, 14 script tests, and 1,029 unit tests passed. Both final controlled-print private headed lifecycle cases passed in 11.95 seconds combined. This qualifies the tested user and agent eight-tab screenshot and Layout/Cancel/Close flow, not all print controls or the site's own Print buttons.

Final implementation was staged with `scripts/dev-daemon.sh` into its isolated Paseo home at explicit host `127.0.0.1:35145`. The plugin reported `running` without an error. Only owned verification services were stopped afterward; the active user plugin, supervisor, browser, and desktop were untouched. The Progress connection remained unavailable and the canonical laptop papercuts file was not mounted, so neither was replaced with a separate tracker or log.

## Controlled Print and remaining page-button limit

With eight normal pages open, printing from a source behind the newer native Chromium tabs leaves its preview hidden. The preview remains listed and the original remains present, but its screenshot times out. An exact-preview `Page.bringToFront` attempt on an owned private display did not resolve capture; that ineffective experiment was removed. No source association or activation heuristic was retained.

Ryan approved the recommended explicit controlled Print action/tool with "Yes". Actions → Print and `shared_browser_print` use one typed RPC contract and the existing control-acquisition path. Eligibility comes from the runtime owner's live private-display handle, never a headed flag or a guessed environment. The runtime pins the selected source's document, creates an isolated world in its exact frame, brings that source forward inside the private display, and invokes built-in `window.print()` once. A missing display or changed source fails before publication. Unknown outcomes remain explicit and are never replayed. Preview discovery and source return still require explicit selection.

Both user-route and shipped stdio MCP cases passed with eight content tabs. The fixture temporarily removes only its source's focus-emulation override to verify actual native `hidden` visibility, then restores the product setting before Print. Each case selected and captured the real preview, read back Layout as `landscape`, cancelled through the agent or closed through the human route, and explicitly returned to the original unsaved draft. All eight original target IDs remained. Each requested print emitted exactly one native `beforeprint` event, and an adversarial replacement of the main world's `window.print` never ran. The [controlled-preview screenshot](controlled-preview.jpg) comes from the public capture route; its native printed date header is UTC. This qualifies the controlled trigger for the tested private Xvfb setup. Existing site Print buttons retain the hidden-source limitation above.

Primary contracts checked during this work: [CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/), [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/), [focus emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/), and the [HTML printing algorithm](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#printing). Native lifecycle evidence above establishes the behavior of the tested binary.

No automatic source routing, default display change, PDF export substitute, or CSS emulation was added. Operating-system native print/save dialogs are separate desktop UI and were not captured or tested. No physical print job was sent.
