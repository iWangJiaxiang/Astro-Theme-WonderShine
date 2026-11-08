import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

// Remote-only standalone entry. One worker owns all bundling/browser/fixture IO;
// the parent has no filesystem promises and confirms process-group termination.
// Chromium DOM layout/input evidence, not WebView, actual zoom, OS text size or AT.
const studio = fileURLToPath(new URL('../../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const fixtureModule = new URL('./native-actions-layout-fixture.mjs', import.meta.url).href;
const output = join(studio, 'test-results/native-actions-layout');
const caps = Object.freeze({ workerMs: 150000, operationMs: 5000, bytes: 196608, faults: 8, tabs: 16, wheels: 16, pngs: 36 });
const codes = new Set(['setup', 'bundle', 'css', 'browser', 'fixture', 'ready', 'counter', 'transport', 'oauth', 'label', 'intrinsic', 'geometry', 'wrap', 'gap', 'alignment', 'grow', 'padding', 'target', 'overflow', 'visibility', 'focus', 'input', 'busy', 'pending', 'draft', 'cancel', 'drain', 'cleanup', 'deadline', 'report', 'matrix', 'worker', 'page', 'console', 'resource', 'unhandled', 'screenshot']);
const need = (value, code) => { if (!value) throw new Error(code); };
const fixed = (error, fallback) => codes.has(error?.message) ? error.message : fallback;
const fault = (list, code) => { if (list.length < caps.faults) list.push(code); else list[caps.faults - 1] = 'counter'; };
const ua = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; LayoutFixture) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
};
export function nativeActionCases() {
  const rows = [];
  for (const [width, height, platform] of [[320, 568, 'ios'], [375, 667, 'android'], [390, 844, 'ios'], [568, 320, 'ios'], [600, 900, 'android'], [601, 900, 'android'], [844, 390, 'ios'], [1440, 1000, 'desktop']]) {
    for (const locale of ['en', 'zh-CN']) rows.push({ id: rows.length, kind: 'layout', width, height, platform, locale, providers: 'both', state: 'ordinary', get: 1, review: 0, pngs: 2 });
  }
  rows.push({ id: 16, kind: 'state', width: 320, height: 568, platform: 'ios', locale: 'en', providers: 'github', state: 'ordinary', get: 0, review: 0, pngs: 1 });
  rows.push({ id: 17, kind: 'state', width: 390, height: 844, platform: 'android', locale: 'zh-CN', providers: 'cnb', state: 'ordinary', get: 0, review: 0, pngs: 1 });
  rows.push({ id: 18, kind: 'state', width: 375, height: 667, platform: 'android', locale: 'en', providers: 'both', state: 'disabled', get: 0, review: 0, pngs: 0 });
  rows.push({ id: 19, kind: 'state', width: 320, height: 568, platform: 'ios', locale: 'en', providers: 'both', state: 'review', get: 1, review: 1, pngs: 2 });
  return rows.map(Object.freeze);
}
const designed = Object.freeze(nativeActionCases());
const inventory = () => designed.map(row => ({ ...row, status: 'not-run', primary: null, secondary: [], measurements: [], focus: [], counts: null, pngCount: 0, drained: false }));

async function bounded(action, ms = caps.operationMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); })]);
  } finally { clearTimeout(timer); }
}
function observe(child) {
  return new Promise(done => {
    child.on('error', () => done({ failed: true })); // Keep late errors handled.
    child.once('exit', (code, signal) => done({ failed: code !== 0 || signal !== null }));
  });
}
function releaseReferences(child) {
  if (!child) return;
  for (const stream of child.stdio || []) { stream?.on('error', () => {}); stream?.removeAllListeners('data'); stream?.destroy(); stream?.unref?.(); }
  child.unref(); // Keepalive release is NEVER process-exit evidence.
}
function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw new Error('cleanup'); }
}
function groupExists(child) {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw new Error('cleanup'); }
}
async function groupGone(child, ms) {
  const deadline = Date.now() + ms;
  while (groupExists(child)) { if (Date.now() >= deadline) return false; await delay(25); }
  return true;
}
async function stopGroup(child, settled) {
  try {
    if (!child?.pid) { if (settled) await bounded(() => settled, 1000); return; }
    signalGroup(child, 'SIGTERM');
    if (!await groupGone(child, 1000)) { signalGroup(child, 'SIGKILL'); need(await groupGone(child, 2000), 'cleanup'); }
    await bounded(() => settled, 1000); need(!groupExists(child), 'cleanup');
  } finally { releaseReferences(child); }
}
async function stopChrome(child, settled) {
  try {
    if (!child?.pid) return;
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      try { await bounded(() => settled, 1000); } catch { child.kill('SIGKILL'); await bounded(() => settled, 1000); }
    }
    await bounded(() => settled, 1000);
  } finally { releaseReferences(child); }
}

