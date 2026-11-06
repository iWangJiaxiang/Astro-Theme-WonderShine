import test from 'node:test';
import assert from 'node:assert/strict';
import { openNativeWorkspaceReviews } from '../platform/review-store.js';

const id = '00000000-0000-4000-8000-000000000001';
const folder = '/app/workspaces/' + id;
const state = folder + '/state';
const directory = state + '/reviews-v1';
const restart = '创作窗口已重新加载，请完全退出并重启应用后重新确认工作区';

// Exercise the real invoke/plugin boundary; Rust OS-lock tests are separate.
async function fixture(run: (value: {
  entries: Map<string, 'directory' | 'file' | 'symlink'>;
  removed: string[]; calls: string[];
  control: { denied: string | null; loseClaimResponse: boolean; beforeFs?: () => Promise<void> };
}) => Promise<void>) {
  const entries = new Map<string, 'directory' | 'file' | 'symlink'>([
    ['/app', 'directory'], ['/app/workspaces', 'directory'], [folder, 'directory'],
    [state, 'directory'], [directory, 'directory'],
  ]);
  const removed: string[] = [], calls: string[] = [];
  const control: { denied: string | null; loseClaimResponse: boolean; beforeFs?: () => Promise<void> } = {
    denied: null, loseClaimResponse: false,
  };
  let owned = false, claimed = false, epoch: string | undefined;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: { path: string; workspaceId: string; epoch: string; claimRecovery: boolean }) => {
      if (command === 'native_review_owner') {
        calls.push(command + ':' + args.claimRecovery);
        assert.equal(args.workspaceId, id);
        assert.match(args.epoch, /^[0-9a-f-]{36}$/);
        assert.equal('path' in args, false, 'Rust never accepts a JS path');
        if (control.denied) throw control.denied;
        epoch ??= args.epoch;
        assert.equal(args.epoch, epoch);
        owned = true;
        if (args.claimRecovery) {
          const first = !claimed;
          claimed = true;
          if (control.loseClaimResponse) throw new Error('IPC response lost');
          return first;
        }
        assert.equal(claimed, true);
        return false;
      }
      assert.equal(owned, true, 'no filesystem operation before OS ownership');
      await control.beforeFs?.();
      const path = args.path;
      calls.push(command + ':' + path);
      assert.ok(path === '/app' || path.startsWith('/app/'), 'never authorize filesystem root');
      const type = entries.get(path);
      if (command === 'plugin:fs|mkdir') {
        if (type) throw new Error('already exists');
        entries.set(path, 'directory'); return;
      }
      if (!type) throw new Error('no such file');
      if (command === 'plugin:fs|lstat') return {
        isDirectory: type === 'directory', isFile: type === 'file', isSymlink: type === 'symlink',
        size: 0, mtime: null, atime: null, birthtime: null, mode: type === 'directory' ? 0o700 : 0o600, nlink: 1,
      };
      if (command === 'plugin:fs|read_dir') return [...entries].filter(([name]) => name.startsWith(path + '/') && !name.slice(path.length + 1).includes('/'))
        .map(([name, value]) => ({ name: name.slice(path.length + 1), isDirectory: value === 'directory', isFile: value === 'file', isSymlink: value === 'symlink' }));
      if (command === 'plugin:fs|remove') {
        removed.push(path); entries.delete(path); return;
      }
      throw new Error('Unexpected command');
    },
  } } });
  try { await run({ entries, removed, calls, control }); }
  finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('native review checks AppData ancestors before store access', async () => fixture(async ({ entries, calls }) => {
  entries.set(folder, 'symlink');
  await assert.rejects(openNativeWorkspaceReviews(state, '/app'));
  assert.ok(calls.includes('plugin:fs|lstat:' + folder));
  assert.equal(calls.some(call => call.startsWith('plugin:fs|mkdir:')), false);
}));

