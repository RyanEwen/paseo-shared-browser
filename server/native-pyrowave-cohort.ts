/** One private GPU encoder and raw channel scoped to an existing exact-tab capture. */
import type { PyrowaveConfiguration } from "../shared/pyrowave-settings";
import type { PyrowaveFrameHeader } from "../shared/pyrowave-wire";
import type { BrowserVideoColorSpace } from "../shared/video-color-space";
import { createPrivateMediaCredential } from "./private-media-credential";
import { createPyrowaveCaptureChannel } from "./pyrowave-capture-channel";

export interface NativePyrowaveAssets {
  binaryPath: string;
  cacheDirectory: string;
  credentialDirectory: string;
}

/** Persist the channel credential before opening a loopback listener. Cancellation
 * revokes callbacks synchronously, including allocation still awaiting filesystem/GPU work. */
export async function createNativePyrowaveCohort(
  options: NativePyrowaveAssets &
    PyrowaveConfiguration & {
      streamId: string;
      signal: AbortSignal;
      isCurrent(): boolean;
      onFrame(header: PyrowaveFrameHeader, bytes: Buffer, colorSpace: BrowserVideoColorSpace): void;
      onFailure(): void;
    },
) {
  const credential = await createPrivateMediaCredential(
    options.credentialDirectory,
    options.streamId,
  );
  try {
    const channel = await createPyrowaveCaptureChannel({
      ...options,
      credential: credential.credential,
    });
    let closing: Promise<void> | null = null;
    return {
      /** Evaluated only in the owning trusted extension CDP session. Never log this expression. */
      acquisitionExpression(key: string): string {
        return `addRawEncoder(${JSON.stringify(key)},${JSON.stringify(options.streamId)},${options.bitrate},${options.fps},${JSON.stringify(channel.url)},${JSON.stringify(credential.credential)})`;
      },
      close(): Promise<void> {
        // close() immediately fences channel callbacks before waiting for storage audit.
        closing ??= channel.close().finally(() => credential.revoke());
        return closing;
      },
    };
  } catch {
    await credential.revoke();
    throw new Error("Native PyroWave capture is unavailable");
  }
}
