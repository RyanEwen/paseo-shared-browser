# Streaming audit and recovery corrections

This records an earlier activated revision. The later [rich-transition investigation](rich-page-transitions-2026-10-19.md) found that a long idle could still trigger a periodic key and reset settled quality. Its subsequently activated follow-up requires sustained admitted cadence, preserves warm codecs across document boundaries, and retains the newest unencoded Standard-video picture with a bounded lifetime. Consult that report for current qualification and the separate Chromium capture-accounting limitation.

An independent Astra Low review found three defects around the streaming work. The owner continued implementation on Sol Medium. The corrections below are implemented, tested in isolation and activated on the home server after the user approved a five-minute Shared Browser restart window. Paseo stayed running.

## Findings and corrections

| Finding | Consequence | Correction |
| --- | --- | --- |
| Native real-time encodes can disappear without an output callback | Two unmatched submissions could permanently occupy both producer slots | After a one-second monotonic deadline, close and replace only that codec incarnation, fence its callbacks and require a fresh key. Three unsuccessful recoveries are allowed before a reported cohort failure. |
| PyroWave observation updates used a channel without retransmissions | A lost update could leave video visible while input remained stale | Existing authenticated heartbeat polling renews the epoch every 750 ms. A read retains the epoch captured before it started. |
| Independent PyroWave pictures reset the decoder on ordinary sequence gaps | Expected sender drops could repeatedly destroy and recreate the GPU device | Same-source independent keys cross gaps. New pictures replace unsubmitted older pictures without replacing the decoder. Source changes, errors and memory bounds retain their existing reset behavior. |

The first defect was reproduced with a controlled silent-drop codec, not observed as a production freeze. The second is a confirmed loss-sensitive code path, not a live packet-loss measurement. Removing GPU allocation churn is a concrete resource improvement; its effect on end-to-end latency has not yet been measured.

Real-time frame drops are permitted by the [WebCodecs latency mode](https://www.w3.org/TR/webcodecs/#latency-mode). The tested [Chromium 155 implementation](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/third_party/blink/renderer/modules/webcodecs/video_encoder.cc) suppresses the output callback for dropped frames. A data channel configured with zero [retransmissions](https://www.w3.org/TR/webrtc/#dom-rtcdatachannelinit-maxretransmits) does not guarantee delivery of the observation update.

## Static text quality

The prior frame-count GOP correction is retained. A full 68-second idle trace now requires a periodic key, continued delta delivery, explicitly negotiated H.264, and final text error below 14 RMSE against a JPEG-quality-100 reference. The reproduced all-key baseline stayed at 17.30, so that baseline cannot pass the new quality threshold. A separate short before/after trace settled at 9.76.

The reference is JPEG-derived, not lossless source pixels. The test retains only twelve cropped decoded pictures. The complete idle cycle passes, including the periodic key. It does not establish identical quality at every instant, across all content, codecs, frame-rate settings or bitrate budgets.

## Verification

- The shipped encoder program is exercised with two silent drops, delayed output before the deadline, late output after replacement, repeated lost recovery keys, a healthy sibling cohort and source replacement during recovery.
- Lost epoch delivery recovers through the existing heartbeat without another user action or reconnect. Wrong-viewer polling is rejected; an old in-flight read retains its old epoch, and an older renewal cannot lower the epoch.
- The real PyroWave adapter with a controlled GPU implementation receives sequences 1, 3 and 7 using one device. Only the newest painted picture earns credit. Source replacement and stale callback fences remain covered.
- Interleaved fragments from two in-flight transfers produce only the newer completed picture using the existing single incomplete-frame bound. This intentionally discards the superseded picture; it does not buffer both.
- Actual isolated supervisor RPCs and the production decoder verify idle-stream joining after the old key expires, recovery after a dropped delta, navigation, mouse/touch receipts and the existing higher-bitrate modes.

The final suite passes 980 unit tests in 127 files, four native checks across three files, frozen dependency validation, typecheck, build, lint and four script test files. Lint retains four existing informational findings. Changes remain uncommitted.

## Remaining performance work

Measure congestion and packet loss before changing buffering or transport policy. Skipping raw capture or encoding when all consumers lack transport capacity may save work, but must preserve independent cohort demand. A second incomplete-frame buffer might tolerate more fragment reordering at a bounded memory cost; the current newest-frame policy remains intentional.

Private Wayland qualification demonstrates GPU rendering improvements, not zero-copy capture or hardware Standard encoding. PyroWave still has no demonstrated general performance advantage over Standard video in the available full-viewer measurements. No additional buffering, bitrate-default change or hardware-encoding claim is part of these corrections.


## Live activation

The reviewed update is active on the home server. Standard video delivered fresh packets; screenshots and hardware Wayland rendering passed. PyroWave assets remain available. Selected rates, preferences, persistent profiles and durable agent bindings were preserved. The current workspace URL and CSS viewport were restored. Paseo retained its original process. Shared Browser tabs and prior viewer, control, frame and element references were invalidated by the approved runtime restart.
