/** One queue per workspace serializes content saves with Git operations. */
const queues = new Map<string, Promise<unknown>>();
export function withWorkspaceLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) || Promise.resolve()).catch(() => undefined).then(action);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}
