/** One queue per workspace serializes content saves with Git operations. */
const queues = new Map<string, Promise<unknown>>();
// Handoff is valid only for consecutive acquisitions by the same session.
let lastOwner: object | undefined;
export function withWorkspaceLock<T>(key: string, action: (uninterrupted: boolean) => Promise<T>, owner?: object): Promise<T> {
  const next = (queues.get(key) || Promise.resolve()).catch(() => undefined).then(() => {
    const uninterrupted = owner !== undefined && owner === lastOwner;
    lastOwner = owner;
    return action(uninterrupted);
  });
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}