const retiredPages = new WeakSet();
const live = page => need(!retiredPages.has(page) && !page.isClosed(), 'deadline');
const wait = async (page, predicate, ...args) => {
  const handle = await page.waitForFunction(predicate, { timeout: caps.operationMs }, ...args);
  try { return true; } finally { await handle.dispose(); }
};
async function settle(page) {
  // Readiness sampling is bounded and never repeats an input action.
  await wait(page, () => !!window.nativeActions && document.fonts.status === 'loaded');
  await bounded(() => page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); }));
}
async function measurement(page, row, surface) {
  const sample = () => bounded(() => page.evaluate((surface, locale, providers, width, platform) => window.nativeActionGeometry.inspect(surface, locale, providers, width, platform), surface, row.locale, row.providers, row.width, row.platform));
  const first = await sample();
  await settle(page);
  const second = await sample();
  sameGeometry(first, second);
  need(first.buttons.every((button, index) => button.box.every((value, axis) => Math.abs(value - second.buttons[index].box[axis]) <= 1)), 'geometry');
  return second;
}
function sameGeometry(a, b) {
  need(a.surface === b.surface && JSON.stringify(a.rows) === JSON.stringify(b.rows) && a.buttons.length === b.buttons.length, 'geometry');
  for (let i = 0; i < a.buttons.length; i++) {
    const x = a.buttons[i], y = b.buttons[i];
    // Scroll may change absolute top. Relative row/button geometry must not jump.
    for (let axis = 0; axis < 4; axis++) {
      const originA = axis % 2 ? a.buttons[0].box[1] : a.buttons[0].box[0];
      const originB = axis % 2 ? b.buttons[0].box[1] : b.buttons[0].box[0];
      need(Math.abs((x.box[axis] - originA) - (y.box[axis] - originB)) <= 1, 'geometry');
    }
    need(Math.abs(x.natural - y.natural) <= 1 && x.textLines === y.textLines, 'geometry');
  }
}
async function reveal(page, selector) {
  for (let i = 0; i <= caps.wheels; i++) {
    const state = await bounded(() => page.$eval(selector, node => {
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, view: innerHeight };
    }));
    if (state.top >= 64 && state.bottom <= state.view - 12) return;
    if (i === caps.wheels) break;
    const center = (state.top + state.bottom) / 2;
    live(page); await page.mouse.move(8, Math.round(state.view / 2));
    live(page); await page.mouse.wheel({ deltaY: Math.max(-240, Math.min(240, center - state.view / 2)) });
    await settle(page);
    // Near a document edge, a target can be fully visible without centering.
    if (state.height > state.view - 76) break;
  }
  // Visibility, clipping and hit-test checks (not the wheel acknowledgment) are
  // authoritative. A failed reveal is not repaired by scrollIntoView/focus().
}
async function pointer(page, selector) {
  await reveal(page, selector);
  const point = await bounded(() => page.$eval(selector, node => {
    window.nativeActionGeometry.visible(node);
    if (node.matches(':disabled')) throw new Error('input');
    const r = node.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];
  }));
  live(page); await page.mouse.click(...point); // Exactly one physical dispatch, no locator retry.
}
async function tabGroup(page, surface) {
  const visited = [];
  let enabled;
  for (let i = 0; i < caps.tabs; i++) {
    live(page); await page.keyboard.press('Tab');
    await settle(page);
    const id = await page.evaluate(surface => {
      const group = document.querySelector(window.nativeActionGeometry.target(surface));
      return [...group.children].indexOf(document.activeElement);
    }, surface);
    if (id < 0) continue;
    await reveal(page, `${surface === 'login' ? '.account-login-buttons' : '.workspace-sync-actions'} > button:nth-child(${id + 1})`);
    const state = await page.evaluate(surface => window.nativeActionGeometry.focus(surface), surface);
    enabled = state.enabled;
    need(!visited.includes(state.id), 'focus'); visited.push(state.id);
    if (visited.length === enabled.length) {
      const start = enabled.indexOf(visited[0]);
      const expected = [...enabled.slice(start), ...enabled.slice(0, start)];
      need(JSON.stringify(visited) === JSON.stringify(expected), 'focus'); return visited;
    }
  }
  throw new Error('focus');
}
async function capture(page, record, slot, selector) {
  need(record.pngCount < record.pngs && ['login', 'workspace', 'busy', 'pending'].includes(slot), 'counter');
  await reveal(page, selector); await settle(page);
  await page.$eval(selector, node => window.nativeActionGeometry.visible(node));
  // Viewport only: fullPage would silently change the short-landscape evidence.
  live(page);
  await bounded(() => page.screenshot({ path: join(output, `case-${record.id}-${slot}.png`), fullPage: false, captureBeyondViewport: false, type: 'png' }));
  // An outer deadline may retire this page while screenshot IO completes late.
  // Only a timely resolved capture is counted; never retry a timed-out write.
  live(page); record.pngCount++;
}
function validateCompletion(completion, row, drained) {
  need(completion && completion.actionStarted === 0 && completion.actionDone === 0, 'drain');
  for (const kind of ['api', 'request', 'effect', 'review', 'action']) {
    const expected = kind === 'effect' ? row.get : kind === 'review' ? row.review : kind === 'action' ? 0 : row.get + row.review;
    need(completion[kind + 'Started'] === expected && completion[kind + 'Done'] === expected, 'drain');
  }
  need(completion.active === 0 && (!drained || completion.drained), 'drain');
}
function validateCounts(state, row, drained) {
  validateCompletion(state.completion, row, false);
  need(state.get === row.get && state.review === row.review && state.unexpected === 0 && state.oauth === 0 && state.unhandled === 0 && !state.saturated && state.faults.length === 0, 'transport');
  if (drained) need(!state.held && state.active === 0 && state.mutations === 0 && state.started === state.done, 'drain');
}

