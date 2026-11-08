import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

type Row = (number | null)[];
interface Diagnostic {
  v: number;
  phase: number;
  worker: Row;
  io: Row[];
  reads: number[];
  ownership: number[];
  firstFault: number[] | null;
}
interface State { invalid: boolean; value: Diagnostic | null }
interface Prepared {
  diagnostic: Diagnostic | null;
  primary: string | null;
  secondary: string[];
  status: string;
  reportRequired: boolean;
}
interface CaseReport {
  status: string;
  primary: string | null;
  counts: number[];
  requests: number[];
  pngs: { bytes: number }[];
}
interface Publication {
  schema: number;
  status: string;
  primary: string | null;
  secondary: string[];
  diagnostic: Diagnostic | null;
  counts?: (number[] | null)[];
  requests?: (number[] | null)[];
  pngCount?: number | null;
  publication?: string;
  delivery?: string;
  fixtureRetention?: string;
  workerTerminal: TerminalObservation;
}
interface TerminalObservation { readonly v: number; readonly record: readonly number[] | null }
interface TerminalObserver { freeze(): TerminalObservation }
interface TerminalHelpers {
  domain(row: unknown): boolean;
  note(owner: number, kind: string, value?: unknown): void;
  start(ctor: new (options: object) => FakeSocket): void;
  emit(): void;
  attach(child: FakeChild): TerminalObserver | null;
  freeze(observer?: TerminalObserver | null): TerminalObservation;
  freezeReleased(child: FakeChild): void;
  resetForTest(): void;
  inspectForTest(): { state: number[] | null; claimed: boolean; writable: boolean };
}
interface Helpers {
  createDiagnostic(): State;
  reduceDiagnostic(state: unknown, event: unknown): State;
  projectDiagnostic(state: unknown): Diagnostic;
  classifyWorkerExit(code: unknown, signal: unknown, exited: unknown): [number, number | null, number | null, number, boolean];
  classifySpawnFault(value: unknown): [number, boolean];
  preparePublication(state: unknown, primary: string | null, secondary: string[]): Prepared;
  buildPublication(kind: string, prepared: Prepared, certain: boolean, owned: boolean, reports: CaseReport[], terminal?: TerminalObservation): Publication;
}

// Import the production seam without calling its unchanged direct-entry guard.
const runnerURL = new URL('./browser/residual-navigation-media-runner.mjs', import.meta.url).href;
const { residualDiagnostic: d, residualTerminalDiagnostic: t } = await import(runnerURL) as { residualDiagnostic: Helpers; residualTerminalDiagnostic: TerminalHelpers };
const event = (type: string, owner = 0, a: unknown = null, b: unknown = null, c: unknown = null) => ({ type, owner, a, b, c });
const reduce = (state: State, type: string, owner = 0, a: unknown = null, b: unknown = null, c: unknown = null) => d.reduceDiagnostic(state, event(type, owner, a, b, c));
const bytes = (value: unknown, lf = false) => Buffer.byteLength(JSON.stringify(value) + (lf ? '\n' : ''));
const reports = (status = 'unavailable'): CaseReport[] => Array.from({ length: 3 }, () => ({ status, primary: status === 'unavailable' ? 'report' : null, counts: Array(17).fill(0), requests: Array(8).fill(0), pngs: [] }));
const valueOf = (state: State) => { assert.equal(state.invalid, false); assert.ok(state.value); return state.value; };

test('frozen seven-function production seam and fresh fixed inventory', () => {
  assert.equal(Object.isFrozen(d), true);
  assert.deepEqual(Object.keys(d), ['createDiagnostic', 'reduceDiagnostic', 'projectDiagnostic', 'classifyWorkerExit', 'classifySpawnFault', 'preparePublication', 'buildPublication']);
  const state = d.createDiagnostic(), other = d.createDiagnostic();
  const value = d.projectDiagnostic(state);
  assert.deepEqual(Object.keys(value), ['v', 'phase', 'worker', 'io', 'reads', 'ownership', 'firstFault']);
  assert.equal(value.worker.length, 13);
  assert.equal(value.io.length, 7);
  assert.ok(value.io.every(row => row.length === 13));
  assert.deepEqual(value.reads, [0, 0, 0]);
  assert.deepEqual(value.ownership, [0, 0, 0, 0, 0, 0]);
  value.worker[0] = 1;
  assert.equal(valueOf(state).worker[0], 0);
  assert.notEqual(valueOf(state).io[0], valueOf(other).io[0]);
});

test('actual exit classifications do not decode worker phases or shell signals', () => {
  for (const [code, kind] of [[0, 1], [1, 2], [2, 3], [3, 6], [16, 6], [130, 6], [143, 6], [255, 6]]) {
    assert.deepEqual(d.classifyWorkerExit(code, null, true), [kind, code, 0, 1, false]);
  }
  assert.deepEqual(d.classifyWorkerExit(null, null, false), [0, null, null, 0, false]);
  for (const [signal, kind] of [['SIGTERM', 1], ['SIGKILL', 2], ['SIGABRT', 3], ['SIGSEGV', 4], ['OTHER', 5]] as const) {
    assert.deepEqual(d.classifyWorkerExit(null, signal, true), [7, null, kind, 1, false]);
  }
  for (const code of [-1, 256, NaN, Infinity, '1', {}, undefined]) {
    assert.equal(d.classifyWorkerExit(code, null, true)[4], true);
  }
  assert.equal(d.classifyWorkerExit(0, {}, true)[4], true);
});

