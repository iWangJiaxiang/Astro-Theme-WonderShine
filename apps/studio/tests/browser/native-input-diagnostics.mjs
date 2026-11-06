import * as fs from 'node:fs/promises';

// Dedicated to the first API address fill, not subsequent model/key inputs.
export async function startNativeInputDiagnostics(page, input, label, expected) {
  const report = {
    version: 1, scope: 'first-api-address-fill-only', maxEvents: 80,
    eventObservation: 'document-capture', outcome: 'not-finished',
    snapshots: [], events: [], droppedEvents: 0, unavailable: [],
  };
  let recorder;
  const attempt = async (stage, operation) => {
    try { return await operation(); }
    catch { report.unavailable.push(stage); }
  };
  await attempt('start', async () => {
    // Every Node-side parameter is explicitly passed; browser callbacks cannot
    // close over Node variables. The returned methods only close over browser state.
    recorder = await page.evaluateHandle((original, label, expected, maxEvents) => {
      const selector = '.native-ai-settings label';
      const controller = new AbortController();
      const data = { snapshots: [], events: [], droppedEvents: 0 };
      const labels = () => [...document.querySelectorAll(selector)]
        .filter(node => node.querySelector('span')?.textContent === label);
      const freshInput = () => labels()[0]?.querySelector('input') ?? null;
      const role = node => node && (node === original || node === freshInput()) ? 'targetinput'
        : node && node === document.querySelector('.main-content h1') ? 'destinationheading' : 'other';
      const describe = (node, fresh) => node instanceof HTMLInputElement ? {
        inputType: node.type, isConnected: node.isConnected, sameAsFreshQuery: node === fresh,
        disabled: node.disabled, readOnly: node.readOnly, inert: !!node.closest('[inert]'),
        value: { empty: node.value.length === 0, length: node.value.length, matchesExpected: node.value === expected },
      } : null;
      const capture = stage => {
        const fresh = freshInput();
        data.snapshots.push({
          stage, timestamp: performance.now(), active: role(document.activeElement),
          selector, selectorMatchCount: document.querySelectorAll(selector).length,
          labelMatchCount: labels().length,
          original: describe(original, fresh), fresh: describe(fresh, fresh),
        });
        return data;
      };
      const onEvent = event => {
        if (data.events.length >= maxEvents) { data.droppedEvents++; return; }
        // Never inspect key/code/data, text, HTML, attributes or actual values.
        data.events.push({
          type: event.type, timestamp: event.timeStamp, observedAt: performance.now(),
          target: role(event.target), defaultPrevented: event.defaultPrevented,
          trusted: event.isTrusted, active: role(document.activeElement),
        });
      };
      try {
        for (const type of ['focusin', 'focusout', 'keydown', 'beforeinput', 'input', 'change']) {
          document.addEventListener(type, onEvent, { capture: true, passive: true, signal: controller.signal });
        }
        capture('before');
        return {
          capture,
          finish: () => {
            try { return capture('finally'); }
            finally { controller.abort(); }
          },
          stop: () => controller.abort(),
        };
      } catch (error) {
        controller.abort();
        throw error;
      }
    }, input, label, expected, report.maxEvents);
  });
  return {
    after: async () => {
      if (recorder) await attempt('after', async () => {
        Object.assign(report, await recorder.evaluate((state, stage) => state.capture(stage), 'after'));
      });
    },
    finish: async outcome => {
      report.outcome = outcome;
      if (recorder) {
        try {
          await attempt('finally', async () => {
            Object.assign(report, await recorder.evaluate(state => state.finish()));
          });
        } finally {
          // Independent cleanup also runs if taking/serializing the final snapshot failed.
          await attempt('listener-cleanup', () => recorder.evaluate(state => state.stop()));
          await attempt('recorder-dispose', () => recorder.dispose());
          recorder = undefined;
        }
      }
    },
    persist: async (path, runOutcome) => {
      report.runOutcome = runOutcome;
      await attempt('persist', () => fs.writeFile(path, JSON.stringify(report, null, 2) + '\n'));
    },
    get available() { return report.unavailable.length === 0; },
  };
}
