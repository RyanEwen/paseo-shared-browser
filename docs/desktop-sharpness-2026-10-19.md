# Desktop sharpness investigation

The fractional-capture experiment was rolled back on October 19, 2026 after the user reported a worse picture. The live home server again uses the qualified 1x or 2x automatic source policy. The experimental source and measurements are kept in the private local archive; they are excluded from the working implementation.

## Regression

The desktop reported 150% scaling for a 1151 by 1469 CSS viewport. Fractional capture produced 1727 by 2204 pixels, while the previous 2x source produced 2302 by 2938. The odd fractional width changed the negotiated Standard codec from H.264 to VP8, despite unchanged 24 Mbps and 60 FPS preferences.

Earlier native checks validated fine detail at even fractional image sizes, but checked only dimensions at the actual odd desktop size. That coverage gap missed image degradation. A subsequent physically aligned, far-edge one-pixel fixture failed the existing contrast thresholds on the fractional path. The same viewport passed with the restored 2x path. Dimensions and the page's reported DPR are insufficient evidence of source sharpness.

[Chromium 155's screen metrics emulator](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/third_party/blink/renderer/core/frame/screen_metrics_emulator.cc) retains native compositor density independently of emulated page DPR. A matching fractional view therefore requires care beyond setting the page DPR. The tested plain-scale/backing-widget adjustment is not qualified for general deployment.

The rollback completed at 5:28 p.m. America/Toronto in the user-approved window. H.264 at 2302 by 2938 was verified using a temporary comparison viewer reporting the previously measured desktop display demand, then that report was retracted. The user's page, CSS size, preferences, profiles and durable agent bindings were preserved. Paseo was not restarted. Browser identities changed during the restart.

## Compression during movement

An isolated 40-frame moving-text comparison reproduced progressive improvement after movement stopped on both VP8 and H.264. Constant bitrate did not improve the VP8 result appreciably. A screen-content hint improved moving error somewhat but worsened the final static result, so neither change was adopted.

With the same restored 2302 by 2938 H.264 source and 60 FPS target, raising the budget reduced moving-text RGB error (lower is better):

| Target | Moving-text RMSE | Final static RMSE |
| --- | ---: | ---: |
| 24 Mbps | 17.32 | 7.46 |
| 48 Mbps | 9.47 | 7.02 |
| 96 Mbps | 6.11 | 5.65 |

These are synthetic encoder-only comparisons against each case's unencoded image, not measured desktop FPS, network bandwidth, or input latency. The harness awaits each decoded frame, so its elapsed time does not establish realtime throughput. Higher budgets are optional; saved rates and defaults are preserved. They require more bandwidth and remain subject to the existing packet, queue and image bounds.

The 48 and 96 Mbps choices are implemented, validated and live on the home server. Both produce actual H.264 packets and decoded 2302 by 2938 images in a disposable native Wayland test. All 968 unit tests, four script-test files, build, typecheck and lint checks pass (four existing informational lint findings).

The Standard name and actual-codec browser bar are already live, applied through a bridge-only refresh with browser processes, runtime, tabs and preferences retained.

The higher-budget runtime was activated at 5:43 p.m. America/Toronto in a fresh user-approved five-minute window. Both rates delivered H.264 video in the live workspace. The selected 24 Mbps and 60 FPS preferences stayed unchanged; the page, CSS display size, persistent profiles and durable agent bindings were preserved. Hardware Wayland rendering remained active and Paseo was not restarted. The restart window ended after verification. Changes remain uncommitted.
