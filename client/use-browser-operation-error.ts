/** One operation notice per panel, with recovery fenced to the error seen at publication. */
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Keep failed-action truth until dismissal or a later successful action.
 * A request that started before a newer failure cannot clear that failure. */
export function useBrowserOperationError(scope: string) {
  const current = useRef({ scope, revision: 0 });
  if (current.current.scope !== scope) {
    current.current = { scope, revision: current.current.revision + 1 };
  }
  const mounted = useRef(true);
  const [notice, setNotice] = useState<{ scope: string; id: number; message: string } | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const publish = useCallback((message: string | null) => {
    const owner = current.current;
    owner.revision += 1;
    setNotice(message === null ? null : { scope: owner.scope, id: owner.revision, message });
  }, []);
  const dismiss = useCallback(
    (id: number) => {
      if (current.current.revision === id) publish(null);
    },
    [publish],
  );
  const recover = useCallback(
    async <Result>(perform: () => Promise<Result>): Promise<Result> => {
      const owner = current.current;
      const revision = owner.revision;
      const result = await perform();
      if (mounted.current && current.current === owner && owner.revision === revision) {
        publish(null);
      }
      return result;
    },
    [publish],
  );

  return {
    message: notice?.scope === scope ? notice.message : null,
    id: notice?.scope === scope ? notice.id : null,
    publish,
    dismiss,
    recover,
  };
}