test('spawn classifier allows only own data codes, never invokes accessors or retries traps', () => {
  for (const [index, code] of ['ENOENT', 'EACCES', 'ENOEXEC', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM'].entries()) {
    assert.deepEqual(d.classifySpawnFault({ code, message: 'private-not-exported' }), [index + 2, false]);
  }
  assert.deepEqual(d.classifySpawnFault({ code: 'OTHER' }), [1, false]);
  assert.deepEqual(d.classifySpawnFault(Object.create({ code: 'ENOENT' })), [1, false]);
  let gets = 0, traps = 0;
  const accessor = Object.defineProperty({}, 'code', { get() { gets++; throw new Error('private'); } });
  assert.deepEqual(d.classifySpawnFault(accessor), [1, true]);
  assert.equal(gets, 0);
  assert.deepEqual(d.classifySpawnFault(new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw new Error('private'); } })), [1, true]);
  assert.equal(traps, 1);
  for (const invalid of [null, undefined, 1, 'ENOENT', { code: 2 }]) assert.deepEqual(d.classifySpawnFault(invalid), [1, true]);
});

test('normal wait deadline, first fault and uncertainty mask remain sticky after late exit', () => {
  let state = reduce(d.createDiagnostic(), 'phase', 0, 4);
  state = reduce(state, 'wait', 0, 3);
  state = reduce(state, 'fault', 0, 4);
  state = reduce(state, 'uncertainty', 0);
  state = reduce(state, 'exit', 0, 0, null, true);
  state = reduce(state, 'wait', 0, 2);
  state = reduce(state, 'group', 0, 3);
  state = reduce(state, 'release', 0, 1);
  state = reduce(state, 'uncertainty', 3);
  state = reduce(state, 'uncertainty', 8);
  const value = d.projectDiagnostic(state);
  assert.equal(value.worker[3], 3);
  assert.equal(value.worker[11], 1);
  assert.deepEqual(value.firstFault, [0, 4, 4]);
  assert.equal(value.ownership[5], 1 | 8 | 256);
});

test('no PID, spawn failure, release and stop completion do not manufacture exit evidence', () => {
  let state = reduce(d.createDiagnostic(), 'spawn', 0, 3);
  state = reduce(state, 'group', 0, 1);
  state = reduce(state, 'release', 0, 1);
  state = reduce(state, 'stopPhase', 0, 5);
  const row = d.projectDiagnostic(state).worker;
  assert.equal(row[4], 8);
  assert.equal(row[10], 1);
  assert.equal(row[11], 0);
  assert.equal(row[5], null);
  assert.equal(row[6], null);
  assert.equal(row[7], 5);
});

test('ownership acknowledgements differ and entered read loop can retain all three attempts', () => {
  let state = reduce(d.createDiagnostic(), 'ownership', 1, 0, 1);
  state = reduce(state, 'ownership', 1, 2, 1);
  assert.deepEqual(d.projectDiagnostic(state).ownership, [1, 0, 1, 0, 0, 0]);
  state = reduce(state, 'ownership', 2, 1, 1);
  for (let index = 0; index < 3; index++) {
    state = reduce(state, 'attempt', index + 3, 1);
    state = reduce(state, 'read', index + 3, index, index === 0 ? 2 : 6);
    if (index === 0) state = reduce(state, 'uncertainty', 3);
  }
  const value = d.projectDiagnostic(state);
  assert.deepEqual(value.reads, [2, 6, 6]);
  assert.ok(value.io.slice(2, 5).every(row => row[0] === 1));
  assert.equal(value.ownership[5], 8);
  assert.equal(value.ownership[4], 0);
});

test('finite process events and before-loop skips retain fixed slot counts', () => {
  let state = d.createDiagnostic();
  for (let owner = 0; owner < 8; owner++) {
    for (const [type, value] of [['attempt', 1], ['spawn', 2], ['spawnFault', 8], ['wait', 1], ['term', 2], ['kill', 3], ['group', 4], ['stopPhase', 6], ['release', 1]] as const) {
      state = reduce(state, type, owner, value);
    }
  }
  for (let index = 0; index < 3; index++) state = reduce(state, 'read', 0, index, 1);
  const value = d.projectDiagnostic(state);
  assert.deepEqual(value.reads, [1, 1, 1]);
  assert.equal(value.io.length, 7);
  assert.ok([value.worker, ...value.io].every(row => row.length === 13 && row[8] === 2 && row[9] === 3 && row[10] === 4));
});

test('closed projector rejects holes, extra keys, accessors, reserved classes and ranges', () => {
  const mutations: ((state: State) => void)[] = [
    state => { delete valueOf(state).worker[0]; },
    state => { Object.assign(valueOf(state).worker, { extra: 1 }); },
    state => { Object.assign(valueOf(state), { extra: 1 }); },
    state => { Object.assign(state, { extra: 1 }); },
    state => { valueOf(state).worker[4] = 4; },
    state => { valueOf(state).worker[4] = 5; },
    state => { valueOf(state).worker[5] = 256; },
    state => { valueOf(state).io.pop(); },
    state => { delete valueOf(state).io[1]; },
    state => { valueOf(state).reads[0] = NaN; },
    state => { valueOf(state).ownership[5] = 512; },
    state => { valueOf(state).phase = 12; },
    state => { valueOf(state).firstFault = [0, 0]; },
    state => { Object.defineProperty(valueOf(state), 'toJSON', { value() { throw new Error('private'); } }); },
    state => { Object.defineProperty(valueOf(state).worker, '0', { get() { throw new Error('must-not-run'); } }); },
    state => { Object.defineProperty(state, 'value', { get() { throw new Error('must-not-run'); } }); },
  ];
  for (const mutate of mutations) {
    const state = d.createDiagnostic(); mutate(state);
    assert.throws(() => d.projectDiagnostic(state), /^Error: report$/);
    assert.deepEqual(reduce(state, 'phase', 0, 1), { invalid: true, value: null });
  }
});

