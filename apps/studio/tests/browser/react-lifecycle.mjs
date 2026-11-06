import assert from 'node:assert/strict';
import { checkWorkspaceNotice } from './workspace-notice.mjs';
import { checkDashboardPreview } from './dashboard-preview.mjs';
import { checkLegacyRecovery } from './legacy-recovery.mjs';
import { checkMediaDisclosureRace } from './media-disclosure-race.mjs';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const fixture = await build({
  stdin: {
    resolveDir: studio, loader: 'tsx', sourcefile: 'react-lifecycle-fixture.tsx', contents: `
import React, { Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { component, element, domRef } from './src/react-component';
import { onBeforeUnmount, onMounted, ref, watch } from './src/reactivity';
const count = ref(0), events: number[] = [], labels: string[] = [];
let setups = 0, cleanups = 0, mounted = 0, aliveCallbacks = 0;
const Counter = component<{ label: string }>('StrictCounter', props => {
  setups++;
  let alive = true;
  watch(count, value => events.push(value));
  watch(() => props.label, value => labels.push(value));
  onMounted(() => { mounted++; queueMicrotask(() => { if (alive) aliveCallbacks++; }); });
  onBeforeUnmount(() => { alive = false; cleanups++; });
  return () => element('button', { id: 'counter', onClick: () => count.value++ }, props.label + ':' + count.value);
});
const ChildHandle = component('ChildHandle', (_, emit, expose) => { expose({ ready: true }); return () => element('span', null, 'Child'); });
const RefParent = component('RefParent', () => {
  const child = ref<{ ready: boolean }>(), clicks = ref(0);
  if (domRef(child) !== domRef(child)) throw new Error('Ref callbacks must retain identity');
  return () => element('div', null, element(ChildHandle, { ref: domRef(child) }), element('button', { id: 'ref-parent', onClick: () => clicks.value++ }, String(child.value?.ready) + ':' + clicks.value));
});
const pending = new Promise<never>(() => {});
function Suspended() { throw pending; }
const root = createRoot(document.getElementById('root')!);
Object.assign(window, {
  fixture: {
    show(key = 'first', label = 'Count') { root.render(<StrictMode><Counter key={key} label={label} /></StrictMode>); },
    suspend() { root.render(<Suspense fallback={<p id="pending">Waiting</p>}><Counter label="Never committed" /><Suspended /></Suspense>); },
    clear() { root.render(null); },
    handles() { root.render(<StrictMode><RefParent /></StrictMode>); },
    increment() { count.value++; },
    stats() { return { events, labels, setups, cleanups, mounted, aliveCallbacks }; },
  },
});
` },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
});
const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to Chrome/Chromium.');
const browser = await puppeteer.launch({ headless: true, executablePath });
try {
  await checkWorkspaceNotice(browser);
  await checkDashboardPreview(browser);
  await checkLegacyRecovery(browser);
  await checkMediaDisclosureRace(browser);
  const page = await browser.newPage(), errors = [], warnings = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') warnings.push(message.text()); });
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  await page.evaluate(() => window.fixture.show());
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count:0');
  await page.click('#counter');
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count:1');
  let stats = await page.evaluate(() => window.fixture.stats());
  assert.deepEqual(stats.events, [1], 'StrictMode replay must retain one active watcher');
  assert.equal(stats.setups - stats.cleanups, 1);
  assert.ok(stats.aliveCallbacks > 0, 'async guards must be fresh after replay');

  await page.evaluate(() => window.fixture.show('first', 'Updated'));
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Updated:1');
  stats = await page.evaluate(() => window.fixture.stats());
  assert.deepEqual(stats.labels, ['Updated']);
  const beforeRemount = stats.setups;
  await page.evaluate(() => window.fixture.show('second'));
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count:1');
  await page.click('#counter');
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count:2');
  stats = await page.evaluate(() => window.fixture.stats());
  assert.ok(stats.setups > beforeRemount);
  assert.equal(stats.setups - stats.cleanups, 1);
  assert.deepEqual(stats.events, [1, 2], 'remount must not leave duplicate subscriptions');

  await page.evaluate(() => window.fixture.clear());
  await page.waitForFunction(() => !document.querySelector('#counter'));
  stats = await page.evaluate(() => window.fixture.stats());
  assert.equal(stats.setups, stats.cleanups, 'unmount must dispose every controller');
  await page.evaluate(() => window.fixture.increment());
  assert.deepEqual((await page.evaluate(() => window.fixture.stats())).events, [1, 2]);

  const setupBeforeSuspense = stats.setups;
  await page.evaluate(() => window.fixture.suspend());
  await page.waitForSelector('#pending');
  await page.evaluate(() => window.fixture.increment());
  stats = await page.evaluate(() => window.fixture.stats());
  assert.equal(stats.setups, setupBeforeSuspense, 'abandoned renders must not create subscriptions or perform setup');
  assert.deepEqual(stats.events, [1, 2]);
  await page.evaluate(() => window.fixture.handles());
  await page.waitForFunction(() => document.querySelector('#ref-parent')?.textContent === 'true:0');
  for (let i=1; i<=5; i++) { await page.click('#ref-parent'); await page.waitForFunction(i=>document.querySelector('#ref-parent')?.textContent === 'true:'+i,{},i); }
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  console.log('PASS: React StrictMode replay, prop updates, async guards, real unmount/remount and abandoned Suspense renders.');
} finally { await browser.close(); }
