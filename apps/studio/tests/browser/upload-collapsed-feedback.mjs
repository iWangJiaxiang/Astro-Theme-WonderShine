import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { bundleUploadFeedbackFixture, uploadFeedbackStyles } from './upload-collapsed-feedback-fixture.mjs';

// Independent remote-CI entry point. No App, API server, native IPC, installation
// or existing lifecycle runner. Build and all browser/worker IO are inside one
// killable worker group. Evidence is DOM semantics, NOT real AT announcements.
const studio = fileURLToPath(new URL('../../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const output = join(studio, 'test-results/upload-collapsed-feedback');
const origin = 'https://upload-feedback.example';
const caps = Object.freeze({ workerMs: 225000, operationMs: 5000, tabs: 40, wheels: 16, bytes: 196608, errors: 64 });
const codes = new Set(['setup', 'bundle', 'observer', 'css', 'browser', 'navigation', 'fixture', 'ready', 'input', 'toggle', 'identity', 'feedback', 'counts', 'busy', 'semantic', 'geometry', 'screenshot', 'retirement', 'drain', 'cleanup', 'deadline', 'report', 'matrix', 'worker', 'resource', 'page', 'console', 'unhandled']);
const fail = code => { throw new Error(code); };
const need = (condition, code) => { if (!condition) fail(code); };
const fixed = (error, fallback) => codes.has(error?.message) ? error.message : fallback;

export function uploadFeedbackCases() {
  const cases = [];
  const add = record => cases.push(Object.freeze({ id: cases.length, ...record }));
  for (const host of ['library', 'picker']) for (const width of [320, 390]) for (const locale of ['en', 'zh-CN']) for (const input of ['pointer', 'keyboard']) {
    add({ group: 'base', kind: 'mixed', host, width, locale, input, key: width === 320 ? 'Enter' : 'Space', native: locale === 'zh-CN', posts: 3, pngs: input === 'pointer' ? 3 : 0 });
  }
  for (const host of ['library', 'picker']) for (const status of [401, 403, 409]) {
    add({ group: 'base', kind: 'blocker', host, width: status === 403 ? 390 : 320, locale: status === 401 ? 'en' : 'zh-CN', input: status === 403 ? 'keyboard' : 'pointer', key: 'Enter', native: status === 409, position: 1, status, posts: 2, pngs: 1 });
  }
  for (const host of ['library', 'picker']) add({ group: 'base', kind: 'limit', host, width: host === 'library' ? 320 : 390, locale: host === 'library' ? 'zh-CN' : 'en', input: 'pointer', key: 'Enter', native: false, posts: 1, pngs: 1 });
  for (const status of [401, 403, 409]) for (const position of [0, 3]) add({ group: 'additional', kind: 'blocker', host: 'library', width: 390, locale: 'en', input: 'keyboard', key: 'Space', native: false, position, status, posts: position + 1, pngs: 0 });
  for (const [kind, posts] of [['initial-limit', 0], ['paused-limit', 2], ['twenty-new', 21], ['empty-cancel-drop', 1], ['other-owner', 1], ['identity-retired', 1], ['method-retired', 1], ['disposed', 1]]) {
    add({ group: 'additional', kind, host: 'library', width: 390, locale: 'en', input: 'pointer', key: 'Enter', native: false, posts, pngs: 0 });
  }
  return Object.freeze(cases);
}
const designed = uploadFeedbackCases();
const expected = group => {
  const rows = designed.filter(row => row.group === group);
  return { cases: rows.length, listings: rows.length, posts: rows.reduce((sum, row) => sum + row.posts, 0), pngs: rows.reduce((sum, row) => sum + row.pngs, 0) };
};

async function bounded(action, ms = caps.operationMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function observe(child) {
  return new Promise(done => {
    child.on('error', () => done({ failed: true })); // Permanent late-error sink.
    child.once('exit', (code, signal) => done({ failed: code !== 0 || signal !== null }));
  });
}
function releaseReferences(child) {
  if (!child) return;
  for (const stream of child.stdio || []) {
    stream?.on('error', () => {});
    stream?.removeAllListeners('data');
    stream?.destroy();
    stream?.unref?.();
  }
  child.unref(); // Keepalive release only; never evidence of process exit.
}
function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') fail('cleanup'); }
}
function groupExists(child) {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; fail('cleanup'); }
}
async function groupGone(child, ms) {
  const deadline = Date.now() + ms;
  while (groupExists(child)) {
    if (Date.now() >= deadline) return false;
    await delay(25); // Liveness cleanup, never browser action replay.
  }
  return true;
}
async function stopGroup(child, settled) {
  try {
    if (!child?.pid) { if (settled) await bounded(() => settled, 1000); return; }
    signalGroup(child, 'SIGTERM');
    if (!await groupGone(child, 1000)) {
      signalGroup(child, 'SIGKILL');
      need(await groupGone(child, 2000), 'cleanup');
    }
    await bounded(() => settled, 1000);
    need(!groupExists(child), 'cleanup');
  } finally { releaseReferences(child); }
}
async function stopChild(child, settled) {
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

const observePage = page => page.evaluate(() => window.uploadFeedback.observe());
const wait = (page, predicate, ...args) => page.waitForFunction(predicate, { timeout: caps.operationMs }, ...args);
const main = record => record.host === 'picker' ? 'dialog.media-dialog[open] .media-browser' : '[data-upload-host="main"] .media-browser';
const summary = record => `${main(record)} .media-upload-disclosure > summary`;
const input = record => `${main(record)} .upload-file-input`;
async function checkpoint(page) {
  await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(0);
  }));
}
async function pointer(page, selector) {
  await revealByWheel(page, selector);
  const point = await page.$eval(selector, node => {
    const box = node.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    return { x, y, valid: box.width > 0 && box.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && !node.matches(':disabled') && node.contains(document.elementFromPoint(x, y)) };
  });
  need(point.valid, 'geometry');
  await page.mouse.click(point.x, point.y); // Exactly one trusted pointer action.
}
async function tabTo(page, selector) {
  for (let ordinal = 0; ordinal <= caps.tabs; ordinal++) {
    if (await page.$eval(selector, node => node === document.activeElement)) return;
    need(ordinal < caps.tabs, 'input');
    await page.keyboard.press('Tab');
  }
}
async function toggle(page, record, open) {
  await checkpoint(page);
  const before = await observePage(page);
  need(before.open === !open, 'toggle');
  if (record.input === 'pointer') await pointer(page, summary(record));
  else {
    await tabTo(page, summary(record));
    await page.keyboard.press(record.key);
  }
  need(await page.$eval(summary(record), node => {
    const box = node.getBoundingClientRect();
    const minimum = document.documentElement.dataset.nativePlatform === 'android' ? 48 : 44;
    return box.height >= minimum && box.width >= minimum && !!node.textContent.trim();
  }), 'geometry');
  await wait(page, (open, before) => {
    const state = window.uploadFeedback.observe();
    return state.open === open && state.toggles === before.toggles + 1;
  }, open, before);
  await checkpoint(page);
  const after = await observePage(page);
  need(after.open === open && after.activations === before.activations + 1 && after.toggles === before.toggles + 1 && after.untrusted === 0, 'toggle');
}
async function choose(page, record, paths) {
  need((await observePage(page)).open === true && !(await observePage(page)).inputDisabled, 'input');
  const handle = await page.$(input(record));
  need(!!handle, 'input');
  try { await handle.uploadFile(...paths); }
  finally { await handle.dispose(); }
}
async function held(page, ordinal) {
  await wait(page, ordinal => window.uploadFeedback.observe().posts === ordinal && window.uploadFeedback.observe().held === 1, ordinal);
}
async function release(page, ordinal, status) {
  await page.evaluate((ordinal, status) => window.uploadFeedback.release(ordinal, status), ordinal, status);
}
async function idle(page) {
  await wait(page, () => { const state = window.uploadFeedback.observe(); return state.done === state.calls && state.held === 0 && !state.uploading && state.mutations === 0; });
  await checkpoint(page);
}
async function counts(page, value) {
  await wait(page, value => {
    const state = window.uploadFeedback.observe(), latest = state.latest;
    return latest && state.localized && Object.entries(value).every(([key, expected]) => latest[key] === expected);
  }, value);
  const state = await observePage(page);
  need(state.status && state.atomic && state.sibling && state.statusCount === 1 && state.duplicateLive === 0 && !state.validationDuplicate && state.progressNamed && state.localized && state.previousReminded, 'semantic');
  need(state.late === 0, 'retirement');
}
const batch = (total, uploaded, failed = 0, skipped = 0, paused = false, active = false, validation = false) => ({ total, uploaded, failed, skipped, completed: uploaded + failed, paused, active, validation });
async function same(page) { need(await page.evaluate(() => window.uploadFeedback.same()), 'identity'); }
async function visibleFeedback(page, record) {
  await revealByWheel(page, `${main(record)} .media-upload-feedback`);
  const valid = await page.$eval(`${main(record)} .media-upload-feedback`, node => {
    const r = node.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight, shown = !!node.textContent.trim();
    for (let parent = node; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
      shown &&= css.display !== 'none' && css.visibility === 'visible' && Number(css.opacity) !== 0 && !parent.hidden;
      if (parent === node) continue;
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.left + parent.clientWidth); }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.top + parent.clientHeight); }
    }
    return shown && r.width > 0 && r.height > 0 && r.left >= left - 1 && r.right <= right + 1 && r.top >= top - 1 && r.bottom <= bottom + 1
      && node.scrollWidth <= node.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
  });
  need(valid, 'geometry');
}
async function revealByWheel(page, selector) {
  // Real bounded scrolling only, never scrollIntoView/focus/style/scroll writes.
  for (let ordinal = 0; ordinal <= caps.wheels; ordinal++) {
    const state = await page.$eval(selector, node => {
      const box = node.getBoundingClientRect(), body = node.closest('.media-dialog-body') || document.scrollingElement;
      const clip = node.closest('.media-dialog-body')?.getBoundingClientRect();
      const top = Math.max(0, clip?.top ?? 0), bottom = Math.min(innerHeight, clip?.bottom ?? innerHeight);
      return { visible: box.top >= top && box.bottom <= bottom, direction: box.top < top ? -1 : 1,
        x: clip ? clip.left + 2 : innerWidth - 4, y: (top + bottom) / 2, scroll: body.scrollTop };
    });
    if (state.visible) return;
    need(ordinal < caps.wheels, 'geometry');
    await page.mouse.move(state.x, state.y);
    await page.mouse.wheel({ deltaY: state.direction * 140 });
    await checkpoint(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}
async function shot(page, record, stage, report) {
  need(['busy', 'terminal', 'reopened'].includes(stage), 'screenshot');
  await page.screenshot({ path: join(output, `case-${record.id}-${stage}.png`), fullPage: false });
  report.pngs++;
}
async function pickerBusy(page, record) {
  if (record.host !== 'picker') return;
  const before = await observePage(page);
  need(before.confirmationDisabled && before.cancelDisabled && before.modal && !before.fieldChanged && before.parentOriginal, 'busy');
  await page.keyboard.press('Escape');
  await checkpoint(page);
  const after = await observePage(page);
  need(after.modal && after.closes === 0 && after.publications === 0 && !after.fieldChanged && after.parentOriginal, 'busy');
}
async function blocker(page, record, files) {
  await choose(page, record, files.slice(0, 4));
  for (let index = 0; index < record.position; index++) {
    await held(page, index + 1); await release(page, index + 1, 201);
  }
  await held(page, record.position + 1);
  await toggle(page, record, false);
  await release(page, record.position + 1, record.status);
  await idle(page);
  await counts(page, batch(4, record.position, 1, 3 - record.position, true));
  const state = await observePage(page);
  need(state.posts === record.position + 1 && state.reauthentication === (record.status === 401), 'counts');
  await visibleFeedback(page, record); await same(page);
  await toggle(page, record, true); await same(page);
  need((await observePage(page)).rows === 4, 'counts');
  await toggle(page, record, false);
}

async function runCase(browser, record, script, css, files) {
  const page = await browser.newPage(), pending = new Set();
  const report = { id: record.id, group: record.group, kind: record.kind, host: record.host, width: record.width, locale: record.locale, input: record.input,
    status: 'failed', primary: null, secondary: [], listings: 0, posts: 0, pngs: 0, errors: 0, warnings: 0, resources: 0, unhandled: 0, drained: false };
  let stage = 'setup', overflow = false;
  const secondary = code => { if (report.secondary.length < caps.errors) report.secondary.push(code); else overflow = true; };
  const increment = key => { report[key] = Math.min(10001, report[key] + 1); if (report[key] > 10000) overflow = true; };
  const pageError = () => { increment('errors'); };
  const consoleError = message => { if (['warn', 'error'].includes(message.type())) increment('warnings'); };
  const interception = request => {
    if (pending.size >= 128) {
      overflow = true;
      // Saturation is a failure, not a reason to retain unbounded CDP promises.
      // Page/browser/group teardown cancels this unhandled resource request.
      secondary('resource');
      return;
    }
    const task = (async () => {
      if (request.isNavigationRequest() && request.url() === origin + '/') {
        await request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>' });
      } else if (/^(data:|blob:)/.test(request.url())) await request.continue();
      else { increment('resources'); await request.abort(); }
    })().catch(() => secondary('resource'));
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  page.on('pageerror', pageError); page.on('console', consoleError);
  page.setDefaultTimeout(caps.operationMs);
  try {
    await page.setViewport({ width: record.width, height: record.width === 320 ? 568 : 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    if (record.native) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
    await page.setRequestInterception(true); page.on('request', interception);
    stage = 'navigation'; await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
    await page.evaluate(record => window.uploadFeedback.start(record.host, record.locale, record.native), record);
    stage = 'ready';
    await wait(page, host => { const state = window.uploadFeedback.observe(); return state.listings === 1 && !state.loading && !state.inputDisabled && state.feedbackPresent && (host !== 'picker' || state.modal); }, record.host);
    const initial = await observePage(page);
    need(initial.feedbackEmpty && initial.shellHeight && initial.nativeInstalled === record.native && initial.owners === 1, 'feedback');
    if (record.host === 'picker') await pointer(page, `${main(record)} .media-card`);
    await toggle(page, record, true);
    need(await page.evaluate(() => window.uploadFeedback.remember()), 'identity');
    stage = 'feedback';
    if (record.kind === 'mixed') {
      await choose(page, record, files.slice(0, 3)); await held(page, 1);
      await counts(page, batch(3, 0, 0, 0, false, true));
      need((await observePage(page)).progressPresent && (await observePage(page)).inputDisabled && (await observePage(page)).mutations === 1, 'busy');
      await pickerBusy(page, record);
      await toggle(page, record, false); await same(page); await visibleFeedback(page, record);
      if (record.pngs) await shot(page, record, 'busy', report);
      await toggle(page, record, true); await same(page);
      await release(page, 1, 201); await held(page, 2);
      await counts(page, batch(3, 1, 0, 0, false, true));
      await release(page, 2, 422); await held(page, 3);
      await counts(page, batch(3, 1, 1, 0, false, true));
      await toggle(page, record, false); await release(page, 3, 201); await idle(page);
      await counts(page, batch(3, 2, 1)); await visibleFeedback(page, record); await same(page);
      if (record.pngs) await shot(page, record, 'terminal', report);
      await toggle(page, record, true); await same(page);
      const state = await observePage(page);
      need(state.rows === 3 && state.successRows === 2 && state.errorRows === 1 && !state.fieldChanged, 'counts');
      if (record.pngs) {
        await revealByWheel(page, `${main(record)} .upload-results`);
        await shot(page, record, 'reopened', report);
      }
      if (record.host === 'picker') {
        need(!state.confirmationDisabled && !state.cancelDisabled, 'busy');
        // Split terminal cancel/confirm among the existing cases; never remount.
        const confirm = record.locale === 'en';
        await pointer(page, confirm ? '.media-dialog .selection-footer > button' : '.media-dialog .card-heading > button');
        await wait(page, () => !window.uploadFeedback.observe().modal);
        const end = await observePage(page);
        need(end.closes === 1 && end.publications === (confirm ? 1 : 0) && end.fieldChanged === confirm
          && (confirm ? end.parentConfirmed : end.parentOriginal), 'busy');
      }
    } else if (record.kind === 'blocker') {
      await blocker(page, record, files);
      if (record.pngs) await shot(page, record, 'terminal', report);
    } else if (record.kind === 'limit' || record.kind === 'initial-limit' || record.kind === 'paused-limit') {
      if (record.kind === 'limit') {
        await choose(page, record, files.slice(0, 1)); await held(page, 1); await release(page, 1, 201); await idle(page);
      } else if (record.kind === 'paused-limit') {
        await choose(page, record, files.slice(0, 4)); await held(page, 1); await release(page, 1, 201);
        await held(page, 2); await release(page, 2, 403); await idle(page);
      }
      const before = await observePage(page);
      await choose(page, record, files); await idle(page);
      await counts(page, record.kind === 'paused-limit' ? batch(4, 1, 1, 2, true, false, true)
        : batch(record.kind === 'limit' ? 1 : 0, record.kind === 'limit' ? 1 : 0, 0, 0, false, false, true));
      need(await page.evaluate(() => window.uploadFeedback.validationMatches()), 'feedback');
      const after = await observePage(page);
      need(after.posts === before.posts && after.rows === before.rows && after.successRows === before.successRows && after.facts === before.facts && after.selectedOrdinal === before.selectedOrdinal && after.publications === 0, 'counts');
      await toggle(page, record, false); await visibleFeedback(page, record); await same(page);
      if (record.pngs) await shot(page, record, 'terminal', report);
      await toggle(page, record, true); await same(page);
    } else if (record.kind === 'twenty-new') {
      await choose(page, record, files.slice(0, 20));
      for (let ordinal = 1; ordinal <= 20; ordinal++) { await held(page, ordinal); await release(page, ordinal, 201); }
      await idle(page); await counts(page, batch(20, 20));
      await choose(page, record, files.slice(20)); await held(page, 21);
      await counts(page, batch(1, 0, 0, 0, false, true));
      await release(page, 21, 201); await idle(page); await counts(page, batch(1, 1));
      need((await observePage(page)).rows === 1, 'counts');
    } else if (record.kind === 'empty-cancel-drop') {
      await choose(page, record, []); await checkpoint(page);
      need((await observePage(page)).feedbackEmpty && (await observePage(page)).posts === 0, 'feedback');
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: caps.operationMs }),
        pointer(page, `${main(record)} .upload-actions > button`),
      ]);
      await chooser.cancel(); await checkpoint(page);
      need((await observePage(page)).feedbackEmpty && (await observePage(page)).posts === 0, 'feedback');
      await choose(page, record, files.slice(0, 1)); await held(page, 1);
      const before = await observePage(page);
      await page.evaluate(() => window.uploadFeedback.drop()); // Explicit synthetic disabled-drop edge, not pointer evidence.
      await checkpoint(page);
      const after = await observePage(page);
      need(after.posts === before.posts && after.events === before.events && after.uploading && after.mutations === 1, 'busy');
      await release(page, 1, 201); await idle(page); await counts(page, batch(1, 1));
    } else if (record.kind === 'other-owner') {
      await choose(page, record, files.slice(0, 1)); await held(page, 1);
      await page.evaluate(() => window.uploadFeedback.other());
      await wait(page, () => window.uploadFeedback.observe().otherCount === 1);
      const state = await observePage(page);
      need(state.otherEmpty && state.otherDisabled && state.otherProgressNamed && state.owners === 2 && state.listings === 1, 'feedback');
      await release(page, 1, 201); await idle(page); await counts(page, batch(1, 1));
      need((await observePage(page)).otherEmpty, 'feedback');
    } else if (['identity-retired', 'method-retired', 'disposed'].includes(record.kind)) {
      await choose(page, record, files.slice(0, 1)); await held(page, 1);
      if (record.kind === 'disposed') await page.evaluate(() => window.uploadFeedback.hide());
      else {
        if (record.kind === 'identity-retired') await page.evaluate(() => window.uploadFeedback.identityRoundtrip());
        else await page.evaluate(() => window.uploadFeedback.methodBoundary());
        await wait(page, () => window.uploadFeedback.observe().feedbackEmpty && window.uploadFeedback.observe().sessionA);
        need((await observePage(page)).sessionOidc === (record.kind === 'method-retired'), 'retirement');
      }
      const boundary = await observePage(page);
      await release(page, 1, 201); await idle(page);
      const after = await observePage(page);
      // Do not demand changes to legacy stale upload/store callbacks. Only the
      // new feedback channel must remain retired after an A/B/A or dispose.
      need(after.events === boundary.events && after.late === 0 && after.feedbackEmpty, 'retirement');
      need(record.kind !== 'disposed' || after.retired === 1, 'retirement');
    } else fail('matrix');
    stage = 'counts'; await idle(page);
    const end = await observePage(page);
    report.listings = end.listings; report.posts = end.posts; report.unhandled = end.unhandled;
    need(end.listings === 1 && end.posts === record.posts && end.unexpected === 0 && end.unhandled === 0 && report.pngs === record.pngs, 'counts');
    need(report.errors === 0 && report.warnings === 0 && report.resources === 0 && report.secondary.length === 0, 'semantic');
    report.status = 'passed';
  } catch (error) { report.primary = fixed(error, stage); }
  finally {
    try {
      const observed = await bounded(() => observePage(page), 1000);
      report.posts = observed.posts; report.listings = observed.listings; report.unhandled = observed.unhandled;
    } catch { secondary('cleanup'); }
    try {
      await bounded(() => page.evaluate(() => window.uploadFeedback?.drain()), 1500);
      const state = await bounded(() => observePage(page), 1000);
      report.drained = state.done === state.calls && state.mutations === 0 && !state.uploading && state.held === 0;
      need(report.drained, 'drain');
    } catch { secondary('drain'); }
    try { await bounded(() => page.evaluate(() => window.uploadFeedback?.dispose()), 1000); }
    catch { secondary('cleanup'); }
    try {
      await bounded(() => checkpoint(page), 1000);
      const final = await bounded(() => observePage(page), 1000);
      report.unhandled = final.unhandled;
      if (final.unhandled) secondary('unhandled');
      if (final.late || final.retired !== final.owners) secondary('retirement');
    } catch { secondary('cleanup'); }
    try { await bounded(() => page.evaluate(() => window.uploadFeedback?.forget()), 1000); }
    catch { secondary('cleanup'); }
    try { await bounded(() => page.close(), 1500); }
    catch { secondary('cleanup'); }
    try { await bounded(() => Promise.all([...pending]), 1000); }
    catch { secondary('cleanup'); }
    page.off('request', interception); page.off('pageerror', pageError); page.off('console', consoleError);
    if (report.errors) secondary('page');
    if (report.warnings) secondary('console');
    if (report.resources) secondary('resource');
    if (overflow) secondary('report');
    if (report.secondary.length) report.status = 'failed';
  }
  return report;
}

async function worker(base) {
  const report = { schema: 1, synthetic: true, base: expected('base'), additional: expected('additional'), status: 'failed', primary: null, secondary: [], records: [] };
  let chrome, settled, browser, stage = 'setup';
  try {
    await mkdir(output, { recursive: true });
    const files = Array.from({ length: 21 }, (_, index) => join(base, `fixture-${String(index).padStart(2, '0')}.png`));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==', 'base64');
    await Promise.all(files.map(path => writeFile(path, png)));
    stage = 'bundle'; const script = await bundleUploadFeedbackFixture();
    stage = 'css'; const css = await uploadFeedbackStyles();
    const executable = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
    need(!!executable, 'browser');
    const profile = join(base, 'browser'); await mkdir(profile);
    stage = 'browser';
    const args = puppeteer.defaultArgs({ headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] });
    chrome = spawn(executable, args, { stdio: 'ignore' }); settled = observe(chrome);
    let stopped = false; void settled.then(() => { stopped = true; });
    let port;
    const deadline = Date.now() + 10000;
    while (!port) {
      need(!stopped && Date.now() < deadline, 'browser');
      try {
        const first = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
        if (/^\d+$/.test(first)) port = first;
      } catch { /* Bounded startup readiness, never retry user input. */ }
      if (!port) await delay(50);
    }
    browser = await bounded(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }), 5000);
    for (const record of designed) {
      const result = await runCase(browser, record, script, css, files);
      report.records.push(result);
      // Independent semantic cases continue once each. No outcome is retried.
      if (result.secondary.includes('cleanup') || result.secondary.includes('drain')) break;
    }
    need(report.records.length === designed.length && report.records.every(row => row.status === 'passed'), 'matrix');
    report.status = 'passed';
  } catch (error) { report.primary = fixed(error, stage); }
  finally {
    if (browser) {
      try { await bounded(() => browser.close(), 2000); }
      catch { report.secondary.push('cleanup'); }
      finally { browser.disconnect(); }
    }
    try { await stopChild(chrome, settled); }
    catch { report.secondary.push('cleanup'); }
    if (report.secondary.length) report.status = 'failed';
    try {
      const text = JSON.stringify(report);
      need(Buffer.byteLength(text) <= caps.bytes, 'report');
      await writeFile(join(output, 'report.json'), text + '\n');
    } catch { report.secondary.push('report'); report.status = 'failed'; }
  }
  return report.status === 'passed';
}

