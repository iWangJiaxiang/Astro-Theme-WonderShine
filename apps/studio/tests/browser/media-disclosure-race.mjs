import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

// This isolates scheduling, not trusted pointer activation, CSS, or native WebView behavior.
// summary.click() is intentionally untrusted; the browser still performs native activation
// and queues its own toggle. No synthetic toggle or forced details.open is used.
export async function checkMediaDisclosureRace(browser, { componentSource, expectedRed = false } = {}) {
  assert.equal(typeof expectedRed, 'boolean', 'expectedRed must be an explicit boolean');
  if (componentSource !== undefined) assert.equal(typeof componentSource, 'string', 'componentSource must be source text');
  if (expectedRed) assert.equal(typeof componentSource, 'string', 'expectedRed requires an explicit componentSource');
  const componentPath = fileURLToPath(new URL('../../src/components/MediaBrowser.tsx', import.meta.url));
  let overrideHits = 0;
  const fixture = await build({
    plugins: [fixtureAssetPlugin(), ...(componentSource === undefined ? [] : [{
      name: 'media-disclosure-component-override',
      setup(builder) {
        const exactPath = new RegExp(`^${componentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        builder.onLoad({ filter: exactPath, namespace: 'file' }, ({ path }) => {
          assert.equal(path, componentPath, 'Only the exact MediaBrowser source may be overridden');
          overrideHits++;
          return { contents: componentSource, loader: 'tsx', resolveDir: dirname(componentPath) };
        });
      },
    }])],
    // This fixture checks scheduling, not CSS or external SVG rendering.
    loader: { '.css': 'empty' },
    stdin: {
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
      loader: 'tsx',
      contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import MediaBrowser from './src/components/MediaBrowser';
import { setApiTransport } from './src/api';
import { setMediaResolver } from './shared/media';
import { locale } from './src/i18n';

locale.value = 'zh-CN';
const query = '(max-width: 760px)';
const originalMatchMedia = window.matchMedia;
const host = document.getElementById('root');
const records = [];
const listeners = new Set();
let root, selector, remembered, narrow, initialToggle, pending, calls = 0;
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="green"/></svg>');
const items = ['race-keep.svg', 'other.svg'].map(name => ({
  path: 'public/uploads/' + name, name, directory: 'public/uploads',
  mime: 'image/svg+xml', size: 128,
}));
setMediaResolver(() => image);
setApiTransport(async (path, init) => {
  if (path !== '/media' || init.method !== 'GET') throw new Error('Unexpected fixture API request');
  calls++;
  return new Response(JSON.stringify({ items, truncated: false }));
});

class NarrowQuery extends EventTarget {
  get media() { return query; }
  get matches() { return narrow; }
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (type === 'change') listeners.add(listener);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    if (type === 'change') listeners.delete(listener);
  }
}
const mql = new NarrowQuery();
window.matchMedia = value => value === query ? mql : originalMatchMedia.call(window, value);
function setNarrow(value) {
  if (narrow === value) return;
  narrow = value;
  mql.dispatchEvent(new MediaQueryListEvent('change', { matches: narrow, media: query }));
}
function nextToggle() {
  if (pending) throw new Error('A native toggle is already pending');
  return new Promise(resolve => { pending = resolve; });
}
async function waitToggle(delivery) {
  let timeout;
  try {
    return await Promise.race([
      delivery,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Native toggle was not delivered within 5000ms')), 5000);
      }),
    ]);
  } finally { clearTimeout(timeout); }
}
function captureToggle(event) {
  if (!(event.target instanceof HTMLDetailsElement) || !host.contains(event.target) || !event.target.matches(selector)) return;
  const record = { type: event.type, trusted: event.isTrusted, open: event.target.open };
  records.push(record);
  const resolve = pending;
  pending = undefined;
  if (resolve) resolve(record);
}
// Install before root.render: an initially-open desktop details queues a real toggle.
document.addEventListener('toggle', captureToggle, true);
// After observing native delivery, allow the rest of dispatch (including production's
// React onToggle) and its resulting commit to finish before starting another action.
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function details() {
  const node = host.querySelector(selector);
  if (!(node instanceof HTMLDetailsElement)) throw new Error('Missing browse disclosure');
  return node;
}
function summary() {
  const node = details().querySelector(':scope > summary');
  if (!(node instanceof HTMLElement)) throw new Error('Missing native summary');
  return node;
}
function snapshot() {
  const node = details();
  return {
    open: node.open, sameNode: node === remembered,
    connected: node.isConnected && remembered.isConnected,
    matches: mql.matches, records: records.slice(), calls,
    paths: [...host.querySelectorAll('[data-media-path]')].map(node => node.getAttribute('data-media-path')),
    search: host.querySelector('.media-search input').value,
    alerts: host.querySelectorAll('[role="alert"]').length,
    listeners: listeners.size,
  };
}
let queuedToggle;
window.mediaDisclosureRace = {
  mount(mode, initiallyNarrow) {
    if (root) throw new Error('Fixture must mount only once');
    narrow = initiallyNarrow;
    selector = mode === 'library' ? '.media-directory-disclosure' : '.media-filter-disclosure';
    initialToggle = narrow ? Promise.resolve(null) : nextToggle();
    root = createRoot(host);
    root.render(<MediaBrowser mode={mode} documentPath="content/posts/race/index.md" selected="" svgOnly={false} />);
  },
  ready() {
    return calls === 1 && host.querySelector('.media-browser')?.getAttribute('aria-busy') === 'false'
      && host.querySelectorAll('[data-media-path]').length === 2;
  },
  async baseline() {
    await waitToggle(initialToggle);
    await settle();
    remembered = details();
    return snapshot();
  },
  async activate() {
    const delivered = nextToggle();
    summary().click();
    await waitToggle(delivered);
    await settle();
    return snapshot();
  },
  race() {
    // No await, timer, render flush, or driver round trip may split this task.
    queuedToggle = nextToggle();
    summary().click();
    const before = details().open;
    setNarrow(!narrow);
    const after = details().open;
    return { before, after, ...snapshot() };
  },
  async delivered() {
    await waitToggle(queuedToggle);
    await settle();
    return snapshot();
  },
  snapshot,
  cleanup() {
    try {
      root?.unmount();
      return listeners.size;
    } finally {
      document.removeEventListener('toggle', captureToggle, true);
      for (const listener of listeners) mql.removeEventListener('change', listener);
      window.matchMedia = originalMatchMedia;
      setApiTransport();
      setMediaResolver();
      pending = undefined;
      delete window.mediaDisclosureRace;
    }
  },
};
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  if (componentSource !== undefined) assert.equal(overrideHits, 1, 'The MediaBrowser source override must be loaded exactly once');

  // "public" is the actual MediaMode used for global images; "global" is not valid.
  for (const mode of ['library', 'document', 'public']) {
    for (const initiallyNarrow of [true, false]) {
      const label = `${mode}: ${initiallyNarrow ? 'mobile to desktop' : 'desktop to mobile'}`;
      const page = await browser.newPage();
      const errors = [], warnings = [];
      const onError = error => errors.push(error.message);
      const onConsole = message => {
        if (['error', 'warn'].includes(message.type())) warnings.push(message.text());
      };
      page.on('pageerror', onError);
      page.on('console', onConsole);
      const check = (state, open, matches, requireToggle, paths, search = '') => {
        const { records, ...current } = state;
        assert.deepEqual(current, {
          open, sameNode: true, connected: true, matches,
          calls: 1, paths, search, alerts: 0, listeners: 1,
        }, label);
        assert.ok(records.every(record => record.type === 'toggle' && record.trusted === true), `${label}: only browser-delivered native toggles`);
        if (requireToggle) {
          assert.ok(records.length > 0, `${label}: native toggle delivery must be observed`);
          assert.equal(records.at(-1).open, open, `${label}: delivered toggle reads current DOM state`);
        }
      };
      const paths = ['public/uploads/race-keep.svg', 'public/uploads/other.svg'];
      const failures = [];
      let phase = 'setup', failurePhase;
      const raceAfterMessage = `${label}: breakpoint must synchronously override the stale ref`;
      try {
        await page.setContent('<!doctype html><div id="root"></div>');
        await page.addScriptTag({ content: fixture.outputFiles[0].text });
        await page.evaluate((mode, narrow) => window.mediaDisclosureRace.mount(mode, narrow), mode, initiallyNarrow);
        await page.waitForFunction(() => window.mediaDisclosureRace.ready());
        check(await page.evaluate(() => window.mediaDisclosureRace.baseline()), !initiallyNarrow, initiallyNarrow, !initiallyNarrow, paths);

        // Consume the baseline activation's real toggle before arranging the race.
        // On desktop this closes the disclosure and sets the production ref false;
        // on mobile it opens it and sets that ref true.
        check(await page.evaluate(() => window.mediaDisclosureRace.activate()), initiallyNarrow, initiallyNarrow, true, paths);
        const race = await page.evaluate(() => window.mediaDisclosureRace.race());
        phase = 'race.before';
        assert.equal(race.before, !initiallyNarrow, `${label}: native activation must change DOM synchronously`);
        phase = 'race.after';
        assert.equal(race.after, initiallyNarrow, raceAfterMessage);
        phase = 'race.snapshot';
        const { before, after, ...synchronousState } = race;
        check(synchronousState, initiallyNarrow, !initiallyNarrow, true, paths);

        check(await page.evaluate(() => window.mediaDisclosureRace.delivered()), initiallyNarrow, !initiallyNarrow, true, paths);
        await page.type('.media-search input[type="search"]', 'race-keep');
        await page.waitForFunction(() => {
          const cards = document.querySelectorAll('[data-media-path]');
          return cards.length === 1 && cards[0].getAttribute('data-media-path') === 'public/uploads/race-keep.svg';
        });
        check(await page.evaluate(() => window.mediaDisclosureRace.snapshot()), initiallyNarrow, !initiallyNarrow, true, [paths[0]], 'race-keep');
      } catch (error) {
        failurePhase = phase;
        failures.push(error);
      } finally {
        try {
          const remainingListeners = await page.evaluate(() => window.mediaDisclosureRace?.cleanup());
          assert.equal(remainingListeners, 0, `${label}: unmount must remove production MQL listeners`);
        } catch (error) { failures.push(error); }
        try { assert.deepEqual(errors, [], `${label}: page errors`); }
        catch (error) { failures.push(error); }
        try { assert.deepEqual(warnings, [], `${label}: console errors/warnings`); }
        catch (error) { failures.push(error); }
        page.off('pageerror', onError);
        page.off('console', onConsole);
        try { await page.close(); }
        catch (error) { failures.push(error); }
      }
      // Classify only after every cleanup/error check. Never unwrap aggregates or
      // count setup, timeout, page/console, or cleanup failures as the expected red.
      if (expectedRed && failures.length === 1 && failurePhase === 'race.after') {
        const error = failures[0];
        const expectedMessage = new AssertionError({
          message: raceAfterMessage, actual: !initiallyNarrow, expected: initiallyNarrow, operator: 'strictEqual',
        }).message;
        if (error instanceof AssertionError && error.constructor === AssertionError
          && error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual'
          && error.message === expectedMessage
          && error.actual === !initiallyNarrow && error.expected === initiallyNarrow) {
          console.log(`EXPECTED RED: ${label}; stage=race.after actual=${error.actual} expected=${error.expected}`);
          continue;
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, `${label}: regression and cleanup failures`, { cause: failures[0] });
      if (expectedRed) throw new Error(`${label}: unexpected pass; expected the precise race.after assertion failure`);
      console.log(`PASS: media disclosure race ${label}`);
    }
  }
}
