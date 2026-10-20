# PyroWave binary transport design

PyroWave is available as an optional mode on the qualified home server. Its isolated installed plugin passes authenticated signaling, binary WebRTC delivery, the actual client reader, WebGPU presentation and supervisor-issued input receipts. This does not establish cross-host reachability, sustained bandwidth or lower input latency.

The LAN transport uses a negotiated, unordered WebRTC data channel with zero retransmissions. Authenticated Paseo RPC carries bounded SDP signaling; video bytes use DTLS/SCTP separately from ordered browser control. Fingerprint verification stays enabled. The local prototype uses no STUN or TURN servers. Paseo relay availability does not imply that direct media will connect.

## Implemented development boundaries

- One application channel with 16 KiB messages. It carries media fragments in one direction and four-byte presentation credits plus bounded local observation-epoch markers in the other. Reliable authenticated heartbeat polling also renews the observation epoch, so losing a channel marker cannot permanently block input. Epoch markers cannot create receipts or change source ages. It accepts no input events or additional remote channels.
- One newest incomplete frame, at most 2 MiB of encoded video plus 32 KiB of schema-bounded metadata. Incomplete frames expire after 100 ms, including when no more fragments arrive. Duplicate fragments cannot extend the deadline.
- At most two sender frames in flight, overlapping transport and presentation without queuing pictures. Actual current presentation returns credit and retires older superseded transport slots without granting those pictures input authority. A lost credit expires after 150 ms; another picture is admitted only after the native sender's reported buffer drains. A buffered native send is never retried.
- Original runtime/session/navigation/viewport metadata and source timestamps travel unchanged. Binary media does not issue receipts or grant control. Frames still originate from the authenticated supervisor's normal viewer read.
- GPU dimensions, chroma, payload extents, block indices, sequence and complete blocks pass CPU checks before GPU allocation. Explicit device ownership fences delayed initialization and output, and device loss revokes pending presentation.
- Negotiation and connection setup have separate deadlines. Closing revokes callbacks before releasing the owned peer. Native binding cleanup must never stop another peer or service.

## Integration and recovery

The native binding runs in an owned Node worker process, separate from the plugin bridge, supervisor and browser. Eight peers and 4 MiB of outstanding raw IPC frame bytes are the global bounds. Each peer has one pending frame command with a one-second deadline. Its environment contains no agent credentials or Node options. Only the retained child handle can be stopped by cleanup.

Authenticated open, poll and close requests retain the original viewer and exact workspace/tab/session/runtime/navigation/viewport binding. A 15-second client heartbeat expires abandoned media independently of server capture reads. Closing a channel retains its pending supervisor-read barrier until it settles, including when channel failure arrives before explicit close. A new codec cannot overlap that old viewer read. A failed native worker can be replaced without restarting the supervisor or browser.

The client uses a negotiated unordered channel with no external ICE servers. Connection, WebGPU or media failure selects standard video, shows the actual path prominently and offers Retry PyroWave. It does not replay input. The existing JPEG fallback remains available. Closed or superseded media readers cannot publish late packets, and old local observation epochs cannot become new input authority.

**Display options → Quality and mode → Video codec** contains the explicit choice. Standard video remains the default. PyroWave has a separate 100/200/250 Mbps budget; changing it preserves the H.264/VP8 bitrate preference. Saving either choice preserves tabs and applies without a browser restart. Unsupported clients keep standard video and explain why PyroWave is unavailable.

## Packaging and host qualification

