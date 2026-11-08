import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';

type Caps = {
  records: number; bytes: number; faults: number; runtimeFaults: number; nodeFaults: number; number: number;
};
type Contract = {
  version: number; hook: string; caps: Caps; events: string[]; owners: string[];
  origins: string[]; locales: string[]; faults: string[]; columns: string[];
};
type BuildPlugin = {
  name: string; enforce: string; apply: string;
  configResolved(config: { command: string; build: { ssr?: boolean } }): void;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
  transform(source: string, id: string, options?: { ssr?: boolean }): { code: string; map: null } | undefined;
  buildEnd(error?: Error): void;
};
type Token = object;
type Read = () => Record<string, unknown>;
type Runtime = {
  caller(owner: string, read?: Read): Token | null;
  api(read?: Read): Token | null;
  request(read?: Read): Token | null;
  event(token: Token | null, event: string, read?: Read): void;
  call<T>(token: Token | null, business: () => T): T;
};
type Ack = { version: number; owner: number; sessionId: number };
type Hook = { version: number; start(owner: number): Ack | null; finish(owner: number): Terminal | null };
type Row = [
  number, number | null, string, string, number | null, number | null, number | null,
  number | null, number | null, number | null, number | null, string | null,
  number | null, number | null, boolean | null, boolean | null, boolean | null,
  boolean | null, number | null, boolean | null, string | null,
];
type Terminal = {
  version: number; owner: number; sessionId: number; active: boolean; stoppedAt: number | null;
  attempts: number; retainedRecords: number; droppedRecords: number;
  faultAttempts: number; faults: string[]; droppedFaults: number; saturated: boolean; failed: boolean;
  lastObservedAppErrorWriter: string | null; writerKnown: boolean;
  appNotice: boolean | null; relationsNotice: boolean | null; records: Row[];
};
type Args = { hook: string; owner: number };
type Handle = { evaluate(callback: unknown, args: Args): unknown; dispose(): unknown };
type Page = { evaluateHandle(callback: unknown, args: Args): unknown };
type Clock = { setTimeout(callback: () => void, delay: number): number; clearTimeout(timer: number): void };
type Collector = { begin(page: Page): Promise<void>; finish(page: Page, path: string, outcome: string): Promise<void> };
type Report = {
  version: number; scope: string; expected: boolean; owner: number; outcome: string; status: string; capture: string;
  beginAttempted: boolean; started: boolean; terminalAttempted: boolean; terminalRpcAttempted: boolean;
  rpc: { deadlineMs: number; begin: string; terminal: string; binding: string };
  timingPerturbed: boolean; terminalAfterCatchDiagnostics: boolean;
  sharedWorkObserved: boolean; beforeStartObserved: boolean; currentAppWriterProven: boolean;
  caps: Caps; columns: string[];
  node: { faultAttempts: number; faults: string[]; droppedFaults: number; saturated: boolean };
  terminal: Terminal | null;
};

// Variable URLs keep test-only JavaScript imports out of declaration resolution.
const pluginURL = new URL('./browser/native-scope-build-plugin.mjs', import.meta.url).href;
const diagnosticsURL = new URL('./browser/native-scope-diagnostics.mjs', import.meta.url).href;
const { nativeScopeBuildPlugin, nativeScopeContract: contract } = await import(pluginURL) as {
  nativeScopeBuildPlugin(): BuildPlugin; nativeScopeContract: Contract;
};
const { projectNativeScopeTerminal, createNativeScopeDiagnostics } = await import(diagnosticsURL) as {
  projectNativeScopeTerminal(value: unknown, owner: number): Terminal;
  createNativeScopeDiagnostics(expected: boolean, options?: { clock: Clock }): Collector | null;
};
const virtualId = 'virtual:studio-test-native-scope-trace';
const resolvedVirtualId = `\0${virtualId}`;
const targetNames = ['App.tsx', 'components/SettingsView.tsx', 'api.ts'] as const;

