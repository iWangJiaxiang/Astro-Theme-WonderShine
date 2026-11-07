import { writeFile } from 'node:fs/promises';
import { mediaTraceStages, mediaTraceCaps } from './media-disclosure-trace-contract.mjs';

const traceNamespace = 'studio-media-controller-trace-v2';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= mediaTraceCaps.numericMaximum;
const positive = value => count(value) && value > 0;
const traceRecordStages = ['entry', 'exit', 'render-requested', 'summary-ref-attach', 'summary-ref-detach'];
const traceKinds = ['mq', 'toggle', 'browse'];
const traceFaultCodes = [
  'clock', 'identity', 'expanded-read', 'disclosure-read', 'mql-read', 'details-read',
  'target-read', 'current-target-read', 'event-matches-read', 'toggle-state-read',
  'summary-parent-read', 'render-props-read', 'summary-clone', 'record', 'snapshot', 'global-install',
  'segment', 'callback',
];
const traceFaults = new Set(traceFaultCodes);
const segmentKeys = ['segmentId', 'stage', 'owner', 'sessionId', 'state', 'status', 'startedAt', 'endedAt', 'previousSegmentId', 'startAttempt', 'endAttempt', 'attempts', 'droppedRecords', 'records', 'faults', 'droppedFaults', 'historyBaseline'];
const recordBaseKeys = ['seq', 'timestamp', 'stage', 'kind', 'controllerId', 'refExpanded', 'currentMQLMatches', 'nodeId', 'connected', 'domOpen', 'targetId', 'currentTargetId', 'targetConnected', 'currentTargetConnected', 'currentTargetOpen', 'selfTarget', 'actualEventMatches', 'toggleOldState', 'toggleNewState'];
const traceCodes = { stages: traceRecordStages, kinds: traceKinds, faultCodes: traceFaultCodes, toggleStates: ['open', 'closed', null] };
const recordIds = new Set(['controllerId', 'nodeId', 'targetId', 'currentTargetId', 'callbackId', 'renderToken', 'summaryId', 'detailsId', 'previousCommittedRenderToken', 'previousCommittedDetailsId']);
const recordBooleans = new Set(['refExpanded', 'currentMQLMatches', 'connected', 'domOpen', 'targetConnected', 'currentTargetConnected', 'currentTargetOpen', 'selfTarget', 'actualEventMatches', 'renderRequestedOpen', 'detailsConnected', 'detailsOpen', 'previousCommittedRequestedOpen', 'previousCommittedDetailsConnected', 'previousCommittedDetailsOpen', 'requestedOpenChanged', 'detailsReplaced']);

