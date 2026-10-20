# Shared Browser latency profile

Measurement correction: the original interaction observer read pixels from the production video canvas. Chromium can switch that canvas to CPU rendering after repeated reads, making subsequent GPU video draws much slower. The gesture and click latency figures below therefore include an observer-induced rendering change and must not be treated as representative of normal UI interaction. Steady-stream samples were collected before those reads. Follow-up comparisons use a separate small probe canvas; see [streaming performance work](streaming-performance.md).

Profiled the installed streaming design in an isolated home-server daemon using the same Chromium 155 build, native assets, public viewer/control RPCs, production decoder and production canvas surface. No production settings or sessions were changed.

## Findings

The main shared bottleneck is software compositing in the source browser. Hardware Vulkan WebGL is active, but Chromium reports `gpu_compositing: disabled_software`. Its trace shows `SoftwareRenderer::DoDrawQuad` doing substantial CPU rendering work. In a1.5-second light canvas 2× trace, 32 `Display::DrawAndSwap` events consumed 1.326 CPU-seconds, with a median 41 ms wall duration per frame. These are repeated spans on the source compositor thread, not additive totals across nested trace categories.

PyroWave adds substantial raw-frame transport and process-copy overhead at 2×. The codec alone is not the main source of latency. Neither requested 60 FPS nor 250 Mbps means those rates are actually achieved.

## Matched measurements

Each row uses 15 seconds of steady sampling after at least 45 presented warmup frames. The light canvas scene has text and one small animation, redrawn on a large 2D canvas. The stress scene adds animated grayscale noise over half the page. A DOM form cross-check uses real inputs/text, a small CSS animation and only a small canvas for response markers. Source CSS layout is 1280×800; 1× is 1280×800 capture and 2× is 2560×1600. Video targets 60 FPS and 24 Mbps compatible or 250 Mbps PyroWave unless otherwise noted. Human response uses 16 acknowledged hover updates through the supported continuous gesture API, observing a marker in the decoded canvas. Agent clicks were profiled separately.

| Scene | Detail | Codec / target FPS | Presented FPS | Frame age p50/p95 | Gesture response p50/p95 | Encoded payload |
| --- | --- | --- | --- | --- | --- | --- |
| Canvas light | 1× | Compatible / 60 | 26.9 | 52/62 ms | 99/115 ms | 0.7 Mbps |
| Canvas light | 1× | PyroWave / 60 | 24.4 | 61/71 ms | 150/215 ms | 55.3 Mbps |
| Canvas light | 2× | Compatible / 60 | 23.1 | 68/82 ms | 162/214 ms | 1.8 Mbps |
| Canvas light | 2× | PyroWave / 60 | 15.7 | 104/136 ms | 291/359 ms | 65.3 Mbps |
| Canvas light | 2× | PyroWave / 60 | 16.6 | 112/140 ms | 307/463 ms | 69.2 Mbps |
| Canvas stress | 2× | Compatible / 60 | 22.9 | 96/122 ms | 200/229 ms | 32.4 Mbps |
| Canvas stress | 2× | PyroWave / 60 | 15.3 | 108/144 ms | 326/385 ms | 63.9 Mbps |
| Canvas light | 2× | PyroWave / 30 | 13.3 | 126/156 ms | 345/442 ms | 90.2 Mbps |
| DOM form | 2× | Compatible / 60 | 28.3 | 58/70 ms | 148/162 ms | 0.9 Mbps |
| DOM form | 2× | PyroWave / 60 | 20.0 | 96/116 ms | 248/344 ms | 83.3 Mbps |

The repeated light canvas 2× PyroWave run confirms the same performance range. These are short local comparisons, not a statistically broad host/device benchmark.

## Where time goes

The following are per-stage medians for displayed frames from the light canvas 2× runs. Stage medians do not sum exactly to the median total. Native PyroWave encode time includes parent/child stdio, CPU/GPU transfer, encoding and result readback; it is not a pure GPU-kernel timer.

| Stage | Compatible | PyroWave |
| --- | --- | --- |
| Source timestamp to capture reader | 42.1 ms | 46.1 ms |
| Colour metadata correction copy | 4.2 ms | 4.9 ms |
| Additional raw plane copy | N/A | 0.9 ms |
| Raw loopback transfer | N/A | 15.6 ms |
| Encoding / native process roundtrip | 6.4 ms | 8.1 ms |
| Encoded packet to public receipt | 0.2 ms | 0.3 ms |
| Receipt to viewer, including worker/network wake | 1.3 ms | 14.3 ms |
| Viewer decode | 1.8 ms | 1.5 ms |
| Viewer animation-frame wait | 7.7 ms | 6.9 ms |
| Canvas draw submission | 1.6 ms | 0.3 ms |

