/** Matched visual-only streams through the actual decoder, with bounded producer queues. */
import assert from "node:assert/strict";

/** Read the SPS profile bytes so the diagnostic names the actual encoded AVC codec. */
function avcCodec(base64) {
  const data = Buffer.from(base64, "base64");
  for (let i = 0; i < data.length - 6; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 31) === 7) {
      return `avc1.${data.subarray(i + 4, i + 7).toString("hex")}`;
    }
  }
  return null;
}

/** Run sequential standard/direct phases on the same independently mapped source pages.
 * This intentionally has no production receipt registration or input-admission integration.
 */
export async function measureStreams({
  source,
  viewer,
  helper,
  mappings,
  evaluate,
  until,
  attachToTarget,
  extensionId,
  sourceOrigin,
  videoSourceTime,
  phases = ["standard", "direct"],
  record = async () => {},
}) {
  const results = [];
  for (const mapping of mappings) {
    await mapping.page.send("Page.navigate", {
      url: `${sourceOrigin}/${mapping.output === 3 ? "?second=1" : ""}`,
    });
    await until(() => evaluate(mapping.page, "window.serial>3"), "owned animated source");
    const geometry = await evaluate(
      mapping.page,
      "({width:innerWidth,height:innerHeight,scale:devicePixelRatio})",
    );
    assert.deepEqual(geometry, {
      width: mapping.width / mapping.scale,
      height: mapping.height / mapping.scale,
      scale: mapping.scale,
    });
  }
  await evaluate(mappings[0].page, "localStorage.setItem('gpu-capture-prototype','same-profile')");
  assert.equal(
    await evaluate(mappings[1].page, "localStorage.getItem('gpu-capture-prototype')"),
    "same-profile",
  );

  for (const phase of phases) {
    const phaseResult = { phase, streams: [], transitions: [], inputAuthorityIssued: false };
    const states = [];
    try {
      for (const mapping of mappings) {
        await evaluate(viewer, `openView(${mapping.output},${mapping.width},${mapping.height})`);
        const state = {
          ...mapping,
          sequence: 0,
          codec: null,
          packets: [],
          received: 0,
          rejectedAge: 0,
          streamId: `${phase}-${mapping.output}`,
          errors: [],
          target: null,
          page: null,
        };
        states.push(state);
        if (phase === "standard") {
          const target = await source.send("Target.createTarget", {
            url: `chrome-extension://${extensionId}/recorder.html`,
            hidden: true,
            background: true,
          });
          state.target = target.targetId;
          state.page = await attachToTarget(source, target.targetId);
          await until(
            () => evaluate(state.page, "typeof startCapture==='function'"),
            "standard helper",
          );
          await state.page.send("Runtime.enable");
          await state.page.send("Runtime.addBinding", { name: "nativeVideoPacket" });
          state.page.on("Runtime.bindingCalled", ({ payload }) => {
            const packet = JSON.parse(payload);
            if (packet.error) {
              state.errors.push(packet.error);
              return;
            }
            assert(
              state.packets.length < 2,
              "Standard producer exceeded its two outstanding packets",
            );
            state.packets.push(packet);
          });
          await state.page.send("Performance.enable");
          const before = performance.now();
          const metrics = await state.page.send("Performance.getMetrics");
          const after = performance.now();
          assert(after - before < 100, "Clock calibration too slow");
          state.clock = {
            sourceMs: metrics.metrics.find((m) => m.name === "Timestamp").value * 1000,
            monotonicMs: (before + after) / 2,
          };
          await evaluate(
            state.page,
            `startCapture(${JSON.stringify(mapping.targetId)},${mapping.width},${mapping.height},1,false)`,
          );
          await evaluate(
            state.page,
            `addEncoder('high',${JSON.stringify(state.streamId)},24000000,60)`,
          );
        } else {
          const before = performance.now();
          const clock = await helper("clock");
          const after = performance.now();
          assert(after - before < 100, "Clock calibration too slow");
          state.clock = { sourceMs: clock.monotonicNs / 1e6, monotonicMs: (before + after) / 2 };
          state.info = await helper("start", {
            output: mapping.output,
            width: mapping.width,
            height: mapping.height,
            scale: mapping.scale,
          });
          state.info = await until(async () => {
            const status = await helper("stats", { output: mapping.output });
            return status.frames > 0 ? status.info : null;
          }, "native encoder readiness");
          await record(`startup-${mapping.output}`, state.info);
          assert.equal(state.info.hardware, true, "Direct encoding must use hardware");
          assert.equal(
            state.info.zero_copy,
            true,
            "Direct capture must report no CPU plane copies",
          );
        }
      }
      const start = performance.timeOrigin + performance.now();
      let lastHeartbeat = 0;
      let transitioned = false;
      while (performance.timeOrigin + performance.now() - start < 18000) {
        const now = performance.timeOrigin + performance.now();
        for (const state of states) {
          if (phase === "standard" && now - lastHeartbeat > 500)
            await evaluate(state.page, "touchEncoder('high')");
          const original =
            phase === "standard"
              ? state.packets.splice(0)
              : await helper("poll", { output: state.output });
          const pictures = [];
          for (const packet of original) {
            if (phase === "direct") assert.equal(packet.actionable, false);
            state.received++;
            const timestampUs =
              phase === "standard" ? packet.timestampUs : Math.floor(packet.captureNs / 1000);
            const time = videoSourceTime(timestampUs, state.clock, performance.now(), Date.now());
            if (!time) {
              state.rejectedAge++;
              continue;
            }
            const key = phase === "standard" ? packet.type === "key" : packet.key;
            state.codec =
              phase === "standard" ? packet.codec : (avcCodec(packet.dataBase64) ?? state.codec);
            assert(state.codec, "First direct picture must have an SPS");
            pictures.push({
              streamId: state.streamId,
              captureGeneration: 1,
              sequence: ++state.sequence,
              type: key ? "key" : "delta",
              timestampUs,
              codec: state.codec,
              width: state.width,
              height: state.height,
              dataBase64: packet.dataBase64,
              capturedAt: time.capturedAt,
              actionable: false,
            });
          }
          if (pictures.length)
            await evaluate(viewer, `consume(${state.output},${JSON.stringify(pictures)})`);
          if (phase === "standard" && original.length) {
            await evaluate(
              state.page,
              original
                .map(
                  (packet) => `acknowledge(${JSON.stringify(packet.streamId)},${packet.sequence})`,
                )
                .join(";"),
            );
          }
        }
        if (now - lastHeartbeat > 500) lastHeartbeat = now;
        if (!transitioned && now - start > 8000) {
          // Real browser input is confined to this owned fixture, with no production lease bypass.
          for (const mapping of mappings) {
            await mapping.page.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: 205,
              y: 38,
              button: "left",
              clickCount: 1,
            });
            await mapping.page.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: 205,
              y: 38,
              button: "left",
              clickCount: 1,
            });
            const at = await evaluate(mapping.page, "transitions.at(-1)");
            assert.equal(typeof at, "number", "Owned route button must receive its click");
            phaseResult.transitions.push({ output: mapping.output, at });
          }
          transitioned = true;
        }
        await new Promise((r) => setTimeout(r, 8));
      }
      const presentations = await evaluate(viewer, "results()");
      for (const state of states) {
        const paints = presentations.find((p) => p.output === state.output).paints;
        const samples = paints.filter((p) => p.at >= start + 3000 && p.at < start + 17000);
        assert(samples.length > 50, "Stream must actually present in the production decoder");
        const transition = phaseResult.transitions.find((t) => t.output === state.output);
        const changed = paints.find(
          (p) => p.at >= transition.at && p.color[1] > 180 && p.color[0] < 70 && p.color[2] < 70,
        );
        assert(changed, "Changed page pixels must reach the viewer");
        phaseResult.streams.push({
          output: state.output,
          width: state.width,
          height: state.height,
          codec: state.codec,
          received: state.received,
          rejectedAge: state.rejectedAge,
          presentedFps: samples.length / 14,
          firstChangedPaintMs: changed.at - transition.at,
          errors: state.errors,
          native: phase === "direct" ? await helper("stats", { output: state.output }) : null,
        });
        assert.deepEqual(state.errors, []);
      }
      if (phase === "direct") {
        const retired = mappings[1];
        const survivor = mappings[0];
        await evaluate(viewer, `closeView(${retired.output})`);
        await helper("stop", { output: retired.output });
        await assert.rejects(helper("poll", { output: retired.output }));
        const before = (await helper("stats", { output: survivor.output })).frames;
        await source.send("Target.closeTarget", { targetId: retired.targetId });
        await until(
          async () =>
            !(await helper("windows")).some((w) => w.nativeWindow === retired.nativeWindow),
          "retired native surface removed",
        );
        assert.equal(
          await helper("move", { nativeWindow: retired.nativeWindow, output: retired.output }),
          false,
        );
        await until(
          async () => (await helper("stats", { output: survivor.output })).frames > before + 3,
          "surviving source continues capture",
        );
        const geometry = await evaluate(
          survivor.page,
          "({width:innerWidth,height:innerHeight,scale:devicePixelRatio})",
        );
        assert.deepEqual(geometry, {
          width: survivor.width / survivor.scale,
          height: survivor.height / survivor.scale,
          scale: survivor.scale,
        });
        phaseResult.retirement = {
          oldNativeHandleRejected: true,
          retiredStreamRejected: true,
          survivingCaptureContinues: true,
          survivorGeometryPreserved: true,
        };
      }
      phaseResult.viewerErrors = await evaluate(viewer, "errors");
      results.push(phaseResult);
      await record(phase, phaseResult);
    } finally {
      for (const state of states) {
        if (phase === "standard" && state.page) {
          await evaluate(state.page, "stopCapture()").catch(() => {});
          await source.send("Target.closeTarget", { targetId: state.target }).catch(() => {});
        } else if (phase === "direct") {
          await helper("stop", { output: state.output }).catch(() => {});
        }
      }
      await evaluate(viewer, "finish()").catch(() => {});
    }
    // Restore fixture colour before the matched next phase; no active user site is involved.
    for (const mapping of phase === "direct" ? [] : mappings) {
      await mapping.page.send("Page.reload");
      await until(() => evaluate(mapping.page, "window.serial>3"), "fixture reload");
    }
  }
  return results;
}
