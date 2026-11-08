import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from '../../server/password.ts';

// Remote-only: uses the built service. Never imports another executable runner.
export const COLLECTION_EDGE_SIZES = Object.freeze([[320, 568], [844, 390]].map(Object.freeze));
const studio = fileURLToPath(new URL('../../', import.meta.url));
const workerPath = fileURLToPath(import.meta.url);
const output = join(studio, 'test-results/collection-modal-edges');
const surface = 'create-collection-collection';
const creation = 'dialog.creation-modal[open]';
const caps = Object.freeze({ wheels: 8, tabs: 32, frames: 90, samples: 192, bytes: 393216, workerMs: 65000 });
const codes = new Set(['setup', 'fixture', 'server', 'browser', 'auth', 'open', 'probe', 'initial', 'wheel-down', 'tail', 'wheel-up', 'top', 'keyboard-forward', 'keyboard-reverse', 'screenshot', 'sentinel', 'cleanup', 'report', 'deadline', 'worker', 'matrix']);

function requireThat(condition, code) {
  if (!condition) throw new Error(code);
}
function fixedCode(error, fallback) {
  return codes.has(error?.message) ? error.message : fallback;
}
function observe(child) {
  return new Promise(resolveExit => {
    // Retain a bounded-lifetime error sink even after a timeout/unref: a late
    // ChildProcess error must not become an uncaught exception.
    child.on('error', () => resolveExit({ failed: true }));
    child.once('exit', (code, signal) => resolveExit({ failed: code !== 0 || signal !== null }));
  });
}
async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
function releaseChildReferences(child) {
  if (!child) return;
  // This releases parent keepalive only, NEVER proves process/group exit. Keep
  // error sinks installed for late events; pending promises alone hold no loop
  // handle. Used for IO helpers (including remover), worker, Chrome and server.
  for (const stream of child.stdio || []) {
    if (!stream) continue;
    stream.on('error', () => {});
    stream.removeAllListeners('data');
    stream.destroy();
    stream.unref?.();
  }
  child.unref();
}
async function stopProcess(child, settled) {
  try {
    if (!child?.pid) return;
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      try { await bounded(() => settled, 1000); }
      catch {
        child.kill('SIGKILL');
        await bounded(() => settled, 1000);
      }
    }
    await bounded(() => settled, 1000);
  } finally { releaseChildReferences(child); }
}
async function reservePort() {
  const reserve = createServer();
  try {
    await new Promise((yes, no) => {
      reserve.once('error', no);
      reserve.listen(0, '127.0.0.1', yes);
    });
    return reserve.address().port;
  } finally {
    if (reserve.listening) await new Promise((yes, no) => reserve.close(error => error ? no(error) : yes()));
  }
}
async function fixtureSite(site) {
  // Only fictitious content, created before service startup. Two languages and
  // three parent choices retain ordinary creation-form wrapping without a copy
  // of a user's site or the large demo fixture / image encoder dependency.
  await mkdir(join(site, 'content/articles/example'), { recursive: true });
  await writeFile(join(site, 'config.toml'), 'title="Collection edge fixture"\nbase_url="https://example.com"\ndefault_language="en"\n[languages.zh-CN]\ntitle="Collection edge fixture"\n');
  await writeFile(join(site, 'data.toml'), '[post]\ntags=[]\ncategories=[]\n');
  await writeFile(join(site, 'content/articles/example/index.md'), '+++\ntitle="Example"\ndraft=true\n+++\nFictitious content.\n');
  for (const [folder, title, layout] of [
    ['field-notes', 'Field notes', 'collection-detail'],
    ['docs', 'Guide', 'collection-category'],
    ['docs/user', 'Guide', 'collection-detail'],
  ]) {
    const directory = join(site, 'content/collections', folder);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '_index.md'), `+++\ntitle="${title}"\nlayout="${layout}"\n+++\nFictitious content.\n`);
  }
}
async function clickText(page, selector, text) {
  await page.waitForFunction((selector, text) => [...document.querySelectorAll(selector)].some(node => node.textContent.trim() === text && !node.disabled), {}, selector, text);
  const handles = await page.$$(selector);
  try {
    for (const handle of handles) {
      if (await handle.evaluate((node, text) => node.textContent.trim() === text, text)) {
        await handle.click(); // One physical setup input, never retried.
        return;
      }
    }
    throw new Error('open');
  } finally { await Promise.all(handles.map(handle => handle.dispose())); }
}

