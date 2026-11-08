import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CAPS, COUNT, REQUEST_CAPS, SIZES, controllerCase, fixtureSite, mediaCase, need } from './residual-navigation-media.mjs';

// Remote-only standalone entry. Importing this file does not start the suite.
const self = fileURLToPath(import.meta.url);
const studio = fileURLToPath(new URL('../../', import.meta.url));
const output = join(studio, 'test-results/residual-navigation-media');
const codes = new Set(['setup', 'fixture', 'service', 'auth', 'browser', 'request', 'open', 'probe', 'identity', 'wheel', 'wheel-range', 'tail', 'edge', 'top', 'path', 'keyboard', 'controller', 'screenshot', 'counter', 'timeout', 'cleanup', 'report', 'worker', 'blocked']);
const fixed = (error, fallback) => codes.has(error?.message) ? error.message : fallback;
// hrtime has the same monotonic epoch across parent/worker on this Linux host.
const now = () => Number(process.hrtime.bigint()) / 1e6;
const deadline = (outer, ms) => Math.min(outer, now() + ms);
const remaining = end => { const ms = Math.floor(end - now()); need(ms > 0, 'timeout'); return ms; };
const fault = (list, code) => { if (!list.includes(code)) { need(list.length < codes.size, 'counter'); list.push(code); } };
async function until(thunk, end) {
  const ms = remaining(end); let timer;
  // Synchronously dispatch only after the remaining-time check; sink immediately.
  const task = Promise.resolve().then(thunk); void task.catch(() => {});
  try { return await Promise.race([task, new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
function observe(child) {
  let exited = false;
  const promise = new Promise(done => {
    child.on('error', () => { if (!child.pid) done({ failed: true, exited: false }); });
    child.once('exit', (code, signal) => { exited = true; done({ failed: code !== 0 || signal !== null, exited: true, code }); });
  });
  void promise.catch(() => {});
  return { promise, exited: () => exited };
}
function release(child) {
  if (!child) return;
  for (const stream of child.stdio || []) if (stream) { stream.on('error', () => {}); stream.destroy(); stream.unref?.(); }
  child.unref(); // Keep late error sinks; unref is not exit evidence.
}
function gone(child) {
  if (!child?.pid) return true;
  try { process.kill(-child.pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw new Error('cleanup'); }
}
function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw new Error('cleanup'); }
}
async function stopGroup(child, observed, end) {
  try {
    if (!child?.pid) return;
    if (!gone(child)) {
      remaining(end); signalGroup(child, 'SIGTERM');
      const term = deadline(end, 1000);
      while (!gone(child) && now() < term) await delay(Math.max(1, Math.min(25, Math.ceil(term - now()))));
      if (!gone(child)) { remaining(end); signalGroup(child, 'SIGKILL'); }
      while (!gone(child)) await until(() => delay(25), end);
    }
    const result = await until(() => observed.promise, end);
    need(result.exited && observed.exited(), 'cleanup');
  } finally { release(child); }
}
// Local metadata only: never read args/handles or retain raw text/location.
// Tuple v1: severity 0..2, kind 0..8, observation window 0..6, source 0..8.
function captureConsoleFirst(first, message, severity, window, origin) {
  if (first[1] !== 0) return;
  first[1] = severity;
  first[3] = window; // Lock the first event even when either metadata read fails.
  try {
    const text = message.text();
    if (typeof text === 'string' && text.length <= 2048) {
      const lower = text.toLowerCase();
      const resource = /^failed to load resource: the server responded with a status of [45][0-9]{2}(?:[ (]|$)/.test(lower);
      const missing = resource && /^failed to load resource: the server responded with a status of 404(?:[ (]|$)/.test(lower);
      const matches = [
        lower.includes('download the react devtools'),
        ['each child in a list should have a unique', 'cannot update a component', 'invalid dom property', 'you provided a `value` prop', 'you provided a `checked` prop'].some(literal => lower.includes(literal)),
        lower.includes('failed to decode downloaded font') || lower.includes('ots parsing error'),
        lower.includes('content security policy'),
        lower.includes('autofocus processing was blocked'),
        missing,
        resource && !missing,
        lower.includes('[intervention]') || lower.includes('[deprecation]'),
      ];
      if (matches.filter(Boolean).length === 1) first[2] = matches.indexOf(true) + 1;
    }
  } catch { /* Unknown is evidence, not a reason to alter the sentinel. */ }
  try {
    const raw = message.location()?.url;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return;
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (!origin) return;
    if (url.origin !== origin) first[4] = 8;
    else if (url.pathname === '/') first[4] = 1;
    else if (url.pathname === '/favicon.ico') first[4] = 5;
    else if (url.pathname.startsWith('/api/')) first[4] = 6;
    else if (/^\/assets\/[a-z0-9_.-]+\.(?:js|mjs)$/i.test(url.pathname)) first[4] = 2;
    else if (/^\/assets\/[a-z0-9_.-]+\.css$/i.test(url.pathname)) first[4] = 3;
    else if (/^\/assets\/[a-z0-9_.-]+\.(?:woff|woff2)$/i.test(url.pathname)) first[4] = 4;
    else first[4] = 7;
  } catch { /* No URL or exception leaves this synchronous callback. */ }
}
function projectConsoleFirst(value, count) {
  need(Array.isArray(value) && value.length === 5 && value.every(Number.isInteger) && value[0] === 1 && value[1] >= 0 && value[1] <= 2 && value[2] >= 0 && value[2] <= 8 && value[3] >= 0 && value[3] <= 6 && value[4] >= 0 && value[4] <= 8, 'report');
  need(count === 0 ? value.slice(1).every(n => n === 0) : value[1] === 1 || value[1] === 2, 'report');
  return [...value];
}
function inventory(index) {
  // Absence of a valid terminal report says nothing about whether a case began.
  // This runner emits no positive not-started ledger, so never synthesizes blocked.
  return { schema: 2, synthetic: true, index, width: SIZES[index][0], height: SIZES[index][1], status: 'unavailable', primary: 'report', secondary: [], phases: Array(index === 2 ? 8 : 5).fill(false), counts: Array(17).fill(0), requests: Array(8).fill(0), samples: [], events: [], pngs: [], cleanup: [false, false, false, false], consoleFirst: null };
}
function tracker(normalEnd, cleanupEnd, report) {
  const pending = new Set(); let mode = 'normal', failed = false;
  const fail = code => { fault(report.secondary, code); failed = true; mode = 'stopped'; };
  const dispatch = (thunk, ms = 6000, closing = false) => {
    need(mode !== 'stopped' && (mode === 'normal' || closing) && pending.size < CAPS.pending, 'counter');
    const operationEnd = deadline(mode === 'normal' ? normalEnd : cleanupEnd, ms); remaining(operationEnd);
    // Registration is synchronous and precedes thunk execution, including events.
    const task = Promise.resolve().then(thunk);
    pending.add(task); report.counts[COUNT.peak] = Math.max(report.counts[COUNT.peak], pending.size);
    void task.catch(() => fail('request'));
    void task.then(() => pending.delete(task), () => pending.delete(task));
    const waited = until(() => task, operationEnd);
    void waited.catch(() => fail('timeout'));
    return waited;
  };
  const call = (thunk, ms) => dispatch(thunk, ms);
  const callback = thunk => {
    try { const task = dispatch(thunk, 6000, mode === 'closing'); void task.catch(() => fail('request')); }
    catch { fail('counter'); } // Do not dispatch an untracked abort on overflow.
  };
  const drain = async () => {
    const end = mode === 'normal' ? normalEnd : cleanupEnd;
    while (pending.size) await until(() => Promise.allSettled([...pending]), end);
    need(pending.size === 0 && !failed, 'cleanup');
  };
  return { call, callback, drain, close: thunk => dispatch(thunk, 1500, true), beginClose: () => { need(mode === 'normal' && !failed, 'cleanup'); mode = 'closing'; }, stop: () => { mode = 'stopped'; }, healthy: () => mode === 'normal' && !failed };
}
async function reservePort(call) {
  const server = createServer();
  await call(() => new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }));
  const port = server.address().port;
  await call(() => new Promise((yes, no) => server.close(error => error ? no(error) : yes())));
  return port;
}
async function readiness(thunk, end, call, report) {
  let attempts = 0;
  while (now() < end) {
    need(attempts++ < 80, 'service');
    if (report) { need(report.counts[COUNT.ready] < 80, 'counter'); report.counts[COUNT.ready]++; }
    const value = await call(() => thunk(Math.min(1000, remaining(end))), Math.min(1200, remaining(end)));
    if (value) return value;
    await call(() => delay(100), Math.min(200, remaining(end)));
  }
  throw new Error('timeout');
}
function installSentinels(page, report, tracked, origin, consoleWindow) {
  const increment = key => { need(report.counts[key] < 2147483647, 'counter'); report.counts[key]++; };
  const bad = (key, code) => { increment(key); fault(report.secondary, code); };
  const event = fn => (...args) => { try { fn(...args); } catch { fault(report.secondary, 'counter'); tracked.stop(); } };
  page.on('pageerror', event(() => bad(COUNT.page, 'browser')));
  page.on('console', event(message => {
    const type = message.type();
    if (!['error', 'warn'].includes(type)) return;
    bad(COUNT.warning, 'browser');
    captureConsoleFirst(report.consoleFirst, message, type === 'warn' ? 1 : 2, consoleWindow(), origin);
  }));
  page.on('dialog', event(dialog => { bad(COUNT.dialog, 'browser'); tracked.callback(() => dialog.dismiss()); }));
  page.on('requestfinished', event(() => increment(COUNT.finished)));
  page.on('requestfailed', event(() => bad(COUNT.failed, 'request')));
  const api = ['/api/auth/session', '/api/bootstrap', '/api/content', '/api/content-preview', '/api/content-languages', '/api/settings/taxonomies', '/api/media', '/api/media/file'];
  page.on('request', event(request => {
    const url = new URL(request.url()); let allowed = true;
    if (['data:', 'blob:'].includes(url.protocol)) { increment(COUNT.local); need(report.counts[COUNT.local] <= 96, 'counter'); }
    else if (!origin || url.origin !== origin) { bad(COUNT.external, 'request'); allowed = false; }
    else if (!['GET', 'HEAD'].includes(request.method())) { bad(COUNT.mutation, 'request'); allowed = false; }
    else {
      need(report.counts[COUNT.get] < 96, 'counter'); increment(COUNT.get);
      if (url.pathname.startsWith('/api/')) {
        const index = api.indexOf(url.pathname);
        if (index < 0) { fault(report.secondary, 'request'); allowed = false; }
        else {
          need(report.requests[index] < REQUEST_CAPS[index] && report.requests.reduce((a, b) => a + b, 0) < 11, 'counter');
          // Query shapes are verified in memory, never exported.
          const keys = [...url.searchParams.keys()];
          const validQuery = index === 5 ? keys.length === 1 && url.searchParams.get('language') === 'en' : index === 7 ? keys.every(k => ['path', 'v'].includes(k)) : keys.length === 0;
          need(validQuery, 'request'); report.requests[index]++;
        }
      } else need(url.pathname === '/' || url.pathname === '/favicon.ico' || /^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname), 'request');
    }
    tracked.callback(() => allowed ? request.continue() : request.abort());
  }));
}
async function runCase(index, base, globalEnd) {
  const report = inventory(index); report.primary = null; report.status = 'failed'; report.consoleFirst = [1, 0, 0, 0, 0];
  let consoleWindow = index === 2 ? 6 : 0;
  const end = deadline(globalEnd, CAPS.slices[index]);
  // Reserve cleanup AND terminal report inside this same slice, never restart it.
  const normalEnd = end - 3000;
  const tracked = tracker(normalEnd, end - 500, report), { call } = tracked;
  const directory = join(output, `case-${index}`);
  let browser, page, client, chrome, chromeExit, service, serviceExit, safe = true;
  const reserve = (key, cap) => { need(report.counts[key] < cap && tracked.healthy(), 'counter'); remaining(normalEnd); report.counts[key]++; };
  const children = [];
  try {
    await call(() => mkdir(directory, { recursive: true }));
    const { default: puppeteer } = await call(() => import('puppeteer-core'));
    let origin, password;
    if (index < 2) {
      const site = join(base, `site-${index}`); await fixtureSite(site, call);
      const port = await reservePort(call); origin = `http://localhost:${port}`;
      password = randomBytes(24).toString('hex');
      const { hashPassword } = await call(() => import('../../server/password.ts'));
      const hash = await call(() => hashPassword(password));
      remaining(normalEnd);
      service = spawn(process.execPath, ['dist/server.mjs'], { cwd: studio, env: { ...process.env, STUDIO_ORIGIN: origin, STUDIO_HOST: '127.0.0.1', PORT: String(port), STUDIO_SITE_ROOT: site, STUDIO_STATE: 'file', STUDIO_STATE_DIR: join(base, `state-${index}`), STUDIO_GIT_URL: '', STUDIO_GIT_WORKSPACE: '', STUDIO_OIDC_ISSUER: '', STUDIO_ADMIN_USER: 'owner', STUDIO_ADMIN_PASSWORD_HASH: hash, STUDIO_SESSION_SECRET: randomBytes(32).toString('hex') }, stdio: 'ignore' });
      serviceExit = observe(service); children.push([service, serviceExit]);
      await readiness(async ms => {
        need(!serviceExit.exited(), 'service');
        try {
          const response = await fetch(origin + '/api/auth/config', { signal: AbortSignal.timeout(ms) });
          const ok = response.ok; await response.body?.cancel(); return ok;
        } catch { return false; } // Bounded readiness only, never business/input retry.
      }, deadline(normalEnd, 10000), call, report);
    }
    const executable = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
    need(executable, 'browser');
    const profile = join(base, `profile-${index}`); await call(() => mkdir(profile));
    // PuppeteerNode.defaultArgs is async in puppeteer-core@25.16.0:187–189.
    // Await under the existing deadline; retain one spawn and identical options.
    const chromeArgs = await call(() => puppeteer.defaultArgs({ headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] }));
    need(Array.isArray(chromeArgs) && chromeArgs.every(arg => typeof arg === 'string'), 'browser');
    remaining(normalEnd);
    chrome = spawn(executable, chromeArgs, { stdio: 'ignore' });
    chromeExit = observe(chrome); children.push([chrome, chromeExit]);
    const browserURL = await readiness(async () => {
      need(!chromeExit.exited(), 'browser');
      let text;
      try { text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return false; throw new Error('browser'); }
      need(Buffer.byteLength(text) <= 1024, 'browser');
      const port = text.split('\n')[0]; need(/^\d{1,5}$/.test(port), 'browser'); return `http://127.0.0.1:${port}`;
    }, deadline(normalEnd, 10000), call);
    browser = await call(() => puppeteer.connect({ browserURL, protocolTimeout: Math.min(6000, remaining(normalEnd)) }));
    page = await call(() => browser.newPage()); page.setDefaultTimeout(Math.min(5000, remaining(normalEnd))); page.setDefaultNavigationTimeout(Math.min(10000, remaining(normalEnd)));
    installSentinels(page, report, tracked, origin, () => consoleWindow);
    if (index < 2) {
      await call(() => page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['en'] })));
      const cookie = await call(async () => {
        const response = await fetch(origin + '/api/auth/login', { method: 'POST', signal: AbortSignal.timeout(Math.min(5000, remaining(normalEnd))), headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }) });
        const value = response.headers.get('set-cookie')?.split(';')[0]; await response.body?.cancel(); need(response.status === 200 && value?.includes('='), 'auth'); return value;
      }, 5000);
      const split = cookie.indexOf('='); await call(() => browser.setCookie({ name: cookie.slice(0, split), value: cookie.slice(split + 1), domain: 'localhost', path: '/', httpOnly: true }));
      password = null;
      await call(() => page.setRequestInterception(true));
      await call(() => page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 }));
      consoleWindow = 1;
      await call(() => page.goto(origin, { waitUntil: 'networkidle0', timeout: Math.min(10000, remaining(normalEnd)) }), 10000);
      consoleWindow = 2;
      await call(() => page.waitForFunction(() => document.querySelector('.studio-shell') && !document.querySelector('[aria-busy="true"],.loading-panel,.error') && [...document.querySelectorAll('.sidebar nav button')].filter(n => n.textContent.trim() === 'Media library' && !n.disabled).length === 1));
      consoleWindow = 3;
      need(report.secondary.length === 0 && tracked.healthy(), 'request'); await tracked.drain();
      consoleWindow = 4;
      const buttons = await call(() => page.$$('.sidebar nav button'));
      try {
        const matches = [];
        for (const button of buttons) if (await call(() => button.evaluate(n => n.textContent.trim() === 'Media library' && !n.disabled))) matches.push(button);
        need(matches.length === 1, 'open'); reserve(COUNT.click, 2); await call(() => matches[0].click());
      } finally { for (const button of buttons) await call(() => button.dispose()); }
      client = await call(() => page.createCDPSession());
      await mediaCase({ page, client, report, directory, call, reserve });
      need(report.requests[6] === 1 && report.requests[7] >= 1 && report.requests[7] <= 2, 'request');
    } else {
      await call(() => page.setRequestInterception(true));
      await controllerCase({ page, report, call, reserve, studio });
      need(report.counts[COUNT.get] === 0 && report.counts[COUNT.external] === 0, 'controller');
    }
    need(report.phases.every(Boolean) && report.secondary.length === 0 && tracked.healthy(), 'probe');
  } catch (error) { report.primary = fixed(error, index === 2 ? 'controller' : 'setup'); }
  finally {
    consoleWindow = 5;
    // The original tracker cannot dispatch more normal work after this boundary.
    try {
      await tracked.drain(); report.cleanup[0] = true;
      tracked.beginClose();
      // Existing listeners use the SAME closing lane, original capacity and slice.
      if (page) await tracked.close(() => page.close());
      if (browser) await tracked.close(() => browser.close());
      if (service && !serviceExit.exited()) { remaining(end - 500); service.kill('SIGTERM'); }
      await tracked.drain(); report.cleanup[1] = true;
      for (const [child, observed] of children) { const result = await until(() => observed.promise, end - 500); need(result.exited, 'cleanup'); }
      report.cleanup[2] = true;
    } catch { safe = false; fault(report.secondary, 'cleanup'); }
    // No uncertain child retirement permits another case or evidence RPC.
    if (!safe) tracked.stop();
    report.cleanup[3] = safe;
    report.status = report.primary || report.secondary.length || !safe ? 'failed' : 'passed';
    try {
      need(safe, 'cleanup'); // No terminal evidence IO after uncertain retirement.
      // Only tuple failure is representable without losing the original primary.
      // Other projection/IO failures still take the existing uncertainty exit.
      try { report.consoleFirst = projectConsoleFirst(report.consoleFirst, report.counts[COUNT.warning]); }
      catch { report.consoleFirst = null; fault(report.secondary, 'report'); report.status = 'failed'; }
      const projected = projectReport(report, index);
      const text = JSON.stringify(projected) + '\n'; need(Buffer.byteLength(text) <= (index === 2 ? CAPS.controllerBytes : CAPS.mediaBytes), 'report');
      await until(() => writeFile(join(directory, 'report.json'), text, { flag: 'wx' }), end);
    } catch { safe = false; fault(report.secondary, 'report'); }
  }
  return { safe, passed: safe && report.status === 'passed' };
}

