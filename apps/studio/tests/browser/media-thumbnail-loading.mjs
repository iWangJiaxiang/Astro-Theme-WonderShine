import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

// Real MediaBrowser/MediaPicker and media-store, synthetic listing/image transport.
// The small fixture layout makes image responses controllable; it is not production
// geometry, a reproduction of a31f7de, a network-priority benchmark or native acceptance.
export async function checkMediaThumbnailLoading(browser) {
  const fixture = await build({
    plugins: [fixtureAssetPlugin()],
    loader: { '.css': 'empty' },
    stdin: {
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
      loader: 'tsx',
      contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import MediaBrowser from './src/components/MediaBrowser';
import MediaPicker from './src/components/MediaPicker';
import { setApiTransport } from './src/api';
import { setMediaResolver } from './shared/media';
import { mediaVersion } from './src/media-store';
import { locale } from './src/i18n';
locale.value = 'en';
const host = document.getElementById('root');
const root = createRoot(host);
const reads = [], unexpected = [], selections = [];
const items = Array.from({ length: 30 }, (_, index) => {
  const name = 'thumb-' + String(index).padStart(2, '0') + '.svg';
  const directory = index < 24 ? 'public/alpha' : 'public/beta';
  return { path: directory + '/' + name, name, directory, mime: 'image/svg+xml', size: 128,
    ...(index === 0 ? { unavailable: 'Fixture unavailable' } : {}) };
});
let epoch = 0;
setMediaResolver((path, version) => {
  const index = items.findIndex(item => item.path === path);
  if (index < 0) throw new Error('Unexpected synthetic image');
  return '/thumbnail/' + index + '?v=' + version + '&mount=' + epoch;
});
setApiTransport((path, init) => {
  if (init.method !== 'GET' || !['/media', '/media?refresh=1'].includes(path)) {
    unexpected.push({ path, method: init.method });
    return Promise.reject(new Error('Unexpected synthetic API request'));
  }
  return new Promise(resolve => reads.push({ path, resolve, stage: 'transport' }));
});
const card = index => document.querySelector('[data-media-path="' + items[index].path + '"]');
const image = index => card(index)?.querySelector('img');
let rememberedCard, rememberedImage;
window.thumbnailLoading = {
  reads: () => reads.map(({ path, stage }) => ({ path, stage })),
  unexpected, selections,
  mount(kind) {
    epoch++;
    root.render(kind === 'picker'
      ? <MediaPicker mode="public" documentPath="" selected="" svgOnly={false}
          onClose={() => root.render(null)} onSelect={(item, value) => selections.push({ path: item.path, value })} />
      : <MediaBrowser mode="library" documentPath="" selected="" svgOnly={false}
          onSelect={(item, value) => selections.push({ path: item.path, value })} />);
  },
  clear() { root.render(null); },
  headers(index) {
    const read = reads[index];
    if (read?.stage !== 'transport') throw new Error('Missing held listing response');
    const body = new ReadableStream({ start(controller) { read.controller = controller; } });
    read.stage = 'body';
    read.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  },
  json(index) {
    const read = reads[index];
    if (read?.stage !== 'body') throw new Error('Missing held listing body');
    read.controller.enqueue(new TextEncoder().encode(JSON.stringify({ items, truncated: false })));
    read.controller.close();
    read.stage = 'done';
  },
  snapshot() {
    return {
      version: mediaVersion.value,
      busy: document.querySelector('.media-browser')?.getAttribute('aria-busy') ?? null,
      cards: [...document.querySelectorAll('.media-card')].map(node => {
        const img = node.querySelector('img');
        return { index: items.findIndex(item => item.path === node.dataset.mediaPath), disabled: node.disabled,
          image: img ? { loading: img.loading, decoding: img.decoding, loaded: img.complete && img.naturalWidth > 0,
            version: Number(new URL(img.src).searchParams.get('v')), mount: Number(new URL(img.src).searchParams.get('mount')) } : null };
      }),
    };
  },
  remember(index) { rememberedCard = card(index); rememberedImage = image(index); },
  identity(index) {
    return { card: rememberedCard === card(index) && rememberedCard?.isConnected === true,
      image: rememberedImage === image(index) && rememberedImage?.isConnected === true,
      oldImageConnected: rememberedImage?.isConnected === true };
  },
  cleanup() {
    root.unmount();
    for (const read of reads) {
      if (read.stage === 'transport') read.resolve(Response.json({ items: [], truncated: false }));
      if (read.stage === 'body') { read.controller.enqueue(new TextEncoder().encode('{"items":[],"truncated":false}')); read.controller.close(); }
    }
    setApiTransport();
    setMediaResolver();
    delete window.thumbnailLoading;
  },
};
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const page = await browser.newPage();
  const errors = [], warnings = [], unexpected = [], interceptionErrors = [], held = new Map(), interceptionTasks = new Set();
  // Keep identities in the synthetic namespace, never real media URLs or content.
  const origin = 'https://thumbnail-loading.example';
  const key = (index, version, mount) => `${index}:${version}:${mount}`;
  const imageBytes = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>';
  const onError = error => errors.push(error.message);
  const onConsole = message => { if (['error', 'warn'].includes(message.type())) warnings.push(message.text()); };
  const onRequest = request => {
    const action = async () => {
      const url = new URL(request.url());
      if (request.isNavigationRequest() && url.href === origin + '/') {
        await request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>' });
        return;
      }
      if (url.origin === origin && /^\/thumbnail\/\d+$/.test(url.pathname)) {
        const id = key(Number(url.pathname.split('/').at(-1)), Number(url.searchParams.get('v')), Number(url.searchParams.get('mount')));
        held.set(id, [...(held.get(id) || []), request]);
        return;
      }
      unexpected.push(url.origin === origin ? url.pathname : 'external');
      await request.abort();
    };
    const task = action().catch(error => interceptionErrors.push(error));
    interceptionTasks.add(task);
    void task.finally(() => interceptionTasks.delete(task));
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  const failures = [];
  try {
    await page.setViewport({ width: 1200, height: 1000 });
    await page.setRequestInterception(true);
    page.on('request', onRequest);
    await page.goto(origin);
    // Deliberately synthetic sizing, not a production-CSS acceptance fixture.
    await page.addStyleTag({ content: '.media-workspace{display:flex;gap:12px}.media-directory-disclosure{width:180px;flex-shrink:0}.media-results{flex:1}.media-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}.media-card{display:flex;flex-direction:column;font-size:10px}.media-thumbnail,.media-thumbnail img{display:block;width:24px;height:24px}.media-dialog{width:1000px;max-height:950px}.media-dialog-body{max-height:800px;overflow:auto}' });
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    const snapshot = () => page.evaluate(() => window.thumbnailLoading.snapshot());
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const selector = index => `[data-media-path$="/thumb-${String(index).padStart(2, '0')}.svg"]`;
    const waitCards = indexes => page.waitForFunction(indexes => {
      const state = window.thumbnailLoading.snapshot();
      return state.busy === 'false' && JSON.stringify(state.cards.map(card => card.index)) === JSON.stringify(indexes);
    }, {}, indexes);
    const policy = async (indexes, missing = []) => {
      const state = await snapshot();
      assert.deepEqual(state.cards.map(card => card.index), indexes, 'policy applies to the current page, in result order');
      const previewable = indexes.filter(index => !missing.includes(index));
      for (const card of state.cards) {
        if (missing.includes(card.index)) assert.equal(card.image, null, `item ${card.index} has fallback, not an image`);
        else {
          assert.ok(card.image, `item ${card.index} has its real img`);
          assert.equal(card.image.loading, previewable.indexOf(card.index) < 4 ? 'eager' : 'lazy', `item ${card.index}: bounded eager prefix`);
          assert.equal(card.image.decoding, 'async');
          assert.equal(card.image.version, state.version, 'current version is rendered');
        }
      }
      return state;
    };
    const pendingImage = async (index, version, mount) => {
      const id = key(index, version, mount);
      // Wait for this exact request; do not infer that lazy forbids other requests.
      if (!held.has(id)) await page.waitForRequest(request => {
        const url = new URL(request.url());
        return url.origin === origin && url.pathname === '/thumbnail/' + index
          && Number(url.searchParams.get('v')) === version && Number(url.searchParams.get('mount')) === mount;
      });
      assert.ok(held.get(id)?.length, `synthetic image ${id} is held`);
      return id;
    };
    const release = async (index, version, mount, invalid = false) => {
      const id = key(index, version, mount);
      if (!held.has(id)) await pendingImage(index, version, mount);
      const requests = held.get(id);
      held.delete(id);
      // Return 200 with invalid bytes for a real decode error, without expected HTTP console noise.
      await Promise.all(requests.map(request => request.respond({ status: 200,
        contentType: 'image/svg+xml', headers: { 'Cache-Control': 'no-store' }, body: invalid ? 'not an image' : imageBytes })));
    };
    const loaded = index => page.waitForFunction(index => window.thumbnailLoading.snapshot().cards.find(card => card.index === index)?.image?.loaded === true, {}, index);
    const allFirst = Array.from({ length: 24 }, (_, index) => index);
    const second = [24, 25, 26, 27, 28, 29];
    const readCount = () => page.evaluate(() => window.thumbnailLoading.reads().length);

    await page.evaluate(() => window.thumbnailLoading.mount('library'));
    await page.waitForFunction(() => window.thumbnailLoading.reads().length === 1);
    assert.equal((await snapshot()).busy, 'true');
    await page.evaluate(() => window.thumbnailLoading.headers(0));
    await settle();
    assert.equal((await snapshot()).busy, 'true', 'response headers alone do not complete listing work');
    assert.equal((await snapshot()).cards.length, 0);
    await page.evaluate(() => window.thumbnailLoading.json(0));
    await waitCards(allFirst);
    const initial = await policy(allFirst, [0]);
    const version = initial.version;
    assert.ok(initial.cards.filter(card => card.image).every(card => !card.image.loaded), 'listing finishes while every image response is held');
    assert.ok(initial.cards.filter(card => card.image).every(card => !card.disabled), 'image work does not block otherwise eligible choices');
    await page.click(selector(1));
    assert.equal(await page.evaluate(() => window.thumbnailLoading.selections.length), 1, 'selection does not await image bytes');

    // A later list item can finish first. This does not promise visible-first completion.
    await release(5, version, 1);
    await loaded(5);
    assert.equal((await snapshot()).cards.find(card => card.index === 1).image.loaded, false);
    assert.equal((await snapshot()).busy, 'false', 'image work does not extend list aria-busy');
    await release(1, version, 1);
    await loaded(1);
    await page.evaluate(() => window.thumbnailLoading.remember(1));
    await release(2, version, 1, true);
    await page.waitForFunction(() => window.thumbnailLoading.snapshot().cards.find(card => card.index === 2)?.image === null);
    await policy(allFirst, [0, 2]);

    // Refresh the actual store: same path/key, new image URL, and cleared failures.
    await page.click('.media-toolbar > button');
    await page.waitForFunction(() => window.thumbnailLoading.reads().length === 2);
    await page.evaluate(() => { window.thumbnailLoading.headers(1); window.thumbnailLoading.json(1); });
    await waitCards(allFirst);
    const refreshed = await policy(allFirst, [0]);
    assert.equal(refreshed.version, version + 1);
    assert.deepEqual(await page.evaluate(() => window.thumbnailLoading.identity(1)), { card: true, image: true, oldImageConnected: true }, 'version updates preserve keyed card and img identities');
    assert.equal(refreshed.cards.find(card => card.index === 1).image.loaded, false, 'old loaded bytes do not satisfy a held new source');
    // Old-source requests may be cancelled by the UA. Do not deliver obsolete
    // interception IDs or pretend this exercises a stale network-event race.
    assert.equal(refreshed.cards.find(card => card.index === 3).image.loaded, false, 'previously pending item also has a held current source');
    await release(2, refreshed.version, 1);
    await loaded(2);

    // Real search and pagination events change which paths own the fixed budget.
    await page.type('.media-search input', 'thumb-2');
    await waitCards([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    await policy([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    await page.$eval('.media-search input', node => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(node, ''); node.dispatchEvent(new Event('input', { bubbles: true })); });
    await waitCards(allFirst);
    await page.click('.media-pagination .row > button:last-child');
    await waitCards(second);
    await policy(second);
    await page.click('.directory-choice[title="public/beta"]');
    await page.waitForFunction(() => document.querySelector('.media-directory-row.active .directory-choice')?.title === 'public/beta' && !document.querySelector('.media-pagination .row'));
    await waitCards(second);
    await policy(second);
    assert.equal(await page.$('.media-pagination .row'), null, 'folder filtering returns to its single first page');
    await page.click('.directory-all');
    await waitCards(allFirst);
    await policy(allFirst, [0]);
    assert.equal(await readCount(), 2, 'filtering/pagination do not refresh or upload');

    // Actual picker remount reuses the recent listing, not library image DOM.
    await page.evaluate(() => window.thumbnailLoading.remember(1));
    await page.evaluate(() => window.thumbnailLoading.clear());
    await page.waitForSelector('.media-browser', { hidden: true });
    await page.evaluate(() => window.thumbnailLoading.mount('picker'));
    await page.waitForSelector('dialog.media-dialog[open]');
    const pickerIndexes = Array.from({ length: 24 }, (_, index) => index + 1);
    await waitCards(pickerIndexes);
    await policy(pickerIndexes);
    assert.deepEqual(await page.evaluate(() => window.thumbnailLoading.identity(1)), { card: false, image: false, oldImageConnected: false });
    await settle();
    assert.equal(await readCount(), 2, 'picker uses the fresh complete listing cache');
    assert.ok((await snapshot()).cards.every(card => !card.image.loaded), 'new mount has held image responses, not invented image readiness');
    await page.click(selector(1));
    assert.equal(await page.$eval('.selection-footer > button', node => node.disabled), false, 'picker confirmation is available before image completion');
    await page.click('.media-dialog .card-heading > button');
    await page.waitForSelector('dialog.media-dialog', { hidden: true });
    assert.equal(await page.evaluate(() => window.thumbnailLoading.selections.length), 1, 'cancel does not publish the pending picker selection');
    assert.deepEqual(await page.evaluate(() => window.thumbnailLoading.unexpected), []);
  } catch (error) {
    failures.push(error);
  } finally {
    try { await page.evaluate(() => window.thumbnailLoading?.cleanup()); }
    catch (error) { failures.push(error); }
    // Closing the isolated page cancels outstanding image requests without making
    // obsolete interception IDs into an accidental cleanup acceptance condition.
    page.off('request', onRequest);
    try { await page.close(); } catch (error) { failures.push(error); }
    await Promise.all([...interceptionTasks]);
    page.off('pageerror', onError);
    page.off('console', onConsole);
    held.clear();
    try { assert.deepEqual(errors, [], 'fixture page errors'); } catch (error) { failures.push(error); }
    try { assert.deepEqual(warnings, [], 'fixture console errors/warnings'); } catch (error) { failures.push(error); }
    try { assert.deepEqual(unexpected, [], 'unexpected external/resource requests'); } catch (error) { failures.push(error); }
    failures.push(...interceptionErrors);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Thumbnail loading regression or cleanup failed', { cause: failures[0] });
  console.log('PASS: bounded eager thumbnail prefix, held listing/image stages, nonblocking selection, out-of-order completion, failure promotion, version reset, filtering/pagination and cached-list picker remount (synthetic transport; not production preview acceptance).');
  return { realmCount: 1, mountCount: 2 };
}
