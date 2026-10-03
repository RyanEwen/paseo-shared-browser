# Shared Browser interaction and display fork

This branch is rebased onto upstream main `d7b3e654` (Shared Browser 1.2.0). It is uncommitted and has not been submitted as a pull request. Dependencies
retain the repository catalog declarations. Runtime assets, browser profiles,
credentials, local backups and application data are excluded.

## Changes preserved

- Display sizes through 2560 by 2560, desktop aspect ratio presets, 1280 by 800
  and 1280 square presets, and a sharper Pixel capture mode.
- Higher capture quality, exact capture dimensions, reconnect restoration,
  stable capture transport and decoded frame buffering.
- Physical hover, cursor feedback, wheel, right and double clicks, continuous
  mouse dragging, native scrollbar dragging and genuine touch gestures.
- Natural input without click or drag mode selectors, with preserved keyboard,
  text, navigation, display and control lease surfaces.
- Ordered gesture channels, bounded pressure, cleanup on lost ownership and
  safe recovery of stale gesture admission. Published actions are not replayed.

## Validation

The combined registered suite passed 226 tests, including native relay, viewer
recovery, acknowledged-navigation, menu and local-view sizing additions. Actual Chromium checks verified trusted native keyboard
input, Unicode, repeat, shortcuts, focus traversal, Ctrl+click and key release.
Quality 70, 90 and 95 produced distinct 9,868, 11,131 and 11,951-byte frames on the
same isolated page. Mounted tests separately cover DOM keyboard/composition,
preference revision conflicts, observer safety and first-control device defaults.
The actual Paseo client/server compiler and mobile Hermes compiler passed.
The loaded runtime also rendered the signed-in nine-printer fleet. Low, Medium
and High captures returned distinct 93,155, 149,326 and 198,233-byte JPEGs, each
1280 by 800 pixels, before restoring the earlier square display.

These checks use disposable profiles and fixtures. They do not establish human
pane forwarding or physical-phone software-keyboard behavior. The user confirmed
native scrollbar dragging in the real pane. Discrete MCP retains strict stale
frame validation and does not exercise the human pane gesture queue.

## Native desktop hover capability

Chromium headless desktop currently reports no pointer or hover capability.
Media-query-gated hover styles therefore do not activate on every control.
Startup Blink settings cannot restore those capabilities after touch emulation
is disabled. Preserve page state: do not reset the page on device changes or
compensate with application CSS. Hidden Linux runtimes now use an authenticated,
owned Xvfb display when the existing executable is available. It supplies genuine
embedder mouse preferences, so desktop -> phone -> desktop and CDP reconnect
retain the correct pointer/hover media. Abstract-only Unix transport avoids WSLg's
protected pathname sockets; TCP and host display access remain disabled. Startup
fallback is allowed only after full display cleanup and before Chromium exists.
Missing Xvfb and other platforms retain their existing behavior; they are not
covered by the Linux capability correction.

## Upstream reconciliation

| Upstream change | Reconciliation |
| --- | --- |
| #263 pointer mapping | Reuse upstream contained geometry helpers, retain capture-scale-aware coordinates and decoded-frame authority. |
| #264 frame settlement | Preserve the upstream discrete-input epoch gate and regressions; gate on decoded frames. Use a factory so the actual mobile Hermes compiler accepts the client bundle. Continuous input keeps its ordered channel. |
| #266 viewport resync | Integrate one bounded reapplication of saved emulation for valid dimension mismatches, using capture scale rather than device pixel ratio. Malformed JPEG and superseded capture remain rejected. |
| #258 sidebar and OMP MCP | Retain upstream sidebar, capability guards, entrypoint and tests. |
| #248 Paseo compatibility | Retain stable 0.11 support and the specifically tested 0.11.0-beta.3 allowance. |
| Release metadata | Keep upstream version 1.2.0 and catalogue dependencies; do not publish an independent release. |

Input limitations and primary references are in [input-forwarding-notes.md](input-forwarding-notes.md).
Keep runtime assets, browser profiles, machine-specific paths and backups outside
the source diff. Changes remain uncommitted for review. The original pre-rebase
stash remains a recovery backup; it is not a pending patch to apply again.

## Toolbar and completed-input follow-up

The toolbar now owns mobile emulation, favorite resolution selection and the
browser action menu. Bottom favorite, emulation and key rows are removed.
Favorite indicators use paired filled/outline star glyphs because the host Icon
API exposes stroke only. No selected raised surface is used for the star button.

Post-update daemon logs contained viewer expiry, stale navigation and live input
attachment changes. Isolated real Chromium reproduced a completed click that
navigated but returned a stale-navigation failure. Completion now accepts only
acknowledged publication plus a document navigation on the same attachment,
closes the old gesture and returns fresh viewing state. Unpublished and uncertain
commands, replaced controls, viewports, runtime targets and bridges still fail.
A separate actual Enter form-submit test confirms one submission and released
held keys. The shared browser is never used for these write-capable fixtures.

