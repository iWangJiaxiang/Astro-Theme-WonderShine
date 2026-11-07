import { writeFile } from 'node:fs/promises';

const MAX = 2_147_483_647;
const BYTE_LIMIT = 32 * 1024;
const phases = ['collect', 'ready', 'query', 'trigger', 'dialog', 'option', 'confirm', 'closed', 'fallback', 'outcome'];
const browserPhases = ['collect', 'ready', 'outcome'];
const outcomes = ['passed', 'failed'];
const roles = ['other', 'root', 'trigger', 'summary', 'structured-toggle', 'details', 'structured-item', 'structured-body'];
const eventTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'toggle'];
const browserFaults = ['install', 'reuse', 'sample', 'event', 'ready', 'finalize', 'listener-cleanup', 'hook-cleanup', 'owner', 'nonfinite', 'saturation'];
const caps = { operations:1, ancestors:8, plan:8, events:24, path:8, samples:4, faults:8, bytes:BYTE_LIMIT };
let nextOwner = 0;

// Passed directly to evaluateHandle: every browser dependency stays inside this function.
export function collectSkillReveal({ selector, owner }) {
  const summaries = [];
  for (let node = document.querySelector(selector)?.parentElement; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) summaries.unshift(node.querySelector(':scope > summary'));
    if (node.classList.contains('structured-item')) {
      const toggle = node.querySelector(':scope > button.structured-toggle[aria-expanded="false"]');
      if (toggle) summaries.unshift(toggle);
    }
  }

  // Only diagnostics are guarded. Original selector/traversal exceptions above retain their identity.
  try {
    const hookName = '__studioSkillChooserDiagnostics', max = 2_147_483_647;
    if (!Number.isInteger(owner) || owner < 1 || owner > max) return summaries;
    if (Object.hasOwn(window, hookName)) {
      const previous = window[hookName];
      if (previous?.owner === owner && previous.data) {
        const old = previous.data;
        old.faultCount = Math.min(max, old.faultCount + 1);
        if (old.faults.length < 8) old.faults.push('reuse');
        else old.droppedFaults = Math.min(max, old.droppedFaults + 1);
        if (old.faultCount === max || old.droppedFaults === max) old.saturated = true;
      }
      return summaries;
    }
    const data = {
      installed:false, outcome:'pending', firstReadySeen:false, phase:'collect',
      actualTriggerIdentity:'unknown', samples:[], events:[], faults:[],
      sampleAttempts:0, droppedSamples:0, eligibleEvents:0, droppedEvents:0,
      droppedAncestors:0, droppedPlan:0, droppedPath:0,
      faultCount:0, droppedFaults:0, saturated:false,
    };
    const ids = new WeakMap(), listeners = [];
    let nextId = 0, enabled = true, recorder, originalRoot = null, listenerStatus = null;
    const fault = code => {
      if (data.faultCount < max) data.faultCount++;
      else data.saturated = true;
      if (data.faults.length < 8) data.faults.push(code);
      else if (data.droppedFaults < max) data.droppedFaults++;
      else data.saturated = true;
    };
    const saturation = () => {
      if (!data.saturated) { data.saturated = true; fault('saturation'); }
    };
    const add = (key, amount = 1) => {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > max - data[key]) {
        data[key] = max; saturation();
      } else data[key] += amount;
    };
    const id = node => {
      if (!node || (typeof node !== 'object' && typeof node !== 'function')) return null;
      if (!ids.has(node)) {
        if (nextId === max) { saturation(); return null; }
        ids.set(node, ++nextId);
      }
      return ids.get(node);
    };
    const coordinate = value => {
      if (!Number.isFinite(value)) { fault('nonfinite'); return null; }
      if (Math.abs(value) > 1_000_000) saturation();
      return Math.round(Math.max(-1_000_000, Math.min(1_000_000, value)) * 4) / 4;
    };
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x:coordinate(r.x), y:coordinate(r.y), width:coordinate(r.width), height:coordinate(r.height) };
    };
    const role = (node, currentRoot) => {
      if (!(node instanceof Element)) return 'other';
      if (node === originalRoot || node === currentRoot) return 'root';
      if (node.matches('button.choice-trigger')) return 'trigger';
      if (node.matches('summary')) return 'summary';
      if (node.matches('button.structured-toggle')) return 'structured-toggle';
      if (node instanceof HTMLDetailsElement) return 'details';
      if (node.classList.contains('structured-item')) return 'structured-item';
      if (node.classList.contains('structured-body')) return 'structured-body';
      return 'other';
    };
    const state = (node, currentRoot) => {
      if (!(node instanceof Element)) return null;
      const style = getComputedStyle(node), expanded = node.getAttribute('aria-expanded');
      return {
        id:id(node), role:role(node, currentRoot), connected:node.isConnected,
        hidden:node.hasAttribute('hidden'),
        visible:style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse',
        inert:!!node.closest('[inert]'), disabled:node.matches(':disabled'),
        expanded:expanded === 'true' ? true : expanded === 'false' ? false : null,
        open:node instanceof HTMLDetailsElement ? node.open : null, rect:rect(node),
      };
    };
    const ancestorFlags = node => {
      const style = getComputedStyle(node);
      return {
        cssHidden:style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0,
        hidden:node.hasAttribute('hidden'), inert:node.hasAttribute('inert'),
        closedDetails:node instanceof HTMLDetailsElement && !node.open,
      };
    };
    const structuralAncestor = node => node instanceof HTMLDetailsElement ||
      node.classList.contains('structured-item') || node.classList.contains('structured-body');
    const sample = (kind, matched = null) => {
      add('sampleAttempts');
      if (data.sampleAttempts > 4) { add('droppedSamples'); return; }
      try {
        const currentRoot = document.querySelector(selector), ancestors = [], plan = [];
        let droppedAncestors = 0, ancestorCount = 0, excludedAncestors = 0;
        const ancestorVisibility = { cssHidden:false, hidden:false, inert:false, closedDetails:false };
        for (let node = currentRoot?.parentElement; node; node = node.parentElement) {
          if (ancestorCount < max) ancestorCount++;
          else saturation();
          const flags = ancestorFlags(node);
          for (const key of Object.keys(ancestorVisibility)) ancestorVisibility[key] ||= flags[key];
          // Retain disclosure structure and every ancestor contributing a hidden/inert state.
          // Ordinary visible layout wrappers are counted, not mislabeled as truncated records.
          if (structuralAncestor(node) || Object.values(flags).some(Boolean)) {
            if (ancestors.length < 8) ancestors.push(state(node, currentRoot));
            else if (droppedAncestors < max) droppedAncestors++;
            else saturation();
          } else if (excludedAncestors < max) excludedAncestors++;
          else saturation();
        }
        const droppedPlan = Math.min(max, Math.max(0, summaries.length - 8));
        if (summaries.length - 8 > max) saturation();
        for (let index = 0; index < Math.min(8, summaries.length); index++) plan.push(state(summaries[index], currentRoot));
        add('droppedAncestors', droppedAncestors); add('droppedPlan', droppedPlan);
        const count = document.querySelectorAll(selector).length;
        if (count > max) saturation();
        data.samples.push({
          kind, matched, matchCount:Math.min(max, count), originalRoot:state(originalRoot, currentRoot),
          currentRoot:state(currentRoot, currentRoot),
          freshTrigger:state(currentRoot?.querySelector(':scope > .choice-trigger'), currentRoot),
          ancestors, ancestorCount, excludedAncestors, ancestorVisibility,
          plan, planCount:Math.min(max, summaries.length), droppedAncestors, droppedPlan,
        });
      } catch { fault('sample'); }
    };
    const cleanup = () => {
      enabled = false;
      let hookDeleted = false, ownerMatched = false;
      // Resource branches are independent; rollback removal is never retried at export.
      if (listenerStatus === null) {
        listenerStatus = true;
        for (const [type, handler] of listeners) {
          try { document.removeEventListener(type, handler, true); }
          catch { listenerStatus = false; fault('listener-cleanup'); }
        }
      }
      try {
        ownerMatched = window[hookName] === recorder && recorder.owner === owner;
        if (ownerMatched) {
          hookDeleted = delete window[hookName];
          hookDeleted = hookDeleted && !Object.hasOwn(window, hookName);
          if (!hookDeleted) fault('hook-cleanup');
        } else fault('owner');
      } catch { fault('hook-cleanup'); }
      return { listenersRemoved:listenerStatus, hookDeleted, ownerMatched };
    };
    recorder = {
      owner, data,
      firstReady(root, matched) {
        if (!enabled || data.firstReadySeen) return;
        data.firstReadySeen = true;
        try {
          if (root !== selector || (matched !== null && typeof matched !== 'boolean')) { fault('ready'); return; }
          data.phase = 'ready'; sample('first-ready', matched);
        } catch { fault('ready'); }
      },
      finalize(outcome) {
        try {
          if (!enabled) fault('finalize');
          data.outcome = outcome === 'passed' || outcome === 'failed' ? outcome : 'failed';
          if (outcome !== 'passed' && outcome !== 'failed') fault('finalize');
          data.phase = 'outcome'; sample('terminal');
        } catch { fault('finalize'); }
        // No failure while sampling may skip either cleanup branch.
        const status = cleanup();
        return { data, cleanup:status };
      },
    };
    try {
      originalRoot = document.querySelector(selector);
      // Own the hook before acquiring resources so partial installation can roll back.
      window[hookName] = recorder;
      if (window[hookName] !== recorder) throw new Error();
      const relevantDisclosure = (control, currentRoot) => {
        const parent = control?.parentElement;
        return !!parent && (parent instanceof HTMLDetailsElement || parent.classList.contains('structured-item')) &&
          (!!originalRoot && parent.contains(originalRoot) || !!currentRoot && parent.contains(currentRoot));
      };
      const handler = event => {
        if (!enabled) return;
        try {
          const target = event.target;
          if (!(target instanceof Element) || target.closest('dialog, .modal, .selection-dialog')) return;
          const currentRoot = document.querySelector(selector);
          const control = target.closest('summary, button.structured-toggle, button.choice-trigger');
          const planned = summaries.find(node => node && (node === target || node.contains(target))) || null;
          const disclosure = target instanceof HTMLDetailsElement &&
            (!!originalRoot && target.contains(originalRoot) || !!currentRoot && target.contains(currentRoot));
          if (!planned && !originalRoot?.contains(target) && !currentRoot?.contains(target) &&
              !disclosure && !relevantDisclosure(control, currentRoot)) return;
          add('eligibleEvents');
          if (data.eligibleEvents > 24) { add('droppedEvents'); return; }
          const fullPath = event.composedPath();
          // This is a fixed structural projection, not a prefix of the full composed path.
          const path = fullPath.filter(node => node === target || node === originalRoot || node === currentRoot ||
            node instanceof Element && (role(node, currentRoot) !== 'other' || node.hasAttribute('hidden') || node.hasAttribute('inert')));
          const droppedPath = Math.min(max, Math.max(0, path.length - 8));
          if (fullPath.length > max || path.length - 8 > max) saturation();
          add('droppedPath', droppedPath);
          data.events.push({
            type:event.type, phase:data.phase, trusted:event.isTrusted,
            captureDefaultPrevented:event.defaultPrevented, targetId:id(target), targetRole:role(target, currentRoot),
            originalRootId:id(originalRoot), currentRootId:id(currentRoot),
            control:state(planned || control || (disclosure ? target : null), currentRoot), planned:!!planned,
            path:path.slice(0, 8).map(id), pathCount:Math.min(max, fullPath.length),
            excludedPath:Math.min(max, fullPath.length - path.length), droppedPath,
            x:event.type === 'toggle' ? null : coordinate(event.clientX),
            y:event.type === 'toggle' ? null : coordinate(event.clientY),
          });
        } catch { fault('event'); }
      };
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'toggle']) {
        listeners.push([type, handler]);
        document.addEventListener(type, handler, { capture:true, passive:true });
      }
      data.installed = true;
      sample('collect');
    } catch {
      fault('install');
      cleanup();
      // Preserve a fault envelope, if possible, but never leave active listeners after rollback.
      try {
        if (!Object.hasOwn(window, hookName)) window[hookName] = recorder;
      } catch { /* Absence will be detected by the single terminal export. */ }
    }
  } catch { /* Diagnostics must never turn an original reveal into a UI failure. */ }
  return summaries;
}

