# Page focus and ordinary tab closing

Implemented and qualified locally on October 22, 2026 with Linux Chrome 155.0.8059.84, revision `5869fe313571d75152b77813cf0a4ee26a4e6df0`. Ryan approved separate invisible native windows per Shared Browser tab. The original window/tab-close changes were subsequently deployed to this host. Later frame-freshness and error-notice work is described in the [follow-up investigation](stale-frame-investigation.md); native passkey-dialog interaction remains a separate pending decision.

## Exact failure and cause

Before the change, the isolated secure-localhost fixture in `tests/browser-webauthn.smoke.test.ts` reproduced the user's exact rejection after opening another native tab:

```text
NotAllowedError: The operation is not allowed at this time because the page does not have focus.
```

The original page still reported `document.hasFocus() === true`, `document.visibilityState === "visible"`, and a secure context under production emulation. The matching Chromium revision checks browser-side `WebContents` visibility for WebAuthn admission, separately from renderer focus emulation. See the pinned [Chrome focus delegate](https://github.com/chromium/chromium/blob/5869fe313571d75152b77813cf0a4ee26a4e6df0/chrome/browser/webauthn/chrome_web_authentication_delegate.cc#L232) and [WebAuthn admission](https://github.com/chromium/chromium/blob/5869fe313571d75152b77813cf0a4ee26a4e6df0/content/browser/webauth/authenticator_common_impl.cc#L1248). Renderer focus alone did not satisfy that browser-side check.

## Approved window model

Each content tab now occupies its own inactive native window inside the same owned browser/profile. Explicit tab creation requests a background window. Existing/restored tabs and site-created popups are reconciled by a hidden trusted extension page using exact debugger-target-to-native-tab identity. [Chrome's windows API](https://developer.chrome.com/docs/extensions/reference/api/windows#method-create) moves the existing tab with `tabId` and `focused:false`; it does not recreate or navigate the page. The existing `debugger` permission supplies the [target mapping](https://developer.chrome.com/docs/extensions/reference/api/debugger#method-getTargets), with no new permissions or URL-based content selection.

Hidden capture helpers and real print previews are excluded. The page picker retains content target IDs, order and counts, and viewer selections stay independent. The manager does not start video streams or encoders. Stable capture/input reads use cached readiness; tab events invalidate it. Ambiguous identity, unavailable helpers and unconfirmed moves refuse access. Creation whose native readiness cannot be confirmed reports an unknown outcome so callers observe before creating another tab.

The browser-management connection can recover on safe identity/state/tab observations after its hidden helper or transport is lost, including after the original launch tab was closed. Recovery requires the original nonce-owned browser process, attaches no replacement content page, and never replays input or starts a replacement browser. Missing selected pages remain refused. Explicit headed launch without an owned private display is rejected before process launch, preventing foreground windows on a real user desktop.

## Real Chromium proof

`tests/browser-webauthn.smoke.test.ts` passes in headless, private Xvfb and private Wayland modes. Each independent window submits a real `navigator.credentials.create()` request that reaches the fixture's own 500 ms abort (`AbortError`). This proves admission past the reported focus rejection. No account, real credential, virtual authenticator, focus shim or security-check override is involved. Real authenticator enrollment and account passkey completion remain untested.

`tests/browser-window-lifecycle.smoke.test.ts` passes in all three modes. It covers shared profile cookies/storage, separate native window identities, independent JPEG and encoded video sources, bounded pointer input, existing-tab reconciliation and hidden-manager recreation. A real `window.open('', 'retained-popup')` preserves its original native target ID, `window.name`, opener/WindowProxy relationship and unsaved draft after relocation. Closing the launch tab and dropping its management transport still permits safe production identity/state requests, native input and JPEG on surviving tabs, without activation, navigation or adopting a survivor as the root page.

Both human and shipped agent Print routes pass in private Xvfb with eight content windows, real preview capture, Layout changes, Cancel/Close and draft-preserving source return. `tests/browser-close.smoke.test.ts` and `tests/browser-close-refusal.smoke.test.ts` cover ordinary human/agent close without control, retained survivor control, final-tab refusal without control, final shutdown/reopen/site-data retention, and usable root/attached targets after close authority expires during reversible cleanup.

The mounted `tab-close` and `tab-close-last` variants of `scripts/test-panel-video-mounted.mjs` prove observer confirmation without control acquisition, survival of another controller's handoff, and retained final-close control prompting. These use DOM leaf doubles and do not qualify native host presentation.

## Capture colour comparison

The same synthetic red/blue video fixtures were decoded with production packet colour metadata on unchanged HEAD and this implementation. Each sampled RGB vector matched exactly, with maximum per-channel change zero in all three modes:

| Mode | HEAD and current red | HEAD and current blue | Maximum change |
| --- | --- | --- | --- |
| Headless | `[255,29,3]` | `[0,13,248]` | 0 |
| Private Xvfb | `[255,29,3]` | `[0,13,248]` | 0 |
| Private Wayland | `[235,0,3]` | `[3,0,245]` | 0 |

This establishes no new measured colour drift and correct independent capture sources. It is not exact colour-fidelity acceptance: the baseline vectors already differ from the fixture colours. The separately qualified Vulkan colour policy is unchanged.

## Qualification limits

Relocation of site-created tabs is asynchronous. Ordinary interaction after settled creation is covered; a script that calls WebAuthn immediately in the same handler as `window.open()` can run before relocation and is not guaranteed by this fix. Opener relationships and drafts are preserved rather than rewriting `window.open()` or recreating pages. Native Windows/macOS behavior, actual account enrollment, video print-preview capture and operating-system print/save dialogs remain unqualified.

The broader retained smoke run exposed an existing forced-fallback recovery failure in `tests/browser.smoke.test.ts`: after the test forces screenshot fallback, the expected `cdp-screencast` recovery remains `screenshot` at its ten-second deadline. The identical failure reproduced with unchanged HEAD runtime source. It remains unresolved and the full retained smoke suite is not claimed green. The identity fixture retains its exact UA/client-hint assertions and now waits for its own script readiness after navigation commit.

Final scoped verification passed locked dependency installation, check/build/typecheck, 1,080 unit tests, 14 script tests, both mounted close flows and 13 real Chromium cases across the focus, window lifecycle, print, close, close-refusal, native identity and background-input suites. The metadata race fixtures now wait for native reads to enter instead of assuming a fixed number of microtasks; their original deadlines and identity-refusal assertions remain intact.

## Reproduce in isolation

Start `TMPDIR=/tmp scripts/dev-daemon.sh up`, then supply its printed home/host and explicit existing runtime binaries:

```bash
PASEO_HOME=<isolated-home> \
PASEO_HOST=<isolated-host> \
PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY=<absolute-agent-browser-path> \
PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE=<absolute-chromium-path> \
PASEO_SHARED_BROWSER_TEST_XVFB=<absolute-Xvfb-path> \
PASEO_SHARED_BROWSER_TEST_ASSETS_HOME=<home-with-verified-Wayland-assets> \
node_modules/.bin/vitest run tests/browser-webauthn.smoke.test.ts tests/browser-window-lifecycle.smoke.test.ts --maxWorkers=1 --testTimeout=120000
```

Fixtures create and remove their own temporary profiles, displays and IPC directories. Run `scripts/dev-daemon.sh down` after verification. A restricted tool sandbox can prevent Chromium's own process sandbox from starting; use an environment that supports it rather than disabling Chromium's sandbox on a shared host.