test('connect recovery removes only an empty derived lock under OS owner', async () => fixture(async ({ entries, removed, calls }) => {
  entries.set(directory + '/lock', 'directory');
  entries.set(state + '/sync.json', 'file');
  entries.set(state + '/history-private.json', 'file');
  const store = await openNativeWorkspaceReviews(state, '/app');
  assert.equal(entries.has(directory + '/lock'), false);
  assert.equal(entries.has(state + '/sync.json'), true);
  assert.equal(entries.has(state + '/history-private.json'), true);
  assert.ok(removed.every(path => path === directory + '/lock'));
  await store.cleanup();
  assert.equal(calls.filter(call => call === 'native_review_owner:false').length, 1);
}));

test('second process or unsupported locking denies initialization before FS access', async () => fixture(async ({ entries, removed, calls, control }) => {
  entries.set(directory + '/lock', 'directory');
  control.denied = 'OS lock unavailable';
  await assert.rejects(openNativeWorkspaceReviews(state, '/app'));
  assert.equal(entries.has(directory + '/lock'), true);
  assert.deepEqual(removed, []);
  assert.deepEqual(calls, ['native_review_owner:true']);
}));

test('every normal operation rechecks Rust ownership and preserves reload restart message', async () => fixture(async ({ calls, control }) => {
  const store = await openNativeWorkspaceReviews(state, '/app');
  calls.length = 0;
  control.denied = restart;
  await assert.rejects(store.cleanup(), { message: restart });
  await assert.rejects(store.createReview({ scope: 'test', branch: 'main', head: null, rows: [] }, async () => null), { message: restart });
  await assert.rejects(store.validateReview(id, { scope: 'test', branch: 'main', head: null, rows: [] }, async () => null), { message: restart });
  assert.deepEqual(calls, Array(3).fill('native_review_owner:false'));
}));

test('same-process reconnect cannot recover a lock twice', async () => fixture(async ({ entries, removed }) => {
  await openNativeWorkspaceReviews(state, '/app');
  entries.set(directory + '/lock', 'directory');
  removed.length = 0;
  await assert.rejects(openNativeWorkspaceReviews(state, '/app'), { message: restart });
  assert.equal(entries.has(directory + '/lock'), true);
  assert.deepEqual(removed, []);
}));

test('lost claim response cannot grant recovery on retry', async () => fixture(async ({ entries, removed, control }) => {
  entries.set(directory + '/lock', 'directory');
  control.loseClaimResponse = true;
  await assert.rejects(openNativeWorkspaceReviews(state, '/app'));
  control.loseClaimResponse = false;
  await assert.rejects(openNativeWorkspaceReviews(state, '/app'), { message: restart });
  assert.deepEqual(removed, []);
}));

test('recovery validates all entries before deleting a lock', async () => fixture(async ({ entries, removed }) => {
  entries.set(directory + '/lock', 'directory');
  entries.set(directory + '/unknown', 'file');
  await assert.rejects(openNativeWorkspaceReviews(state, '/app'));
  assert.deepEqual(removed, []);
  entries.delete(directory + '/unknown');
  entries.set(directory + '/lock/unknown', 'file');
  await assert.rejects(openNativeWorkspaceReviews(state, '/app'));
  assert.deepEqual(removed, []);
}));

test('review queue serializes reconnect behind a live operation without stealing its lock', async () => fixture(async ({ control, calls }) => {
  const store = await openNativeWorkspaceReviews(state, '/app');
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  control.beforeFs = async () => { control.beforeFs = undefined; entered(); await blocked; };
  const operation = store.cleanup();
  await started;
  calls.length = 0;
  const reconnect = openNativeWorkspaceReviews(state, '/app');
  await Promise.resolve();
  assert.deepEqual(calls, [], 'reconnect must wait before claiming or accessing storage');
  release();
  await Promise.all([operation, reconnect]);
}));

test('invalid workspace paths cannot invoke ownership or touch files', async () => fixture(async ({ calls }) => {
  await assert.rejects(openNativeWorkspaceReviews('/app/workspaces/not-a-uuid/state', '/app'));
  await assert.rejects(openNativeWorkspaceReviews(state, '/other'));
  assert.deepEqual(calls, []);
}));