async function installProbe(page) {
  // Observational only: no DOM/style/input/focus/scroll writes. Node identities
  // stay inside the page; only bounded local integers and fixed fields leave it.
  await page.evaluate(() => {
    const dialog = document.querySelector('dialog.creation-modal[open]');
    const footer = dialog?.querySelector('form.modal > button.primary.wide');
    if (!dialog || !footer) throw new Error('probe');
    const ids = new WeakMap();
    let nextId = 0, backgroundFaults = 0, submit = 0, wheel = 0, tab = 0, scroll = 0;
    let saturated = false;
    const id = node => {
      if (!node) return 0;
      if (!ids.has(node)) ids.set(node, ++nextId);
      if (nextId > 4096) saturated = true;
      return ids.get(node);
    };
    const baseline = new Map();
    const windowStart = [scrollX, scrollY];
    const footerDisabled = footer.disabled;
    const outside = node => !dialog.contains(node);
    const scanBackground = () => {
      const nodes = [...document.querySelectorAll('*')];
      if (nodes.length > 2048) saturated = true;
      return nodes.slice(0, 2048).filter(node => outside(node) &&
        (node === document.scrollingElement || node === document.body || node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth));
    };
    for (const node of scanBackground()) baseline.set(node, [node.scrollLeft, node.scrollTop]);
    const background = () => {
      let delta = Math.max(Math.abs(scrollX - windowStart[0]), Math.abs(scrollY - windowStart[1]));
      const nodes = new Set([...baseline.keys(), ...scanBackground()]);
      if (nodes.size > 64) saturated = true;
      for (const node of nodes) {
        const start = baseline.get(node) || [0, 0];
        delta = Math.max(delta, Math.abs(node.scrollLeft - start[0]), Math.abs(node.scrollTop - start[1]));
      }
      if (delta !== 0) backgroundFaults = Math.min(1000, backgroundFaults + 1);
      return { delta, count: nodes.size, faults: backgroundFaults };
    };
    function stops() {
      const all = [...dialog.querySelectorAll('a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable="true"]')];
      if (all.length > 128) saturated = true;
      const candidates = all.slice(0, 128).filter(node => {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (!parent.matches('details:not([open])')) continue;
          const summary = [...parent.children].find(child => child.tagName === 'SUMMARY');
          if (!summary?.contains(node)) return false;
        }
        const style = getComputedStyle(node);
        return node.tabIndex >= 0 && !node.matches(':disabled, input[type="hidden"]') && !node.closest('[inert], [hidden]') &&
          node.getClientRects().length > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse';
      });
      // Match production modal-layer.ts, including native radio sequential stops.
      return candidates.filter(node => {
        if (!(node instanceof HTMLInputElement) || node.type !== 'radio' || !node.name) return true;
        const group = candidates.filter(other => other instanceof HTMLInputElement && other.type === 'radio' && other.name === node.name && other.form === node.form);
        return node === (group.find(radio => radio.checked) || group[0]);
      }).sort((a, b) => (a.tabIndex || Number.MAX_SAFE_INTEGER) - (b.tabIndex || Number.MAX_SAFE_INTEGER));
    }
    const initialStops = stops();
    const finite = value => {
      if (!Number.isFinite(value) || Math.abs(value) > 1000000) { saturated = true; return -1; }
      return value;
    };
    const box = rect => [rect.left, rect.top, rect.right, rect.bottom].map(finite);
    function geometry(node) {
      if (!node) return { box: [0, 0, 0, 0], full: false, hit: false };
      const rect = node.getBoundingClientRect();
      const view = visualViewport;
      let left = Math.max(0, view?.offsetLeft ?? 0), top = Math.max(0, view?.offsetTop ?? 0);
      let right = Math.min(innerWidth, left + (view?.width ?? innerWidth));
      let bottom = Math.min(innerHeight, top + (view?.height ?? innerHeight));
      let visible = node.getClientRects().length > 0;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), r = parent.getBoundingClientRect();
        visible &&= style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && Number(style.opacity) !== 0;
        if (parent === node) continue;
        if (/(auto|scroll|hidden|clip|overlay)/.test(style.overflowX)) {
          left = Math.max(left, r.left + parent.clientLeft);
          right = Math.min(right, r.left + parent.clientLeft + parent.clientWidth);
        }
        if (/(auto|scroll|hidden|clip|overlay)/.test(style.overflowY)) {
          top = Math.max(top, r.top + parent.clientTop);
          bottom = Math.min(bottom, r.top + parent.clientTop + parent.clientHeight);
        }
      }
      // No partial-visibility exemption. The 1px tolerance is geometric rounding,
      // not an allowance for untraversed content or skipped hit-test samples.
      const full = visible && rect.width > 0 && rect.height > 0 && rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1;
      const hit = full && [[.5, .5], [.05, .05], [.95, .05], [.05, .95], [.95, .95]].every(([x, y]) => {
        const target = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
        return target === node || node.contains(target);
      });
      return { box: box(rect), full, hit };
    }
    const snapshot = () => {
      const currentStops = stops(), active = document.activeElement;
      const focusTarget = active?.matches('input[type=radio],input[type=checkbox]') ? active.labels?.[0] || active : active;
      let painted = false;
      for (let node = active; node && node !== dialog; node = node.parentElement) {
        const style = getComputedStyle(node);
        if ((node === active || node.matches('label')) && ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)') || style.boxShadow !== 'none')) painted = true;
      }
      const rect = dialog.getBoundingClientRect();
      const contentType = dialog.querySelector('input[name="content-type"][value="collection"]');
      const allDialogs = [...document.querySelectorAll('dialog[open]')];
      const point = [[.5, .55], [.8, .55], [.5, .8]].map(([x, y]) => ({ x: rect.left + dialog.clientLeft + dialog.clientWidth * x, y: rect.top + dialog.clientTop + dialog.clientHeight * y })).find(({ x, y }) => {
        if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return false;
        for (let node = document.elementFromPoint(x, y); node; node = node.parentElement) {
          if (node === dialog) return true;
          if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return false;
        }
        return false;
      });
      const bg = background();
      return {
        width: innerWidth, height: innerHeight, scale: finite(visualViewport?.scale ?? 1),
        touchPoints: navigator.maxTouchPoints, coarse: matchMedia('(any-pointer: coarse)').matches,
        dialog: id(dialog), connected: dialog.isConnected, modal: dialog.matches(':modal'), sole: allDialogs.length === 1 && allDialogs[0] === dialog,
        subtype: !!contentType?.checked, footerDisabled: footer.disabled, disabledUnchanged: footer.disabled === footerDisabled,
        unselectedParent: !dialog.querySelector('[data-field="collection-parent"] input:checked'),
        top: finite(dialog.scrollTop), max: finite(dialog.scrollHeight - dialog.clientHeight), left: finite(dialog.scrollLeft),
        scrollable: /^(auto|scroll)$/.test(getComputedStyle(dialog).overflowY),
        point: point ? [point.x, point.y].map(finite) : [], footer: geometry(footer),
        background: bg, submit, wheel, tab, scroll,
        stops: currentStops.map(id), stopsUnchanged: currentStops.length === initialStops.length && currentStops.every((node, i) => node === initialStops[i]),
        firstIsCancel: currentStops[0] === dialog.querySelector('.card-heading button'), footerIsStop: currentStops.includes(footer),
        active: id(active), contained: active !== dialog && dialog.contains(active), documentFocused: document.hasFocus(),
        focusVisible: !!active?.matches(':focus-visible'), painted, focus: geometry(focusTarget), saturated,
      };
    };
    const onScroll = () => { scroll = Math.min(1000, scroll + 1); background(); };
    const onSubmit = () => { submit = Math.min(1000, submit + 1); };
    const onWheel = event => { if (event.isTrusted) wheel = Math.min(1000, wheel + 1); };
    const onKey = event => { if (event.isTrusted && event.key === 'Tab') tab = Math.min(1000, tab + 1); };
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('scroll', onScroll);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    document.addEventListener('keydown', onKey, true);
    window.collectionEdgeProbe = {
      snapshot,
      settle: () => new Promise(resolveFrames => {
        let last = '', stable = 0, frames = 0;
        const frame = () => {
          const bg = background();
          const next = [dialog.scrollTop, dialog.scrollLeft, bg.delta].join(',');
          stable = next === last ? stable + 1 : 0;
          last = next;
          if (++frames >= 8 && stable >= 5) resolveFrames(true);
          else if (frames >= 90) resolveFrames(false);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
      dispose() {
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('scroll', onScroll);
        document.removeEventListener('submit', onSubmit, true);
        document.removeEventListener('wheel', onWheel, true);
        document.removeEventListener('keydown', onKey, true);
        delete window.collectionEdgeProbe;
      },
    };
  });
}

