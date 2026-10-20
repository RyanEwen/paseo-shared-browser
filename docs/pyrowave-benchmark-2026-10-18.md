# PyroWave bring-up results, 2026-10-18

This report records the initial bring-up, before live activation. For current availability and remaining limits, see the [transport guide](pyrowave-transport.md).

The home Linux AMD Radeon Graphics (RADV RENOIR, Mesa 25.2.8) passes the pinned native PyroWave GPU roundtrip, upstream C API correctness/invalid-input suite, and independent browser decoder comparison. A private exact-tab prototype also passed real capture through GPU encode and bounded WebGPU canvas presentation. These are preliminary development measurements. PyroWave is **not enabled as a live Shared Browser codec**.

The native source, Granite dependency and browser decoder are pinned in [the transport guide](pyrowave-transport.md#packaging-and-host-qualification). Build tools and binaries were prepared privately in the development workspace; no system packages were installed. The development dependency locks now include the pinned browser decoder and WebSocket transport; these have not been deployed to the live plugin. The separate visible GPU graphics setting is activated on home; Paseo's daemon was not restarted.

## Native experiment

The [benchmark helper](../scripts/native/README.md) completed all twelve combinations of 1280×800/2560×1600, 30/60 FPS byte budgets, and 100/200/250 Mbps. Each run used eight warmup frames and sixty measured frames. It generated synthetic I420 fine lines, checkerboards, gradients and a moving block; its chroma signal changed deterministically.

Representative measurements:

| Resolution | FPS byte budget | Mbps budget | Host encode including completion wait, p95 | Native decode including CPU readback, p95 | Synthetic luma PSNR |
| --- | --- | --- | --- | --- | --- |
| 1280×800 | 30 | 100 | 1.97 ms | 1.14 ms | 55.02 dB |
| 1280×800 | 60 | 100 | 1.90 ms | 0.86 ms | 30.85 dB |
| 2560×1600 | 30 | 250 | 5.61 ms | 3.23 ms | 43.97 dB |
| 2560×1600 | 60 | 250 | 4.75 ms | 3.15 ms | 29.33 dB |

Runs were unpaced and serialized, with CPU-buffer upload and readback. “FPS” sets the encoded byte budget; it does not establish sustained streaming FPS. The live host could have other work affecting timings. These synthetic quality figures do not substitute for actual text/layout inspection. Quality drops when the same bitrate is divided across more or larger frames. I420 already limits chroma detail, irrespective of the encoder.

## Browser compatibility experiment

The pinned `@trev.zip/pyrowave-webgpu` 0.3.0 decoded native packets in an isolated hardware Chromium browser. All three decoded planes were compared with the independent native decoder's 8-bit I420 output. Maximum error was below 0.71 of one 8-bit code value in both tested fixtures. The high-level decoder also emitted a real RGB `VideoFrame` that was drawn to a canvas and closed.

| Native fixture | WebGPU decode through queue completion, p50 | p95 |
| --- | --- | --- |
| 1280×800, 30 FPS/100 Mbps budget | 2.6 ms | 2.7 ms |
| 2560×1600, 30 FPS/250 Mbps budget | 5.0 ms | 5.1 ms |

These timings replayed one complete fixture per profile, with eight warmup decodes and thirty-two measured decodes. They include submission through GPU queue completion, with output readback and high-level drawing tested separately. They exclude streaming capture, transport, presentation and input latency. Initialization was much slower than warm decoding, so it must be kept out of the steady-state frame path. Do not add separate p95 figures to claim a measured end-to-end p95.

The experimental preflight refused mismatched dimensions/chroma, truncated or oversized packets, excessive dimensions, invalid block indices/counts and mixed frame sequences before GPU allocation. Native packets were also required to assemble completely. The package's high-level decoder alone does not perform that completeness gate; production integration must retain an explicit preflight and still needs malformed-input review, resource limits and lifecycle fencing.

## Same-source text and colour lines

Both codecs received identical full-range BT.709 I420 bytes generated from a text and fine-line canvas. H.264 used realtime WebCodecs at 30 FPS, one keyframe and fifteen subsequent frames, with latency optimization enabled at decode. PyroWave encoded each complete frame independently. These static fixtures favor H.264 temporal compression, so they are useful comparisons rather than a general quality ranking.

| Resolution | H.264 24 Mbps, last delta RGB PSNR | PyroWave 100 Mbps | PyroWave 250 Mbps |
| --- | --- | --- | --- |
| 1280×800 | 43.55 dB | 45.54 dB | 45.77 dB |
| 2560×1600 | 46.14 dB | 39.87 dB | 48.53 dB |

At the larger size, the 100 Mbps PyroWave budget was worse than H.264 on this fixture; 250 Mbps improved it at a substantial bandwidth cost. Neither codec restores chroma detail already lost in I420 capture. The same-source crop image was inspected alongside these measurements. No universal sharpness improvement or lower end-to-end latency has been established.

## Exact-tab development prototype

An isolated hardware Chromium tab supplied native I420/NV12 frames through a single-client authenticated binary loopback channel into the persistent native GPU encoder. Six resulting frames were decoded by the actual bounded viewer adapter and drawn to a real canvas. A document-generation reset dropped old output, and changing the owning attachment refused later reads. Teardown closed the owned encoder/listener and recorded private credential revocation.

The viewer validates dimensions, chroma, sequence, block indices, payload extents and complete encoded blocks before GPU allocation. Unit regressions cover copy cancellation, duplicate credits, bounded decode queues, delayed initialization, late output and per-cohort device failure. Existing source-clock age is retained. The early prototype used synthetic viewer receipts and granted no control. Later qualification passed the real supervisor-issued presentation and input path.

## Final integrated qualification

Authenticated direct LAN playback to Windows Edge passed with its hardware Qualcomm WebGPU adapter, two viewers, source fencing, real input receipts and return to compatible video without replacing the browser. Windows viewer drawing slowed after a few seconds despite continuing receipt and decoding. Those runs establish connectivity and lifecycle behavior, not sustained LAN latency.

Separate headed X11 viewer runs on the home server measured the final integrated capture and decoder. Each row is one 10-second sample after warmup, with 16 guarded clicks. The page contains fine text and a large animated noise region.

| Source | Codec budget | Presented FPS | Source age p50/p95 | Encoded payload | Guarded click response p50/p95 |
| --- | --- | --- | --- | --- | --- |
| 1280×800 | PyroWave 100 Mbps | 22.9 | 68.5/82.5 ms | 76.3 Mbps | 250.5/356.5 ms |
| 1280×800 | Compatible 24 Mbps | 23.4 | 72/100 ms | 18.5 Mbps | 230/261 ms |
| 2560×1600 | PyroWave 200 Mbps | 14.2 | 125.5/148.5 ms | 94.7 Mbps | 636.5/777.5 ms |
| 2560×1600 | Compatible 24 Mbps | 23.0 | 95/118 ms | 33.5 Mbps | 671/800 ms |

A separate ordinary text/small-animation page at 2560×1600 with compatible video used 1.76 Mbps payload, presented 21.2 FPS and measured 74.5/88.5 ms source age. Guarded click response was 618.5/706.5 ms. These click measurements include the agent control and presentation safety path; they do not measure live pointer latency. Source age ends at canvas presentation, not physical screen illumination. Payload excludes transport overhead. These local runs are not LAN latency figures.

The qualified Chromium software-compositor capture path mislabeled limited-range BT.601 planes as BT.709. A narrowly gated correction now preserves the actual capture colour interpretation in both codecs. Real colour swatches pass at 1× and 2×. The gate requires the exact qualified browser build and graphics path; other builds need separate qualification.

Compatible video remains the default. PyroWave is experimental and has not shown a general performance advantage, particularly at 2×. WSL ARM64 hardware D3D12 produces compatible H.264 video; its current software-only Vulkan path is refused for optional native PyroWave encoding. Sustained LAN congestion/loss testing and physical display latency remain unqualified. Current H.264 encoding is software.