// Passed directly to waitForFunction; the original query/predicate executes first.
export function skillChooserReady({ root, owner }) {
  const el = document.querySelector(root);
  const matched = el && !el.querySelector('fieldset:disabled, button.choice-trigger:disabled');
  try {
    const hook = window.__studioSkillChooserDiagnostics;
    if (hook?.owner === owner) hook.firstReady(root, matched);
  } catch { /* Missing/failed first-ready capture is audited from the terminal envelope. */ }
  return matched;
}

// Closed, recursive schemas reject unknown fields instead of trying to scrub private data.
const bool = value => typeof value === 'boolean';
const integer = value => Number.isInteger(value) && value >= 0 && value <= MAX;
const localId = value => integer(value) && value > 0;
const enumeration = values => value => values.includes(value);
const nullable = check => value => value === null || check(value);
const list = (check, limit) => value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= limit &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length:value.length }, (_, index) => Object.hasOwn(value, index) && check(value[index])).every(Boolean);
const shape = fields => value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === Object.keys(fields).length &&
  Reflect.ownKeys(value).every(key => Object.hasOwn(fields, key)) &&
  Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const coordinate = value => Number.isFinite(value) && Math.abs(value) <= 1_000_000 && Number.isInteger(value * 4);
const rectangle = shape({ x:nullable(coordinate), y:nullable(coordinate), width:nullable(coordinate), height:nullable(coordinate) });
const nodeState = nullable(shape({
  id:nullable(localId), role:enumeration(roles), connected:bool, hidden:bool, visible:bool, inert:bool,
  disabled:bool, expanded:nullable(bool), open:nullable(bool), rect:rectangle,
}));
const sampleSchema = shape({
  kind:enumeration(['collect', 'first-ready', 'terminal']), matched:nullable(bool), matchCount:integer,
  originalRoot:nodeState, currentRoot:nodeState, freshTrigger:nodeState,
  ancestors:list(nodeState, 8), ancestorCount:integer, excludedAncestors:integer,
  ancestorVisibility:shape({ cssHidden:bool, hidden:bool, inert:bool, closedDetails:bool }),
  plan:list(nodeState, 8), planCount:integer, droppedAncestors:integer, droppedPlan:integer,
});
const eventSchema = shape({
  type:enumeration(eventTypes), phase:enumeration(browserPhases), trusted:bool, captureDefaultPrevented:bool,
  targetId:nullable(localId), targetRole:enumeration(roles), originalRootId:nullable(localId), currentRootId:nullable(localId),
  control:nodeState, planned:bool, path:list(nullable(localId), 8), pathCount:integer, excludedPath:integer, droppedPath:integer,
  x:nullable(coordinate), y:nullable(coordinate),
});
const dataSchema = shape({
  installed:bool, outcome:enumeration(['pending', ...outcomes]), firstReadySeen:bool, phase:enumeration(browserPhases),
  actualTriggerIdentity:enumeration(['unknown']), samples:list(sampleSchema, 4), events:list(eventSchema, 24),
  faults:list(enumeration(browserFaults), 8), sampleAttempts:integer, droppedSamples:integer,
  eligibleEvents:integer, droppedEvents:integer, droppedAncestors:integer, droppedPlan:integer, droppedPath:integer,
  faultCount:integer, droppedFaults:integer, saturated:bool,
});
const cleanupSchema = shape({ listenersRemoved:bool, hookDeleted:bool, ownerMatched:bool });
const envelopeSchema = shape({ data:() => true, cleanup:() => true });

