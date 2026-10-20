# Private Linux GPU-capture experiment

This opt-in development runner compares the existing tab-capture pipeline with direct compositor capture and VAAPI H.264, using the actual Shared Browser decoder. It creates its own private Wayland compositor and Chromium profiles. It never connects to Paseo or supplies input authority. Do not use its images as proof that an input belongs to a production browser document.

Use an existing stock Chromium executable, Python 3.12, the checkout's locked development dependencies, and a readable Linux AMD render node at `/dev/dri/renderD128`. Obtain the released Pixelflux 2.1.0 CPython 3.12 manylinux wheel separately. The runner verifies SHA256 `776bb8e80970a2d07d391cf043b77a6cb203cfdff565dd43713dd07ce9bdf257` before extracting it into disposable storage. It does not install packages or download dependencies. The wheel is a research dependency with distribution restrictions described in the [design](../../docs/gpu-capture-prototype.md).

From the repository root, set explicit local paths:

```sh
PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
SHARED_BROWSER_GPU_PROTOTYPE_WHEEL=/absolute/path/to/pixelflux-2.1.0-cp312-cp312-manylinux_2_28_x86_64.whl \
SHARED_BROWSER_GPU_PROTOTYPE_REPORT="$PWD/.local-history/gpu-capture-prototype/local-run" \
node scripts/gpu-capture-prototype/run.mjs
```

Run native GPU experiments serially. Allow about a minute. Reports must stay under the checkout's ignored `.local-history` directory. They include synthetic frame diagnostics and private browser logs. `--direct-only` is a troubleshooting shortcut, not a matched comparison.

The runner checks two independently mapped pages with identical titles, changed private pixel challenges, shared profile storage, mixed 1×/2× capture, decoded route markers, and page retirement with a surviving sibling stream. The JSON reports distinguish source callbacks, received packets and actual presentations. Base64 JSON transport, CDP polling, synthetic content and a single sequential run limit performance conclusions. Hardware encoding and zero-copy reports do not establish production responsiveness, equal quality or isolation.

Run transport checks without GPU access:

```sh
node --test scripts/gpu-capture-prototype/processes.test.mjs
npx tsc --noEmit -p scripts/gpu-capture-prototype/tsconfig.json
```

The released compositor does not enforce exclusive per-tab render ownership or document provenance. Those production gates remain unimplemented. Existing browser installation, tabs, preferences and control rules remain untouched.
