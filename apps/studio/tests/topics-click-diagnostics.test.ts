import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// @ts-expect-error -- Test-only ESM has no declaration under the strict no-allowJs test config.
import * as topicsESM from './browser/topics-click-diagnostics.mjs';

type Seam = { mark: (value: string) => void; afterClick: () => Promise<void> };
// Numeric envelopes are deliberately mutable/damageable fixtures in these tests.
type Capsule = { afterClick: () => any[]; cleanup: () => any[] };
type Handle = { evaluate: (callback: (capsule: Capsule) => unknown) => Promise<unknown>; dispose: () => Promise<unknown> };
type Operation = (seam: Seam) => unknown;
interface TopicsTestExports {
  createTopicsBrowserCapsule: (env?: { currentDocument: () => unknown }) => Capsule;
  projectTopicsEnvelope: (kind: string, input: unknown) => any[] | null;
  encodeTopicsRoot: (input: unknown) => string | null;
  createTopicsDiagnosticRun: (deps: {
    clock: { set: (callback: () => void, ms: number) => number; clear: (id: number) => void };
    write: (path: string, text: string) => Promise<unknown>;
    receipt: (value: number[]) => void;
  }) => (input: { page: { evaluateHandle: (factory: unknown) => Promise<Handle> }; output: string; operation: Operation }) => Promise<void>;
}
const { createTopicsBrowserCapsule, projectTopicsEnvelope, encodeTopicsRoot, createTopicsDiagnosticRun } = topicsESM as TopicsTestExports;

