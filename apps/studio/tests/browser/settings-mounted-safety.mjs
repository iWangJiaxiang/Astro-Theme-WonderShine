import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

// Standalone remote-only ownership fixture. No lifecycle/workflow hook, images,
// source hashes, real service, local test invocation or remount recovery claim.
// All dependencies, bundling, browser and filesystem work run in killable groups.
const self = fileURLToPath(import.meta.url);
const studio = fileURLToPath(new URL('../../', import.meta.url));
const fixtureURL = new URL('./settings-mounted-safety-fixture.mjs', import.meta.url).href;
const output = join(studio, 'test-results/settings-mounted-safety');
const temporary = '/tmp/opencode';
const origin = 'https://mounted-safety.example/';
const caps = Object.freeze({ workerMs: 180000, operationMs: 10000, bytes: 65536, faults: 4, actions: 24, boundaries: 8, resources: 16 });
const codes = new Set(['setup', 'dependency', 'bundle', 'observer', 'browser', 'navigation', 'fixture', 'ready', 'input', 'counter', 'transport', 'completion', 'epoch', 'draft', 'identity', 'retirement', 'portal', 'busy', 'adoption', 'relations', 'guard', 'compatibility', 'drain', 'cleanup', 'deadline', 'report', 'matrix', 'worker', 'page', 'console', 'resource', 'dialog', 'unhandled']);
const need = (value, code) => { if (!value) throw new Error(code); };
const fixed = (error, fallback) => codes.has(error?.message) ? error.message : fallback;
const fault = (list, code) => { if (list.length < caps.faults) list.push(code); else list[caps.faults - 1] = 'counter'; };
const baselineRequests = Object.freeze([0, 3, 4, 4, 4, 4, 4, 3, 3, 3, 2, 2, 3, 3, 3, 8, 12, 11]);
const baselinePuts = Object.freeze([0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0]);
const baselineCapabilities = Object.freeze([0, 0, 0, 0, 0, 0, 0, 14, 14, 14, 10, 14, 14, 14, 14, 0, 0, 0]);
const inventory = () => Array.from({ length: 19 }, (_, i) => ({ id: i + 1, status: 'not-run', primary: null, secondary: [], requests: 0, puts: 0, capabilities: 0, stickyGuardCalls: 0, saveButtonGuardCalls: 0, actions: 0, boundaries: 0, page: 0, console: 0, resource: 0, unhandled: 0, drained: false }));

async function bounded(action, ms = caps.operationMs) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
function observe(child) {
  return new Promise(done => {
    child.on('error', () => done({ failed: true }));
    child.once('exit', (code, signal) => done({ failed: code !== 0 || signal !== null }));
  });
}
function releaseReferences(child) {
  if (!child) return;
  for (const stream of child.stdio || []) { stream?.on('error', () => {}); stream?.removeAllListeners('data'); stream?.destroy(); stream?.unref?.(); }
  child.unref(); // Keepalive release is not process termination evidence.
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
  const until = performance.now() + ms;
  while (groupExists(child)) { if (performance.now() >= until) return false; await delay(25); }
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
      try { await bounded(() => settled, 1000); }
      catch { child.kill('SIGKILL'); await bounded(() => settled, 1000); }
    }
    await bounded(() => settled, 1000);
  } finally { releaseReferences(child); }
}

