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
const nodeCodes = ['start-rpc', 'start-schema', 'terminal-rpc', 'terminal-schema', 'incomplete', 'size', 'serialize', 'write'];
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
// attempt and one terminal attempt; an unknown begin result is never retried.
export function createNativeScopeDiagnostics(expected) {
  if (!expected) return null;
  const owner = ++nextOwner;
  if (!numeric(owner) || owner === 0) throw new Error('Native scope owner exhausted');
  let beginAttempted = false, terminalAttempted = false, started = false, terminal = null;
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
    version: 1, scope: 'final-clone-to-outer-finally', expected: true, owner,
    outcome, status: failed || saturated || !started || !terminal ? 'incomplete' : 'complete',
    capture: !beginAttempted ? 'not-started' : !started ? 'start-unknown' : terminal ? 'stopped' : 'terminal-unknown',
    beginAttempted, started, terminalAttempted,
    timingPerturbed: true, terminalAfterCatchDiagnostics: true,
    sharedWorkObserved: false, beforeStartObserved: false, currentAppWriterProven: false,
    caps: { ...caps }, columns: [...contract.columns],
    node: { faultAttempts, faults: [...faults], droppedFaults, saturated }, terminal,
  });
  return {
    async begin(page) {
      if (beginAttempted) { fault('start-schema'); return; }
      beginAttempted = true;
      let result;
      try {
        result = await page.evaluate(({ hook, owner }) => {
          if (!Object.isExtensible(globalThis) || Object.hasOwn(globalThis, `${hook}Unavailable`)) return null;
          const descriptor = Object.getOwnPropertyDescriptor(globalThis, hook);
          const api = descriptor?.value;
          if (!descriptor || descriptor.configurable !== false || descriptor.writable !== false || !Object.isFrozen(api) ||
              !api || api.version !== 1 || typeof api.start !== 'function' || typeof api.finish !== 'function') return null;
          return api.start(owner);
        }, { hook: contract.hook, owner });
      } catch { fault('start-rpc'); return; }
      if (!exact(result, ['version', 'owner', 'sessionId']) || result.version !== 1 || result.owner !== owner || result.sessionId !== 1) {
        fault('start-schema'); return;
      }
      started = true;
    },
    async finish(page, path, outcome) {
      if (terminalAttempted) { fault('terminal-schema'); process.exitCode = 1; return; }
      terminalAttempted = true;
      if (!['passed', 'failed'].includes(outcome)) { fault('terminal-schema'); outcome = 'failed'; }
      let raw = null;
      // No hook touch on a pre-start failure. An attempted but unknown start still
      // owns exactly one stop+snapshot RPC in the original page's realm.
      if (beginAttempted) {
        try {
          raw = await page.evaluate(({ hook, owner }) => {
            if (!Object.isExtensible(globalThis) || Object.hasOwn(globalThis, `${hook}Unavailable`)) return null;
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, hook);
            const api = descriptor?.value;
            if (!descriptor || descriptor.configurable !== false || descriptor.writable !== false || !Object.isFrozen(api) ||
                !api || api.version !== 1 || typeof api.finish !== 'function') return null;
            return api.finish(owner);
          }, { hook: contract.hook, owner });
        } catch { fault('terminal-rpc'); }
        // Schema validation and persistence are attempted independently of export.
        try { terminal = projectNativeScopeTerminal(raw, owner); }
        catch { fault('terminal-schema'); }
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
    },
  };
}