async function runSize(index, base) {
  const [width, height] = COLLECTION_EDGE_SIZES[index];
  const directory = join(output, `size-${index}`);
  const report = { schema: 1, surface, index, width, height, synthetic: true, status: 'running', primary: null, secondary: [],
    phases: { initial: false, tail: false, top: false, forward: false, reverse: false },
    caps, samples: [], screenshots: [], pageErrors: 0, warnings: 0, mutations: 0, external: 0, dialogs: 0 };
  let stage = 'setup', server, serverSettled, chrome, chromeSettled, browser, page, client, intercept;
  const pending = new Set();
  const controller = new AbortController();
  const secondary = code => { if (!report.secondary.includes(code)) report.secondary.push(code); };
  const track = operation => {
    const task = operation.catch(() => { secondary('sentinel'); });
    if (pending.size >= 64) {
      secondary('sentinel'); // Fail closed; Chrome shutdown drains overflow work.
      return;
    }
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  let expectedDialog;
  const read = async (phase, ordinal = 0) => {
    const state = await page.evaluate(() => window.collectionEdgeProbe.snapshot());
    requireThat(report.samples.length < caps.samples, 'sentinel');
    report.samples.push({ phase, ordinal, ...state });
    requireThat(state.width === width && state.height === height && Math.abs(state.scale - 1) <= .001 && state.touchPoints === 5 && state.coarse, 'sentinel');
    requireThat(state.connected && state.modal && state.sole && state.subtype && state.disabledUnchanged && !state.saturated && state.stopsUnchanged, 'sentinel');
    requireThat(state.dialog === expectedDialog && state.left === 0 && state.background.delta === 0 && state.background.faults === 0 && state.submit === 0, 'sentinel');
    requireThat(state.firstIsCancel && state.footerIsStop === !state.footerDisabled && state.stops.length >= 3 && state.stops.length <= caps.tabs, 'sentinel');
    requireThat(report.pageErrors === 0 && report.warnings === 0 && report.mutations === 0 && report.external === 0 && report.dialogs === 0, 'sentinel');
    return state;
  };
  const settle = async () => requireThat(await page.evaluate(() => window.collectionEdgeProbe.settle()), 'sentinel');
  const screenshot = async phase => {
    const previousStage = stage;
    stage = 'screenshot';
    requireThat(report.screenshots.length < 6, 'screenshot');
    // PNGs are fictitious UI evidence, not a structured-data redaction guarantee.
    await page.screenshot({ path: join(directory, `${phase}.png`), fullPage: false });
    // Puppeteer screenshots can restore its desktop metrics. Reapply the same
    // emulation, never a scroll position, then assert it before more input.
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await settle();
    report.screenshots.push(phase);
    stage = previousStage;
    return read(phase);
  };
  try {
    await mkdir(directory, { recursive: true });
    stage = 'fixture';
    const site = join(base, 'site');
    await fixtureSite(site);
    const port = await reservePort(), origin = `http://localhost:${port}`;
    const password = randomBytes(24).toString('hex');
    stage = 'server';
    server = spawn(process.execPath, ['dist/server.mjs'], { cwd: studio, env: { ...process.env,
      STUDIO_ORIGIN: origin, STUDIO_HOST: '127.0.0.1', PORT: String(port), STUDIO_SITE_ROOT: site,
      STUDIO_STATE: 'file', STUDIO_STATE_DIR: join(base, 'state'), STUDIO_GIT_URL: '', STUDIO_GIT_WORKSPACE: '', STUDIO_OIDC_ISSUER: '',
      STUDIO_ADMIN_USER: 'owner', STUDIO_ADMIN_PASSWORD_HASH: await hashPassword(password), STUDIO_SESSION_SECRET: randomBytes(32).toString('hex'),
    }, stdio: 'ignore' });
    serverSettled = observe(server);
    let serverStopped = false;
    void serverSettled.then(() => { serverStopped = true; });
    const readyDeadline = Date.now() + 10000;
    while (true) {
      requireThat(!serverStopped && Date.now() < readyDeadline, 'server');
      try {
        const response = await fetch(origin + '/api/auth/config', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { /* Readiness only. No authentication or input retries. */ }
      await delay(100);
    }
    stage = 'browser';
    const executable = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
    requireThat(!!executable, 'browser');
    const profile = join(base, 'browser');
    await mkdir(profile, { recursive: true });
    chrome = spawn(executable, puppeteer.defaultArgs({ headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] }), { stdio: 'ignore' });
    chromeSettled = observe(chrome);
    let chromeStopped = false;
    void chromeSettled.then(() => { chromeStopped = true; });
    const chromeDeadline = Date.now() + 10000;
    let browserURL;
    while (!browserURL) {
      requireThat(!chromeStopped && Date.now() < chromeDeadline, 'browser');
      try {
        const [debugPort] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        if (/^\d+$/.test(debugPort)) browserURL = `http://127.0.0.1:${debugPort}`;
      } catch { /* Disposable Chrome endpoint readiness only. */ }
      if (!browserURL) await delay(100);
    }
    browser = await puppeteer.connect({ browserURL, protocolTimeout: 6000 });
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    page.on('pageerror', () => { report.pageErrors = Math.min(1000, report.pageErrors + 1); });
    page.on('console', message => { if (['error', 'warn'].includes(message.type())) report.warnings = Math.min(1000, report.warnings + 1); });
    page.on('dialog', dialog => { report.dialogs = Math.min(1000, report.dialogs + 1); track(dialog.dismiss()); });
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] }));
    stage = 'auth';
    // One real login per isolated service. No credential entry, session expiry,
    // production throttle change, automatic form submission or mutation fixture.
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }) });
    requireThat(login.status === 200, 'auth');
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    await login.body?.cancel();
    requireThat(!!cookie && cookie.includes('='), 'auth');
    const split = cookie.indexOf('=');
    await browser.setCookie({ name: cookie.slice(0, split), value: cookie.slice(split + 1), domain: 'localhost', path: '/', httpOnly: true });
    await page.setRequestInterception(true);
    intercept = request => {
      const url = new URL(request.url());
      let operation;
      if (url.protocol === 'data:' || url.protocol === 'blob:') operation = request.continue();
      else if (url.origin !== origin) { report.external = Math.min(1000, report.external + 1); operation = request.abort(); }
      else if (!['GET', 'HEAD'].includes(request.method())) { report.mutations = Math.min(1000, report.mutations + 1); operation = request.abort(); }
      else operation = request.continue();
      track(operation);
    };
    page.on('request', intercept);
    stage = 'open';
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.studio-shell');
    await page.select('.language-switcher select', 'zh-CN');
    await clickText(page, '.sidebar nav button', '合集管理');
    await page.waitForSelector('.content-library .content-row');
    await clickText(page, '.page-heading button', '新建内容');
    await page.waitForSelector(creation);
    await page.click(`${creation} input[name="content-type"][value="collection"]`);
    await page.waitForFunction(() => document.querySelector('dialog.creation-modal[open] input[name="content-type"][value="collection"]')?.checked && !document.querySelector('[aria-busy="true"]'));
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    client = await page.createCDPSession();
    // Match form-audit's mobile/touch CSS environment without changing
    // Puppeteer's isMobile flag (which would reload and lose this live dialog).
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
    stage = 'probe';
    await installProbe(page);
    expectedDialog = await page.evaluate(() => window.collectionEdgeProbe.snapshot().dialog);
    stage = 'initial';
    await settle();
    let state = await read('initial');
    requireThat(state.top <= 1 && state.max > 1 && state.scrollable && state.point.length === 2 && state.footerDisabled && state.unselectedParent, 'initial');
    await screenshot('initial');
    report.phases.initial = true;

    const wheelOnce = async (direction, phase, ordinal) => {
      const before = await read(phase, ordinal);
      requireThat(before.point.length === 2, 'sentinel');
      // No handles, locators, focus or scroll writes anywhere in wheel evidence.
      await page.mouse.move(...before.point);
      await page.mouse.wheel({ deltaY: direction * 160 });
      await settle();
      const after = await read(phase, ordinal);
      requireThat(after.wheel === before.wheel + 1 && after.tab === before.tab && Math.abs(after.max - before.max) <= 1, 'sentinel');
      return { before, after };
    };
    const traverse = async direction => {
      const phase = direction === 1 ? 'wheel-down' : 'wheel-up';
      stage = phase;
      let reached = false;
      for (let ordinal = 1; ordinal <= caps.wheels; ordinal++) {
        const { before, after } = await wheelOnce(direction, phase, ordinal);
        reached = direction === 1 ? after.max - after.top <= 1 : after.top <= 1;
        requireThat(direction * (after.top - before.top) > 1 || reached, phase);
        state = after;
        if (reached) break;
      }
      requireThat(reached, phase);
      const { before, after } = await wheelOnce(direction, phase, caps.wheels + 1);
      requireThat(Math.abs(after.top - before.top) <= 1 && (direction === 1 ? after.max - after.top <= 1 : after.top <= 1), phase);
      return after;
    };
    state = await traverse(1);
    stage = 'tail';
    requireThat(state.footer.full && state.footer.hit, 'tail');
    state = await screenshot('wheel-tail');
    requireThat(state.max - state.top <= 1 && state.footer.full && state.footer.hit, 'tail');
    report.phases.tail = true;
    state = await traverse(-1);
    stage = 'top';
    requireThat(state.top <= 1, 'top');
    state = await screenshot('wheel-return-top');
    requireThat(state.top <= 1, 'top');
    report.phases.top = true;

    const keyboard = async backwards => {
      stage = backwards ? 'keyboard-reverse' : 'keyboard-forward';
      const phase = stage;
      let wrapped = false, ordinary = false;
      // Walk a complete native cycle from the actual current focus; never seed
      // boundaries with .focus(). Disabled footer stays excluded by production.
      const length = state.stops.length;
      for (let ordinal = 1; ordinal <= length; ordinal++) {
        const before = await read(phase, ordinal), index = before.stops.indexOf(before.active);
        requireThat(index >= 0, phase);
        const nextIndex = (index + (backwards ? -1 : 1) + length) % length;
        if (backwards) await page.keyboard.down('Shift');
        try { await page.keyboard.press('Tab'); }
        finally { if (backwards) await page.keyboard.up('Shift'); }
        await settle();
        state = await read(phase, ordinal);
        requireThat(state.tab === before.tab + 1 && state.wheel === before.wheel && state.active === before.stops[nextIndex], phase);
        requireThat(state.contained && state.documentFocused && state.focusVisible && state.painted && state.focus.full && state.focus.hit, phase);
        const boundary = backwards ? index === 0 : index === length - 1;
        if (boundary) {
          requireThat(!wrapped, phase);
          wrapped = true;
          await screenshot(backwards ? 'keyboard-reverse-wrap' : 'keyboard-forward-wrap');
        } else ordinary = true;
      }
      requireThat(wrapped && ordinary, phase);
    };
    await keyboard(false);
    report.phases.forward = true;
    await keyboard(true);
    report.phases.reverse = true;
    stage = 'sentinel';
    await read('final');
    await bounded(() => Promise.all([...pending]), 1000);
    requireThat(report.secondary.length === 0 && Object.values(report.phases).every(Boolean), 'sentinel');
    report.status = 'passed';
  } catch (error) {
    report.primary = fixedCode(error, stage);
    report.status = 'failed';
  } finally {
    controller.abort();
    // Stop page observers only after final evidence. Cleanup cannot replace the
    // primary exception; parent kills this entire owned group on any deadline.
    if (page && !page.isClosed()) {
      try { await bounded(() => page.evaluate(() => window.collectionEdgeProbe?.dispose()), 1000); }
      catch { secondary('cleanup'); }
    }
    if (browser) {
      try { await bounded(() => browser.close(), 1500); }
      catch { secondary('cleanup'); }
      finally { browser.disconnect(); }
    }
    const drained = await Promise.allSettled([stopProcess(chrome, chromeSettled), stopProcess(server, serverSettled)]);
    if (drained.some(result => result.status === 'rejected')) secondary('cleanup');
    // Chrome exit drains page/CDP work; only then are handlers detached and all
    // tracked request/dialog operations drained. No unhandled late rejection.
    if (page && intercept) page.off('request', intercept);
    try { await bounded(() => Promise.all([...pending]), 1000); }
    catch { secondary('cleanup'); }
    if (report.pageErrors || report.warnings || report.mutations || report.external || report.dialogs) secondary('sentinel');
    if (report.secondary.length) report.status = 'failed';
    try {
      const text = JSON.stringify(report, null, 2) + '\n';
      requireThat(Buffer.byteLength(text) <= caps.bytes, 'report');
      await writeFile(join(directory, 'report.json'), text);
    } catch { secondary('report'); report.status = 'failed'; }
  }
  return report.status === 'passed' && report.secondary.length === 0;
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw new Error('cleanup'); }
}
function groupExists(child) {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) {
    // EPERM and all unexpected results are uncertainty, never proof of exit.
    if (error.code === 'ESRCH') return false;
    throw new Error('cleanup');
  }
}
async function waitGroupGone(child, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (groupExists(child)) {
    if (Date.now() >= deadline) return false;
    await delay(25); // Process-liveness cleanup only; never replay browser input.
  }
  return true;
}
async function stopGroup(child, settled) {
  try {
    if (!child?.pid) { if (settled) await bounded(() => settled, 1000); return; }
    signalGroup(child, 'SIGTERM');
    if (!await waitGroupGone(child, 1000)) {
      signalGroup(child, 'SIGKILL');
      requireThat(await waitGroupGone(child, 2000), 'cleanup');
    }
    await bounded(() => settled, 1000);
    requireThat(!groupExists(child), 'cleanup');
  } finally {
    // Even a still-live / unconfirmable PG must not permanently hold the parent
    // open. The exception still propagates: caller records cleanup failure and
    // retains the fixture; unref is not converted into groupGone evidence.
    releaseChildReferences(child);
  }
}

