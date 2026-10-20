# Static text refinement after movement

This records an earlier activated revision. The later [rich-transition investigation](rich-page-transitions-2026-10-19.md) found that a long idle could still trigger a periodic key and reset settled quality. Its subsequently activated follow-up requires sustained admitted cadence, preserves warm codecs across document boundaries, and retains the newest unencoded Standard-video picture with a bounded lifetime. Consult that report for current qualification and the separate Chromium capture-accounting limitation.

The correction is implemented, validated and activated on the home server after a user-approved live restart window. It keeps the selected bitrate, frame-rate target and all display settings.

## Cause

A private native capture of the installed Chrome 155 showed approximately one fresh capture per second after a page stopped changing. Our previous rule forced a keyframe whenever one second had elapsed since the previous keyframe. Every idle capture therefore became another keyframe at the same compressed quality.

At 12 Mbps with a 60 FPS target and a 2302 by 2938 image, six successive static keyframes were approximately 239 KB each and their decoded text error stayed at 17.30 RMSE against a JPEG-quality-100 reference of the unchanged source. More keyframes did not clear that image. The problem was repeated independent pictures preventing refinement, not a missing request for an independent picture.

## Correction

Periodic GOP length now counts successfully submitted pictures, using the selected frame-rate target. At a full 60 encoded pictures per second, periodic keys remain approximately one second apart. At a static one-picture-per-second capture rate, fresh deltas can refine the prior picture instead of restarting it each second. Actual timing depends on delivered and admitted source frames.

Joining viewers, output loss, explicit recovery and source changes still force an immediate key on the next eligible fresh capture. Packet backpressure, timestamp age, source generation, navigation, viewport and control checks are unchanged. No old image is retained and retimestamped as a fresh input receipt. No new capture heartbeat, extra buffering, bitrate increase or persistent setting is introduced.

The minimum capture cadence is an observed property of this tested native setup, not a universal promise for all Chromium versions and platforms. The correction works on received source frames and does not synthesize a heartbeat.

## Validation

A serial before/after comparison used the unchanged deployed implementation and the candidate, the same deterministic moving-text fixture, and separate private low-latency decoders. The page stopped all animation at its fixed final position. The JPEG-quality-100 reference screenshot was captured only after the trace, so screenshot reads could not generate extra refreshes during measurement.

| At 12 Mbps, 60 FPS target | Previous implementation | Corrected implementation |
| --- | ---: | ---: |
| Six static refresh types | All keyframes | All deltas |
| Decoded text error after settling | 17.30 RMSE | 9.76 RMSE |
| Final refresh size | About 239 KB | About 0.5 KB |

The corrected fixture's text error against that JPEG-derived reference was about 44% lower. These are isolated measurements of this fixture, not a universal quality, bandwidth or latency promise. Lossy encoding and its bitrate limits still apply.

The original 968-test validation passed, including the shipped-program regression that sends one-second-spaced fresh frames and verifies delta refinement. Four native checks across three files pass: static refinement and decode, 48/96 Mbps decode, and the existing authenticated mouse/touch video proofs. Frozen install, lint, build, typecheck and four script-test files also pass. Four existing informational lint findings remain. No dependencies, preferences or live processes changed during validation. Changes remain uncommitted.


The subsequent [streaming audit](streaming-audit-2026-10-19.md) corrected recovery bugs, strengthened the quality threshold, qualified a complete idle GOP cycle, and added actual public-viewer join and lost-delta recovery checks. Those results supersede the earlier short-trace acceptance coverage above.
