# Stock Chromium and external hardware encoding, 2026-10-19

The home server's AMD driver supports hardware H.264 encoding. Neither tested integration provides a qualified responsiveness improvement for the current Shared Browser. No production browser settings, dependencies or processes were changed. Custom Chromium builds are excluded at the owner's request.

## Stock Chromium

The tested browser is Chrome 155.0.8059.84 on the existing private Wayland backend, using host Mesa 25.2.8. The installed libva 1.20 interface reports hardware H.264 constrained-baseline, main and high encode entry points.

Chromium's documented `AcceleratedVideoEncoder` feature exposes hardware encode profiles, but its advertised profiles accept the tested 30 FPS configuration rather than the requested 60 FPS. The GPU is not itself limited to 30 FPS: the external encoder below accepted a 60 FPS configuration.

A real 30 FPS WebCodecs attempt selects `VaapiVideoEncodeAccelerator`, then fails with `EncoderStatus::Allocating a buffer failed`, code 19. The failure occurs when the pinned adapter creates its mappable shared image, before conversion and encoding. It also occurs with CPU-backed I420 input matching the tab-capture format. GPU-backed canvas input additionally caused isolated GPU-process crashes. Support probes and the GPU feature summary therefore do not establish successful hardware encoding.

The [version-matched adapter](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/media/video/video_encode_accelerator_adapter.cc) selects GPU-memory-buffer storage on Linux and requests a mappable shared image with `VEA_READ_CAMERA_AND_CPU_READ_WRITE`. The error does not prove physical memory exhaustion. No supported configuration remedy was established. The experimental feature was not added to the plugin's launch policy, and no sandbox protections were disabled. See Chromium's [VA-API documentation](https://github.com/chromium/chromium/blob/main/docs/gpu/vaapi.md) for the upstream feature and verification guidance.

## External VA-API experiment

An isolated C helper uses official FFmpeg 9.0.2 with only its VA-API H.264 encoder enabled. The source release signature and published signing-key fingerprint were verified. Libraries were built in a container against the existing Ubuntu 24.04 compatibility floor; the helper uses the host's existing libva and AMD driver. No host packages were installed. This is a private feasibility probe, not a shipped dependency or supported alternate backend.

The helper accepts bounded I420 source bytes, prepares NV12, uploads to a GPU surface and receives Annex-B H.264. It uses no B frames, an asynchronous depth of one and one frame submitted at a time. Both paths request 24 Mbps and a 60 FPS configuration. Static and scrolling grayscale text use identical source planes in each path. Each case submits sixty frames serially without pacing; the first eight are excluded from the warm medians.

| Source | Pixels | WebCodecs submit to output | External preparation, upload and output | External preparation and upload subtotal |
| --- | --- | ---: | ---: | ---: |
| Static text | 1280 × 800 | 0.75 ms | 3.70 ms | 1.36 ms |
| Static text | 2560 × 1600 | 4.50 ms | 11.63 ms | 4.73 ms |
| Scrolling text | 1280 × 800 | 1.30 ms | 3.77 ms | 1.44 ms |
| Scrolling text | 2560 × 1600 | 5.35 ms | 11.98 ms | 5.14 ms |

These columns have deliberately explicit boundaries. WebCodecs timing begins after input-frame construction; the external timing includes scalar planar interleaving, buffer acquisition and upload. They do not establish an encoder-only speed ratio. They show that this external integration has not demonstrated a latency advantage even before adding capture-to-process transfer and production transport.

An independent stock-Chromium decoder decoded all 240 external output pictures without errors. The final decoded luma RMSE against each exact source was 0.16–0.21. This establishes working output for the diagnostic fixtures, not equal quality between encoders. Identical bitrate settings do not imply identical rate control, payload bandwidth or image quality. No sustained 60 FPS, CPU savings, application-render contention improvement, concurrent-viewer capacity or input-to-display latency is claimed.

## Remaining options

The current helper can perform software colour correction before standard encoder admission, copying some frames that are later deferred, superseded or expired. Admission-aware correction is a bounded potential optimization inside the existing exact-tab pipeline. It requires serialized correction, original arrival age, source and generation checks, and explicit ownership through replacement. The colour correction is disabled on the current Wayland backend, so this would improve only the qualified software-capture fallback, not the active home-server path.

A larger reduction in the active path would require obtaining GPU-backed capture surfaces for an external encoder instead of downloading raw planes and uploading them again. The public [WebCodecs VideoFrame interface](https://www.w3.org/TR/webcodecs/#videoframe-interface) does not provide a DMA-BUF export API. Direct compositor capture is a separate backend design, not an interchangeable source for existing tab receipts. It must first establish independent per-tab capture, source ownership, geometry, navigation barriers, background operation and lifecycle cleanup. The earlier [backend investigation](chromium-streaming-backends.md) records the isolated prototype and its outstanding acceptance gates.

The current software encoder remains in place. A raw-upload VA-API replacement is not justified by these results.
