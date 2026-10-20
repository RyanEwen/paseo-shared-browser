# Shared Browser

A shared Chromium browser for you and your coding agents, accessible from desktop or phone. It runs on your Paseo host, keeps workspace logins, and works without desktop focus, including while the host is locked.

## Install

```bash
paseo plugin install github:RyanEwen/paseo-shared-browser --ref main
```

Run on the Paseo host with plugins enabled, Node.js 24+ and npm installed. Requires a compatible Paseo 0.11 app and daemon. Open **Shared Browser** from a workspace or the Command Center.

## What this fork changes

Forked from Omer Cohen's [Shared Browser in omercnet/paseo-plugins](https://github.com/omercnet/paseo-plugins/tree/main/paseo-shared-browser). These are our additions and refinements, including contributions also accepted upstream:

- **More responsive streaming:** quicker page and app transitions, fewer missed updates, clearer text after movement, and automatic recovery from stalled or dropped video.
- **Video you control from the UI:** switch between screenshots and Standard H.264/VP8 video without closing tabs, with bitrate choices up to 96 Mbps and frame rates up to 60 FPS.
- **Experimental PyroWave LAN:** an optional GPU codec and direct WebRTC transport for high-bandwidth local connections. Requires a qualified host and a WebGPU viewer.
- **GPU graphics:** Linux Vulkan and private Wayland options for graphics-heavy sites, plus WSL D3D12 support. Choose graphics from the toolbar and see the renderer actually in use.
- **Automatic image detail:** matches the highest display need among visible viewers, within capture limits, including monitor scaling and zoom changes. No manual density setting.
- **Improved display menus:** compact desktop/mobile menus, current-setting summaries, resolution favorites, device presets, custom sizes and a viewport that follows the panel.
- **Improved mobile input:** direct keyboard typing, IME composition and Android video support through Paseo++. Mouse, touch, dragging and canvas interaction remain available.
- **Agents that can use forms:** element snapshots and direct click, fill, select, hover and type tools, plus bounded read-only JavaScript inspection. Screenshots remain available for visual work.
- **Fewer agent interruptions:** reconnect to the same workspace and selected tab after disconnects, keep trusted observations usable longer, and use agent viewports up to 3840 × 3840.
- **Shared tabs with clear ownership:** independent tab selection, per-tab control, human priority, and confirmed close/reopen actions that preserve saved site data.

## Paseo++

Built alongside [Paseo++](https://github.com/RyanEwen/paseo-plus-plus), our Paseo fork with additional desktop and mobile workflow improvements. This plugin also supports compatible upstream Paseo clients; native Android video requires the matching Paseo++ Android app. Other clients can use screenshots.

## Setup and details

Use the monitor toolbar icon, then **Quality and mode → Mode**, to enable video. Screenshots are the default. Standard video needs WebCodecs or the supported Android integration. Wayland and PyroWave require additional native assets; GPU rendering does not imply hardware H.264 encoding. PyroWave is experimental and is not guaranteed to be faster than Standard video.

[Full guide](docs/guide.md) · [PyroWave setup and limits](docs/pyrowave-transport.md) · [Streaming performance](docs/streaming-performance.md) · [Fork history](docs/standalone-migration.md)

MIT licensed. Original copyright and attribution are preserved in [LICENSE](LICENSE).