// Validate before retaining. Only the Node archive owns historical segments; incoming
// RPC envelopes (at most two segments) and the browser's latest cache are transient.
function validateTrace(trace, owner, previous, incoming, nextStage, final) {
  const require = condition => { if (!condition) throw new Error('Invalid media controller trace contract'); };
  require(trace?.version === 2 && trace.owner === owner && positive(trace.sessionId));
  require(trace.idNamespace === traceNamespace && same(trace.plan, mediaTraceStages) && same(trace.caps, mediaTraceCaps));
  require(['available', 'partial'].includes(trace.status) && typeof trace.active === 'boolean');
  require(trace.saturated === undefined || typeof trace.saturated === 'boolean');
  if (trace.codes !== undefined) require(same(trace.codes, traceCodes));
  require(finite(trace.startedAt) && finite(trace.timestamp) && finite(trace.timeOrigin));
  require(trace.startedAt >= 0 && trace.timestamp >= trace.startedAt && trace.timeOrigin > 0);
  require(trace.active ? trace.stoppedAt === null : finite(trace.stoppedAt) && trace.stoppedAt >= trace.startedAt && trace.stoppedAt <= trace.timestamp);
  require(final ? !trace.active : trace.active);
  require(Array.isArray(trace.segments) && trace.segments.length === (nextStage ? 2 : 1));
  if (previous.sessionId !== null) {
    require(trace.sessionId === previous.sessionId && trace.timeOrigin === previous.timeOrigin && trace.startedAt === previous.startedAt);
    require(trace.timestamp >= previous.timestamp);
  }
  const segments = [...incoming];
  for (const segment of trace.segments) {
    require(segment && positive(segment.segmentId) && segment.owner === owner && segment.sessionId === trace.sessionId);
    require(Object.keys(segment).length === segmentKeys.length && segmentKeys.every(key => Object.hasOwn(segment, key)));
    require(mediaTraceStages.includes(segment.stage) && ['active', 'sealed', 'stopped'].includes(segment.state));
    require(['available', 'partial'].includes(segment.status));
    require(finite(segment.startedAt) && segment.startedAt >= trace.startedAt && segment.startedAt <= trace.timestamp);
    require(segment.state === 'active' ? segment.endedAt === null : finite(segment.endedAt) && segment.endedAt >= segment.startedAt && segment.endedAt <= trace.timestamp);
    require(count(segment.attempts) && count(segment.droppedRecords) && count(segment.droppedFaults));
    require(positive(segment.startAttempt) && count(segment.endAttempt) && segment.endAttempt === segment.startAttempt + segment.attempts - 1);
    require(Array.isArray(segment.records) && segment.records.length <= mediaTraceCaps.recordsPerSegment);
    require(Array.isArray(segment.faults) && segment.faults.length <= mediaTraceCaps.faultsPerSegment);
    require(segment.attempts === segment.records.length + segment.droppedRecords);
    require(segment.records.length === Math.min(segment.attempts, mediaTraceCaps.recordsPerSegment));
    require(segment.faults.every(code => traceFaults.has(code)));
    require(!segment.droppedFaults || segment.faults.length === mediaTraceCaps.faultsPerSegment);
    require(!(segment.droppedRecords || segment.droppedFaults || segment.faults.length) || segment.status === 'partial');
    let lastTimestamp = segment.startedAt;
    for (const [index, record] of segment.records.entries()) {
      require(record && record.seq === segment.startAttempt + index && traceRecordStages.includes(record.stage) && traceKinds.includes(record.kind));
      require(recordBaseKeys.every(key => Object.hasOwn(record, key)));
      const stageKeys = ['entry', 'exit'].includes(record.stage) ? ['callbackId'] : ['renderToken', 'renderRequestedOpen'];
      if (record.stage === 'summary-ref-attach') stageKeys.push('summaryId', 'detailsId', 'detailsConnected', 'detailsOpen', 'previousCommittedRenderToken', 'previousCommittedRequestedOpen', 'previousCommittedDetailsId', 'previousCommittedDetailsConnected', 'previousCommittedDetailsOpen', 'requestedOpenChanged', 'detailsReplaced');
      require(stageKeys.every(key => Object.hasOwn(record, key)) && Object.keys(record).length === recordBaseKeys.length + stageKeys.length);
      require(['entry', 'exit'].includes(record.stage) ? ['mq', 'toggle'].includes(record.kind) : record.kind === 'browse');
      require(record.timestamp === null ? segment.status === 'partial' : finite(record.timestamp) && record.timestamp >= lastTimestamp && record.timestamp <= (segment.endedAt ?? trace.timestamp));
      if (record.timestamp !== null) lastTimestamp = record.timestamp;
      for (const [key, value] of Object.entries(record)) {
        if (['seq', 'timestamp', 'stage', 'kind'].includes(key)) continue;
        if (recordIds.has(key)) require(value === null || positive(value));
        else if (recordBooleans.has(key)) require(value === null || typeof value === 'boolean');
        else if (['toggleOldState', 'toggleNewState'].includes(key)) require(value === null || value === 'open' || value === 'closed');
        else require(false);
      }
    }
    const existing = segments.findIndex(item => item.segmentId === segment.segmentId);
    if (existing >= 0) {
      const before = segments[existing];
      if (before.state !== 'active') require(same(before, segment));
      else {
        for (const key of ['segmentId', 'stage', 'owner', 'sessionId', 'startedAt', 'previousSegmentId', 'startAttempt', 'historyBaseline']) require(same(before[key], segment[key]));
        for (const key of ['attempts', 'endAttempt', 'droppedRecords', 'droppedFaults']) require(segment[key] >= before[key]);
        require(segment.records.length >= before.records.length && same(segment.records.slice(0, before.records.length), before.records));
        require(segment.faults.length >= before.faults.length && same(segment.faults.slice(0, before.faults.length), before.faults));
        require(before.status !== 'partial' || segment.status === 'partial');
      }
      // A duplicate sealed segment is compared but never re-archived.
      if (before.state === 'active') segments[existing] = segment;
    } else {
      require(!segments.some(item => item.state === 'active'));
      segments.push(segment);
    }
  }
  require(segments.length > 0 && segments.length <= mediaTraceCaps.segments);
  for (const [index, segment] of segments.entries()) {
    const prior = segments[index - 1];
    require(segment.stage === mediaTraceStages[index] && segment.segmentId === index + 1);
    require(segment.previousSegmentId === (prior?.segmentId ?? null));
    require(segment.historyBaseline === (index ? 'carried-within-session' : 'session-start-unknown'));
    require(segment.startAttempt === (prior ? prior.endAttempt + 1 : 1));
    require(prior ? segment.startedAt === prior.endedAt : segment.startedAt === trace.startedAt);
    require(segment.state === (index < segments.length - 1 ? 'sealed' : trace.active ? 'active' : 'stopped'));
  }
  const last = segments.at(-1);
  if (nextStage) {
    require(incoming.length > 0 && incoming.at(-1).stage === mediaTraceStages[mediaTraceStages.indexOf(nextStage) - 1]);
    require(trace.segments[0].segmentId === incoming.at(-1).segmentId && trace.segments[0].state === 'sealed');
    require(last.stage === nextStage && last.segmentId !== trace.segments[0].segmentId && last.state === 'active');
    require(segments.length === incoming.length + 1);
  } else require(segments.length === (incoming.length || 1) && trace.segments[0].segmentId === last.segmentId);
  if (!trace.active) require(last.endedAt === trace.stoppedAt);
  const totals = {
    attempts: 0, retainedRecords: 0, droppedRecords: 0,
    faultAttempts: 0, retainedFaults: 0, droppedFaults: 0,
  };
  for (const segment of segments) {
    totals.attempts += segment.attempts; totals.retainedRecords += segment.records.length;
    totals.droppedRecords += segment.droppedRecords;
    totals.retainedFaults += segment.faults.length; totals.droppedFaults += segment.droppedFaults;
  }
  totals.faultAttempts = totals.retainedFaults + totals.droppedFaults;
  require(trace.totals && Object.keys(trace.totals).length === Object.keys(totals).length);
  for (const [key, value] of Object.entries(totals)) require(count(value) && trace.totals[key] === value);
  require(totals.retainedRecords <= mediaTraceCaps.totalRecords && totals.retainedFaults <= mediaTraceCaps.totalFaults);
  require(!(trace.saturated || totals.faultAttempts || totals.droppedRecords || totals.droppedFaults || segments.some(segment => segment.status === 'partial')) || trace.status === 'partial');
  return segments;
}