- [PyroWave](https://github.com/Themaister/pyrowave/tree/21f099d24df0ab0e4c10c3288c924b6b1717e581): commit `21f099d24df0ab0e4c10c3288c924b6b1717e581`, C API 1.0.0.
- Granite: commit `53090429539bf3404250d18fe58db971f0907c04`, including its exact submodule revisions.
- [@trev.zip/pyrowave-webgpu](https://www.npmjs.com/package/@trev.zip/pyrowave-webgpu): version 0.3.0, MIT-licensed browser decoder.

Native preparation requires the pinned sources below, an existing C++ toolchain and a built shared library. The owner-operated `scripts/prepare-pyrowave.mjs` verifies complete source inventories against checksummed pinned archives, builds the helper, retains dependency notices, and runs an actual GPU encode before publishing a private native-cache pointer. Failed preparation preserves the previous cache pointer.

Immutable-runtime preparation includes optional native assets only after another GPU encode check. A platform/architecture manifest hashes every helper, library, worker and transitive native-loader file. Runtime admission rejects altered, missing, unlisted or symbolic-link native assets. Missing optional assets leave standard video working. Native compilation is not attempted automatically during normal viewing, and no system GPU packages are installed.

The pinned transport binding is [node-datachannel](https://github.com/murat-dogan/node-datachannel), npm 0.33.4, using its platform-specific N-API package. It is MPL 2.0 licensed; retained notices and source availability obligations apply when distributing it. PyroWave, Granite, and the WebGPU decoder retain their original notices. No host/system package was installed for the candidate.

Home-server Linux x64 packaging and real public-RPC loopback playback pass. Ryan-Laptop WSL ARM64 packaging, hardware D3D12 graphics and H.264 fallback pass with Chromium 154. Its current Vulkan device is CPU-only llvmpipe, so it is not a qualified PyroWave encoder host. GPU rendering through D3D12 does not establish Vulkan compute support.

Actual direct LAN playback passes from the Linux host to a temporary Windows Edge 155 viewer with hardware Qualcomm WebGPU. This uses direct DTLS/SCTP media, with SSH only for test signaling and diagnostics. Two viewers, authenticated input receipts and return to standard video pass without replacing the tab.

Local sustained rendering and authenticated input also pass with a private X11 consumer at 1280×800 and 2560×1600. The comparison uses a ten-second sampled window after warmup, plus 16 discrete tool clicks. PyroWave uses substantially more payload bandwidth and is slower than standard video in the 2× stress case; there is no demonstrated general performance advantage. These are local source-to-canvas measurements, not physical-display or cross-host latency.

The temporary Windows viewer pauses compositor drawing while packet receipt continues, so its successful-frame-only timings are excluded from performance claims. The source Linux headless browser and the explicit X11 consumer remain separate configurations. WSL UDP reachability, longer runs and congestion/loss behaviour remain qualification limits; no firewall or driver setting was changed.

## Source colour

Raw frames preserve bounded SDR matrix/range metadata through native encoding, transport and decoder configuration. Unknown/HDR metadata is refused rather than silently interpreted as full-range 709. This does not restore 4:4:4 colour detail already lost by the tab capture's 4:2:0 conversion.

The qualified Chrome 155.0.8059.84 headless Linux/Vulkan software-compositor path has an upstream mismatch: its bitmap conversion emits 601-limited I420 but the capturer labels it 709. The implementation confines a matrix correction to that exact positively traced configuration, software-compositor status and expected I420 metadata. Other builds and backends preserve their reported metadata. The exception needs requalification on a browser upgrade. See Chromium's [bitmap conversion](https://github.com/chromium/chromium/blob/main/components/viz/common/frame_sinks/copy_output_result.cc) and [capture labelling](https://github.com/chromium/chromium/blob/main/components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc).

Both native video and PyroWave receive a frame reconstructed from unchanged planes with the correct matrix. Timestamps and display geometry are preserved; late copies are discarded on source retirement. This adds one bounded source copy (about 1.54 MB per 1280×800 frame). Actual white/black/RGB patches pass through both codecs at 1× and 2×. Transfer metadata is retained, not guessed.

## Remaining qualification

Longer LAN runs, congestion and loss behaviour remain qualification work. True RGB/4:4:4 capture, GPU texture sharing across processes and broader native/mobile decoding are future scope. Current I420/NV12 capture has already lost chroma detail; converting it to RGBA cannot recover it. Compare rendering, capture, copies, encode, transport and presentation separately using the same source. Codec-only timings do not establish end-to-end responsiveness. See the [benchmark](pyrowave-benchmark-2026-10-18.md) and [streaming performance work](streaming-performance.md) for measurements and their limits.
