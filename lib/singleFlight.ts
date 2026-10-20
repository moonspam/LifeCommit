/**
 * Coalescing serial queue: runs never overlap (each starts only after the previous one settled, even on rejection).
 * Calls made while a run is queued but not started share that run; a call made after a run started gets the next one,
 * so every result comes from a run that started at or after the call (a manual refresh sees events after the click).
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let queued: Promise<T> | null = null;
  return () => {
    if (queued) return queued; // not started yet: share it
    const run: Promise<T> = tail.then(() => {
      queued = null; // from here on, new calls queue the next run behind this one
      return fn();
    });
    queued = run;
    tail = run.then(() => undefined, () => undefined); // a rejection still releases the next run
    return run;
  };
}