export function createSkillChooserDiagnostics({ page, reportPath, withTimeout }) {
  const report = {
    schemaVersion:1, scope:'single-skill-chooser', caps, actualTriggerIdentity:'unknown',
    projection:{ ancestors:'disclosure-or-hidden-inert', path:'target-root-controls-disclosures-hidden-inert' },
    outcome:'not-run', status:'not-run', complete:false, owner:null, nodeStage:'collect',
    enteredStages:Object.fromEntries(phases.map(phase => [phase, false])),
    readiness:{ firstInvocationObserved:false, waitReturned:false },
    faultAccounting:{ order:'node-before-export-then-browser-then-node', attempts:0, retained:0, dropped:0 },
    exportStatus:'not-attempted', browser:null,
    cleanup:{ listeners:'not-attempted', hook:'not-attempted', ownerEnded:null, release:'not-started' },
    faults:[], faultCount:0, droppedFaults:0, saturated:false,
    limitations:[
      'Read-only style/geometry sampling and passive capture can affect timing; this is not an uninstrumented schedule.',
      'One new terminal export/cleanup RPC precedes the original failure screenshot; its 2s timeout does not cancel it. No retry.',
      'Fresh queries, event targets and terminal rectangles are not the retained trigger or original click geometry. Visibility flags are local computed style, not clickability.',
      'Capture defaultPrevented is dispatch-time only. No modal, React, mutation or native input instrumentation; bounded evidence is not root-cause proof.',
      'Lost exports leave cleanup unknown until existing browser-owner destruction is observed; destruction never repairs export or capture faults.',
    ],
  };
  const errors = [];
  let begun = false, finished = false, ownerNoted = false, browserComplete = false;
  const fail = code => {
    if (report.faultCount < MAX) report.faultCount++;
    else report.saturated = true;
    const retainedBrowserFaults = report.browser?.faults.length ?? 0;
    if (report.faults.length + retainedBrowserFaults < caps.faults) {
      report.faults.push(code);
      const error = new Error(code); error.code = code;
      errors.push(error);
    } else {
      if (report.droppedFaults < MAX) report.droppedFaults++;
      else report.saturated = true;
      // A drained error queue must not hide a later fault when the archive is full.
      if (errors.length === 0) {
        const error = new Error('SKILL_DIAGNOSTICS_FAULT_BUDGET');
        error.code = 'SKILL_DIAGNOSTICS_FAULT_BUDGET';
        errors.push(error);
      }
    }
    report.complete = false;
    if (begun) report.status = 'incomplete';
  };
  const refresh = () => {
    // Each context is bounded by MAX; their sum remains an exact safe integer.
    const browser = report.browser;
    report.faultAccounting.attempts = report.faultCount + (browser?.faultCount ?? 0);
    report.faultAccounting.retained = report.faults.length + (browser?.faults.length ?? 0);
    report.faultAccounting.dropped = report.droppedFaults + (browser?.droppedFaults ?? 0);
    report.complete = begun && finished && browserComplete && report.faultCount === 0 &&
      report.cleanup.listeners === 'confirmed' && report.cleanup.hook === 'confirmed' && report.cleanup.ownerEnded === true;
    report.status = !begun ? 'not-run' : report.faultCount ? 'incomplete' : report.complete ? 'complete' :
      finished ? 'awaiting-owner' : 'active';
  };
  const audit = data => {
    // Structural validity is not completeness. Failed capture attempts must not look like zero work.
    const kinds = data.samples.map(sample => sample.kind);
    const required = kinds.length === 3 && kinds[0] === 'collect' && kinds[1] === 'first-ready' && kinds[2] === 'terminal';
    const ancestorDrops = data.samples.reduce((total, sample) => total + sample.droppedAncestors, 0);
    const planDrops = data.samples.reduce((total, sample) => total + sample.droppedPlan, 0);
    const pathDrops = data.events.reduce((total, event) => total + event.droppedPath, 0);
    const countersConsistent = data.sampleAttempts === data.samples.length + data.droppedSamples &&
      data.eligibleEvents === data.events.length + data.droppedEvents &&
      data.faultCount === data.faults.length + data.droppedFaults &&
      data.droppedAncestors === ancestorDrops && data.droppedPlan === planDrops && data.droppedPath === pathDrops &&
      data.samples.every(sample => sample.ancestorCount === sample.ancestors.length + sample.excludedAncestors + sample.droppedAncestors &&
        sample.planCount === sample.plan.length + sample.droppedPlan) &&
      data.events.every(event => event.pathCount === event.path.length + event.excludedPath + event.droppedPath);
    if (!countersConsistent) fail('SKILL_DIAGNOSTICS_COUNTERS');
    if (data.faultCount || data.saturated) fail('SKILL_DIAGNOSTICS_BROWSER_FAULT');
    if (data.droppedSamples || data.droppedEvents || data.droppedAncestors || data.droppedPlan || data.droppedPath || data.droppedFaults) {
      fail('SKILL_DIAGNOSTICS_DROPPED');
    }
    if (!data.installed || !data.firstReadySeen || !required || data.outcome !== report.outcome || data.phase !== 'outcome') {
      fail('SKILL_DIAGNOSTICS_INCOMPLETE');
    }
    browserComplete = countersConsistent && data.installed && data.firstReadySeen && required &&
      data.outcome === report.outcome && data.phase === 'outcome' && !data.faultCount && !data.saturated &&
      !data.droppedSamples && !data.droppedEvents && !data.droppedAncestors && !data.droppedPlan && !data.droppedPath && !data.droppedFaults;
  };
  return {
    begin() {
      if (begun) { fail('SKILL_DIAGNOSTICS_REUSED'); return { owner:report.owner }; }
      begun = true;
      if (nextOwner === MAX || ownerNoted) fail('SKILL_DIAGNOSTICS_OWNER');
      else report.owner = ++nextOwner;
      report.outcome = 'pending'; report.enteredStages.collect = true;
      refresh();
      return { owner:report.owner };
    },
    phase(phase) {
      if (!begun || finished || !phases.includes(phase)) { fail('SKILL_DIAGNOSTICS_PHASE'); return; }
      report.nodeStage = phase; report.enteredStages[phase] = true;
      if (phase === 'ready') report.readiness.waitReturned = true;
    },
    async finish(outcome) {
      if (finished) { fail('SKILL_DIAGNOSTICS_FINISH_REUSED'); return; }
      finished = true;
      if (!begun) { fail('SKILL_DIAGNOSTICS_NOT_BEGUN'); return; }
      if (!outcomes.includes(outcome)) { fail('SKILL_DIAGNOSTICS_OUTCOME'); outcome = 'failed'; }
      report.outcome = outcome; report.nodeStage = 'outcome'; report.enteredStages.outcome = true;
      report.cleanup.listeners = 'unknown'; report.cleanup.hook = 'unknown'; report.cleanup.release = 'unknown';
      try {
        if (ownerNoted || !localId(report.owner)) { fail('SKILL_DIAGNOSTICS_OWNER'); return; }
        report.exportStatus = 'attempted';
        let envelope;
        try {
          envelope = await withTimeout(() => page.evaluate(({ owner, outcome }) => {
            const hook = window.__studioSkillChooserDiagnostics;
            if (!hook || hook.owner !== owner) {
              return { data:null, cleanup:{ listenersRemoved:false, hookDeleted:false, ownerMatched:false } };
            }
            return hook.finalize(outcome);
          }, { owner:report.owner, outcome }), 'Skill chooser diagnostics terminal export', 2_000);
        } catch {
          report.exportStatus = 'unknown'; fail('SKILL_DIAGNOSTICS_EXPORT');
          return;
        }
        const validEnvelope = envelopeSchema(envelope);
        // Cleanup is audited independently even when the envelope/data is rejected.
        if (cleanupSchema(envelope?.cleanup)) {
          const status = envelope.cleanup;
          report.cleanup.listeners = status.ownerMatched && status.listenersRemoved ? 'confirmed' : 'failed';
          report.cleanup.hook = status.ownerMatched && status.hookDeleted ? 'confirmed' : 'failed';
          if (report.cleanup.listeners === 'confirmed' && report.cleanup.hook === 'confirmed') report.cleanup.release = 'listeners-removed';
          else fail('SKILL_DIAGNOSTICS_CLEANUP');
        } else fail('SKILL_DIAGNOSTICS_CLEANUP_SCHEMA');
        if (!validEnvelope) { report.exportStatus = 'rejected'; fail('SKILL_DIAGNOSTICS_ENVELOPE'); return; }
        if (!dataSchema(envelope.data)) { report.exportStatus = 'rejected'; fail('SKILL_DIAGNOSTICS_DATA'); return; }
        if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > BYTE_LIMIT) {
          report.exportStatus = 'rejected'; fail('SKILL_DIAGNOSTICS_SIZE'); return;
        }
        const availableFaults = Math.max(0, caps.faults - report.faults.length);
        const omittedFaults = Math.max(0, envelope.data.faults.length - availableFaults);
        report.browser = {
          ...envelope.data,
          faults:envelope.data.faults.slice(0, availableFaults),
          droppedFaults:Math.min(MAX, envelope.data.droppedFaults + omittedFaults),
          saturated:envelope.data.saturated || envelope.data.droppedFaults + omittedFaults > MAX,
        };
        report.exportStatus = 'received';
        report.readiness.firstInvocationObserved = report.browser.firstReadySeen;
        audit(report.browser);
      } catch {
        // No raw protocol/browser error is retained or allowed to replace the original chooser error.
        if (report.exportStatus === 'attempted') report.exportStatus = 'rejected';
        fail('SKILL_DIAGNOSTICS_VALIDATION');
      } finally {
        if (report.cleanup.listeners !== 'confirmed' || report.cleanup.hook !== 'confirmed') fail('SKILL_DIAGNOSTICS_CLEANUP_UNKNOWN');
        refresh();
      }
    },
    noteBrowserOwner(ended) {
      if (ownerNoted) { fail('SKILL_DIAGNOSTICS_OWNER_REUSED'); return; }
      ownerNoted = true;
      if (typeof ended !== 'boolean') { fail('SKILL_DIAGNOSTICS_OWNER'); refresh(); return; }
      report.cleanup.ownerEnded = ended;
      if (begun && !ended) fail('SKILL_DIAGNOSTICS_OWNER');
      if (begun && ended && (report.cleanup.listeners !== 'confirmed' || report.cleanup.hook !== 'confirmed')) {
        report.cleanup.release = 'process-destroyed';
        fail('SKILL_DIAGNOSTICS_PROCESS_RELEASE_ONLY');
      }
      refresh();
    },
    takeErrors() { return errors.splice(0); },
    async writeReport() {
      // Cached Node state only. A persistence failure may have no writable artifact;
      // the caller's final error drain remains the authoritative failure signal.
      try {
        if (begun && (!finished || !ownerNoted)) fail('SKILL_DIAGNOSTICS_LIFECYCLE');
        refresh();
        let serialized = JSON.stringify(report) + '\n';
        if (Buffer.byteLength(serialized, 'utf8') > BYTE_LIMIT) {
          // Keep bounded browser fault accounting when rejecting bulky geometry/events.
          if (report.browser) report.browser = {
            faultCount:report.browser.faultCount, faults:report.browser.faults,
            droppedFaults:report.browser.droppedFaults, saturated:report.browser.saturated,
          };
          browserComplete = false; report.exportStatus = 'rejected';
          fail('SKILL_DIAGNOSTICS_SIZE'); refresh();
          serialized = JSON.stringify(report) + '\n';
        }
        if (Buffer.byteLength(serialized, 'utf8') > BYTE_LIMIT) throw new Error();
        await writeFile(reportPath, serialized);
        return true;
      } catch {
        fail('SKILL_DIAGNOSTICS_WRITE'); refresh();
        return false;
      }
    },
  };
}