The completed-input follow-up also passes mounted desktop/compact toolbar,
filled-star preference and native keyboard request checks. Mounted keyboard and
touch fixtures confirm held inputs are quarantined until physical release after
acknowledged navigation. Old-document continuations are discarded; no action is
replayed and no obsolete channel-end request is sent. Independent regression
checks retain refusal of a target replacement after publication.

## Combined toolbar menus and local view sizing

The monitor control combines favorites, the full resolution/quality list and
local Fit/Actual size selection. The vertical-dots browser menu contains actions,
without duplicated resolution access. Both use one shared anchored-menu surface
with bounded placement, keyboard focus and dismissal. Only public RN primitives
and themed SDK icons are used; the SDK has no public inline menu API.

Actual size preserves canonical CSS layout dimensions and decoded frame slots.
Image and input overlay share one geometry, including high-density captures.
Desktop uses one scroll host so both local scrollbars stay at the pane edges.
Native observation permits local panning; active control reserves gestures for
the remote page. Scale selection is local to the mounted viewer, and changing
scale cancels held remote input. The browser page and shared resolution persist.

The combined follow-up passes 226 registered tests, four mounted toolbar/canvas
cases, TypeScript, the actual Paseo compiler and the mobile Hermes compiler.
These validate rendering structure, focus, local scroll styles and input mapping;
they do not certify physical-phone native panning or software-keyboard behavior.

## Mode-only display preservation and key submenu

The mobile toggle and the first-control device default now retain the current
CSS viewport dimensions and JPEG capture density. The policy resolves these
values under the session lock, cancels held input, and invalidates old frames
even when dimensions do not change. Explicit resolution presets retain their
full display behavior. Preset checkmarks and the frame label require an exact
display and capture-density match, preventing a remembered behavior profile
from incorrectly claiming a selected resolution.

Send keys is a nested toolbar menu, not a separate dialog. Desktop uses a
bounded flyout; compact/native clients use a Back row. One backdrop owns outside
dismissal. Keyboard navigation scopes each menu level, returns to the parent
trigger, and retains the existing command guards and dispatch callback.

The combined registered suite passes 236 tests. Disposable Chromium confirms
unchanged 1280 x 800 mode switches and preserved 824 x 1678 sharp captures,
with page drafts intact and no reload. Seven mounted mode-hook cases and five
mounted submenu cases cover ownership, pending/stale callbacks, keyboard
hierarchy and single command dispatch. TypeScript, the actual Paseo compiler
and the mobile Hermes compiler pass. Human host-pane interactions still need
direct observation; browser MCP images cannot establish their behavior.

## Actual-size bounds, native hover and frame delivery

Actual size now sizes the canvas to the remote CSS dimensions and lets the scroll
host center it. An outer border or a single scrollbar no longer creates overflow
on the other axis. Container size changes cancel held input because recentering
can move the frame origin without changing its CSS dimensions. Disposable
Chromium measured 16 before/after cases covering fitting and exact-edge frames,
fractional borders, each overflowing axis, classic and zero-width scrollbar
geometry, edge reachability, sharp captures and pointer mapping after panning.
These use the public React Native Web CSS shape, not a physical phone.

An owned private Linux display supplies genuine desktop hover, including after
phone emulation and CDP reconnect. The actual authenticated runtime preserves a
page draft through those switches and produces 824 x 1678 sharp phone and
2560 x 2560 desktop captures. Activating this launch change for an existing
headless browser requires one browser restart; later mode switches do not reload
the page. Missing Xvfb and other platforms keep their existing behavior.

Frame polling reuses only the exact runtime receipt under matching session,
runtime, bridge, navigation, viewport and quality authority. Repeated cached
frames return metadata instead of sending the JPEG again. Runtime age and
new-capture invalidation remain enforced. A disposable idle-page fixture reduced
three repeated poll payloads by 72.94%, without changing image quality. Fresh
page metadata reads run concurrently under attachment/document guards. The
measured median was 3.434 ms before and 2.121 ms after; guarded input median was
16.971 ms before and 15.504 ms after, with no established tail-latency improvement.
This remains JPEG-frame transport, not an encoded video stream or a frame-rate
claim. A memoized image leaf also avoids decoding/rendering unchanged visual
props on unrelated parent updates.

The compact address field removes excess vertical padding and stays at full
contrast while observing. Its control and navigation permissions are unchanged.

The registered suite passes 264 tests. Four mounted toolbar/canvas checks and
two mounted image authority/memoization checks also pass, as do TypeScript, the
actual Paseo compiler and mobile Hermes compiler. Linux fixture checks prove
native hover and display lifecycle; human host-pane performance and physical
native-phone input/layout still need direct observation.
