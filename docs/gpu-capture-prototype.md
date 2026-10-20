# Linux GPU-capture prototype

This is an isolated design and measurement prototype for stock Chromium, approved on 2026-10-19. It is not a new installed graphics mode. It never connects to Paseo, registers input receipts, changes production preferences or captures a physical desktop. The existing Shared Browser backend remains active.

## Intended architecture

Keep the current browser profile, page controllers, DOM tools, tab selection, input ownership and fallback modes. A private compositor gives each independently viewed page a dedicated output. It passes GPU-backed images to a hardware H.264 encoder without downloading raw planes into JavaScript and uploading them to the GPU again. The existing video decoder remains the viewer.

The prototype uses the current stable Pixelflux 2.1.0 library, with its released wheel verified by checksum and extracted into a disposable directory. This is a research dependency only. Its released wheel includes GPL-enabled components; a distributable integration requires a reproducible build with those components excluded and the original notices preserved. No dependency is installed globally or added to normal plugin installation.

## Page-to-surface bootstrap

The trusted extension creates one Chromium popup window per page in the same profile. Extension tab IDs identify exact CDP targets; Chromium window IDs and native compositor handles remain separate identities.

Each new page initially loads a private extension resource, with no web-accessible resources or site scripts. The owner changes an unpredictable 128-bit pixel challenge through that exact page attachment. Candidate native surfaces are moved through an unstreamed output and compared with the challenge. A candidate must also display a second challenge changed after the move. Exactly one candidate must match. A timeout, ambiguity or destroyed target aborts the attempt. Site titles and a newly appeared window are never sufficient identity evidence.

This proves an initial association. It does not prove that a native window will permanently contain only that page, or that every later pixel belongs to the current document. Chromium's own UI may be inside the same root surface. A popup window's tab and shortcut behaviour must be tested rather than assumed to provide permanent exclusivity.

## Native ownership boundary still required

The released compositor exposes output placement and enumeration, but not an exclusive per-page capture contract. Client fullscreen requests can move windows. Both capture composition paths can include unrelated intersecting windows, popups, layer surfaces and cursor content. Polling the window list cannot make that composition atomic.

Before production integration, the native compositor must provide:

1. Atomic bind and revoke on its compositor thread, using a live surface handle scoped to the compositor incarnation. Unbound windows must be quarantined before their first mapping, and conflicting bindings refused.
2. A render-time allowlist for the bound root and explicitly permitted descendants, across every capture path. Exclude unrelated roots, layer overlays and global cursor content. Clear old framebuffer contents and damage history when ownership changes. Placement restrictions alone are insufficient.
3. Immutable provenance attached when the image is rendered: binding generation, native surface lifetime, geometry generation, render sequence, sampling time and contributing surface-tree state. Carry it unchanged through encoding and delivery. Rebinding revokes queued old output and starts an independent codec chain.
4. A separate browser-document-to-presentation proof. A compositor commit after a CDP navigation event does not establish that it contains the new document. A root commit counter misses child-surface updates, while a render counter can advance without new content. Never assign the current navigation generation to an arbitrary newly delivered image.

Until those requirements are qualified, prototype packets remain visual-only and cannot mint or renew input authority. There is no production RPC or control lease in this runner. Existing screenshot, DOM and gesture admission rules are unchanged.

## Qualification sequence

- Bootstrap: simultaneous identical titles, fresh challenge changes, delayed mapping, wrong candidates, destruction/recreation and compositor restart.
- Browser semantics: same-profile storage, single-page window ownership, background rendering, popups, keyboard tab shortcuts, fullscreen UI, navigation, resize and per-page scaling.
- Native isolation: adversarial fullscreen moves, overlapping roots, subsurfaces and menus, layer overlays, destruction and delayed encoder output. Unrelated sentinel pixels must never reach an admitted stream.
- Streaming: compare the same source pages, image sizes, bitrate and production decoder. Separate capture/encode callbacks from viewer presentation and actual route response. Verify colour and text quality outside timing samples.
- Lifecycle: source retirement, viewer disconnect, native-helper failure, bounded buffers and complete owned-process cleanup. Keep the current backend as fallback until the new path passes.

The first released-library experiment can establish bootstrap and visual performance only. Native ownership, browser semantics and production receipt qualification are explicit later gates, not inferred from a successful decoder or a faster callback rate.

## Running the isolated experiment

See the [prototype runner instructions](../scripts/gpu-capture-prototype/README.md). Native GPU measurements must run serially. The runner uses a private Wayland socket, disposable source/viewer profiles, bounded packet queues and exact retained child handles. It does not require a custom Chromium build.

## Measured result

The isolated matched run completed two simultaneous streams at 24 Mbps and a requested 60 FPS, using the same synthetic pages and production decoder. Both pages had a 1280 × 800 CSS viewport; their physical captures were 2560 × 1600 and 1280 × 800. Each phase measured decoder draw callbacks over a 14-second window and one fixture-change-to-draw transition per page. These are software draw callbacks, not measurements of physical display presentation.

| Physical capture | Existing Standard: draw FPS / fixture-to-draw | Direct GPU: draw FPS / fixture-to-draw |
| --- | --- | --- |
| 2560 × 1600 | 26.9 FPS / 127 ms | 24.4 FPS / 170 ms |
| 1280 × 800 | 26.9 FPS / 164 ms | 22.7 FPS / 180 ms |

The native library reported DMA-BUF capture, zero-copy and VAAPI hardware H.264 on the host AMD GPU. Median source-to-native-callback age was approximately 16.2 ms at the larger size and 4.9 ms at the smaller size. These callback timings exclude transport, decoding and viewer drawing. They do not establish end-to-end latency savings.

Both changing pixel challenges, shared storage and simultaneous mixed-scale sources passed. Retiring one source rejected its old native handle and stream while the sibling continued at unchanged geometry. Neither phase reported decoder errors. No production input authority was issued, and the live plugin was not changed.

This run demonstrates feasibility, not an improvement over Standard. The prototype uses bounded base64 JSON transport and CDP polling rather than the installed media transport. The native streams dropped 77 and 73 packets under that bounded delivery pressure; delivered packet counts and presentation counts are separate. The phases ran sequentially, with Standard first, and codec profiles differed. There was no matched decoded-quality, sustained-load, physical-client or input-latency qualification. No claim of equal quality or reduced CPU use follows from the selected bitrate or hardware encoder.

The appropriate next production gate is a native ownership/provenance implementation plus a representative binary media transport, followed by repeated matched performance and quality tests. A faster hardware callback alone is insufficient reason to replace the current backend. The released-library visual prototype is complete; production integration remains unqualified.