const title = '[data-settings-group] input[name="title"]';
const save = '[data-settings-group] .settings-save-actions .save-button-main';
const retry = '[data-settings-group] .settings-card > .notice.error button';
const chooser = '[data-settings-group] [data-field="post.today_recommend.post_path"] button.choice-trigger';
const source = '.editor-page .markdown-source';
const observePage = page => page.evaluate(() => window.mountedSafety.observe());
async function wait(page, predicate, ...args) {
  const handle = await page.waitForFunction(predicate, { timeout: caps.operationMs }, ...args);
  try { return true; } finally { await bounded(() => handle.dispose()); }
}
async function checkpoint(page) {
  await page.evaluate(ms => new Promise((yes, no) => {
    const channel = new MessageChannel();
    const close = () => { channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { close(); no(new Error('deadline')); }, ms);
    channel.port1.onmessage = () => { clearTimeout(timer); close(); yes(); };
    channel.port2.postMessage(0);
  }), caps.operationMs);
}
async function completed(page, kind, count) {
  await wait(page, (kind, count) => window.mountedSafety.observe().tokens.filter(t => t.kind === kind && t.done).length >= count, kind, count);
  need((await observePage(page)).tokens.filter(t => t.kind === kind && t.done).length === count, 'completion');
  await checkpoint(page);
}
async function idle(page) {
  await wait(page, () => { const s = window.mountedSafety.observe(); return s.tokens.every(t => t.done) && s.mutations === 0 && s.packsDone; });
  await checkpoint(page);
}
async function held(page, kind, ordinal) {
  await wait(page, (kind, ordinal) => window.mountedSafety.observe().jobs.filter(j => j.kind === kind).length >= ordinal, kind, ordinal);
  const jobs = (await observePage(page)).jobs.filter(j => j.kind === kind);
  need(jobs.length === ordinal, 'counter'); return jobs[ordinal - 1].id;
}
const release = (page, id, options = {}) => page.evaluate((id, options) => window.mountedSafety.release(id, options), id, options);
async function holdJSON(page, id, options = {}) {
  await release(page, id, { ...options, holdJSON: true });
  await wait(page, id => window.mountedSafety.observe().jobs[id - 1].jsonStarted, id);
}
async function finish(page, id, phase, options = {}) {
  if (phase === 'json') await page.evaluate(id => window.mountedSafety.decode(id), id);
  else await release(page, id, options);
  await wait(page, id => window.mountedSafety.observe().jobs[id - 1].done, id);
}
async function dirtyForm(ctx, later = false) {
  await ctx.type(title, later ? ' later' : ' dirty');
  await wait(ctx.page, () => window.mountedSafety.observe().dirty);
  await ctx.page.evaluate(title => window.mountedSafety.checkDraft(title), later ? 'Synthetic site dirty later' : 'Synthetic site dirty');
}
async function ready(page) {
  await wait(page, selector => !!document.querySelector(selector), title);
  need(await page.$eval(title, n => n.value === 'Synthetic site'), 'fixture');
  await wait(page, () => window.mountedSafety.observe().owners === 1);
}
async function openPortal(ctx, kind = 'chooser') {
  await ctx.click(kind === 'save' ? '[data-settings-group] .save-button-toggle' : chooser);
  await wait(ctx.page, kind => !!document.querySelector(kind === 'save' ? '.save-mode-menu' : 'dialog.selection-dialog[open]'), kind);
  await ctx.page.evaluate(kind => window.mountedSafety.capturePortal(kind), kind);
}
async function retired(page) {
  await wait(page, () => !document.querySelector('[data-settings-group]') && window.mountedSafety.observe().portalGone);
  await page.evaluate(() => window.mountedSafety.checkRetired());
}
async function saveHeld(ctx, phase, options = {}) {
  await ctx.click(save);
  const put = await held(ctx.page, 'put', 1);
  await wait(ctx.page, () => window.mountedSafety.observe().mutations === 1 && window.mountedSafety.observe().busy);
  await ctx.page.evaluate(() => window.mountedSafety.checkSubmitted());
  if (phase === 'json') await holdJSON(ctx.page, put, options);
  return put;
}

