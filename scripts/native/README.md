# Native PyroWave bring-up benchmark

`pyrowave-bench.cpp` is a development-only C API benchmark. It is not shipped in the installed Shared Browser runtime and does not capture any browser or desktop. It generates synthetic I420 luma lines, checkerboards, gradients and a moving rectangle; chroma has a deterministic changing signal.

Use PyroWave commit `21f099d24df0ab0e4c10c3288c924b6b1717e581`, its Granite commit `53090429539bf3404250d18fe58db971f0907c04`, and the exact submodule gitlinks selected by that Granite revision. The pinned PyroWave `checkout_granite.sh` identifies its standalone dependencies. Retain their MIT and other original licenses. Build in an ignored development directory, with no system installation:

```sh
# Set these to private absolute source/build locations, after checking out the pins.
cmake -S "$PYROWAVE_SOURCE" -B "$PYROWAVE_BUILD" \
  -DCMAKE_BUILD_TYPE=Release -DPYROWAVE_DEVEL=OFF -DPYROWAVE_UTILS=OFF
cmake --build "$PYROWAVE_BUILD" --target pyrowave-device-validation pyrowave-c-test -j 2

# Qualify your actual hardware IDs (hex); this example is the home AMD GPU.
"$PYROWAVE_BUILD/pyrowave-device-validation" --vid 1002 --pid 1638 --roundtrip --timeout 30
timeout 60 "$PYROWAVE_BUILD/pyrowave-c-test"

g++ -std=c++17 -O2 -Wall -Wextra \
  -I "$PYROWAVE_SOURCE" \
  -I "$PYROWAVE_SOURCE/Granite/third_party/khronos/vulkan-headers/include" \
  scripts/native/pyrowave-bench.cpp -L "$PYROWAVE_BUILD" -lpyrowave-shared \
  -Wl,-rpath,"$PYROWAVE_BUILD" -o "$PYROWAVE_BUILD/shared-browser-pyrowave-bench"

# WIDTH HEIGHT FPS MBPS FRAMES VENDOR_HEX DEVICE_HEX NEW_OUTPUT_DIRECTORY [INPUT_I420]
timeout 60 "$PYROWAVE_BUILD/shared-browser-pyrowave-bench" \
  1280 800 30 100 60 1002 1638 "$PYROWAVE_BUILD/first-fixture" > "$PYROWAVE_BUILD/first-result.json"
```

The helper checks C API 1.0.0, explicit device selection, even dimensions bounded to 3840, 20–600 measured frames, supported bitrate/frame-budget ranges, a 2 MiB encoded-frame buffer, packet counts/offsets and complete native decode. It refuses to overwrite an existing output directory. Always run it in a disposable process with an external timeout: a driver hang is outside the C API's work bounds.

Eight warmup frames precede measurements. JSON reports host encode submission, encode including completion wait, packetization, native decode including CPU readback, packet sizes and synthetic luma PSNR. GPU timestamp diagnostics go to stderr. `FPS` sets the per-frame byte budget; processing is **unpaced and serialized**, so this does not establish sustained 30/60 FPS, network latency or browser presentation performance. Do not add the p95 values to claim a measured end-to-end p95. Other work on a live host can affect these timings.

The output directory contains one synthetic frame's `source.i420`, native `decoded.i420`, `frame.bin` and a packet-offset `manifest.json` for independent browser decoder checks. Validate those dimensions, chroma, packet bounds and completeness before GPU allocation. A browser decoder must still enforce its own limits for received data; a manifest is not trusted input authority.

See the [transport and qualification guide](../../docs/pyrowave-transport.md) for browser integration, packaging, input policy and remaining limits.

An optional final `INPUT_I420` path repeats those exact I420 bytes instead of the synthetic animation. Its byte length must match the bounded even geometry. This supports a same-source comparison with another codec without a second RGB/YUV conversion changing the input.

`pyrowave-encoder.cpp` is the persistent exact-tab encoder helper. It accepts only configured even geometry, 100/200/250 Mbps and 15/30/60 FPS. Its private stdio protocol carries a fixed 32-byte header plus one exact contiguous I420/NV12 frame; encoded responses echo source sequence, timestamp and generation. The owning process enforces one frame in flight, a five-second deadline, a 2 MiB encoded bound and owned-child teardown. The helper rejects CPU Vulkan devices. It is included only when optional native assets pass preparation and runtime qualification.
