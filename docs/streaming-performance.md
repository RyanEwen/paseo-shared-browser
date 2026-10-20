# Streaming performance work

## What established systems do

Responsiveness depends on rendering, capture, encoding, transport and presentation. A faster codec cannot recover time already spent rendering or copying a frame. [PyroFling's IPC design](https://github.com/Themaister/pyrofling#ipc) exchanges GPU image handles and synchronization primitives to avoid extra copies. [Sunshine's capture documentation](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html#capture) distinguishes native GPU capture from CPU-intensive X11 capture. [RDP frame acknowledgements](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/0241e258-77ef-4a58-b426-5039ed6296ce) report successful decoding and client queue depth. [Moonlight's statistics](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions#what-do-the-numbers-mean-in-the-on-screen-connection-statistics) separate decode, queue and rendering latency. These are architectural precedents, not dependencies installed by this work.

## First implementation

The PyroWave sender previously waited for one picture to be displayed before sending another. The change allows at most two independent pictures in flight, overlapping transport and presentation without adding a pending picture queue. Native transport buffering still blocks admission, and lost credits retain the existing 150 ms expiry.

The actual decoder can replace an older decoded picture before paint. A presentation credit for a newer transfer therefore retires its own and superseded older transport slots. Otherwise a skipped picture would occupy capacity until its timeout even though it could never be presented. Late or duplicate credits cannot release newer work. These are transport resources only: observation receipts, source fencing, control ownership and input admission do not change. Existing receivers remain compatible with the same wire format.

A regression joins the real sender, receiver and decoder, delivers two outputs before one animation frame, and verifies that only the newer picture is presented while both superseded transport slots are released. Other tests cover the two-frame limit, losses, duplicate/future credits, native buffering, source revocation and cleanup. The full suite passes 944 unit tests in 123 files.

The home-server pacing update was activated through a plugin bridge reload. The existing browser supervisor, Paseo daemon and all 33 existing Chromium processes remained running. Preferences, persistent profiles and agent bindings were preserved. The isolated development daemon was stopped and removed after verification.

## Corrected measurements

The original [profile](browser-latency-profile-2026-10-18.md) used an interaction observer that read pixels directly from the video canvas. Chromium's [Canvas2D implementation](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc) can disable GPU acceleration after repeated readbacks when `willReadFrequently` was not explicitly set. In the fixture, later video draws grew from approximately 0.4 ms to 115 ms, while the pixel read itself remained fast. Those interaction figures do not represent normal viewer behavior. Steady samples preceded the reads.

The corrected observer copies just the marker region into a separate tiny canvas with explicit `willReadFrequently:false`; it never reads the real video canvas. The real video draws remain around 0.4 ms during interaction. A rendered frame serial also distinguishes actual content age from the packet's capture timestamp.

The matched local comparison uses the same Chromium 155 binary, native assets, public viewer/control RPCs, production decoder and production canvas. Source CSS is 1280×800, capture is 2560×1600, target 60 FPS, PyroWave budget 250 Mbps. Each row samples 15 seconds after 45 warmup presentations, then 16 supported hover updates.

| Source and sender | Presented FPS | Frame age p50/p95 | Gesture response p50/p95 |
| --- | --- | --- | --- |
| Original headless, one frame | 18.7 | 101/120ms | 185/260ms |
| Original headless, two frames with supersession retirement | 20.4 | 100/121ms | 183/213ms |

This is a modest throughput and tail-response improvement in a short local sample, not a claim of 60 FPS or a broad latency reduction. Capture timestamp age is not actual pixel age; the serial diagnostic confirms that compositor/capture buffering can precede it. Results exclude physical display illumination, actual Paseo shell cost, Windows scheduling and network congestion. The observer itself still performs bounded diagnostic work, so the figures are not a physical input-to-photon measure.

## Investigated and held

### GPU compositing

The source headless Vulkan browser accelerates WebGL but reports software compositing. Chromium's [headless GPU guide](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/using-gpu-hardware-in-headless-chrome.md), [Vulkan output surface](https://github.com/chromium/chromium/blob/main/components/viz/service/display_embedder/skia_output_surface_impl_on_gpu.cc) and [output-surface provider](https://github.com/chromium/chromium/blob/main/components/viz/service/display_embedder/output_surface_provider_impl.cc) explain why GPU rendering and GPU compositing must be qualified independently. These current main-branch references explain architecture, not the exact source revision of the tested binary.

An isolated candidate automatically hosted Linux Vulkan on the existing authenticated private X11 display. It enabled GPU compositing and passed WebGL/WebGL2 pixel, WebGPU compute and decoded colour checks without a physical screen or desktop capture. Timestamp-to-capture-reader delay fell from about 42–46 ms to 8 ms. With the corrected observer and two-frame pacing, however, the canvas sample delivered 19 FPS and 211 ms median gesture response versus 20.4 FPS and 183 ms on the retained headless path. It is therefore shelved, with its exact patch and qualification tests preserved privately. The running graphics/display policy is unchanged. GPU-compositing status alone does not establish copy-free capture or output.

### Native WebSocket masking

The [ws performance guidance](https://github.com/websockets/ws#opt-in-for-performance) recommends its optional native `bufferutil` helper for masking and unmasking. The registry's current stable 4.1.0 was tested privately with prebuilt binaries and install scripts disabled. A 6.14 MB unmask microbenchmark fell from 4.92 ms in JavaScript to 0.18 ms native. Actual raw loopback median fell from 15.3 ms to 12.4 ms, but steady presentation remained about 20 FPS. It was not added to production dependencies: the small end-to-end gain does not yet justify native packaging and qualification across all supported hosts. No host-global package was installed.

## Remaining work

Shared Browser's PyroWave path still copies raw planes through a local connection and an encoder process. A genuine GPU-handle path needs explicit Chromium capture integration, synchronization and ownership across processes, plus platform-specific qualification. X11 hosting alone is not that path. Rendering/capture content age, raw transfer and receiver timing should remain separate measurements before choosing that larger change.

Triple buffering at the GPU output surface is distinct from allowing three pictures in flight over the network. Another queued picture can improve throughput while increasing input delay. The two-frame pipeline is deliberately bounded; this work does not introduce a third frame or remove backpressure to inflate FPS.

## Follow-up: remove redundant raw colour reconstruction

PyroWave now carries the existing qualified colour-metadata override alongside its raw YUV planes. It no longer needs an intermediate reconstructed VideoFrame before its own plane copy. WebCodecs still receives a correctly labelled reconstructed frame when a compatible-video viewer is present. Raw capture takes an owned clone before the caller closes the source, and its existing generation/cancellation checks still run after the asynchronous copy. Neither the colour qualification predicate nor transport protocol changes.

The shipped helper-loop regression verifies one plane copy and no reconstruction for PyroWave alone, plus both required copies and identical corrected metadata with simultaneous compatible encoding. Document-replacement tests run with correction both enabled and disabled. All 948 unit tests pass; real Chromium checks pass for both video formats, including decoded colour and guarded input.

A matched local 2× canvas comparison with the already-updated two-frame sender found:

| Path | Presented FPS | Frame age p50/p95 | Gesture response p50/p95 |
| --- | --- | --- | --- |
| Current capture | 21.3 | 98/117ms | 183/202ms |
| One-copy raw capture | 20.9 | 92/108ms | 177/195ms |
| One-copy raw capture, repeat | 20.3 | 95/122ms | 180/206ms |

The reconstruction stage's measured 4.8 ms median disappears. Raw plane-copy median changes from 1.0 ms to 1.3 ms when copying the original source instead of the reconstructed CPU frame. The observed overall gain is 3–6 ms of median frame age, with no demonstrated throughput gain or consistent tail-response improvement. These short samples do not establish a statistically significant improvement across devices or workloads.

This is a small efficiency change. Capture code belongs to the detached browser supervisor, so a bridge reload does not activate it in existing browsers. The clean runtime is prepared for the next supervisor startup; current browsers are deliberately preserved. The larger software-compositor/capture and raw-transport costs remain.

## Count native encodes in the two-frame budget

The compatible encoder now bounds frames already inside the codec as well as completed output awaiting acknowledgement. Its JavaScript queue alone did not bound native work. On a large VP8 resize, 37 submitted frames produced 30 outputs whose generation metadata had all been evicted, so the viewer waited indefinitely. The corrected admission retains that metadata and passes the same real transition through 3840 square. This changes neither source freshness nor control authority.

The private Wayland integration also removes the launch-tab-close controller collision and uses real compositor presentation. Its current measurements and acceptance limits are recorded in the [qualification report](wayland-qualification-2026-10-19.md).

## Stock Chromium hardware-encoding follow-up

The [hardware-encoding investigation](hardware-encoding-2026-10-19.md) verifies the host AMD encoder but finds a stock-Chromium shared-buffer allocation failure. An external VA-API helper produces valid output without a browser rebuild, but its measured preparation/upload/output cost does not demonstrate a latency advantage. Neither experimental path was activated.