test('invalid events and throwing proxies are total, sticky and do not retain raw values', () => {
  let traps = 0;
  const proxy = new Proxy({}, { ownKeys() { traps++; throw new Error('private'); } });
  const invalids = [proxy, null, {}, { ...event('phase', 0, 1), extra: 0 }, event('phase', 9, 1), event('unknown'), event('read', 0, 3, 1), event('phase', 0, 1, 2), event('group', 0, {})];
  for (const input of invalids) {
    const invalid = d.reduceDiagnostic(d.createDiagnostic(), input);
    assert.deepEqual(invalid, { invalid: true, value: null });
    assert.equal(Object.isFrozen(invalid), true);
    assert.equal(reduce(invalid, 'phase', 0, 1), invalid);
    assert.ok(!JSON.stringify(invalid).includes('private'));
  }
  assert.equal(traps, 1);
  let accessors = 0;
  const input = Object.defineProperty(event('phase', 0, 1), 'a', { get() { accessors++; return 1; } });
  assert.equal(d.reduceDiagnostic(d.createDiagnostic(), input).invalid, true);
  assert.equal(accessors, 0);
});

test('projector catches proxy traps once without invoking accessors or toJSON', () => {
  let traps = 0, calls = 0;
  const state = d.createDiagnostic();
  valueOf(state).worker = new Proxy(valueOf(state).worker, { ownKeys() { traps++; throw new Error('private'); } });
  assert.throws(() => d.projectDiagnostic(state), /^Error: report$/);
  assert.equal(traps, 1);
  const raw = d.createDiagnostic();
  Object.defineProperty(valueOf(raw), 'toJSON', { value() { calls++; return {}; } });
  assert.equal(d.preparePublication(raw, null, []).status, 'failed');
  assert.equal(calls, 0);
});

test('publication preparation precedes status snapshot and fallback preserves primary', () => {
  const secondary = ['cleanup'];
  const prepared = d.preparePublication({ invalid: true, value: null }, 'worker', secondary);
  assert.deepEqual(secondary, ['cleanup']);
  assert.deepEqual(prepared, { diagnostic: null, primary: 'worker', secondary: ['cleanup', 'report'], status: 'failed', reportRequired: true });
  if (prepared.reportRequired && !secondary.includes('report')) secondary.push('report');
  const summary = d.buildPublication('summary', prepared, false, true, reports());
  assert.deepEqual(summary.secondary, secondary);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.primary, 'worker');
  assert.equal(summary.diagnostic, null);
  const again = d.preparePublication({ invalid: true, value: null }, null, ['report']);
  assert.deepEqual(again.secondary, ['report']);
  assert.equal(again.status, 'failed');
  const outOfDomain = d.createDiagnostic(); valueOf(outOfDomain).worker[0] = 10 ** 100;
  assert.equal(d.preparePublication(outOfDomain, null, []).diagnostic, null);
});