// All parent-owned filesystem work runs in a separately killable process group.
// Paths are selected here, not accepted from stdout. Only a capped report is
// returned; stderr/raw errors and temporary paths never enter evidence/logs.
const ioProgram = `
import { mkdir, rm, open, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const [operation, output, base, indexText, capText] = process.argv.slice(1);
const cap = Number(capText), index = Number(indexText);
const files = ['report.json', 'initial.png', 'wheel-tail.png', 'wheel-return-top.png', 'keyboard-forward-wrap.png', 'keyboard-reverse-wrap.png'];
try {
  if (!Number.isInteger(cap) || cap < 1 || cap > 393216) throw 0;
  if (operation === 'init') {
    await mkdir(output, { recursive: true });
    await rm(join(output, 'summary.json'), { force: true });
    for (let i = 0; i < 2; i++) for (const file of files) await rm(join(output, 'size-' + i, file), { force: true });
  } else if (operation === 'create' || operation === 'remove') {
    if (dirname(base) !== tmpdir() || !/^studio-collection-edges-[a-f0-9]{32}$/.test(base.slice(tmpdir().length + 1))) throw 0;
    if (operation === 'create') await mkdir(base);
    else await rm(base, { recursive: true, force: true });
  } else if (operation === 'read') {
    if (index !== 0 && index !== 1) throw 0;
    const handle = await open(join(output, 'size-' + index, 'report.json'), 'r');
    let buffer;
    try {
      if ((await handle.stat()).size > cap) throw 0;
      buffer = Buffer.alloc(cap + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > cap) throw 0;
      buffer = buffer.subarray(0, length);
    } finally { await handle.close(); }
    await new Promise((yes, no) => process.stdout.write(buffer, error => error ? no(error) : yes()));
  } else if (operation === 'summary') {
    const parts = []; let length = 0;
    for await (const part of process.stdin) {
      length += part.length;
      if (length > cap) throw 0;
      parts.push(part);
    }
    await writeFile(join(output, 'summary.json'), Buffer.concat(parts));
  } else throw 0;
  process.exitCode = 0;
} catch { process.exitCode = 1; }
`;
async function parentIO(operation, { base = '', index = 0, input = '' } = {}) {
  requireThat(['init', 'create', 'remove', 'read', 'summary'].includes(operation), 'setup');
  requireThat(Buffer.byteLength(input) <= caps.bytes, 'report');
  let child, settled, failure, length = 0, overflow = false;
  const chunks = [];
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', ioProgram, operation, output, base, String(index), String(caps.bytes)], {
      detached: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    settled = observe(child);
    child.stdin.on('error', () => {}); // Exit status/cleanup remains authoritative.
    child.stdout.on('error', () => { overflow = true; }); // Fixed failure flag only.
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > (operation === 'read' ? caps.bytes : 0)) {
        overflow = true;
        try { signalGroup(child, 'SIGKILL'); } catch { /* Confirm below. */ }
      } else chunks.push(chunk);
    });
    const closed = new Promise(resolveClose => child.once('close', resolveClose));
    child.stdin.end(input);
    const result = await bounded(async () => {
      const result = await settled;
      await closed; // Drain bounded stdout before parsing it.
      return result;
    }, 3000);
    requireThat(!result.failed && !overflow, operation === 'remove' ? 'cleanup' : 'report');
  } catch (error) { failure = new Error(fixedCode(error, 'report')); }
  finally {
    try { await stopGroup(child, settled); }
    catch {
      if (!failure) failure = new Error('cleanup');
      failure.cleanupFailed = true;
    }
    // stopGroup's finally releases all owned streams and the process handle,
    // including its uncertain-termination path. No late IO promise is awaited.
  }
  if (failure) throw failure;
  return Buffer.concat(chunks);
}