async function reviewCase(page, row, record) {
  const input = '.workspace-panel .field input';
  await pointer(page, input);
  await page.keyboard.down('Control');
  try { await page.keyboard.press('KeyA'); } finally { await page.keyboard.up('Control'); }
  await page.keyboard.type('docs(content): layout regression draft');
  need(await page.evaluate(() => window.nativeActions.messagePreserved()), 'draft');
  const initial = await measurement(page, row, 'workspace'); record.measurements.push(initial);
  // Dirty status leaves only commit and commit-sync enabled. Preserve that guard.
  need(JSON.stringify(initial.buttons.map(b => b.disabled)) === '[false,true,false]', 'busy');
  await pointer(page, '.workspace-sync-actions > button:nth-child(3)');
  await wait(page, () => window.nativeActions.snapshot().held && window.nativeActions.snapshot().review === 1 && [...document.querySelectorAll('.workspace-sync-actions > button')].every(b => b.disabled) && document.querySelector('.workspace-panel .field input')?.disabled && document.querySelector('.workspace-panel .page-heading button')?.disabled);
  need(await page.evaluate(() => window.nativeActions.messagePreserved() && !document.querySelector('.workspace-sync-card > [role="group"]')), 'busy');
  sameGeometry(initial, await measurement(page, row, 'workspace'));
  await capture(page, record, 'busy', '.workspace-sync-actions');
  await page.evaluate(() => window.nativeActions.release());
  await wait(page, () => document.querySelector('.workspace-sync-card > [role="group"]') && window.nativeActions.snapshot().mutations === 0);
  const pending = await measurement(page, row, 'workspace'); sameGeometry(initial, pending);
  need(pending.buttons.every(b => b.disabled), 'pending');
  need(await page.evaluate(() => window.nativeActions.messagePreserved() && document.querySelector('.workspace-panel .field input').disabled && document.querySelector('.workspace-panel .page-heading button').disabled), 'draft');
  const confirmation = '.workspace-sync-card > [role="group"]';
  await page.$eval(confirmation, group => {
    const buttons = [...group.querySelectorAll('button')];
    if (buttons.length !== 2 || buttons.some(b => b.disabled) || buttons[0].textContent.trim() !== 'Confirm and proceed' || buttons[1].textContent.trim() !== 'Cancel') throw new Error('pending');
    const a = buttons[0].getBoundingClientRect(), b = buttons[1].getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) throw new Error('geometry');
  });
  // Do not programmatically seed a focus boundary. Native Tab must make both
  // confirmation controls reachable while all original actions stay disabled.
  const seen = [];
  for (let i = 0; i < caps.tabs && seen.length < 2; i++) {
    live(page); await page.keyboard.press('Tab'); await settle(page);
    const id = await page.$eval(confirmation, group => [...group.querySelectorAll('button')].indexOf(document.activeElement));
    if (id < 0) continue;
    await reveal(page, `${confirmation} > button:nth-of-type(${id + 1})`);
    await page.evaluate(() => window.nativeActionGeometry.visible(document.activeElement, true));
    need(!seen.includes(id), 'focus'); seen.push(id);
  }
  need(JSON.stringify(seen) === '[0,1]', 'focus'); record.focus.push({ surface: 'confirmation', ids: seen });
  await capture(page, record, 'pending', confirmation);
  need(await page.$eval(confirmation, group => document.activeElement === group.querySelectorAll('button')[1]), 'focus');
  live(page); await page.keyboard.press('Enter'); // Real focused Cancel only; never confirm.
  await wait(page, () => !document.querySelector('.workspace-sync-card > [role="group"]') && !document.querySelector('.workspace-panel .field input').disabled);
  need(await page.evaluate(() => window.nativeActions.messagePreserved()), 'draft');
  const cancelled = await measurement(page, row, 'workspace'); sameGeometry(initial, cancelled);
  need(JSON.stringify(cancelled.buttons.map(b => b.disabled)) === '[false,true,false]', 'cancel');
  await settle(page);
  validateCounts(await page.evaluate(() => window.nativeActions.snapshot()), row, true);
}

