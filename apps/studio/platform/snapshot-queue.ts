// Shared across repository instances with the same filesystem authority.
const tails = new Map<string, Promise<void>>();

/** Reserve all paths together; callbacks must not reacquire their own paths. */
export function withSnapshotLocks<T>(scope: string, paths: string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths)].sort().map(path => JSON.stringify([scope, path]));
  const previous = keys.map(key => tails.get(key) ?? Promise.resolve());
  const result = Promise.all(previous).then(operation);
  const tail = result.then(() => {}, () => {});
  // Reserve synchronously before any callback starts, so overlapping batches cannot cycle.
  for (const key of keys) tails.set(key, tail);
  return result.finally(() => {
    for (const key of keys) if (tails.get(key) === tail) tails.delete(key);
  });
}
