# Established Chromium streaming backends

Investigation date: 2026-10-19. The direct display-capture findings below concern an isolated Linux experiment. A subsequent private Wayland integration retaining exact-tab capture is now qualified and active on the home server; see the [qualification report](wayland-qualification-2026-10-19.md).

## Finding

An existing capture backend can run unmodified Chromium with GPU compositing, capture its private display through GPU buffers and encode H.264 on the home server's AMD GPU. This does not require a Chromium fork or PyroWave.

The most relevant reusable component is Pixelflux, the compositor/capture/encoder library behind Selkies. Adopting the full Selkies application would also introduce its HTTP service, authentication, client and desktop input policy. Shared Browser already owns those responsibilities, so the library is the narrower integration.

## Sources and versions

The experiment uses the released Python 3.12 Linux x86-64 wheel of [Pixelflux 2.1.0](https://github.com/selkies-project/pixelflux/tree/1ebcb0a10a96caeba20e1ad09be47cc018a55238), verified against the registry's SHA256. Its source revision is `1ebcb0a10a96caeba20e1ad09be47cc018a55238`. [Selkies 2.0.0](https://github.com/selkies-project/selkies/tree/3ec56fb1538cf077c27156f5ab75b6595a83c461) depends on this library. Current development source was inspected separately; measurements do not depend on unreleased code.

The alternative reviewed was [KasmVNC 1.5.0](https://docs.kasmvnc.com/docs/video_streaming_mode/). It provides a complete virtual X server and desktop streaming implementation with VA-API/NVENC encoding. Its [GPU documentation](https://docs.kasmvnc.com/docs/gpu_acceleration/) distinguishes rendering from encoding and lists desktop compositing limitations. It is a credible complete session backend, but was not installed or benchmarked in this investigation.

Chrome's [tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) already supplies our exact-tab MediaStream. Direct WebRTC forwarding is another transport option, but is not evidence that the source rendering/capture cost goes away. A transport change alone should not be credited with the display-capture results below.

## Host experiment

The home server exposes an AMD Cezanne/Radeon Vega render device and a working Mesa radeonsi driver. Direct VA-API enumeration and Pixelflux's actual probes identify hardware H.264 and H.265 encoding. The library does not report hardware 4:4:4 encoding on this device. GPU rendering support alone was not used as proof of encoding support.

The wheel was extracted into an ignored project-only research directory. It was not installed globally or added to the plugin's dependencies. Native host integration was necessary to probe the actual render device and driver. No full desktop container, privileged service or host package installation was required.

The fixture launches the same Chrome for Testing 155.0.8059.84 binary used by earlier measurements, with a disposable profile and a private Wayland compositor socket. The compositor renders on the AMD GPU and passes DMA-BUF images to the VA-API encoder. No physical display or existing desktop session is captured. The source uses EGL/OpenGL rather than our retained headless Vulkan launch policy.

The source is the existing light animated canvas fixture: CSS 1280 by 800 at 2x, giving exactly 2560 by 1600 physical pixels. Target rate is 60 FPS and H.264 target bitrate is 24 Mbps. After startup/warmup, each sample counts encoded callbacks for ten seconds. Timed sampling does not read pixels from the source canvas. Independent decode checks run afterward.

| Full-viewport run | Encoded callback FPS | Capture-to-callback median | Capture-to-callback p95 |
| --- | --- | --- | --- |
| First | 58.4 | 14.85 ms | 15.12 ms |
| Repeat with decoded colour probes | 57.5 | 14.87 ms | 15.14 ms |
| Before separate-output check | 58.3 | 14.89 ms | 15.19 ms |

A subsequent paired run, with the exact-tab helper extension loaded but initially idle, delivered 57.2 FPS and 14.90/15.16 ms median/p95 capture-to-callback time.

Pixelflux reports `capture: dmabuf`, `zero_copy: true`, `encoder: VAAPI`, `hardware: true`, and a GL compositor on the same render node. Chromium's `SystemInfo.getInfo` independently reports GPU compositing and rasterization enabled. Chromium's own video encoder reports software-only; these results use the external VA-API encoder, not Chromium's WebCodecs encoder.

Ninety captured access units decode successfully in Chromium WebCodecs as H.264 at 2560 by 1600. Red, green and blue patches remain identifiable, but the decoded values are not exact source RGB values. This is a bitstream/decode feasibility check, not completed colour or perceptual-quality qualification.

The driver refuses an optional bitrate ceiling while accepting target-rate encoding. A production adapter must expose actual capability/fallback and bound encoded packets independently of this setting. The capture threads ran at normal priority because elevated thread priority was refused; no scheduling settings were changed to obtain these results.

Earlier fixture runs included Chrome for Testing's infobar, reducing CSS height to 744. They are excluded from the full-viewport table. The corrected fixture uses Chrome for Testing's documented `--disable-infobars` and asserts exact page size and DPR. Native window enumeration also waits for mapping before output assignment.

These are capture/encoding measurements. They exclude Shared Browser transport, viewer scheduling, input admission, physical display latency and congested networks. They cannot be compared as end-to-end FPS or latency against our previous complete viewer measurements. In particular, 15 ms is not an input-to-photon result.

## Independent pages are feasible, but require integration

A second check creates another window in the same Chromium process/profile and assigns it to a separate private output. Both outputs use DMA-BUF capture and hardware H.264 encoding. The original page retains CSS 1280 by 800 at DPR 2 while the second retains 640 by 480 at DPR 1. Both continue drawing, and a local-storage marker written by the first page is readable in the second. The second capture delivers 151 frames during the three-second check.

This proves the underlying window/output primitive, not production tab mapping. Our current tabs can share one native window; display capture cannot see every background tab independently. A full display-capture adapter would need one native window/output per independently viewed page, or another proven isolation scheme. It must retain the same profile, CDP targets and per-page emulation.

The fixture identifies the only newly mapped native window in a serialized, owned test. That is not a sufficient production identity protocol. Native popup creation, concurrent opens, crashes and output removal must not cause capture of another page. Matching by site-provided title is unacceptable. This is the main architectural integration risk.

## Recommended integration boundary

Keep Shared Browser's toolbar, agent tools, profile storage, tab selection and control ownership. Evaluate Pixelflux as a private supervised media helper, using its Python API and full-frame H.264 output. The existing decoder can consume that format; it still needs trustworthy packet metadata and lifecycle integration. Do not embed an unrestricted remote-desktop client or enable Pixelflux's separate computer-use HTTP endpoint.

### Smaller alternative measured

The experiment also loaded our current exact-tab helper, stopped Pixelflux encoding while retaining the private compositor, and captured the same exact page at 2560 by 1600. It used our existing H.264 encoder configuration at 24 Mbps/60 FPS, the usual two-packet acknowledgement bound and no colour-correction reconstruction. The helper was kept alive through its existing demand heartbeat. No plugin source was changed for this comparison.

Encoded helper output was 33.2 FPS, then 32.4 FPS on repeat. In the repeat, a bounded diagnostic counter observed 52.5 source-track frames per second, all I420. Thus the remaining loss is not explained solely by the page drawing slowly. The helper's capture/conversion, software encoding, pacing and acknowledgement path still need separate attribution. These counts do not identify one of those as the entire cause. There were no reported helper errors.

Private Wayland plus existing tab capture is therefore a credible smaller upgrade, retaining exact-tab identity, but it did not match direct display capture in this fixture. Neither result includes the full Paseo viewer/input path. The recommendation is to qualify the smaller option end to end first, and use the direct-capture prototype as the measured alternative if its remaining performance is insufficient. Do not substitute one shared active desktop for independently selected tabs.

The subsequent [home-server qualification](wayland-qualification-2026-10-19.md) initially found a page/input mapping defect. That defect was corrected and the qualified private Wayland backend is now active on the home server. The linked qualification records independent-tab, source-fence, pixel and input checks. The earlier direct-capture prototype's FPS does not establish that the complete plugin integration meets its acceptance gates.

For a display-capture adapter, retain all existing workspace, runtime, bridge, attachment, navigation, document, viewport and controller fences. Capture timestamps are not page-render timestamps. A newly arrived frame must not become actionable merely because it arrived after an input acknowledgement. Source retirement and fresh-frame barriers require explicit qualification before using the new stream for control receipts. DOM tools can continue through their existing CDP authority.

Preserve bounded queues, packet sizes, encoder cohorts and presentation credits. Output teardown must cancel capture before destroying the window/output, and supervisor loss must clean up its own compositor/helper without touching another workspace. A helper restart should report media unavailability rather than silently replacing a user's browser profile.

## Platform, packaging and acceptance

This is a Linux prototype. It does not prove native Windows support or equivalent WSL performance: the existing WSL D3D12 graphics path is not the same as this Linux DRM/GBM/VA-API path. Keep the present cross-platform capture implementation as a fallback until each host is qualified. Private output ownership makes independence from the physical desktop plausible, but actual lock/unlock and reconnect tests remain required.

Upstream labels Pixelflux MPL-2.0 and KasmVNC GPL-2.0. Pixelflux's released wheels also bundle GPL-enabled encoder dependencies. Its documented source-build option excludes those components, but reproducible packaging and applicable notices still need review before redistribution. A local prototype is not approval to change the repository license or ship an unreviewed binary dependency.

The next implementation decision should follow a matched end-to-end comparison:

1. Existing exact-tab capture on private Wayland versus direct display capture, using the same source, physical pixels, bitrate and production decoder.
2. Actual visible frame age and acknowledged gesture response, with independent pixel observation that does not force the viewer canvas into software rendering.
3. Two viewers on different tabs and two viewers on the same tab; navigation, close, resize, DPR changes, popups and controller takeover.
4. Colour, small coloured text, WebGL/WebGPU, mobile emulation and screenshot fallback; no sharpness regression accepted in exchange for FPS alone.
5. Lock/unlock, hidden viewers, bounded memory/CPU over a sustained run, helper crash/recovery and complete owned-resource cleanup.

Private Wayland with retained exact-tab capture is now integrated and active on the home server. Its sustained local production-viewer test measured 38.5 FPS and 29.5 ms median capture timestamp age, with independent-tab, input-authority, colour, resize and owned-process cleanup checks passing. These are different metrics from the direct encoder callbacks above and must not be compared as equivalent latency measurements. Direct display capture with hardware encoding remains separate engineering work. The existing exact-tab path does not require a new codec or a Chromium fork.