const kinds = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'focusin'];
const clone = <T>(value: T): T => structuredClone(value);
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (value?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function result(promise: Promise<unknown>) {
  try { await promise; return { failed: false, value: undefined as unknown }; }
  catch (value) { return { failed: true, value }; }
}
function realm(options: { add?: number; remove?: number; thrown?: unknown } = {}) {
  const callbacks = new Map<string, (event: any) => void>();
  const active = new Set<string>();
  const adds: string[] = [], removes: string[] = [];
  let comparisons = 0, current: unknown, bindingThrow = false, bindingValue: unknown;
  const document = {
    addEventListener(type: string, callback: (event: any) => void, config: any) {
      assert.deepEqual(config, { capture: true, passive: true });
      adds.push(type); callbacks.set(type, callback); active.add(type);
      // Side effect first: even the throwing registration needs one removal.
      if (adds.length === options.add) throw options.thrown;
    },
    removeEventListener(type: string, callback: (event: any) => void, capture: boolean) {
      assert.equal(callback, callbacks.get(type)); assert.equal(capture, true);
      removes.push(type); active.delete(type);
      if (kinds.indexOf(type) + 1 === options.remove) throw options.thrown;
    },
  };
  current = document;
  const env = { currentDocument: () => {
    comparisons++;
    if (bindingThrow) throw bindingValue;
    return current;
  } };
  const capsule = createTopicsBrowserCapsule(env);
  return { capsule, document, active, adds, removes, callbacks,
    comparisons: () => comparisons,
    binding: (next: unknown) => { bindingThrow = false; current = next; },
    throwBinding: (value: unknown) => { bindingThrow = true; bindingValue = value; },
    emit: (kind = 'click', event: any = { isTrusted: true }) => callbacks.get(kind)?.(event),
  };
}
// This builds protocol fixtures, not a second Browser collector.
function rootFromACK(ack: any, cleanup = ack[2]) {
  const m = cleanup, captured = ack[2], h = Array(24).fill(0);
  h[0] = 3; h[1] = 1; h[2] = 1; h[3] = m[5] ? 1 : 2;
  h[4] = h[5] = h[6] = h[8] = h[9] = h[10] = h[13] = h[21] = 1;
  h[7] = m[1]; h[11] = h[12] = 3;
  h[14] = captured[3]; h[15] = ack[3].length; h[16] = captured[4]; h[17] = m[5];
  h[19] = m[6]; h[20] = m[7].includes(2) ? 2 : 1; h[22] = m[2]; h[23] = m[0];
  return [h, clone(ack[3]), clone(m[7])];
}
class FakeClock {
  next = 0;
  timers = new Map<number, () => void>();
  delays: number[] = [];
  clearHook?: (id: number) => void;
  set = (callback: () => void, ms: number) => {
    this.delays.push(ms); const id = ++this.next; this.timers.set(id, callback); return id;
  };
  clear = (id: number) => { this.timers.delete(id); this.clearHook?.(id); };
  fire() {
    const entry = this.timers.entries().next().value; assert.ok(entry);
    this.timers.delete(entry[0]); entry[1]();
  }
}
function harness(options: { hold?: string; reject?: string; corrupt?: string; receiptThrow?: boolean;
  map?: (slot: string, value: any) => any } = {}) {
  // Realm exists before fake install; factory identity is not a serialization test.
  const r = realm(), clock = new FakeClock(), waiting = deferred();
  const calls: string[] = [], writes: string[] = [], receipts: number[][] = [];
  const held = new Map<string, { promise: Promise<any>; resolve: (value?: any) => void; reject: (value?: unknown) => void }>();
  async function perform(slot: string, action: () => any) {
    calls.push(slot);
    if (options.reject === slot) throw undefined;
    let value = action();
    if (options.corrupt === slot) value = [999];
    if (options.map) value = options.map(slot, value);
    if (options.hold === slot) {
      held.set(slot, { promise: waiting.promise, resolve: () => waiting.resolve(value), reject: waiting.reject });
      return waiting.promise;
    }
    return value;
  }
  const handle = {
    evaluate: (callback: (capsule: Capsule) => unknown) => {
      // Execute remotely first, then hold/reject its response; not every execution timing.
      // Invoke the actual literal callback. No source extraction or rewriting.
      let slot = 'cleanup';
      const capsule = {
        afterClick() { slot = 'ack'; return r.capsule.afterClick(); },
        cleanup() { return r.capsule.cleanup(); },
      };
      const value = callback(capsule);
      return perform(slot, () => clone(value));
    },
    dispose: () => perform('dispose', () => undefined),
  };
  const page = { evaluateHandle: (factory: unknown) => {
    assert.equal(factory, createTopicsBrowserCapsule);
    return perform('install', () => handle);
  } };
  const run = createTopicsDiagnosticRun({ clock,
    write: (path: string, text: string) => perform('write', () => {
      assert.ok(path.endsWith('topics-initial-click.json')); writes.push(text);
    }),
    receipt: (value: number[]) => { receipts.push(clone(value)); if (options.receiptThrow) throw Symbol('receipt'); },
  });
  return { ...r, clock, waiting, held, calls, writes, receipts, run, page, handle };
}
const operation = async ({ mark, afterClick }: Seam) => {
  mark('click-entry'); mark('click-return'); await afterClick(); mark('ready-entry'); mark('ready-return');
};
function invoke(h: ReturnType<typeof harness>, op: Operation = operation) {
  return result(h.run({ page: h.page, output: '.', operation: op }));
}

// Six finite groups. No group has been run locally; builtin patches are serial
// and restored with finally. They are tests of the real exports, not main.
test('1 / actual factory: six kinds, opaque events, terminal drop and 65/66 guards', () => {
  const r = realm(); let trustedReads = 0, forbidden = 0;
  for (const [index, kind] of kinds.entries()) {
    const event = Object.defineProperties({}, {
      isTrusted: { get() { trustedReads++; return index % 2 === 0; } },
      ...Object.fromEntries(['target', 'activeElement', 'clientX', 'clientY', 'timeStamp'].map(key =>
        [key, { get() { forbidden++; throw new Error('Forbidden read'); } }])),
    });
    r.emit(kind, event);
  }
  const ack = r.capsule.afterClick();
  assert.deepEqual(ack[3], kinds.map((_, i) => [i + 1, i + 1, Number(i % 2 === 0)]));
  assert.equal(trustedReads, 6); assert.equal(forbidden, 0);
  assert.ok(projectTopicsEnvelope('ack', ack));
  for (const thrown of [0, undefined, Symbol('external')]) {
    for (const source of ['trusted', 'binding']) {
      const f = realm();
      if (source === 'binding') f.throwBinding(thrown);
      f.emit('click', Object.defineProperty({}, 'isTrusted', { get() { throw thrown; } }));
      f.binding(f.document);
      const cleanup = f.capsule.cleanup();
      assert.ok(projectTopicsEnvelope('cleanup', cleanup));
      assert.equal(cleanup[2][3], 1); assert.equal(cleanup[2][4], 1);
      assert.equal(cleanup[2][2], source === 'binding' ? 4 : 3);
      assert.ok(cleanup[2][5] & (source === 'binding' ? 2 : 4));
      assert.equal(f.removes.length, 6);
    }
  }
  for (const trusted of [undefined, null, 0, 1, 'true', NaN, {}, Symbol('invalid')]) {
    const f = realm(); f.emit('click', { isTrusted: trusted });
    const a = f.capsule.afterClick(); assert.ok(projectTopicsEnvelope('ack', a));
    assert.deepEqual(a[2].slice(2, 6), [3, 1, 1, 4]); assert.deepEqual(a[3], []);
  }
  const full = realm();
  for (let i = 0; i < 64; i++) full.emit(kinds[i % 6]);
  const fullACK = full.capsule.afterClick();
  assert.equal(fullACK[3].length, 64); assert.equal(fullACK[2][4], 0);
  assert.ok(projectTopicsEnvelope('ack', fullACK));
  const fullText = encodeTopicsRoot(rootFromACK(fullACK));
  assert.ok(fullText); assert.ok(Buffer.byteLength(fullText, 'utf8') <= 2579);
  const quota = realm();
  for (let i = 0; i < 64; i++) quota.emit(kinds[i % 6]);
  const before = quota.comparisons();
  quota.throwBinding(Symbol('must not compare'));
  const unread = Object.defineProperty({}, 'isTrusted', { get() { throw new Error('65/66 read'); } });
  quota.emit('click', unread); quota.emit('click', unread);
  assert.equal(quota.comparisons(), before);
  quota.binding(quota.document);
  const boundary = quota.capsule.afterClick();
  assert.ok(projectTopicsEnvelope('ack', boundary));
  assert.equal(boundary[3].length, 64); assert.deepEqual(boundary[2].slice(2, 6), [2, 65, 1, 8]);
  const root = rootFromACK(boundary), encoded = encodeTopicsRoot(root);
  assert.ok(projectTopicsEnvelope('root', root)); assert.ok(encoded);
  assert.ok(encoded.endsWith('\n')); assert.ok(Buffer.byteLength(encoded, 'utf8') <= 2579);
  // Finite field-width proof, not a claim this one boundary is globally longest:
  // header <=24 ten-digit leaves+punctuation=265; <=64 event3 <=34 each
  // with separators=2242; release6 <=67; outer punctuation+LF=5.
  assert.equal(265 + 2242 + 67 + 5, 2579); assert.ok(2579 < 24576);
  const bad = clone(boundary); bad[3][0][0] = 2;
  assert.equal(projectTopicsEnvelope('ack', bad), null);
});

test('2 / every acquisition/removal, binding history veto, independent cached ACK', async () => {
  for (let position = 1; position <= 6; position++) {
    for (const thrown of [0, undefined, Symbol('add/remove')]) {
      const f = realm({ add: position, thrown });
      const cleanup = f.capsule.cleanup();
      assert.ok(projectTopicsEnvelope('cleanup', cleanup));
      assert.equal(cleanup[2][0], 0); assert.equal(cleanup[2][6], (1 << (position - 1)) - 1);
      assert.deepEqual(cleanup[2][7], kinds.map((_, i) => i < position ? 1 : 3));
      assert.deepEqual(f.capsule.afterClick(), [3, 1]);
      f.capsule.cleanup(); assert.equal(f.adds.length, position); assert.equal(f.removes.length, position);
      assert.equal(f.active.size, 0);
      const removed = realm({ remove: position, thrown });
      const ack = removed.capsule.afterClick(), saved = clone(ack);
      assert.ok(projectTopicsEnvelope('ack', ack)); assert.equal(ack[2][7][position - 1], 2);
      removed.capsule.cleanup(); removed.capsule.afterClick(); removed.capsule.cleanup();
      assert.equal(removed.removes.length, 6); assert.deepEqual(ack, saved);
      assert.equal(ack[2][5], 16);
    }
  }
  for (const failure of ['mismatch', 'throw']) {
    const f = realm();
    if (failure === 'mismatch') f.binding({}); else f.throwBinding(undefined);
    f.emit(); f.binding(f.document);
    assert.deepEqual(f.capsule.afterClick(), [3, 1]);
    const comparisons = f.comparisons();
    assert.deepEqual(f.capsule.afterClick(), [3, 1]); assert.equal(f.comparisons(), comparisons);
    const cleanup = f.capsule.cleanup();
    assert.equal(cleanup[2][1], 1); assert.equal(cleanup[2][2], 4);
    assert.ok(projectTopicsEnvelope('cleanup', cleanup));
  }
  const failedInstall = realm({ add: 1, thrown: 0 });
  const installed0 = harness({ map: (slot, value) => slot === 'ack' ? failedInstall.capsule.afterClick() :
    slot === 'cleanup' ? failedInstall.capsule.cleanup() : value });
  assert.equal((await invoke(installed0)).failed, true);
  const installed0Root = JSON.parse(installed0.writes[0]);
  assert.ok(projectTopicsEnvelope('root', installed0Root));
  assert.equal(installed0Root[0][23], 0); assert.equal(installed0Root[0][20], 1);
  const earlyCleanup = realm(); earlyCleanup.capsule.cleanup();
  assert.ok(projectTopicsEnvelope('ack', earlyCleanup.capsule.afterClick()));
  const f = realm(); f.emit();
  const ack = f.capsule.afterClick(), original = clone(ack);
  f.throwBinding(0); const cleanup = f.capsule.cleanup();
  assert.equal(cleanup[2][1], 0); assert.equal(cleanup[2][2], 1); assert.equal(cleanup[2][5], 2);
  assert.deepEqual(ack, original); assert.deepEqual(f.capsule.afterClick(), original);
  ack[2][7][0] = 3; ack[3][0][0] = 55;
  assert.deepEqual(f.capsule.afterClick(), original);
  const partial = rootFromACK(original, cleanup[2]);
  assert.ok(projectTopicsEnvelope('root', partial)); assert.equal(partial[0][3], 1);
  const bound = realm();
  const h = harness({ map: (slot, value) => {
    if (slot === 'ack') return bound.capsule.afterClick();
    if (slot === 'cleanup') { bound.throwBinding(0); return bound.capsule.cleanup(); }
    return value;
  } });
  const end = await invoke(h); assert.equal(end.failed, true);
  const archived = JSON.parse(h.writes[0]);
  assert.equal(archived[0][3], 1); assert.equal(archived[0][13], 1); assert.equal(archived[0][21], 1);
  assert.equal(archived[0][22], 1); assert.equal(archived[0][7], 0);
});

test('3 / closed own-data schema, exact meta versus unknown root, transition rejection', async () => {
  const f = realm(); f.emit(); const ack = f.capsule.afterClick(), cleanup = f.capsule.cleanup();
  const fixtures: [string, any, number[][]][] = [
    ['ack', ack, [[], [2], [2, 7], [3], [3, 0]]],
    ['cleanup', cleanup, [[], [2], [2, 7]]],
    ['root', rootFromACK(ack), [[], [0], [1], [1, 0], [2]]],
  ];
  let reads = 0;
  for (const [kind, original, paths] of fixtures) {
    assert.ok(projectTopicsEnvelope(kind, original));
    for (const path of paths) {
      for (const damage of ['hole', 'accessor', 'symbol', 'key', 'prototype', 'extra']) {
        const value = clone(original); let target = value;
        for (const i of path) target = target[i];
        if (damage === 'hole') delete target[0];
        if (damage === 'accessor') Object.defineProperty(target, '0', { get() { reads++; throw 0; } });
        if (damage === 'symbol') target[Symbol('extra')] = 1;
        if (damage === 'key') target.extra = 1;
        if (damage === 'prototype') Object.setPrototypeOf(target, null);
        if (damage === 'extra') target.push(0);
        assert.equal(projectTopicsEnvelope(kind, value), null, `${kind}/${path}/${damage}`);
      }
    }
  }
  assert.equal(reads, 0);
  const root = rootFromACK(ack);
  for (const [slot, values] of [[0, [2, 4]], [2, [0, 3]], [3, [0, 1, 3]], [6, [0, 2, 3]],
    [10, [0, 2]], [13, [0, 2]], [17, [1, 4, 8, 16, 32]], [18, [64, 128, 1024]],
    [19, [0, 62, 64]], [20, [0, 2, 3]], [21, [0, 2]], [22, [0, 2, 3, 4, 5, 6]], [23, [0, 2]]] as [number, number[]][]) {
    for (const value of values) {
      const bad = clone(root); bad[0][slot] = value;
      assert.equal(projectTopicsEnvelope('root', bad), null, `${slot}/${value}`);
    }
  }
  for (const value of [-0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = clone(root); bad[0][18] = value; assert.equal(encodeTopicsRoot(bad), null);
  }
  for (const mutate of [
    (a: any) => { a[2][3] = 2; a[2][4] = 1; a[3][0][0] = 2; },
    (a: any) => { a[2][5] = 8; },
    (a: any) => { a[2][4] = 1; },
    (a: any) => { a[2][7][0] = 2; },
    (a: any) => { a[2][5] = 2; },
    (a: any) => { a[2][2] = 0; },
  ]) { const bad = clone(ack); mutate(bad); assert.equal(projectTopicsEnvelope('ack', bad), null); }
  const unavailable = harness({ reject: 'install' });
  await invoke(unavailable); const unknown = JSON.parse(unavailable.writes[0]);
  assert.ok(projectTopicsEnvelope('root', unknown)); assert.deepEqual(unknown[2], [0, 0, 0, 0, 0, 0]);
  assert.equal(unknown[0][20], 0); assert.equal(unknown[0][23], 0);
  const quota = harness({ reject: 'ack' });
  await invoke(quota, async seam => {
    for (let i = 0; i < 65; i++) quota.emit();
    await operation(seam);
  });
  const lost = JSON.parse(quota.writes[0]);
  assert.ok(projectTopicsEnvelope('root', lost)); assert.equal(lost[0][13], 0);
  assert.deepEqual(lost[0].slice(14, 17), [0, 0, 0]); assert.equal(lost[0][17], 8); assert.equal(lost[0][22], 2);
  for (const mutate of [
    (m: any) => { m[3]++; }, (m: any) => { m[2] = 5; },
    (m: any) => { m[7][0] = 2; m[5] |= 16; },
  ]) {
    const h = harness({ map: (slot, value) => { if (slot === 'cleanup') mutate(value[2]); return value; } });
    assert.equal((await invoke(h)).failed, true);
    const archived = JSON.parse(h.writes[0]); assert.equal(archived[0][13], 1);
    assert.ok(archived[0][18] & 4); assert.equal(archived[2][0], 1);
  }
  const faulted = realm(); faulted.emit('click', { isTrusted: null });
  const stopped = faulted.capsule.afterClick();
  const clearing = harness({ map: (slot, value) => slot === 'ack' ? clone(stopped) : slot === 'cleanup' ? clone(cleanup) : value });
  assert.equal((await invoke(clearing)).failed, true);
  const kept = JSON.parse(clearing.writes[0]);
  assert.equal(kept[0][17], 4); assert.equal(kept[0][22], 3); assert.ok(kept[0][18] & 4);
  // Multi-field counterexamples lower evidence first, so rejection is not an evidence2 side effect.
  const cleanUnavailable = clone(root);
  for (const i of [3, 13, 14, 15, 16, 21]) cleanUnavailable[0][i] = 0;
  cleanUnavailable[0][6] = 2; cleanUnavailable[0][18] = 2; cleanUnavailable[1] = [];
  assert.equal(projectTopicsEnvelope('root', cleanUnavailable), null);
  const malformedClean = clone(cleanUnavailable); malformedClean[0][18] |= 4;
  assert.ok(projectTopicsEnvelope('root', malformedClean));
  const omittedACK = clone(cleanUnavailable); omittedACK[0][5] = omittedACK[0][6] = 0;
  assert.equal(projectTopicsEnvelope('root', omittedACK), null);
  omittedACK[0][18] |= 256; assert.ok(projectTopicsEnvelope('root', omittedACK));
  for (const [cleanupSlot, disposeSlot, mask, valid] of [
    [0, 0, 0, false], [0, 0, 16, false], [0, 0, 512, false], [0, 0, 8, true],
    [1, 0, 0, false], [1, 0, 16, false], [1, 0, 8, true], [0, 1, 8, false],
  ] as [number, number, number, boolean][]) {
    const mandatory = clone(root); mandatory[0][3] = 1;
    mandatory[0][8] = cleanupSlot; mandatory[0][9] = disposeSlot; mandatory[0][18] = mask;
    assert.equal(Boolean(projectTopicsEnvelope('root', mandatory)), valid, `mandatory/${cleanupSlot}/${disposeSlot}/${mask}`);
  }
  const conflicting = harness({ map: (slot, value) => slot === 'ack' ? [3, 1] : value });
  assert.equal((await invoke(conflicting)).failed, true);
  const rejectedMeta = JSON.parse(conflicting.writes[0]);
  assert.ok(projectTopicsEnvelope('root', rejectedMeta));
  assert.equal(rejectedMeta[0][6], 2); assert.equal(rejectedMeta[0][8], 1);
  assert.equal(rejectedMeta[0][18] & (2 | 4 | 8), 2 | 4 | 8);
  assert.equal(rejectedMeta[0][22], 0); assert.equal(rejectedMeta[0][23], 0);
  assert.equal(rejectedMeta[0][19], 0); assert.deepEqual(rejectedMeta[2], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(conflicting.calls, ['install', 'ack', 'cleanup', 'dispose', 'write']);
  const restored = realm(); restored.binding({}); restored.emit(); restored.binding(restored.document);
  const bindingUnavailable = harness({ map: (slot, value) => slot === 'ack' ? restored.capsule.afterClick() :
    slot === 'cleanup' ? restored.capsule.cleanup() : value });
  assert.equal((await invoke(bindingUnavailable)).failed, true);
  const restoredRoot = JSON.parse(bindingUnavailable.writes[0]);
  assert.ok(projectTopicsEnvelope('root', restoredRoot));
  assert.equal(restoredRoot[0][6], 2); assert.equal(restoredRoot[0][7], 1);
  assert.equal(restoredRoot[0][23], 1); assert.equal(restoredRoot[0][17], 2);
  assert.equal(restoredRoot[0][18], 2); assert.equal(restoredRoot[0][22], 4);
  const malformed = harness({ corrupt: 'ack' });
  assert.equal((await invoke(malformed)).failed, true);
  const malformedRoot = JSON.parse(malformed.writes[0]);
  assert.ok(projectTopicsEnvelope('root', malformedRoot));
  assert.equal(malformedRoot[0][6], 2); assert.equal(malformedRoot[0][23], 1);
  assert.equal(malformedRoot[0][17], 0); assert.equal(malformedRoot[0][18], 2 | 4);
  const discard = clone(root); discard[0][3] = discard[0][13] = discard[0][14] = discard[0][15] = discard[0][16] = 0; discard[1] = [];
  assert.equal(projectTopicsEnvelope('root', discard), null);
  discard[0][18] = 32; assert.ok(projectTopicsEnvelope('root', discard));
});

test('4 / one claim, one afterClick, phase prefix, type gate and read-only callsite inventory', async () => {
  const h = harness(); let count = 0, types = 0;
  const first = await invoke(h, async seam => { count++; await operation(seam); });
  if (!first.failed) types++;
  assert.equal(first.failed, false); assert.equal(count, 1); assert.equal(types, 1);
  assert.deepEqual(h.calls, ['install', 'ack', 'cleanup', 'dispose', 'write']);
  assert.equal(h.receipts.length, 0); assert.ok(h.clock.delays.every(ms => ms === 10000));
  const before = [...h.calls];
  assert.equal((await invoke(h, () => { count++; })).failed, true);
  assert.equal(count, 1); assert.deepEqual(h.calls, before);
  const concurrent = harness({ hold: 'install' }); let operations = 0;
  const pending = invoke(concurrent, async seam => { operations++; await operation(seam); });
  assert.equal((await invoke(concurrent, () => { operations++; })).failed, true);
  await flush(); concurrent.held.get('install')!.resolve(); await pending; assert.equal(operations, 1);
  const twice = harness();
  assert.equal((await invoke(twice, async ({ mark, afterClick }) => {
    mark('click-entry'); mark('click-return');
    await Promise.all([afterClick(), afterClick()]); mark('ready-entry'); mark('ready-return');
  })).failed, true);
  assert.equal(twice.calls.filter(x => x === 'ack').length, 1);
  const heldACK = harness({ hold: 'ack' }); let heldOperations = 0;
  const heldRun = invoke(heldACK, async ({ mark, afterClick }) => {
    heldOperations++; mark('click-entry'); mark('click-return');
    const ack = afterClick(); await flush();
    assert.ok(heldACK.held.has('ack'));
    mark('ready-entry'); mark('ready-return');
    heldACK.held.get('ack')!.resolve(); await ack;
    // Even a later valid prefix cannot wash away the pending-ACK phase fault.
    mark('ready-entry'); mark('ready-return');
  });
  assert.equal((await heldRun).failed, true); assert.equal(heldOperations, 1);
  const heldRoot = JSON.parse(heldACK.writes[0]);
  assert.equal(heldRoot[0][3], 1); assert.equal(heldRoot[0][6], 1);
  assert.equal(heldRoot[0][11], 3); assert.equal(heldRoot[0][12], 3); assert.ok(heldRoot[0][18] & 256);
  assert.deepEqual(heldACK.calls, ['install', 'ack', 'cleanup', 'dispose', 'write']);
  assert.equal(heldACK.receipts.length, 1);

  const remote = realm(); remote.emit(); const disposeGate = deferred(), releaseReached = deferred();
  const abandoned = harness({ hold: 'ack', map: (slot, value) => {
    if (slot === 'ack') return remote.capsule.afterClick();
    if (slot === 'cleanup') { remote.throwBinding(0); return remote.capsule.cleanup(); }
    if (slot === 'dispose') { releaseReached.resolve(undefined); return disposeGate.promise; }
    return value;
  } });
  let abandonedACK: Promise<void> | undefined, abandonedOperations = 0;
  const abandonedRun = invoke(abandoned, async ({ mark, afterClick }) => {
    abandonedOperations++; mark('click-entry'); mark('click-return');
    abandonedACK = afterClick(); await flush(); // Response remains pending at operation end.
  });
  await releaseReached.promise; assert.deepEqual(abandoned.calls, ['install', 'ack', 'cleanup', 'dispose']);
  assert.equal(abandoned.writes.length, 0);
  abandoned.held.get('ack')!.resolve(); await abandonedACK; await flush();
  disposeGate.resolve(undefined);
  assert.equal((await abandonedRun).failed, true); assert.equal(abandonedOperations, 1);
  const abandonedRoot = JSON.parse(abandoned.writes[0]);
  assert.ok(projectTopicsEnvelope('root', abandonedRoot));
  assert.equal(abandonedRoot[0][3], 0); assert.equal(abandonedRoot[0][5], 0); assert.equal(abandonedRoot[0][6], 0);
  assert.equal(abandonedRoot[0][13], 0); assert.equal(abandonedRoot[0][21], 0);
  assert.deepEqual(abandonedRoot[0].slice(14, 17), [0, 0, 0]); assert.deepEqual(abandonedRoot[1], []);
  assert.equal(abandonedRoot[0][7], 0); assert.equal(abandonedRoot[0][17], 2); assert.equal(abandonedRoot[0][22], 1);
  assert.equal(abandonedRoot[0][23], 1); assert.equal(abandonedRoot[0][19], 63);
  assert.deepEqual(abandonedRoot[2], [1, 1, 1, 1, 1, 1]); assert.ok(abandonedRoot[0][18] & 256);
  assert.deepEqual(abandoned.calls, ['install', 'ack', 'cleanup', 'dispose', 'write']);
  assert.equal(abandoned.receipts.length, 1);
  for (const op of [
    async ({ mark, afterClick }: any) => { mark('ready-entry'); await operation({ mark, afterClick }); },
    async ({ mark }: any) => { mark('click-entry'); mark('click-return'); mark('ready-entry'); mark('ready-return'); },
  ]) {
    const bad = harness(); let type = 0;
    const end = await invoke(bad, op); if (!end.failed) type++;
    assert.equal(type, 0); assert.equal(end.failed, true);
    assert.equal(bad.calls.includes('finish'), false);
  }
  const runner = await readFile(new URL('./browser/form-audit.mjs', import.meta.url), 'utf8');
  assert.equal((runner.match(/createTopicsDiagnosticRun\(\)/g) ?? []).length, 1);
  assert.equal((runner.match(/await topicsClickDiagnostics\(/g) ?? []).length, 1);
  const select = runner.slice(runner.indexOf("add('select-topics'"), runner.indexOf("add('create-topic-inline'"));
  assert.equal(select.includes('topicsClickDiagnostics'), false);
  const inline = runner.slice(runner.indexOf("add('create-topic-inline'"), runner.indexOf('for (const external'));
  const ordered = ["await threads();", "mark('click-entry');", 'await page.click(\'.thread-composer button[name="extra.topics"]\');',
    "mark('click-return');", 'await afterClick();', "mark('ready-entry');", "await ready('dialog[open]');",
    "mark('ready-return');", 'await page.type(\'dialog[open] input[type=search]\',\'审计新话题\');'];
  let previous = -1;
  for (const literal of ordered) { const at = inline.indexOf(literal); assert.ok(at > previous); previous = at; }
  assert.equal((inline.match(/await page\.click\(/g) ?? []).length, 1);
  assert.equal((inline.match(/await page\.type\(/g) ?? []).length, 1);
  assert.ok(runner.includes('const ready = async selector => { await page.waitForSelector(selector, {visible:true}); await page.waitForFunction(() => !document.querySelector(\'[aria-busy="true"]\')); await shellSettled(); };'));
  assert.ok(runner.includes('sizes: AUDIT_SIZES, shard: {index:shardIndex,count:shardCount}'));
  const helper = await readFile(new URL('./browser/topics-click-diagnostics.mjs', import.meta.url), 'utf8');
  assert.ok(helper.includes('page.evaluateHandle(createTopicsBrowserCapsule)'));
  assert.equal(helper.includes('capsule.finish'), false);
  for (const absent of ['MutationObserver', 'createTreeWalker', 'elementFromPoint', 'activeElement', 'event.target']) assert.equal(helper.includes(absent), false);
});

test('5 / five slot timeouts and late resolve/reject; late release timer faults at all three phases', async () => {
  for (const slot of ['install', 'ack', 'cleanup', 'dispose', 'write']) {
    for (const late of ['resolve', 'reject']) {
      const h = harness({ hold: slot }); let count = 0;
      const pending = invoke(h, async seam => { count++; await operation(seam); });
      await flush(); assert.ok(h.held.has(slot)); h.clock.fire();
      const end = await pending; assert.equal(end.failed, true);
      const text = [...h.writes], receipts = clone(h.receipts);
      h.held.get(slot)![late === 'resolve' ? 'resolve' : 'reject'](Symbol('late')); await flush();
      assert.deepEqual(h.writes, text); assert.deepEqual(h.receipts, receipts); assert.equal(count, 1);
      assert.ok(h.calls.filter(x => x === 'cleanup').length <= 1);
      assert.ok(h.calls.filter(x => x === 'dispose').length <= 1);
      assert.ok(h.calls.filter(x => x === 'write').length <= 1);
      assert.ok(h.clock.delays.every(ms => ms === 10000));
      if (slot === 'ack') assert.equal(JSON.parse(h.writes[0])[0][13], 0);
    }
  }
  for (const when of ['before-seal', 'during-write', 'after-return']) {
    const observations: any[] = [];
    for (const throwClear of [false, true]) {
      const opGate = deferred(), writeGate = deferred();
      const h = harness({ hold: 'install', map: (slot, value) => slot === 'write' && when === 'during-write' ? writeGate.promise : value });
      let count = 0;
      const pending = invoke(h, async seam => { count++; await operation(seam); if (when === 'before-seal') await opGate.promise; });
      await flush(); h.clock.fire(); await flush();
      if (when === 'after-return') await pending;
      if (when === 'during-write') assert.equal(h.writes.length, 1);
      h.clock.clearHook = () => { if (throwClear) throw 0; };
      h.held.get('install')!.resolve(); await flush();
      // A write timer in flight belongs to timely delivery, not late release.
      h.clock.clearHook = undefined;
      opGate.resolve(undefined); writeGate.resolve(undefined);
      const end = await pending; await flush();
      assert.equal(end.failed, true); assert.equal((end.value as Error).message, 'Topics diagnostic unavailable');
      assert.equal(count, 1); assert.equal(h.calls.filter(x => x === 'cleanup').length, 1);
      assert.equal(h.calls.filter(x => x === 'dispose').length, 1);
      observations.push([h.writes, h.receipts, h.calls, end.failed, (end.value as Error).message]);
    }
    assert.deepEqual(observations[0], observations[1]);
  }
  const timely = harness(); timely.clock.clearHook = () => { throw undefined; };
  assert.equal((await invoke(timely)).failed, true);
  assert.ok(JSON.parse(timely.writes[0])[0][18] & 512);
  const setFailure = harness();
  setFailure.clock.set = () => { throw 0; };
  assert.equal((await invoke(setFailure)).failed, true);
  assert.equal(setFailure.writes.length, 1); assert.equal(setFailure.receipts.length, 1);
  assert.ok(JSON.parse(setFailure.writes[0])[0][18] & 512);
});

test('6 / finite primary failures, schema/encode fallback, two-encode limit and optional freeze', { concurrency: false }, async () => {
  for (const original of [undefined, null, 0, false, 'primary', Symbol('primary'), Object.freeze({})]) {
    const noACK = harness({ reject: 'cleanup', receiptThrow: true });
    const early = await invoke(noACK, () => { throw original; });
    assert.equal(early.failed, true); assert.equal(early.value, original);
    assert.equal(noACK.calls.includes('ack'), false); assert.equal(noACK.calls.includes('finish'), false);
    assert.equal(noACK.calls.filter(x => x === 'dispose').length, 1);
    for (const slot of ['install', 'ack', 'cleanup', 'dispose', 'write', 'receipt']) {
      const h = harness({ reject: slot === 'receipt' ? undefined : slot, receiptThrow: slot === 'receipt' }); let count = 0;
      const end = await invoke(h, async ({ mark, afterClick }) => {
        count++; mark('click-entry'); mark('click-return'); await afterClick(); mark('ready-entry'); throw original;
      });
      assert.equal(end.failed, true); assert.equal(end.value, original); assert.equal(count, 1);
      assert.ok(h.writes.length <= 1); assert.equal(h.receipts.length, 1);
      assert.deepEqual(h.receipts[0].slice(0, 3), [3, 1, 1]);
    }
  }
  for (const slot of ['ack', 'cleanup']) {
    const h = harness({ corrupt: slot }); assert.equal((await invoke(h)).failed, true);
    const root = JSON.parse(h.writes[0]); assert.ok(projectTopicsEnvelope('root', root)); assert.ok(root[0][18] & 4);
  }
  const stringify = JSON.stringify, byteLength = Buffer.byteLength, freeze = Object.freeze;
  for (const mode of ['first-encode', 'both-encode', 'first-byte', 'both-byte', 'malformed-first-encode', 'oversize', 'freeze']) {
    const h = harness({ corrupt: mode === 'malformed-first-encode' ? 'ack' : undefined }); let encodes = 0, count = 0;
    try {
      if (mode === 'first-encode' || mode === 'both-encode' || mode === 'malformed-first-encode') JSON.stringify = ((...args: any[]) => {
        encodes++; if (mode === 'both-encode' || encodes === 1) throw undefined;
        return Reflect.apply(stringify, JSON, args);
      }) as typeof JSON.stringify;
      if (mode === 'first-byte' || mode === 'both-byte') Buffer.byteLength = ((...args: any[]) => {
        encodes++; if (mode === 'both-byte' || encodes === 1) throw 0;
        return Reflect.apply(byteLength, Buffer, args);
      }) as typeof Buffer.byteLength;
      if (mode === 'oversize') Buffer.byteLength = (() => { encodes++; return 24577; }) as typeof Buffer.byteLength;
      if (mode === 'freeze') Object.freeze = (() => { throw 0; }) as typeof Object.freeze;
      const end = await invoke(h, async seam => { count++; await operation(seam); });
      assert.equal(end.failed, true); assert.equal(count, 1);
    } finally { JSON.stringify = stringify; Buffer.byteLength = byteLength; Object.freeze = freeze; }
    if (mode === 'both-encode' || mode === 'both-byte' || mode === 'oversize') {
      assert.equal(encodes, 2); assert.equal(h.writes.length, 0); assert.deepEqual(h.receipts, [[3, 1, 1, 4]]);
    } else {
      assert.equal(h.writes.length, 1); const root = JSON.parse(h.writes[0]);
      assert.ok(projectTopicsEnvelope('root', root));
      if (mode !== 'freeze') {
        assert.equal(encodes, 2); assert.equal(root[0][6], mode === 'malformed-first-encode' ? 2 : 1); assert.equal(root[0][13], 0);
        assert.equal(root[0][21], mode === 'malformed-first-encode' ? 0 : 1); assert.ok(root[0][18] & 32); assert.deepEqual(root[1], []);
        if (mode === 'malformed-first-encode') assert.ok(root[0][18] & 4);
      } else assert.ok(root[0][18] & 256);
    }
  }
  // Both encodes, write capability and receipt fail: every primary still wins.
  for (const original of [undefined, null, 0, false, 'primary', Symbol('primary'), {}]) {
    const h = harness({ reject: 'write', receiptThrow: true }); let encodes = 0;
    let end;
    try {
      JSON.stringify = (() => { encodes++; throw Symbol('encode'); }) as typeof JSON.stringify;
      end = await invoke(h, async seam => { await operation(seam); throw original; });
    } finally { JSON.stringify = stringify; }
    assert.equal(end.failed, true); assert.equal(end.value, original);
    assert.equal(encodes, 2); assert.equal(h.writes.length, 0); assert.equal(h.receipts.length, 1);
  }
});
