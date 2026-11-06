import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { WorkspaceProfile } from '../platform/hosting.js';

type Runtime = typeof import('../platform/native-runtime.js');
const id = '00000000-0000-4000-8000-000000000001';
const base = '/app';
const folder = base + '/workspaces/' + id;
const state = folder + '/state';
const root = folder + '/repo';

// Bundle the actual orchestration source, replacing only its imported boundaries.
// No native IPC, Git, real filesystem mutations or global window mocks are needed.
const exportsByModule: Record<string, string[]> = {
  './native-ai': ['NativeAiController'],
  '@tauri-apps/api/path': ['appDataDir'],
  '@tauri-apps/api/core': ['convertFileSrc'],
  '@tauri-apps/plugin-fs': ['mkdir'],
  '@tauri-apps/plugin-http': ['fetch'],
  '../core/transport': ['createContentTransport'],
  '../core/summary-runtime': ['createSummaryRuntime'],
  './summary-store': ['createNativeSummaryStore'],
  '../core/media-validation': ['validateMediaPath'],
  '../shared/media': ['setMediaResolver'],
  '../src/api': ['setApiTransport'],
  './tauri-filesystem': ['tauriFiles'],
  './file-repository': ['FileRepository'],
  './git-engine': ['NativeGitEngine'],
  './git-http': ['createGitHttp'],
  './hosting': ['validateProfile', 'validateRemote'],
  './local-workspace': ['inspectLocalRepository'],
  './load-diagnostics': ['createLoadDiagnostics'],
  './review-store': ['nativeReviewSource', 'openNativeWorkspaceReviews'],
  './filesystem': ['ensureDirectory'],
};
let bundled: Promise<string> | undefined;
function bundle() {
  return bundled ??= build({
    entryPoints: [fileURLToPath(new URL('../platform/native-runtime.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
    plugins: [{ name: 'native-runtime-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return;
        const key = args.path.replace(/\.js$/, '');
        if (!exportsByModule[key]) throw new Error('Unmocked runtime import: ' + args.path);
        return { path: key, namespace: 'runtime-boundary' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'runtime-boundary' }, args => ({
        loader: 'js',
        contents: exportsByModule[args.path].map(name =>
          `export const ${name} = globalThis.boundaries[${JSON.stringify(args.path)}][${JSON.stringify(name)}];`).join('\n'),
      }));
    } }],
  }).then(result => result.outputFiles[0].text);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function profile(localPath?: string): WorkspaceProfile {
  return { id, label: 'Fixture', provider: 'generic', url: 'https://git.example/site.git', branch: 'main',
    username: '', authorName: 'Fixture', authorEmail: 'fixture@example.invalid',
    ...(localPath ? { source: 'local' as const, localPath } : {}),
  };
}
async function fixture(appData = base + '/', holdState = false) {
  const events: string[] = [];
  const files = {};
  const store = {};
  const source = async () => null;
  const stateCreated = deferred<void>(), stateEntered = deferred<void>();
  const owner = deferred<unknown>(), ownerEntered = deferred<void>();
  const opened = deferred<void>(), openEntered = deferred<void>();
  const recovered = deferred<void>(), recoveryEntered = deferred<void>();
  let injected: { store: unknown; source: unknown } | undefined;
  const boundaries = {
    './native-ai': { NativeAiController: class { dispose() {} } },
    '@tauri-apps/api/path': { appDataDir: async () => appData },
    '@tauri-apps/api/core': { convertFileSrc: (path: string) => path },
    '@tauri-apps/plugin-fs': { mkdir: async (path: string) => { events.push('mkdir:' + path); } },
    '@tauri-apps/plugin-http': { fetch: () => { throw new Error('Unexpected HTTP'); } },
    '../core/transport': { createContentTransport: () => {
      events.push('transport:create'); return () => { throw new Error('Unexpected request'); };
    } },
    '../core/summary-runtime': { createSummaryRuntime: (repository: unknown) => {
      events.push('runtime:create'); return { repository, dispose() {} };
    } },
    './summary-store': { createNativeSummaryStore: () => ({}) },
    '../core/media-validation': { validateMediaPath() {} },
    '../shared/media': { setMediaResolver: (value?: unknown) => { events.push(value ? 'media:expose' : 'media:clear'); } },
    '../src/api': { setApiTransport: (value?: unknown) => { events.push(value ? 'api:expose' : 'api:clear'); } },
    './tauri-filesystem': { tauriFiles: () => files },
    './file-repository': { FileRepository: class {
      constructor() { events.push('local:construct'); }
      async recover() { events.push('local:recover'); recoveryEntered.resolve(); await recovered.promise; events.push('local:ready'); }
    } },
    './git-engine': { NativeGitEngine: class {
      constructor(_files: unknown, _root: string, _state: string, _profile: unknown, _http: unknown,
        _credentials: unknown, adapter: { store: unknown; source: unknown }) {
        assert.equal(_files, files);
        assert.equal(_state, state);
        injected = adapter;
        events.push('git:construct');
      }
      async open() { events.push('git:open'); openEntered.resolve(); await opened.promise; events.push('git:ready'); }
      async assertWritable() {}
    } },
    './git-http': { createGitHttp: () => ({}) },
    './hosting': { validateProfile() {}, validateRemote() {} },
    './local-workspace': { inspectLocalRepository: async () => {
      events.push('local:inspect'); return { branch: 'main', url: 'https://git.example/site.git' };
    } },
    './load-diagnostics': { createLoadDiagnostics: () => ({
      progress: () => ({ onProgress() {}, finish() {} }),
      measure: (_label: string, action: () => unknown) => action(), dispose() {},
    }) },
    './review-store': {
      nativeReviewSource: (path: string) => { events.push('source:' + path); return source; },
      openNativeWorkspaceReviews: async (path: string, authorizationRoot: string) => {
        assert.equal(path, state);
        assert.equal(authorizationRoot, base);
        events.push('owner:begin'); ownerEntered.resolve();
        const value = await owner.promise;
        events.push('owner:ready'); return value;
      },
    },
    './filesystem': { ensureDirectory: async (adapter: unknown, path: string) => {
      assert.equal(adapter, files); events.push('ensure:' + path);
      if (path === state && holdState) { stateEntered.resolve(); await stateCreated.promise; }
    } },
  };
  const module = { exports: {} };
  runInNewContext(await bundle(), { module, exports: module.exports, boundaries, localStorage: {} });
  const runtime = module.exports as Runtime;
  return { runtime, events, store, source, stateCreated, stateEntered, owner, ownerEntered, opened, openEntered, recovered, recoveryEntered,
    injected: () => injected };
}
const forbiddenBeforeOwnership = /^(?:git:|local:construct|local:recover|runtime:|transport:|media:expose|api:expose)/;

test('native runtime awaits state, ownership, Git open and local recovery before exposure', { timeout: 15_000 }, async () => {
  const f = await fixture(base + '/', true);
  const connecting = f.runtime.connectNativeWorkspace(profile(), '', () => {});
  try {
    await f.stateEntered.promise;
    assert.deepEqual(f.events, ['mkdir:' + base, 'ensure:' + folder, 'ensure:' + state]);
    f.stateCreated.resolve();
    await f.ownerEntered.promise;
    assert.deepEqual(f.events, ['mkdir:' + base, 'ensure:' + folder, 'ensure:' + state, 'owner:begin']);
    assert.equal(f.events.some(event => forbiddenBeforeOwnership.test(event)), false);
    f.owner.resolve(f.store);
    await f.openEntered.promise;
    assert.equal(f.injected()?.store, f.store, 'inject the acquired store, not an unowned fallback');
    assert.equal(f.injected()?.source, f.source);
    assert.ok(f.events.indexOf('owner:ready') < f.events.indexOf('git:construct'));
    assert.ok(f.events.includes('source:' + root));
    assert.equal(f.events.some(event => /^(?:local:construct|runtime:|transport:|api:expose)/.test(event)), false);
    f.opened.resolve();
    await f.recoveryEntered.promise;
    assert.equal(f.events.some(event => /^(?:runtime:|transport:|media:expose|api:expose)/.test(event)), false);
    f.recovered.resolve();
    const dispose = await connecting;
    for (const name of ['runtime:create', 'transport:create', 'media:expose', 'api:expose']) {
      assert.ok(f.events.indexOf(name) > f.events.indexOf('local:ready'), name + ' must wait for recovery');
    }
    dispose();
  } finally {
    f.stateCreated.resolve(); f.owner.resolve(f.store); f.opened.resolve(); f.recovered.resolve();
    await connecting.catch(() => undefined);
  }
});

test('native runtime propagates ownership rejection without Git or transport fallback', { timeout: 15_000 }, async () => {
  const f = await fixture();
  const denied = new Error('Native owner denied; full restart required');
  const connecting = f.runtime.connectNativeWorkspace(profile('/selected/repo'), '', () => {});
  const rejected = assert.rejects(connecting, error => error === denied);
  await f.ownerEntered.promise;
  assert.deepEqual(f.events, ['mkdir:' + base, 'ensure:' + folder, 'local:inspect', 'ensure:' + state, 'owner:begin']);
  f.owner.reject(denied);
  await rejected;
  assert.equal(f.events.some(event => forbiddenBeforeOwnership.test(event)), false);
  assert.equal(f.injected(), undefined);
  assert.equal(f.events.filter(event => event === 'owner:begin').length, 1);
});

test('overlapping checkout/state paths are rejected before any directory creation or ownership', { timeout: 15_000 }, async () => {
  for (const localPath of [state, state + '/', folder, base, state + '/nested', state.replace(/\//g, '\\') + '\\']) {
    const f = await fixture();
    // Resolve gates so an accidental bypass fails assertions rather than hanging.
    f.owner.resolve(f.store); f.opened.resolve(); f.recovered.resolve();
    await assert.rejects(f.runtime.connectNativeWorkspace(profile(localPath), '', () => {}),
      /Git 工作区与状态目录必须分开存储/);
    assert.deepEqual(f.events, [], 'overlap must fail before mkdir/ensure/inspection/ownership: ' + localPath);
  }
});