async function directCase(ctx, row, contract) {
  const page = ctx.page;
  if (row.id === 1) {
    await wait(page, () => !!document.querySelector('#compat') && !!document.querySelector('#bridge'));
    await page.evaluate(() => window.mountedSafety.compatRemember());
    await ctx.boundaryCall(() => page.evaluate(() => window.mountedSafety.compatWrite('name')));
    await wait(page, () => document.querySelector('#bridge')?.textContent === 'Renamed' && document.querySelector('#compat')?.textContent.startsWith('Renamed:'));
    await page.evaluate(() => window.mountedSafety.compatCheck());
    for (const kind of ['equal', 'batch']) await ctx.boundaryCall(() => page.evaluate(kind => window.mountedSafety.compatWrite(kind), kind));
    await checkpoint(page); await page.evaluate(() => window.mountedSafety.compatCheck()); return;
  }
  if ([3, 4, 11].includes(row.id)) {
    const main = await held(page, 'main', 1), relations = await held(page, 'content', 1);
    if (row.id === 4) { await holdJSON(page, main, { status: 401 }); await holdJSON(page, relations, { obsolete: true }); }
    if (row.id === 11) await holdJSON(page, relations, { status: 401 });
    await ctx.boundary(row.id === 3 ? 'session' : row.id === 4 ? 'identity' : 'same-transport', row.id === 11);
    // The invalidated content caller must finish independently of its held orphan.
    await completed(page, 'settings-loadRelations', row.id === 11 ? 2 : 1);
    need(!(await observePage(page)).jobs[relations - 1].done, 'completion');
    if (row.id === 11) {
      await finish(page, main, 'transport', { obsolete: true }); await finish(page, relations, 'json');
      await page.evaluate(() => window.mountedSafety.pack()); await idle(page); await retired(page); return;
    }
    await finish(page, main, row.id === 4 ? 'json' : 'transport', { obsolete: true });
    await finish(page, relations, row.id === 4 ? 'json' : 'transport', { status: 401 });
    await completed(page, 'settings-load', 1);
    need(!(await observePage(page)).reauth && await page.evaluate(selector => !document.querySelector(selector), title), 'retirement');
    await ctx.click(contract.selectors.reload);
    const nextMain = await held(page, 'main', 2), nextRelations = await held(page, 'content', 2);
    need((await observePage(page)).jobs[nextRelations - 1].refresh, 'transport');
    await release(page, nextMain); await release(page, nextRelations); await idle(page); await ready(page);
    await page.evaluate(() => window.mountedSafety.checkCurrentRelations()); return;
  }
  await ready(page); await idle(page);
  await dirtyForm(ctx); await page.evaluate(() => { window.mountedSafety.remember(); window.mountedSafety.mark(); });
  if (row.id === 19) {
    await ctx.dialog('confirm', true, () => ctx.click('[data-settings-group] .settings-discard'));
    await completed(page, 'settings-load', 2); await idle(page);
    await page.evaluate(() => window.mountedSafety.checkReloadFailure());
    await ctx.dialog('confirm', false, () => ctx.click(contract.selectors.errorRetry));
    await page.evaluate(() => window.mountedSafety.checkRetryCancelled());
    await ctx.dialog('confirm', true, () => ctx.click(contract.selectors.errorRetry));
    await completed(page, 'settings-load', 3); await idle(page); await ready(page);
    await page.evaluate(() => { window.mountedSafety.checkReloadRecovered(); window.mountedSafety.checkCurrentRelations(); });
    await dirtyForm(ctx); return;
  }
  if (row.id === 2) {
    const put = await saveHeld(ctx, 'json');
    await dirtyForm(ctx, true);
    const before = (await observePage(page)).requests;
    for (const language of ['en', 'zh-CN']) {
      await ctx.select('.language-switcher select', language);
      await wait(page, language => document.documentElement.lang === language, language);
      await page.evaluate(() => { window.mountedSafety.same(); window.mountedSafety.checkDraft('Synthetic site dirty later'); });
      need((await observePage(page)).requests === before && (await observePage(page)).busy && (await observePage(page)).mutations === 1, 'busy');
    }
    await finish(page, put, 'json'); await completed(page, 'settings-save', 1); await idle(page);
    await page.evaluate(() => { window.mountedSafety.same(); window.mountedSafety.checkDraft('Synthetic site dirty later', true); window.mountedSafety.checkSaveAdopted(); }); return;
  }
  if ([5, 6, 7].includes(row.id)) {
    const phase = row.id === 6 ? 'transport' : 'json', options = row.id === 6 ? { status: 401 } : row.id === 7 ? { status: 409 } : {};
    const put = await saveHeld(ctx, phase, options);
    if (row.id === 5) await dirtyForm(ctx, true);
    await page.evaluate(() => window.mountedSafety.mark());
    await ctx.boundary(row.id === 5 ? 'csrf' : row.id === 6 ? 'expires' : 'session');
    await page.evaluate(() => window.mountedSafety.checkPreserved());
    await ctx.click(retry);
    await wait(page, () => { const s = window.mountedSafety.observe(); return s.tokens.filter(t => t.kind === 'settings-loadRelations').length === 2 && s.tokens.some(t => t.kind === 'settings-loadRelations' && !t.done); });
    need((await observePage(page)).jobs.filter(j => j.kind === 'content').length === 1, 'transport');
    need((await observePage(page)).busy && (await observePage(page)).mutations === 1, 'busy');
    await finish(page, put, phase, options); await completed(page, 'settings-save', 1);
    const current = await held(page, 'content', 2);
    await page.evaluate(async () => { window.mountedSafety.checkUnknown(); window.mountedSafety.checkPreserved(); window.mountedSafety.checkForcedCurrent(); await window.mountedSafety.checkStickySave(); });
    await release(page, current); await idle(page);
    await page.evaluate(() => { window.mountedSafety.checkCurrentRelations(); window.mountedSafety.checkPreserved(); }); return;
  }
  if (row.id === 12) {
    await ctx.click('[data-settings-group] .save-button-toggle');
    await wait(page, () => !!document.querySelector('.save-mode-menu [role="radio"]:nth-child(2)'));
    await ctx.click('.save-mode-menu [role="radio"]:nth-child(2)');
    await wait(page, () => !document.querySelector('.save-mode-menu'));
    await openPortal(ctx, 'save'); await ctx.boundary('default-transport', true); await retired(page);
    await page.evaluate(() => window.mountedSafety.pack()); await idle(page); return;
  }
  const phase = [8, 14].includes(row.id) ? 'transport' : 'json';
  const options = row.id === 9 ? { status: 401 } : [10, 14].includes(row.id) ? { status: 409 } : row.id === 15 ? { badJSON: true } : {};
  const put = await saveHeld(ctx, phase, options);
  await openPortal(ctx);
  if ([13, 14].includes(row.id)) {
    const prop = row.id === 13 ? 'group' : 'language';
    await ctx.boundaryCall(() => page.evaluate(prop => window.mountedSafety.prop(prop), prop));
    await retired(page); await page.evaluate(() => window.mountedSafety.pack());
    await ctx.boundaryCall(() => page.evaluate(prop => window.mountedSafety.prop(prop, true), prop));
  } else await ctx.boundary(row.id === 8 ? 'id' : row.id === 9 ? 'null' : row.id === 10 ? 'method' : 'unmount', true);
  await retired(page);
  need((await observePage(page)).busy && (await observePage(page)).mutations === 1, 'busy');
  await finish(page, put, phase, options);
  await page.evaluate(() => window.mountedSafety.pack()); await idle(page); await retired(page);
}

