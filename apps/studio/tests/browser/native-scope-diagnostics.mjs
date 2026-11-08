import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { nativeScopeContract as contract } from './native-scope-build-plugin.mjs';

const { caps } = contract;
const numeric = value => Number.isSafeInteger(value) && value >= 0 && value < caps.number;
const nullableNumber = value => value === null || numeric(value);
const nullableBoolean = value => value === null || typeof value === 'boolean';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const terminalKeys = ['version', 'owner', 'sessionId', 'active', 'stoppedAt', 'attempts', 'retainedRecords', 'droppedRecords',
  'faultAttempts', 'faults', 'droppedFaults', 'saturated', 'failed', 'lastObservedAppErrorWriter', 'writerKnown', 'appNotice', 'relationsNotice', 'records'];
const nodeCodes = ['start-rpc', 'start-schema', 'start-deadline', 'terminal-rpc', 'terminal-schema', 'terminal-deadline', 'document', 'incomplete', 'size', 'serialize', 'write'];
const deadlineMs = 3000;
const nodeClock = { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer) };

// A deadline ends Node's wait, not remote execution. Both late branches remain
// handled; only late begin handles need cleanup, never a late stop or retry.
function settle(operation, clock, onLateValue = () => {}, detached = false) {
  return new Promise(resolve => {
    let settled = false;
    const timer = clock.setTimeout(() => {
      settled = true;
      resolve({ status: 'deadline' });
    }, deadlineMs);
    if (detached) timer?.unref?.();
    const complete = result => {
      if (settled) {
        if (result.status === 'returned') {
          try { onLateValue(result.value); } catch { /* Cleanup cannot affect evidence. */ }
        }
        return;
      }
      settled = true;
      clock.clearTimeout(timer);
      resolve(result);
    };
    try {
      Promise.resolve(operation()).then(
        value => complete({ status: 'returned', value }),
        () => complete({ status: 'rejected' }),
      );
    } catch { complete({ status: 'rejected' }); }
  });
}

function disposeHandle(handle, clock) {
  // Detached, bounded and rejection-handled, including a handle delivered after
  // begin timed out. Disposal is resource cleanup, not another capture attempt.
  void settle(() => handle?.dispose(), clock, undefined, true);
}
let nextOwner = 0;

// Validate first, project second: no unknown browser property reaches the artifact.
export function projectNativeScopeTerminal(value, owner) {
  if (!exact(value, terminalKeys) || value.version !== 1 || value.owner !== owner || value.sessionId !== 1 ||
      value.active !== false || value.writerKnown !== false ||
      ![value.saturated, value.failed].every(item => typeof item === 'boolean') ||
      ![value.appNotice, value.relationsNotice].every(nullableBoolean) ||
      !(value.lastObservedAppErrorWriter === null || ['app-bootstrap', 'app-content'].includes(value.lastObservedAppErrorWriter)) ||
      !(value.stoppedAt === null || (Number.isFinite(value.stoppedAt) && value.stoppedAt >= 0 && value.stoppedAt < caps.number)) ||
      !['attempts', 'retainedRecords', 'droppedRecords', 'faultAttempts', 'droppedFaults'].every(key => numeric(value[key])) ||
      !Array.isArray(value.faults) || value.faults.length > caps.runtimeFaults || !value.faults.every(code => contract.faults.includes(code)) ||
      value.faultAttempts !== value.faults.length + value.droppedFaults ||
      !Array.isArray(value.records) || value.records.length > caps.records || value.retainedRecords !== value.records.length ||
      value.attempts !== value.retainedRecords + value.droppedRecords) throw new Error('Native scope terminal schema invalid');
  if (!numeric(owner) || owner === 0) throw new Error('Native scope owner invalid');
  let previousSeq = 0, previousTime = 0;
  const callers = new Map(), apis = new Map(), requests = new Map();
  const records = value.records.map(row => {
    if (!Array.isArray(row) || row.length !== contract.columns.length ||
        !numeric(row[0]) || row[0] <= previousSeq || row[0] > value.attempts ||
        !(row[1] === null || (Number.isFinite(row[1]) && row[1] >= previousTime && row[1] < caps.number)) ||
        !contract.events.includes(row[2]) || !contract.owners.includes(row[3]) ||
        ![4, 5, 6, 7, 8, 9, 10, 12, 13, 18].every(index => nullableNumber(row[index])) ||
        !(row[11] === null || contract.origins.includes(row[11])) ||
        ![14, 15, 16, 17, 19].every(index => nullableBoolean(row[index])) ||
        !(row[20] === null || contract.locales.includes(row[20]))) throw new Error('Native scope record schema invalid');
    const [,, event, recordOwner, callerId, apiId, requestId] = row;
    if ([callerId, apiId, requestId].some(id => id === 0) ||
        (row[12] !== null && row[12] > 599) || (row[13] !== null && row[13] > 599) ||
        (row[18] !== null && row[18] > 63) ||
        (row[1] !== null && value.stoppedAt !== null && row[1] > value.stoppedAt)) throw new Error('Native scope record bounds invalid');
    if (event === 'caller-start') {
      if (callerId === null || apiId !== null || requestId !== null || callers.has(callerId) || recordOwner === 'other') throw new Error('Native scope caller invalid');
      callers.set(callerId, recordOwner);
    } else if (callerId !== null && callers.get(callerId) !== recordOwner) throw new Error('Native scope caller link invalid');
    if (event === 'api-start') {
      if (apiId === null || requestId !== null || apis.has(apiId)) throw new Error('Native scope API invalid');
      apis.set(apiId, [callerId, recordOwner]);
    } else if (apiId !== null && (apis.get(apiId)?.[0] !== callerId || apis.get(apiId)?.[1] !== recordOwner)) throw new Error('Native scope API link invalid');
    if (event === 'request-start') {
      if (requestId === null || requests.has(requestId)) throw new Error('Native scope request invalid');
      requests.set(requestId, [apiId, callerId, recordOwner]);
    } else if (requestId !== null) {
      const parent = requests.get(requestId);
      if (!parent || parent[0] !== apiId || parent[1] !== callerId || parent[2] !== recordOwner) throw new Error('Native scope request link invalid');
    }
    previousSeq = row[0];
    if (row[1] !== null) previousTime = row[1];
    return contract.columns.map((_, index) => row[index]);
  });
  return Object.fromEntries(terminalKeys.map(key => [key, key === 'records' ? records : key === 'faults' ? [...value.faults] : value[key]]));
}

