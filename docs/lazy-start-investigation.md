# Empty workspace browser startup

## Cause and behavior

Observation previously attached a workspace to the native process owner, which launched Chromium at its default `https://example.com/` URL. The default page existed before an agent requested a destination and was easy to leave behind.

Production now reserves a runtime generation without launching Chromium, creating its display or opening a profile. Status, tab listing, human panel attachment, control acquisition, screenshot capture and DOM observation do not create content. Empty capture returns no frame, and DOM observation explains that no page is open. The panel shows No pages open while keeping the address field and New Tab available.

The first explicit URL starts the process directly at that destination. Explicit New Tab requests one blank page. Bare reopening clears the deliberately closed gate but stays empty. The reservation identifies one runtime generation from empty state through launch; a later reopen receives a new generation. Existing content remains discoverable after bridge reconnection, and saved site data is retained after closing and reopening the browser.

First-page requests are serialized. Viewer expiry, control loss, agent revocation, selection changes and runtime replacement are checked again before native publication and after awaited startup. A refusal before launch leaves the unused reservation reusable. A clean startup failure requires explicit recovery; unconfirmed cleanup refuses replacement. If a page was created before authority changed, the caller gets an unknown outcome and must inspect tabs. The request is never replayed. Only the initiating viewer moves to the new page; other empty viewers retain their selection and can explicitly select the discovered page. Empty control cannot bypass the existing final-tab shutdown checks.

## Verification

The exact production supervisor/MCP Chromium regression first failed because status returned ready at example.com. Its green version checks empty observation with no profile, capture or DOM page, two overlapping adapter connections producing one first destination request and one target, bridge reconnection retaining target/runtime identity, final-tab closed refusal, a new empty generation on reopen, one explicitly requested blank tab, and saved-cookie retention. The full retained DOM/keyboard suite passes all six cases with the qualified Chrome 155.0.8059.84 and agent-browser 0.38.2 binaries under isolated homes.

The staged plugin was also installed through `scripts/dev-daemon.sh` on a disposable loopback daemon. Normal human RPC attachment, control and capture stayed empty with no profile or native IPC directory; first URL produced one destination request, one content target and a nonempty capture. A wire-2 request received `PROTOCOL_MISMATCH` from the wire-3 endpoint without changing its metadata, and the matched plugin continued normally.

Policy/supervisor tests exercise preparation-time refusal, private-display cleanup, failure recovery, unconfirmed cleanup refusal, concurrent first tabs, expired human viewers, revoked or reselected agents, independent selections and late empty replies. Mounted production panel tests cover first URL/New Tab with Video selected, plus retained tab selection/closing, control confirmation, View size, notices and quiet-video recovery. These checks use platform leaf doubles and do not establish native client rendering.

The broader mounted `handoff` fixture still fails its expected extra gesture update after its held-video fallback: observed 2, expected 3. The same corrected fixture fails identically against unchanged production source at `3101a9740b873fc7088db2fb8516fb6c7f27fdf9`. This is an unresolved retained fixture limit, not a passing full video-suite claim. Its settings now explicitly select Video, and presentation assertions check the actual VP8 label and draw rather than an obsolete generic Video label.

## Compatibility and limits

The new empty status uses internal wire protocol 3. Package versions remain unchanged. The `supervisor-v2` IPC and startup-lock directory is deliberately retained so a version mismatch cannot start a parallel supervisor sharing profiles. Mismatched bridges refuse before attachment. Wire 2 agent adapters pinned in existing agents' saved configuration remain admitted; see the project handoff for the endpoint format and the stable adapter launcher that prevents future pinning. Deployment needs matched plugin, adapter and runtime bundles plus affected-session approval for supervisor replacement; a plugin-only reload does not activate this lifecycle change.

No live user tabs or settings were changed for this work. Isolated proofs do not establish deployment activation, real account/passkey interaction, native dialogs or cross-platform graphics fidelity.
