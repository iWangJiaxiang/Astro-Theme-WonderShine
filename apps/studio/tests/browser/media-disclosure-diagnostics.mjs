import { writeFile } from 'node:fs/promises';

// Test-only DOM evidence. Node IDs are not React refs; no component state is read.
const hook = '__mediaDisclosureDiagnostics';
const caps = { events: 120, waits: 96, checkpoints: 16, failures: 24, animations: 4, mutationNodes: 8, previewSamples: 2, previewCandidates: 24, previewFaults: 8 };
let nextOwner = 0;

export function createMediaDisclosureDiagnostics({ page, reportPath, withTimeout }) {
  const owner = ++nextOwner;
  const report = {
    schemaVersion: 2, scope: 'checkUploads', limitation: 'DOM identity only; not React refs or proof of a shared root cause; instrumentation may affect timing',
    previewSemantics: {
      predicate: 'Original some order, geometry, hit tests and body-scroll short circuit; matched computed before additional DOM reads',
      measurements: 'Candidate/body/footer rectangles and hits reused from predicate; atSampling context and hit roles read afterward, not an atomic snapshot or causal evidence',
      missing: 'Missing, partial or unavailable evidence is not success; skipped predicate body scroll is null, not zero; body absence preserves original true branch',
      limits: 'First 24 visited candidates per sample, at most 2 samples; counts distinguish dropped visited candidates from short-circuited unvisited candidates; DOM only, not component state',
      roles: ['img', 'media-card', 'footer', 'body', 'dialog', 'other', null],
      css: 'Only finite numeric px or unitless custom properties on documentElement; null means absent or unparseable, never an inferred zero',
    },
    previewSamples: [], previewAttempts: 0, droppedPreviewSamples: 0,
    codes: { roles: ['library-directory', 'picker-filter', 'sidebar', 'sidebar-backdrop'], playStates: ['idle', 'running', 'paused', 'finished'], mutationChange: { removed: -1, attribute: 0, added: 1 } },
    caps, installation: 'not-started', outcome: 'not-run', active: false,
    browser: null, waits: [], droppedWaits: 0, cleanup: {}, diagnosticFailures: [], droppedFailures: 0,
  };
  const errors = [];
  let active = false, nextWaitId = 0;
  const failure = (stage, error) => {
    if (report.diagnosticFailures.length < caps.failures) {
      report.diagnosticFailures.push({ stage });
      errors.push(error);
    } else report.droppedFailures++;
  };
  const attempt = async (stage, action) => {
    try { return await withTimeout(action, `Media disclosure diagnostic: ${stage}`); }
    catch (error) { failure(stage, error); }
  };
  const retain = data => { if (data) report.browser = data; };
  return {
    async install() {
      active = true; report.active = true; report.installation = 'attempted';
      const data = await attempt('install', () => page.evaluate(({ hook, caps, owner }) => {
        if (Object.hasOwn(window, hook)) throw new Error('Media diagnostic hook already exists');
        const ids = new WeakMap();
        let nextId = 0, enabled = true, observer;
        const listeners = [];
        const data = {
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
          export(waitId, outcome) {
            const wait = waits.get(waitId);
            if (wait) wait.outcome = outcome;
            return data;
          },
          cleanup(kind) {
            enabled = false;
            if (kind === 'observer') observer?.disconnect();
            if (kind === 'listeners') {
              const failures = [];
              for (const [target, type, handler, capture] of listeners) {
                try { target.removeEventListener(type, handler, capture); } catch (error) { failures.push(error); }
              }
              if (failures.length) throw new AggregateError(failures, 'Media diagnostic listener cleanup failed');
            }
          },
        };
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
        return data;
      }, { hook, caps, owner }));
      retain(data);
      report.installation = data?.installed ? 'installed' : 'failed-or-partial';
      if (!data?.installed && !report.diagnosticFailures.length) failure('install-unavailable', new Error('Media diagnostic installation returned no state'));
    },
    recordPreview(target, result, unavailableStage = 'sample-unavailable') {
      // Synchronous Node cache only: no export RPC, disk write or active-hook dependency.
      report.previewAttempts++;
      try {
        const sample = result?.sample;
        const available = sample?.status === 'available';
        if (report.previewSamples.length < caps.previewSamples) {
          report.previewSamples.push({
            attempt: report.previewAttempts, target: target === 'library' ? 'library' : 'picker',
            matched: typeof result?.matched === 'boolean' ? result.matched : null,
            sample: sample ?? { status: 'unavailable', faults: [unavailableStage === 'rpc-failed' ? 'rpc-failed' : 'sample-unavailable'], droppedFaults: 0 },
          });
        } else report.droppedPreviewSamples++;
        if (!available) failure(sample?.status === 'partial' ? 'preview-sample-partial' : unavailableStage === 'rpc-failed' ? 'preview-rpc-failed' : 'preview-sample-unavailable', new Error('Media diagnostic preview evidence unavailable or partial'));
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
    async endWait(waitId, outcome) {
      if (!active) return;
      const wait = report.waits.find(wait => wait.waitId === waitId);
      if (wait) wait.outcome = outcome;
      const data = await attempt('wait-export', () => page.evaluate(({ hook, waitId, outcome, owner }) => {
        if (window[hook]?.owner !== owner) throw new Error('Active media diagnostic hook missing or not owned');
        return window[hook].export(waitId, outcome);
      }, { hook, waitId, outcome, owner }));
      retain(data);
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
        // Each resource class and global deletion is attempted independently.
        for (const kind of ['observer', 'listeners', 'hook']) {
          const result = await attempt(`cleanup-${kind}`, () => page.evaluate(({ hook, kind, owner }) => {
            if (!Object.hasOwn(window, hook)) return 'absent-in-current-document';
            if (window[hook]?.owner !== owner) throw new Error('Refusing to clean up an unowned media diagnostic hook');
            if (kind === 'hook') { delete window[hook]; return 'completed'; }
            window[hook].cleanup(kind); return 'completed';
          }, { hook, kind, owner }));
          report.cleanup[kind] = result ?? 'failed';
        }
        active = false; report.active = false;
      }
      for (const { stage } of report.browser?.failures ?? []) failure(`browser-${stage}`, new Error(`Media diagnostic browser stage failed: ${stage}`));
      if (report.browser?.droppedFailures) failure('browser-dropped-failures', new Error('Additional media diagnostic browser failures were dropped'));
    },
    takeErrors() { return errors.splice(0); },
    async writeReport() {
      // Cached Node data remains writable even after page/browser destruction.
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    },
  };
}