async function appCase(ctx, row, contract) {
  const page = ctx.page;
  await wait(page, () => !!document.querySelector('.home-grid .content-row'));
  await idle(page); need((await observePage(page)).requests === 4, 'counter');
  if (row.id === 16) await ctx.click('aside nav[aria-label="站点设置"] button');
  else {
    await ctx.click('.home-grid .content-row');
    await wait(page, selector => !!document.querySelector(selector), source);
    await idle(page);
    need((await observePage(page)).requests === 8, 'counter');
    if (row.id === 18) { await ctx.type(source, ' dirty'); await page.evaluate(() => window.mountedSafety.checkDocumentDraft()); }
    // Approved public page-settings tab; retain the real typed exit chain.
    await ctx.click('.page-editor-tabs button:last-child');
  }
  await ready(page); await idle(page); await dirtyForm(ctx);
  await page.evaluate(() => window.mountedSafety.mark());
  let put;
  if (row.id !== 18) put = await saveHeld(ctx, row.id === 16 ? 'transport' : 'json', row.id === 17 ? { status: 409 } : {});
  else await openPortal(ctx);
  await ctx.boundary('reset'); await retired(page);
  await page.evaluate(() => window.mountedSafety.checkGuard());
  if (put) {
    await ctx.dialog('alert', false, () => ctx.click(contract.selectors.exit));
    await retired(page); need((await observePage(page)).mutations === 1, 'guard');
    await finish(page, put, row.id === 16 ? 'transport' : 'json', row.id === 17 ? { status: 409 } : {});
    await completed(page, 'settings-save', 1); await idle(page);
  }
  const count = (await observePage(page)).requests;
  await ctx.dialog('confirm', false, () => ctx.click(contract.selectors.exit));
  need((await observePage(page)).requests === count, 'guard');
  await retired(page); await page.evaluate(() => window.mountedSafety.checkGuard());
  await ctx.dialog('confirm', true, () => ctx.click(contract.selectors.exit));
  await wait(page, () => !!document.querySelector('.home-grid .content-row') && !document.querySelector('.page-template-settings'));
  await idle(page);
  await page.evaluate(() => window.mountedSafety.checkExited());
  if (row.id === 18) await page.evaluate(() => window.mountedSafety.checkDocumentDraft());
}