async function isolatedSize(index) {
  let base, worker, settled, groupStopped = true, fixtureOwned = false;
  const record = { index, width: COLLECTION_EDGE_SIZES[index][0], height: COLLECTION_EDGE_SIZES[index][1], status: 'failed', primary: null, secondary: [] };
  try {
    // Parent knows the cleanup path before starting killable IO; no path IPC.
    base = join(tmpdir(), `studio-collection-edges-${randomBytes(16).toString('hex')}`);
    await parentIO('create', { base });
    fixtureOwned = true;
    worker = spawn(process.execPath, [...process.execArgv, workerPath, '--collection-edge-worker', String(index), base], { cwd: studio, detached: true, stdio: 'ignore' });
    settled = observe(worker);
    const result = await bounded(() => settled, caps.workerMs);
    let bytes;
    try { bytes = await parentIO('read', { index }); }
    catch (error) {
      if (error.cleanupFailed) { record.secondary.push('cleanup'); groupStopped = false; }
      throw new Error(result.failed ? 'worker' : fixedCode(error, 'report'));
    }
    requireThat(bytes.length <= caps.bytes, 'report');
    const report = JSON.parse(bytes.toString('utf8'));
    // Preserve the worker's fixed primary code; cleanup and report failures are
    // separate, never a replacement exception containing browser/server detail.
    if (result.failed) {
      if (Array.isArray(report.secondary)) record.secondary.push(...report.secondary.filter(code => codes.has(code)).slice(0, codes.size));
      throw new Error(codes.has(report.primary) ? report.primary : 'worker');
    }
    requireThat(report.schema === 1 && report.surface === surface && report.index === index && report.width === record.width && report.height === record.height && report.synthetic === true && report.status === 'passed' && report.primary === null && report.secondary.length === 0, 'matrix');
    requireThat(Object.keys(report.phases).sort().join(',') === 'forward,initial,reverse,tail,top' && Object.values(report.phases).every(value => value === true), 'matrix');
    requireThat(report.samples.length > 0 && report.samples.length <= caps.samples && report.screenshots.length === 5 && report.pageErrors === 0 && report.warnings === 0 && report.mutations === 0 && report.external === 0 && report.dialogs === 0, 'matrix');
    record.status = 'passed';
  } catch (error) {
    record.primary = fixedCode(error, 'worker');
    if (error.cleanupFailed) { record.secondary.push('cleanup'); groupStopped = false; }
  } finally {
    if (worker) {
      try { await stopGroup(worker, settled); }
      catch { record.secondary.push('cleanup'); groupStopped = false; }
    }
    // A leader exit or a successful signal is not evidence that Chrome/server
    // descendants are gone. Retain the fixture on any group-exit uncertainty.
    record.groupGone = groupStopped;
    record.fixtureRetained = !!base && (!fixtureOwned || !groupStopped);
    if (fixtureOwned && groupStopped) {
      try { await parentIO('remove', { base }); }
      catch (error) {
        record.secondary.push('cleanup');
        record.fixtureRetained = true;
        if (error.cleanupFailed) record.groupGone = false;
      }
    }
    if (record.secondary.length) record.status = 'failed';
  }
  return record;
}

