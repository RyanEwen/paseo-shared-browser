# Rich page and route transition responsiveness

Warm-encoder and bounded final-frame corrections are implemented, qualified and activated on the home server after an explicitly approved restart window. Paseo stayed running; saved preferences and persistent profiles were preserved. The public PrintStream Home-to-FAQ transition is now measured directly in private profiles. No PrintStream data was modified.

## What was measured

The controlled rich-page fixture changes 75 image cards and their text, at 1280 by 800 CSS pixels captured at 2560 by 1600. It compares the identical change with and without a same-document URL update. Standard video requests the user's current 96 Mbps and 60 FPS. All browser profiles, displays and viewers are private.

Each condition has eight transitions. Streaming-off samples run before and after streaming-on samples to expose rendering cost and warmup effects. The independent receiver uses the production decoder and canvas, with a separate one-pixel colour probe. It never reads back the production video canvas.

| Condition | Before, median | Warm encoder, median |
| --- | ---: | ---: |
| Visual change without route update, first matching viewer pixels | 81 ms | 80 ms |
| Same visual change with route update, first matching viewer pixels | 401 ms | 110 ms |
| Source rendering proxy during streamed route update | 18 ms | 20 ms |

The route-change median improved about 73% in this fixture without changing quality, capture resolution, bitrate or frame-rate target. Source rendering uses two animation-frame callbacks as a scheduling proxy, not physical presentation. Viewer time ends at the canvas draw, not display scanout. Native reads are passed to the private receiver over local test CDP, so these numbers isolate the producer and decoder rather than measuring Paseo relay/network latency or the actual PrintStream app. The marker verifies the new view's colour, not full-page completion. These are short serial samples, not a general latency promise.

With streaming disabled, the source rendering proxy ranged around 19–31 ms across the conditions. With streaming enabled it remained around 18–34 ms. Streaming does consume additional host resources, but this comparison points to route recovery, rather than page rendering contention, as the dominant added delay in the fixture. It does not rule out contention in the real application or under higher host load.

## Cause and correction

The runtime treats same-document navigation as an authority boundary. That must continue: old frames, element references and gestures cannot target the new route. Previously the encoder was also closed and reconstructed at each such boundary. This added costly codec initialization to ordinary application tab switches.

The correction retains the native encoder across document/action boundaries on the same capture track. It still requires a fresh independent picture. Outstanding native submissions retain their original generation and occupy the existing two slots until output or the existing bounded stall recovery. Old output releases its slot but cannot publish or disturb a newer generation's key state. Unknown output still requests recovery. Genuine codec stalls still replace the codec; physical source teardown still closes it.

No old frame receives a new timestamp or authority. Controller, runtime, navigation, viewport, attachment, receipt age and cancellation checks remain. No quality reduction, additional queued frames or new dependency is introduced.

## Verification

Shipped-program tests cover two occupied native slots across a route change, late old output after a new key, repeated route boundaries, silent-drop recovery and healthy sibling cohorts. Actual public supervisor RPCs and the production decoder prove that a same-document route change retains the exact encoder, rejects the previous frame for input and paints the new route. Existing real mouse/touch, navigation, viewport and high-bitrate checks also pass.


## Actual PrintStream Home to FAQ

The public Home-to-FAQ case was measured in isolated browser profiles. An initial DOM-ready timestamp filter could exclude an already displayed new picture. Those older measurements remain private diagnostic artifacts and are not used here as proof of source-capture delay.

The corrected diagnostic establishes a decoded baseline, assigns each transition a unique eight-bit visual marker, waits the same idle duration, and observes raw Y-plane pixels immediately after the track reader returns. It separately records submission, output, viewer draw, navigation and Chromium capture/compositor events. It does not weaken production timestamp or generation fences.

In one slow transition, FAQ DOM readiness was about 83 ms. Raw reads near 68, 94 and 124 ms still contained the old marker. The new marker reached the raw reader near 1147 ms and the viewer near 1219 ms. Chromium's trace shows a newer surface activation, a rejected compositor capture, then 29 rejected refresh attempts before another pixel copy. No pixel copy occurs during that wait. A later fast transition delivered the new marker near 72 ms and drew it near 176 ms.

A second diagnostic records Chromium's native protobuf trace from capture startup. It contains 723 captures. Capture zero fails after 6.9 ms with result 2, `kI420ReadbackFailed`; 722 later captures succeed. There is no intervening stop. During the first slow transition, 29 ordinary refreshes are rejected, and capture resumes through an explicit demand about one second after the final compositor rejection. Successful pixel copies take at most about 25 ms in this run.

The pinned Chromium 155 implementation increments the oracle's pending count for each recorded capture, but its failed-readback delivery path skips completion. Later successful captures add and subtract one, preserving that leaked count. Ordinary refresh admission requires zero pending captures, while explicit demand and compositor updates do not. Together with the failure and demand timeline, this identifies pending-count leakage as the refresh-suppression cause in this fixture. The event named `FpsRateLimited` covers any oracle rejection, not just a configured FPS ceiling. Sources: [capture delivery and accounting](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc), [oracle admission](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/media/capture/content/video_capture_oracle.cc).