test('real builders preserve unavailable nulls and immutable pre-cleanup snapshot', () => {
  let state = reduce(d.createDiagnostic(), 'phase', 6, 9);
  const prepared = d.preparePublication(state, 'worker', []);
  const cases = reports();
  const summary = d.buildPublication('summary', prepared, false, true, cases);
  assert.equal(summary.schema, 2);
  assert.equal(summary.publication, 'pre-cleanup-snapshot');
  assert.deepEqual(summary.counts, [null, null, null]);
  assert.deepEqual(summary.requests, [null, null, null]);
  assert.equal(summary.pngCount, null);
  assert.ok(summary.diagnostic);
  assert.deepEqual(summary.diagnostic.io[5].slice(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(summary.diagnostic.io[6].slice(0, 4), [0, 0, 0, 0]);
  state = reduce(state, 'attempt', 6, 1);
  state = reduce(state, 'ownership', 7, 3, 1);
  state = reduce(state, 'ownership', 7, 4, 1);
  state = reduce(state, 'phase', 0, 11);
  const receipt = d.buildPublication('receipt', d.preparePublication(state, 'worker', []), true, false, cases);
  assert.equal(receipt.delivery, 'attempt-only');
  assert.equal(receipt.fixtureRetention, 'removed-or-not-created');
  assert.equal(receipt.diagnostic?.ownership[4], 1);
  assert.equal(summary.diagnostic.ownership[4], 0);
  assert.equal(summary.diagnostic.io[5][0], 0);
  assert.ok(!Object.keys(receipt).some(key => /ack|confirmed/i.test(key)));
  prepared.diagnostic!.worker[0] = 1;
  prepared.secondary.push('report');
  assert.equal(summary.diagnostic.worker[0], 0);
  assert.deepEqual(summary.secondary, []);
  const available = reports('passed');
  const output = d.buildPublication('summary', d.preparePublication(d.createDiagnostic(), null, []), true, false, available);
  available[0].counts[0] = 99; available[0].requests[0] = 99;
  assert.equal(output.counts?.[0]?.[0], 0);
  assert.equal(output.requests?.[0]?.[0], 0);
});

test('serialized diagnostic worst-domain and conservative publication bounds fit unchanged caps', () => {
  const state = d.createDiagnostic();
  const value = valueOf(state);
  value.phase = 11;
  // JSON null is longer than every allowed number in these nullable columns.
  value.worker = [1, 4, 8, 3, 8, null, null, 6, 3, 3, 4, 1, 1];
  value.io = Array.from({ length: 7 }, () => [...value.worker]);
  value.reads = [6, 6, 6]; value.ownership = [1, 1, 1, 1, 1, 511]; value.firstFault = [8, 11, 5];
  const projected = d.projectDiagnostic(state);
  assert.ok(bytes(projected) <= 2048);
  const prepared = d.preparePublication(state, 'screenshot', ['setup', 'fixture', 'service', 'auth', 'browser', 'request', 'open', 'probe', 'identity', 'wheel', 'wheel-range', 'tail', 'edge', 'top', 'path', 'keyboard', 'controller', 'screenshot', 'counter', 'timeout', 'cleanup', 'report', 'worker', 'blocked']);
  const cases = reports('failed');
  // This counter superset bounds builder bytes, not valid business-report data.
  for (const report of cases) { report.primary = 'screenshot'; report.counts.fill(2147483647); report.requests.fill(2147483647); }
  cases[0].pngs = Array.from({ length: 11 }, () => ({ bytes: 2097152 }));
  cases[1].pngs = Array.from({ length: 11 }, () => ({ bytes: 2097152 }));
  const maximumCaseBytes = 393216 + 393216 + 32768;
  for (const certain of [false, true]) for (const owned of [false, true]) {
    const summary = d.buildPublication('summary', prepared, certain, owned, cases);
    const receipt = d.buildPublication('receipt', prepared, certain, owned, cases);
    assert.ok(bytes(summary, true) <= 32768);
    assert.ok(bytes(receipt, true) < 4096);
    // Cap composition, not three maximum legal JSON fixtures or near-cap rejection.
    assert.ok(maximumCaseBytes + bytes(summary, true) <= 851968);
  }
});

// Pure synchronous fakes: no sockets, descriptors, tasks, or process lifetime.
const terminalCodes = ['setup', 'fixture', 'service', 'auth', 'browser', 'request', 'open', 'probe', 'identity', 'wheel', 'wheel-range', 'tail', 'edge', 'top', 'path', 'keyboard', 'controller', 'screenshot', 'counter', 'timeout', 'cleanup', 'report', 'worker', 'blocked'];
const maximumTerminal = [1, 4, 14, 6, 310, 25, 2, 2, 73, 53, 2];
const terminalWire = (row = maximumTerminal) => Buffer.from(JSON.stringify(row) + '\n');
class FakeSocket extends EventEmitter {
  destroyed = false;
  trace: string[] = ['construct'];
  frames: Buffer[] = [];
  callbacks: ((error?: Error) => void)[] = [];
  claimedAtWrite = false;
  readonly options: object;
  readonly failAt: string;
  readonly backpressure: boolean;
  constructor(options: object, failAt = '', backpressure = false) {
    super(); this.options = options; this.failAt = failAt; this.backpressure = backpressure;
  }
  override on(name: string, listener: (...args: any[]) => void): this {
    this.trace.push(`on:${name}`);
    if (this.failAt === `on:${name}`) throw new Error('listener');
    return super.on(name, listener);
  }
  unref() { this.trace.push('unref'); if (this.failAt === 'unref') throw new Error('unref'); }
  destroy() { this.trace.push('destroy'); this.destroyed = true; this.emit('error', new Error('local destroy')); }
  write(frame: Buffer, callback: (error?: Error) => void) {
    this.claimedAtWrite = t.inspectForTest().claimed;
    this.trace.push('write'); this.frames.push(Buffer.from(frame)); this.callbacks.push(callback);
    if (this.failAt === 'write') throw new Error('write');
    return !this.backpressure;
  }
}
function startFake(failAt = '', backpressure = false) {
  let socket!: FakeSocket;
  class SocketCtor extends FakeSocket {
    constructor(options: object) { super(options, failAt, backpressure); socket = this; }
  }
  t.start(SocketCtor);
  return socket;
}
class FakeStream extends EventEmitter {
  pauses = 0;
  destroys = 0;
  failAt = '';
  override on(name: string, listener: (...args: any[]) => void): this {
    if (this.failAt === name) throw new Error('attach listener');
    return super.on(name, listener);
  }
  pause() { this.pauses++; }
  destroy() { this.destroys++; this.emit('close'); }
}
class FakeChild extends EventEmitter {
  readonly stdio: (FakeStream | null)[];
  readonly stream: FakeStream | null;
  constructor(stream: FakeStream | null = new FakeStream()) {
    super(); this.stream = stream; this.stdio = [null, null, null, stream];
  }
}
function receive(chunks: Buffer[] = [], end = true) {
  const child = new FakeChild(), observer = t.attach(child);
  for (const chunk of chunks) child.stream!.emit('data', chunk);
  if (end) child.stream!.emit('end');
  return { child, observer };
}
function selectMaximum() {
  t.note(3, 'select'); t.note(3, 'site', 10); t.note(3, 'stage', 14); t.note(0, 'branch', 6);
  t.note(3, 'primary', 'blocked'); t.note(3, 'failed');
  t.note(3, 'cleanup', 73); t.note(3, 'report', 53); t.note(3, 'safe', 2);
}
function terminalTest(name: string, body: () => void) {
  test(name, { concurrency: false }, () => {
    t.resetForTest();
    try { body(); } finally { t.resetForTest(); }
  });
}

// Only the selected builtin fault is replaced. No assertions, logging, await,
// runner registration, or async scheduling occur before descriptor restoration.
type FaultTarget = 'copy' | 'encode' | 'recordFreeze' | 'observationFreeze' | 'alloc';
function builtinFault(target: FaultTarget, action: () => void) {
  const host = target === 'copy' ? Array.prototype : target === 'encode' ? JSON : target === 'alloc' ? Buffer : Object;
  const key = target === 'copy' ? Symbol.iterator : target === 'encode' ? 'stringify' : target === 'alloc' ? 'alloc' : 'freeze';
  const descriptor = Object.getOwnPropertyDescriptor(host, key)!;
  const original = descriptor.value;
  let hits = 0;
  const replacement = function(this: unknown, ...args: any[]) {
    const value = target === 'copy' ? this : args[0];
    const selected = target === 'alloc' ? value === 256 : target === 'observationFreeze'
      ? value !== null && typeof value === 'object' && !Array.isArray(value) && value.v === 1 && Array.isArray(value.record)
      : Array.isArray(value) && value.length === 11;
    if (selected) { hits++; throw new Error('selected builtin fault'); }
    return Reflect.apply(original, this, args);
  };
  try {
    Object.defineProperty(host, key, { ...descriptor, value: replacement });
    action();
  } finally { Object.defineProperty(host, key, descriptor); }
  return { hits, host, key, descriptor };
}
function restored(fault: ReturnType<typeof builtinFault>) {
  assert.ok(fault.hits > 0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(fault.host, fault.key), fault.descriptor);
}

terminalTest('terminal seam is separate, frozen, handle-free, and resets only test state', () => {
  assert.equal(Object.isFrozen(t), true);
  assert.deepEqual(Object.keys(t), ['domain', 'note', 'start', 'emit', 'attach', 'freeze', 'freezeReleased', 'resetForTest', 'inspectForTest']);
  assert.deepEqual(t.inspectForTest(), { state: null, claimed: false, writable: false });
  assert.equal(t.freeze(null).record, null);
  assert.equal(Object.isFrozen(t.freeze(null)), true);
  const socket = startFake();
  assert.deepEqual(t.inspectForTest(), { state: [1, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0], claimed: false, writable: true });
  const copy = t.inspectForTest(); copy.state![0] = 99;
  assert.equal(t.inspectForTest().state![0], 1);
  assert.deepEqual(Object.keys(copy), ['state', 'claimed', 'writable']);
  const { child, observer } = receive([terminalWire()]);
  t.resetForTest(); t.freezeReleased(child);
  assert.equal(socket.trace.includes('destroy'), false);
  assert.deepEqual(t.inspectForTest(), { state: null, claimed: false, writable: false });
  // Reset removed only the association, not this already attached fake observer.
  assert.deepEqual(t.freeze(observer).record, maximumTerminal);
});

terminalTest('dense terminal domain covers every numeric value and closed boundary', () => {
  const range = (max: number) => Array.from({ length: max + 1 }, (_, i) => i);
  const boundaries = (steps: number) => [0, 1, ...Array.from({ length: steps }, (_, i) => [10 * (i + 1) + 1, 10 * (i + 1) + 2, 10 * (i + 1) + 3]).flat()];
  const sites = [0, 11, ...[1, 2, 3].flatMap(owner => range(9).map(i => owner * 100 + i + 1))];
  const domains = [[1], range(4), range(14), range(6), sites, range(25), range(2), range(2), boundaries(7), boundaries(5), range(2)];
  assert.equal(t.domain(maximumTerminal), true);
  for (let slot = 0; slot < 11; slot++) {
    for (let value = 0; value <= (slot === 4 ? 411 : Math.max(...domains[slot]) + 2); value++) {
      const row = [...maximumTerminal]; row[slot] = value;
      assert.equal(t.domain(row), domains[slot].includes(value), `slot ${slot} value ${value}`);
    }
    for (const value of [-1, .5, NaN, Infinity, -Infinity, null, undefined, true, '1']) {
      const row: unknown[] = [...maximumTerminal]; row[slot] = value;
      assert.equal(t.domain(row), false);
    }
  }
  for (const row of [null, {}, 'record', [], maximumTerminal.slice(1), [...maximumTerminal, 0]]) assert.equal(t.domain(row), false);
});

terminalTest('real notes separate unknown, null, late owner, first site, and last invocation', () => {
  t.note(1, 'select'); assert.equal(t.inspectForTest().state, null);
  startFake(); t.note(4, 'stage', 2); t.note(0, 'branch', 5);
  assert.deepEqual(t.inspectForTest().state!.slice(1, 4), [4, 2, 5]);
  t.note(1, 'select');
  assert.deepEqual(t.inspectForTest().state, [1, 1, 3, 5, 0, 0, 0, 0, 1, 1, 0]);
  t.note(1, 'primary', null); assert.equal(t.inspectForTest().state![5], 1);
  for (const [i, code] of terminalCodes.entries()) { t.note(1, 'primary', code); assert.equal(t.inspectForTest().state![5], i + 2); }
  t.note(1, 'primary', 'other'); assert.equal(t.inspectForTest().state![5], 0);
  t.note(1, 'tracker'); assert.deepEqual(t.inspectForTest().state!.slice(6, 8), [1, 1]);
  t.note(1, 'stopped'); assert.deepEqual(t.inspectForTest().state!.slice(6, 8), [1, 2]);
  t.note(1, 'failed'); assert.deepEqual(t.inspectForTest().state!.slice(6, 8), [2, 2]);
  t.note(1, 'safe', 2); t.note(1, 'safe', 1); assert.equal(t.inspectForTest().state![10], 1);
  for (let stage = 4; stage <= 14; stage++) { t.note(1, 'stage', stage); assert.equal(t.inspectForTest().state![2], stage); }
  t.note(2, 'select');
  t.note(1, 'failed'); t.note(1, 'stopped'); t.note(1, 'safe', 1); t.note(1, 'stage', 14);
  assert.deepEqual(t.inspectForTest().state, [1, 2, 3, 5, 0, 0, 0, 0, 1, 1, 0]);
  t.note(1, 'site', 4); t.note(2, 'site', 6); t.note(0, 'site', 11);
  assert.equal(t.inspectForTest().state![4], 104);
  t.note(3, 'select'); assert.deepEqual(t.inspectForTest().state, [1, 3, 3, 5, 104, 0, 0, 0, 1, 1, 0]);
  for (const owner of [1, 2, 3]) for (let local = 1; local <= 10; local++) {
    t.resetForTest(); startFake(); t.note(owner, 'site', local); t.note(0, 'site', 11);
    assert.equal(t.inspectForTest().state![4], owner * 100 + local);
  }
  t.resetForTest(); startFake(); t.note(0, 'site', 11); assert.equal(t.inspectForTest().state![4], 11);
  for (let branch = 0; branch <= 6; branch++) { t.note(0, 'branch', branch); assert.equal(t.inspectForTest().state![3], branch); }
});

terminalTest('real cleanup and report notes distinguish entered, returned, failed, and unknown', () => {
  startFake(); t.note(1, 'select');
  for (const [kind, slot, steps] of [['cleanup', 8, 7], ['report', 9, 5]] as const) {
    for (let step = 1; step <= steps; step++) {
      t.note(1, kind, step * 10 + 1); assert.equal(t.inspectForTest().state![slot], step * 10 + 1);
      t.note(1, kind + 'Failed'); assert.equal(t.inspectForTest().state![slot], step * 10 + 3);
      t.note(1, kind, step * 10 + 1); t.note(1, kind, step * 10 + 2);
      assert.equal(t.inspectForTest().state![slot], step * 10 + 2);
      t.note(1, kind + 'Failed'); assert.equal(t.inspectForTest().state![slot], 0);
    }
    for (const notEntered of [0, 1]) { t.note(1, kind, notEntered); t.note(1, kind + 'Failed'); assert.equal(t.inspectForTest().state![slot], 0); }
  }
});

terminalTest('real start uses FD3 sink/unref ordering and isolates partial initialization failures', () => {
  const socket = startFake();
  assert.deepEqual(socket.options, { fd: 3, readable: false, writable: true });
  assert.deepEqual(socket.trace, ['construct', 'on:error', 'on:end', 'on:close', 'unref']);
  t.emit(); assert.equal(socket.trace.at(-1), 'write');
  for (const failAt of ['on:error', 'on:end', 'on:close', 'unref']) {
    t.resetForTest(); const failed = startFake(failAt);
    assert.equal(t.inspectForTest().writable, false);
    assert.equal(failed.trace.includes('destroy'), failAt !== 'on:error');
    assert.equal(failed.listenerCount('error'), failAt === 'on:error' ? 0 : 1);
    if (failAt !== 'on:error') failed.emit('error', new Error('late'));
    t.emit(); assert.equal(failed.frames.length, 0); assert.equal(t.inspectForTest().claimed, true);
  }
  t.resetForTest(); let constructions = 0;
  class ThrowSocket extends FakeSocket { constructor(options: object) { super(options); constructions++; throw new Error('construct'); } }
  t.start(ThrowSocket); t.emit(); t.emit();
  assert.equal(constructions, 1); assert.equal(t.inspectForTest().writable, false); assert.equal(t.inspectForTest().claimed, true);
  for (const name of ['error', 'end', 'close']) {
    t.resetForTest(); const disabled = startFake(); disabled.emit(name, new Error('channel'));
    assert.equal(t.inspectForTest().writable, false); t.emit(); assert.equal(disabled.frames.length, 0);
    assert.equal(disabled.listenerCount('error'), 1);
  }
  t.resetForTest(); const destroyed = startFake(); destroyed.destroyed = true; t.emit(); assert.equal(destroyed.frames.length, 0);
});

terminalTest('real emitter claims before one canonical write and late events never mutate or retry', () => {
  for (const failAt of ['', 'write']) for (const backpressure of [false, true]) {
    t.resetForTest(); const socket = startFake(failAt, backpressure); selectMaximum();
    const before = t.inspectForTest().state;
    t.emit(); const claimed = t.inspectForTest();
    t.note(2, 'select'); t.note(0, 'branch', 6); t.note(0, 'site', 11); t.emit();
    socket.callbacks[0](new Error('late write')); socket.callbacks[0]();
    socket.emit('error', new Error('late')); socket.emit('end'); socket.emit('close'); t.emit();
    assert.equal(claimed.claimed, true); assert.deepEqual(t.inspectForTest(), claimed);
    assert.deepEqual(claimed.state, before); assert.equal(socket.frames.length, 1);
    assert.equal(socket.claimedAtWrite, true);
    assert.equal(socket.frames[0].toString('ascii'), '[1,3,14,6,310,25,2,2,73,53,2]\n');
    assert.equal(socket.frames[0].length, 30);
  }
  t.resetForTest(); t.emit(); assert.equal(t.inspectForTest().claimed, true);
  t.resetForTest(); const invalid = startFake(); t.note(4, 'stage', 15); t.emit(); t.emit();
  assert.equal(t.inspectForTest().claimed, true); assert.equal(invalid.frames.length, 0);
});

terminalTest('real emitter copy, encode, and freeze throws leave claim sticky without a write', () => {
  for (const target of ['copy', 'encode', 'recordFreeze'] as const) {
    t.resetForTest(); const socket = startFake(); selectMaximum();
    const fault = builtinFault(target, () => { t.emit(); });
    restored(fault);
    assert.equal(fault.hits, 1); assert.equal(t.inspectForTest().claimed, true);
    const before = t.inspectForTest(); t.note(1, 'select'); t.emit();
    assert.deepEqual(t.inspectForTest(), before); assert.equal(socket.frames.length, 0);
  }
});

terminalTest('real receiver accepts single/split canonical buffers only after natural EOF', () => {
  const wire = terminalWire();
  for (let split = 0; split <= wire.length; split++) {
    const { child, observer } = receive([wire.subarray(0, split), wire.subarray(split)]);
    wire[1] = 57; // Mutate the consumed input before freezing the parsed scalar copy.
    const observation = t.freeze(observer);
    wire[1] = 49; // Restore the canonical frame for the next split fixture.
    assert.deepEqual(observation.record, maximumTerminal);
    assert.equal(Object.isFrozen(observation), true); assert.equal(Object.isFrozen(observation.record), true);
    assert.throws(() => { (observation.record as number[])[0] = 9; }, TypeError);
    child.stream!.emit('data', Buffer.from('x')); child.stream!.emit('error', new Error('late')); child.stream!.emit('close');
    assert.equal(t.freeze(observer), observation);
    assert.deepEqual(observation.record, maximumTerminal);
  }
  const missingEnd = receive([terminalWire()], false);
  const frozen = t.freeze(missingEnd.observer); assert.equal(frozen.record, null);
  missingEnd.child.stream!.emit('end'); assert.equal(t.freeze(missingEnd.observer), frozen);
  const empty = receive(); assert.equal(t.freeze(empty.observer).record, null);
  const missing = new FakeChild(null); assert.equal(t.freeze(t.attach(missing)).record, null);
});

terminalTest('real receiver rejects malformed ASCII, record count, domains and bounded overflow', () => {
  const canonical = terminalWire().toString('ascii');
  const invalid = [canonical + canonical, canonical + '0', canonical + '\n', canonical.trimEnd(), canonical.replace('1,', '01,'), canonical.replace('1,', '+1,'), canonical.replace('1,', '1.0,'), canonical.replace('1,', '1e0,'), canonical.replace('1,', '-0,'), canonical.replace('1,', 'null,'), canonical.replace('1,', 'true,'), canonical.replace('1,', '"1",'), ' ' + canonical, canonical.replace(',', ', '), canonical.replace('\n', '\r\n'), JSON.stringify(maximumTerminal.slice(1)) + '\n', JSON.stringify([...maximumTerminal, 0]) + '\n'];
  for (let slot = 0; slot < 11; slot++) { const row = [...maximumTerminal]; row[slot] = [2, 5, 15, 7, 311, 26, 3, 3, 74, 54, 3][slot]; invalid.push(JSON.stringify(row) + '\n'); }
  const buffers = invalid.map(text => Buffer.from(text));
  buffers.push(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), terminalWire()]), Buffer.concat([terminalWire(), Buffer.from([0x80])]), Buffer.from(canonical.replace('1', 'é')));
  for (const input of buffers) {
    const { child, observer } = receive([input]);
    assert.equal(t.freeze(observer).record, null, input.toString('hex'));
    assert.equal(child.stream!.destroys, 0);
  }
  for (const chunks of [[terminalWire(), terminalWire()], [terminalWire(), Buffer.from('x')]]) assert.equal(t.freeze(receive(chunks).observer).record, null);
  // Exactly 256 allowed ASCII bytes are retained but grammar-invalid, not valid.
  const atCap = receive([Buffer.alloc(256, 49)], false);
  assert.equal(atCap.child.stream!.pauses, 0); atCap.child.stream!.emit('end');
  assert.equal(t.freeze(atCap.observer).record, null); assert.equal(atCap.child.stream!.pauses, 1);
  for (const chunks of [[Buffer.alloc(257, 49)], [Buffer.alloc(256, 49), Buffer.from('1')]]) {
    const overflow = receive(chunks, false);
    assert.equal(overflow.child.stream!.pauses, 1); assert.equal(overflow.child.stream!.listenerCount('data'), 0);
    overflow.child.stream!.emit('data', terminalWire()); overflow.child.stream!.emit('end');
    assert.equal(t.freeze(overflow.observer).record, null); assert.equal(overflow.child.stream!.destroys, 0);
  }
});

