/** Keep capture demand aligned with this client's native scale, monitor, and local web zoom. */
import { useEffect, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { observeBrowserDisplayScale, readBrowserDisplayScale } from "./browser-display-scale";

/** React Native owns native scale updates; web additionally observes DPR-only monitor transitions. */
export function useBrowserDisplayScale(): number {
  const { scale: nativeScale } = useWindowDimensions();
  const web = Platform.OS === "web";
  const [browserScale, setBrowserScale] = useState(() =>
    web ? readBrowserDisplayScale(nativeScale) : nativeScale,
  );
  useEffect(() => {
    if (!web) return;
    return observeBrowserDisplayScale(nativeScale, setBrowserScale);
  }, [web, nativeScale]);
  return web ? browserScale : nativeScale;
}
