import { writeFile } from 'node:fs/promises';

// Test-only, read-only evidence for one existing folder-clear attempt.
const hook = '__folderClearDiagnostics';
const caps = { events:96, mutations:32, path:8, checkpoints:8, failures:16 };
let nextOwner = 0;

export function createFolderClearDiagnostics({ page, reportPath, withTimeout }) {
  const owner = ++nextOwner;
  const report = {
    schemaVersion:1, scope:'checkUploads-public-picker-folder-clear', caps,
    limitation:'Install/export/checkpoint/cleanup RPCs and synchronous DOM/geometry reads may affect timing. No React state/ref evidence or root-cause proof; native close before React commit is only a timing hypothesis.',
    semantics:'First eligible attempts, shared across event kinds and phases; mutations have a separate cap. Capture/bubble defaultPrevented is dispatch-time, not final cancellation after later listeners. Native checked is read at events/waits; property changes need not mutate attributes. Checkpoints bracket the original screenshot attempt, not guaranteed completion.',
    lifecycle:'Outcome describes only folder clearing through the original parent-selection assertions, not whole smoke. Null evidence is unavailable; failed exports leave the last Node cache.',
    roles:['empty-radio', 'previous-radio', 'confirm', 'dialog', 'folder-trigger', 'other'],
    installation:'not-started', outcome:'not-run', active:false, browser:null, cleanup:{},
    diagnosticFailures:[], diagnosticFailureCount:0, droppedFailures:0,
  };
  const errors = [];
  let active = false;
  const failure = (stage, error) => {
    report.diagnosticFailureCount++;
    if (report.diagnosticFailures.length < caps.failures) {
      report.diagnosticFailures.push({ stage }); errors.push(error);
    } else report.droppedFailures++;
  };
  const attempt = async (stage, action) => {
    try { return await withTimeout(action, `Folder clear diagnostic: ${stage}`); }
    catch (error) { failure(stage, error); }
  };
  const retain = data => { if (data) report.browser = data; };
  return {
    async install() {
      active = true; report.active = true; report.outcome = 'pending'; report.installation = 'attempted';
      retain(await attempt('install', () => page.evaluate(({ hook, owner, caps }) => {
        if (Object.hasOwn(window, hook)) throw new Error('Folder diagnostic hook already exists');
        const ids = new WeakMap(), listeners = [];
        let nextId = 0, enabled = true, observer, rememberedChooser = null;
        const picker = document.querySelector('dialog.media-dialog[open]');
        const filter = picker?.querySelector('.media-filter-disclosure');
        const trigger = picker?.querySelector('button[name="media-folder"]');
        const data = { installed:false, events:[], mutations:[], checkpoints:[], wait:{ count:0, matchCount:0, first:null, last:null },
          assertion:null, eligibleEvents:0, droppedEvents:0, eligibleMutations:0, droppedMutations:0,
          droppedCheckpoints:0, failures:[], failureCount:0, droppedFailures:0 };
        const fault = stage => {
          data.failureCount++;
          if (data.failures.length < caps.failures) data.failures.push({ stage }); else data.droppedFailures++;
        };
        const id = node => {
          if (!node) return null;
          if (!ids.has(node)) ids.set(node, ++nextId);
          return ids.get(node);
        };
        const chooser = () => {
          const current = document.querySelector('.selection-dialog');
          if (current) rememberedChooser = current;
          return current || rememberedChooser;
        };
        const role = node => {
          if (!(node instanceof Element)) return 'other';
          const option = node.closest('label')?.querySelector('input[type="radio"]') || node;
          if (option.matches('input[type="radio"][value=""]')) return 'empty-radio';
          if (option.matches('input[type="radio"][value="public/uploads"]')) return 'previous-radio';
          if (node.closest('.selection-footer button.primary')) return 'confirm';
          if (node.closest('button[name="media-folder"]')) return 'folder-trigger';
          if (node.matches('.selection-dialog')) return 'dialog';
          return 'other';
        };
        const identity = node => ({ nodeId:id(node), role:role(node) });
        const rect = node => {
          if (!node) return null;
          const r = node.getBoundingClientRect();
          return { x:r.x, y:r.y, width:r.width, height:r.height };
        };
        const state = node => ({ ...identity(node), connected:node?.isConnected ?? false,
          docId:node ? id(node.ownerDocument) : null, rect:rect(node), inert:node?.inert ?? null,
          inertAncestor:!!node?.closest('[inert]'), disabled:node ? node.matches(':disabled') : null,
          nativeDisabled:typeof node?.disabled === 'boolean' ? node.disabled : null });
        const radio = node => ({ ...state(node), checked:node?.checked ?? null,
          labelSelected:node ? node.closest('label')?.classList.contains('selected') ?? false : null,
          label:state(node?.closest('label')) });
        const snapshot = (cards = null, point = null) => {
          const dialog = chooser(), view = window.visualViewport;
          const empty = dialog?.querySelector('input[type="radio"][value=""]');
          const previous = dialog?.querySelector('input[type="radio"][value="public/uploads"]');
          const confirm = dialog?.querySelector('.selection-footer button.primary');
          const fieldset = dialog?.querySelector('fieldset');
          const nodes = cards || [...(picker?.querySelectorAll('.media-card') || [])];
          const selected = nodes.filter(node => node.classList.contains('selected'));
          const inside = nodes.filter(node => node.dataset.mediaPath?.startsWith('public/uploads/')).length;
          const hit = point ? document.elementFromPoint(point.x, point.y) : null;
          return { timestamp:performance.now(), timeOrigin:performance.timeOrigin, docId:id(document),
            viewport:{ width:innerWidth, height:innerHeight, devicePixelRatio,
              visual:view ? { width:view.width, height:view.height, scale:view.scale, offsetLeft:view.offsetLeft, offsetTop:view.offsetTop } : null },
            chooser:{ ...state(dialog), count:document.querySelectorAll('.selection-dialog').length,
              openCount:document.querySelectorAll('.selection-dialog[open]').length,
              open:dialog?.open ?? null, modal:dialog?.matches(':modal') ?? null },
            empty:radio(empty), previous:radio(previous), confirm:state(confirm), fieldset:state(fieldset),
            parent:{ ...state(picker), open:picker?.open ?? null, modal:picker?.matches(':modal') ?? null,
              trigger:state(trigger), allFolders:trigger?.textContent.trim() === 'All folders',
              uploadsFolder:trigger?.textContent.includes('public/uploads') ?? false,
              summaryAllFolders:filter?.querySelector(':scope > summary')?.textContent.includes('All folders') ?? false,
              summaryUploads:filter?.querySelector(':scope > summary')?.textContent.includes('public/uploads') ?? false,
              cards:nodes.length, insideUploads:inside, outsideUploads:nodes.length - inside, selectedCount:selected.length,
              knownSelectedCover:selected.some(node => node.dataset.mediaPath === 'public/uploads/cover-upload.png') },
            point:point ? { ...point, hit:identity(hit), hitRect:rect(hit) } : null };
        };
        const checkpoint = label => {
          if (!enabled) return;
          if (data.checkpoints.length >= caps.checkpoints) { data.droppedCheckpoints++; return; }
          try { data.checkpoints.push({ label, ...snapshot() }); } catch { fault('checkpoint'); }
        };
        // Publish ownership before acquiring resources, so partial installs are removable.
        window[hook] = {
          owner, checkpoint,
          sampleWait(matched) {
            if (!enabled) return;
            try {
              data.wait.count++; if (matched) data.wait.matchCount++;
              const sample = { matched, ...snapshot() };
              data.wait.first ??= sample; data.wait.last = sample;
            } catch { fault('wait-sample'); }
          },
          sampleAssertion(nodes, matched) {
            if (!enabled) return;
            try { data.assertion = { matched, ...snapshot(nodes) }; } catch { fault('assertion-sample'); }
          },
          export() { return data; },
          cleanup(kind) {
            enabled = false;
            if (kind === 'observer') observer?.disconnect();
            if (kind === 'listeners') {
              const failures = [];
              for (const [type, handler, capture] of listeners) {
                try { document.removeEventListener(type, handler, capture); } catch (error) { failures.push(error); }
              }
              if (failures.length) throw new AggregateError(failures, 'Folder diagnostic listener cleanup failed');
            }
          },
        };
        for (const type of ['pointerdown', 'pointerup', 'click', 'input', 'change']) {
          for (const capture of [true, false]) {
            const handler = e => {
              if (!enabled || !(e.target instanceof Element)) return;
              if (!e.target.closest('.selection-dialog') && !trigger?.contains(e.target)) return;
              if (++data.eligibleEvents > caps.events) { data.droppedEvents++; return; }
              try {
                const path = e.composedPath(), pointer = type.startsWith('pointer') || type === 'click';
                const point = pointer ? { x:e.clientX, y:e.clientY } : null;
                data.events.push({ kind:type, phase:capture ? 'capture' : 'bubble', eventPhase:e.eventPhase,
                  trusted:e.isTrusted, defaultPreventedAtPhase:e.defaultPrevented, target:identity(e.target),
                  path:path.slice(0, caps.path).map(identity), droppedPath:Math.max(0, path.length - caps.path),
                  ...snapshot(null, point) });
              } catch { fault('event'); }
            };
            listeners.push([type, handler, capture]);
            document.addEventListener(type, handler, { capture, passive:true });
          }
        }
        const relevant = node => node instanceof Element &&
          (node.matches('.selection-dialog') || !!node.closest('.selection-dialog') || node === filter || !!filter?.contains(node));
        observer = new MutationObserver(records => {
          if (!enabled) return;
          for (const record of records) {
            try {
              const removed = record.type === 'childList' && [...record.removedNodes].some(node =>
                node === rememberedChooser || node === filter || (node instanceof Element &&
                  (node.matches('.selection-dialog') || !!node.querySelector('.selection-dialog') ||
                    (!!rememberedChooser && node.contains(rememberedChooser)) || (!!filter && node.contains(filter)))));
              const added = record.type === 'childList' && [...record.addedNodes].some(node =>
                node instanceof Element && (node.matches('.selection-dialog') || !!node.querySelector('.selection-dialog')));
              if (!relevant(record.target) && !removed && !added) continue;
              if (++data.eligibleMutations > caps.mutations) { data.droppedMutations++; continue; }
              data.mutations.push({ kind:record.type, attribute:record.attributeName, target:identity(record.target),
                addedChooser:!!added, removedTracked:!!removed, ...snapshot() });
            } catch { fault('mutation'); }
          }
        });
        observer.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class', 'open', 'disabled', 'checked'] });
        data.installed = true; checkpoint('installed');
        return data;
      }, { hook, owner, caps })));
      report.installation = report.browser?.installed ? 'installed' : 'failed-or-partial';
      if (!report.browser?.installed && !report.diagnosticFailureCount) failure('install-unavailable', new Error('Folder diagnostic installation unavailable'));
    },
    async snapshot(label) {
      if (!active) return;
      retain(await attempt(label, () => page.evaluate(({ hook, owner, label }) => {
        if (window[hook]?.owner !== owner) throw new Error('Owned folder diagnostic hook missing');
        window[hook].checkpoint(label);
        return window[hook].export();
      }, { hook, owner, label })));
    },
    async stop(outcome) {
      if (!active) return;
      report.outcome = outcome;
      try { await this.snapshot('stopping'); }
      finally {
        for (const kind of ['observer', 'listeners', 'hook']) {
          report.cleanup[kind] = await attempt(`cleanup-${kind}`, () => page.evaluate(({ hook, owner, kind }) => {
            if (!Object.hasOwn(window, hook)) return 'absent-in-current-document';
            if (window[hook]?.owner !== owner) throw new Error('Refusing to clean up unowned folder hook');
            if (kind === 'hook') delete window[hook]; else window[hook].cleanup(kind);
            return 'completed';
          }, { hook, owner, kind })) ?? 'failed';
        }
        active = false; report.active = false;
      }
      for (const { stage } of report.browser?.failures ?? []) failure(`browser-${stage}`, new Error(`Folder diagnostic browser stage failed: ${stage}`));
      if (report.browser?.droppedFailures) failure('browser-dropped-failures', new Error('Additional folder diagnostic failures dropped'));
    },
    takeErrors() { return errors.splice(0); },
    async writeReport() {
      // Cached data needs no live page, even after failed installation or teardown.
      await attempt('report-write', () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'));
    },
  };
}
