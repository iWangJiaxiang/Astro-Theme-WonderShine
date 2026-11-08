import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Passed directly to evaluateHandle: all Browser dependencies are local.
export function createTopicsBrowserCapsule(env) {
  env ??= { currentDocument: () => document };
  const originalDocument = env.currentDocument();
  const kinds = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'focusin'];
  const slots = kinds.map(type => ({ type, callback: null, attempted: false, removed: false, status: 3 }));
  const events = [];
  let installed = 0, binding = 1, reason = 0, attempts = 0, drops = 0, mask = 0, registration = 0, cached;
  function compare() {
    try { binding = env.currentDocument() === originalDocument ? 1 : 2; }
    catch { binding = 0; }
    if (binding !== 1) mask |= 2;
    return binding === 1;
  }
  function stop(firstReason) {
    if (!reason) reason = firstReason;
    for (const slot of slots) {
      if (!slot.attempted || slot.removed) continue;
      slot.removed = true;
      try { originalDocument.removeEventListener(slot.type, slot.callback, true); slot.status = 1; }
      catch { slot.status = 2; mask |= 16; }
    }
  }
  function record(kind, event) {
    if (reason) return;
    attempts++;
    if (attempts === 65) { mask |= 8; drops = 1; stop(2); return; }
    if (!compare()) { drops = 1; stop(4); return; }
    try {
      const trusted = event.isTrusted;
      if (typeof trusted !== 'boolean') { mask |= 4; drops = 1; stop(3); return; }
      events.push([attempts, kind, Number(trusted)]);
    } catch { mask |= 4; drops = 1; stop(3); }
  }
  function meta() {
    return [installed, binding, reason, attempts, drops, mask, registration, slots.map(slot => slot.status)];
  }
  function copyACK(value) {
    return value.length === 2 ? [3, 1] : [3, 1, [...value[2].slice(0, 7), [...value[2][7]]], value[3].map(row => [...row])];
  }
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    slot.callback = event => record(index + 1, event);
    slot.attempted = true;
    try {
      originalDocument.addEventListener(slot.type, slot.callback, { capture: true, passive: true });
      registration |= 1 << index;
    } catch { mask |= 1; stop(3); break; }
  }
  if (registration === 63) installed = 1;
  return {
    afterClick() {
      if (cached) return copyACK(cached);
      compare();
      stop(mask & 2 ? 4 : 1);
      cached = installed && !(mask & 2) ? [3, 1, meta(), events.map(row => [...row])] : [3, 1];
      return copyACK(cached);
    },
    cleanup() {
      compare();
      stop(mask & 2 ? 4 : 5);
      return [3, 1, meta()];
    },
  };
}

