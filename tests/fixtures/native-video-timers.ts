/** Synchronous VM fixtures disable wakes; the timed encoder fixture tests scheduling. */
export const nativeVideoSynchronousTimers = {
  setTimeout: () => 0,
  clearTimeout: () => {},
};