function withBuildEnvironment<T>(ci: string | undefined, enabled: string | undefined, action: () => T): T {
  const previous = { CI: process.env.CI, STUDIO_TEST_NATIVE_SCOPE_TRACE: process.env.STUDIO_TEST_NATIVE_SCOPE_TRACE };
  try {
    for (const [key, value] of Object.entries({ CI: ci, STUDIO_TEST_NATIVE_SCOPE_TRACE: enabled })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function configuredPlugin() {
  const plugin = nativeScopeBuildPlugin();
  withBuildEnvironment('true', '1', () => plugin.configResolved({ command: 'build', build: {} }));
  return plugin;
}

function runtimeFixture(options: {
  globals?: Record<string, unknown>; descriptors?: Record<string, PropertyDescriptor>;
  now?: () => number; querySelector?: (selector: string) => unknown;
} = {}) {
  const source = configuredPlugin().load(resolvedVirtualId);
  assert.ok(source);
  assert.match(source, /^import \{ untracked \} from '@preact\/signals-react';\nexport const nativeScopeTrace = /);
  // CI-only unit fixture: evaluate the generated runtime, not the application or a browser.
  const executable = source.replace(/^import[^\n]+\n/, '').replace('export const nativeScopeTrace =', 'const nativeScopeTrace =');
  let reads = 0;
  const sandbox: Record<string, unknown> = {
    performance: { now: options.now ?? (() => 10) },
    document: { querySelector: options.querySelector ?? (() => null) },
    untracked: <T>(callback: () => T): T => { reads++; return callback(); },
    ...options.globals,
  };
  for (const [key, descriptor] of Object.entries(options.descriptors ?? {})) {
    Object.defineProperty(sandbox, key, descriptor);
  }
  const trace = runInNewContext(`${executable}\nnativeScopeTrace;`, sandbox) as Runtime;
  // Descriptor inspection must not invoke a preexisting hook accessor in collision fixtures.
  const hook = Object.getOwnPropertyDescriptor(sandbox, contract.hook)?.value as Hook | undefined;
  return { trace, hook, sandbox, reads: () => reads };
}

function row(seq: number, event = 'scope-invalidate', owner = 'other', caller: number | null = null,
  api: number | null = null, request: number | null = null): Row {
  return [seq, seq, event, owner, caller, api, request, null, null, null, null, null,
    null, null, null, null, null, null, null, null, null];
}

function terminal(owner = 1, records: Row[] = [row(1)]): Terminal {
  return {
    version: 1, owner, sessionId: 1, active: false, stoppedAt: 100,
    attempts: records.length, retainedRecords: records.length, droppedRecords: 0,
    faultAttempts: 0, faults: [], droppedFaults: 0, saturated: false, failed: false,
    lastObservedAppErrorWriter: null, writerKnown: false, appNotice: false, relationsNotice: false, records,
  };
}

function linkedTerminal(owner = 1) {
  return terminal(owner, [
    row(1, 'caller-start', 'app-content', 1), row(2, 'api-start', 'app-content', 1, 1),
    row(3, 'request-start', 'app-content', 1, 1, 1), row(4, 'request-return', 'app-content', 1, 1, 1),
  ]);
}

function assertPrivateFree(text: string) {
  assert.doesNotMatch(text, /private-|EISDIR|report\.json|"(?:message|stack|body|headers|url|path|privatePayload)"/);
}

test('native scope plugin: explicit CI build and exact-source fail-closed contract', { concurrency: false }, async t => {
  await t.test('disabled, non-CI, serve and SSR configurations refuse instrumentation', () => {
    for (const [ci, enabled, command, ssr] of [
      [undefined, undefined, 'build', false], ['true', undefined, 'build', false],
      ['false', '1', 'build', false], ['1', '1', 'build', false],
      ['true', 'true', 'build', false], ['true', '1', 'serve', false], ['true', '1', 'build', true],
    ] as const) {
      withBuildEnvironment(ci, enabled, () => {
        assert.throws(() => nativeScopeBuildPlugin().configResolved({ command, build: { ssr } }), /non-SSR CI build/);
      });
    }
    const plugin = nativeScopeBuildPlugin();
    assert.throws(() => plugin.load(resolvedVirtualId), /exactly once/);
    assert.throws(() => plugin.buildEnd(), /incomplete/);
  });

  const targets = await Promise.all(targetNames.map(async name => {
    const url = new URL(`../src/${name}`, import.meta.url);
    return { name, id: fileURLToPath(url), source: await readFile(url, 'utf8') };
  }));

  await t.test('only all three exact targets plus one virtual load can complete', () => {
    const plugin = configuredPlugin();
    assert.equal(plugin.enforce, 'pre');
    assert.equal(plugin.apply, 'build');
    assert.equal(plugin.resolveId(virtualId), resolvedVirtualId);
    assert.equal(plugin.resolveId(`${virtualId}?raw`), undefined);
    assert.equal(plugin.load('unrelated-module'), undefined);
    assert.equal(plugin.transform('private-unrelated-source', '/other/api.ts'), undefined);
    for (const target of targets) {
      assert.equal(plugin.transform(target.source, `${target.id}?raw`), undefined);
      const result = plugin.transform(target.source, target.id);
      assert.ok(result, `${target.name} must transform its real source`);
      assert.equal(result.map, null);
      assert.match(result.code, /^import \{ nativeScopeTrace as __studioNativeScope \} from "virtual:studio-test-native-scope-trace";\n/);
      assert.ok(result.code.includes('__studioNativeScope.call('));
      assert.throws(() => plugin.transform(target.source, target.id), /transform refused/);
    }
    assert.throws(() => plugin.buildEnd(), /virtualLoads=0/);
    assert.ok(plugin.load(resolvedVirtualId));
    assert.doesNotThrow(() => plugin.buildEnd());
    assert.throws(() => plugin.load(resolvedVirtualId), /exactly once/);
  });

  await t.test('real App locale watcher keeps its branch and records bit 5 immediately after generation increments', () => {
    const target = targets.find(target => target.name === 'App.tsx');
    assert.ok(target);
    const watcherStart = `    watch([
      session,
      () => session.value?.identity.id,
      () => session.value?.identity.method,
      () => session.value?.csrf,
      () => session.value?.expires,
      locale,
    ] as const, async (next, previous) => {
      generation++;`;
    const localeBranch = `      const [value] = next;
      const sessionChanged = next.slice(0, 5).some((item, index) => !Object.is(item, previous[index]));
      if (!sessionChanged) {
        if (checking.value) {
          await checkSession();
          return;
        }
        if (!value) return;
        // Locale invalidates pending reads, not the mounted editing context.
        if (workspaceRefreshPending) {
          await refreshWorkspace(false);
          return;
        }
        await Promise.all([
          loadingSite.value || !data.value ? bootstrap() : Promise.resolve(),
          loadingArticles.value || !articlesReady.value ? loadArticles() : Promise.resolve(),
        ]);
        return;
      }`;
    const watcherEnd = '    async function checkSession() {';
    assert.equal(target.source.split(watcherStart).length - 1, 1);
    assert.equal(target.source.split(watcherEnd).length - 1, 1);
    const watcher = target.source.slice(target.source.indexOf(watcherStart), target.source.indexOf(watcherEnd));
    assert.ok(watcher.startsWith(`${watcherStart}\n${localeBranch}`));
    const result = configuredPlugin().transform(target.source, target.id);
    assert.ok(result);
    const event = '      __studioNativeScope.event(null, "app-generation", () => ({ generation, reasonMask: previous ? next.reduce((mask, item, index) => mask | (!Object.is(item, previous[index]) ? 1 << index : 0), 0) : null }));';
    const instrumentedStart = `${watcherStart}\n${event}`;
    assert.equal(result.code.split(instrumentedStart).length - 1, 1);
    assert.equal(result.code.split(event).length - 1, 1);
    const instrumentedWatcher = result.code.slice(result.code.indexOf(watcherStart), result.code.indexOf(watcherEnd));
    assert.equal(instrumentedWatcher, watcher.replace(watcherStart, instrumentedStart),
      'Only the diagnostic event may be inserted; callback arguments and all business branches must remain original');

    // Evaluate only the generated increment/event fragment, never App business callbacks.
    const incrementAt = instrumentedWatcher.indexOf('      generation++;');
    const branchAt = instrumentedWatcher.indexOf('      const [value] = next;');
    assert.ok(incrementAt >= 0 && branchAt > incrementAt);
    const fragment = instrumentedWatcher.slice(incrementAt, branchAt);
    assert.equal(fragment, `      generation++;\n${event}\n`);
    const f = runtimeFixture();
    assert.ok(f.hook);
    assert.ok(f.hook.start(13));
    const sessionReference = {};
    const previous = [sessionReference, 'private-identity', 'private-method', 'private-csrf', 100, 'en'] as const;
    for (const [next, old] of [
      [[...previous.slice(0, 5), 'zh-CN'], previous],
      [[{}, ...previous.slice(1, 5), 'zh-CN'], previous],
      [previous, previous],
      [previous, undefined],
    ] as const) {
      const generation = 40;
      assert.equal(runInNewContext(`${fragment}\ngeneration;`, {
        __studioNativeScope: f.trace, generation, next, previous: old,
      }), generation + 1);
    }
    const terminal = f.hook.finish(13);
    assert.ok(terminal);
    const records = projectNativeScopeTerminal(terminal, 13).records;
    assert.deepEqual(Array.from(records, record => [record[2], record[3], record[9], record[18]]), [
      ['app-generation', 'other', 41, 32],
      ['app-generation', 'other', 41, 33],
      ['app-generation', 'other', 41, 0],
      ['app-generation', 'other', 41, null],
    ]);
    assertPrivateFree(JSON.stringify(terminal));

    const sentinel = '    ] as const, async (next, previous) => {\n      generation++;';
    for (const changed of [
      target.source.replace(sentinel, '    ] as const, async ([value]) => {\n      generation++;'),
      target.source.replace(sentinel, '    ] as const, async (next, previous) => {\n      generation += 1;'),
      `${target.source}\n${sentinel}`,
    ]) {
      assert.notEqual(changed, target.source);
      assert.throws(() => configuredPlugin().transform(changed, target.id), /sentinels changed/);
    }
  });

  await t.test('Settings relations instrumentation preserves refresh ownership and current=true guard semantics', async () => {
    const target = targets.find(target => target.name === 'components/SettingsView.tsx');
    assert.ok(target);
    const result = configuredPlugin().transform(target.source, target.id);
    assert.ok(result);
    const start = '    let relationsRequestId = 0, relationsAlive = true, relationsRefreshPending = false;';
    const end = '    watch(locale, () => {';
    function fragment(source: string) {
      const first = source.indexOf(start), last = source.indexOf(end, first);
      assert.ok(first >= 0 && last > first);
      // Erase only the two TS-only constructs in this bounded function fixture.
      return source.slice(first, last).replaceAll('api<ArticleSummary[]>', 'api').replace('item.publicPath!', 'item.publicPath');
    }
    const original = fragment(target.source), transformed = fragment(result.code);
    assert.match(transformed, /relationsRefreshPending = relationsRefreshPending \|\| refresh;\n\s+const __nsCaller = __studioNativeScope\.caller\("settings-relations", \(\) => \(\{ counter: id, refresh: relationsRefreshPending \}\)\);/);
    assert.equal(transformed.split('current()').length, original.split('current()').length,
      'Instrumentation must not evaluate current() an extra time');
    assert.ok(transformed.includes('"/content" + (relationsRefreshPending ? "?refresh=1" : "")'));
    for (const state of ['current', 'replaced', 'unmounted'] as const) {
      for (const rejection of [false, true]) {
        for (const [refresh, inheritedRefresh] of [[false, false], [true, false], [false, true], [true, true]]) {
          const effectiveRefresh = refresh || inheritedRefresh;
          async function execute(source: string, trace: Runtime) {
            const pending = deferred<unknown>();
            const paths: string[] = [];
            const globals = {
              __studioNativeScope: trace,
              relationsLoading: { value: false }, relationsError: { value: 'old-error' },
              unresolvedItems: { value: ['old-unresolved'] as unknown[] },
              postItems: { value: ['old-posts'] as unknown[] }, links: { value: ['old-links'] as unknown[] },
              errorMessage: () => 'fixed-error',
              api: (path: string) => { paths.push(path); return pending.promise; },
            };
            const context = createContext(globals);
            runInContext(source, context);
            // Simulate an inherited unfinished refresh obligation independently of
            // this invocation's refresh argument, as locale replacement does.
            runInContext(`relationsRefreshPending = ${inheritedRefresh};`, context);
            const operation = runInContext(`loadRelations(${refresh})`, context) as Promise<void>;
            assert.deepEqual(paths, [effectiveRefresh ? '/content?refresh=1' : '/content']);
            if (state === 'replaced') runInContext('relationsRequestId++;', context);
            if (state === 'unmounted') runInContext('relationsAlive = false; relationsRequestId++;', context);
            if (rejection) pending.reject(new Error('private-relations-error'));
            else pending.resolve([{ title: 'fixed-title', publicPath: '/post', kind: 'post', path: 'post.md', linkWarning: true }]);
            await operation;
            return JSON.parse(JSON.stringify({
              loading: globals.relationsLoading.value, error: globals.relationsError.value,
              unresolved: globals.unresolvedItems.value, posts: globals.postItems.value, links: globals.links.value,
              refreshPending: runInContext('relationsRefreshPending', context),
            })) as { loading: boolean; error: string; refreshPending: boolean };
          }
          const f = runtimeFixture();
          assert.ok(f.hook);
          assert.ok(f.hook.start(17));
          const observed = await execute(transformed, f.trace);
          const baseline = await execute(original, runtimeFixture().trace);
          assert.deepEqual(observed, baseline, `${state}, rejection=${rejection}, refresh=${refresh}: business state must be unchanged`);
          const snapshot = f.hook.finish(17);
          assert.ok(snapshot);
          const records = projectNativeScopeTerminal(snapshot, 17).records;
          const current = state === 'current', counter = current ? 1 : 2;
          assert.deepEqual(Array.from(records, record => [record[2], record[3], record[10], record[14], record[19]]), [
            ['caller-start', 'settings-relations', 1, null, effectiveRefresh],
            [rejection ? 'caller-catch' : 'caller-return', 'settings-relations', null, null, null],
            ['guard', 'settings-relations', counter, current, null],
            ...(rejection && current ? [['notice-write', 'settings-relations', null, null, null]] : []),
            ['caller-finally', 'settings-relations', counter, current, null],
            ...(current ? [['loading-clear', 'settings-relations', null, null, null]] : []),
          ]);
          assert.equal(observed.loading, !current);
          assert.equal(observed.refreshPending, !current && effectiveRefresh);
          assert.equal(observed.error, rejection && current ? 'fixed-error' : '');
        }
      }
    }

    // Every replaced guard sentinel is fail-closed, including the obsolete
    // unguarded catch/finally shape that caused the remote regression.
    for (const [before, after] of [
      ['        if (!current()) return;', '        if (false) return;'],
      ['        if (current()) relationsError.value = errorMessage(e);', '        relationsError.value = errorMessage(e);'],
      ['        if (current()) {\n          relationsRefreshPending = false;', '        {\n          relationsRefreshPending = false;'],
      ['      relationsRefreshPending = relationsRefreshPending || refresh;', '      relationsRefreshPending = refresh;'],
    ]) {
      assert.equal(target.source.split(before).length - 1, 1);
      assert.throws(() => configuredPlugin().transform(target.source.replace(before, after), target.id), /sentinels changed/);
    }
  });

  await t.test('missing, duplicate, changed, pre-instrumented and SSR source cannot pass', () => {
    for (const target of targets) {
      const plugin = configuredPlugin();
      assert.throws(() => plugin.transform(target.source, target.id, { ssr: true }), /transform refused/);
      const changed = target.source.replace('async function ', 'async function __changed_');
      assert.notEqual(changed, target.source);
      assert.throws(() => plugin.transform(changed, target.id), /sentinels changed/);
      assert.throws(() => plugin.transform(`${target.source}\n${target.source}`, target.id), /sentinels changed/);
      assert.throws(() => plugin.transform(`${target.source}\n// __studioNativeScope`, target.id), /sentinels changed/);
      assert.throws(() => nativeScopeBuildPlugin().transform(target.source, target.id), /transform refused/);
    }
    const incomplete = configuredPlugin();
    incomplete.load(resolvedVirtualId);
    incomplete.transform(targets[0].source, targets[0].id);
    assert.throws(() => incomplete.buildEnd(), /transformed=1/);
    assert.doesNotThrow(() => incomplete.buildEnd(new Error('private-existing-build-failure')));
  });
});

test('native scope runtime: ownership, synchronous attribution and bounded projection', { concurrency: false }, async t => {
  await t.test('inactive calls are not adopted; owner and session are single-use', () => {
    const f = runtimeFixture();
    assert.ok(f.hook);
    const descriptor = Object.getOwnPropertyDescriptor(f.sandbox, contract.hook);
    assert.equal(descriptor?.writable, false);
    assert.equal(descriptor?.configurable, false);
    assert.ok(Object.isFrozen(f.hook));
    assert.ok(Object.isFrozen(f.trace));
    let inactiveReads = 0;
    const before = f.trace.caller('app-content', () => { inactiveReads++; return {}; });
    assert.equal(before, null);
    assert.equal(f.trace.call(before, () => 'same-value'), 'same-value');
    for (const owner of [0, -1, NaN, 1.5, contract.caps.number]) assert.equal(f.hook.start(owner), null);
    const ack = f.hook.start(7);
    assert.ok(ack);
    assert.deepEqual({ ...ack }, { version: 1, owner: 7, sessionId: 1 });
    assert.equal(f.hook.start(8), null);
    assert.equal(f.hook.finish(8), null);
    f.trace.event(before, 'caller-return', () => { inactiveReads++; return {}; });
    const token = f.trace.caller('app-content');
    assert.ok(token);
    f.trace.event(token, 'notice-write');
    const result = f.hook.finish(7);
    assert.ok(result);
    assert.equal(result.records.length, 2);
    assert.equal(result.lastObservedAppErrorWriter, 'app-content');
    assert.equal(result.writerKnown, false);
    assert.equal(result.active, false);
    assert.equal(result.sessionId, ack.sessionId);
    assert.equal(f.hook.finish(7), null);
    assert.equal(f.hook.start(7), null);
    f.trace.event(token, 'caller-return', () => { inactiveReads++; return {}; });
    assert.equal(f.trace.api(), null);
    assert.equal(inactiveReads, 0);
    assert.equal(projectNativeScopeTerminal(result, 7).attempts, 2);
  });

  await t.test('a preexisting hook is never overwritten or adopted', () => {
    const existing = Object.freeze({ version: 1, privatePayload: 'private-hook' });
    const f = runtimeFixture({ globals: { [contract.hook]: existing } });
    assert.strictEqual(f.sandbox[contract.hook], existing);
    assert.equal(f.sandbox[`${contract.hook}Unavailable`], true);
    assert.equal(f.trace.caller('app-content'), null);
    const unavailable = runtimeFixture({ globals: { [`${contract.hook}Unavailable`]: true } });
    assert.equal(unavailable.sandbox[contract.hook], undefined);
    assert.equal(unavailable.trace.api(), null);
  });

  await t.test('collision descriptor matrix preserves existing hooks and markers without invoking accessors', async t => {
    type DescriptorCase = { name: string; create(get: () => unknown, set: (value: unknown) => void): PropertyDescriptor };
    const privateValue = Object.freeze({ privatePayload: 'private-collision-sentinel' });
    const cases: DescriptorCase[] = [];
    for (const configurable of [false, true]) {
      for (const writable of [false, true]) {
        for (const value of [false, privateValue]) {
          cases.push({
            name: `data-${value === false ? 'false' : 'private'}-configurable-${configurable}-writable-${writable}`,
            create: () => ({ value, configurable, writable, enumerable: true }),
          });
        }
      }
      for (const kind of ['getter', 'setter', 'getter-setter'] as const) {
        cases.push({
          name: `${kind}-configurable-${configurable}`,
          create: (get, set) => ({
            configurable, enumerable: false,
            ...(kind !== 'setter' ? { get } : {}),
            ...(kind !== 'getter' ? { set } : {}),
          }),
        });
      }
    }
    const marker = `${contract.hook}Unavailable`;
    // Fourteen descriptor shapes plus absence for each property: 15² - 1 collisions.
    const variants = [undefined, ...cases];
    for (const hookCase of variants) {
      for (const markerCase of variants) {
        if (!hookCase && !markerCase) continue;
        await t.test(`hook=${hookCase?.name ?? 'absent'} marker=${markerCase?.name ?? 'absent'}`, () => {
          let getterCalls = 0, setterCalls = 0, diagnosticReads = 0, businessCalls = 0;
          const get = () => { getterCalls++; return privateValue; };
          const set = (_value: unknown) => { setterCalls++; };
          const descriptors: Record<string, PropertyDescriptor> = {};
          if (hookCase) descriptors[contract.hook] = hookCase.create(get, set);
          if (markerCase) descriptors[marker] = markerCase.create(get, set);
          const f = runtimeFixture({ descriptors });
          for (const [key, before] of Object.entries(descriptors)) {
            const after = Object.getOwnPropertyDescriptor(f.sandbox, key);
            assert.ok(after);
            assert.equal(after.configurable, before.configurable);
            assert.equal(after.enumerable, before.enumerable);
            if ('value' in before) {
              assert.strictEqual(after.value, before.value, 'Existing data values must retain identity, including false');
              assert.equal(after.writable, before.writable);
              assert.equal('get' in after, false);
            } else {
              assert.strictEqual(after.get, before.get);
              assert.strictEqual(after.set, before.set);
              assert.equal('value' in after, false);
            }
          }
          if (!hookCase) assert.equal(Object.hasOwn(f.sandbox, contract.hook), false);
          if (!markerCase) {
            assert.deepEqual(Object.getOwnPropertyDescriptor(f.sandbox, marker), {
              value: true, writable: false, enumerable: false, configurable: false,
            });
          }
          const read = () => { diagnosticReads++; return {}; };
          assert.equal(f.trace.caller('app-content', read), null);
          assert.equal(f.trace.api(read), null);
          assert.equal(f.trace.request(read), null);
          f.trace.event(null, 'scope-invalidate', read);
          assert.equal(f.trace.call(null, () => { businessCalls++; return privateValue; }), privateValue);
          assert.equal(businessCalls, 1);
          assert.equal(diagnosticReads, 0);
          assert.equal(f.reads(), 0);
          assert.equal(getterCalls, 0, 'Collision checks and fixture inspection must never invoke getters');
          assert.equal(setterCalls, 0, 'Installation must never assign through existing setters');
        });
      }
    }
  });

  await t.test('pre-start API and request tokens cannot adopt work when capture begins', () => {
    const f = runtimeFixture();
    assert.ok(f.hook);
    let reads = 0;
    const read = () => { reads++; return {}; };
    const beforeApi = f.trace.api(read);
    const beforeRequest = f.trace.request(read);
    assert.equal(beforeApi, null);
    assert.equal(beforeRequest, null);
    assert.equal(reads, 0);
    assert.ok(f.hook.start(11));
    const request = f.trace.call(beforeApi, () => f.trace.request());
    assert.ok(request);
    f.trace.event(beforeRequest, 'transport-return', read);
    f.trace.event(beforeRequest, 'request-return', read);
    f.trace.event(beforeApi, 'api-return', read);
    f.trace.event(request, 'request-return');
    const result = f.hook.finish(11);
    assert.ok(result);
    const records = projectNativeScopeTerminal(result, 11).records;
    assert.deepEqual(Array.from(records, record => Array.from(record).slice(2, 7)), [
      ['request-start', 'other', null, null, 1],
      ['request-return', 'other', null, null, 1],
    ]);
    assert.equal(result.attempts, 2);
    assert.equal(reads, 0, 'Pre-start completions must not even read diagnostic state');
  });

  await t.test('explicit tokens preserve async closure links without leaking synchronous global context', async () => {
    const f = runtimeFixture();
    assert.ok(f.hook);
    assert.ok(f.hook.start(12));
    const caller = f.trace.caller('app-content');
    assert.ok(caller);
    let businessCalls = 0;
    const operation = f.trace.call(caller, async () => {
      businessCalls++;
      const api = f.trace.api();
      assert.ok(api);
      await Promise.resolve();
      // Async continuations need their explicit token; global context must be empty.
      f.trace.request();
      const request = f.trace.call(api, () => f.trace.request());
      assert.ok(request);
      await Promise.resolve();
      f.trace.event(request, 'request-return');
      f.trace.event(api, 'api-return');
      return 'same-result';
    });
    f.trace.api(); // Synchronous work outside call() must not inherit the caller.
    assert.equal(await operation, 'same-result');
    assert.equal(businessCalls, 1);
    f.trace.event(caller, 'caller-return');
    f.trace.request(); // Explicit async call() must also restore its prior empty context.
    const result = f.hook.finish(12);
    assert.ok(result);
    const records = projectNativeScopeTerminal(result, 12).records;
    assert.deepEqual(Array.from(records, record => Array.from(record).slice(2, 7)), [
      ['caller-start', 'app-content', 1, null, null],
      ['api-start', 'app-content', 1, 1, null],
      ['api-start', 'other', null, 2, null],
      ['request-start', 'other', null, null, 1],
      ['request-start', 'app-content', 1, 1, 2],
      ['request-return', 'app-content', 1, 1, 2],
      ['api-return', 'app-content', 1, 1, null],
      ['caller-return', 'app-content', 1, null, null],
      ['request-start', 'other', null, null, 3],
    ]);
    assertPrivateFree(JSON.stringify(result));
  });

  await t.test('nested synchronous context is consumed once and restored without wrapping business results', async () => {
    const f = runtimeFixture();
    assert.ok(f.hook);
    f.hook.start(1);
    const caller = f.trace.caller('app-bootstrap');
    const nestedCaller = f.trace.caller('settings-main');
    let businessCalls = 0;
    const originalPromise = Promise.resolve('private-business-result');
    const thrown = Object.assign(new Error('private-business-error'), { privatePayload: 'private-body' });
    const beforeReads = f.reads();
    const returned = f.trace.call(caller, () => {
      businessCalls++;
      assert.equal(f.reads(), beforeReads, 'Business callbacks must not run inside untracked');
      f.trace.call(nestedCaller, () => f.trace.api());
      assert.throws(() => f.trace.call(nestedCaller, () => { throw thrown; }), error => error === thrown);
      // Both nested calls must restore the unconsumed outer context, including on throw.
      const api = f.trace.api();
      f.trace.call(api, () => {
        f.trace.request();
        f.trace.request(); // The API parent has already been consumed.
      });
      f.trace.api(); // The outer caller parent has also been consumed.
      return originalPromise;
    });
    assert.strictEqual(returned, originalPromise);
    assert.equal(businessCalls, 1);
    await returned;
    f.trace.api(); // No attribution may survive the synchronous call boundary.
    const result = f.hook.finish(1);
    assert.ok(result);
    const records = projectNativeScopeTerminal(result, 1).records;
    assert.deepEqual(Array.from(records, record => Array.from(record).slice(2, 7)), [
      ['caller-start', 'app-bootstrap', 1, null, null],
      ['caller-start', 'settings-main', 2, null, null],
      ['api-start', 'settings-main', 2, 1, null],
      ['api-start', 'app-bootstrap', 1, 2, null],
      ['request-start', 'app-bootstrap', 1, 2, 1],
      ['request-start', 'other', null, null, 2],
      ['api-start', 'other', null, 3, null],
      ['api-start', 'other', null, 4, null],
    ]);
    assertPrivateFree(JSON.stringify(result));
  });

  await t.test('only diagnostic reads are untracked and private fields are never projected', () => {
    const f = runtimeFixture({ querySelector: selector => selector.startsWith('.main-content') ? {} : null });
    assert.ok(f.hook);
    f.hook.start(2);
    const priorReads = f.reads();
    const caller = f.trace.caller('app-content', () => ({
      scope: 3, transport: 4, generation: 5, counter: 6, refresh: true, locale: 'private-locale',
      privatePayload: 'private-path-and-token', body: 'private-body',
    }));
    assert.equal(f.reads(), priorReads + 1);
    f.trace.event(caller, 'notice-write');
    const result = f.hook.finish(2);
    assert.ok(result);
    assert.equal(result.appNotice, true);
    assert.equal(result.relationsNotice, false);
    assert.equal(result.records[0][7], 3);
    assert.equal(result.records[0][20], 'other');
    assert.equal(result.records[0].length, contract.columns.length);
    assertPrivateFree(JSON.stringify(projectNativeScopeTerminal(result, 2)));
  });

  await t.test('record overflow keeps the first 64 and terminal accounting remains partial, not silent success', () => {
    const f = runtimeFixture();
    assert.ok(f.hook);
    f.hook.start(3);
    for (let index = 0; index < 70; index++) f.trace.event(null, 'scope-invalidate', () => ({ scope: index }));
    const result = f.hook.finish(3);
    assert.ok(result);
    const projected = projectNativeScopeTerminal(result, 3);
    assert.equal(projected.records.length, 64);
    assert.equal(projected.attempts, 70);
    assert.equal(projected.droppedRecords, 6);
    assert.equal(projected.attempts, projected.retainedRecords + projected.droppedRecords);
    assert.equal(projected.records[0][7], 0);
    assert.equal(projected.records[63][7], 63);
    assert.equal(projected.active, false);
  });

  await t.test('repeated throwing diagnostic getters stay bounded and cannot swallow business exceptions', () => {
    const f = runtimeFixture();
    assert.ok(f.hook);
    f.hook.start(4);
    const original = new Error('private-getter-error');
    for (let index = 0; index < 10; index++) {
      assert.doesNotThrow(() => f.trace.event(null, 'scope-invalidate', () => { throw original; }));
    }
    let calls = 0;
    assert.throws(() => f.trace.call(null, () => { calls++; throw original; }), error => error === original);
    assert.equal(calls, 1);
    const result = f.hook.finish(4);
    assert.ok(result);
    const projected = projectNativeScopeTerminal(result, 4);
    assert.equal(projected.failed, true);
    assert.equal(projected.faultAttempts, 10);
    assert.deepEqual(Array.from(projected.faults), ['read', 'read', 'read', 'read']);
    assert.equal(projected.droppedFaults, 6);
    assert.equal(projected.faultAttempts, projected.faults.length + projected.droppedFaults);
    assert.equal(projected.attempts, 10);
    assert.equal(projected.droppedRecords, 10);
    assert.equal(projected.retainedRecords, 0);
    assertPrivateFree(JSON.stringify(projected));
  });
});

test('native scope validator: closed schema, counts, bounds and causal links', { concurrency: false }, async t => {
  await t.test('valid linked rows are copied rather than retaining incoming arrays', () => {
    const raw = linkedTerminal();
    const projected = projectNativeScopeTerminal(raw, 1);
    assert.deepEqual(projected, raw);
    assert.notStrictEqual(projected, raw);
    assert.notStrictEqual(projected.records, raw.records);
    assert.notStrictEqual(projected.records[0], raw.records[0]);
    assert.notStrictEqual(projected.faults, raw.faults);
    raw.records[0][3] = 'private-mutated-owner';
    raw.faults.push('private-mutated-fault');
    assert.equal(projected.records[0][3], 'app-content');
    assert.deepEqual(projected.faults, []);
  });

  const invalid: { name: string; mutate(value: Terminal): void }[] = [
    { name: 'unknown private field', mutate: value => { Object.assign(value, { privatePayload: 'private-token' }); } },
    { name: 'missing field', mutate: value => { Reflect.deleteProperty(value, 'appNotice'); } },
    { name: 'wrong owner', mutate: value => { value.owner = 2; } },
    { name: 'wrong session', mutate: value => { value.sessionId = 2; } },
    { name: 'active snapshot', mutate: value => { value.active = true; } },
    { name: 'unproven writer claimed known', mutate: value => { value.writerKnown = true; } },
    { name: 'unknown writer', mutate: value => { value.lastObservedAppErrorWriter = 'settings-main'; } },
    { name: 'attempt equation', mutate: value => { value.attempts++; } },
    { name: 'retained equation', mutate: value => { value.retainedRecords--; } },
    { name: 'fault equation', mutate: value => { value.faultAttempts++; } },
    { name: 'unknown fault', mutate: value => { value.faults.push('private-error'); value.faultAttempts++; } },
    { name: 'too many faults', mutate: value => { value.faults = Array(5).fill('read'); value.faultAttempts = 5; } },
    { name: 'too many records', mutate: value => {
      value.records = Array.from({ length: 65 }, (_, index) => row(index + 1));
      value.attempts = value.retainedRecords = 65;
    } },
    { name: 'extra row column', mutate: value => { value.records[0].push('private-payload'); } },
    { name: 'unknown event', mutate: value => { value.records[0][2] = 'private-event'; } },
    { name: 'unknown owner', mutate: value => { value.records[0][3] = 'private-owner'; } },
    { name: 'unknown origin', mutate: value => { value.records[0][11] = 'private-origin'; } },
    { name: 'unknown locale', mutate: value => { value.records[0][20] = 'private-locale'; } },
    { name: 'duplicate sequence', mutate: value => { value.records[1][0] = 1; } },
    { name: 'sequence beyond attempts', mutate: value => { value.records[3][0] = 5; } },
    { name: 'backwards time', mutate: value => { value.records[1][1] = 0; } },
    { name: 'time after stop', mutate: value => { value.records[3][1] = 101; } },
    { name: 'unbounded generation', mutate: value => { value.records[0][9] = contract.caps.number; } },
    { name: 'noninteger scope', mutate: value => { value.records[0][7] = 0.5; } },
    { name: 'invalid response status', mutate: value => { value.records[0][12] = 600; } },
    { name: 'invalid error status', mutate: value => { value.records[0][13] = 600; } },
    { name: 'reason mask overflow', mutate: value => { value.records[0][18] = 64; } },
    { name: 'zero caller ID', mutate: value => { value.records[0][4] = 0; } },
    { name: 'caller owner mismatch', mutate: value => { value.records[1][3] = 'settings-main'; } },
    { name: 'missing caller start', mutate: value => { value.records[0][2] = 'caller-return'; } },
    { name: 'missing API start', mutate: value => { value.records[1][2] = 'api-return'; } },
    { name: 'missing request start', mutate: value => { value.records[2][2] = 'request-return'; } },
    { name: 'API link mismatch', mutate: value => { value.records[3][5] = 2; } },
    { name: 'request link mismatch', mutate: value => { value.records[3][6] = 2; } },
  ];
  for (const item of invalid) {
    await t.test(`rejects ${item.name}`, () => {
      const value = linkedTerminal();
      item.mutate(value);
      assert.throws(() => projectNativeScopeTerminal(value, 1), /Native scope/);
    });
  }
  await t.test('partial evidence is valid schema but never fabricated into complete evidence', () => {
    const value = terminal();
    value.records[0][1] = null;
    value.stoppedAt = null;
    value.appNotice = null;
    value.failed = true;
    assert.deepEqual(projectNativeScopeTerminal(value, 1), value);
    assert.throws(() => projectNativeScopeTerminal(terminal(0), 0), /owner invalid/);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: Clock = {
    setTimeout(callback, delay) { const key = ++id; timers.set(key, { at: now + delay, callback }); return key; },
    clearTimeout(key) { timers.delete(key); },
  };
  return {
    clock, pending: () => timers.size,
    async advance(ms: number) {
      now += ms;
      for (const [key, timer] of timers) {
        if (timer.at <= now) { timers.delete(key); timer.callback(); }
      }
      await flushMicrotasks();
    },
  };
}

async function collectorFixture(t: TestContext, options: {
  start?: (owner: number) => unknown; stop?: (owner: number) => unknown; directoryPath?: boolean;
  beginRpc?: (handle: Handle) => unknown; terminalRpc?: (run: () => unknown) => unknown;
  envelope?: (value: Record<string, unknown>) => unknown; dispose?: () => unknown;
  hookDescriptors?: Record<string, PropertyDescriptor>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report.json');
  if (options.directoryPath) await mkdir(reportPath);
  const time = fakeClock();
  const collector = createNativeScopeDiagnostics(true, { clock: time.clock });
  assert.ok(collector);
  const calls: Args[] = [];
  let starts = 0, stops = 0, disposals = 0, capsule: unknown;
  const sandbox: Record<string, unknown> = {
    document: {}, location: { href: 'https://same.example.test/' }, performance: { timeOrigin: 10 },
  };
  const hook = {
    version: 1,
    start(owner: number) { starts++; return options.start ? options.start(owner) : { version: 1, owner, sessionId: 1 }; },
    finish(owner: number) { stops++; return options.stop ? options.stop(owner) : terminal(owner); },
  };
  Object.defineProperties(hook, options.hookDescriptors ?? {});
  Object.defineProperty(sandbox, contract.hook, { value: Object.freeze(hook), configurable: false, writable: false });
  const context = createContext(sandbox);
  const handle: Handle = {
    evaluate(callback, args) {
      calls.push({ ...args });
      const run = () => {
        sandbox.capsule = capsule; sandbox.args = args;
        const value = runInContext(`(${String(callback)})(capsule, args)`, context) as Record<string, unknown>;
        return options.envelope ? options.envelope(value) : value;
      };
      return options.terminalRpc ? options.terminalRpc(run) : run();
    },
    dispose() { disposals++; return options.dispose?.(); },
  };
  const page: Page = {
    evaluateHandle(callback, args) {
      calls.push({ ...args });
      sandbox.args = args;
      capsule = runInContext(`(${String(callback)})(args)`, context);
      return options.beginRpc ? options.beginRpc(handle) : handle;
    },
  };
  async function report() {
    const text = await readFile(reportPath, 'utf8');
    assert.ok(Buffer.byteLength(text, 'utf8') <= contract.caps.bytes);
    assertPrivateFree(text);
    const value = JSON.parse(text) as Report;
    assert.equal(value.node.faultAttempts, value.node.faults.length + value.node.droppedFaults);
    assert.ok(value.node.faults.length <= contract.caps.nodeFaults);
    assert.ok(value.node.faults.length + (value.terminal?.faults.length ?? 0) <= contract.caps.faults);
    return value;
  }
  return { collector, page, handle, sandbox, calls, time, reportPath, report,
    counts: () => ({ starts, stops, disposals }), capsule: () => capsule };
}

async function withFailureSignals(action: (messages: unknown[][]) => Promise<void>) {
  const exitCode = process.exitCode;
  const consoleError = console.error;
  const messages: unknown[][] = [];
  try {
    process.exitCode = undefined;
    console.error = (...args: unknown[]) => { messages.push(args); };
    await action(messages);
  } finally {
    process.exitCode = exitCode;
    console.error = consoleError;
  }
}

test('native scope collector: one begin/terminal RPC, strict completeness and bounded failure delivery',
  { concurrency: false }, async t => {
    await t.test('opt-out creates nothing; a complete report preserves explicit evidence boundaries', async t => {
      assert.equal(createNativeScopeDiagnostics(false), null);
      const f = await collectorFixture(t);
      await withFailureSignals(async messages => {
        await f.collector.begin(f.page);
        await f.collector.finish(f.page, f.reportPath, 'passed');
        assert.equal(process.exitCode, undefined);
        assert.deepEqual(messages, []);
      });
      assert.equal(f.calls.length, 2);
      assert.equal(f.calls[0].hook, contract.hook);
      assert.equal(f.calls[0].owner, f.calls[1].owner);
      const report = await f.report();
      assert.equal(report.version, 2);
      assert.equal(report.owner, f.calls[0].owner);
      assert.equal(report.terminalRpcAttempted, true);
      assert.deepEqual(report.rpc, { deadlineMs: 3000, begin: 'handle-received', terminal: 'returned', binding: 'matched' });
      assert.deepEqual(f.counts(), { starts: 1, stops: 1, disposals: 1 });
      assert.equal(f.time.pending(), 0);
      assert.ok(Object.isFrozen(f.capsule()));
      assert.equal(report.status, 'complete');
      assert.equal(report.capture, 'stopped');
      assert.equal(report.outcome, 'passed');
      assert.equal(report.beginAttempted, true);
      assert.equal(report.started, true);
      assert.equal(report.terminalAttempted, true);
      assert.equal(report.timingPerturbed, true);
      assert.equal(report.terminalAfterCatchDiagnostics, true);
      assert.equal(report.sharedWorkObserved, false);
      assert.equal(report.beforeStartObserved, false);
      assert.equal(report.currentAppWriterProven, false);
      assert.deepEqual(report.caps, contract.caps);
      assert.deepEqual(report.caps, { records: 64, bytes: 16384, faults: 8, runtimeFaults: 4, nodeFaults: 4, number: 2147483647 });
      assert.deepEqual(report.columns, contract.columns);
      assert.equal(report.terminal?.active, false);
    });

    for (const unknown of ['throw', 'invalid'] as const) {
      await t.test(`an unknown start (${unknown}) is never retried but still gets exactly one terminal attempt`, async t => {
        const f = await collectorFixture(t, { start: () => {
          if (unknown === 'throw') throw new Error('private-start-rpc');
          return { privatePayload: 'private-invalid-start' };
        } });
        await withFailureSignals(async messages => {
          await f.collector.begin(f.page);
          await f.collector.finish(f.page, f.reportPath, 'failed');
          const report = await f.report();
          assert.equal(report.status, 'incomplete');
          assert.equal(report.capture, 'start-unknown');
          assert.equal(report.started, false);
          assert.equal(report.terminalAttempted, true);
          assert.equal(report.terminalRpcAttempted, true);
          assert.ok(report.terminal, 'A valid terminal cannot erase an unknown start ack');
          assert.deepEqual(report.node.faults, ['start-schema', 'incomplete']);
          const text = await readFile(f.reportPath, 'utf8');
          await f.collector.finish(f.page, f.reportPath, 'failed');
          assert.equal(await readFile(f.reportPath, 'utf8'), text, 'Repeated finish must not rewrite or touch the hook');
          assert.equal(f.calls.length, 2);
          assert.equal(process.exitCode, 1);
          assert.equal(messages.length, 1);
          assertPrivateFree(JSON.stringify(messages));
        });
      });
    }

    await t.test('pre-start failure writes incomplete evidence without touching the page', async t => {
      const f = await collectorFixture(t);
      await withFailureSignals(async messages => {
        await f.collector.finish(f.page, f.reportPath, 'failed');
        assert.deepEqual(f.calls, []);
        const report = await f.report();
        assert.equal(report.capture, 'not-started');
        assert.equal(report.terminalRpcAttempted, false);
        await f.collector.begin(f.page);
        assert.equal(f.calls.length, 0, 'Begin cannot start after finalization');
        assert.equal(report.status, 'incomplete');
        assert.equal(report.terminal, null);
        assert.deepEqual(report.node.faults, ['incomplete']);
        assert.equal(process.exitCode, 1);
        assert.equal(messages.length, 1);
      });
    });

    const incompleteCases: { name: string; change(value: Terminal): void }[] = [
      { name: 'dropped records', change: value => { value.attempts++; value.droppedRecords++; } },
      { name: 'runtime faults', change: value => { value.failed = true; value.faults = ['read']; value.faultAttempts = 1; } },
      { name: 'saturation', change: value => { value.saturated = true; } },
      { name: 'missing stop time', change: value => { value.stoppedAt = null; } },
      { name: 'missing record time', change: value => { value.records[0][1] = null; } },
      { name: 'missing notice observation', change: value => { value.appNotice = null; } },
      { name: 'empty capture', change: value => { value.records = []; value.attempts = value.retainedRecords = 0; } },
    ];
    for (const item of incompleteCases) {
      await t.test(`${item.name} cannot count as complete after a passed business operation`, async t => {
        const f = await collectorFixture(t, { stop: owner => {
          const value = terminal(owner);
          item.change(value);
          return value;
        } });
        await withFailureSignals(async messages => {
          await f.collector.begin(f.page);
          await f.collector.finish(f.page, f.reportPath, 'passed');
          const report = await f.report();
          assert.equal(report.outcome, 'passed');
          assert.equal(report.status, 'incomplete');
          assert.deepEqual(report.node.faults, ['incomplete']);
          assert.equal(process.exitCode, 1);
          assert.equal(messages.length, 1);
        });
      });
    }

    await t.test('invalid terminal objects are discarded rather than retained as a raw fallback', async t => {
      const f = await collectorFixture(t, { stop: owner => ({ ...terminal(owner), privatePayload: 'private-secret' }) });
      await withFailureSignals(async messages => {
        await f.collector.begin(f.page);
        await f.collector.finish(f.page, f.reportPath, 'passed');
        const report = await f.report();
        assert.equal(report.terminal, null);
        assert.equal(report.capture, 'terminal-unknown');
        assert.deepEqual(report.node.faults, ['terminal-schema', 'incomplete']);
        assert.equal(process.exitCode, 1);
        assert.equal(messages.length, 1);
        assertPrivateFree(JSON.stringify(messages));
      });
    });

    await t.test('fault overflow stays sticky with four retained codes and no extra RPC or unbounded output', async t => {
      const f = await collectorFixture(t);
      await withFailureSignals(async messages => {
        await f.collector.begin(f.page);
        for (let index = 0; index < 12; index++) await f.collector.begin(f.page);
        await f.collector.finish(f.page, f.reportPath, 'passed');
        const report = await f.report();
        assert.equal(report.status, 'incomplete');
        assert.equal(report.node.faultAttempts, 12);
        assert.deepEqual(report.node.faults, Array(4).fill('start-schema'));
        assert.equal(report.node.droppedFaults, 8);
        assert.equal(f.calls.length, 2);
        assert.equal(process.exitCode, 1);
        for (let index = 0; index < 12; index++) await f.collector.finish(f.page, f.reportPath, 'passed');
        assert.equal(f.calls.length, 2);
        assert.equal(messages.length, 1);
        assert.ok(JSON.stringify(messages).length < 256);
        assertPrivateFree(JSON.stringify(messages));
      });
    });

    await t.test('an injected full-report byte-length rejection fails the size guard without expanding caps', async t => {
      // Guard-level fault injection only: this does not prove that the closed
      // schema can naturally produce an oversized terminal or a maximal report.
      const f = await collectorFixture(t, { stop: owner => linkedTerminal(owner) });
      const baseline = linkedTerminal(1);
      assert.equal(projectNativeScopeTerminal(baseline, 1).records.length, 4);
      assert.ok(Buffer.byteLength(JSON.stringify(baseline), 'utf8') < contract.caps.bytes);
      await withFailureSignals(async messages => {
        await f.collector.begin(f.page);
        const originalByteLength = Buffer.byteLength;
        const measured: string[] = [];
        try {
          Buffer.byteLength = (...args: Parameters<typeof Buffer.byteLength>) => {
            const value = args[0];
            // Inject only the collector's first complete-report measurement.
            // Subsequent fallback measurements use the real UTF-8 byte length.
            if (typeof value === 'string' && value.startsWith('{"version":2,"scope":"final-clone-to-outer-finally"')) {
              measured.push(value);
              if (measured.length === 1) return contract.caps.bytes + 1;
            }
            return originalByteLength(...args);
          };
          await f.collector.finish(f.page, f.reportPath, 'passed');
        } finally {
          Buffer.byteLength = originalByteLength;
        }
        // Keep precondition/assertion failures outside fake evaluate(), where
        // they would otherwise be normalized into terminal-rpc failures.
        assert.equal(measured.length, 2);
        const initial = JSON.parse(measured[0]) as Report;
        assert.equal(initial.status, 'complete');
        assert.equal(initial.terminal?.records.length, 4);
        assert.ok(originalByteLength(measured[0], 'utf8') < contract.caps.bytes);
        assert.equal(JSON.parse(measured[1]).terminal, null);
        assert.ok(originalByteLength(measured[1], 'utf8') <= contract.caps.bytes);
        const report = await f.report();
        assert.equal(report.status, 'incomplete');
        assert.equal(report.terminal, null);
        assert.deepEqual(report.node.faults, ['size']);
        assert.equal(report.caps.bytes, 16384);
        assert.equal(f.calls.length, 2);
        assert.equal(process.exitCode, 1);
        assert.equal(messages.length, 1);
        assertPrivateFree(JSON.stringify(messages));
      });
    });

    await t.test('a terminal RPC failure still persists fixed-code incomplete evidence', async t => {
      const f = await collectorFixture(t, { stop: () => { throw new Error('private-terminal-rpc'); } });
      await withFailureSignals(async messages => {
        await f.collector.begin(f.page);
        await assert.doesNotReject(() => f.collector.finish(f.page, f.reportPath, 'passed'));
        assert.deepEqual((await f.report()).node.faults, ['terminal-rpc', 'incomplete']);
        assert.equal(process.exitCode, 1);
        assert.equal(messages.length, 1);
        assertPrivateFree(JSON.stringify(messages));
      });
    });

    for (const throwing of ['version-getter', 'start-getter', 'ack-getter', 'start-side-effect'] as const) {
      await t.test(`${throwing} retains the original document capsule without retaining raw errors`, async t => {
        let effects = 0;
        const fail = () => { throw new Error('private-browser-getter'); };
        const f = await collectorFixture(t, {
          hookDescriptors: throwing === 'version-getter' ? { version: { get: fail } }
            : throwing === 'start-getter' ? { start: { get: fail } } : undefined,
          start: owner => {
            effects++;
            if (throwing === 'start-side-effect') throw new Error('private-start-after-activation');
            return Object.defineProperty({ owner, sessionId: 1 }, 'version', { enumerable: true, get: fail });
          },
        });
        await withFailureSignals(async () => {
          await f.collector.begin(f.page);
          assert.ok(f.capsule());
          await f.collector.finish(f.page, f.reportPath, 'passed');
          const report = await f.report();
          assert.equal(report.rpc.begin, 'handle-received');
          assert.equal(report.terminalRpcAttempted, true);
          assert.equal(report.started, false);
          assert.equal(report.status, 'incomplete');
          assert.equal(f.calls.length, 2);
          assert.equal(f.counts().disposals, 1);
          assert.equal(effects, throwing.endsWith('getter') && throwing !== 'ack-getter' ? 0 : 1);
          assert.equal(f.counts().stops, throwing === 'version-getter' ? 0 : 1);
          if (throwing !== 'version-getter') assert.deepEqual(report.node.faults, ['start-schema', 'incomplete']);
        });
      });
    }

    await t.test('duplicate finalization during persistence and after completion shares immutable evidence', async t => {
      const f = await collectorFixture(t);
      await withFailureSignals(async messages => {
        await f.collector.begin(f.page);
        const originalStringify = JSON.stringify;
        let finish!: Promise<void>, duringWrite!: Promise<void>, serializations = 0;
        try {
          // Schedule the duplicate after serialization, while mkdir/write are
          // pending. No filesystem patching or global fake timers are needed.
          JSON.stringify = ((value: unknown, ...args: unknown[]) => {
            if (value && typeof value === 'object' && 'scope' in value && value.scope === 'final-clone-to-outer-finally') {
              serializations++;
              queueMicrotask(() => { duringWrite = f.collector.finish(f.page, f.reportPath, 'failed'); });
            }
            return Reflect.apply(originalStringify, JSON, [value, ...args]);
          }) as typeof JSON.stringify;
          finish = f.collector.finish(f.page, f.reportPath, 'passed');
          await finish;
        } finally { JSON.stringify = originalStringify; }
        assert.strictEqual(duringWrite, finish);
        assert.strictEqual(f.collector.finish(f.page, f.reportPath, 'failed'), finish);
        const original = await readFile(f.reportPath, 'utf8');
        const report = await f.report();
        assert.equal(report.outcome, 'passed');
        assert.equal(report.status, 'complete');
        assert.deepEqual(report.node.faults, []);
        assert.equal(serializations, 1);
        assert.equal(process.exitCode, undefined);
        assert.deepEqual(messages, []);
        assert.equal(await readFile(f.reportPath, 'utf8'), original);
        assert.deepEqual(f.counts(), { starts: 1, stops: 1, disposals: 1 });
      });
    });

    for (const delivery of ['sync-throw', 'reject', 'deadline-handle', 'deadline-reject'] as const) {
      await t.test(`begin ${delivery}: bounded wait, no fallback and no late evidence adoption`, async t => {
        const pending = deferred<Handle>();
        const f = await collectorFixture(t, { beginRpc: () => {
          if (delivery === 'sync-throw') throw new Error('private-sync');
          if (delivery === 'reject') return Promise.reject(new Error('private-reject'));
          return pending.promise;
        } });
        await withFailureSignals(async () => {
          const begin = f.collector.begin(f.page);
          if (delivery.startsWith('deadline')) {
            await f.time.advance(2999);
            assert.equal(f.time.pending(), 1);
            await f.time.advance(1);
          }
          await begin;
          // Late arrival even BEFORE finalization is quarantined, not adopted.
          if (delivery === 'deadline-handle') pending.resolve(f.handle);
          if (delivery === 'deadline-reject') pending.reject(new Error('private-late'));
          await flushMicrotasks();
          await f.collector.finish(f.page, f.reportPath, 'passed');
          const report = await f.report();
          assert.equal(report.started, false);
          assert.equal(report.status, 'incomplete');
          assert.equal(report.terminalRpcAttempted, false);
          assert.equal(report.rpc.begin, delivery.startsWith('deadline') ? 'deadline' : 'rejected');
          assert.equal(report.rpc.terminal, 'not-dispatched');
          assert.equal(report.rpc.binding, 'unavailable');
          assert.deepEqual(report.node.faults, [delivery.startsWith('deadline') ? 'start-deadline' : 'start-rpc', 'incomplete']);
          assert.equal(f.calls.length, 1);
          assert.equal(f.counts().stops, 0);
          assert.equal(f.counts().disposals, delivery === 'deadline-handle' ? 1 : 0);
          assert.equal(f.time.pending(), 0);
        });
      });
    }

    await t.test('timely settlement just before each deadline clears timers without an extra ack RPC', async t => {
      const beginReply = deferred<Handle>(), terminalReply = deferred<unknown>();
      let remote!: () => unknown;
      const f = await collectorFixture(t, {
        beginRpc: () => beginReply.promise,
        terminalRpc: run => { remote = run; return terminalReply.promise; },
      });
      await withFailureSignals(async messages => {
        const begin = f.collector.begin(f.page);
        await f.time.advance(2999);
        beginReply.resolve(f.handle);
        await begin;
        assert.equal(f.time.pending(), 0);
        assert.equal(f.calls.length, 1, 'No getProperty/jsonValue/ack RPC may be issued');
        const finish = f.collector.finish(f.page, f.reportPath, 'passed');
        await flushMicrotasks();
        await f.time.advance(2999);
        terminalReply.resolve(remote());
        await finish;
        await f.time.advance(3000);
        assert.equal((await f.report()).status, 'complete');
        assert.equal(f.time.pending(), 0);
        assert.deepEqual(f.counts(), { starts: 1, stops: 1, disposals: 1 });
        assert.deepEqual(messages, []);
      });
    });

    await t.test('never-settled terminal requires only its fixed deadline', async t => {
      const f = await collectorFixture(t, { terminalRpc: () => new Promise(() => {}) });
      await withFailureSignals(async () => {
        await f.collector.begin(f.page);
        const finish = f.collector.finish(f.page, f.reportPath, 'passed');
        await flushMicrotasks();
        await f.time.advance(3000);
        await finish;
        assert.deepEqual((await f.report()).node.faults, ['terminal-deadline', 'incomplete']);
        assert.equal(f.time.pending(), 0);
        assert.equal(f.counts().disposals, 1);
      });
    });

    await t.test('never-settled begin can finalize; handle arriving after export only disposes once', async t => {
      const pending = deferred<Handle>();
      const disposal = deferred<void>();
      const f = await collectorFixture(t, { beginRpc: () => pending.promise, dispose: () => disposal.promise });
      await withFailureSignals(async messages => {
        const begin = f.collector.begin(f.page);
        const finish = f.collector.finish(f.page, f.reportPath, 'failed');
        await f.time.advance(3000);
        await begin; await finish;
        const original = await readFile(f.reportPath, 'utf8');
        pending.resolve(f.handle);
        await flushMicrotasks();
        assert.equal(f.counts().disposals, 1);
        assert.equal(f.counts().stops, 0);
        await f.time.advance(3000); // Disposal never settles; its deadline is independent.
        disposal.reject(new Error('private-late-dispose'));
        await flushMicrotasks();
        assert.equal(await readFile(f.reportPath, 'utf8'), original);
        assert.equal(f.time.pending(), 0);
        assert.equal(messages.length, 1);
      });
    });

    for (const late of ['snapshot', 'reject'] as const) {
      await t.test(`terminal deadline with late ${late} never cancels, upgrades or rewrites evidence`, async t => {
        const pending = deferred<unknown>();
        let remote!: () => unknown;
        const f = await collectorFixture(t, { terminalRpc: run => { remote = run; return pending.promise; } });
        await withFailureSignals(async messages => {
          await f.collector.begin(f.page);
          const finish = f.collector.finish(f.page, f.reportPath, 'passed');
          await flushMicrotasks();
          await f.time.advance(2999);
          assert.equal(f.counts().disposals, 0);
          await f.time.advance(1);
          await finish;
          const report = await f.report();
          const original = await readFile(f.reportPath, 'utf8');
          assert.equal(report.started, false, 'A handle alone is not ack evidence');
          assert.equal(report.capture, 'start-unknown');
          assert.equal(report.status, 'incomplete');
          assert.equal(report.terminal, null);
          assert.equal(report.terminalRpcAttempted, true);
          assert.deepEqual(report.rpc, { deadlineMs: 3000, begin: 'handle-received', terminal: 'deadline', binding: 'unverified' });
          assert.deepEqual(report.node.faults, ['terminal-deadline', 'incomplete']);
          assert.equal(f.counts().stops, 0);
          if (late === 'snapshot') pending.resolve(remote());
          else pending.reject(new Error('private-late-terminal'));
          await flushMicrotasks();
          assert.equal(f.counts().stops, late === 'snapshot' ? 1 : 0, 'Timeout does not cancel remote execution');
          assert.equal(await readFile(f.reportPath, 'utf8'), original);
          assert.equal(f.counts().disposals, 1);
          assert.equal(f.calls.length, 2);
          assert.equal(f.time.pending(), 0);
          assert.equal(messages.length, 1);
        });
      });
    }

    await t.test('document mismatch is rejected before even inspecting the new realm hook', async t => {
      const f = await collectorFixture(t);
      await withFailureSignals(async () => {
        await f.collector.begin(f.page);
        // Identical URL/timeOrigin and owner/session metadata cannot prove identity.
        f.sandbox.document = {};
        let hookTouches = 0;
        const guardedObject = Object.create(Object) as typeof Object;
        guardedObject.getOwnPropertyDescriptor = () => { hookTouches++; throw new Error('private-new-realm-hook'); };
        f.sandbox.Object = guardedObject;
        await f.collector.finish(f.page, f.reportPath, 'failed');
        const report = await f.report();
        assert.equal(report.rpc.binding, 'mismatch');
        assert.equal(report.started, false);
        assert.equal(report.terminal, null);
        assert.equal(report.status, 'incomplete');
        assert.deepEqual(report.node.faults, ['document', 'incomplete']);
        assert.equal(hookTouches, 0);
        assert.equal(f.counts().stops, 0);
      });
    });

    await t.test('destroyed original context rejects without using the replacement page', async t => {
      const f = await collectorFixture(t, { terminalRpc: () => Promise.reject(new Error('private-context-destroyed')) });
      let replacementTouches = 0;
      const replacement: Page = { evaluateHandle() { replacementTouches++; throw new Error('private-replacement'); } };
      await withFailureSignals(async () => {
        await f.collector.begin(f.page);
        await f.collector.finish(replacement, f.reportPath, 'failed');
        assert.equal((await f.report()).rpc.binding, 'unverified');
        assert.equal(replacementTouches, 0);
        assert.equal(f.counts().stops, 0);
        assert.equal(f.calls.length, 2);
      });
    });

    for (const disposal of ['throw', 'reject', 'never'] as const) {
      await t.test(`best-effort disposal ${disposal} cannot delay finish or alter evidence`, async t => {
        const f = await collectorFixture(t, { dispose: () => {
          if (disposal === 'throw') throw new Error('private-dispose');
          if (disposal === 'reject') return Promise.reject(new Error('private-dispose'));
          return new Promise(() => {});
        } });
        await withFailureSignals(async messages => {
          await f.collector.begin(f.page);
          await f.collector.finish(f.page, f.reportPath, 'passed');
          assert.equal((await f.report()).status, 'complete');
          assert.equal(f.counts().disposals, 1);
          await f.time.advance(3000);
          assert.equal(f.time.pending(), 0);
          assert.equal(process.exitCode, undefined);
          assert.deepEqual(messages, []);
        });
      });
    }

    for (const corrupt of [
      (value: Record<string, unknown>) => ({ ...value, privatePayload: 'private-envelope' }),
      (value: Record<string, unknown>) => ({ ...value, ackValid: 1 }),
      (value: Record<string, unknown>) => ({ ...value, binding: 'private-binding' }),
      (value: Record<string, unknown>) => ({ ...value, binding: 'mismatch' }),
      (value: Record<string, unknown>) => ({ ...value, version: 2 }),
    ]) {
      await t.test('closed envelope rejects unknown fields, types and contradictory binding', async t => {
        const f = await collectorFixture(t, { envelope: corrupt });
        await withFailureSignals(async () => {
          await f.collector.begin(f.page);
          await f.collector.finish(f.page, f.reportPath, 'passed');
          const report = await f.report();
          assert.equal(report.started, false);
          assert.equal(report.terminal, null);
          assert.equal(report.rpc.binding, 'unverified');
          assert.deepEqual(report.node.faults, ['terminal-schema', 'incomplete']);
        });
      });
    }

    await t.test('concurrent duplicate methods dispatch once and never write a second artifact', async t => {
      const pending = deferred<Handle>();
      const f = await collectorFixture(t, { beginRpc: () => pending.promise });
      await withFailureSignals(async () => {
        const begin = f.collector.begin(f.page);
        await f.collector.begin(f.page);
        const finish = f.collector.finish(f.page, f.reportPath, 'passed');
        const duplicate = f.collector.finish(f.page, f.reportPath, 'passed');
        assert.strictEqual(duplicate, finish);
        pending.resolve(f.handle);
        await begin; await finish;
        const original = await readFile(f.reportPath, 'utf8');
        assert.equal((await f.report()).status, 'incomplete');
        assert.deepEqual(f.counts(), { starts: 1, stops: 1, disposals: 1 });
        await f.collector.begin(f.page);
        await f.collector.finish(f.page, f.reportPath, 'passed');
        assert.equal(await readFile(f.reportPath, 'utf8'), original);
        assert.equal(f.calls.length, 2);
        assert.equal(f.time.pending(), 0);
      });
    });

    for (const failure of ['begin-deadline', 'terminal-deadline', 'identity'] as const) {
      await t.test(`${failure} preserves the original propagated primary exception`, async t => {
        const f = await collectorFixture(t, {
          beginRpc: failure === 'begin-deadline' ? () => new Promise(() => {}) : undefined,
          terminalRpc: failure === 'terminal-deadline' ? () => new Promise(() => {}) : undefined,
        });
        const primary = new Error('private-primary');
        await withFailureSignals(async () => {
          const begin = f.collector.begin(f.page);
          if (failure === 'begin-deadline') await f.time.advance(3000);
          await begin;
          if (failure === 'identity') f.sandbox.document = {};
          const operation = (async () => {
            try { throw primary; }
            finally {
              const finish = f.collector.finish(f.page, f.reportPath, 'failed');
              await flushMicrotasks();
              if (failure === 'terminal-deadline') await f.time.advance(3000);
              await finish;
            }
          })();
          await assert.rejects(operation, error => error === primary);
          assert.equal((await f.report()).status, 'incomplete');
          assert.equal(process.exitCode, 1);
        });
      });
    }

    await t.test('late EISDIR write failure is nonthrowing, signals failure and cannot replace a primary error', async t => {
      const f = await collectorFixture(t, { directoryPath: true });
      const primary = new Error('private-original-operation');
      await withFailureSignals(async messages => {
        await f.collector.begin(f.page);
        const caught: unknown[] = [];
        try {
          throw primary;
        } catch (error) {
          caught.push(error);
        } finally {
          await assert.doesNotReject(() => f.collector.finish(f.page, f.reportPath, 'failed'));
        }
        assert.strictEqual(caught[0], primary);
        assert.equal(caught.length, 1);
        assert.equal(process.exitCode, 1);
        assert.equal(messages.length, 1);
        assertPrivateFree(JSON.stringify(messages));
        await rm(f.reportPath, { recursive: true });
        await f.collector.finish(f.page, f.reportPath, 'failed');
        await assert.rejects(() => readFile(f.reportPath), { code: 'ENOENT' });
        assert.equal(f.calls.length, 2, 'A failed persistence attempt cannot retry terminal capture');
      });
    });
  });