export async function main() {
  // Killable IO selects only this runner's fixed evidence names. No parent fs
  // promise can outlive a timer race or stall before the worker deadline starts.
  await parentIO('init');
  const records = [];
  for (let index = 0; index < COLLECTION_EDGE_SIZES.length; index++) records.push(await isolatedSize(index));
  const passed = records.length === 2 && records.every((record, index) => record.index === index && record.status === 'passed');
  let reportFailure;
  try { await parentIO('summary', { input: JSON.stringify({ schema: 1, surface, synthetic: true, status: passed ? 'passed' : 'failed', records }, null, 2) + '\n' }); }
  catch (error) { reportFailure = error; }
  if (!passed) {
    // Summary IO cannot replace an already-failed browser/matrix outcome.
    if (reportFailure) console.error('Collection modal edges secondary failure: report');
    throw new Error('matrix');
  }
  if (reportFailure) throw reportFailure;
  console.log('PASS: isolated collection modal wheel-tail/return and native keyboard edges (synthetic Chromium only).');
}

if (process.argv[1] && resolve(process.argv[1]) === workerPath) {
  try {
    if (process.argv[2] === '--collection-edge-worker') {
      const index = Number(process.argv[3]), base = process.argv[4];
      requireThat(Number.isInteger(index) && index >= 0 && index < COLLECTION_EDGE_SIZES.length && !!base && dirname(base) === tmpdir() && base.startsWith(join(tmpdir(), 'studio-collection-edges-')), 'setup');
      process.exit(await runSize(index, base) ? 0 : 1);
    } else await main();
  } catch (error) {
    // Never serialize raw exceptions: Puppeteer/server errors can contain URLs,
    // selectors, filesystem paths, field values or browser output.
    console.error(`Collection modal edges failed: ${fixedCode(error, 'setup')}`);
    process.exitCode = 1;
  }
}
