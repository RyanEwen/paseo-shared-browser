# Private Wayland qualification

The home-server Linux implementation now passes isolated production-viewer, independent-tab and input-authority checks. It uses a real private compositor with GPU rendering, retaining exact-tab capture and the existing viewer. All nine final native regression cases pass, including forced compositor loss, owned-child cleanup, WebGL, existing Vulkan/WebGPU, DOM and video. It is activated on the home server, with hardware rendering, screenshots and compatible video verified live. PyroWave remains available. This is not a direct desktop capture adapter, and WSL was not an acceptance gate.

## Measured behavior

The source is Chrome 155.0.8059.84 with the home server's AMD GPU and host Mesa. The page contains ordinary text, controls and a small animation, 1280 by 800 CSS pixels captured at 2560 by 1600. Compatible video requests 24 Mbps and 60 FPS. The viewer uses the production decoder/canvas through real isolated plugin RPCs.

| Configuration | Sample | Presented FPS | Capture timestamp age, median / p95 |
| --- | --- | ---: | ---: |
| Previous backend, compatible | 15 seconds | 24.9 | 61.5 / 73.5 ms |
| Native private Wayland, compatible | 120 seconds | 38.5 | 29.5 / 39.5 ms |

The sustained run had 4,619 measured frames, no viewer errors and passing RGB swatches. All 16 clicks and 16 gestures passed; median gesture response was 67.0 ms, p95 80.0 ms. Timestamp age measures capture timestamp to viewer canvas, not page render time or physical input-to-photon latency. Both viewers ran locally; mobile network, decoding and screen scanout remain separate costs. The baseline is an earlier short sample, not a statistical controlled trial. Host memory pressure and unrelated workloads can affect the tails.

PyroWave also passes the complete viewer, RGB and input flow on this backend. A short final run delivered 20.3 FPS, 76.5 ms median frame age and 160.9 ms median gesture response. It does not demonstrate an advantage over compatible video for this workload. GPU rendering alone does not eliminate raw readback, transport, receiver compute or software H.264 encoding.

## Corrections established by the investigation

### Real compositor presentation

The first Pixelflux wrapper ran its display without a render consumer. Its idle service sent frame callbacks but discarded presentation feedback. Chrome's [fullscreen hint watchdog](https://chromium.googlesource.com/chromium/src/+/39a706dc05a765588d1ac98360aedc73d0ea6c26) exits fullscreen after 1.5 seconds if the hint never receives successful presentation. The installed source and protocol trace matched that mechanism: 683 presentation requests, zero successful presentations and eight fullscreen exits.

A normal Weston GL compositor resolves this without PNG initialization, repeated emulation writes or fabricated presentation feedback. The corrected raw lifecycle trace had 1,312 successful presentations, one discard and zero fullscreen exits. Its headless virtual output is software timed, not physical hardware vsync.

### Independent controllers when the launch tab closes

The browser-owning controller used to attach to a surviving page after closing its original page. That restored the closed page's emulation over the survivor's independent controller. The reproducer measured the survivor changing from 1280 by 800 to 800 by 600, with black borders in its video.

The launcher now retires its page attachment while keeping ownership of the browser process. It does not select another page. Untargeted requests reuse a surviving page's existing controller. An unconfirmed close stays pinned to the original page, and shutdown still closes the owned browser. The strict public RPC test checks unchanged metrics and the first fresh post-close frame, without recovery retries.

### Frames already inside the codec

`VideoEncoder.encodeQueueSize` does not count all frames already handed to the native codec. The helper retained only four timestamp-generation records while continuing submission. At the failing large VP8 transition, instrumentation observed 37 submissions and 30 completed outputs, all 30 discarded because their generation record had been evicted. No packets reached the viewer.

Admission now counts both active encodes and completed output awaiting its producer acknowledgement within the existing two-frame budget. Metadata remains until its output callback; it is not evicted to make room. The delayed-codec regression models an empty JavaScript queue while native work remains active. Late output after document replacement still fails its generation fence. The original source-clock freshness, controller and packet bounds remain unchanged.

## Acceptance coverage

The real public RPC fixture uses a separate private Chromium receiver with its normal decoder and GPU canvas. It verifies:

- Independent red/blue tab streams and per-tab resize.
- Wrong-runtime and wrong-tab receipts, previous-controller rejection after takeover, and stale navigation receipts.
- Closing the launch tab without changing the survivor's first fresh pixels.
- Resize transitions through 320 by 480, 1920 square, 3840 by 2160 and 3840 square, with decoded RGB and dimensions checked. The largest square uses compatible video's existing VP8 fallback.
- Detached viewers cannot revive capture.

Decoding inside the Wayland source browser exposed a separate GPU colour conversion problem. Identical encoded chunks retain correct software-decoded YUV samples. The source-browser canvas can display those samples incorrectly, while the independent receiver and actual production viewer pass. Chromium can convert texture-backed frames during [readback](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/third_party/blink/renderer/modules/webcodecs/background_readback.cc), so a changed copied GPU plane is not proof of a bitstream decoder fault. No sender matrix override or global software-decoder fallback was introduced. This does not qualify every possible GPU receiver.

## Native packaging and user control

The current native package uses [Weston 16.0.1](https://wayland.freedesktop.org/releases.html), Wayland Protocols 1.49 and libdisplay-info 0.4.0. It is built in a pinned Ubuntu 24.04 container against glibc 2.39, then runs privately with host Mesa. No persistent container or host package installation is required. Source checksums, build instructions and dependency notices are retained; see the [private build](../scripts/native/weston/README.md).

Prepared assets are copied with checksums into the immutable browser runtime. Each workspace owns a private 0700 socket directory and compositor child. Startup requires a working listener and a hardware renderer. There is no physical screen, seat, Xwayland, network listener or separate remote-desktop authentication service.

**Graphics > Wayland GPU** is an explicit persistent host choice. Host default and Vulkan remain available. Saving preserves running tabs; applying to an existing browser uses the existing restart/data-loss confirmation. Missing assets or failed GPU startup are reported, rather than silently switching to a host desktop capture.

Activation preserved persistent site profiles, durable agent bindings and all preferences except the explicitly selected graphics mode. Existing browser tabs, references and viewer/control identities were invalidated by the authorized browser reload. Paseo itself stayed running. Post-activation checks passed and the isolated qualification daemon, container and obsolete prototype display were removed. The complete validation includes 959 unit tests, seven script tests, nine native regression cases, build, typecheck and lint checks. Changes remain uncommitted. Actual phone playback latency and other host platforms are not qualified by these local results.