// Allocate the owner before the first RPC. Each collector has exactly one begin
// attempt and one terminal finalization; an unknown begin result is never retried.
// Clock injection is collector-scoped for deterministic unit fixtures only; the
// deadline and capture caps are fixed, not caller-configurable.
export function createNativeScopeDiagnostics(expected, { clock = nodeClock } = {}) {
  if (!expected) return null;
  const owner = ++nextOwner;
  if (!numeric(owner) || owner === 0) throw new Error('Native scope owner exhausted');
  let beginAttempted = false, terminalAttempted = false, started = false, terminal = null;
  let handle = null, beginTask = null, finalizationTask = null, terminalRpcAttempted = false;
  const rpc = { deadlineMs, begin: 'not-attempted', terminal: 'not-dispatched', binding: 'unavailable' };
  let faultAttempts = 0, droppedFaults = 0, saturated = false, failed = false;
  const faults = [];
  const fault = code => {
    failed = true;
    if (faultAttempts >= caps.number - 1) saturated = true;
    else faultAttempts++;
    if (faults.length < caps.nodeFaults) faults.push(nodeCodes.includes(code) ? code : 'serialize');
    else if (droppedFaults >= caps.number - 1) saturated = true;
    else droppedFaults++;
  };
  const report = outcome => ({
    version: 2, scope: 'final-clone-to-outer-finally', expected: true, owner,
    outcome, status: failed || saturated || !started || !terminal || rpc.binding !== 'matched' ? 'incomplete' : 'complete',
    capture: !beginAttempted ? 'not-started' : !started ? 'start-unknown' : terminal ? 'stopped' : 'terminal-unknown',
    beginAttempted, started, terminalAttempted, terminalRpcAttempted, rpc: { ...rpc },
    timingPerturbed: true, terminalAfterCatchDiagnostics: true,
    sharedWorkObserved: false, beforeStartObserved: false, currentAppWriterProven: false,
    caps: { ...caps }, columns: [...contract.columns],
    node: { faultAttempts, faults: [...faults], droppedFaults, saturated }, terminal,
  });
  return {
    async begin(page) {
      if (terminalAttempted) return; // Finalization seals evidence even if begin never ran.
      if (beginAttempted) { fault('start-schema'); return; }
      beginAttempted = true;
      beginTask = settle(() => page.evaluateHandle(({ hook, owner }) => {
        const capturedDocument = document;
        let ackValid = false;
        try {
          if (Object.isExtensible(globalThis) && !Object.hasOwn(globalThis, `${hook}Unavailable`)) {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, hook);
            const api = descriptor?.value;
            if (descriptor && descriptor.configurable === false && descriptor.writable === false && Object.isFrozen(api) &&
                api && api.version === 1 && typeof api.start === 'function' && typeof api.finish === 'function') {
              const ack = api.start(owner);
              ackValid = !!ack && typeof ack === 'object' && !Array.isArray(ack) &&
                Object.keys(ack).length === 3 && ['version', 'owner', 'sessionId'].every(key => Object.hasOwn(ack, key)) &&
                ack.version === 1 && ack.owner === owner && ack.sessionId === 1;
            }
          }
        } catch { /* Keep the original document even if start activated before throwing. */ }
        // Null prototype prevents inherited thenables; retain no raw ack or error.
        return Object.freeze(Object.assign(Object.create(null), { document: capturedDocument, ackValid }));
      }, { hook: contract.hook, owner }), clock, value => disposeHandle(value, clock)).then(result => {
        if (result.status !== 'returned') {
          rpc.begin = result.status;
          fault(result.status === 'deadline' ? 'start-deadline' : 'start-rpc');
          return;
        }
        rpc.begin = 'handle-received';
        rpc.binding = 'unverified';
        handle = result.value;
      });
      await beginTask;
    },
    finish(page, path, outcome) {
      if (finalizationTask) return finalizationTask;
      terminalAttempted = true;
      finalizationTask = (async () => {
        if (!['passed', 'failed'].includes(outcome)) { fault('terminal-schema'); outcome = 'failed'; }
        // A concurrent begin has its own fixed deadline. Finish waits for that
        // settlement, never for the original unbounded transport promise.
        await beginTask;
        // No current-page fallback, even after an unknown begin. A handle binds
        // execution to the original context; document identity is checked before
        // any hook access in case the context survives a document replacement.
        if (handle) {
          terminalRpcAttempted = true;
          const originalHandle = handle;
          handle = null;
          const result = await settle(() => originalHandle.evaluate((capsule, { hook, owner }) => {
            if (capsule.document !== document) return { version: 1, binding: 'mismatch', ackValid: false, terminal: null };
            const envelope = { version: 1, binding: 'matched', ackValid: capsule.ackValid, terminal: null };
            if (!Object.isExtensible(globalThis) || Object.hasOwn(globalThis, `${hook}Unavailable`)) return envelope;
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, hook);
            const api = descriptor?.value;
            if (!descriptor || descriptor.configurable !== false || descriptor.writable !== false || !Object.isFrozen(api) ||
                !api || api.version !== 1 || typeof api.finish !== 'function') return envelope;
            envelope.terminal = api.finish(owner);
            return envelope;
          }, { hook: contract.hook, owner }), clock);
          disposeHandle(originalHandle, clock);
          rpc.terminal = result.status;
          if (result.status !== 'returned') {
            fault(result.status === 'deadline' ? 'terminal-deadline' : 'terminal-rpc');
          } else {
            const envelope = result.value;
            if (!exact(envelope, ['version', 'binding', 'ackValid', 'terminal']) || envelope.version !== 1 ||
                !['matched', 'mismatch'].includes(envelope.binding) || typeof envelope.ackValid !== 'boolean' ||
                (envelope.binding === 'mismatch' && (envelope.ackValid !== false || envelope.terminal !== null))) {
              fault('terminal-schema');
            } else {
              rpc.binding = envelope.binding;
              if (envelope.binding === 'mismatch') fault('document');
              else {
                started = envelope.ackValid;
                if (!started) fault('start-schema');
                try { terminal = projectNativeScopeTerminal(envelope.terminal, owner); }
                catch { fault('terminal-schema'); }
              }
            }
          }
        }
        if (!started || !terminal || terminal.failed || terminal.saturated || terminal.droppedRecords ||
            terminal.faultAttempts || terminal.droppedFaults || terminal.stoppedAt === null ||
            terminal.appNotice === null || terminal.relationsNotice === null || terminal.records.length === 0 ||
            terminal.records.some(row => row[1] === null)) fault('incomplete');
        let text;
        try {
          text = JSON.stringify(report(outcome));
          if (Buffer.byteLength(text, 'utf8') > caps.bytes) {
            fault('size');
            terminal = null; // An oversized report is rejected, never silently truncated.
            text = JSON.stringify(report(outcome));
          }
          if (Buffer.byteLength(text, 'utf8') > caps.bytes) throw new Error('Native scope report exceeds cap');
        } catch { text = undefined; fault('serialize'); }
        try {
          if (text === undefined) throw new Error('Native scope serialization unavailable');
          await fs.mkdir(dirname(path), { recursive: true });
          await fs.writeFile(path, text);
        } catch { fault('write'); }
        // Late serialization/write faults must fail even if the business operation
        // succeeded. Existing primary exceptions remain untouched by this collector.
        if (failed || saturated) {
          process.exitCode = 1;
          console.error('Native scope diagnostics incomplete (bounded fixed-code report; export/write failures may prevent an updated artifact).');
        }
      })();
      return finalizationTask;
    },
  };
}