function traceSaturated(trace, segments) {
  const maximum = mediaTraceCaps.numericMaximum;
  if (trace.saturated || trace.owner === maximum || trace.sessionId === maximum || Object.values(trace.totals).includes(maximum)) return true;
  for (const segment of segments) {
    if (['segmentId', 'startAttempt', 'endAttempt', 'attempts', 'droppedRecords', 'droppedFaults'].some(key => segment[key] === maximum)) return true;
    if (segment.records.some(record => Object.entries(record).some(([key, value]) => (key === 'seq' || recordIds.has(key)) && value === maximum))) return true;
  }
  return false;
}

// DOM IDs and controller-trace IDs are independent namespaces, not interchangeable refs.
const hook = '__mediaDisclosureDiagnostics';
const controllerTraceExpected = process.env.STUDIO_TEST_MEDIA_TRACE_EXPECTED === '1';
const caps = { events: 120, waits: 96, checkpoints: 16, failures: 24, animations: 4, mutationNodes: 8, previewSamples: 2, previewCandidates: 24, previewImageLayouts: 24, previewFaults: 8 };
let nextOwner = 0;

export function createMediaDisclosureDiagnostics({ page, reportPath, withTimeout }) {
  const owner = ++nextOwner;
  const report = {
    schemaVersion: 3, scope: 'checkUploads', limitation: 'DOM and optional test-build controller observations are not proof of a shared root cause; instrumentation may affect timing',
    controllerTraceExpectation: controllerTraceExpected ? 'expected' : 'not-enabled',
    previewSemantics: {
      predicate: 'Original some order, geometry, hit tests and body-scroll short circuit; matched computed before additional DOM reads',
      measurements: 'Candidate/body/footer rectangles and hits reused from predicate; candidate imageOrdinal is the zero-based original image-array position. atSampling context, hit roles and mediaLayout loaded flags/rectangles are read afterward, not an atomic snapshot or causal evidence',
      missing: 'Missing, partial or unavailable evidence is not success; skipped predicate body scroll is null, not zero; body absence preserves original true branch',
      limits: 'First 24 visited candidates and first 24 original image layouts per sample, at most 2 samples; counts distinguish dropped visited candidates, short-circuited unvisited candidates and droppedImageLayouts. Any truncation or sampling fault is partial and fails diagnostics; DOM only, not component state',
      layout: 'mediaLayout includes post-predicate start/end performance times, original image ordinals with newly read loaded flags/rectangles, upload disclosure open/rectangle and toolbar/filter/grid rectangles; missing elements are null, not inferred closed or zero',
      roles: ['img', 'media-card', 'footer', 'body', 'dialog', 'other', null],
      css: 'Only finite numeric px or unitless custom properties on documentElement; null means absent or unparseable, never an inferred zero',
    },
    previewSamples: [], previewAttempts: 0, droppedPreviewSamples: 0,
    codes: { roles: ['library-directory', 'picker-filter', 'sidebar', 'sidebar-backdrop'], playStates: ['idle', 'running', 'paused', 'finished'], mutationChange: { removed: -1, attribute: 0, added: 1 } },
    caps, installation: 'not-started', outcome: 'not-run', active: false,
    controllerTrace: {
      version: 2, status: controllerTraceExpected ? 'unavailable' : 'not-enabled', owner,
      idNamespace: traceNamespace, plan: [...mediaTraceStages], caps: { ...mediaTraceCaps }, codes: traceCodes,
      sessionId: null, timeOrigin: null, startedAt: null, stoppedAt: null, timestamp: null,
      active: null, saturated: false, totals: null, segments: [], boundaries: [], missing: [...mediaTraceStages],
      planStatus: controllerTraceExpected ? 'incomplete' : 'not-enabled',
      finalization: controllerTraceExpected ? 'not-attempted' : 'not-enabled',
      continuity: controllerTraceExpected ? 'not-established' : 'not-enabled',
      memory: 'Node owns at most 8 segments (2048 records/128 faults); browser latest envelope and in-flight RPC contain at most 2 segments (512 records/32 faults) each; report.browser omits the transient controllerTrace cache',
    },
    browser: null, waits: [], droppedWaits: 0, cleanup: {}, diagnosticFailures: [], droppedFailures: 0,
  };
  const errors = [];
  let active = false, nextWaitId = 0, operationFailed = false;
  const rotationRequests = new Set();
  const failure = (stage, error) => {
    if (report.diagnosticFailures.length < caps.failures) {
      report.diagnosticFailures.push({ stage });
      errors.push(error);
    } else report.droppedFailures++;
  };
  let traceFailed = false;
  const traceFailure = (stage, continuity = false) => {
    traceFailed = true;
    report.controllerTrace.status = 'partial';
    if (continuity) report.controllerTrace.continuity = 'unknown';
    failure(stage, new Error(`Media controller trace diagnostic failed: ${stage}`));
  };
  const attempt = async (stage, action) => {
    try { return await withTimeout(action, `Media disclosure diagnostic: ${stage}`); }
    catch (error) {
      failure(stage, error);
      if (controllerTraceExpected) traceFailure('controller-trace-rpc-continuity-unknown', true);
    }
  };
  const retainTrace = (trace, { nextStage, final = false } = {}) => {
    if (!controllerTraceExpected) return;
    const archive = report.controllerTrace;
    try {
      const segments = validateTrace(trace, owner, archive, archive.segments, nextStage, final);
      const partial = trace.status !== 'available' || segments.some(segment => segment.status !== 'available' || segment.faults.length || segment.droppedFaults || segment.droppedRecords);
      const saturated = traceSaturated(trace, segments);
      Object.assign(archive, {
        sessionId: trace.sessionId, timeOrigin: trace.timeOrigin, startedAt: trace.startedAt,
        stoppedAt: trace.stoppedAt, timestamp: trace.timestamp, active: trace.active,
        saturated: archive.saturated || saturated, totals: trace.totals, segments,
        boundaries: segments.slice(1).map((segment, index) => ({
          previousSegmentId: segments[index].segmentId, segmentId: segment.segmentId,
          from: segments[index].stage, to: segment.stage, timestamp: segment.startedAt,
          endAttempt: segments[index].endAttempt, startAttempt: segment.startAttempt,
        })),
        missing: mediaTraceStages.slice(segments.length),
      });
      if (archive.continuity === 'not-established') archive.continuity = 'known';
      if (partial || saturated) traceFailure(saturated ? 'controller-trace-numeric-saturation' : 'controller-trace-partial');
      archive.status = traceFailed ? 'partial' : 'available';
      if (final) archive.finalization = 'final-inactive-validated';
    } catch {
      traceFailure(final ? 'controller-trace-final-invalid' : 'controller-trace-invalid-or-unavailable', true);
      if (final) archive.finalization = 'invalid-or-unavailable';
    }
  };
  const retain = (data, options) => {
    if (!data) { retainTrace(undefined, options); return; }
    // Do not serialize the browser's latest transient envelope a second time.
    const { controllerTrace, ...domData } = data;
    report.browser = domData;
    retainTrace(controllerTrace, options);
    if (controllerTraceExpected && (domData.failures?.some(({ stage }) => stage.startsWith('controller-trace-')) || domData.droppedFailures)) {
      traceFailure('controller-trace-browser-fault');
    }
  };
  return {
    async install() {
      active = true; report.active = true; report.installation = 'attempted';
      const data = await attempt('install', () => page.evaluate(({ hook, caps, owner, controllerTraceExpected, tracePlan, traceCaps }) => {
        if (Object.hasOwn(window, hook)) throw new Error('Media diagnostic hook already exists');
        const ids = new WeakMap();
        let nextId = 0, enabled = true, observer;
        const listeners = [];
        let controllerAPI = null, controllerStarted = false;
        let expectedSessionId = null, expectedSegmentId = null, expectedStageIndex = 0;
        const rotationRequests = new Set();
        const data = {
          controllerTrace: { version: null, status: controllerTraceExpected ? 'unavailable' : 'not-enabled' },
          installed: false, identity: null, events: [], waits: [], checkpoints: [], failures: [],
          droppedEvents: 0, droppedWaits: 0, droppedCheckpoints: 0, droppedFailures: 0,
        };
        const id = node => {
          if (!node) return null;
          if (!ids.has(node)) ids.set(node, ++nextId);
          return ids.get(node);
        };
        const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
        const fault = stage => {
          if (data.failures.length < caps.failures) data.failures.push({ stage });
          else data.droppedFailures++;
        };
        const acceptControllerTrace = (trace, nextStage, final) => {
          const validCount = value => Number.isSafeInteger(value) && value >= 0 && value <= traceCaps.numericMaximum;
          const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
          if (trace?.version !== 2 || trace.owner !== owner || !validCount(trace.sessionId) || trace.sessionId === 0 ||
              trace.idNamespace !== 'studio-media-controller-trace-v2' ||
              !equal(trace.plan, tracePlan) || !equal(trace.caps, traceCaps) ||
              !['available', 'partial'].includes(trace.status) || trace.active !== !final ||
              !Array.isArray(trace.segments) || trace.segments.length !== (nextStage ? 2 : 1) ||
              !trace.totals || !['attempts', 'retainedRecords', 'droppedRecords', 'faultAttempts', 'retainedFaults', 'droppedFaults'].every(key => validCount(trace.totals[key]))) {
            throw new Error('Controller trace envelope invalid');
          }
          if (expectedSessionId !== null && trace.sessionId !== expectedSessionId) throw new Error('Controller trace session changed');
          for (const segment of trace.segments) {
            if (segment.owner !== owner || segment.sessionId !== trace.sessionId || !validCount(segment.segmentId) || !segment.segmentId ||
                !tracePlan.includes(segment.stage) || !['available', 'partial'].includes(segment.status) ||
                !Array.isArray(segment.records) || segment.records.length > traceCaps.recordsPerSegment ||
                !Array.isArray(segment.faults) || segment.faults.length > traceCaps.faultsPerSegment) throw new Error('Controller trace segment invalid');
          }
          const current = trace.segments.at(-1);
          if (nextStage) {
            if (trace.segments[0].segmentId !== expectedSegmentId || trace.segments[0].state !== 'sealed' ||
                trace.segments[0].stage !== tracePlan[expectedStageIndex] || current.segmentId === expectedSegmentId ||
                current.stage !== nextStage || current.state !== 'active') throw new Error('Controller trace rotation invalid');
          } else if (current.stage !== tracePlan[expectedStageIndex] ||
              (expectedSegmentId !== null && current.segmentId !== expectedSegmentId) ||
              current.state !== (final ? 'stopped' : 'active')) throw new Error('Controller trace current segment invalid');
          expectedSessionId = trace.sessionId; expectedSegmentId = current.segmentId;
          if (nextStage) expectedStageIndex++;
          // Replace, do not append: runtime and browser cache never archive history.
          data.controllerTrace = trace;
          if (trace.status !== 'available' || trace.segments.some(segment => segment.status !== 'available' || segment.faults.length || segment.droppedFaults || segment.droppedRecords)) fault('controller-trace-partial');
        };
        const exportControllerTrace = (nextStage, final = false) => {
          if (!controllerTraceExpected) return;
          try {
            if (!controllerAPI || (!controllerStarted && !final)) throw new Error('Controller trace not started');
            if (nextStage !== undefined) {
              if (final || nextStage !== tracePlan[expectedStageIndex + 1] || !tracePlan.includes(nextStage) || rotationRequests.has(nextStage)) throw new Error('Controller trace next stage invalid');
              rotationRequests.add(nextStage); // Record before invocation: a lost result is never retried.
            }
            const trace = nextStage === undefined ? controllerAPI.snapshot(owner) : controllerAPI.rotate(owner, expectedSessionId, expectedSegmentId, nextStage);
            acceptControllerTrace(trace, nextStage, final);
          } catch {
            // Never retry rotation or present a stale active cache as final evidence.
            data.controllerTrace = { version: 2, status: 'unavailable' };
            fault(final ? 'controller-trace-final-snapshot' : nextStage === undefined ? 'controller-trace-snapshot' : 'controller-trace-rotate');
          }
        };
        const queries = ['(max-width: 760px)', '(max-width: 1180px)'];
        const media = [];
        const context = () => ({
          timestamp: performance.now(), timeOrigin: performance.timeOrigin, docId: id(document),
          visibility: document.visibilityState === 'visible' ? 1 : document.visibilityState === 'hidden' ? 0 : -1,
          innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
          mql760: media[0]?.matches ?? null, mql1180: media[1]?.matches ?? null,
        });
        const selectors = ['.media-library .media-directory-disclosure', 'dialog.media-dialog[open] .media-filter-disclosure', '.sidebar', '.sidebar-backdrop'];
        const nodeState = (node, index) => {
          if (!node) return { role: index, nodeId: null, isConnected: false };
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const animations = node.getAnimations();
          const transform = style.transform === 'none' ? null : Array.from(new DOMMatrixReadOnly(style.transform).toFloat64Array(), numeric);
          return {
            role: index, nodeId: id(node), isConnected: node.isConnected, docId: id(node.ownerDocument),
            open: typeof node.open === 'boolean' ? node.open : null,
            openClass: node.classList.contains('open'), inert: node.inert, hidden: node.hidden,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
            transform, animationCount: animations.length, droppedAnimations: Math.max(0, animations.length - caps.animations),
            animations: animations.slice(0, caps.animations).map(animation => ({
              currentTime: numeric(animation.currentTime), startTime: numeric(animation.startTime),
              playbackRate: numeric(animation.playbackRate), pending: animation.pending,
              playState: ['idle', 'running', 'paused', 'finished'].indexOf(animation.playState),
            })),
          };
        };
        const snapshot = () => ({ ...context(), nodes: selectors.map((selector, index) => nodeState(document.querySelector(selector), index)) });
        const checkpoint = label => {
          if (!enabled) return;
          if (data.checkpoints.length >= caps.checkpoints) { data.droppedCheckpoints++; return; }
          try { data.checkpoints.push({ label, ...snapshot() }); } catch { fault('checkpoint'); }
        };
        const event = (kind, target = null, mutation = null) => {
          if (!enabled) return;
          if (data.events.length >= caps.events) { data.droppedEvents++; return; }
          try { data.events.push({ kind, targetId: id(target), mutation, ...snapshot() }); }
          catch { fault('event'); }
        };
        const waits = new Map();
        const previewSeen = new Set();
        // Publish before acquiring resources so partial installation can be cleaned up.
        window[hook] = {
          owner, checkpoint,
          sampleWait(waitId, node, matched, expected, target) {
            if (!enabled || !Number.isInteger(waitId)) return;
            try {
              let wait = waits.get(waitId);
              if (!wait) {
                if (waits.size >= caps.waits) { data.droppedWaits++; return; }
                wait = { waitId, target, expected, count: 0, matchCount: 0, first: null, last: null, outcome: 'pending' };
                waits.set(waitId, wait); data.waits.push(wait);
              }
              const sample = { ...context(), nodeId: id(node), isConnected: node?.isConnected ?? false, open: node?.open ?? null, matched };
              wait.count++; if (matched) wait.matchCount++;
              wait.first ??= sample; wait.last = sample;
            } catch { fault('wait-sample'); }
          },
          previewSample(target, loaded, sidebarReady) {
            if (!enabled || !loaded) return;
            for (const [suffix, capture] of [['first-loaded', true], ['ready', sidebarReady]]) {
              const label = `${target}-preview-${suffix}`;
              if (capture && !previewSeen.has(label)) { previewSeen.add(label); checkpoint(label); }
            }
          },
          export(waitId, outcome, nextTraceStage) {
            const wait = waits.get(waitId);
            if (wait) wait.outcome = outcome;
            exportControllerTrace(nextTraceStage);
            return data;
          },
          cleanup(kind) {
            enabled = false;
            if (kind === 'observer') {
              let status = 'completed';
              // Disconnect, stop and final snapshot are independent in this same RPC.
              try { observer?.disconnect(); } catch { status = 'failed'; fault('observer-disconnect'); }
              if (controllerTraceExpected) {
                try {
                  if (!controllerAPI || controllerAPI.stop(owner) !== true) throw new Error('Controller trace stop refused');
                  controllerStarted = false;
                } catch { status = 'failed'; fault('controller-trace-stop'); }
                exportControllerTrace(undefined, true);
                if (data.controllerTrace.status === 'unavailable') status = 'failed';
              }
              return { status, ...(controllerTraceExpected ? { controllerTrace: data.controllerTrace } : {}), failures: data.failures, droppedFailures: data.droppedFailures };
            }
            if (kind === 'listeners') {
              const failures = [];
              for (const [target, type, handler, capture] of listeners) {
                try { target.removeEventListener(type, handler, capture); } catch (error) { failures.push(error); }
              }
              if (failures.length) throw new AggregateError(failures, 'Media diagnostic listener cleanup failed');
            }
          },
        };
        // The cleanup hook is published before start, so later DOM setup failures cannot leak the session.
        if (controllerTraceExpected) {
          try {
            if (Object.hasOwn(window, '__studioMediaDisclosureTraceUnavailable')) throw new Error('Controller trace global collision');
            const api = window.__studioMediaDisclosureTrace;
            if (api?.version !== 2 || api.status !== 'ready' ||
                typeof api.start !== 'function' || typeof api.snapshot !== 'function' ||
                typeof api.rotate !== 'function' || typeof api.stop !== 'function') throw new Error('Controller trace API unavailable');
            controllerAPI = api;
            if (controllerAPI.start(owner) !== true) throw new Error('Controller trace start refused');
            controllerStarted = true;
            exportControllerTrace();
          } catch {
            data.controllerTrace = { version: 2, status: 'unavailable' };
            fault('controller-trace-start');
          }
        }
        const listen = (target, type, handler, capture = false) => {
          listeners.push([target, type, handler, capture]);
          target.addEventListener(type, handler, capture);
        };
        for (const [index, query] of queries.entries()) {
          const mql = matchMedia(query); media.push(mql);
          listen(mql, 'change', () => event(index === 0 ? 'mq760-change' : 'mq1180-change'));
        }
        listen(document, 'toggle', e => {
          if (e.target instanceof Element && e.target.matches('.media-directory-disclosure, .media-filter-disclosure')) event('toggle', e.target);
        }, true);
        listen(document, 'visibilitychange', () => event('visibility-change'));
        const relevant = '.media-directory-disclosure, .media-filter-disclosure, .sidebar, .sidebar-backdrop';
        observer = new MutationObserver(records => {
          if (!enabled) return;
          if (data.events.length >= caps.events) { data.droppedEvents++; return; }
          try {
            let attributes = 0, childLists = 0, open = 0, inert = 0, classes = 0, styles = 0, droppedNodes = 0;
            const nodes = [];
            const remember = (node, change) => {
              const role = node.matches('.media-directory-disclosure') ? 0 : node.matches('.media-filter-disclosure') ? 1 : node.matches('.sidebar') ? 2 : 3;
              if (nodes.length < caps.mutationNodes) nodes.push({ nodeId: id(node), role, change, isConnected: node.isConnected, open: typeof node.open === 'boolean' ? node.open : null });
              else droppedNodes++;
            };
            for (const record of records) {
              const target = record.target;
              if (record.type === 'attributes' && target instanceof Element && target.matches(relevant)) {
                attributes++; remember(target, 0);
                if (record.attributeName === 'open') open++;
                if (record.attributeName === 'inert') inert++;
                if (record.attributeName === 'class') classes++;
                if (record.attributeName === 'style') styles++;
              } else if (record.type === 'childList') {
                let relevantChange = false;
                for (const [list, change] of [[record.addedNodes, 1], [record.removedNodes, -1]]) {
                  for (const node of list) {
                    if (!(node instanceof Element)) continue;
                    if (node.matches(relevant)) { remember(node, change); relevantChange = true; }
                    for (const descendant of node.querySelectorAll(relevant)) { remember(descendant, change); relevantChange = true; }
                  }
                }
                if (relevantChange) childLists++;
              }
            }
            if (attributes || childLists) event('mutation', null, { attributes, childLists, open, inert, classes, styles, nodes, droppedNodes });
          } catch { fault('mutation'); }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'inert', 'class', 'style'] });
        data.identity = context(); data.installed = true; checkpoint('installed');
        exportControllerTrace();
        return data;
      }, { hook, caps, owner, controllerTraceExpected, tracePlan: [...mediaTraceStages], traceCaps: { ...mediaTraceCaps } }));
      retain(data);
      report.installation = data?.installed ? 'installed' : 'failed-or-partial';
      if (!data?.installed && !report.diagnosticFailures.length) failure('install-unavailable', new Error('Media diagnostic installation returned no state'));
    },
    recordPreview(target, result, unavailableStage = 'sample-unavailable') {
      // Synchronous Node cache only: no export RPC, disk write or active-hook dependency.
      report.previewAttempts++;
      try {
        const sample = result?.sample;
        const partial = sample?.status === 'partial' || (sample?.faults?.length ?? 0) > 0 || (sample?.droppedFaults ?? 0) > 0 || (sample?.droppedCandidates ?? 0) > 0 || (sample?.droppedImageLayouts ?? 0) > 0;
        const available = sample?.status === 'available' && !partial;
        if (report.previewSamples.length < caps.previewSamples) {
          report.previewSamples.push({
            attempt: report.previewAttempts, target: target === 'library' ? 'library' : 'picker',
            matched: typeof result?.matched === 'boolean' ? result.matched : null,
            sample: sample ?? { status: 'unavailable', faults: [unavailableStage === 'rpc-failed' ? 'rpc-failed' : 'sample-unavailable'], droppedFaults: 0 },
          });
        } else report.droppedPreviewSamples++;
        if (!available) failure(partial ? 'preview-sample-partial' : unavailableStage === 'rpc-failed' ? 'preview-rpc-failed' : 'preview-sample-unavailable', new Error('Media diagnostic preview evidence unavailable or partial'));
      } catch {
        failure('preview-record', new Error('Media diagnostic preview cache failed'));
      }
    },
    nextWait() {
      if (!active) return undefined;
      const waitId = ++nextWaitId;
      if (report.waits.length < caps.waits) report.waits.push({ waitId, outcome: 'pending', sampleStatus: 'not-exported' });
      else report.droppedWaits++;
      return waitId;
    },
    async endWait(waitId, outcome, { nextTraceStage } = {}) {
      if (!active) return;
      const wait = report.waits.find(wait => wait.waitId === waitId);
      if (wait) wait.outcome = outcome;
      if (outcome !== 'passed') operationFailed = true;
      const invalidStage = nextTraceStage !== undefined && (!mediaTraceStages.includes(nextTraceStage) ||
        (controllerTraceExpected && (nextTraceStage !== mediaTraceStages[report.controllerTrace.segments.length] || rotationRequests.has(nextTraceStage))));
      if (invalidStage) failure('controller-trace-stage-request', new Error('Invalid media controller trace stage request'));
      if (invalidStage && controllerTraceExpected) traceFailure('controller-trace-stage-request', true);
      // A failed operation never advances the semantic plan. This is the original export RPC.
      const nextStage = !invalidStage && outcome === 'passed' ? nextTraceStage : undefined;
      if (controllerTraceExpected && nextStage !== undefined) rotationRequests.add(nextStage);
      const data = await attempt('wait-export', () => page.evaluate(({ hook, waitId, outcome, owner, nextStage }) => {
        if (window[hook]?.owner !== owner) throw new Error('Active media diagnostic hook missing or not owned');
        return window[hook].export(waitId, outcome, nextStage);
      }, { hook, waitId, outcome, owner, nextStage }));
      retain(data, { nextStage });
      if (wait) wait.sampleStatus = data?.waits.some(sample => sample.waitId === waitId) ? 'exported' : data ? 'no-invocation-observed' : 'unavailable';
    },
    async snapshot(label) {
      if (!active) return;
      retain(await attempt(label, () => page.evaluate(({ hook, label, owner }) => {
        const state = window[hook];
        if (state?.owner !== owner) throw new Error('Active media diagnostic hook missing or not owned');
        state.checkpoint(label);
        return state.export();
      }, { hook, label, owner })));
    },
    async stop(outcome) {
      if (!active) return;
      report.outcome = outcome;
      try { await this.snapshot('stopping'); }
      finally {
        if (controllerTraceExpected) report.controllerTrace.finalization = 'attempted';
        // Each resource class and global deletion is attempted independently.
        for (const kind of ['observer', 'listeners', 'hook']) {
          const result = await attempt(`cleanup-${kind}`, () => page.evaluate(({ hook, kind, owner }) => {
            if (!Object.hasOwn(window, hook)) throw new Error('Media diagnostic cleanup hook missing');
            if (window[hook]?.owner !== owner) throw new Error('Refusing to clean up an unowned media diagnostic hook');
            if (kind === 'hook') {
              if (!delete window[hook]) throw new Error('Media diagnostic hook removal failed');
              return 'completed';
            }
            return window[hook].cleanup(kind) ?? 'completed';
          }, { hook, kind, owner }));
          report.cleanup[kind] = typeof result === 'string' ? result : result?.status ?? 'failed';
          if (kind === 'observer') {
            // Retain the final inactive envelope before listener/hook cleanup.
            if (controllerTraceExpected) retainTrace(result?.controllerTrace, { final: true });
            if (result && report.browser) {
              report.browser.failures = result.failures ?? report.browser.failures;
              report.browser.droppedFailures = result.droppedFailures ?? report.browser.droppedFailures;
            }
          }
          if (report.cleanup[kind] !== 'completed') {
            failure(`cleanup-${kind}-incomplete`, new Error('Media diagnostic cleanup incomplete'));
            if (controllerTraceExpected) traceFailure(`controller-trace-cleanup-${kind}`, true);
          }
        }
        active = false; report.active = false;
      }
      const archive = report.controllerTrace;
      if (controllerTraceExpected) {
        const completePlan = archive.segments.length === mediaTraceCaps.segments && archive.boundaries.length === mediaTraceStages.length - 1 && archive.missing.length === 0;
        archive.planStatus = outcome === 'passed' && !operationFailed && completePlan ? 'complete' : 'incomplete';
        if (archive.planStatus !== 'complete') traceFailure('controller-trace-incomplete-plan');
        if (archive.finalization !== 'final-inactive-validated' || archive.active !== false || !finite(archive.stoppedAt) || archive.segments.at(-1)?.state !== 'stopped') traceFailure('controller-trace-finalization-incomplete', true);
      }
      for (const { stage } of report.browser?.failures ?? []) {
        failure(`browser-${stage}`, new Error(`Media diagnostic browser stage failed: ${stage}`));
        if (controllerTraceExpected && stage.startsWith('controller-trace-')) traceFailure('controller-trace-browser-fault');
      }
      if (report.browser?.droppedFailures) {
        failure('browser-dropped-failures', new Error('Additional media diagnostic browser failures were dropped'));
        if (controllerTraceExpected) traceFailure('controller-trace-browser-dropped-failures');
      }
    },
    takeErrors() { return errors.splice(0); },
    async writeReport() {
      // Cached Node data remains writable even after page/browser destruction.
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    },
  };
}