terminalTest('real EOF/error/close/release ordering is sticky and release does not manufacture EOF', () => {
  for (const order of [ ['close', 'end'], ['error', 'end'], ['end', 'error'], ['end', 'data'], ['childError', 'end'] ]) {
    const { child, observer } = receive([terminalWire()], false);
    for (const name of order) {
      if (name === 'childError') child.emit('error', new Error('child'));
      else child.stream!.emit(name, name === 'data' ? Buffer.from('0') : new Error('channel'));
    }
    assert.equal(t.freeze(observer).record, null, order.join(','));
  }
  const clean = receive([terminalWire()]); clean.child.stream!.emit('close');
  assert.deepEqual(t.freeze(clean.observer).record, maximumTerminal);
  for (const end of [false, true]) {
    const { child, observer } = receive([terminalWire()], end);
    t.freezeReleased(new FakeChild()); // Unassociated parentIO-shaped child does nothing.
    t.freezeReleased(child); child.stream!.destroy();
    const observation = t.freeze(observer);
    assert.deepEqual(observation.record, end ? maximumTerminal : null);
    child.stream!.emit('end'); child.emit('error', new Error('late')); child.stream!.emit('data', terminalWire());
    t.freezeReleased(child); assert.equal(t.freeze(observer), observation);
  }
  const fallback = receive([terminalWire()]); const first = t.freeze(fallback.observer);
  t.freezeReleased(fallback.child); assert.equal(t.freeze(fallback.observer), first);
});

