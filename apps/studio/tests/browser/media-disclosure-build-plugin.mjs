import { fileURLToPath } from 'node:url';
import { mediaTraceStages, mediaTraceCaps } from './media-disclosure-trace-contract.mjs';

const virtualId = 'virtual:studio-test-media-disclosure-trace';
const resolvedVirtualId = `\0${virtualId}`;
const target = fileURLToPath(new URL('../../src/components/MediaBrowser.tsx', import.meta.url)).replaceAll('\\', '/');
const traceName = '__studioMediaDisclosureTraceController';
const createName = '__studioCreateMediaDisclosureTracer';

// These are deliberately exact, multiline source sentinels, not a general TS transform.
const declaration = `    const narrowLayout = window.matchMedia("(max-width: 760px)");
    const browseExpanded = ref(!narrowLayout.matches);
    const browseDisclosure = ref<HTMLDetailsElement>();`;
const layout = `    function layoutChanged(event: MediaQueryListEvent) {
      const disclosure = browseDisclosure.value;
      if (event.matches && disclosure?.contains(document.activeElement))
        disclosure.querySelector("summary")?.focus({ preventScroll: true });
      if (disclosure) disclosure.open = !event.matches;
      browseExpanded.value = !event.matches;
    }`;
const toggle = `      onToggle: domEvent(($event: Event) => {
        if ($event.target !== $event.currentTarget) return;
        browseExpanded.value = ($event.currentTarget as HTMLDetailsElement).open;
      }),`;
const library = `            ? element(
                "details",
                {
                  ...browseDisclosureProps(),
                  className: classes("media-directory-disclosure"),
                },
                element(
                  "summary",
                  null,`;
const picker = `              ? element(
                  "details",
                  {
                    ...browseDisclosureProps(),
                    className: classes("media-filter-disclosure"),
                  },
                  element(
                    "summary",
                    null,`;

