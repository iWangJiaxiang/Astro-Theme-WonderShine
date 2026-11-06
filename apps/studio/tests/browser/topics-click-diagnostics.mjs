import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const errorKind = error => ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'TimeoutError', 'ProtocolError', 'TargetCloseError'].includes(error?.name) ? error.name : 'UnknownError';

// A timeout bounds waiting, not the underlying RPC/write. Never retry it.
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error('Diagnostic deadline'); error.name = 'TimeoutError'; reject(error); }, 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Observe only select-topics' original click/ready operation; never make it ready. */
export async function topicsClickDiagnostics({ page, output, operation }) {
  const failures = [];
  let failureAttempts = 0, handle, capture = null, cleanupCapture = null, cachedAfterClick = null, installation = 'unavailable';
  const failed = (stage, error) => { if (++failureAttempts <= 16) failures.push({ stage, errorKind: errorKind(error) }); };
  const release = async target => {
    let result = null;
    try { result = await bounded(() => target.evaluate(collector => collector.cleanup())); }
    catch (error) { failed('cleanup-rpc', error); }
    finally {
      try { await bounded(() => target.dispose()); }
      catch (error) { failed('handle-dispose', error); }
    }
    return result;
  };
  try {
    const pending = page.evaluateHandle(() => {
      const triggerSelector = '.thread-composer button[name="extra.topics"]';
      const dialogSelector = 'dialog.selection-dialog, dialog.reauth-backdrop';
      const original = document.querySelector(triggerSelector), originalTextarea = document.querySelector('.thread-composer textarea');
      const ids = new WeakMap(), events = [], mutations = [], snapshots = [], failures = [], listeners = [];
      let nextId = 1, eventAttempts = 0, mutationAttempts = 0, snapshotAttempts = 0, failureAttempts = 0, observer, installed = false;
      const started = performance.now();
      const fail = stage => { if (++failureAttempts <= 16) failures.push({ stage, errorKind: 'CaptureError' }); };
      const id = node => { if (!node) return null; if (!ids.has(node)) ids.set(node, nextId++); return ids.get(node); };
      const current = () => document.querySelector(triggerSelector);
      const rect = node => { if (!node) return null; const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
      const role = node => {
        if (!(node instanceof Element)) return 'other';
        if (original && (node === original || original.contains(node))) return 'original-trigger';
        const fresh = current();
        if (fresh && (node === fresh || fresh.contains(node))) return 'current-trigger';
        if (node.matches('.thread-composer textarea') || node === originalTextarea) return 'textarea';
        if (node.closest('dialog.selection-dialog')) return 'selection-dialog';
        if (node.closest('dialog.reauth-backdrop')) return 'reauth-dialog';
        return 'other';
      };
      const state = node => {
        if (!node) return null;
        let hiddenAncestor = false, computedHiddenAncestor = false;
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
          hiddenAncestor ||= ancestor.hasAttribute('hidden');
          const style = getComputedStyle(ancestor);
          computedHiddenAncestor ||= style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
        }
        const expanded = node.getAttribute('aria-expanded');
        return { id: id(node), connected: node.isConnected, disabled: typeof node.disabled === 'boolean' ? node.disabled : null,
          rect: rect(node), inert: !!node.closest('[inert]'), hiddenAncestor, computedHiddenAncestor,
          ariaExpanded: expanded === 'true' ? true : expanded === 'false' ? false : null };
      };
      const triggerStates = () => {
        const fresh = current(), textarea = document.querySelector('.thread-composer textarea');
        return { original: state(original), current: state(fresh), sameTrigger: original && fresh ? original === fresh : null,
          originalTextarea: state(originalTextarea), currentTextarea: state(textarea), sameTextarea: originalTextarea && textarea ? originalTextarea === textarea : null };
      };
      const dialogState = node => ({ id: id(node), role: role(node), connected: node.isConnected, open: !!node.open, modal: node.matches(':modal') });
      const dialogs = selector => {
        const nodes = document.querySelectorAll(selector);
        return { count: nodes.length, states: [...nodes].slice(0, 8).map(dialogState), dropped: Math.max(0, nodes.length - 8) };
      };
      function snapshot(stage) {
        if (++snapshotAttempts > 8) return null;
        try {
          const viewport = window.visualViewport;
          const entry = { stage, time: performance.now() - started, ...triggerStates(), activeRole: role(document.activeElement),
            layoutViewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
            visualViewport: viewport ? { width: viewport.width, height: viewport.height, offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop, scale: viewport.scale } : null,
            selectionDialogs: dialogs('dialog.selection-dialog'), reauthDialogs: dialogs('dialog.reauth-backdrop'),
            shellInert: document.querySelector('.studio-shell')?.inert ?? null };
          snapshots.push(entry);
          return entry;
        } catch { fail('snapshot'); return null; }
      }
      function observe(records) {
        for (const record of records) {
          try {
            if (record.type === 'attributes') {
              const node = record.target;
              const eligible = (record.attributeName === 'disabled' && (node === original || node === current()))
                || (record.attributeName === 'open' && node.matches(dialogSelector))
                || (record.attributeName === 'inert' && node.matches('.studio-shell'));
              if (!eligible || ++mutationAttempts > 32) continue;
              mutations.push({ type: record.attributeName === 'disabled' ? 'trigger-disabled' : record.attributeName === 'open' ? 'dialog-open' : 'shell-inert',
                time: performance.now() - started, stateAtDelivery: node.matches(dialogSelector) ? dialogState(node) : state(node) });
            } else {
              for (const [type, nodes] of [['dialog-attached', record.addedNodes], ['dialog-detached', record.removedNodes]]) {
                for (const node of nodes) {
                  if (!(node instanceof Element)) continue;
                  // Descendants also cover removal/attachment of a dialog's parent.
                  const found = node.matches(dialogSelector) ? [node, ...node.querySelectorAll(dialogSelector)] : node.querySelectorAll(dialogSelector);
                  for (const dialog of found) {
                    if (++mutationAttempts > 32) continue;
                    mutations.push({ type, time: performance.now() - started, stateAtDelivery: dialogState(dialog) });
                  }
                }
              }
            }
          } catch { fail('mutation-capture'); }
        }
      }
      function cleanup() {
        // Independent branches: neither listener removal nor drain failure skips disconnect.
        for (const [type, listener] of listeners.splice(0)) {
          try { document.removeEventListener(type, listener, true); } catch { fail('listener-cleanup'); }
        }
        const activeObserver = observer;
        observer = null;
        if (activeObserver) {
          try { observe(activeObserver.takeRecords()); } catch { fail('mutation-drain'); }
          try { activeObserver.disconnect(); } catch { fail('observer-cleanup'); }
        }
        return { failures, failureAttempts, failuresDropped: Math.max(0, failureAttempts - 16) };
      }
      try {
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'focusin']) {
          const listener = event => {
            try {
              const target = event.target;
              if (!(target instanceof Element) || !(role(target) !== 'other' || target.closest('.thread-composer'))) return;
              // First eligible attempts, not a ring buffer or first successful captures.
              if (++eventAttempts > 64) return;
              const pointer = type !== 'focusin', x = pointer ? event.clientX : null, y = pointer ? event.clientY : null;
              events.push({ type, phase: 'capture', time: performance.now() - started, trusted: event.isTrusted,
                x, y, targetRole: role(target), hitRole: pointer ? role(document.elementFromPoint(x, y)) : null,
                activeRole: role(document.activeElement), ...triggerStates() });
            } catch { fail('event-capture'); }
          };
          listeners.push([type, listener]);
          document.addEventListener(type, listener, { capture: true, passive: true });
        }
        observer = new MutationObserver(observe);
        observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'open', 'inert'] });
        installed = true;
        snapshot('before');
      } catch { fail('installation'); cleanup(); }
      return {
        snapshot, cleanup,
        finish(success) {
          let cleanupResult;
          try { snapshot(success ? 'final-success' : 'final-failed'); }
          finally { cleanupResult = cleanup(); }
          return { installed, snapshots, events, mutations, ...cleanupResult,
            eventAttempts, eventsDropped: eventAttempts - events.length, mutationAttempts, mutationsDropped: mutationAttempts - mutations.length,
            snapshotAttempts, snapshotsDropped: snapshotAttempts - snapshots.length };
        },
      };
    });
    try { handle = await bounded(() => pending); installation = 'handle-available'; }
    catch (error) {
      // Attach after the race fails, including when resolution races the deadline.
      void pending.then(async late => {
        const result = await release(late);
        console.error('Topics click diagnostics late-install cleanup attempted:', JSON.stringify({ cleanup: result, failures, failureAttempts }));
      }, () => {}).catch(lateError => { failed('late-install-cleanup', lateError); });
      throw error;
    }
  } catch (error) { failed('install-rpc', error); }

  let primary, operationFailed = false;
  try {
    await operation(async () => {
      if (!handle) return;
      try {
        cachedAfterClick = await bounded(() => handle.evaluate(collector => collector.snapshot('after-click')));
        if (!cachedAfterClick) failed('after-click-missing', null);
      } catch (error) { failed('after-click-rpc', error); }
    });
  } catch (error) { primary = error; operationFailed = true; }
  finally {
    if (handle) {
      try { capture = await bounded(() => handle.evaluate((collector, success) => collector.finish(success), !operationFailed)); }
      catch (error) { failed('export-rpc', error); }
      finally { cleanupCapture = await release(handle); }
    }
    const report = {
      schemaVersion: 1, operation: operationFailed ? 'failed' : 'succeeded', installation: capture ? (capture.installed ? 'installed' : 'unavailable') : installation,
      captureStatus: capture ? 'exported' : 'missing', capture, cleanupCapture,
      cachedAfterClickStatus: cachedAfterClick ? 'available' : 'missing', cachedAfterClick,
      failures, failureAttempts, failuresDropped: Math.max(0, failureAttempts - 16),
      limits: { rpcAndWriteMs: 10_000, events: 64, mutations: 32, snapshots: 8, failuresPerContext: 16, dialogsPerSnapshot: 8 },
      limitations: [
        'Install, after-click and export RPCs add timing gaps; this is not the uninstrumented schedule.',
        'Timeouts do not cancel underlying RPCs or writes; late install cleanup is best effort, without retries.',
        'Mutation states are at delivery, not historical mutation states. Only first eligible attempts are captured.',
        'Missing capture/cache is unavailable evidence, not zero events. Readiness and late visibility do not prove an enabled click or its cause.',
      ],
    };
    try { await bounded(() => writeFile(join(output, 'topics-initial-click.json'), JSON.stringify(report, null, 2) + '\n')); }
    catch (error) { failed('persist', error); }
    if (failureAttempts || capture?.failureAttempts || cleanupCapture?.failureAttempts || !capture?.installed) {
      console.error('Topics click diagnostics capture/persistence unavailable:', JSON.stringify({ failures, failureAttempts, browserFailures: capture?.failures ?? null, cleanupCapture }));
      if (!operationFailed) { primary = new Error('Topics click diagnostics unavailable'); operationFailed = true; }
    }
  }
  if (operationFailed) throw primary;
}
