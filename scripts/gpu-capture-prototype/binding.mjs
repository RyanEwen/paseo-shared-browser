/** Bootstrap native-surface identity using private changing pixels, never site titles. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const challenge = () => [...randomBytes(16)].map((b) => b.toString(2).padStart(8, "0")).join("");

/** Provision two experiment windows. This association is not a production capture capability. */
export async function provisionWindows({
  source,
  controller,
  viewer,
  helper,
  evaluate,
  until,
  attachToTarget,
  reportDirectory,
}) {
  const mappings = [];
  const bound = new Set();
  for (const output of [2, 3]) {
    const width = output === 2 ? 2560 : 1280,
      height = output === 2 ? 1600 : 800,
      scale = output === 2 ? 2 : 1;
    assert(await helper("create", { output, width, height, scale }));
    const window = await evaluate(
      controller,
      `chrome.windows.create({type:'popup',state:'fullscreen',url:chrome.runtime.getURL('provision.html')})`,
    );
    const target = await until(
      async () =>
        (await evaluate(controller, "chrome.debugger.getTargets()")).find(
          (t) => t.tabId === window.tabs[0].id,
        ),
      "exact extension tab target",
    );
    const page = await attachToTarget(source, target.id);
    await until(() => evaluate(page, "typeof setChallenge==='function'"), "provisioning script");
    const candidates = await until(async () => {
      const list = (await helper("windows")).filter((w) => !bound.has(w.nativeWindow));
      return list.length >= 2 ? list : null;
    }, "mapped candidates");
    const matches = [];
    for (const candidate of candidates) {
      const first = challenge();
      await evaluate(page, `setChallenge(${JSON.stringify(first)})`);
      assert(await helper("move", { nativeWindow: candidate.nativeWindow, output }));
      const inspect = async () =>
        evaluate(
          viewer,
          `inspectChallenge(${JSON.stringify(await helper("snapshot", { output }))})`,
        );
      let seen = false;
      try {
        await until(async () => (await inspect()).bits === first, "first pixel challenge", 1000);
        seen = true;
      } catch (error) {
        if (error.message !== "Timed out: first pixel challenge") throw error;
        const observed = await inspect();
        await writeFile(
          join(reportDirectory, `candidate-${output}-${candidate.nativeWindow}.json`),
          JSON.stringify(
            {
              native: candidate,
              observed,
              expected: first,
              source: await evaluate(
                page,
                '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,canvas:[document.querySelector("canvas").width,document.querySelector("canvas").height]})',
              ),
              windows: await helper("windows"),
              error: String(error),
            },
            null,
            2,
          ),
        );
      }
      if (seen) {
        const second = challenge();
        await evaluate(page, `setChallenge(${JSON.stringify(second)})`);
        await until(async () => (await inspect()).bits === second, "changed pixel challenge", 2000);
        matches.push(candidate.nativeWindow);
      }
      assert(await helper("move", { nativeWindow: candidate.nativeWindow, output: 0 }));
    }
    assert.equal(matches.length, 1, "Provisioning must have exactly one matching surface");
    const nativeWindow = matches[0];
    bound.add(nativeWindow);
    assert(await helper("move", { nativeWindow, output }));
    const browserWindow = await source.send("Browser.getWindowForTarget", { targetId: target.id });
    mappings.push({
      output,
      width,
      height,
      scale,
      targetId: target.id,
      chromeWindow: window.id,
      cdpWindow: browserWindow.windowId,
      nativeWindow,
      changedChallenge: true,
      candidates: candidates.length,
    });
    // Keep the source attached for independent post-provisioning fixture checks.
    mappings.at(-1).page = page;
  }
  return mappings;
}
