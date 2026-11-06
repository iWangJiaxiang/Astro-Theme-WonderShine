import type { Repository, RepositoryWrite } from '../shared/repository.js';
import type { WorkspaceControl } from '../shared/workspace.js';

export type RepositoryMutationOperation = 'write' | 'writeBatch' | 'sync';
interface RepositoryMutation {
  /** Unique to this invocation, including overlapping operations on the same wrapper. */
  readonly id: symbol;
  readonly operation: RepositoryMutationOperation;
}
export type RepositoryMutationEvent =
  | (RepositoryMutation & { readonly type: 'begin' })
  | (RepositoryMutation & {
    readonly type: 'committed';
    readonly operation: 'write' | 'writeBatch';
    readonly beginRecorded: boolean;
    /** Final submitted text, including deletions; available only during notification. */
    readonly changes: readonly Readonly<RepositoryWrite>[];
  })
  | (RepositoryMutation & { readonly type: 'uncertain'; readonly beginRecorded: boolean });
export type RepositoryMutationListener = (event: RepositoryMutationEvent) => void | Promise<void>;

/**
 * Observe content writes without replacing repository validation, receivers or locks.
 * Begin is awaited before invoking storage so a listener can persist a dirty marker.
 * Terminal notifications are awaited too, but no listener failure can change the
 * storage result. Listeners must invalidate synchronously before fallible cache I/O,
 * and keep their cache disabled if recording/reconciling an event fails. A false
 * beginRecorded forbids treating a committed delta as proof of a clean cache.
 *
 * Begin/terminal bracket the call, not the underlying lock. Listeners must account
 * for overlapping IDs and must not reenter mutations from a notification. Sync has
 * unknown deltas even on success, so always ends uncertain. A write rejection also
 * ends uncertain: validation, rollback and partial persistence are not distinguished.
 * No history, content cache, global scope registry or durable state is retained here.
 */
export function observeRepository(repository: Repository, listener: RepositoryMutationListener): Repository {
  async function notify(event: RepositoryMutationEvent): Promise<boolean> {
    try { await listener(Object.freeze(event)); return true; }
    catch { return false; }
  }

  async function mutate<T>(operation: RepositoryMutationOperation, changes: RepositoryWrite[] | undefined, apply: () => Promise<T>): Promise<T> {
    const mutation = { id: Symbol(operation), operation };
    const beginRecorded = await notify({ ...mutation, type: 'begin' });
    let result: T;
    try { result = await apply(); }
    catch (error) {
      await notify({ ...mutation, type: 'uncertain', beginRecorded });
      throw error;
    }
    if (operation === 'sync') await notify({ ...mutation, type: 'uncertain', beginRecorded });
    else await notify({ ...mutation, operation, type: 'committed', beginRecorded,
      changes: Object.freeze(changes!.map(entry => Object.freeze({ ...entry }))) });
    return result;
  }

  const write: Repository['write'] = (path, text, expectedRevision, guard) => {
    const changes = [{ path, text, expectedRevision }];
    // Use the original receiver: internal write -> writeBatch delegation is one event.
    return mutate('write', changes, () => repository.write(path, text, expectedRevision, guard));
  };
  const writeBatch: Repository['writeBatch'] = (entries, guard) => {
    // Snapshot before the first await; callers may reuse their objects while queued.
    const changes = entries.map(({ path, text, expectedRevision }) => ({ path, text, expectedRevision }));
    return mutate('writeBatch', changes, () => repository.writeBatch(changes, guard));
  };

  const workspaces = new WeakMap<WorkspaceControl, WorkspaceControl>();
  function workspace(control: WorkspaceControl): WorkspaceControl {
    let observed = workspaces.get(control);
    if (!observed) {
      const sync: WorkspaceControl['sync'] = confirmation => mutate('sync', undefined, () => control.sync(confirmation));
      observed = new Proxy(control, { get(target, property) {
        if (property === 'sync') return sync;
        // Commit and saveBranch do not change worktree content.
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      workspaces.set(control, observed);
    }
    return observed;
  }

  return new Proxy(repository, { get(target, property) {
    if (property === 'write') return write;
    if (property === 'writeBatch') return writeBatch;
    const value = Reflect.get(target, property, target);
    if (property === 'workspace') return value ? workspace(value) : value;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
