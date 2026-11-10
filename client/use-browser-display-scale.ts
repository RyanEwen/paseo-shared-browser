/** Keep capture demand aligned with this client's native scale, monitor, and local web zoom. */
import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import { observeBrowserDisplayScale, readBrowserDisplayScale } from "./browser-display-scale";
import { webDisplayScaleSource } from "./browser-page-web";

/** React Native owns native scale updates; web additionally observes DPR-only monitor transitions. */
export function useBrowserDisplayScale(): number {
  const { scale: nativeScale } = useWindowDimensions();
  const [source] = useState(webDisplayScaleSource);
  const [browserScale, setBrowserScale] = useState(() =>
    source ? readBrowserDisplayScale(nativeScale, source) : nativeScale,
  );
  useEffect(() => {
    if (!source) return;
    return observeBrowserDisplayScale(nativeScale, setBrowserScale, source);
  }, [source, nativeScale]);
  return source ? browserScale : nativeScale;
}