// Closed projection: no browser strings, filenames, URLs, errors or arbitrary
// nested objects are copied from a worker report. Fixed numeric tuple schemas.
function projectReport(value, index) {
  const only = (object, keys) => need(object && Object.getPrototypeOf(object) === Object.prototype && Object.keys(object).length === keys.length && keys.every(k => Object.hasOwn(object, k)), 'report');
  const finite = n => Number.isFinite(n) && Math.abs(n) <= 1000000;
  const integer = n => Number.isInteger(n) && n >= 0 && n <= 2147483647;
  const tuple = (array, length, predicate) => { need(Array.isArray(array) && array.length === length && array.every(predicate), 'report'); return [...array]; };
  only(value, ['schema', 'synthetic', 'index', 'width', 'height', 'status', 'primary', 'secondary', 'phases', 'counts', 'requests', 'samples', 'events', 'pngs', 'cleanup', 'consoleFirst']);
  need(value.schema === 2 && value.synthetic === true && value.index === index && value.width === SIZES[index][0] && value.height === SIZES[index][1] && ['passed', 'failed'].includes(value.status) && (value.primary === null || codes.has(value.primary)), 'report');
  need(Array.isArray(value.secondary) && value.secondary.length <= codes.size && new Set(value.secondary).size === value.secondary.length && value.secondary.every(c => codes.has(c)), 'report');
  const phases = tuple(value.phases, index === 2 ? 8 : 5, n => typeof n === 'boolean');
  const cleanup = tuple(value.cleanup, 4, n => typeof n === 'boolean');
  const counts = tuple(value.counts, 17, integer), requests = tuple(value.requests, 8, integer);
  let consoleFirst;
  if (value.consoleFirst === null) {
    need(value.status === 'failed' && value.secondary.includes('report'), 'report');
    consoleFirst = null; // Explicit diagnostic failure, not zero console events.
  } else consoleFirst = projectConsoleFirst(value.consoleFirst, counts[COUNT.warning]);
  need(counts[0] <= 18 && counts[1] <= 6 && counts[2] <= 2 && counts[3] <= 18 && counts[4] <= 80 && counts[5] <= 2 && counts[6] <= 3 && counts[12] <= 96 && counts[13] <= 96 && counts[16] <= 32 && requests.every((n, i) => n <= REQUEST_CAPS[i]) && requests.reduce((a, b) => a + b, 0) <= 11, 'report');
  need(Array.isArray(value.samples) && value.samples.length <= (index === 2 ? 32 : 128) && Array.isArray(value.events) && value.events.length <= (index === 2 ? 16 : 64) && Array.isArray(value.pngs) && value.pngs.length <= (index === 2 ? 0 : 12), 'report');
  const uint = cap => n => integer(n) && n <= cap;
  const domain = values => n => values.includes(n);
  const bit = domain([0, 1]);
  const dimension = n => finite(n) && n >= 0;
  const scale = n => Number.isFinite(n) && n >= 0 && n <= 10;
  // Every field is checked for FAILED reports too. Zero-valued reserved samples
  // remain representable, but cannot satisfy the separate passed-proof checks.
  const mediaFields = [
    ['phase', domain([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20, 21, 22])],
    ['rootX', finite], ['rootY', finite], ['ownerMax', dimension],
    ['width', uint(16384)], ['height', uint(16384)], ['scale', scale],
    ['activeRole', uint(5)], ['wheels', uint(18)], ['tabs', uint(6)],
    ['clicks', uint(2)], ['focusEvents', uint(64)],
    ['detailsID', uint(4096)], ['tileID', uint(4096)], ['ownerID', uint(4096)],
    ['nonownerFaults', uint(2147483647)], ['repositoryLines', uint(64)],
    ['siteLines', uint(64)], ['rootUnlocked', bit], ['sidebarMode', bit],
    ...['details', 'back', 'siteCopy', 'repositoryCopy', 'tile', 'repositoryPath', 'sitePath'].flatMap(name => [
      [name + 'Left', finite], [name + 'Top', finite],
      [name + 'Width', dimension], [name + 'Height', dimension],
    ]),
    ['outlineWidth', dimension], ['outlineOffset', finite],
    ['outlineSolid', bit], ['outlineAlpha', bit],
    ['visualWidth', dimension], ['visualHeight', dimension],
    ['visualOffsetLeft', finite], ['visualOffsetTop', finite], ['visualPageTop', finite],
    ['hoverX', finite], ['hoverY', finite], ['hoverHitRole', bit],
  ];
  const controllerFields = [
    ['phase', uint(7)], ['rootY', finite], ['activeRole', uint(3)],
    ['originalDocument', bit], ['targetConnected', bit], ['scrollHeight', dimension],
    ['events', uint(16)], ['reserved', domain([0])],
  ];
  const fields = index === 2 ? controllerFields : mediaFields;
  need(fields.length === (index === 2 ? 8 : 60), 'report');
  const samples = value.samples.map(row => {
    need(Array.isArray(row) && row.length === fields.length && fields.every(([, validate], i) => validate(row[i])), 'report');
    return [...row];
  });
  const events = value.events.map(row => {
    const copy = tuple(row, 4, finite);
    need((index === 2 ? [3, 4] : [0, 1, 2, 3]).includes(copy[0]) && uint(index === 2 ? 3 : 5)(copy[1]) && bit(copy[2]) && (copy[0] === 0 ? [-160, 160].includes(copy[3]) : copy[0] === 1 ? bit(copy[3]) : copy[3] === 0), 'report');
    return copy;
  });
  const pngs = value.pngs.map(png => {
    only(png, ['slot', 'bytes', 'coverage']); need(integer(png.slot) && png.slot < 12 && integer(png.bytes) && png.bytes <= CAPS.pngBytes && Array.isArray(png.coverage) && png.coverage.length === 2, 'report');
    const coverage = png.coverage.map((bits, p) => { need(Array.isArray(bits) && (bits.length === 0 || bits.length === (p ? 158 : 164)) && bits.every(n => n === 0 || n === 1), 'report'); return [...bits]; });
    return { slot: png.slot, bytes: png.bytes, coverage };
  });
  need(new Set(pngs.map(p => p.slot)).size === pngs.length, 'report');
  if (value.status === 'passed') {
    need(value.primary === null && value.secondary.length === 0 && phases.every(Boolean) && cleanup.every(Boolean) && [7, 8, 9, 10, 11, 15].every(k => counts[k] === 0), 'report');
    if (index < 2) {
      need(counts[0] >= 4 && counts[1] === 6 && counts[2] === 2 && counts[3] === counts[0] && requests[6] === 1 && requests[7] >= 1 && pngs.every(p => p.bytes > 0) && [0, 9, 10].every(slot => pngs.some(p => p.slot === slot)) && pngs.some(p => p.slot >= 1 && p.slot <= 8), 'report');
      for (let p = 0; p < 2; p++) need(Array.from({ length: p ? 158 : 164 }, (_, i) => pngs.filter(p => p.slot <= 8).some(png => png.coverage[p][i] === 1)).every(Boolean), 'report');
      need(events.filter(e => e[0] === 1).length === 6 && events.filter(e => e[0] === 3).map(e => e[1]).join(',') === '2,3,4,3,2,5' && events.filter(e => e[0] === 0).length === counts[0] && events.every(e => e[2] === 1), 'report');
      need(samples.length > 0 && samples.every(row => row[1] === 0 && row[4] === SIZES[index][0] && row[5] === SIZES[index][1] && Math.abs(row[6] - 1) <= .001 && row[10] === 0 && row[15] === 0 && row[18] === 1 && row[19] === (index === 0 ? 0 : 1) && [12, 13, 14].every(k => row[k] === samples[0][k])), 'report');
      need(samples.some(row => row[0] === 9 && row[2] <= 1) && samples.some(row => row[0] === 10 && row[7] === 4) && samples.some(row => row[0] === 20 && row[3] - row[2] <= 1), 'report');
      need(requests[0] === 1 && requests[1] === 1 && pngs.length <= 11 && !pngs.some(p => p.slot === 11), 'report');
    } else need(counts[0] === 0 && counts[1] === 0 && counts[2] === 0 && counts[5] === 2 && counts[6] === 3 && counts[12] === 0 && requests.every(n => n === 0) && samples.length === 8 && samples.every((row, phase) => row[0] === phase && Math.abs(row[1] - [480, 64, 64, 480, 480, 160, 160, 160][phase]) <= 1 && row[2] === [1, 3, 3, 1, 1, 1, 1, 1][phase] && row[3] === 1 && row[4] === 1 && row[6] === (phase < 3 ? 0 : 1) && row[7] === 0) && events.length === 1 && events[0][0] === 3 && events[0][1] === 1, 'report');
  }
  return { schema: 2, synthetic: true, index, width: SIZES[index][0], height: SIZES[index][1], status: value.status, primary: value.primary, secondary: [...value.secondary], phases, counts, requests, samples, events, pngs, cleanup, consoleFirst };
}

