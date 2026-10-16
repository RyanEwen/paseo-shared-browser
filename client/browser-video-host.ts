/** Optional video contract exposed by Ryan's Paseo host, outside the published SDK. */
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { BrowserVideoCodec, DecodedBrowserVideoFrame } from "./browser-video-decoder";

export interface EncodedVideoFrame extends Omit<DecodedBrowserVideoFrame, "close"> {
  id: number;
}

/** The host owns retained frames; presentation resolves only after its canvas paints. */
export interface EncodedVideoHandle {
  configure(
    config: Omit<Parameters<BrowserVideoCodec["configure"]>[0], "description"> & {
      descriptionBase64?: string;
    },
  ): void;
  decode(chunk: { type: "key" | "delta"; timestamp: number; dataBase64: string }): void;
  reset(): void;
  present(frameId: number): Promise<void>;
  release(frameId: number): void;
}

interface EncodedVideoProps {
  style?: StyleProp<ViewStyle>;
  onReady(): void;
  onFrame(frame: EncodedVideoFrame): void;
  onDequeue(): void;
  onError(error: Error): void;
}

type EncodedVideoComponent = ForwardRefExoticComponent<
  EncodedVideoProps & RefAttributes<EncodedVideoHandle>
>;

/** Inspect the runtime namespace without declaring unsupported exports in the stock SDK.
 * Stock hosts return undefined and retain JPEG. Fork hosts expose the same optional
 * component as packages/plugin/src/client/react-native.ts in Ryan's Paseo fork.
 */
export function getEncodedVideoComponent(host: object): EncodedVideoComponent | undefined {
  return (host as { EncodedVideo?: EncodedVideoComponent }).EncodedVideo;
}