// Serialized into the virtual module. No project runtime import or UI mutation.
function installRuntime(cloneElement, untracked, plan, caps) {
  const key = '__studioMediaDisclosureTrace';
  const unavailableKey = '__studioMediaDisclosureTraceUnavailable';
  const { recordsPerSegment: limit, faultsPerSegment: faultLimit, numericMaximum: maximum } = caps;
  const faultCodes = [
    'clock', 'identity', 'expanded-read', 'disclosure-read', 'mql-read', 'details-read',
    'target-read', 'current-target-read', 'event-matches-read', 'toggle-state-read',
    'summary-parent-read', 'render-props-read', 'summary-clone', 'record', 'snapshot', 'global-install',
    'segment', 'callback',
  ];
  const stages = ['entry', 'exit', 'render-requested', 'summary-ref-attach', 'summary-ref-detach'];
  const kinds = ['mq', 'toggle', 'browse'];
  const nodeIds = new WeakMap(), controllerIds = new WeakMap(), renderIds = new WeakMap(), callbackIds = new WeakMap();
  let nextNode = 0, nextController = 0, nextRender = 0, nextCallback = 0, nextSession = 0;
  let session = null, available = false, callbackDepth = 0;
  const increment = value => {
    if (value >= maximum - 1) {
      // A sticky flag fails strict validation without recursively incrementing faults.
      if (session) session.saturated = true;
      return maximum;
    }
    return value + 1;
  };
  const fault = code => {
    try {
      // Snapshot reads after stop must still make the returned evidence partial.
      if (!session) return;
      const { segment, totals } = session;
      totals.faultAttempts = increment(totals.faultAttempts);
      if (segment.faults.length < faultLimit && totals.retainedFaults < caps.totalFaults) {
        segment.faults.push(faultCodes.includes(code) ? code : 'record');
        totals.retainedFaults = increment(totals.retainedFaults);
      } else {
        segment.droppedFaults = increment(segment.droppedFaults);
        totals.droppedFaults = increment(totals.droppedFaults);
      }
    } catch { /* Diagnostics must never escape into UI callbacks. */ }
  };
  const read = (code, getter, fallback = null) => {
    try { return untracked(getter); } catch { fault(code); return fallback; }
  };
  const boolean = value => typeof value === 'boolean' ? value : null;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const clock = () => read('clock', () => numeric(performance.now()));
  const identity = (map, value, kind) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    return read('identity', () => {
      if (!map.has(value)) {
        let id;
        if (kind === 'node') { nextNode = increment(nextNode); id = nextNode; }
        if (kind === 'controller') { nextController = increment(nextController); id = nextController; }
        if (kind === 'render') { nextRender = increment(nextRender); id = nextRender; }
        if (kind === 'callback') { nextCallback = increment(nextCallback); id = nextCallback; }
        if (id === maximum) { fault('identity'); return null; }
        map.set(value, id);
      }
      return map.get(value);
    });
  };
  const nodeState = node => ({
    nodeId: identity(nodeIds, node, 'node'),
    connected: node ? read('details-read', () => boolean(node.isConnected)) : null,
    domOpen: node ? read('details-read', () => boolean(node.open)) : null,
  });
  const toggleState = value => value === 'open' || value === 'closed' ? value : null;
  const createSegment = (segmentId, startedAt, startAttempt) => ({
    segmentId, stage: plan[segmentId - 1], owner: session.owner, sessionId: session.id,
    state: 'active', status: 'available', startedAt, endedAt: null,
    previousSegmentId: segmentId === 1 ? null : segmentId - 1,
    startAttempt, endAttempt: session.totals.attempts,
    attempts: 0, droppedRecords: 0, records: [], faults: [], droppedFaults: 0,
    historyBaseline: segmentId === 1 ? 'session-start-unknown' : 'carried-within-session',
  });
  const copySegment = segment => ({
    ...segment,
    status: segment.faults.length || segment.droppedFaults || segment.droppedRecords ? 'partial' : 'available',
    records: segment.records.map(record => ({ ...record })),
    faults: [...segment.faults],
  });
  const envelope = (timestamp, segments) => ({
    version: 2,
    status: session.saturated || session.totals.faultAttempts || session.totals.droppedRecords || session.totals.droppedFaults ? 'partial' : 'available',
    owner: session.owner, active: session.active, sessionId: session.id,
    idNamespace: 'studio-media-controller-trace-v2',
    startedAt: session.startedAt, stoppedAt: session.stoppedAt,
    timestamp, timeOrigin: session.timeOrigin,
    caps: { ...caps }, plan: [...plan], saturated: session.saturated,
    codes: { stages: [...stages], kinds: [...kinds], faultCodes: [...faultCodes], toggleStates: ['open', 'closed', null] },
    totals: { ...session.totals }, segments,
  });
  const snapshot = owner => {
    if (!session || session.owner !== owner) return null;
    try {
      // Read first: any diagnostic fault must be included in this very snapshot.
      const timestamp = clock();
      return envelope(timestamp, [copySegment(session.segment)]);
    } catch { fault('snapshot'); return null; }
  };
  const api = {
    version: 2, status: 'ready',
    start(owner) {
      if (!Number.isSafeInteger(owner) || owner <= 0 || owner > maximum) return false;
      // A stopped owner's last snapshot remains readable, but cannot stop another session.
      if (session?.active) return session.owner === owner;
      if (nextSession >= maximum - 1) return false;
      session = {
        id: ++nextSession, owner, active: true, startedAt: null, stoppedAt: null, timeOrigin: null,
        saturated: false,
        totals: { attempts: 0, retainedRecords: 0, droppedRecords: 0, faultAttempts: 0, retainedFaults: 0, droppedFaults: 0 },
        segment: null,
      };
      session.segment = createSegment(1, null, 1);
      session.startedAt = session.segment.startedAt = clock();
      session.timeOrigin = read('clock', () => numeric(performance.timeOrigin));
      return true;
    },
    snapshot,
    rotate(owner, expectedSessionId, expectedSegmentId, nextStage) {
      const reject = code => {
        fault(code);
        throw new Error('Media disclosure trace rotation refused');
      };
      if (!session || session.owner !== owner || !session.active ||
          session.id !== expectedSessionId || session.segment.segmentId !== expectedSegmentId) reject('segment');
      if (callbackDepth !== 0) reject('callback');
      const current = session.segment;
      if (current.state !== 'active' || session.saturated || current.segmentId >= caps.segments ||
          current.segmentId >= plan.length || nextStage !== plan[current.segmentId]) reject('segment');
      // Attribute boundary clock faults to the segment being sealed, not its successor.
      const timestamp = clock();
      const startAttempt = increment(session.totals.attempts);
      if (session.saturated) reject('segment');
      const sealed = copySegment(current);
      sealed.state = 'sealed';
      sealed.endedAt = timestamp;
      const next = createSegment(current.segmentId + 1, timestamp, startAttempt);
      // Only the active segment is retained. The collector owns its sealed copy.
      session.segment = next;
      return envelope(timestamp, [sealed, copySegment(next)]);
    },
    stop(owner) {
      if (!session || session.owner !== owner) return false;
      if (!session.active) return true;
      const idle = callbackDepth === 0;
      if (!idle) fault('callback');
      const timestamp = clock();
      session.segment.state = 'stopped';
      session.segment.endedAt = session.stoppedAt = timestamp;
      session.active = false;
      // A non-idle stop still stops capture, but cannot claim a clean boundary.
      return idle;
    },
  };
  try {
    if (Object.hasOwn(globalThis, key) || Object.hasOwn(globalThis, unavailableKey)) {
      // Do not adopt, replace or invoke an unknown global, even if its version matches.
      Object.defineProperty(globalThis, unavailableKey, { value: true, configurable: false, writable: false });
    } else {
      Object.defineProperty(globalThis, key, { value: api, configurable: false, writable: false });
      available = true;
    }
  } catch {
    // A collision is unavailable, not an application exception.
    try { Object.defineProperty(globalThis, unavailableKey, { value: true, configurable: false, writable: false }); } catch { /* Unavailable. */ }
  }

  return function createMediaDisclosureTracer(expanded, disclosure, matches) {
    const controller = {};
    let committedSession = null, previousCommitted = null;
    const active = () => available && session?.active;
    const emit = (stage, kind, event, extra = {}) => {
      if (!active()) return;
      const { segment, totals } = session;
      try {
        const seq = totals.attempts = increment(totals.attempts);
        segment.attempts = increment(segment.attempts);
        segment.endAttempt = seq;
        if (session.saturated || segment.records.length >= limit || totals.retainedRecords >= caps.totalRecords) {
          segment.droppedRecords = increment(segment.droppedRecords);
          totals.droppedRecords = increment(totals.droppedRecords);
          return;
        }
        const refNode = read('disclosure-read', disclosure);
        const targetNode = event ? read('target-read', () => event.target) : null;
        const currentNode = event ? read('current-target-read', () => event.currentTarget) : null;
        const targetId = identity(nodeIds, targetNode, 'node');
        const currentTargetId = identity(nodeIds, currentNode, 'node');
        segment.records.push({
          seq, timestamp: clock(), stage, kind,
          controllerId: identity(controllerIds, controller, 'controller'),
          refExpanded: read('expanded-read', () => boolean(expanded())),
          currentMQLMatches: read('mql-read', () => boolean(matches())),
          ...nodeState(refNode),
          targetId, currentTargetId,
          targetConnected: targetNode ? read('target-read', () => boolean(targetNode.isConnected)) : null,
          currentTargetConnected: currentNode ? read('current-target-read', () => boolean(currentNode.isConnected)) : null,
          currentTargetOpen: kind === 'toggle' && currentNode ? read('current-target-read', () => boolean(currentNode.open)) : null,
          selfTarget: kind === 'toggle' && targetNode && currentNode ? targetNode === currentNode : null,
          actualEventMatches: kind === 'mq' ? read('event-matches-read', () => boolean(event.matches)) : null,
          toggleOldState: kind === 'toggle' ? read('toggle-state-read', () => toggleState(event.oldState)) : null,
          toggleNewState: kind === 'toggle' ? read('toggle-state-read', () => toggleState(event.newState)) : null,
          ...extra,
        });
        totals.retainedRecords = increment(totals.retainedRecords);
      } catch {
        segment.droppedRecords = increment(segment.droppedRecords);
        totals.droppedRecords = increment(totals.droppedRecords);
        fault('record');
      }
    };
    return {
      callback(kind, stage, event, callbackId = null) {
        // Count all production callbacks across tracers, including inactive capture.
        if (stage === 'entry') callbackDepth = increment(callbackDepth);
        try {
          if (!active()) return null;
          if (stage === 'entry') callbackId = identity(callbackIds, {}, 'callback');
          emit(stage, kind, event, { callbackId });
          return callbackId;
        } catch { fault('callback'); return null; }
        finally {
          if (stage === 'exit') {
            if (callbackDepth > 0) callbackDepth--;
            else fault('callback');
          }
        }
      },
      renderBrowse(factory, tag, props, summary, ...children) {
        let renderedSummary = summary;
        // Controllers created before collector installation use the current session here.
        if (active()) {
          try {
            const capturedSession = session.id;
            const renderToken = identity(renderIds, {}, 'render');
            const requestedOpen = read('render-props-read', () => boolean(props.open));
            emit('render-requested', 'browse', null, { renderToken, renderRequestedOpen: requestedOpen });
            const ref = node => {
              if (!active() || session.id !== capturedSession) return undefined;
              try {
                if (!node) {
                  emit('summary-ref-detach', 'browse', null, { renderToken, renderRequestedOpen: requestedOpen });
                  return undefined;
                }
                // Child refs may attach before the original details ref. Read the parent directly.
                const details = read('summary-parent-read', () => {
                  const parent = node.parentElement;
                  if (parent?.tagName !== 'DETAILS') throw new Error('Unexpected summary parent');
                  return parent;
                });
                if (committedSession !== capturedSession) {
                  committedSession = capturedSession; previousCommitted = null;
                }
                const committed = {
                  renderToken, requestedOpen, detailsId: identity(nodeIds, details, 'node'),
                  detailsConnected: details ? read('details-read', () => boolean(details.isConnected)) : null,
                  detailsOpen: details ? read('details-read', () => boolean(details.open)) : null,
                };
                const previous = previousCommitted;
                emit('summary-ref-attach', 'browse', null, {
                  renderToken, renderRequestedOpen: requestedOpen,
                  summaryId: identity(nodeIds, node, 'node'),
                  detailsId: committed.detailsId,
                  detailsConnected: committed.detailsConnected,
                  detailsOpen: committed.detailsOpen,
                  previousCommittedRenderToken: previous?.renderToken ?? null,
                  previousCommittedRequestedOpen: previous?.requestedOpen ?? null,
                  previousCommittedDetailsId: previous?.detailsId ?? null,
                  previousCommittedDetailsConnected: previous?.detailsConnected ?? null,
                  previousCommittedDetailsOpen: previous?.detailsOpen ?? null,
                  requestedOpenChanged: previous && previous.requestedOpen !== null && requestedOpen !== null ? previous.requestedOpen !== requestedOpen : null,
                  detailsReplaced: previous?.detailsId !== null && previous?.detailsId !== undefined && committed.detailsId !== null ? previous.detailsId !== committed.detailsId : null,
                });
                // Only non-null attachments advance committed history. A ref detach is not replacement.
                previousCommitted = committed;
              } catch { fault('record'); }
              return undefined;
            };
            // The sentinel summary has no original ref; clone only while a session is active.
            renderedSummary = read('summary-clone', () => cloneElement(summary, { ref }), summary);
          } catch { fault('record'); }
        }
        // Preserve the original factory, props, children and factory error behavior.
        return factory(tag, props, renderedSummary, ...children);
      },
    };
  };
}