// All parent-owned filesystem operations are separately killable process groups.
const ioSource = `
import { mkdir, rm, open, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
const [op, output, base, indexText, capText] = process.argv.slice(1);
const index = Number(indexText), cap = Number(capText);
try {
  if (![32768,393216].includes(cap)) throw 0;
  if (op === 'create' || op === 'remove') {
    if (dirname(base) !== tmpdir() || !/^studio-residual-evidence-[a-f0-9]{32}$/.test(basename(base))) throw 0;
    if (op === 'create') await mkdir(base); else await rm(base,{recursive:true,force:true});
  } else if (op === 'init') {
    await mkdir(output,{recursive:true}); await rm(join(output,'summary.json'),{force:true});
    const slots = ['initial',...Array.from({length:8},(_,i)=>'down-'+String(i+1).padStart(2,'0')),'return-top','keyboard-last','failure'];
    for(let i=0;i<3;i++) for(const file of ['report.json',...(i<2?slots.map(s=>s+'.png'):[])]) await rm(join(output,'case-'+i,file),{force:true});
  } else if (op === 'read') {
    if (![0,1,2].includes(index) || cap !== (index===2?32768:393216)) throw 0;
    const handle=await open(join(output,'case-'+index,'report.json'),'r'); let bytes;
    try {
      if ((await handle.stat()).size>cap) throw 0;
      const buffer=Buffer.alloc(cap+1); let length=0;
      while(length<buffer.length){const r=await handle.read(buffer,length,buffer.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}
      if(length>cap)throw 0;bytes=buffer.subarray(0,length);
    } finally {await handle.close();}
    await new Promise((yes,no)=>process.stdout.write(bytes,e=>e?no(e):yes()));
  } else if(op==='summary') {
    if(cap!==32768)throw 0;const chunks=[];let length=0;
    for await(const chunk of process.stdin){length+=chunk.length;if(length>cap)throw 0;chunks.push(chunk);}
    await writeFile(join(output,'summary.json'),Buffer.concat(chunks));
  } else throw 0;
} catch {process.exitCode=1;}
`;
async function parentIO(op, outer, base = '', index = 0, input = '') {
  const end = deadline(outer, 6000), normalEnd = end - 3000;
  const cap = op === 'read' && index < 2 ? CAPS.mediaBytes : CAPS.summaryBytes;
  need(Buffer.byteLength(input) <= cap, 'report'); remaining(normalEnd);
  let child, observed, failure, overflow = false, signalUncertain = false, length = 0;
  const chunks = [];
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', ioSource, op, output, base, String(index), String(cap)], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    observed = observe(child);
    child.stdin.on('error', () => {}); child.stdout.on('error', () => { overflow = true; });
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > (op === 'read' ? cap : 0)) { overflow = true; try { signalGroup(child, 'SIGKILL'); } catch { signalUncertain = true; } }
      else chunks.push(chunk);
    });
    const closed = new Promise(done => child.once('close', done)); child.stdin.end(input);
    const result = await until(async () => { const r = await observed.promise; await closed; return r; }, normalEnd);
    need(result.exited && !result.failed && !overflow, 'report');
  } catch (error) { failure = new Error(fixed(error, 'report')); }
  finally {
    try { await stopGroup(child, observed, end); }
    catch { if (!failure) failure = new Error('cleanup'); failure.cleanupFailed = true; }
  }
  if (signalUncertain) { if (!failure) failure = new Error('cleanup'); failure.cleanupFailed = true; }
  if (failure) throw failure;
  return Buffer.concat(chunks);
}
async function worker(base, end) {
  need(end > now() && end - now() <= CAPS.workerMs, 'timeout'); let passed = true;
  for (let index = 0; index < 3; index++) {
    if (now() >= end) return false;
    let result;
    try { result = await runCase(index, base, end); }
    catch { return null; }
    passed &&= result.passed;
    if (!result.safe) return null; // Dedicated uncertainty exit; retain fixture.
  }
  return passed;
}
export async function mainRunner() {
  const end = now() + CAPS.parentMs;
  const workEnd = end - 1000; // Final bounded console receipt is inside 143s.
  let child, observed, primary = null, certain = true, owned = false, result;
  const secondary = [], reports = Array.from({ length: 3 }, (_, i) => inventory(i));
  const uncertainty = error => { if (error?.cleanupFailed) { certain = false; fault(secondary, 'cleanup'); } };
  const base = join(tmpdir(), `studio-residual-evidence-${randomBytes(16).toString('hex')}`);
  try {
    need(process.platform === 'linux', 'setup');
    await parentIO('init', workEnd); owned = true; await parentIO('create', workEnd, base);
    const workerEnd = deadline(workEnd, CAPS.workerMs); remaining(workerEnd);
    child = spawn(process.execPath, [...process.execArgv, self, '--residual-worker', base, String(workerEnd)], { cwd: studio, detached: true, stdio: 'ignore' }); observed = observe(child);
    try { result = await until(() => observed.promise, workerEnd); }
    catch (error) { primary = fixed(error, 'worker'); }
    try { await stopGroup(child, observed, deadline(workEnd, 5000)); }
    catch { certain = false; fault(secondary, 'cleanup'); }
    if (result?.code === 2 || !result?.exited) { certain = false; fault(secondary, 'cleanup'); }
    if (certain) {
      // Exactly THREE reads. The original 6s reserve includes the final 1s
      // console attempt, leaving 5s unallocated; it never authorizes a read.
      for (let index = 0; index < 3; index++) {
        try {
          const value = JSON.parse((await parentIO('read', workEnd, '', index)).toString('utf8'));
          // Keep only fixed failure codes before projection. A malformed diagnosis
          // cannot erase a legitimate case primary; unavailable counts stay null.
          if (value && value.synthetic === true && value.index === index && value.width === SIZES[index][0] && value.height === SIZES[index][1] && value.status === 'failed') {
            if (codes.has(value.primary)) reports[index].primary = value.primary;
            if (Array.isArray(value.secondary)) for (const code of value.secondary.slice(0, codes.size)) if (codes.has(code)) fault(reports[index].secondary, code);
          }
          try { reports[index] = projectReport(value, index); }
          catch { fault(reports[index].secondary, 'report'); throw new Error('report'); }
        } catch (error) { uncertainty(error); fault(secondary, fixed(error, 'report')); }
      }
    }
    need(result && !result.failed && reports.every(r => r.status === 'passed'), 'worker');
  } catch (error) { uncertainty(error); if (primary) fault(secondary, fixed(error, 'worker')); else primary = fixed(error, 'worker'); }
  finally {
    // Do not restart the worker stop budget. A previous uncertain stop is sticky.
    if (child && !certain) release(child);
    const snapshot = {
      schema: 1, synthetic: true, status: primary || secondary.length ? 'failed' : 'passed', primary, secondary: [...secondary], publication: 'pre-cleanup-snapshot', groupsGoneBeforePublication: certain, fixtureRetainedAtPublication: owned || !certain,
      plannedCases: 3, caseStatus: reports.map(r => r.status), casePrimary: reports.map(r => r.primary), counts: reports.map(r => r.status === 'unavailable' ? null : r.counts), requests: reports.map(r => r.status === 'unavailable' ? null : r.requests), pngCount: reports.some(r => r.status === 'unavailable') ? null : reports.reduce((n, r) => n + r.pngs.filter(p => p.bytes > 0).length, 0), workerMs: 90000, parentMs: 143000, finalConsoleMs: 1000, unusedReserveMs: 5000,
    };
    try {
      const text = JSON.stringify(snapshot) + '\n'; need(Buffer.byteLength(text) <= CAPS.summaryBytes, 'report');
      need(reports.reduce((n, report) => n + Buffer.byteLength(JSON.stringify(report) + '\n'), Buffer.byteLength(text)) <= CAPS.totalReportBytes, 'report');
      await parentIO('summary', workEnd, '', 0, text);
    }
    catch (error) { uncertainty(error); fault(secondary, 'report'); }
    // Never delete after ANY uncertain worker or IO exit, including publication.
    if (owned && certain) {
      try { await parentIO('remove', workEnd, base); owned = false; }
      catch (error) { uncertainty(error); fault(secondary, 'cleanup'); }
    }
  }
  // Last publication attempt, AFTER all child/IO supervision and removal decisions.
  // This record cannot attest to its own delivery; success also requires exit 0.
  const receipt = { schema: 1, status: primary || secondary.length ? 'failed' : 'passed', primary, secondary, groupGone: certain, fixtureRetention: !certain ? 'unconfirmed' : owned ? 'retained' : 'removed-or-not-created', plannedCases: 3, caseStatus: reports.map(r => r.status), delivery: 'attempt-only' };
  const text = JSON.stringify(receipt); need(Buffer.byteLength(text) < 4096, 'report');
  const consoleEnd = deadline(end, 1000);
  process.stdout.on('error', () => {}); // Sink retained even after failed delivery.
  try { await until(() => new Promise((yes, no) => process.stdout.write(text + '\n', error => error ? no(new Error('report')) : yes())), consoleEnd); }
  catch {
    // A timed-out pipe write can keep Node alive despite exitCode. No child or
    // filesystem cleanup remains here; preserve prior uncertainty, never publish
    // a second/repaired receipt, retire the pipe and force a NON-success exit.
    process.exitCode = 1;
    try { process.stdout.destroy(); } catch { /* Exit below is the final fallback. */ }
    process.exit(1);
  }
  if (primary || secondary.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    if (process.argv[2] === '--residual-worker') {
      const base = process.argv[3], end = Number(process.argv[4]);
      need(dirname(base) === tmpdir() && /^studio-residual-evidence-[a-f0-9]{32}$/.test(basename(base)) && Number.isFinite(end) && end > now() && end - now() <= CAPS.workerMs, 'setup');
      const result = await worker(base, end);
      process.exit(result === null ? 2 : result ? 0 : 1);
    } else await mainRunner();
  } catch {
    // An unexpected worker exception cannot erase earlier retirement uncertainty.
    if (process.argv[2] === '--residual-worker') process.exit(2);
    process.exitCode = 1;
  }
}
