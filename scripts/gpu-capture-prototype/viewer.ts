/** Isolated visual sink. Synthetic metadata is never submitted as an input receipt. */
import { createBrowserVideoDecoder } from "../../client/browser-video-decoder";
import { type BrowserVideoCanvasNode, createBrowserVideoEnvironment } from "../../client/web";
import type { BrowserVideoPacket, BrowserVideoPicture } from "../../shared/browser-video";

/** Keep this fixture's browser types local, matching the production adapter's
 * platform-neutral contracts without introducing DOM/WebGPU globals into native code. */
interface PrototypeElement extends BrowserVideoCanvasNode {
  style: Record<string, string>;
  remove(): void;
}
interface ProbeContext {
  drawImage(image: unknown, ...geometry: number[]): void;
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
}
declare const document: {
  createElement(kind: "div"): PrototypeElement;
  body: { appendChild(element: PrototypeElement): void };
};
declare const OffscreenCanvas: {
  new (
    width: number,
    height: number,
  ): {
    getContext(kind: "2d", options: { willReadFrequently: boolean }): ProbeContext | null;
  };
};
declare function createImageBitmap(
  blob: Blob,
): Promise<{ width: number; height: number; close(): void }>;

interface Paint {
  at: number;
  timestamp: number;
  color: number[];
}
interface View {
  decoder: ReturnType<typeof createBrowserVideoDecoder>;
  surface: NonNullable<ReturnType<typeof createBrowserVideoEnvironment>>;
  div: PrototypeElement;
  paints: Paint[];
  width: number;
  height: number;
  generation: number;
}
interface PrototypeScope {
  errors: string[];
  inspectChallenge(base64: string): Promise<{ bits: string; width: number; height: number }>;
  openView(output: number, width: number, height: number): void;
  consume(output: number, packets: Omit<BrowserVideoPacket, "frame">[]): void;
  results(): { output: number; paints: Paint[] }[];
  closeView(output: number): void;
  finish(): void;
}
const scope = globalThis as unknown as PrototypeScope;
const views = new Map<number, View>();
scope.errors = [];

/** Decode a private compositor challenge outside timing samples. */
scope.inspectChallenge = async (base64: string) => {
  const image = await fetch(`data:image/png;base64,${base64}`);
  const bitmap = await createImageBitmap(await image.blob());
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    let bits = "";
    for (let bit = 0; bit < 128; bit++) {
      const x = 64 + (bit % 32) * 16 + 8;
      const y = 160 + Math.floor(bit / 32) * 16 + 8;
      const p = context.getImageData(x, y, 1, 1).data;
      bits += p[0]! > 128 ? "1" : "0";
    }
    return { bits, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
};

/** Open only a visual decoder; no input listeners or Shared Browser RPC client exist here. */
scope.openView = (output: number, width: number, height: number) => {
  const div = document.createElement("div");
  Object.assign(div.style, { width: "640px", height: "400px" });
  document.body.appendChild(div);
  const surface = createBrowserVideoEnvironment(div)!;
  const originalDraw = surface.environment.draw;
  const probe = new OffscreenCanvas(1, 1);
  const context = probe.getContext("2d", { willReadFrequently: false })!;
  const paints: Paint[] = [];
  const generation = 1;
  const decoder = createBrowserVideoDecoder({
    environment: {
      ...surface.environment,
      draw(frame) {
        const result = originalDraw(frame);
        context.drawImage(frame, 0, 0, 64, 64, 0, 0, 1, 1);
        const color = [...context.getImageData(0, 0, 1, 1).data];
        paints.push({
          at: performance.timeOrigin + performance.now(),
          timestamp: frame.timestamp,
          color,
        });
        if (paints.length > 12000) paints.shift();
        return result;
      },
    },
    // This sink has no input-admission path. Production-issued authority is absent.
    isCurrent: () => false,
    isSourceCurrent: (p) => p.captureGeneration === generation,
    onPresented() {},
    onNeedKeyFrame() {
      scope.errors.push("Visual decoder needs a keyframe");
    },
    onError(error) {
      scope.errors.push(String(error));
    },
  });
  views.set(output, { decoder, surface, div, paints, width, height, generation });
};

/** Receive test-only packets; actionable remains false even after successful mapping. */
scope.consume = (output: number, packets: Omit<BrowserVideoPacket, "frame">[]) => {
  const view = views.get(output);
  if (!view) throw new Error("Unknown prototype output");
  for (const p of packets) {
    view.decoder.receive(
      {
        ...p,
        actionable: false,
        frame: {
          frameId: "prototype-visual-only",
          sessionId: "prototype-no-session",
          navigationGeneration: 1,
          viewportGeneration: 1,
          width: view.width,
          height: view.height,
          capturedAt: p.capturedAt,
        },
      } as BrowserVideoPicture,
      1,
    );
  }
};
scope.results = () => [...views].map(([output, view]) => ({ output, paints: view.paints }));
/** Revoke this visual sink before a source is closed or replaced. */
scope.closeView = (output: number) => {
  const view = views.get(output);
  if (!view) return;
  views.delete(output);
  view.decoder.close();
  view.surface.dispose();
  view.div.remove();
};
scope.finish = () => {
  for (const output of [...views.keys()]) scope.closeView(output);
};
