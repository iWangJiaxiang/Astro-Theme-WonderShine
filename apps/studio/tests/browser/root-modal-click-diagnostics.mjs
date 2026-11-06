import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function errorKind(error) {
  const name = error?.name;
  return ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'TimeoutError', 'ProtocolError', 'TargetCloseError'].includes(name) ? name : 'UnknownError';
}

/** Observe only the first AI click boundary; never inspect content or change UI. */
export async function initialAiClickDiagnostics({ page, screenshots, outcome }) {
  const failures = [];
  let handle;
  const failed = (stage, error) => failures.push({ stage, errorKind: errorKind(error) });
  try {
    handle = await page.evaluateHandle(() => {
      const events = [], mutations = [], snapshots = [], failures = [];
      const limit = 80;
      const selectors = [
        ['ai-button', '.ai-action'],
        ['summary-label', '.summary-heading label[for="article-description"]'],
        ['summary-heading', '.summary-heading'],
        ['summary-textarea', 'textarea#article-description'],
        ['source-textarea', '.editor-page textarea.markdown-source'],
        ['ai-dialog', 'dialog.ai-assistant-dialog'],
        ['reauth-dialog', 'dialog.reauth-backdrop'],
        ['language-loading', '.language-versions .loading-panel'],
        ['language-section', '.language-versions'],
        ['studio-shell', '.studio-shell'],
      ];
      const tags = new Set(['HTML', 'BODY', 'DIV', 'SECTION', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'BUTTON', 'LABEL', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'DIALOG', 'SPAN', 'P', 'H1', 'H2', 'H3', 'A', 'SVG', 'PATH', 'SUMMARY', 'DETAILS']);
      const started = performance.now();
      let observer;
      const listeners = [];
      const append = (ring, entry) => {
        if (ring.length === limit) ring.shift();
        ring.push(entry);
      };
      const diagnosticFailure = stage => {
        if (!failures.some(item => item.stage === stage)) failures.push({ stage, errorKind: 'CaptureError' });
      };
      function identity(node) {
        if (!(node instanceof Element)) return node ? { tag: 'other' } : null;
        return {
          tag: tags.has(node.tagName.toUpperCase()) ? node.tagName.toLowerCase() : 'other',
          identities: selectors.filter(([, selector]) => node.matches(selector)).map(([name]) => name),
          within: selectors.filter(([, selector]) => !!node.closest(selector)).map(([name]) => name),
        };
      }
      function rect(node) {
        if (!node) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      }
      function dialogState(node) {
        return node ? { present: true, connected: node.isConnected, open: node.open, modal: node.matches(':modal') } : { present: false, connected: false, open: false, modal: false };
      }
      function snapshot(stage) {
        try {
          const button = document.querySelector('.ai-action');
          snapshots.push({
            stage,
            time: performance.now() - started,
            button: button ? { rect: rect(button), disabled: button.disabled, inert: !!button.closest('[inert]'), connected: button.isConnected } : null,
            summaryTextareaRect: rect(document.querySelector('textarea#article-description')),
            sourceTextareaRect: rect(document.querySelector('.editor-page textarea.markdown-source')),
            active: identity(document.activeElement),
            languageLoading: !!document.querySelector('.language-versions .loading-panel'),
            aiDialog: dialogState(document.querySelector('dialog.ai-assistant-dialog')),
            reauthDialog: dialogState(document.querySelector('dialog.reauth-backdrop')),
            shellInert: document.querySelector('.studio-shell')?.inert ?? null,
          });
        } catch { diagnosticFailure(stage); }
      }
      function observeMutations(records) {
        try {
          for (const record of records) {
            if (record.type === 'attributes') {
              if (!record.target.matches('dialog.ai-assistant-dialog')) continue;
              append(mutations, {
                type: 'ai-open-attribute', time: performance.now() - started,
                oldOpen: record.oldValue !== null,
                // Current state is at delivery, not necessarily at each mutation.
                stateAtDelivery: dialogState(record.target),
              });
            } else {
              for (const [type, nodes] of [['ai-attached', record.addedNodes], ['ai-detached', record.removedNodes]]) {
                for (const node of nodes) {
                  if (!(node instanceof Element)) continue;
                  const dialog = node.matches('dialog.ai-assistant-dialog') ? node : node.querySelector('dialog.ai-assistant-dialog');
                  if (dialog) append(mutations, { type, time: performance.now() - started, stateAtDelivery: dialogState(dialog) });
                }
              }
            }
          }
        } catch { diagnosticFailure('mutation-capture'); }
      }
      function cleanup() {
        for (const [type, listener] of listeners) {
          try { document.removeEventListener(type, listener, true); }
          catch { diagnosticFailure('listener-cleanup'); }
        }
        if (observer) {
          try { observeMutations(observer.takeRecords()); }
          catch { diagnosticFailure('mutation-drain'); }
          finally {
            try { observer.disconnect(); }
            catch { diagnosticFailure('observer-cleanup'); }
          }
        }
      }
      try {
        for (const type of ['pointerdown', 'pointerup', 'click', 'focusin']) {
          const listener = event => {
            try {
              const pointer = type !== 'focusin';
              const x = pointer ? event.clientX : null, y = pointer ? event.clientY : null;
              append(events, {
                type, time: performance.now() - started, trusted: event.isTrusted,
                x, y, target: identity(event.target),
                elementFromPoint: pointer ? identity(document.elementFromPoint(x, y)) : null,
                active: identity(document.activeElement),
                buttonDisabled: document.querySelector('.ai-action')?.disabled ?? null,
                buttonRect: rect(document.querySelector('.ai-action')),
              });
            } catch { diagnosticFailure('event-capture'); }
          };
          // Register cleanup before installation so partial setup is safe.
          listeners.push([type, listener]);
          document.addEventListener(type, listener, true);
        }
        observer = new MutationObserver(observeMutations);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'], attributeOldValue: true });
        snapshot('before');
        return {
          snapshot,
          finish(success) {
            try { snapshot(success ? 'final-success' : 'final-failure'); }
            finally { cleanup(); }
            return { snapshots, events, mutations, failures };
          },
        };
      } catch {
        cleanup();
        // Never return raw browser exception messages or stacks.
        throw new Error('Initial AI diagnostic setup unavailable');
      }
    });
  } catch (error) { failed('setup', error); }

  return {
    async afterClick() {
      if (!handle) return;
      try { await handle.evaluate(capture => capture.snapshot('after-click')); }
      catch (error) { failed('after-click', error); }
    },
    async finish(operationFailed) {
      let capture = null;
      try {
        if (handle) {
          // Browser callbacks cannot close over this module's operation state.
          try { capture = await handle.evaluate((capture, success) => capture.finish(success), !operationFailed); }
          catch (error) { failed('final-capture-cleanup-unavailable', error); }
        }
      } finally {
        if (handle) {
          try { await handle.dispose(); }
          catch (error) { failed('handle-dispose', error); }
        }
      }
      const report = {
        schemaVersion: 1, outcome, operation: operationFailed ? 'failed' : 'succeeded',
        captureAvailable: capture !== null,
        ...capture,
        failures: [...failures, ...(capture?.failures || [])],
      };
      if (screenshots) {
        try { await writeFile(join(screenshots, 'root-modal-initial-ai-click.json'), JSON.stringify(report, null, 2) + '\n'); }
        catch (error) { failed('persist', error); }
      }
      if (failures.length || capture?.failures.length) {
        // Safe kinds only: a persistence failure cannot report itself in its file.
        console.error('Initial AI click diagnostics unavailable:', JSON.stringify([...failures, ...(capture?.failures || [])]));
        if (!operationFailed) throw new Error('Initial AI click diagnostics unavailable');
      }
    },
  };
}
