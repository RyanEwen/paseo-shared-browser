# Private Weston build

This build uses Weston 16.0.1, Wayland Protocols 1.49 and libdisplay-info 0.4.0. The Ubuntu 24.04 build image preserves the home server's glibc 2.39 compatibility floor. Runtime rendering uses the host Mesa driver. This is currently qualified on Linux x64 only.

Download the three source archives from their upstream release pages into this build directory before building. The Dockerfile verifies their exact SHA256s. Do not commit downloaded archives or built binaries.

- https://gitlab.freedesktop.org/wayland/weston/-/releases/16.0.1
- https://gitlab.freedesktop.org/wayland/wayland-protocols/-/releases/1.49
- https://gitlab.freedesktop.org/emersion/libdisplay-info/-/releases/0.4.0

Build with `docker build -t shared-browser-weston-native:16.0.1 scripts/native/weston`. Use a temporary, non-running container to copy `/opt/shared-browser-weston` into a private build directory, then remove that container. No host package installation or persistent container is needed. Preserve `licenses/` with the build output.

Prepare the private cache with:

```
node scripts/prepare-wayland.mjs BUILT_PACKAGE PASEO_HOME/plugin-data/shared-browser/native-wayland
```

The preparer checks the binary version, flattens only in-tree library symlinks, records file checksums, and atomically replaces `current`. The runtime preparer copies verified assets into its new immutable runtime. Neither operation changes a running browser. Select **Graphics > Wayland GPU** for new browsers; applying to an existing browser uses the existing explicit restart confirmation.

The native bundle requires compatible host Wayland, libinput, DRM, EGL/GLES, GBM, Cairo/Pango and Mesa libraries. Missing libraries or a software renderer fail startup visibly. Host default and Vulkan remain available. Never fall back from an explicitly selected Wayland GPU mode by silently capturing the host desktop.