// Normal RPC plain arrays are the boundary, not hostile Proxy trap execution.
export function projectTopicsEnvelope(kind, input) {
  try {
    const check = condition => { if (!condition) throw new Error('Invalid topics envelope'); };
    const num = (value, max) => { check(Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= max); return value; };
    function array(value, cap, exact = false) {
      check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      check(length && Object.hasOwn(length, 'value'));
      const size = num(length.value, cap); check(!exact || size === cap);
      const result = [];
      for (let index = 0; index < size; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        check(descriptor && Object.hasOwn(descriptor, 'value'));
        result.push(descriptor.value);
      }
      const keys = Reflect.ownKeys(value);
      check(keys.length === size + 1 && keys.every(key => key === 'length' ||
        (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < size)));
      return result;
    }
    const tuple = (value, domains) => array(value, domains.length, true).map((v, i) => num(v, domains[i]));
    const releases = value => tuple(value, [3, 3, 3, 3, 3, 3]);
    const aggregate = r => r.includes(2) ? 2 : r.includes(0) ? 0 : 1;
    function facts(installed, binding, reason, mask, registration, release) {
      check(reason > 0 && release.every(v => v > 0));
      check(Boolean(mask & 16) === release.includes(2));
      check(binding === 1 || (mask & 2));
      check(Boolean(mask & 8) === (reason === 2));
      check(!(mask & 8) || !(mask & 4));
      check(reason !== 4 || (mask & 2));
      if (installed) {
        check(registration === 63 && release.every(v => v === 1 || v === 2) && !(mask & 1));
        check(Boolean(mask & 4) === (reason === 3));
      } else {
        check((mask & 1) && reason === 3 && !(mask & (4 | 8)));
        const k = release.findIndex(v => v === 3);
        const attempted = k < 0 ? 6 : k;
        check(attempted >= 1 && registration === (1 << (attempted - 1)) - 1);
        check(release.every((v, i) => i < attempted ? v === 1 || v === 2 : v === 3));
      }
    }
    function counts(installed, reason, attempts, drops, mask) {
      const retained = attempts - drops;
      check(retained >= 0 && retained <= 64);
      if (!installed) { check(attempts === 0 && drops === 0); return; }
      check(Boolean(mask & 8) === (attempts === 65 && retained === 64 && drops === 1));
      if (mask & 4) check(attempts >= 1 && attempts <= 64 && drops === 1);
      else if (!(mask & 8)) {
        check(drops === 0 || (reason === 4 && (mask & 2) && attempts >= 1 && attempts <= 64));
      }
    }
    function meta(value) {
      const a = array(value, 8, true);
      const m = a.slice(0, 7).map((v, i) => num(v, [1, 2, 5, 65, 1, 31, 63][i]));
      m.push(releases(a[7]));
      facts(m[0], m[1], m[2], m[5], m[6], m[7]);
      counts(m[0], m[2], m[3], m[4], m[5]);
      return m;
    }
    function rows(value) {
      return array(value, 64).map((row, i) => {
        const r = tuple(row, [64, 6, 1]); check(r[0] === i + 1 && r[1] >= 1); return r;
      });
    }
    if (kind === 'ack' || kind === 'cleanup') {
      const a = array(input, kind === 'ack' ? 4 : 3);
      check(a[0] === 3 && a[1] === 1);
      if (kind === 'ack' && a.length === 2) return [3, 1];
      check(a.length === (kind === 'ack' ? 4 : 3));
      const m = meta(a[2]);
      if (kind === 'cleanup') return [3, 1, m];
      check(m[0] === 1 && m[1] === 1 && !(m[5] & 2));
      const e = rows(a[3]); check(e.length === m[3] - m[4]);
      return [3, 1, m, e];
    }
    check(kind === 'root');
    const a = array(input, 3, true);
    const h = tuple(a[0], [3, 1, 2, 2, 3, 3, 2, 2, 3, 3, 1, 3, 3, 1, 65, 64, 1, 31, 1023, 63, 2, 1, 5, 1]);
    const e = rows(a[1]), r = releases(a[2]);
    check(h[0] === 3 && h[1] === 1 && h[2] >= 1 && h[10] === 1 && !(h[18] & ~831));
    check((h[12] & ~h[11]) === 0 && (!(h[11] & 2) || (h[12] & 1)));
    check(h[2] !== 1 || (h[11] === 3 && h[12] === 3) || (h[18] & 256));
    check(h[20] === aggregate(r));
    if (h[4] !== 1) check(h[5] === 0 && h[8] === 0 && h[9] === 0 && (h[18] & 1));
    if (h[9]) check(h[8] > 0);
    if (h[4] === 1) {
      // Only the outer physicalRelease catch can leave a mandatory slot at0.
      if (h[8] === 0) check(h[9] === 0 && (h[18] & 8));
      if (h[9] === 0) check(h[18] & 8);
      if (h[5] === 0 && h[11] === 3 && h[12] === 3) check(h[18] & 256);
    }
    check(h[5] === 1 ? h[4] === 1 && h[6] > 0 : h[6] === 0);
    if (h[5] === 0) check(h[18] & (2 | 256));
    if (h[6] === 2 && !(h[18] & 4) && h[22]) check(!h[23] || (h[17] & 2));
    if (h[6] === 2 || h[5] === 2 || h[5] === 3) check(h[18] & 2);
    if (h[8] === 2 || h[8] === 3) check(h[18] & 8);
    if (h[9] === 2 || h[9] === 3) check(h[18] & 16);
    if (h[22]) {
      check(h[6] === 1 || h[8] === 1);
      facts(h[23], h[7], h[22], h[17], h[19], r);
    } else {
      check(h[7] === 0 && h[17] === 0 && h[19] === 0 && h[20] === 0 && h[23] === 0 && r.every(v => v === 0));
      if (h[8] === 1) check((h[18] & (4 | 8)) === (4 | 8));
    }
    if (h[6] === 1) {
      check(h[4] === 1 && h[5] === 1 && h[21] === 1 && h[23] === 1 && h[19] === 63 && h[22] !== 4);
      if (h[7] !== 1 || (h[17] & 2)) check(h[8] === 1);
    } else check(h[21] === 0 && h[13] === 0);
    if (h[13]) {
      check(h[6] === 1 && h[15] === e.length && h[14] === h[15] + h[16]);
      counts(h[23], h[22], h[14], h[16], h[17]);
    } else {
      check(h[3] === 0 && e.length === 0 && h[14] === 0 && h[15] === 0 && h[16] === 0);
      if (h[6] === 1) check(h[18] & (4 | 32));
    }
    const complete = h[2] === 1 && h[11] === 3 && h[12] === 3 && h[13] === 1 && h[6] === 1 &&
      h[23] === 1 && h[19] === 63 && h[7] === 1 && h[17] === 0 && h[18] === 0 && h[16] === 0 &&
      h[22] === 1 && h[8] === 1 && r.every(v => v === 1) && h[9] === 1;
    check(h[3] === (h[13] ? complete ? 2 : 1 : 0));
    return [h, e, r];
  } catch { return null; }
}

