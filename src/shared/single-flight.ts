/**
 * Single-flight: dedupe concurrent calls that share a key onto ONE in-flight promise. A second call made
 * while the first is still running joins the first's result instead of starting a new run; once it settles,
 * the next call starts fresh. Used to stop a second `verify run` (e.g. a second Run-checks click) from
 * spawning a whole parallel fleet of agents. Pure (no I/O of its own); the wrapped fn does the work.
 */
export function singleFlight<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
  keyOf: (...args: A) => string,
): (...args: A) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (...args: A) => {
    const key = keyOf(...args);
    const existing = inFlight.get(key);
    if (existing) return existing;
    // Start it, register before any await can interleave, and clear on settle so the next call runs fresh.
    const p = fn(...args).finally(() => {
      if (inFlight.get(key) === p) inFlight.delete(key);
    });
    inFlight.set(key, p);
    return p;
  };
}
