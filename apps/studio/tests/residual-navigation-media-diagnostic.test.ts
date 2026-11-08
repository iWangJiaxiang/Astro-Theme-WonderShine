import test from 'node:test';
import assert from 'node:assert/strict';

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
}
interface Helpers {
  createDiagnostic(): State;
  reduceDiagnostic(state: unknown, event: unknown): State;
  projectDiagnostic(state: unknown): Diagnostic;
  classifyWorkerExit(code: unknown, signal: unknown, exited: unknown): [number, number | null, number | null, number, boolean];
  classifySpawnFault(value: unknown): [number, boolean];
  preparePublication(state: unknown, primary: string | null, secondary: string[]): Prepared;
  buildPublication(kind: string, prepared: Prepared, certain: boolean, owned: boolean, reports: CaseReport[]): Publication;
}

// Import the production seam without calling its unchanged direct-entry guard.
const runnerURL = new URL('./browser/residual-navigation-media-runner.mjs', import.meta.url).href;
const { residualDiagnostic: d } = await import(runnerURL) as { residualDiagnostic: Helpers };
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