async function runCase(browser, row, bundle, record) {
  let page, stage = 'setup', stalled = false, overflow = false;
  const pending = new Set();
  const counts = { page: 0, console: 0, resource: 0, dialog: 0 };
  const increment = key => { if (counts[key] >= 64) overflow = true; else counts[key]++; };
  const track = operation => {
    if (pending.size >= 16) { overflow = true; void operation.catch(() => {}); return; }
    pending.add(operation);
    void operation.catch(() => increment('resource')).finally(() => pending.delete(operation));
  };
  const pageError = () => increment('page');
  const consoleError = message => { if (['warn', 'error'].includes(message.type())) increment('console'); };
  const intercept = request => {
    if (request.url().startsWith('data:')) track(request.continue());
    else { increment('resource'); track(request.abort()); }
  };
  const dialog = event => { increment('dialog'); track(event.dismiss()); };
  const step = async action => {
    try { return await bounded(action); }
    catch (error) { if (fixed(error, '') === 'deadline') { stalled = true; if (page) retiredPages.add(page); } throw error; }
  };
  try {
    record.status = 'failed';
    page = await step(() => browser.newPage());
    page.setDefaultTimeout(caps.operationMs); page.setDefaultNavigationTimeout(caps.operationMs);
    page.on('pageerror', pageError); page.on('console', consoleError); page.on('dialog', dialog);
    await step(() => page.setRequestInterception(true)); page.on('request', intercept);
    await step(() => page.setUserAgent(ua[row.platform]));
    await step(() => page.setViewport({ width: row.width, height: row.height, deviceScaleFactor: 1, isMobile: row.platform !== 'desktop', hasTouch: row.platform !== 'desktop' }));
    await step(() => page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>'));
    await step(() => page.evaluate(config => { window.nativeActionConfig = config; }, { locale: row.locale, state: row.state }));
    await step(async () => { const handle = await page.addStyleTag({ content: bundle.css }); await handle.dispose(); });
    await step(async () => { const handle = await page.addScriptTag({ content: bundle.js }); await handle.dispose(); });
    stage = 'ready'; await step(() => settle(page));
    need(await step(() => page.evaluate((platform, width, height) => {
      const root = document.documentElement;
      return innerWidth === width && innerHeight === height && visualViewport.scale === 1 && (platform === 'desktop' ? !root.hasAttribute('data-native-mobile') : root.dataset.nativeMobile === 'true' && root.dataset.nativePlatform === platform) && parseFloat(root.style.getPropertyValue('--studio-visible-width')) === visualViewport.width;
    }, row.platform, row.width, row.height)), 'fixture');
    if (row.state === 'review') {
      await step(() => wait(page, () => !!document.querySelector('.workspace-sync-actions')));
      stage = 'pending'; await reviewCase(page, row, record);
    } else {
      await step(() => wait(page, () => !!document.querySelector('.account-login-buttons')));
      stage = 'geometry'; const login = await step(() => measurement(page, row, 'login')); record.measurements.push(login);
      if (row.state === 'disabled') {
        await step(() => page.evaluate(() => window.nativeActions.disable(true)));
        const disabled = await step(() => measurement(page, row, 'login')); sameGeometry(login, disabled); need(disabled.buttons.every(b => b.disabled), 'busy');
        await step(() => pointer(page, '[data-edge="before"]'));
        await page.keyboard.press('Tab'); await step(() => settle(page));
        need(await page.evaluate(() => document.activeElement === document.querySelector('[data-edge="after"]')), 'focus');
        await step(() => page.evaluate(() => window.nativeActions.disable(false)));
        const restored = await step(() => measurement(page, row, 'login')); sameGeometry(login, restored); need(restored.buttons.every(b => !b.disabled), 'busy');
      } else {
        const keyboard = row.kind === 'layout' && row.locale === 'en' && [320, 1440].includes(row.width);
        if (keyboard) { stage = 'focus'; record.focus.push({ surface: 'login', ids: await step(() => tabGroup(page, 'login')) }); }
        stage = 'screenshot'; await step(() => capture(page, record, 'login', '.account-login-buttons'));
        if (row.kind === 'layout') {
          await step(() => page.evaluate(() => window.nativeActions.show('workspace')));
          await step(() => wait(page, () => !!document.querySelector('.workspace-sync-actions'))); await step(() => settle(page));
          stage = 'geometry'; const workspace = await step(() => measurement(page, row, 'workspace')); record.measurements.push(workspace);
          need(JSON.stringify(workspace.buttons.map(b => b.disabled)) === '[false,true,false]', 'busy');
          if (keyboard) { stage = 'focus'; record.focus.push({ surface: 'workspace', ids: await step(() => tabGroup(page, 'workspace')) }); }
          stage = 'screenshot'; await step(() => capture(page, record, 'workspace', '.workspace-sync-actions'));
        }
      }
    }
    stage = 'transport'; validateCounts(await step(() => page.evaluate(() => window.nativeActions.snapshot())), row, true);
    need(record.pngCount === row.pngs, 'screenshot');
    record.status = 'passed';
  } catch (error) {
    // Browser RPC errors are never persisted verbatim. Only exact allowlisted
    // assertion suffixes may supply a more specific fixed failure enum.
    const suffix = typeof error?.message === 'string' ? error.message.match(/(?:^|Error:\s*)([a-z-]+)\s*$/)?.[1] : null;
    record.primary = codes.has(suffix) ? suffix : fixed(error, stage);
    if (record.primary === 'deadline' || error?.name === 'TimeoutError') stalled = true;
  }
  finally {
    if (page) retiredPages.add(page);
    // A deadline stops waiting, NOT the underlying operation. Never continue the
    // matrix after uncertainty; cleanup and parent group termination stay required.
    if (page && !page.isClosed()) {
      try {
        await bounded(() => page.evaluate(async () => { await window.nativeActions?.drain(); }), 1500);
        const state = await bounded(() => page.evaluate(() => window.nativeActions?.snapshot()), 1000);
        need(state && !state.held && state.active === 0 && state.mutations === 0 && state.started === state.done && state.completion?.drained && state.completion.active === 0 && ['api', 'request', 'effect', 'review', 'action'].every(kind => state.completion[kind + 'Started'] === state.completion[kind + 'Done']) && state.completion.actionStarted === 0, 'drain');
        record.counts = state; record.drained = true;
        try { validateCounts(state, row, true); } catch { fault(record.secondary, 'transport'); }
      } catch { fault(record.secondary, 'drain'); stalled = true; }
      // A failed drain goes directly to page/process teardown, never reset or
      // unmount based on a late completion of the timed-out drain RPC.
      if (record.drained) {
        try {
          await bounded(() => page.evaluate(() => window.nativeActions?.dispose()), 1000);
          const state = await bounded(() => page.evaluate(() => window.nativeActions?.snapshot()), 1000);
          need(state?.disposed && !state.saturated && !state.faults.length, 'cleanup');
          record.counts = state;
        } catch { fault(record.secondary, 'cleanup'); stalled = true; }
      }
      try { await bounded(() => page.close(), 1500); } catch { fault(record.secondary, 'cleanup'); stalled = true; }
    } else { fault(record.secondary, 'cleanup'); stalled = true; }
    try { await bounded(() => Promise.allSettled([...pending]), 1000); } catch { fault(record.secondary, 'cleanup'); stalled = true; }
    if (page) { page.off('request', intercept); page.off('pageerror', pageError); page.off('console', consoleError); page.off('dialog', dialog); }
    for (const key of ['page', 'console', 'resource']) if (counts[key]) fault(record.secondary, key);
    if (counts.dialog) fault(record.secondary, 'input');
    if (overflow) fault(record.secondary, 'counter');
    record.events = counts;
    if (record.secondary.length || record.primary !== null) record.status = 'failed';
  }
  return !stalled;
}

async function worker(base) {
  const report = { schema: 1, synthetic: true, status: 'failed', primary: null, secondary: [], bundles: 0, browsers: 0, records: inventory(), wrapEvidence: [] };
  let chrome, settled, browser, stage = 'setup';
  try {
    stage = 'bundle';
    const { bundleNativeActions } = await import(fixtureModule);
    const bundles = await bundleNativeActions(); report.bundles = bundles.size;
    const executable = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
    need(!!executable, 'browser');
    const profile = join(base, 'browser'); await mkdir(profile);
    stage = 'browser';
    // Explicit child ownership survives partial puppeteer connection/startup.
    chrome = spawn(executable, puppeteer.defaultArgs({ headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] }), { stdio: 'ignore' });
    settled = observe(chrome); report.browsers++;
    let stopped = false; void settled.then(() => { stopped = true; });
    const deadline = Date.now() + 10000; let port;
    while (!port) {
      need(!stopped && Date.now() < deadline, 'browser');
      try { const first = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; if (/^\d{1,5}$/.test(first)) port = Number(first); }
      catch { /* Bounded browser startup only, never a replayed input action. */ }
      if (!port) await delay(50);
    }
    browser = await bounded(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }));
    for (const row of designed) {
      stage = 'fixture';
      if (!await runCase(browser, row, bundles.get(row.providers), report.records[row.id])) break;
    }
    for (const surface of ['login', 'workspace']) {
      const candidates = report.records.filter(r => r.kind === 'layout' && r.locale === 'en' && r.status === 'passed');
      const narrow = candidates.find(r => r.measurements.find(m => m.surface === surface)?.rows.length > 1);
      const wide = candidates.find(r => r.measurements.find(m => m.surface === surface)?.rows.length === 1);
      need(narrow && wide, 'wrap'); report.wrapEvidence.push({ surface, before: narrow.id, after: wide.id });
    }
    need(report.bundles === 3 && report.browsers === 1 && report.records.every(r => r.status === 'passed') && report.records.reduce((n, r) => n + r.pngCount, 0) === caps.pngs, 'matrix');
    report.status = 'passed';
  } catch (error) { report.primary = fixed(error, stage); }
  finally {
    if (browser) {
      try { await bounded(() => browser.close(), 2000); } catch { fault(report.secondary, 'cleanup'); }
      finally { try { browser.disconnect(); } catch { fault(report.secondary, 'cleanup'); } }
    }
    try { await stopChrome(chrome, settled); } catch { fault(report.secondary, 'cleanup'); }
    if (report.secondary.length) report.status = 'failed';
    try { const text = JSON.stringify(report); need(Buffer.byteLength(text) <= caps.bytes, 'report'); await writeFile(join(output, 'report.json'), text + '\n'); }
    catch { fault(report.secondary, 'report'); report.status = 'failed'; }
  }
  return report.status === 'passed';
}

