import { writeFile } from 'node:fs/promises';

// Test-only, bounded evidence; no DOM mutation, input dispatch or diagnostic polling.
const hook = '__chooserScrollDiagnostics';
const caps = { events:64, path:8, waits:4, targets:2, checkpoints:8, failures:16 };
let nextOwner = 0;

export function createChooserScrollDiagnostics({ page, reportPath, withTimeout }) {
  const owner = ++nextOwner;
  const report = {
    schemaVersion:1, scope:'checkControls-icon-chooser-scroll-loop', caps,
    limitation:'Read-only geometry/style sampling can affect timing. Extra install/export/checkpoint/cleanup evaluations are diagnostic, not original test timing. Bounded evidence is not a full trace or proof of a root cause.',
    codes:{ roles:['other', 'window', 'document', 'root', 'body', 'dialog', 'panel', 'results', 'fieldset', 'footer', 'tile', 'input'], selectorRoles:[5, 6, 7, 8, 9], overflowY:['visible', 'hidden', 'clip', 'scroll', 'auto'], visibility:['hidden', 'visible'] },
    eventSemantics:'Passive capture samples only; captureDefaultPrevented is not final dispatch cancellation. First N eligible event attempts are retained; failures and later events are counted separately.',
    lifecycle:'active means collection was attempted and stop has not finished, not proof of installation; outcome describes only this loop; cleanup results independently describe resource release; null browser/counters are unavailable, not zero events',
    installation:'not-started', active:false, outcome:'not-run', browser:null,
    targets:[], droppedTargets:0, waits:[], droppedWaits:0, cleanup:{},
    diagnosticFailures:[], diagnosticFailureCount:0, droppedFailures:0,
  };
  const errors = [];
  let active = false, nextWaitId = 0;
  const failure = (stage, error) => {
    report.diagnosticFailureCount++;
    if (report.diagnosticFailures.length < caps.failures) {
      report.diagnosticFailures.push({ stage }); errors.push(error);
    } else {
      report.droppedFailures++;
      // Draining the queue must not hide later faults after the archive fills.
      if (errors.length === 0) errors.push(new Error('Chooser scroll diagnostic failure budget exceeded'));
    }
  };
  const attempt = async (stage, action) => {
    try { return await withTimeout(action, `Chooser scroll diagnostic: ${stage}`); }
    catch (error) { failure(stage, error); }
  };
  const retain = data => { if (data) report.browser = data; };
  return {
    hook, owner,
    async install() {
      active = true; report.active = true; report.outcome = 'pending'; report.installation = 'attempted';
      retain(await attempt('install', () => page.evaluate(({ hook, owner, caps }) => {
        if (Object.hasOwn(window, hook)) throw new Error('Chooser diagnostic hook already exists');
        const ids = new WeakMap(), listeners = [], waits = new Map();
        let nextId = 0, enabled = true, point = null;
        const data = { installed:false, events:[], waits:[], targets:[], checkpoints:[], failures:[], eligibleEvents:0,
          droppedEvents:0, droppedWaits:0, droppedTargets:0, droppedCheckpoints:0, failureCount:0, droppedFailures:0 };
        const fault = stage => {
          data.failureCount++;
          if (data.failures.length < caps.failures) data.failures.push({ stage });
          else data.droppedFailures++;
        };
        const id = node => {
          if (!node) return null;
          if (!ids.has(node)) ids.set(node, ++nextId);
          return ids.get(node);
        };
        const numeric = n => Number.isFinite(n) ? n : null;
        const selectors = ['.selection-dialog[open]', '.selection-dialog[open] .selection-field-panel',
          '.selection-dialog[open] .selection-results', '.selection-dialog[open] .selection-results fieldset',
          '.selection-dialog[open] .selection-footer'];
        const role = node => {
          if (node === window) return 1;
          if (node === document) return 2;
          if (node === document.documentElement) return 3;
          if (node === document.body) return 4;
          if (!(node instanceof Element)) return 0;
          if (node.matches('.selection-dialog')) return 5;
          if (node.matches('.selection-field-panel')) return 6;
          if (node.matches('.selection-results')) return 7;
          if (node.matches('.selection-result-options')) return 8;
          if (node.matches('.selection-footer')) return 9;
          if (node.matches('.choice-tile')) return 10;
          if (node.matches('input')) return 11;
          return 0;
        };
        const identity = node => ({ nodeId:id(node), role:role(node) });
        const rect = node => {
          const r = node.getBoundingClientRect();
          return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom };
        };
        const nodeState = (node, fixedRole) => ({
          nodeId:id(node), role:fixedRole, docId:node ? id(node.ownerDocument) : null, connected:node?.isConnected ?? false,
          rect:node ? rect(node) : null, scrollTop:node?.scrollTop ?? null,
          clientHeight:node?.clientHeight ?? null, scrollHeight:node?.scrollHeight ?? null,
          overflowY:node ? ['visible', 'hidden', 'clip', 'scroll', 'auto'].indexOf(getComputedStyle(node).overflowY) : null,
        });
        const context = () => {
          const root = document.documentElement, view = window.visualViewport, style = getComputedStyle(root);
          return {
            timestamp:performance.now(), timeOrigin:performance.timeOrigin, docId:id(document),
            visibility:['hidden', 'visible'].indexOf(document.visibilityState),
            layout:{ innerWidth, innerHeight, clientWidth:root.clientWidth, clientHeight:root.clientHeight, devicePixelRatio },
            visual:view ? { width:view.width, height:view.height, scale:view.scale, offsetLeft:view.offsetLeft, offsetTop:view.offsetTop, pageLeft:view.pageLeft, pageTop:view.pageTop } : null,
            tracker:{ height:numeric(parseFloat(style.getPropertyValue('--native-visible-height'))),
              top:numeric(parseFloat(style.getPropertyValue('--native-visible-top'))),
              width:numeric(parseFloat(style.getPropertyValue('--studio-visible-width'))),
              left:numeric(parseFloat(style.getPropertyValue('--studio-visible-left'))), compact:root.hasAttribute('data-compact-viewport') },
          };
        };
        const ancestry = node => {
          const path = [];
          for (let current = node; current && path.length < caps.path; current = current.parentNode) path.push(identity(current));
          return path;
        };
        const snapshot = (at = point) => {
          const nodes = selectors.map(selector => document.querySelector(selector));
          const hit = at ? document.elementFromPoint(at.x, at.y) : null;
          return { ...context(), cardinality:selectors.map(selector => document.querySelectorAll(selector).length),
            nodes:nodes.map((node, index) => nodeState(node, index + 5)),
            point:at ? { x:at.x, y:at.y, hit:identity(hit), path:ancestry(hit),
              hitRect:hit ? rect(hit) : null, inResults:!!(hit && nodes[2]?.contains(hit)) } : null };
        };
        const checkpoint = label => {
          if (!enabled) return;
          if (data.checkpoints.length >= caps.checkpoints) { data.droppedCheckpoints++; return; }
          try { data.checkpoints.push({ label, ...snapshot() }); } catch { fault('checkpoint'); }
        };
        // Publish ownership/cleanup before acquiring any listeners, including partial installs.
        window[hook] = {
          owner, checkpoint,
          target(node, x, y) {
            if (!enabled) return null;
            try {
              point = { x, y };
              const state = { selectedNodeId:id(node), ...snapshot() };
              if (data.targets.length < caps.targets) data.targets.push(state); else data.droppedTargets++;
              return state;
            } catch { fault('target'); return null; }
          },
          sampleWait(waitId, node, matched) {
            if (!enabled || !Number.isInteger(waitId)) return;
            try {
              let wait = waits.get(waitId);
              if (!wait) {
                if (waits.size >= caps.waits) { data.droppedWaits++; return; }
                wait = { waitId, count:0, trueCount:0, minOffset:null, maxOffset:null, first:null, last:null, outcome:'pending' };
                waits.set(waitId, wait); data.waits.push(wait);
              }
              wait.count++; if (matched) wait.trueCount++;
              const offset = node.scrollTop;
              wait.minOffset = wait.minOffset === null ? offset : Math.min(wait.minOffset, offset);
              wait.maxOffset = wait.maxOffset === null ? offset : Math.max(wait.maxOffset, offset);
              const sample = { ...context(), node:nodeState(node, 7), matched };
              wait.first ??= sample; wait.last = sample;
            } catch { fault('wait-sample'); }
          },
          export(waitId, outcome) {
            const wait = waits.get(waitId);
            if (wait) wait.outcome = outcome;
            return data;
          },
          cleanup() {
            enabled = false;
            const errors = [];
            for (const [target, type, handler] of listeners) {
              try { target.removeEventListener(type, handler, true); } catch (error) { errors.push(error); }
            }
            if (errors.length) throw new AggregateError(errors, 'Chooser diagnostic listener cleanup failed');
          },
        };
        const event = (kind, e) => {
          if (!enabled) return;
          // Scroll is restricted to fixed known containers, never arbitrary descendants.
          if (kind === 'scroll' && ![2, 3, 4, 5, 6, 7, 8, 9].includes(role(e.target))) return;
          if (++data.eligibleEvents > caps.events) { data.droppedEvents++; return; }
          try {
            const path = e.composedPath();
            data.events.push({ kind, target:identity(e.target), trusted:e.isTrusted,
              captureDefaultPrevented:e.defaultPrevented, path:path.slice(0, caps.path).map(identity), droppedPath:Math.max(0, path.length - caps.path),
              wheel:kind === 'wheel' ? { clientX:e.clientX, clientY:e.clientY, deltaY:e.deltaY, deltaMode:e.deltaMode } : null,
              ...snapshot(kind === 'wheel' ? { x:e.clientX, y:e.clientY } : point) });
          } catch { fault('event'); }
        };
        const listen = (target, type, kind = type) => {
          const handler = e => event(kind, e);
          listeners.push([target, type, handler]);
          target.addEventListener(type, handler, { capture:true, passive:true });
        };
        listen(document, 'wheel'); listen(document, 'scroll'); listen(document, 'focusin');
        listen(window, 'resize', 'window-resize');
        if (window.visualViewport) {
          listen(window.visualViewport, 'resize', 'visual-resize');
          listen(window.visualViewport, 'scroll', 'visual-scroll');
        }
        data.installed = true;
        return data;
      }, { hook, owner, caps })));
      report.installation = report.browser?.installed ? 'installed' : 'failed-or-partial';
      if (!report.browser?.installed && !report.diagnosticFailureCount) failure('install-unavailable', new Error('Chooser diagnostic installation returned no state'));
    },
    rememberTarget(snapshot) {
      if (report.targets.length < caps.targets) report.targets.push({ status:snapshot ? 'captured' : 'unavailable', snapshot });
      else report.droppedTargets++;
      if (!snapshot) failure('target-unavailable', new Error('Chooser target diagnostic unavailable'));
    },
    nextWait(width, direction, top) {
      const waitId = ++nextWaitId;
      if (report.waits.length < caps.waits) report.waits.push({ waitId, width, direction, top, outcome:'pending', sampleStatus:'not-exported' });
      else report.droppedWaits++;
      return waitId;
    },
    async endWait(waitId, outcome) {
      const wait = report.waits.find(wait => wait.waitId === waitId);
      if (wait) wait.outcome = outcome;
      const data = await attempt('wait-export', () => page.evaluate(({ hook, owner, waitId, outcome }) => {
        if (window[hook]?.owner !== owner) throw new Error('Owned chooser diagnostic hook missing');
        return window[hook].export(waitId, outcome);
      }, { hook, owner, waitId, outcome }));
      retain(data);
      if (wait) wait.sampleStatus = data?.waits.some(sample => sample.waitId === waitId) ? 'exported' : data ? 'no-invocation-observed' : 'unavailable';
    },
    async snapshot(label) {
      if (!active) return;
      retain(await attempt(label, () => page.evaluate(({ hook, owner, label }) => {
        if (window[hook]?.owner !== owner) throw new Error('Owned chooser diagnostic hook missing');
        window[hook].checkpoint(label);
        return window[hook].export();
      }, { hook, owner, label })));
    },
    async stop(outcome) {
      if (!active) return;
      report.outcome = outcome;
      try { await this.snapshot('stopping'); }
      finally {
        // Each cleanup is independent; never delete another owner's hook.
        for (const kind of ['listeners', 'hook']) {
          report.cleanup[kind] = await attempt(`cleanup-${kind}`, () => page.evaluate(({ hook, owner, kind }) => {
            if (!Object.hasOwn(window, hook)) return 'absent-in-current-document';
            if (window[hook]?.owner !== owner) throw new Error('Refusing to clean up unowned chooser hook');
            if (kind === 'hook') delete window[hook]; else window[hook].cleanup();
            return 'completed';
          }, { hook, owner, kind })) ?? 'failed';
        }
        active = false; report.active = false;
      }
      for (const { stage } of report.browser?.failures ?? []) failure(`browser-${stage}`, new Error(`Chooser diagnostic browser stage failed: ${stage}`));
      if (report.browser?.droppedFailures) failure('browser-dropped-failures', new Error('Additional chooser diagnostic browser failures were dropped'));
    },
    takeErrors() { return errors.splice(0); },
    async writeReport() {
      // No live page is needed; unavailable browser evidence remains null, not zero.
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    },
  };
}