async function runCase(browser, row, script, contract, record) {
  let page, injected = false, uncertain = false, stage = 'setup', plannedDialog = null;
  // Reserve before issuing work. Keep every issued RPC, including one whose
  // timeout fires before its real promise settles; a timeout is not drain proof.
  const pending = [];
  let supplementalClosed = false, supplementalFailed = false;
  const supplementalFault = () => {
    record.drained = false; uncertain = true; supplementalFailed = true; fault(record.secondary, 'resource');
  };
  const track = action => {
    if (supplementalClosed || pending.length >= caps.resources) { supplementalFault(); return; }
    const entry = { done: false, ok: false, completion: null, watchdog: null };
    pending.push(entry);
    entry.completion = Promise.resolve().then(action).then(
      () => { entry.done = true; entry.ok = true; },
      () => { entry.done = true; supplementalFault(); },
    );
    entry.watchdog = bounded(() => entry.completion).catch(supplementalFault);
  };
  const drainSupplemental = async () => {
    let active = true;
    try {
      await bounded(async () => {
        for (;;) {
          const count = pending.length;
          await Promise.all(pending.map(entry => entry.completion));
          if (!active) return;
          await Promise.all(pending.map(entry => entry.watchdog));
          if (!active) return;
          await checkpoint(page);
          if (!active) return;
          if (pending.length === count && pending.every(entry => entry.done)) {
            need(!supplementalFailed && pending.every(entry => entry.ok), 'resource'); return;
          }
        }
      });
    } finally { active = false; } // A timed-out drain must never issue another RPC.
  };
  const onPage = () => { if (record.page < 64) record.page++; else fault(record.secondary, 'counter'); };
  const onConsole = message => { if (message.type() === 'error') { if (record.console < 64) record.console++; else fault(record.secondary, 'counter'); } };
  const onRequest = request => {
    if (request.isNavigationRequest() && request.url() === origin) track(() => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="root"></div>' }));
    else if (request.url().startsWith('data:')) track(() => request.continue());
    else { if (record.resource < 64) record.resource++; else fault(record.secondary, 'counter'); track(() => request.abort()); }
  };
  const onDialog = event => {
    const plan = plannedDialog; plannedDialog = null;
    if (!plan || event.type() !== plan.kind) { fault(record.secondary, 'dialog'); track(() => event.dismiss()); return; }
    plan.seen = true; track(() => plan.accept ? event.accept() : event.dismiss());
  };
  const step = async action => {
    try { return await bounded(action); }
    catch (error) { if (error?.name === 'TimeoutError' || fixed(error, '') === 'deadline') uncertain = true; throw error; }
  };
  const action = async fn => { need(!uncertain && ++record.actions <= caps.actions, 'input'); return step(fn); };
  const ctx = {
    get page() { return page; },
    click: selector => action(() => page.click(selector)),
    select: (selector, value) => action(() => page.select(selector, value)),
    type: (selector, value) => action(async () => {
      await page.focus(selector);
      await page.$eval(selector, node => node.setSelectionRange(node.value.length, node.value.length));
      await page.type(selector, value);
    }),
    boundaryCall: fn => { need(!uncertain && ++record.boundaries <= caps.boundaries, 'counter'); return step(fn); },
    boundary: (kind, pack = false) => ctx.boundaryCall(() => page.evaluate((kind, pack) => window.mountedSafety.boundary(kind, pack), kind, pack)),
    dialog: async (kind, accept, fn) => {
      need(!plannedDialog, 'dialog'); const plan = { kind, accept, seen: false }; plannedDialog = plan;
      await fn(); await step(() => wait(page, () => true));
      need(plan.seen && plannedDialog === null, 'dialog');
    },
  };
  record.status = 'failed';
  try {
    const rawPage = await step(() => browser.newPage());
    // Every protocol RPC, not only input and readiness, has an operation bound.
    // Timeouts invalidate the scenario; they never authorize replay or deletion.
    const rpc = new Set(['evaluate', '$eval', '$', 'waitForFunction', 'click', 'select', 'focus', 'type']);
    page = new Proxy(rawPage, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return rpc.has(key) ? (...args) => step(() => value.apply(target, args)) : value.bind(target);
    } });
    page.setDefaultTimeout(caps.operationMs); page.setDefaultNavigationTimeout(caps.operationMs);
    page.on('pageerror', onPage); page.on('console', onConsole); page.on('dialog', onDialog);
    await step(() => page.setRequestInterception(true)); page.on('request', onRequest);
    await step(() => page.setViewport({ width: 1280, height: 1000 }));
    stage = 'navigation'; await step(() => page.goto(origin, { waitUntil: 'domcontentloaded' }));
    // Mark before injecting: partially executed setup still gets cleanup attempts.
    injected = true;
    await step(async () => { const handle = await page.addScriptTag({ content: script }); await handle.dispose(); });
    await step(() => page.evaluate(id => window.mountedSafety.start(id), row.id));
    stage = 'fixture';
    if (row.mode === 'app') await appCase(ctx, row, contract);
    else await directCase(ctx, row, contract);
    stage = 'completion'; await step(() => idle(page));
    await step(() => page.evaluate(row => window.mountedSafety.checkCounts(row), row));
    need(!record.page && !record.console && !record.resource && !record.secondary.length, 'page');
    record.status = 'passed';
  } catch (error) { record.primary = fixed(error, stage); }
  finally {
    if (page && !page.isClosed()) {
      let fixtureDrained = false;
      if (injected) {
        try { await bounded(() => page.evaluate(() => window.mountedSafety?.cleanup())); }
        catch { fault(record.secondary, 'cleanup'); uncertain = true; }
        try {
          await bounded(() => wait(page, () => { const s = window.mountedSafety?.observe(); return !!s && s.unmounted && s.tokens.every(t => t.done) && s.mutations === 0 && s.packsDone && s.jobs.every(j => j.released && j.done && (!j.jsonStarted || j.jsonReleased)); }));
          await drainSupplemental();
          await bounded(() => checkpoint(page));
          const end = await bounded(() => observePage(page));
          record.requests = end.requests; record.puts = end.puts; record.capabilities = end.capabilities; record.unhandled = end.unhandled;
          record.stickyGuardCalls = end.stickyGuardCalls; record.saveButtonGuardCalls = end.saveButtonGuardCalls;
          need(end.unmounted && end.tokens.every(t => t.done) && end.mutations === 0 && end.packsDone && end.jobs.every(j => j.released && j.done && (!j.jsonStarted || j.jsonReleased)), 'drain');
          need(end.portalGone && end.unexpected === 0 && end.unhandled === 0 && end.storageClearCalls === 0, 'drain');
          fixtureDrained = true;
        } catch { fault(record.secondary, 'drain'); uncertain = true; }
        // Restoration is independent of cleanup/drain success, not its last step.
        try { await bounded(() => page.evaluate(() => window.mountedSafety?.forget())); }
        catch { fault(record.secondary, 'cleanup'); uncertain = true; }
      }
      try {
        // Include RPCs emitted during cleanup/restoration and a final task turn.
        await drainSupplemental();
        need(fixtureDrained && !uncertain && !record.page && !record.console && !record.resource && !record.secondary.length && !plannedDialog, 'drain');
        record.drained = true;
      } catch { fault(record.secondary, 'resource'); uncertain = true; }
      supplementalClosed = true;
      // Never use page.close to make pending RPCs appear drained.
      try { await bounded(() => page.close(), 2000); } catch { fault(record.secondary, 'cleanup'); uncertain = true; }
      if (supplementalFailed) record.drained = false;
    } else { fault(record.secondary, 'cleanup'); uncertain = true; }
    if (page) {
      try { page.off('pageerror', onPage); page.off('console', onConsole); page.off('dialog', onDialog); page.off('request', onRequest); }
      catch { fault(record.secondary, 'cleanup'); uncertain = true; }
    }
    if (record.page) fault(record.secondary, 'page');
    if (record.console) fault(record.secondary, 'console');
    if (record.resource) fault(record.secondary, 'resource');
    if (plannedDialog) fault(record.secondary, 'dialog');
    if (record.primary || record.secondary.length || !record.drained) record.status = 'failed';
  }
  return !uncertain && record.status === 'passed';
}

