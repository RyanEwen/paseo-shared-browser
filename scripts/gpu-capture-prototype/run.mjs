/** Explicit, isolated Linux feasibility runner. It never connects to a Paseo daemon. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { provisionWindows } from "./binding.mjs";
import { measureStreams } from "./measure.mjs";
import { createPrototypeProcesses, evaluate, until } from "./processes.mjs";
import { sourceHtml } from "./source.mjs";

let CdpConnection;
let attachToTarget;
let stopOwnedChild;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const chrome = process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE;
const wheel = process.env.SHARED_BROWSER_GPU_PROTOTYPE_WHEEL;
const reportDirectory = process.env.SHARED_BROWSER_GPU_PROTOTYPE_REPORT;
assert(
  process.platform === "linux" && chrome && wheel && reportDirectory,
  "Set explicit Chromium, verified Pixelflux wheel and private report paths on Linux",
);
assert(
  resolve(reportDirectory).startsWith(`${join(root, ".local-history")}/`),
  "Prototype reports must remain in this checkout’s ignored .local-history directory",
);
const wheelHash = "776bb8e80970a2d07d391cf043b77a6cb203cfdff565dd43713dd07ce9bdf257";
const work = await mkdtemp(join(tmpdir(), "shared-browser-gpu-prototype-"));
const result = { inputAuthorityIssued: false, mappings: [], measurements: [], checks: {} };
const cleanEnvironment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  XDG_RUNTIME_DIR: join(work, "wayland"),
  XDG_CACHE_HOME: join(work, "cache"),
};
let helper;
let viewer;
let fixtureServer;
let videoSourceTime;
let processes;

try {
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await mkdir(cleanEnvironment.XDG_RUNTIME_DIR, { mode: 0o700 });
  const cdpModule = await build({
    entryPoints: [join(root, "server/cdp.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  await writeFile(join(work, "cdp.mjs"), cdpModule.outputFiles[0].contents);
  ({ CdpConnection, attachToTarget } = await import(pathToFileURL(join(work, "cdp.mjs")).href));
  // Verify and extract locally. The wheel is not installed into any interpreter environment.
  const cleanupModule = await build({
    entryPoints: [join(root, "server/owned-child.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  await writeFile(join(work, "cleanup.mjs"), cleanupModule.outputFiles[0].contents);
  ({ stopOwnedChild } = await import(pathToFileURL(join(work, "cleanup.mjs")).href));
  const clockModule = await build({
    entryPoints: [join(root, "server/native-video-buffer.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  await writeFile(join(work, "clock.mjs"), clockModule.outputFiles[0].contents);
  ({ videoSourceTime } = await import(pathToFileURL(join(work, "clock.mjs")).href));
  fixtureServer = createServer((_request, response) => response.end(sourceHtml));
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  const sourceOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  processes = createPrototypeProcesses({
    chrome,
    work,
    cleanEnvironment,
    CdpConnection,
    stopOwnedChild,
    reportDirectory,
  });
  const { child, rpc, browser } = processes;
  const wheelBytes = await readFile(wheel);
  assert.equal(createHash("sha256").update(wheelBytes).digest("hex"), wheelHash);
  const extracted = join(work, "wheel");
  const extract = child(
    "python3",
    [
      "-c",
      "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      wheel,
      extracted,
    ],
    "extract",
  );
  assert.equal((await once(extract, "exit"))[0], 0);
  const module = await build({
    entryPoints: [join(root, "server/native-video-extension.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  await writeFile(join(work, "extension.mjs"), module.outputFiles[0].contents);
  const { prepareNativeVideoExtension, NATIVE_VIDEO_EXTENSION_ID } = await import(
    pathToFileURL(join(work, "extension.mjs")).href
  );
  const staged = await prepareNativeVideoExtension(join(work, "ipc"));
  const extension = join(work, "prototype-extension");
  await cp(staged, extension, { recursive: true });
  await writeFile(
    join(extension, "control.html"),
    "<!doctype html><title>Owned GPU prototype controller</title>",
  );
  await writeFile(
    join(extension, "provision.html"),
    '<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{width:100%;height:100%}</style><canvas></canvas><script src="provision.js"></script>',
  );
  await writeFile(
    join(extension, "provision.js"),
    `
let bits='0'.repeat(128);const c=document.querySelector('canvas'),g=c.getContext('2d');
function paint(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;g.fillStyle='#777';g.fillRect(0,0,c.width,c.height);for(let n=0;n<128;n++){g.fillStyle=bits[n]==='1'?'white':'black';g.fillRect(64+n%32*16,160+Math.floor(n/32)*16,16,16)}}
window.setChallenge=async value=>{bits=value;paint();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true};addEventListener('resize',paint);paint();`,
  );
  const captureProcess = child(
    "python3",
    [join(root, "scripts/gpu-capture-prototype/capture.py"), extracted],
    "capture",
  );
  helper = rpc(captureProcess);
  const { socket } = await helper("initialize");
  const source = await browser(
    "source",
    [
      "--ozone-platform=wayland",
      "--enable-gpu",
      "--use-gl=angle",
      "--use-angle=gl-egl",
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      `--allowlisted-extension-id=${NATIVE_VIDEO_EXTENSION_ID}`,
      "about:blank",
    ],
    { ...cleanEnvironment, WAYLAND_DISPLAY: socket },
  );
  const controlTarget = await source.send("Target.createTarget", {
    url: `chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/control.html`,
    hidden: true,
    background: true,
  });
  const controller = await attachToTarget(source, controlTarget.targetId);
  await writeFile(
    join(reportDirectory, "controller.json"),
    JSON.stringify(
      await evaluate(
        controller,
        "({url:location.href,body:document.body?.innerText,api:Object.keys(chrome),runtime:!!chrome.runtime,ready:document.readyState})",
      ),
      null,
      2,
    ),
  );
  await until(
    () => evaluate(controller, "typeof chrome.windows?.create==='function'"),
    "trusted controller API",
  );
  const compiled = await build({
    entryPoints: [join(root, "scripts/gpu-capture-prototype/viewer.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    plugins: [
      {
        name: "platform",
        setup(b) {
          b.onResolve({ filter: /^react-native$/ }, () => ({
            path: "platform",
            namespace: "prototype",
          }));
          b.onLoad({ filter: /.*/, namespace: "prototype" }, () => ({
            contents: 'export const Platform={OS:"web"}',
            loader: "js",
          }));
        },
      },
    ],
  });
  await writeFile(join(work, "viewer.js"), compiled.outputFiles[0].contents);
  await writeFile(
    join(work, "viewer.html"),
    '<!doctype html><title>Owned visual-only GPU viewer</title><script defer src="viewer.js"></script>',
  );
  const consumer = await browser(
    "viewer",
    [
      "--headless=new",
      "--enable-gpu",
      "--use-angle=vulkan",
      "--enable-features=Vulkan",
      "--disable-vulkan-surface",
      pathToFileURL(join(work, "viewer.html")).href,
    ],
    cleanEnvironment,
  );
  const viewerTarget = await until(
    async () =>
      (await consumer.send("Target.getTargets")).targetInfos.find((p) =>
        p.url.endsWith("/viewer.html"),
      ),
    "viewer target",
  );
  viewer = await attachToTarget(consumer, viewerTarget.targetId);
  await until(() => evaluate(viewer, "typeof inspectChallenge==='function'"), "viewer script");
  result.mappings = await provisionWindows({
    source,
    controller,
    viewer,
    helper,
    evaluate,
    until,
    attachToTarget,
    reportDirectory,
    extensionId: NATIVE_VIDEO_EXTENSION_ID,
  });
  result.checks.mapping = true;
  result.measurements = await measureStreams({
    source,
    viewer,
    helper,
    mappings: result.mappings,
    evaluate,
    until,
    attachToTarget,
    extensionId: NATIVE_VIDEO_EXTENSION_ID,
    sourceOrigin,
    videoSourceTime,
    phases: process.argv.includes("--direct-only") ? ["direct"] : ["standard", "direct"],
    record: (name, data) =>
      writeFile(join(reportDirectory, `${name}.json`), JSON.stringify(data, null, 2)),
  });
  result.checks.sharedProfile = true;
  result.checks.twoConcurrentSources = true;
  await writeFile(
    join(reportDirectory, "mapping.json"),
    JSON.stringify(result, (_key, value) => (_key === "page" ? undefined : value), 2),
  );
  console.log("Mapped two exact CDP targets using changed private pixel challenges");
} catch (error) {
  result.error = String(error);
  throw error;
} finally {
  if (viewer) await evaluate(viewer, "typeof finish==='function'&&finish()").catch(() => {});
  await processes?.close().catch((error) => {
    result.cleanupError = String(error);
    process.exitCode = 1;
  });
  await writeFile(
    join(reportDirectory, "result.json"),
    JSON.stringify(result, (_key, value) => (_key === "page" ? undefined : value), 2),
  );
  if (fixtureServer) {
    fixtureServer.closeAllConnections();
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
