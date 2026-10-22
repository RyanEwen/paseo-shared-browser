/** Client-session view size, independent of host settings and remote browser geometry. */
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { BrowserCanvasDisplayMode } from "./browser-canvas-layout";

/** Retain each host/workspace choice across panel remounts in the installation's
 * client cache. Never fetch or save host settings. Inactive choices do not expire
 * during this app session; unloading the plugin clears its owning cache. */
export function useBrowserViewSize(hostId: string, workspaceId: string) {
  const client = useQueryClient();
  const queryKey = useMemo(
    () => ["shared-browser", "view-size", hostId, workspaceId] as const,
    [hostId, workspaceId],
  );
  const { data: mode } = useQuery<BrowserCanvasDisplayMode>({
    queryKey,
    queryFn: skipToken,
    initialData: "fit",
    gcTime: Number.POSITIVE_INFINITY,
  });
  const setMode = useCallback(
    (value: BrowserCanvasDisplayMode) => {
      client.setQueryData<BrowserCanvasDisplayMode>(queryKey, value);
    },
    [client, queryKey],
  );
  return [mode ?? "fit", setMode] as const;
}