async function worker(base) {
  const report = { schema: 1, synthetic: true, status: 'failed', primary: null, secondary: [], bundles: 0, browsers: 0, records: inventory() };
  let chrome, settled, browser, stage = 'dependency';
  const persist = async () => { const text = JSON.stringify(report); need(Buffer.byteLength(text) <= caps.bytes, 'report'); await writeFile(join(output, 'report.json'), text + '\n'); };
  try {
    // Dynamic dependencies are intentionally loaded only in this killable worker.
    const { bundleMountedSafety, mountedCases, productContract } = await import(fixtureURL);
    need(mountedCases.length === 19 && mountedCases.every((r, i) => r.id === i + 1), 'matrix');
    for (const [i, row] of mountedCases.entries()) need(row.requests === (i < 18 ? baselineRequests[i] : 6) && row.puts === (i < 18 ? baselinePuts[i] : 0) && row.capabilities === (i < 18 ? baselineCapabilities[i] : 0), 'matrix');
    need(productContract.stickyGuardCalls === 3 && productContract.saveButtonGuardCalls === 4, 'matrix');
    need(productContract.approved, 'dependency');
    stage = 'bundle'; const bundles = await bundleMountedSafety(); report.bundles = bundles.size; need(bundles.size === 3, 'bundle');
    const { default: puppeteer } = await import('puppeteer-core');
    stage = 'browser';
    const executable = process.env.STUDIO_TEST_BROWSER || '/usr/bin/chromium';
    const profile = join(base, 'browser'); await mkdir(profile);
    chrome = spawn(executable, puppeteer.defaultArgs({ headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] }), { stdio: 'ignore' });
    settled = observe(chrome); report.browsers++;
    let stopped = false, port; void settled.then(() => { stopped = true; });
    const until = Date.now() + caps.operationMs;
    while (!port) {
      need(!stopped && Date.now() < until, 'browser');
      try { const first = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; if (/^\d{1,5}$/.test(first) && Number(first) > 0 && Number(first) <= 65535) port = Number(first); }
      catch { /* Bounded resource readiness, never an input replay. */ }
      if (!port) await delay(50);
    }
    browser = await bounded(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }));
    for (const row of mountedCases) {
      const keepGoing = await runCase(browser, row, bundles.get(row.mode), productContract, report.records[row.id - 1]);
      await persist(); // Fixed-schema partial evidence, including not-run tail.
      if (!keepGoing) break;
    }
    need(report.records.every(r => r.status === 'passed') && report.records.slice(0, 18).reduce((n, r) => n + r.requests, 0) === 76 && report.records[18].requests === 6 && report.records.reduce((n, r) => n + r.requests, 0) === 82 && report.records.reduce((n, r) => n + r.puts, 0) === 12 && report.records.reduce((n, r) => n + r.capabilities, 0) === 108 && report.records.reduce((n, r) => n + r.stickyGuardCalls, 0) === 3 && report.records.reduce((n, r) => n + r.saveButtonGuardCalls, 0) === 4, 'matrix');
    report.status = 'passed';
  } catch (error) { report.primary = fixed(error, stage); }
  finally {
    if (browser) {
      try { await bounded(() => browser.close(), 2000); } catch { fault(report.secondary, 'cleanup'); }
      try { await bounded(() => browser.disconnect(), 2000); } catch { fault(report.secondary, 'cleanup'); }
    }
    try { await stopChrome(chrome, settled); } catch { fault(report.secondary, 'cleanup'); }
    if (report.secondary.length) report.status = 'failed';
    try { await persist(); } catch { fault(report.secondary, 'report'); report.status = 'failed'; }
  }
  return report.status === 'passed';
}

