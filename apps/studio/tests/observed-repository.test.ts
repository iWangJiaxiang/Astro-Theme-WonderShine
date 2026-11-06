import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRepository, type RepositoryMutationEvent } from '../core/observed-repository.js';
import { saveBatch } from '../core/save.js';
import type { Repository, RepositoryWrite, WriteGuard } from '../shared/repository.js';
import type { FileSnapshot, SaveResult } from '../shared/types.js';
import type { WorkspaceControl, WorkspaceStatus } from '../shared/workspace.js';
import { withWorkspaceLock } from '../platform/queue.js';

const path = 'content/articles/example/index.md';
const entry = (text: string | null = 'final text'): RepositoryWrite => ({ path, text, expectedRevision: null });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class MemoryRepository implements Repository {
  readonly mode = 'local';
  #files = new Map<string, FileSnapshot>();
  #scope = `observed-test-${crypto.randomUUID()}`;
  get saveScope() { return this.#scope; }
  workspace?: WorkspaceControl;
  locked = false;
  writes = 0;
  batches = 0;
  failure?: Error;
  partial = false;
  readonly result: SaveResult = { revision: 'saved', message: 'saved locally' };
  async read(path: string) { return this.#files.get(path) ?? null; }
  async list() { return [...this.#files.values()]; }
  async listForSummary() { return this.list(); }
  async listMedia() { return { items: [], truncated: false, maxFileSize: 1024 }; }
  async readMedia() { return null; }
  async uploadMedia(): Promise<never> { throw new Error('unused'); }
  write(path: string, text: string | null, expectedRevision: string | null, guard?: WriteGuard) {
    this.writes++;
    return this.writeBatch([{ path, text, expectedRevision }], guard);
  }
  writeBatch(entries: RepositoryWrite[], guard?: WriteGuard): Promise<SaveResult> {
    return withWorkspaceLock(this.#scope, async () => {
      this.batches++; this.locked = true;
      try {
        if (!entries.length || new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('invalid batch');
        for (const entry of entries) {
          if ((this.#files.get(entry.path)?.revision ?? null) !== entry.expectedRevision) throw new Error('stale revision');
        }
        await guard?.(this);
        if (this.failure && !this.partial) throw this.failure;
        for (const entry of entries) {
          if (entry.text === null) this.#files.delete(entry.path);
          else this.#files.set(entry.path, { path: entry.path, text: entry.text, revision: this.result.revision });
          if (this.failure) throw this.failure;
        }
        return this.result;
      } finally { this.locked = false; }
    });
  }
}

class MemoryWorkspace implements WorkspaceControl {
  #status: WorkspaceStatus = { branch: 'main', dirty: false, changes: 0, ahead: 0, behind: 0,
    diverged: false, head: null, remoteHead: null, lastSync: null };
  confirmation?: string;
  branchFailure?: Error;
  syncFailure?: Error;
  syncChanged = false;
  async status() { return this.#status; }
  async createReview() { return { ...this.#status, confirmation: 'review-token', confirmationExpiresAt: 12345 }; }
  async commit(_message: string, confirmation?: string) { this.confirmation = confirmation; return this.#status; }
  async sync(confirmation?: string) {
    this.confirmation = confirmation;
    this.syncChanged = true;
    if (this.syncFailure) throw this.syncFailure;
    return this.#status;
  }
  async saveBranch() {
    // Exercise the original receiver even though branch creation does not change files.
    assert.equal(this.#status.branch, 'main');
    if (this.branchFailure) throw this.branchFailure;
    return { branch: 'studio/save-example', commit: 'branch-commit' };
  }
}

function record() {
  const events: RepositoryMutationEvent[] = [];
  return { events, listener: (event: RepositoryMutationEvent) => { events.push(event); } };
}
function committed(events: RepositoryMutationEvent[]) {
  const event = events.at(-1)!;
  assert.equal(event.type, 'committed');
  if (event.type !== 'committed') throw new Error('expected committed');
  return event;
}

test('write delegates the original write with its receiver, preserves results and emits only one pair', async () => {
  const original = new MemoryRepository(), { events, listener } = record();
  const repository = observeRepository(original, listener);
  const detachedWrite = repository.write;
  const result = await detachedWrite(path, 'final text', null);
  assert.equal(result, original.result);
  assert.equal(original.writes, 1);
  assert.equal(original.batches, 1);
  assert.deepEqual(events.map(event => event.type), ['begin', 'committed']);
  assert.equal(events[0].id, events[1].id);
  assert.equal(committed(events).operation, 'write');
  assert.equal(committed(events).beginRecorded, true);
  assert.deepEqual(committed(events).changes, [entry()]);
  assert.equal(repository.saveScope, original.saveScope);
  assert.equal((await repository.read(path))?.text, 'final text');
  assert.deepEqual(await repository.listForSummary!(), await original.list());
});

test('batch snapshots caller entries before awaiting begin and reports all final text and deletions', async () => {
  const original = new MemoryRepository();
  const began = deferred(), release = deferred(), { events, listener } = record();
  const repository = observeRepository(original, async event => {
    listener(event);
    if (event.type === 'begin') { began.resolve(); await release.promise; }
  });
  const entries = [entry(), { path: 'content/articles/deleted.md', text: null, expectedRevision: null }];
  const expected = entries.map(entry => ({ ...entry }));
  const saving = repository.writeBatch(entries);
  await began.promise;
  assert.equal(original.batches, 0);
  entries[0].text = 'caller changed text';
  entries[1].path = 'content/articles/wrong.md';
  entries.push(entry('extra'));
  release.resolve();
  assert.equal(await saving, original.result);
  assert.equal(original.writes, 0);
  assert.equal(original.batches, 1);
  assert.equal(committed(events).operation, 'writeBatch');
  assert.deepEqual(committed(events).changes, expected);
  assert.equal((await original.read(path))?.text, 'final text');
  assert.equal(Object.isFrozen(committed(events).changes), true);
  assert.equal(Object.isFrozen(committed(events).changes[0]), true);
});

test('guards run under the original lock with the exact repository passed by storage', async () => {
  const original = new MemoryRepository(), { events, listener } = record();
  const repository = observeRepository(original, listener);
  const entered = deferred(), release = deferred();
  let guards = 0;
  const first = repository.writeBatch([entry()], async current => {
    assert.equal(current, original);
    assert.equal(original.locked, true);
    assert.equal(await current.read(path), null);
    guards++; entered.resolve(); await release.promise;
  });
  await entered.promise;
  const second = repository.write(path, 'stale', null, async () => { guards++; });
  release.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(guards, 1);
  assert.equal(original.locked, false);
  assert.equal(events.filter(event => event.type === 'committed').length, 1);
  assert.equal(events.filter(event => event.type === 'uncertain').length, 1);
  assert.equal(new Set(events.map(event => event.id)).size, 2);
});

test('delegating repositories keep the authoritative checkout passed to guards', async () => {
  const checkout = new MemoryRepository(), { events, listener } = record();
  const outer = new Proxy(checkout, { get(target, property) {
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const repository = observeRepository(outer, listener);
  await repository.writeBatch([entry()], async current => {
    assert.equal(current, checkout);
    assert.notEqual(current, outer);
    assert.notEqual(current, repository);
    assert.equal(checkout.locked, true);
  });
  assert.deepEqual(events.map(event => event.type), ['begin', 'committed']);
});

test('guard, validation and partial persistence failures end uncertain without claiming changes', async () => {
  for (const mode of ['guard', 'validation', 'storage', 'partial'] as const) {
    const original = new MemoryRepository(), { events, listener } = record();
    const failure = new Error(mode);
    if (mode === 'storage' || mode === 'partial') original.failure = failure;
    original.partial = mode === 'partial';
    const repository = observeRepository(original, listener);
    const saving = repository.writeBatch(mode === 'validation' ? [] : [entry()], mode === 'guard' ? async () => { throw failure; } : undefined);
    if (mode === 'validation') await assert.rejects(saving, /invalid batch/);
    else await assert.rejects(saving, error => error === failure);
    assert.deepEqual(events.map(event => event.type), ['begin', 'uncertain']);
    assert.equal(events[0].id, events[1].id);
    assert.equal('changes' in events[1], false);
    assert.equal((await original.read(path))?.text ?? null, mode === 'partial' ? 'final text' : null);
  }
});

test('sync always invalidates at both boundaries, preserving workspace receivers and confirmation', async () => {
  const original = new MemoryRepository(), control = new MemoryWorkspace(), { events, listener } = record();
  original.workspace = control;
  const repository = observeRepository(original, listener);
  assert.equal(repository.workspace, repository.workspace);
  assert.notEqual(repository.workspace, control);
  assert.equal(await repository.workspace!.status(), await control.status());
  assert.equal((await repository.workspace!.status()).confirmation, undefined);
  const detachedReview = repository.workspace!.createReview;
  assert.deepEqual(await detachedReview(), await control.createReview(), 'review delegates with the original private-field receiver');
  assert.equal((await repository.workspace!.status()).confirmation, undefined, 'review must not mutate the ordinary status');
  assert.equal(await repository.workspace!.commit('message', 'commit-token'), await control.status());
  await repository.workspace!.saveBranch!('key', []);
  assert.deepEqual(events, []);
  assert.equal(await repository.workspace!.sync('sync-token'), await control.status());
  assert.equal(control.confirmation, 'sync-token');
  assert.deepEqual(events.map(event => [event.operation, event.type]), [['sync', 'begin'], ['sync', 'uncertain']]);
  events.length = 0;
  const failure = control.syncFailure = new Error('checkout partially failed');
  await assert.rejects(repository.workspace!.sync('retry-token'), error => error === failure);
  assert.equal(control.syncChanged, true);
  assert.deepEqual(events.map(event => event.type), ['begin', 'uncertain']);
});

test('sync waits for the dirty marker and listener failure does not mask a successful sync', async () => {
  const original = new MemoryRepository(), control = new MemoryWorkspace();
  original.workspace = control;
  const began = deferred(), release = deferred(), { events, listener } = record();
  const repository = observeRepository(original, async event => {
    listener(event);
    if (event.type === 'begin') { began.resolve(); await release.promise; }
    throw new Error('index unavailable');
  });
  const syncing = repository.workspace!.sync('confirmation');
  await began.promise;
  assert.equal(control.syncChanged, false);
  release.resolve();
  assert.equal(await syncing, await control.status());
  assert.deepEqual(events.map(event => event.type), ['begin', 'uncertain']);
  const terminal = events[1];
  assert.equal(terminal.type === 'uncertain' && terminal.beginRecorded, false);
});

test('branch save failure leaves the successful worktree write committed to observers', async () => {
  const original = new MemoryRepository(), control = new MemoryWorkspace(), { events, listener } = record();
  original.workspace = control;
  control.branchFailure = new Error('branch commit failed');
  const repository = observeRepository(original, listener);
  const result = await saveBatch(repository, [entry()], undefined, 'branch');
  assert.equal(result.branchPending, true);
  assert.equal(result.revision, original.result.revision);
  assert.equal((await original.read(path))?.text, 'final text');
  assert.deepEqual(events.map(event => event.type), ['begin', 'committed']);
  assert.deepEqual(committed(events).changes, [entry()]);
});

test('synchronous and asynchronous listener failures cannot replace persistence results or errors', async () => {
  for (const asynchronous of [false, true]) {
    const original = new MemoryRepository(), { events, listener } = record();
    const repository = observeRepository(original, event => {
      listener(event);
      if (asynchronous) return Promise.reject(new Error('cache unavailable'));
      throw new Error('cache unavailable');
    });
    assert.equal(await repository.write(path, 'final text', null), original.result);
    assert.equal(committed(events).beginRecorded, false);
    assert.equal((await original.read(path))?.text, 'final text');
    events.length = 0;
    const failure = original.failure = new Error('storage unavailable');
    await assert.rejects(repository.write(path, 'new text', 'saved'), error => error === failure);
    assert.deepEqual(events.map(event => event.type), ['begin', 'uncertain']);
  }
});

test('terminal listeners finish before returning but cannot mutate committed changes', async () => {
  const original = new MemoryRepository(), entered = deferred(), release = deferred();
  let returned = false;
  const repository = observeRepository(original, async event => {
    if (event.type !== 'committed') return;
    entered.resolve(); await release.promise;
    // A cache bug throws in strict mode; persistence must still succeed.
    (event.changes[0] as RepositoryWrite).text = 'cache corruption';
  });
  const saving = repository.write(path, 'final text', null).then(result => { returned = true; return result; });
  await entered.promise;
  assert.equal(returned, false);
  assert.equal((await original.read(path))?.text, 'final text');
  release.resolve();
  assert.equal(await saving, original.result);
  assert.equal((await original.read(path))?.text, 'final text');
});

test('observation composes with AI guard proxies in either order without losing cancellation', async () => {
  for (const observerOutside of [false, true]) {
    const original = new MemoryRepository(), { events, listener } = record();
    const cancelled = new Error('AI cancelled');
    const aiProxy = (repository: Repository) => new Proxy(repository, { get(target, property) {
      if (property === 'writeBatch') return ((entries, guard) => target.writeBatch(entries, async current => {
        assert.equal(current, original);
        assert.equal(original.locked, true);
        await guard?.(current);
        throw cancelled;
      })) satisfies Repository['writeBatch'];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const repository = observerOutside ? observeRepository(aiProxy(original), listener) : aiProxy(observeRepository(original, listener));
    let guards = 0;
    await assert.rejects(repository.writeBatch([entry()], async current => {
      assert.equal(current, original); guards++;
    }), error => error === cancelled);
    assert.equal(guards, 1);
    assert.equal(await original.read(path), null);
    assert.deepEqual(events.map(event => event.type), ['begin', 'uncertain']);
  }
});

test('wrappers isolate listeners and scopes without clobbering underlying methods or workspace', async () => {
  const a = new MemoryRepository(), b = new MemoryRepository();
  a.workspace = new MemoryWorkspace();
  const before = Object.getOwnPropertyDescriptors(a), control = a.workspace, method = a.writeBatch;
  const first = record(), second = record(), third = record();
  const observedA = observeRepository(a, first.listener), observedB = observeRepository(b, second.listener);
  const alternateA = observeRepository(a, third.listener);
  assert.notEqual(observedA.saveScope, observedB.saveScope);
  await observedA.writeBatch([entry('a')]);
  assert.equal(second.events.length, 0);
  assert.equal(third.events.length, 0);
  await observedB.writeBatch([entry('b')]);
  await alternateA.write(path, 'a2', 'saved');
  assert.deepEqual(committed(first.events).changes, [entry('a')]);
  assert.deepEqual(committed(second.events).changes, [entry('b')]);
  assert.equal(first.events.length, 2);
  assert.equal(third.events.length, 2);
  assert.equal(a.workspace, control);
  assert.equal(a.writeBatch, method);
  // Only the fixture's persistence counters change; no wrapper metadata is installed.
  const after = Object.getOwnPropertyDescriptors(a);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const key of Object.keys(before).filter(key => key !== 'writes' && key !== 'batches')) assert.deepEqual(after[key], before[key]);
  assert.equal(observedB.workspace, undefined);
});