export function mediaDisclosureBuildPlugin() {
  let transformed = 0, loaded = 0, configured = false;
  const guard = config => {
    if (process.env.CI !== 'true' || process.env.STUDIO_TEST_MEDIA_TRACE !== '1' || config.command !== 'build' || config.build.ssr) {
      throw new Error('Media disclosure tracing requires an explicitly enabled non-SSR CI build');
    }
  };
  return {
    name: 'studio-test-media-disclosure-trace', enforce: 'pre', apply: 'build',
    configResolved(config) { guard(config); configured = true; },
    resolveId(id) { if (id === virtualId) return resolvedVirtualId; },
    load(id) {
      if (id !== resolvedVirtualId) return;
      if (!configured) throw new Error('Media disclosure tracing was not configured');
      loaded++;
      return `import { cloneElement } from 'react';\nimport { untracked } from '@preact/signals-react';\nexport const createMediaDisclosureTracer = (${installRuntime.toString()})(cloneElement, untracked, ${JSON.stringify(mediaTraceStages)}, ${JSON.stringify(mediaTraceCaps)});\n`;
    },
    transform(source, id, options) {
      if (id.replaceAll('\\', '/') !== target) return;
      if (!configured || options?.ssr) throw new Error('Media disclosure tracing cannot transform this build');
      if (transformed !== 0) throw new Error('Media disclosure target transformed more than once');
      const sentinels = [declaration, layout, toggle, library, picker];
      // Validate ALL five counts before applying ANY replacement.
      const counts = sentinels.map(sentinel => source.split(sentinel).length - 1);
      if (counts.some(count => count !== 1) || source.includes(traceName) || source.includes(createName)) {
        throw new Error(`Media disclosure trace sentinels changed: ${counts.join(',')}`);
      }
      const layoutBody = layout.slice(layout.indexOf('\n') + 1, layout.lastIndexOf('\n'));
      const toggleBody = toggle.slice(toggle.indexOf('\n') + 1, toggle.lastIndexOf('\n'));
      let code = source.replace(declaration, `${declaration}\n    const ${traceName} = ${createName}(\n      () => browseExpanded.value,\n      () => browseDisclosure.value,\n      () => narrowLayout.matches,\n    );`);
      code = code.replace(layout, `    function layoutChanged(event: MediaQueryListEvent) {\n      const __studioMediaTraceCallback = ${traceName}.callback("mq", "entry", event);\n      try {\n${layoutBody}\n      } finally {\n        ${traceName}.callback("mq", "exit", event, __studioMediaTraceCallback);\n      }\n    }`);
      code = code.replace(toggle, `      onToggle: domEvent(($event: Event) => {\n        const __studioMediaTraceCallback = ${traceName}.callback("toggle", "entry", $event);\n        try {\n${toggleBody}\n        } finally {\n          ${traceName}.callback("toggle", "exit", $event, __studioMediaTraceCallback);\n        }\n      }),`);
      code = code.replace(library, library.replace('? element(', `? ${traceName}.renderBrowse(element,`));
      code = code.replace(picker, picker.replace('? element(', `? ${traceName}.renderBrowse(element,`));
      transformed++;
      return { code: `import { createMediaDisclosureTracer as ${createName} } from "${virtualId}";\n${code}`, map: null };
    },
    generateBundle() {
      if (!configured || transformed !== 1 || loaded !== 1) {
        throw new Error(`Media disclosure tracing incomplete: transformed=${transformed}, virtualLoads=${loaded}`);
      }
    },
  };
}

export default mediaDisclosureBuildPlugin;