// No parent filesystem promise: bounded killable IO helpers own each operation.
// Only fixed-shape capped numeric/boolean/enum reports cross process boundaries.
const ioSource = `
import { mkdir, rm, open, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
const [op, output, base, capText] = process.argv.slice(1), cap = Number(capText);
try {
  if (cap !== 65536) throw 0;
  if (op === 'create' || op === 'remove') {
    if (dirname(base) !== '/tmp/opencode' || !/^studio-settings-mounted-[a-f0-9]{32}$/.test(basename(base))) throw 0;
    if (op === 'create') await mkdir(base); else await rm(base, { recursive: true, force: true });
  } else if (op === 'init') {
    await mkdir(output, { recursive: true });
    for (const name of ['report.json', 'summary.json']) await rm(join(output, name), { force: true });
  } else if (op === 'read') {
    const handle = await open(join(output, 'report.json'), 'r'); let data;
    try {
      if ((await handle.stat()).size > cap) throw 0;
      const buffer = Buffer.alloc(cap + 1); let length = 0;
      while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > cap) throw 0; data = buffer.subarray(0, length);
    } finally { await handle.close(); }
    await new Promise((yes, no) => process.stdout.write(data, error => error ? no(error) : yes()));
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
    settled = observe(child); child.stdin.on('error', () => {}); child.stdout.on('error', () => { overflow = true; });
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
  const only = (object, keys) => need(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(k => Object.hasOwn(object, k)), 'report');
  const integer = (value, cap) => Number.isInteger(value) && value >= 0 && value <= cap;
  const error = value => value === null || codes.has(value);
  only(report, ['schema', 'synthetic', 'status', 'primary', 'secondary', 'bundles', 'browsers', 'records']);
  need(report.schema === 1 && report.synthetic === true && ['passed', 'failed'].includes(report.status) && error(report.primary) && Array.isArray(report.secondary) && report.secondary.length <= caps.faults && report.secondary.every(c => codes.has(c)) && integer(report.bundles, 3) && integer(report.browsers, 1) && Array.isArray(report.records) && report.records.length === 19, 'report');
  const records = report.records.map((row, i) => {
    only(row, Object.keys(inventory()[0]));
    need(row.id === i + 1 && ['passed', 'failed', 'not-run'].includes(row.status) && error(row.primary) && Array.isArray(row.secondary) && row.secondary.length <= caps.faults && row.secondary.every(c => codes.has(c)) && typeof row.drained === 'boolean', 'report');
    for (const [key, cap] of Object.entries({ requests: 16, puts: 1, capabilities: 14, stickyGuardCalls: 1, saveButtonGuardCalls: 4, actions: 24, boundaries: 8, page: 64, console: 64, resource: 64, unhandled: 64 })) need(integer(row[key], cap), 'report');
    if (row.status === 'passed') need(row.primary === null && !row.secondary.length && row.drained && row.page + row.console + row.resource + row.unhandled === 0 && row.stickyGuardCalls === ([5, 6, 7].includes(row.id) ? 1 : 0) && row.saveButtonGuardCalls === (row.id === 12 ? 4 : 0) && row.requests === (i < 18 ? baselineRequests[i] : 6) && row.puts === (i < 18 ? baselinePuts[i] : 0) && row.capabilities === (i < 18 ? baselineCapabilities[i] : 0), 'matrix');
    if (row.status === 'not-run') need(row.primary === null && !row.secondary.length && !row.drained && ['requests', 'puts', 'capabilities', 'stickyGuardCalls', 'saveButtonGuardCalls', 'actions', 'boundaries', 'page', 'console', 'resource', 'unhandled'].every(k => row[k] === 0), 'report');
    return { ...row, secondary: [...row.secondary] };
  });
  if (report.status === 'passed') need(report.bundles === 3 && report.browsers === 1 && records.every(r => r.status === 'passed') && records.slice(0, 18).reduce((n, r) => n + r.requests, 0) === 76 && records[18].requests === 6 && records.reduce((n, r) => n + r.requests, 0) === 82 && records.reduce((n, r) => n + r.puts, 0) === 12 && records.reduce((n, r) => n + r.capabilities, 0) === 108 && records.reduce((n, r) => n + r.stickyGuardCalls, 0) === 3 && records.reduce((n, r) => n + r.saveButtonGuardCalls, 0) === 4, 'matrix');
  return { schema: 1, synthetic: true, status: report.status, primary: report.primary, secondary: [...report.secondary], bundles: report.bundles, browsers: report.browsers, records };
}
export async function mainRunner() {
  let child, settled, owned = false, certain = true, primary = null, report = null;
  const secondary = [], base = join(temporary, 'studio-settings-mounted-' + randomBytes(16).toString('hex'));
  // Sticky across every parent IO catch, including partial startup and summary
  // publication. A later successful worker stop cannot clear IO uncertainty.
  const observeUncertainty = error => {
    if (error?.cleanupFailed) { certain = false; if (!secondary.includes('cleanup')) fault(secondary, 'cleanup'); }
  };
  try {
    need(process.platform === 'linux', 'setup');
    await parentIO('init'); owned = true; await parentIO('create', base);
    child = spawn(process.execPath, [self, '--settings-mounted-worker', base], { cwd: studio, detached: true, stdio: 'ignore' }); settled = observe(child);
    let result;
    try { result = await bounded(() => settled, caps.workerMs); } catch (error) { primary = fixed(error, 'worker'); }
    let canRead = true;
    try { await stopGroup(child, settled); } catch { certain = false; canRead = false; if (primary) fault(secondary, 'cleanup'); else primary = 'cleanup'; }
    if (canRead) {
      try { report = projectReport(JSON.parse((await parentIO('read')).toString('utf8'))); }
      catch (error) {
        observeUncertainty(error);
        if (primary) fault(secondary, fixed(error, 'report')); else throw error;
      }
    }
    if (primary) throw new Error(primary);
    need(!result.failed && report.status === 'passed' && report.primary === null && !report.secondary.length, report.primary || 'matrix');
  } catch (error) {
    // Also covers init/create/read before a worker or fixture fully exists.
    observeUncertainty(error);
    if (!primary) primary = fixed(error, 'worker');
    else if (fixed(error, 'worker') !== primary) fault(secondary, fixed(error, 'worker'));
  } finally {
    try { await stopGroup(child, settled); } catch { certain = false; fault(secondary, 'cleanup'); }
    // Publish before removal. This snapshot cannot certify its own IO writer's
    // exit or later removal; summary IO uncertainty therefore retains the fixture.
    const summary = { schema: 1, synthetic: true, status: primary || secondary.length ? 'failed' : 'passed', primary, secondary: [...secondary],
      workerPrimary: report?.primary ?? null, workerSecondary: report?.secondary || [],
      publication: 'pre-cleanup-snapshot', groupGone: 'unconfirmed', groupsGoneBeforePublication: certain, fixtureRetainedAtPublication: owned || !certain,
      baselineCases: 18, baselineRequests: 76, recoveryCases: 1, recoveryRequests: 6, recoveryPuts: 0, recoveryCapabilities: 0,
      plannedCases: 19, plannedRequests: 82, plannedPuts: 12, plannedCapabilities: 108, plannedStickyGuardCalls: 3, plannedSaveButtonGuardCalls: 4, plannedBundles: 3, screenshots: 0, records: report?.records || inventory() };
    try { await parentIO('summary', '', JSON.stringify(summary) + '\n'); }
    catch (error) { observeUncertainty(error); fault(secondary, 'report'); }
    // No recursive rewrite and no retry: removal begins only after every earlier
    // group, including summary IO, has confirmed exit. Uncertainty forbids it.
    if (owned && certain) {
      try { await parentIO('remove', base); owned = false; }
      catch (error) { observeUncertainty(error); fault(secondary, 'cleanup'); }
    }
  }
  // Final fixed-size console receipt only after the last IO helper has settled.
  const receipt = { schema: 1, status: primary || secondary.length ? 'failed' : 'passed', primary, secondary: [...secondary], groupGone: certain,
    fixtureRetention: !certain ? 'unconfirmed' : owned ? 'retained' : 'removed-or-not-created' };
  if (primary || secondary.length) console.error(JSON.stringify(receipt));
  else console.log(JSON.stringify(receipt));
  if (primary || secondary.length) throw new AggregateError([...(primary ? [new Error(primary)] : []), ...secondary.map(c => new Error(c))], 'matrix');
  console.log('PASS: settings-mounted-safety baselineRealms=18 baselineTransport=76 recoveryRealms=1 recoveryGET=6 realms=19 transport=82 settingsPUT=12 capabilities=108 stickyGuards=3 saveButtonGuards=4 bundles=3 browser=1 screenshots=0; synthetic ownership only.');
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    if (process.argv[2] === '--settings-mounted-worker') {
      const base = process.argv[3]; need(base && dirname(base) === temporary && /^studio-settings-mounted-[a-f0-9]{32}$/.test(basename(base)), 'setup');
      process.exit(await worker(base) ? 0 : 1);
    } else await mainRunner();
  } catch (error) { console.error('Settings mounted safety failed: ' + fixed(error, 'worker')); process.exitCode = 1; }
}