At 2×, bounded one-frame presentation credits also discard roughly 13–19% of attempted PyroWave sends in these ordinary runs. Those are deliberate flow-control drops, not observed network packet loss. Encoding still does work for some frames that cannot be sent. Credit pacing is a secondary throughput constraint, not the whole explanation for the 60 FPS shortfall.

Human gesture RPCs took about 16–45 ms at the median across these cases, while their visual responses took 100–326 ms. In the instrumented repeated light canvas 2× PyroWave run, the page redraw-to-viewer interval was about 296 ms at the median. Source freshness age alone therefore understates perceived interaction delay. This also includes scene redraw, compositor buffering and marker observation.

## Resource limits and current settings

No plugin CPU quota, imposed native encoder thread count, or process RSS ceiling was found. The live service has all 12 logical CPUs available and unlimited CPU and address-space resource limits; inherited cgroups have no CPU/memory quota. Buffers, frame dimensions, packet sizes, peer counts and pending work are explicitly bounded. The source GPU process consumed approximately one CPU core during baseline runs; this CPU figure does not mean the physical GPU is 100% utilized.

A DOM-form trace independently measured a 32 ms median compositor span with 1.337 CPU-seconds of drawing in 1.5 seconds. The bottleneck is not exclusive to large canvas scenes.

At the start of the profile, the selected home-server settings were PyroWave, 250 Mbps and 60 FPS, with Vulkan graphics. The native rate-control budget is `bitrate / target FPS` per frame. At 60 FPS, 250 Mbps permits about 521 KB per frame; at 16 delivered frames/s this corresponds to about 67 Mbps payload. Lower delivered FPS does not automatically raise the per-frame quality budget.

A controlled 30 FPS/250 Mbps PyroWave run delivered 13.3 FPS, about 90 Mbps payload, 127 ms median frame age and 345 ms median gesture response. Increasing its per-frame budget did not improve responsiveness. This profile does not establish a quality ranking from bitrate alone; no live setting was changed.

## Controlled compositor check

One isolated comparison added Chromium VulkanFromANGLE and DefaultANGLEVulkan while preserving the existing launch flags. The effective command line confirmed both additions, but Chromium still reported software compositing. The optional trace did not complete within its deadline, so that run is excluded from timing tables. No claim that these flags fix the issue is supported. They were removed from the private test source and never applied to production.

## Prioritized work

1. Find a supported launch/backend combination that actually enables GPU compositing on this host. Validate compositor status, WebGL, colour, image detail and locked-host operation before activating it. Hardware WebGL alone is insufficient evidence.
2. Reduce PyroWave raw-frame CPU/process copies and avoid encoding work that cannot be delivered. The 2× raw loopback stage alone costs about 16 ms in these samples.
3. Evaluate a small bounded transport pipeline against current presentation credits. Preserve stale-source fencing, teardown barriers and input receipt rules; measure latency as well as FPS before changing the window.
4. Revisit settings and adaptive per-frame budgeting once actual capture throughput improves. Simply increasing exposed FPS or bitrate is not the first fix.

## Limits and reproducibility

The viewer was a genuinely headed private X11 Chromium instance on the same server. PyroWave used real encrypted WebRTC loopback; compatible video used local public RPC delivery. This isolates server/client pipeline costs from Wi-Fi and Windows scheduling. It does not measure Windows Paseo-shell overhead, full UI event handling, sustained LAN congestion or physical screen illumination. Source/frame clocks use the existing calibrated source timestamp; clocks and Date serialization introduce roughly millisecond precision. Canvas draw acknowledgement is not physical display. The polling marker observer can perturb interaction tests slightly.

Private reproducibility artifacts include the profiling fixture, exact instrumentation script, bounded per-frame JSONL, source trace files and analysis. They remain in the ignored local history archive and contain no published credentials. Instrumentation was installed only in a disposable development runtime. Production is unchanged.

Primary background references: [Chromium headless GPU guidance](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/using-gpu-hardware-in-headless-chrome.md) and [PyroWave design](https://github.com/Themaister/pyrowave#pyrowave). The measured findings above come from this checkout and host rather than upstream benchmark claims.