The direct upstream correction is exactly-once oracle completion for recorded captures, including failure paths without double completion on oracle rejection. No Chromium fork or upstream post has been created. A local bounded explicit refresh demand is being evaluated on the existing owned track; it is not yet a qualified product correction.

## Final changed-frame admission

A separate serial raw-pixel diagnostic establishes an application-level loss: marker 3 arrives at the helper about 84 ms after navigation, with no native work or output awaiting ACK. Its source timestamp is only 13.3 ms after the previous submission, below the 60 FPS interval, so the old loop closes it. No newer source picture arrives until a later demand repeats those pixels. This is distinct from the first transition whose new pixels never reach the reader during the stall.

Standard WebCodecs now retains one source-wide newest picture when at least one active cohort has not encoded it. New arrivals replace and close older retained pixels. Per-cohort timestamp deduplication prevents repeated keys or fast viewers from encoding a picture again while a slower cohort still needs it. Native work plus output awaiting ACK remains bounded to two slots per cohort. This adds one retained source picture, not a third native encode slot or an encoded-frame queue.

A monotonic deadline can admit a final throttled picture without requiring a future source timestamp. Actual deferred submissions start the next pacing deadline without catch-up credits. Ordinary admission still uses source timestamp intervals; this policy is not a strict wall-clock FPS ceiling under all bursts. Output and ACK callbacks schedule the same synchronous drain, and do not grant capacity independently of the existing slot count.

Retention expires 250 ms after the original raw read, including asynchronous software colour correction. A cleanup timer releases it even if no more input or callbacks arrive. Downstream calibrated source-clock freshness remains unchanged; retention never renews the original timestamp or receipt authority. Reset, source replacement, stop, reader completion and reader rejection cancel timer ownership and close retained pixels. An old-generation asynchronous copy cannot be relabelled. The PyroWave raw-copy path is unchanged.

The actual-site candidate trace confirms that capacity-blocked markers 3 and 9 are submitted with their original timestamps about 5 and 11 ms after arrival. Marker 5, both capacity-blocked and only 7 ms after its predecessor, is submitted about 5 ms after arrival. Every first matching raw marker has a corresponding encode record. CPU checks overlapped part of this run, so these observations prove retention behavior rather than a clean end-to-end latency improvement. The first upstream capture wait remains.

Focused shipped-program tests cover the exact 13.3 ms case with no later source input, full native/output slots, different-rate cohorts, repeated key requests, newest-frame replacement, deferred pacing, original generation/timestamps, expiry without future input, terminal reader exits, late output/ACKs, and reset or source replacement during asynchronous colour copying. Colour work exceeding the retention age closes without encoding. The final 128-second native H.264 quality regression passes after these changes, including the idle key-suppression and absolute error checks. It retains only the last twelve decoded crops for error measurement, so it does not prove identical quality at every instant.

## Refresh-demand experiments and upstream repair

A private minimum-frame-rate burst did not establish its applied settings and is not part of the candidate. A single ImageCapture demand at navigation +150 ms reached Chromium but was rejected by its separate animation sampler. A later probe after compositor inactivity could return a resurrected existing picture; it did not establish a general latency bound. No ImageCapture, timer-based refresh probe or capture-flag variation was added to the product.

A private uncompiled C++ accounting-patch draft and upstream-report draft preserve the evidence for the Chromium defect. Neither has been submitted, installed or published. Repairing the browser directly requires a separately qualified build; ordinary warmup or skipping the first frame cannot clear leaked native accounting.

## Idle quality regression discovered during acceptance

The longer test caught a periodic static keyframe restoring the original 17.30 RMSE compression level, with unchanged following deltas failing to refine it. Periodic keys now additionally require sustained admitted cadence: at least a quarter-second of the target frame count with consecutive gaps at most 250 ms. This is an admission heuristic, not pixel-motion detection. Explicit join, navigation/action and loss recovery still force fresh keys. The source frame is never dropped or retimestamped by this cadence decision. The 128-second native H.264 regression passes, including at least 120 idle pictures, no periodic idle key, and final error below 14 against the JPEG-derived reference. The old prepared package remains superseded.

## Activation verification

The reviewed self-contained runtime is live on the home server. All 1,001 unit tests and four serial native checks passed before activation, including the 128-second H.264 quality test. Frozen dependency validation, check, build, typecheck and script tests passed; four pre-existing informational lint findings remain. A separate read-only deployed-stream check decoded and painted through the production viewer in an owned private browser. It acquired no source control and did not navigate the live page. GPU rendering, screenshot capture and optional PyroWave capability were verified. Settings, profiles and durable agent bindings were preserved, and the Paseo daemon did not restart.

Browser tabs and existing browser references were invalidated by the approved restart. The workspace's prior URL and viewport were restored. This update fixes the local admission and encoder-reset costs; it does not repair Chromium's separate initial-capture accounting defect. Changes remain uncommitted.