// Small killable IO helper, matching the collection-edge ownership pattern. No
// parent FS promise can outlive a timeout. Stdout carries only a capped report.
const ioSource = `
import { mkdir, rm, open, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
const [op, output, base, capText] = process.argv.slice(1), cap = Number(capText);
try {
  if (cap !== 196608) throw 0;
  if (op === 'create' || op === 'remove') {
    if (dirname(base) !== tmpdir() || !/^studio-native-actions-[a-f0-9]{32}$/.test(basename(base))) throw 0;
    if (op === 'create') await mkdir(base); else await rm(base, { recursive: true, force: true });
  } else if (op === 'init') {
    await mkdir(output, { recursive: true });
    for (const file of ['report.json', 'summary.json']) await rm(join(output, file), { force: true });
    for (let id = 0; id < 20; id++) for (const slot of ['login', 'workspace', 'busy', 'pending']) await rm(join(output, 'case-' + id + '-' + slot + '.png'), { force: true });
  } else if (op === 'read') {
    const handle = await open(join(output, 'report.json'), 'r'); let bytes;
    try {
      if ((await handle.stat()).size > cap) throw 0;
      const buffer = Buffer.alloc(cap + 1); let length = 0;
      while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > cap) throw 0; bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    await new Promise((yes, no) => process.stdout.write(bytes, error => error ? no(error) : yes()));
  } else if (op === 'summary') {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > cap) throw 0; chunks.push(chunk); }
    await writeFile(join(output, 'summary.json'), Buffer.concat(chunks));
  } else throw 0;
} catch { process.exitCode = 1; }
`;
async function parentIO(operation, base = '', input = '') {
  need(['init', 'create', 'remove', 'read', 'summary'].includes(operation) && Buffer.byteLength(input) <= caps.bytes, 'setup');
  let child, settled, failure, length = 0, overflow = false;
  const chunks = [];
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', ioSource, operation, output, base, String(caps.bytes)], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    settled = observe(child);
    child.stdin.on('error', () => {}); child.stdout.on('error', () => { overflow = true; });
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > (operation === 'read' ? caps.bytes : 0)) { overflow = true; try { signalGroup(child, 'SIGKILL'); } catch {} }
      else chunks.push(chunk);
    });
    const closed = new Promise(done => child.once('close', done)); child.stdin.end(input);
    const result = await bounded(async () => { const result = await settled; await closed; return result; }, 4000);
    need(!result.failed && !overflow, 'report');
  } catch (error) { failure = new Error(fixed(error, 'report')); }
  finally { try { await stopGroup(child, settled); } catch { if (!failure) failure = new Error('cleanup'); failure.cleanupFailed = true; } }
  if (failure) throw failure;
  return Buffer.concat(chunks);
}

