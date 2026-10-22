# Frame expiration and recoverable error notices

Follow-up source work on October 22, 2026, after the original focus/window and ordinary-close deployment. The evidence below qualifies the follow-up source changes and isolated runtime behavior; host deployment identity and rollback are recorded separately in the private release receipt.

## Evidence and cause

Ryan reported Store Sign navigation clicks failing with `Browser frame is stale (stage=admission; reason=expired; ageMs=5126)`. The live daemon's redacted diagnostic at 2:42 p.m. America/Toronto recorded `gesture.update`, category `stale-frame`, and handler duration 1 ms. The receipt was already too old when the press reached admission; this was not a slow native click completing after admission. The log does not identify why the particular live video picture stopped renewing, or rule out transport delay before handler entry.

The production video hook and real receipt/gesture policy reproduce the exact rejection deterministically without WebAuthn, a native dialog or transport latency:

```sh
node_modules/.bin/vitest run client/use-browser-video.test.ts -t 'renews quiet video pixels'
```

Before the correction, healthy empty video reads repeatedly extended the quiet-picture hold. They neither supplied new pixels nor renewed the host's five-second frame receipt. Hover kept the native input channel alive, but its next press still used the expired picture. The exact red output was:

```text
Browser frame is stale (stage=admission; reason=expired; ageMs=5126)
```

The correction makes the existing 2.5-second painted-frame watchdog obtain fresh pixels even when empty reads continue succeeding. It revokes old video input authority immediately, retains displayed video until the exact replacement image decodes, and requests an independent video picture through the existing recovery path. It does not renew an old source timestamp, extend the five-second admission limit, replay a press, activate a desktop window or change graphics preferences.

This is a proven client liveness defect and a matching path to the reported error. The precise live capture or transport event that triggered the gap remains unconfirmed. An isolated real Chrome 155.0.8059.84 static page continued producing native frames about once a second, with measured source ages of 2 to 14 ms. Static content alone did not reproduce the live interruption. Normal fresh video keeps the existing presentation and cadence.

## Verification

The video hook test couples actual hook presentation to the production SessionManager, retaining real frame receipt and gesture admission behavior. The original exact red now passes with a genuinely new source observation. Healthy empty replies cannot indefinitely postpone the refresh, and delayed/reset/display-only frames retain their prior input fences.

The `quiet-video` mounted fixture uses real React Query, panel, frame-buffer and input logic with SDK/native-rendering leaf doubles. It proves healthy empty reads still request a real image payload, the replacement loads before input, and one explicit subsequent click carries that newly decoded frame's receipt. It does not qualify physical host rendering or video fidelity.

```sh
node scripts/test-panel-video-mounted.mjs --tooling-root <existing-host-tooling> --fixture quiet-video
```

`tests/browser-frame-freshness.smoke.test.ts` uses the real isolated Chromium/runtime-owner and production policy. A genuine native video receipt ages beyond five seconds while hover keeps its exact channel alive. The expired down is refused with zero click effects. A fresh JPEG followed by an explicit down/up yields exactly one click and preserves the draft. This qualifies native refusal and fresh-image recovery; the policy/hook and mounted tests separately qualify automatic presentation handoff.

## Error behavior

Every shared browser notice now has an accessible Dismiss message control, including operation, viewing, runtime and display-preference errors. Dismissal hides that occurrence without sending a browser request, retrying an action or changing failed-operation truth. Identical errors reappear after recovery, new occurrences and host/workspace changes. Retained dismissal callbacks cannot hide replacement notices.

A successful explicit operation or acknowledged non-hover input clears the operation failure that existed when it began. A revision and panel-scope fence prevent an older request's success from clearing a newer failure. Hover and cleanup do not clear action failures. Existing viewing-query and decoder recovery continue clearing their own errors after success. Errors with an unknown mutation outcome keep that qualification and are never replayed.

The exact expired-at-admission error explains that the action was not sent and asks the user to wait for refreshed viewing before trying again. Other error details remain available as before. The mounted `errors` fixture covers dismissal without RPC publication, repeated identical failures, successful retry, an older success arriving after a newer failure, and viewing-error dismissal. Focused notice tests cover same-object/text recurrence through a retained informational notice and cross-panel scope.

## Separate native passkey limitation

The earlier authorized Store Sign cancellation preserved its live page and form value and restored native focus. A sustained synthetic WebAuthn request separately proved Chromium's native child-modal chooser blocks page input while being absent from page capture. The prior 500 ms abort tests qualified focus admission only. Browser-owned prompt capture/input and local-client authenticator forwarding remain separate capability decisions; these frame/error changes implement neither and do not qualify real account passkey enrollment.