export function encodeTopicsRoot(input) {
  try {
    const root = projectTopicsEnvelope('root', input);
    if (!root) return null;
    const text = JSON.stringify(root) + '\n';
    return Buffer.byteLength(text, 'utf8') <= 24576 ? text : null;
  } catch { return null; }
}

export function createTopicsDiagnosticRun(deps = {}) {
  const clock = deps.clock ?? { set: (callback, ms) => setTimeout(callback, ms), clear: timer => clearTimeout(timer) };
  const write = deps.write ?? writeFile;
  const receipt = deps.receipt ?? (value => console.error(JSON.stringify(value)));
  let claimed = false;
  return async function run({ page, output, operation }) {
    if (claimed) throw new Error('Topics diagnostic unavailable');
    claimed = true;
    const h = Array(24).fill(0); h[0] = 3; h[1] = 1; h[10] = 1;
    let release = [0, 0, 0, 0, 0, 0], events = [], accepted = null, handle;
    let cleanupDispatched = false, disposeDispatched = false, afterDispatched = false, phase = 0, accepting = true;
    let operationOpen = true, afterDecisionComplete = false, exactUnavailable = false;
    let operationFailed = false, originalThrownValue, localFailure = false;
    const fault = bit => { if (accepting) h[18] |= bit; };
    // This helper never mutates the run decision, including on late release.
    async function settle(action) {
      let timer, timerFault = false, result;
      try {
        const pending = Promise.resolve().then(action).then(value => ({ status: 1, value }), () => ({ status: 3 }));
        result = await Promise.race([pending, new Promise(resolve => {
          try { timer = clock.set(() => resolve({ status: 2 }), 10000); }
          catch { timerFault = true; resolve({ status: 3 }); }
        })]);
      } catch { result = { status: 3 }; }
      try { if (timer !== undefined) clock.clear(timer); } catch { timerFault = true; }
      return { ...result, timerFault };
    }
    const timely = result => { if (result.timerFault) fault(512); };
    function acceptMeta(m) {
      h[23] = m[0]; h[7] = m[1]; h[22] = m[2]; h[17] = m[5]; h[19] = m[6]; release = [...m[7]];
      h[20] = release.includes(2) ? 2 : 1;
    }
    async function physicalRelease(target, late) {
      if (!cleanupDispatched) {
        cleanupDispatched = true;
        const result = await settle(() => target.evaluate(capsule => capsule.cleanup()));
        if (!late) {
          timely(result); h[8] = result.status;
          if (result.status !== 1) fault(8);
          else {
            const value = projectTopicsEnvelope('cleanup', result.value);
            if (!value) fault(4 | 8);
            else {
              const m = value[2];
              if ((exactUnavailable && m[0] === 1 && !(m[5] & 2)) ||
                (accepted && ([0, 2, 3, 4, 6].some(i => m[i] !== accepted[i]) ||
                (m[5] & accepted[5]) !== accepted[5] || m[7].some((v, i) => v !== accepted[7][i])))) fault(4 | 8);
              else acceptMeta(m);
            }
          }
        }
      }
      if (!disposeDispatched) {
        disposeDispatched = true;
        const result = await settle(() => target.dispose());
        if (!late) { timely(result); h[9] = result.status; if (result.status !== 1) fault(16); }
      }
    }
    const mark = value => {
      try {
        if (!operationOpen || !accepting || ['click-entry', 'click-return', 'ready-entry', 'ready-return'][phase] !== value ||
          (phase === 2 && !afterDecisionComplete)) { fault(256); return; }
        phase++;
        if (phase === 1) h[11] |= 1;
        if (phase === 2) h[12] |= 1;
        if (phase === 3) h[11] |= 2;
        if (phase === 4) h[12] |= 2;
      } catch { fault(256); }
    };
    const afterClick = async () => {
      if (afterDispatched || !operationOpen || !accepting) { fault(256); return; }
      afterDispatched = true;
      try {
        if (phase !== 2) { fault(256); return; }
        if (!handle) { fault(2); return; }
        const result = await settle(() => handle.evaluate(capsule => capsule.afterClick()));
        if (!operationOpen) return;
        timely(result); h[5] = result.status;
        if (result.status !== 1) { fault(2); return; }
        const value = projectTopicsEnvelope('ack', result.value);
        if (!value || value.length === 2) {
          exactUnavailable = Boolean(value); h[6] = 2; fault(2 | (value ? 0 : 4)); return;
        }
        h[6] = 1; h[13] = 1; h[21] = 1;
        accepted = value[2]; events = value[3]; acceptMeta(accepted);
        h[14] = accepted[3]; h[15] = events.length; h[16] = accepted[4];
      } catch { if (operationOpen) fault(2 | 4); }
      finally { if (operationOpen) afterDecisionComplete = true; }
    };
    try {
      const pending = Promise.resolve().then(() => page.evaluateHandle(createTopicsBrowserCapsule));
      const result = await settle(() => pending); timely(result); h[4] = result.status;
      if (result.status === 1) handle = result.value;
      else {
        fault(1);
        void pending.then(late => physicalRelease(late, true), () => {}).catch(() => {});
      }
    } catch { fault(1); }
    const seam = { mark, afterClick };
    try { Object.freeze(seam); } catch { fault(256); }
    // Only the original operation is enclosed by this dedicated catch.
    try { await operation(seam); }
    catch (value) { operationFailed = true; originalThrownValue = value; }
    operationOpen = false;
    h[2] = operationFailed ? 2 : 1;
    if (afterDispatched && !afterDecisionComplete) fault(256);
    if (!afterDispatched) fault(2);
    if (!operationFailed && phase !== 4) fault(256);
    try { if (handle) await physicalRelease(handle, false); } catch { fault(8); }
    accepting = false;
    const complete = !operationFailed && phase === 4 && h[13] === 1 && h[7] === 1 && h[17] === 0 && h[18] === 0 &&
      h[16] === 0 && h[22] === 1 && h[8] === 1 && release.every(v => v === 1) && h[9] === 1;
    h[3] = h[13] ? complete ? 2 : 1 : 0;
    let text = null, reason = 1;
    try {
      const projected = projectTopicsEnvelope('root', [h, events, release]);
      if (!projected) h[18] |= 4;
      else { text = encodeTopicsRoot(projected); if (!text) h[18] |= 32; }
    } catch { h[18] |= 32; }
    if (!text) {
      localFailure = true;
      try {
        const fallback = [...h]; fallback[3] = 0; fallback[13] = 0; fallback[14] = 0; fallback[15] = 0; fallback[16] = 0;
        text = encodeTopicsRoot([fallback, [], release]);
      } catch { /* Both encoding failures stay secondary. */ }
    }
    localFailure ||= h[3] !== 2;
    // The decision and selected text are sealed; delivery can only fail locally.
    if (text) {
      const result = await settle(() => write(join(output, 'topics-initial-click.json'), text));
      if (result.timerFault) localFailure = true;
      if (result.status !== 1) { localFailure = true; reason = result.status === 2 ? 3 : 2; }
    } else { localFailure = true; reason = 4; }
    if (localFailure) {
      try { receipt([3, 1, 1, reason]); } catch { /* No recursive receipt. */ }
    }
    if (operationFailed) throw originalThrownValue;
    if (localFailure) throw new Error('Topics diagnostic unavailable');
  };
}
