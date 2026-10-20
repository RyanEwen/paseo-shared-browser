Shared Browser runs one real Chromium browser per workspace on the daemon host and shows that same live page to every connected Paseo client, so viewers and agents act on one page with one set of cookies and logins. Many viewers can watch, and one human at a time holds control. Open it from the Command Center, the **Shared Browser** composer pill, or the sidebar footer.

## How it works

- Chromium runs on the daemon host and uses that host's network, including local development servers. Clients receive streamed frames and send input. Phone and tablet presets emulate the screen size and user agent in Chromium, and do not run Safari.
- Control is taken and released explicitly, and agents cannot take control from a human who holds it.
- Each workspace keeps a private browser profile in the Paseo data directory, so logins survive disconnects and reloads. It is kept when a workspace is archived and must be deleted by hand if no longer wanted. It does not use your personal browser profiles.
- Closing a panel keeps the browser running, and archiving the workspace closes it.

## Agent access

New agents whose provider accepts external MCP servers receive a local MCP server with tools to check status, capture the page, take and release control, navigate, send input and set the viewport. A bounded semantic DOM snapshot gives element references for click, fill and select without intermediate screenshots. References expire and are tied to the observed document and tab; mutations require control. Screenshots and live gestures remain available for canvas and visual work.

Synchronous JavaScript inspection runs with Chromium's side-effect checker in an isolated world, with time and output limits. It can read the DOM but cannot access page script globals. Snapshots omit form values; explicitly requested inspection can read page data, and agent hosts may retain tool arguments. Profile access, arbitrary CDP and file access are not exposed. Agents can visit any address the host can reach, so use it with agents you trust.

## Setup

Open the monitor toolbar icon, then Quality and mode → Mode to choose Video or Screenshots. The choice is saved per host and defaults to Screenshots. Changes apply immediately without closing tabs or losing unsaved work. The UI clearly shows starting, active or unavailable video. Bitrate and frame-rate controls are available when video is on; other clients retain screenshots. Video retains headless operation so it can continue while the desktop is locked.

Display Size groups desktop sizes, mobile devices and Custom. Image detail automatically matches the highest display need among visible clients, within capture limits. Moving between differently scaled screens updates detail without closing tabs. Higher detail uses more processing and bandwidth.

Quality and mode also offers experimental PyroWave LAN when qualified native GPU assets are installed on the host. It requires WebGPU on the viewer and uses much more bandwidth. Performance varies with the host and image size; standard video remains the default. Unsupported clients or connections visibly fall back to standard video.

Graphics in the display menu saves Host default, Vulkan GPU (Linux), or Wayland GPU (Linux x64 with prepared native assets) per host and reports the renderer observed at startup. Wayland uses a private hardware display while retaining independent tabs, screenshots and video. Saving preserves open tabs. An explicit Restart and apply action applies a different backend to this workspace, with a warning that all its tabs close and unsaved page changes are lost. Existing WSL graphics remain supported under Host default. GPU rendering does not imply hardware H.264 encoding.

- Paseo ^0.11.0, and Node.js 24 or newer on the daemon host.
- Chromium is downloaded when the plugin is installed and stored in the Paseo data directory. On Linux ARM64 nothing is downloaded, and you install a non-Snap Chromium at `/usr/bin/chromium` first. `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE` points the plugin at a different Chromium.

## Limits

Downloads, uploads, clipboard sync, media permissions, extensions and passkeys are not available. Viewers who are paired with the same daemon can see and control the browser, and the browser runs with the daemon user's file and network access.