// Parent has NO filesystem promises: every IO operation is in its own bounded,
// killable group. Only a fixed schema report (never raw errors/paths) crosses it.
const ioSource = `
import { mkdir, rm, open, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
const [op, output, base, capText] = process.argv.slice(1), cap = Number(capText);
try {
  if (!Number.isInteger(cap) || cap !== 196608) throw 0;
  if (op === 'create' || op === 'remove') {
    if (dirname(base) !== tmpdir() || !/^studio-upload-feedback-[a-f0-9]{32}$/.test(basename(base))) throw 0;
    if (op === 'create') await mkdir(base); else await rm(base, { recursive: true, force: true });
  } else if (op === 'init') {
    await mkdir(output, { recursive: true });
    for (const file of ['report.json', 'summary.json']) await rm(join(output, file), { force: true });
    for (let id = 0; id < 38; id++) for (const stage of ['busy', 'terminal', 'reopened']) await rm(join(output, 'case-' + id + '-' + stage + '.png'), { force: true });
  } else if (op === 'read') {
    const handle = await open(join(output, 'report.json'), 'r');
    let bytes;
    try {
      if ((await handle.stat()).size > cap) throw 0;
      const buffer = Buffer.alloc(cap + 1); let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > cap) throw 0;
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    await new Promise((yes, no) => process.stdout.write(bytes, error => error ? no(error) : yes()));
  } else if (op === 'summary') {
    let length = 0; const chunks = [];
    for await (const chunk of process.stdin) { length += chunk.length; if (length > cap) throw 0; chunks.push(chunk); }
    await writeFile(join(output, 'summary.json'), Buffer.concat(chunks));
  } else throw 0;
} catch { process.exitCode = 1; }
`;
async function parentIO(operation, base = '', text = '') {
  need(['init', 'create', 'remove', 'read', 'summary'].includes(operation) && Buffer.byteLength(text) <= caps.bytes, 'setup');
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
    const closed = new Promise(done => child.once('close', done));
    child.stdin.end(text);
    const result = await bounded(async () => { const result = await settled; await closed; return result; }, 4000);
    need(!result.failed && !overflow, 'report');
  } catch (error) { failure = new Error(fixed(error, 'report')); }
  finally {
    try { await stopGroup(child, settled); }
    catch { if (!failure) failure = new Error('cleanup'); failure.cleanupFailed = true; }
  }
  if (failure) throw failure;
  return Buffer.concat(chunks);
}
function validateReport(report) {
  need(report.schema === 1 && report.synthetic === true && Array.isArray(report.records) && report.records.length <= designed.length, 'report');
  need(report.secondary?.length <= caps.errors && report.secondary.every(code => codes.has(code)), 'report');
  need(report.primary === null || codes.has(report.primary), 'report');
  for (const [index, row] of report.records.entries()) {
    const design = designed[index];
    need(row.id === index && row.group === design.group && row.kind === design.kind && row.host === design.host && row.locale === design.locale && row.width === design.width && row.input === design.input, 'report');
    need(['passed', 'failed'].includes(row.status) && (row.primary === null || codes.has(row.primary)) && row.secondary.length <= caps.errors && row.secondary.every(code => codes.has(code)), 'report');
    for (const key of ['posts', 'listings', 'pngs', 'errors', 'warnings', 'resources', 'unhandled']) need(Number.isInteger(row[key]) && row[key] >= 0 && row[key] <= 10000, 'report');
    need(typeof row.drained === 'boolean', 'report');
    // No unrecognized field is copied into the parent's published summary.
    if (row.status === 'passed') need(row.primary === null && row.secondary.length === 0 && row.drained && row.posts === design.posts && row.listings === 1 && row.pngs === design.pngs && row.errors + row.warnings + row.resources + row.unhandled === 0, 'matrix');
  }
  return report.records.map(row => ({ id: row.id, group: row.group, kind: row.kind, host: row.host, width: row.width, locale: row.locale, input: row.input, status: row.status, primary: row.primary, secondary: row.secondary, posts: row.posts, listings: row.listings, pngs: row.pngs, drained: row.drained }));
}
export async function mainRunner() {
  const failures = [], secondary = [];
  let child, settled, owned = false, createAttempted = false, certain = true, records = [];
  const base = join(tmpdir(), `studio-upload-feedback-${randomBytes(16).toString('hex')}`);
  try {
    need(JSON.stringify(expected('base')) === JSON.stringify({ cases: 24, listings: 24, posts: 62, pngs: 32 })
      && JSON.stringify(expected('additional')) === JSON.stringify({ cases: 14, listings: 14, posts: 43, pngs: 0 }), 'matrix');
    await parentIO('init'); createAttempted = true; await parentIO('create', base); owned = true;
    child = spawn(process.execPath, [...process.execArgv, self, '--upload-feedback-worker', base], { cwd: studio, detached: true, stdio: 'ignore' });
    settled = observe(child);
    const result = await bounded(() => settled, caps.workerMs);
    const report = JSON.parse((await parentIO('read')).toString('utf8'));
    records = validateReport(report);
    secondary.push(...report.secondary);
    need(!result.failed && report.status === 'passed' && report.primary === null && records.length === designed.length && records.every(row => row.status === 'passed'), codes.has(report.primary) ? report.primary : 'matrix');
    for (const group of ['base', 'additional']) {
      const rows = records.filter(row => row.group === group), budget = expected(group);
      need(rows.length === budget.cases && rows.reduce((sum, row) => sum + row.posts, 0) === budget.posts
        && rows.reduce((sum, row) => sum + row.listings, 0) === budget.listings
        && rows.reduce((sum, row) => sum + row.pngs, 0) === budget.pngs, 'matrix');
    }
  } catch (error) {
    failures.push(new Error(fixed(error, 'worker')));
    if (error.cleanupFailed) certain = false;
  } finally {
    try { await stopGroup(child, settled); }
    catch { certain = false; secondary.push('cleanup'); }
    if (owned && certain) {
      try { await parentIO('remove', base); owned = false; }
      catch (error) { secondary.push('cleanup'); if (error.cleanupFailed) certain = false; }
    }
    const summary = { schema: 1, synthetic: true, status: failures.length || secondary.length ? 'failed' : 'passed',
      base: expected('base'), additional: expected('additional'), groupGone: certain, fixtureRetained: createAttempted && (owned || !certain || !child),
      primary: failures.length ? fixed(failures[0], 'worker') : null, secondary, records };
    try { await parentIO('summary', '', JSON.stringify(summary) + '\n'); }
    catch { secondary.push('report'); }
  }
  for (const code of secondary) failures.push(new Error(code));
  if (failures.length) throw new AggregateError(failures, 'matrix');
  console.log('PASS: upload feedback base=24 additional=14 PNG=32 listing=38 syntheticPOST=105 networkPOST=0; Chromium DOM evidence only.');
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    if (process.argv[2] === '--upload-feedback-worker') {
      const base = process.argv[3];
      need(!!base && dirname(base) === tmpdir() && /^studio-upload-feedback-[a-f0-9]{32}$/.test(base.slice(tmpdir().length + 1)), 'setup');
      process.exit(await worker(base) ? 0 : 1);
    } else await mainRunner();
  } catch (error) {
    console.error(`Upload feedback failed: ${fixed(error, 'worker')}`);
    process.exitCode = 1;
  }
}