function projectReport(report) {
  need(report.schema === 1 && report.synthetic === true && report.records?.length === 20 && Array.isArray(report.secondary) && report.secondary.length <= caps.faults && report.secondary.every(code => codes.has(code)) && (report.primary === null || codes.has(report.primary)), 'report');
  const finite = n => Number.isFinite(n) && Math.abs(n) < 100000;
  const integer = n => Number.isInteger(n) && n >= 0 && n <= 64;
  const only = (object, keys) => need(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(object, key)), 'report');
  only(report, ['schema', 'synthetic', 'status', 'primary', 'secondary', 'bundles', 'browsers', 'records', 'wrapEvidence']);
  need(integer(report.bundles) && integer(report.browsers) && ['passed', 'failed'].includes(report.status), 'report');
  const records = report.records.map((row, i) => {
    const design = designed[i];
    only(row, [...Object.keys(design), 'status', 'primary', 'secondary', 'measurements', 'focus', 'counts', 'pngCount', 'drained', ...(row.status === 'not-run' ? [] : ['events'])]);
    for (const [key, value] of Object.entries(design)) need(row[key] === value, 'report');
    need(['not-run', 'passed', 'failed'].includes(row.status) && (row.primary === null || codes.has(row.primary)) && Array.isArray(row.secondary) && row.secondary.length <= caps.faults && row.secondary.every(code => codes.has(code)) && typeof row.drained === 'boolean' && integer(row.pngCount) && row.pngCount <= design.pngs, 'report');
    need(Array.isArray(row.measurements) && row.measurements.length <= 2 && Array.isArray(row.focus) && row.focus.length <= 2, 'report');
    const measurements = row.measurements.map(m => {
      only(m, ['surface', 'capacity', 'rows', 'buttons']);
      need(['login', 'workspace'].includes(m.surface) && finite(m.capacity) && m.capacity > 0 && Array.isArray(m.buttons) && m.buttons.length >= 1 && m.buttons.length <= 3 && Array.isArray(m.rows) && m.rows.length <= 3, 'report');
      const buttons = m.buttons.map((b, id) => {
        only(b, ['id', 'box', 'natural', 'textLines', 'disabled']);
        need(b.id === id && Array.isArray(b.box) && b.box.length === 4 && b.box.every(finite) && finite(b.natural) && b.natural > 0 && integer(b.textLines) && b.textLines > 0 && typeof b.disabled === 'boolean', 'report');
        return { id, box: b.box, natural: b.natural, textLines: b.textLines, disabled: b.disabled };
      });
      need(m.rows.flat().length === buttons.length && m.rows.flat().every((id, index) => id === index) && m.rows.every(r => Array.isArray(r) && r.length > 0), 'report');
      return { surface: m.surface, capacity: m.capacity, rows: m.rows.map(r => [...r]), buttons };
    });
    const focus = row.focus.map(f => { only(f, ['surface', 'ids']); need(['login', 'workspace', 'confirmation'].includes(f.surface) && Array.isArray(f.ids) && f.ids.length <= 3 && f.ids.every(integer), 'report'); return { surface: f.surface, ids: [...f.ids] }; });
    let counts = null;
    if (row.counts !== null) {
      only(row.counts, ['get', 'review', 'unexpected', 'started', 'done', 'oauth', 'unhandled', 'active', 'mutations', 'held', 'disposed', 'saturated', 'completion', 'faults']);
      need(row.counts && ['get', 'review', 'unexpected', 'started', 'done', 'oauth', 'unhandled', 'active', 'mutations'].every(key => integer(row.counts[key])) && ['held', 'disposed', 'saturated'].every(key => typeof row.counts[key] === 'boolean') && Array.isArray(row.counts.faults) && row.counts.faults.length <= caps.faults && row.counts.faults.every(code => codes.has(code)), 'report');
      const completionKeys = ['active', 'drained', ...['api', 'request', 'effect', 'review', 'action'].flatMap(kind => [kind + 'Started', kind + 'Done'])];
      only(row.counts.completion, completionKeys);
      need(typeof row.counts.completion.drained === 'boolean' && completionKeys.filter(key => key !== 'drained').every(key => integer(row.counts.completion[key])), 'report');
      counts = Object.fromEntries(['get', 'review', 'unexpected', 'started', 'done', 'oauth', 'unhandled', 'active', 'mutations', 'held', 'disposed', 'saturated', 'faults'].map(key => [key, row.counts[key]]));
      counts.completion = Object.fromEntries(completionKeys.map(key => [key, row.counts.completion[key]]));
    }
    let events = null;
    if (row.events) { only(row.events, ['page', 'console', 'resource', 'dialog']); need(['page', 'console', 'resource', 'dialog'].every(key => integer(row.events[key])), 'report'); events = Object.fromEntries(['page', 'console', 'resource', 'dialog'].map(key => [key, row.events[key]])); }
    if (row.status === 'passed') {
      need(row.primary === null && row.secondary.length === 0 && row.drained && row.pngCount === design.pngs && counts && events && Object.values(events).every(n => n === 0), 'matrix');
      validateCounts(counts, design, true);
      validateCompletion(counts.completion, design, true);
      need(counts.disposed && counts.started === design.get + design.review && measurements.length === (design.kind === 'layout' ? 2 : 1), 'matrix');
      if (design.kind === 'layout' && design.locale === 'en' && [320, 1440].includes(design.width)) need(focus.length === 2 && focus.some(f => f.surface === 'login' && f.ids.length === 2) && focus.some(f => f.surface === 'workspace' && f.ids.length === 2), 'matrix');
      if (design.state === 'review') need(focus.length === 1 && focus[0].surface === 'confirmation' && JSON.stringify(focus[0].ids) === '[0,1]', 'matrix');
    }
    return { ...design, status: row.status, primary: row.primary, secondary: [...row.secondary], drained: row.drained, pngCount: row.pngCount, counts, events, measurements, focus };
  });
  need(Array.isArray(report.wrapEvidence) && report.wrapEvidence.length <= 2, 'report');
  const wrapEvidence = report.wrapEvidence.map(w => {
    only(w, ['surface', 'before', 'after']);
    need(['login', 'workspace'].includes(w.surface) && integer(w.before) && integer(w.after) && w.before < 16 && w.after < 16, 'report');
    const before = records[w.before], after = records[w.after];
    need(before.locale === 'en' && after.locale === 'en' && before.status === 'passed' && after.status === 'passed' && before.measurements.find(m => m.surface === w.surface)?.rows.length > 1 && after.measurements.find(m => m.surface === w.surface)?.rows.length === 1, 'report');
    return { surface: w.surface, before: w.before, after: w.after };
  });
  if (report.status === 'passed') need(new Set(wrapEvidence.map(w => w.surface)).size === 2, 'matrix');
  return { schema: 1, synthetic: true, status: report.status, primary: report.primary, secondary: [...report.secondary], bundles: report.bundles, browsers: report.browsers, records, wrapEvidence };
}
export async function mainRunner() {
  let child, settled, certain = true, owned = false, report = null, primary = null;
  const secondary = [];
  // Sticky across every parent IO catch, even when another primary already
  // exists. A later successful worker stop cannot clear an uncertain IO group.
  const observeUncertainty = error => {
    if (error?.cleanupFailed) { certain = false; if (!secondary.includes('cleanup')) fault(secondary, 'cleanup'); }
  };
  const base = join(tmpdir(), `studio-native-actions-${randomBytes(16).toString('hex')}`);
  try {
    need(process.platform === 'linux', 'setup');
    await parentIO('init'); owned = true; await parentIO('create', base);
    child = spawn(process.execPath, [self, '--native-actions-worker', base], { cwd: studio, detached: true, stdio: 'ignore' }); settled = observe(child);
    let result;
    try { result = await bounded(() => settled, caps.workerMs); }
    catch (error) { primary = fixed(error, 'worker'); }
    // Stop/confirm the writer group before reading partial evidence. A watchdog
    // failure remains primary even when a pre-deadline report can be recovered.
    let canRead = true;
    try { await stopGroup(child, settled); }
    catch { certain = false; canRead = false; if (primary) fault(secondary, 'cleanup'); else primary = 'cleanup'; }
    if (canRead) {
      try { report = projectReport(JSON.parse((await parentIO('read')).toString('utf8'))); }
      catch (error) {
        observeUncertainty(error);
        if (primary) fault(secondary, fixed(error, 'report')); else throw error;
      }
    }
    if (primary) throw new Error(primary);
    need(!result.failed && report.status === 'passed' && report.primary === null && report.secondary.length === 0 && report.bundles === 3 && report.browsers === 1 && report.records.every(row => row.status === 'passed') && report.wrapEvidence.length === 2, report.primary || 'matrix');
  } catch (error) {
    // Includes init/create/read failures before a worker or fixture fully exists.
    observeUncertainty(error);
    if (primary) { const code = fixed(error, 'worker'); if (code !== primary) fault(secondary, code); }
    else primary = fixed(error, 'worker');
  }
  finally {
    try { await stopGroup(child, settled); } catch { certain = false; fault(secondary, 'cleanup'); }
    // Publish while the fixture still exists. If summary IO has uncertain exit,
    // retain it; never delete first and only then discover an unknown IO group.
    const summary = { schema: 1, synthetic: true, status: primary || secondary.length ? 'failed' : 'passed', primary, secondary: [...secondary], workerPrimary: report?.primary ?? null, workerSecondary: report?.secondary || [], publication: 'pre-cleanup-snapshot', groupGone: 'unconfirmed', groupsGoneBeforePublication: certain, fixtureRetainedAtPublication: owned || !certain,
      plannedCases: 20, plannedGet: 17, plannedReview: 1, plannedPng: caps.pngs, actualZoom: 'not-run', osTextSize: 'not-run', pinch: 'not-run', records: report?.records || inventory(), wrapEvidence: report?.wrapEvidence || [] };
    try { await parentIO('summary', '', JSON.stringify(summary) + '\n'); }
    catch (error) { observeUncertainty(error); fault(secondary, 'report'); }
    // No later FS publication: it would introduce another helper whose exit the
    // report itself could not confirm. This removal starts only after ALL earlier
    // groups (including summary IO) have confirmed exit. Never retry removal.
    if (owned && certain) {
      try { await parentIO('remove', base); owned = false; }
      catch (error) { observeUncertainty(error); fault(secondary, 'cleanup'); }
    }
  }
  // The file is explicitly a pre-publication snapshot, not a final cleanup
  // receipt. Emit final bounded evidence only after the last IO helper settles.
  const receipt = { schema: 1, status: primary || secondary.length ? 'failed' : 'passed', primary, secondary: [...secondary], groupGone: certain,
    fixtureRetention: !certain ? 'unconfirmed' : owned ? 'retained' : 'removed-or-not-created' };
  if (primary || secondary.length) console.error(JSON.stringify(receipt));
  else console.log(JSON.stringify(receipt));
  if (primary || secondary.length) throw new AggregateError([...(primary ? [new Error(primary)] : []), ...secondary.map(code => new Error(code))], 'matrix');
  console.log('PASS: native action layout=16 state=4 bundles=3 browser=1 syntheticGET=17 reviewPOST=1 commitSyncPOST=0 PNG=36; synthetic Chromium only.');
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    if (process.argv[2] === '--native-actions-worker') {
      const base = process.argv[3]; need(base && dirname(base) === tmpdir() && /^studio-native-actions-[a-f0-9]{32}$/.test(basename(base)), 'setup');
      process.exit(await worker(base) ? 0 : 1);
    } else await mainRunner();
  } catch (error) { console.error(`Native actions failed: ${fixed(error, 'worker')}`); process.exitCode = 1; }
}