terminalTest('real attach and freezer allocation/copy/freeze failures return immutable unavailable', () => {
  const child = new FakeChild(); let allocated: TerminalObserver | null = null;
  const allocFault = builtinFault('alloc', () => { allocated = t.attach(child); });
  restored(allocFault); assert.equal(allocated, null); assert.equal(t.freeze(allocated).record, null);
  for (const name of ['error', 'close', 'end', 'data']) {
    const failed = new FakeChild(); failed.stream!.failAt = name;
    assert.equal(t.attach(failed), null); t.freezeReleased(failed);
    if (name !== 'error') failed.stream!.emit('error', new Error('late retained sink'));
    assert.equal(failed.stream!.listenerCount('data'), 0);
  }
  for (const target of ['copy', 'recordFreeze', 'observationFreeze'] as const) {
    const { child: source, observer } = receive([terminalWire()]);
    let observation: TerminalObservation | undefined;
    const fault = builtinFault(target, () => { observation = t.freeze(observer); });
    restored(fault); assert.equal(fault.hits, 1);
    assert.equal(observation!.record, null); assert.equal(Object.isFrozen(observation), true);
    source.stream!.emit('end'); source.stream!.emit('data', terminalWire());
    assert.equal(t.freeze(observer), observation); t.freezeReleased(source); assert.equal(t.freeze(observer), observation);
  }
});

terminalTest('safe real frozen observations preserve every legacy publication field and shared identity', () => {
  const good = receive([terminalWire()]), absent = receive([terminalWire()], false);
  const available = t.freeze(good.observer), unavailable = t.freeze(absent.observer);
  const state = reduce(reduce(d.createDiagnostic(), 'uncertainty', 0), 'exit', 0, 2, null, true);
  const prepared = d.preparePublication(state, 'worker', ['cleanup']);
  for (const certain of [false, true]) for (const owned of [false, true]) for (const status of ['unavailable', 'failed', 'passed']) {
    const cases = reports(status);
    const summary = d.buildPublication('summary', prepared, certain, owned, cases, available);
    const receipt = d.buildPublication('receipt', prepared, certain, owned, cases, available);
    assert.equal(summary.workerTerminal, available); assert.equal(receipt.workerTerminal, available);
    for (const kind of ['summary', 'receipt']) {
      const baseline = d.buildPublication(kind, prepared, certain, owned, cases, unavailable);
      const changed = d.buildPublication(kind, prepared, certain, owned, cases, available);
      const { workerTerminal: ignoredBase, ...legacyBase } = baseline;
      const { workerTerminal: ignoredChanged, ...legacyChanged } = changed;
      assert.deepEqual(legacyChanged, legacyBase);
      assert.equal(ignoredBase, unavailable); assert.equal(ignoredChanged, available);
      assert.equal(changed.primary, 'worker'); assert.deepEqual(changed.secondary, ['cleanup']);
      assert.deepEqual(changed.diagnostic!.ownership, [0, 0, 0, 0, 0, 1]);
    }
    good.child.stream!.emit('error', new Error('late')); absent.child.stream!.emit('end');
    assert.equal(t.freeze(good.observer), available); assert.equal(t.freeze(absent.observer), unavailable);
  }
});

terminalTest('exact maximal terminal bytes and actual worst-domain builder fixture fit unchanged caps', () => {
  const socket = startFake(); selectMaximum(); t.emit();
  const observation = t.freeze(receive(socket.frames).observer), unavailable = t.freeze(null);
  assert.equal(t.domain(maximumTerminal), true);
  assert.equal(bytes(observation.record), 29); assert.equal(socket.frames[0].length, 30);
  assert.equal(Buffer.byteLength(',"workerTerminal":' + JSON.stringify(observation)), 64);
  assert.equal(Buffer.byteLength(',"workerTerminal":' + JSON.stringify(unavailable)), 39);
  const state = d.createDiagnostic(), value = valueOf(state);
  value.phase = 11; value.worker = [1, 4, 8, 3, 8, null, null, 6, 3, 3, 4, 1, 1];
  value.io = Array.from({ length: 7 }, () => [...value.worker]); value.reads = [6, 6, 6];
  value.ownership = [1, 1, 1, 1, 1, 511]; value.firstFault = [8, 11, 5];
  const prepared = d.preparePublication(state, 'wheel-range', terminalCodes);
  const cases = reports('unavailable');
  // Builder-domain maxima, not legal media/controller business reports or a
  // claim that the unexposed full report projector has been exercised.
  for (const report of cases) { report.status = 'failed'; report.primary = 'wheel-range'; report.counts.fill(2147483647); report.requests.fill(2147483647); }
  for (const report of cases.slice(0, 2)) report.pngs = Array.from({ length: 12 }, () => ({ bytes: 2097152 }));
  let largestSummary = 0, largestReceipt = 0;
  for (const certain of [false, true]) for (const owned of [false, true]) {
    const summary = d.buildPublication('summary', prepared, certain, owned, cases, observation);
    const receipt = d.buildPublication('receipt', prepared, certain, owned, cases, observation);
    const nullSummary = d.buildPublication('summary', prepared, certain, owned, cases, unavailable);
    const nullReceipt = d.buildPublication('receipt', prepared, certain, owned, cases, unavailable);
    assert.equal(bytes(summary, true) - bytes(nullSummary, true), 25);
    assert.equal(bytes(receipt, true) - bytes(nullReceipt, true), 25);
    largestSummary = Math.max(largestSummary, bytes(summary, true)); largestReceipt = Math.max(largestReceipt, bytes(receipt, true));
    assert.ok(bytes(receipt, true) < 4096); assert.ok(bytes(summary, true) <= 32768);
    assert.ok(393216 * 2 + 32768 + bytes(summary, true) <= 851968);
  }
  assert.equal(bytes(prepared.diagnostic), 372);
  assert.equal(largestSummary, 1942);
  assert.equal(largestReceipt, 890);
  // Receipt-only maximum uses unavailable statuses; their null summary counters
  // would make them smaller than the available summary fixture above.
  const maximumReceipt = d.buildPublication('receipt', prepared, true, false, reports(), observation);
  assert.equal(bytes(maximumReceipt, true), 905);
  assert.ok(bytes(maximumReceipt, true) < 4096);
  // Static conservative report bounds are deliberately not runtime fixtures.
  assert.equal(275824 * 2 + 14752 + 6209, 572609);
});
