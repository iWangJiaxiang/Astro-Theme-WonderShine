import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import puppeteer from 'puppeteer-core';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const endpoints = ['content', 'languages', 'capabilities'];
const phases = ['transport', 'json'];
const section = '.language-versions';
const add = `${section} .language-version-bar > button`;
const manual = `${section} .language-version-create button.secondary`;
const ai = `${section} .language-version-create button.primary`;
const source = '.editor-page .markdown-source';
const save = '.editor-page .editor-save-actions .save-button-main';

// Observe actual function completion, including orphan request work after an
// InflightQuery invalidation. No API, component, watcher or async outcome is
// replaced. AST ranges avoid depending on the worker's implementation body.
function completionProbe(text, filename, names) {
  const tree = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [], found = new Set();
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      const name = node.name.text;
      assert.ok(node.body && node.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword), 'Completion probe requires a real async function');
      assert.ok(!found.has(name), 'Completion probe function must be unique');
      found.add(name);
      edits.push([node.body.getStart(tree) + 1, `\nconst __ownershipCompletion = globalThis.__ownershipTrace.begin(${JSON.stringify(name)}); try {\n`]);
      edits.push([node.body.end - 1, '\n} finally { globalThis.__ownershipTrace.end(__ownershipCompletion); }\n']);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(found.size, names.length, 'Completion probe must observe every requested production function');
  for (const [position, insertion] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, position) + insertion + text.slice(position);
  return text;
}

async function bundleFixture() {
  return build({
    stdin: { resolveDir: studio, loader: 'tsx', sourcefile: 'localized-content-ownership-fixture.tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import App from './src/App';
import LocalizedContentContext from './src/components/LocalizedContentContext';
import LanguageSwitcher from './src/components/LanguageSwitcher';
import { api, setApiTransport, session, pendingMutations } from './src/api';
import { setLocale, t } from './src/i18n';
setLocale('zh-CN');
const path = 'content/articles/ownership-fixture/index.md';
const otherPath = 'content/articles/ownership-fixture/other.md';
const translatedPath = 'content/articles/ownership-fixture/index.en.md';
const identity = () => ({ identity: { id: 'ownership-fixture', name: 'Synthetic editor', method: 'password' }, csrf: 'synthetic-csrf', expires: 9999999999 });
const row = (value = path, kind = 'article') => ({ path: value, title: 'Synthetic article', date: '2026-01-01', draft: false, kind, tags: [], categories: [] });
const languages = { defaultLanguage: 'zh-CN', languages: ['zh-CN', 'en'] };
const bootstrap = { site: {}, appearance: {}, mode: 'local', saveScope: 'ownership-fixture', saveCapabilities: { modes: ['local'], defaultMode: 'local' }, groups: [{ id: 'site', title: '站点信息' }] };
const settings = { id: 'site', title: '站点信息', description: '', file: 'config.toml', fields: [{ path: 'title', label: '标题', kind: 'text', default: '' }], values: { title: 'Synthetic site' }, revision: 'settings-r1' };
let unhandledRejections = 0;
window.addEventListener('unhandledrejection', () => { unhandledRejections++; });
const tokens = [];
globalThis.__ownershipTrace = {
  begin(kind) { const token = { kind, done: false }; tokens.push(token); return token; },
  end(token) { if (token.done) throw new Error('Duplicate synthetic completion'); token.done = true; },
};
const jobs = [], unexpected = [], opens = [], working = [];
let supplementalDone = false, supplementalCorrect = false;
let armed = null, mounted = true, initialSession;
let props = { path, kind: 'article', revision: 'document-r1', dirty: false, busy: false };
const classify = endpoint => endpoint === '/content' || endpoint === '/content?refresh=1' ? 'content'
  : endpoint === '/content-languages' ? 'languages' : endpoint === '/translation/config' ? 'capabilities'
  : endpoint === '/translation/manual' ? 'manual' : endpoint === '/translation' ? 'ai'
  : endpoint.startsWith('/document?path=') ? 'document' : endpoint === '/document' ? 'save'
  : endpoint === '/auth/session' ? 'auth' : endpoint === '/bootstrap' ? 'bootstrap'
  : endpoint === '/content-preview' ? 'preview' : endpoint === '/settings/site' ? 'settings'
  : endpoint.startsWith('/settings/taxonomies?language=') ? 'taxonomy' : 'unexpected';
const dataFor = (job, stale = false) => job.kind === 'content' ? (stale ? [row(), row(translatedPath), row(translatedPath, 'page')] : [row()])
  : job.kind === 'languages' ? (stale ? { defaultLanguage: 'zh-CN', languages: ['zh-CN'] } : languages)
  : job.kind === 'capabilities' ? { enabled: !stale, model: 'synthetic-model' }
  : job.kind === 'auth' ? identity() : job.kind === 'bootstrap' ? bootstrap : job.kind === 'preview' ? null
  : job.kind === 'settings' ? settings
  : job.kind === 'taxonomy' ? { id: 'taxonomies', title: '分类', fields: [], values: { 'post.tags': [], 'post.categories': [] }, revision: 'taxonomy-r1' }
  : job.kind === 'document' ? { path: job.endpoint.includes(encodeURIComponent(translatedPath)) ? translatedPath : path, text: 'Synthetic file', metadata: { title: job.endpoint.includes(encodeURIComponent(translatedPath)) ? 'Synthetic translation' : 'Synthetic article', draft: false }, body: 'Synthetic saved body', revision: 'document-r1' }
  : job.kind === 'save' ? { revision: 'document-r2', message: 'Synthetic saved' }
  : { path: translatedPath, revision: 'translation-r1' };
function release(id, options = {}) {
  const job = jobs[id - 1];
  if (!job || job.released) throw new Error('Missing synthetic held transport');
  job.released = true;
  if (options.timeout) { job.reject(new DOMException('Synthetic transport timeout', 'TimeoutError')); return; }
  const status = options.status || 200;
  const response = Response.json(status === 200 ? dataFor(job, !!options.stale) : { error: options.conflict ? 'Synthetic translation conflict' : 'Synthetic current read failure', revision: 'do-not-adopt' }, { status });
  const decode = response.json.bind(response);
  response.json = () => {
    job.jsonStarted = true;
    if (!options.holdJSON) { job.jsonReleased = true; return decode(); }
    return new Promise((resolve, reject) => { job.decode = () => { job.jsonReleased = true; decode().then(resolve, reject); }; });
  };
  job.resolve(response);
}
setApiTransport((endpoint, init) => {
  const kind = classify(endpoint);
  if (kind === 'unexpected') unexpected.push(kind);
  if (jobs.length >= 150) throw new Error('Synthetic request bound exceeded');
  return new Promise((resolve, reject) => {
    const job = { id: jobs.length + 1, endpoint, kind, method: init.method, language: new Headers(init.headers).get('Accept-Language'), refresh: endpoint.includes('refresh=1'), body: init.body ? JSON.parse(String(init.body)) : null, released: false, jsonStarted: false, jsonReleased: false, resolve, reject };
    job.requestToken = tokens.filter(token => token.kind === 'request' && !token.done).at(-1);
    jobs.push(job);
    if (kind !== armed && !['manual', 'ai', 'save'].includes(kind)) release(job.id);
  }); // Intentionally ignores abort; production ownership must reject stale work.
});
document.cookie = 'studio-autosave=0; Path=/; SameSite=Strict';
const documentKey = 'studio-draft:password:ownership-fixture:' + path;
localStorage.removeItem(documentKey);
const root = createRoot(document.getElementById('root'));
const direct = window.ownershipMode === 'direct-child';
function render() {
  root.render(direct ? <><LanguageSwitcher /><LocalizedContentContext {...props} onOpen={(...args) => opens.push(args)} onWorking={value => working.push(value)} /></> : <App />);
}
window.ownership = {
  start(target = null) { armed = target; if (direct) { session.value = identity(); initialSession = session.value; } render(); },
  arm(target) { armed = target; },
  observe() {
    return { jobs: jobs.map(({ id, kind, method, language, refresh, released, jsonStarted, jsonReleased, requestToken }) => ({ id, kind, method, language, refresh, released, jsonStarted, jsonReleased, requestDone: !!requestToken?.done })),
      tokens: tokens.map(({ kind, done }) => ({ kind, done })), opens: opens.length, working: [...working], pendingMutations: pendingMutations.value, unexpected: unexpected.length, unhandledRejections, supplementalDone, supplementalCorrect };
  },
  ordinaryContent() {
    if (!direct) throw new Error('Supplemental reader is direct-child only');
    void api('/content').then(value => { supplementalCorrect = Array.isArray(value) && value.length === 1 && value[0].path === path; }, () => {}).finally(() => { supplementalDone = true; });
  },
  release,
  decode(id) { const job = jobs[id - 1]; if (!job?.decode || job.jsonReleased) throw new Error('Missing synthetic held JSON'); job.decode(); },
  event(kind) {
    if (!direct && kind !== 'unmount' && kind !== 'logout') throw new Error('Prop boundary is direct-child only');
    if (kind === 'path') { props = { ...props, path: otherPath }; flushSync(render); }
    else if (kind === 'kind') { props = { ...props, kind: 'page' }; flushSync(render); }
    else if (kind === 'revision') { props = { ...props, revision: 'document-r2' }; flushSync(render); }
    else if (kind === 'path-return') { props = { ...props, path }; flushSync(render); }
    else if (kind === 'kind-return') { props = { ...props, kind: 'article' }; flushSync(render); }
    else if (kind === 'dirty') { props = { ...props, dirty: true }; flushSync(render); }
    else if (kind === 'busy') { props = { ...props, dirty: false, busy: true }; flushSync(render); }
    else if (kind === 'handlers') { props = { ...props, dirty: false, busy: false }; flushSync(render); }
    else if (kind === 'session') session.value = identity();
    else if (kind === 'session-return') session.value = initialSession;
    else if (kind === 'fields-return') { session.value.identity.id = 'ownership-fixture'; session.value.identity.method = 'password'; session.value.csrf = 'synthetic-csrf'; session.value.expires = 9999999999; }
    else if (kind === 'id') session.value.identity.id = 'ownership-fixture-next';
    else if (kind === 'method') session.value.identity.method = 'oidc';
    else if (kind === 'csrf') session.value.csrf = 'synthetic-csrf-next';
    else if (kind === 'expires') session.value.expires++;
    else if (kind === 'logout') session.value = null;
    else if (kind === 'unmount') { if (mounted) { mounted = false; flushSync(() => root.unmount()); } }
    else throw new Error('Unknown synthetic event');
  },
  matchesMutation(kind) {
    const writes = jobs.filter(job => job.kind === kind);
    return writes.length === 1 && JSON.stringify(writes[0].body) === JSON.stringify({ path, revision: 'document-r1', language: 'en' });
  },
  rememberEditor() {
    window.ownershipNodes = ['.editor-page', '.markdown-source', '.title-field input', '.editor-save-actions .save-button-main', '.language-versions'].map(selector => document.querySelector(selector));
    return window.ownershipNodes.every(Boolean);
  },
  sameEditor() { return ['.editor-page', '.markdown-source', '.title-field input', '.editor-save-actions .save-button-main', '.language-versions'].every((selector, index) => window.ownershipNodes[index]?.isConnected && document.querySelector(selector) === window.ownershipNodes[index]); },
  rememberDraft() { window.ownershipDraft = localStorage.getItem(documentKey); return !!window.ownershipDraft; },
  draftIntact() {
    const raw = localStorage.getItem(documentKey), draft = JSON.parse(raw || 'null');
    return raw === window.ownershipDraft && draft?.body === 'Synthetic saved body dirty' && draft.originalBody === 'Synthetic saved body' && draft.revision === 'document-r1' && draft.values.title === 'Synthetic article' && draft.baseline.title === 'Synthetic article';
  },
  flushDraft() { window.dispatchEvent(new Event('pagehide')); },
  hasReadError(timeout = false) { return document.querySelector('.language-versions')?.textContent.includes(t(timeout ? '连接超时，请重试。' : 'Synthetic current read failure')); },
  hasConflict() { return document.querySelector('.language-versions')?.textContent.includes('Synthetic translation conflict'); },
  hasChoicesScopeError() {
    const alerts = [...document.querySelectorAll('.editor-aside [role="alert"]')];
    return alerts.length === 1 && alerts[0].textContent.includes(t('选项载入失败：')) && alerts[0].textContent.includes(t('连接已更换，请重试'));
  },
  openedCorrectly() { return opens.length === 1 && opens[0][0] === translatedPath; },
  cleanup() {
    armed = null;
    if (mounted) { mounted = false; flushSync(() => root.unmount()); }
    for (const job of jobs) if (!job.released) release(job.id, { stale: true });
    for (const job of jobs) if (job.decode && !job.jsonReleased) job.decode();
  },
};
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    loader: { '.css': 'empty' },
    plugins: [fixtureAssetPlugin(), {
      name: 'localized-ownership-real-source-observers-and-app-isolation',
      setup(builder) {
        builder.onLoad({ filter: /\/src\/(?:api\.ts|components\/(?:LocalizedContentContext|DocumentEditor)\.tsx)$/ }, async args => ({
          loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
          contents: completionProbe(await readFile(args.path, 'utf8'), args.path,
            args.path.endsWith('/api.ts') ? ['api', 'request'] : args.path.endsWith('/DocumentEditor.tsx') ? ['loadChoices'] : ['load', 'translate']),
        }));
        const isolated = new Set([
          './components/LoginView', './components/ContentLibrary', './components/ThreadComposer',
          './components/ThreadDetail', './components/LocalizedContentLibrary', './components/SettingsView',
          './components/MediaLibrary', './components/GettingStarted',
          '../platform/LegacyRecovery', '../platform/NativeAiSettings', '../platform/WorkspacePanel',
        ]);
        builder.onResolve({ filter: /(?:components\/|platform\/)/ }, args => {
          if (args.importer.endsWith('/src/App.tsx') && isolated.has(args.path)) return { path: args.path, namespace: 'ownership-unrelated-child' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'ownership-unrelated-child' }, () => ({
          loader: 'tsx', contents: `import React from 'react'; const Child = React.forwardRef(() => null); export default Child; export { Child as LegacyRecovery, Child as NativeAiSettings, Child as WorkspacePanel };`,
        }));
        builder.onResolve({ filter: /^vditor$/ }, () => ({ path: 'vditor', namespace: 'ownership-unused-rich' }));
        builder.onLoad({ filter: /.*/, namespace: 'ownership-unused-rich' }, () => ({ loader: 'js', contents: 'export default class UnusedRichEditor { constructor() { throw new Error("Source-mode fixture must not instantiate Vditor"); } }' }));
      },
    }],
  });
}

// Every scenario gets a fresh realm. These helpers expose only bounded synthetic
// categories/booleans, never DOM dumps, content, paths, request bodies or errors.
async function inRealm(browser, bundle, mode, target, scenario) {
  const page = await browser.newPage();
  let pageErrors = 0, started = false, scenarioFailed = false, scenarioFailure;
  const cleanupFailures = [];
  page.on('pageerror', () => pageErrors++);
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => request.isNavigationRequest()
      ? request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
      : request.abort());
    await page.goto('https://localized-ownership.example');
    await page.evaluate(mode => { window.ownershipMode = mode; }, mode);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(target => window.ownership.start(target), target);
    started = true;
    await scenario(page);
    assert.equal(pageErrors, 0, 'No uncaught browser exceptions');
    assert.equal((await observe(page)).unexpected, 0, 'Only declared synthetic routes are used');
  } catch (error) {
    scenarioFailed = true;
    scenarioFailure = error;
  } finally {
    if (started) {
      try {
        await page.evaluate(() => window.ownership.cleanup());
        await page.waitForFunction(() => {
          const state = window.ownership.observe();
          return state.tokens.every(token => token.done) && state.pendingMutations === 0 && state.jobs.every(job => job.released && (!job.jsonStarted || job.jsonReleased));
        });
      } catch { cleanupFailures.push('unmount-drain'); }
      try {
        // A task checkpoint lets the browser deliver unhandledrejection after
        // tracked continuations drain; it does not replace completion counters.
        await page.evaluate(() => new Promise(resolve => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
          channel.port2.postMessage(null);
        }));
        assert.equal((await observe(page)).unhandledRejections, 0, 'No late unhandled promise rejection is hidden by realm closure');
        assert.equal(pageErrors, 0, 'Cleanup also observes orphan rejections');
      } catch { cleanupFailures.push('checkpoint'); }
    }
    try { await page.close(); } catch { cleanupFailures.push('close'); }
  }
  if (cleanupFailures.length) console.error(JSON.stringify({ cleanupFailed: true, cleanupFailureCount: cleanupFailures.length, stages: cleanupFailures }));
  if (scenarioFailed) throw scenarioFailure;
  if (cleanupFailures.length) throw new Error(`Ownership cleanup failed: ${cleanupFailures[0]}`);
}
const observe = page => page.evaluate(() => window.ownership.observe());
const event = (page, kind) => page.evaluate(kind => window.ownership.event(kind), kind);
const arm = (page, kind) => page.evaluate(kind => window.ownership.arm(kind), kind);
const release = (page, id, options = {}) => page.evaluate((id, options) => window.ownership.release(id, options), id, options);
const decode = (page, id) => page.evaluate(id => window.ownership.decode(id), id);
async function held(page, kind, ordinal) {
  await page.waitForFunction((kind, ordinal) => window.ownership.observe().jobs.filter(job => job.kind === kind).length >= ordinal, {}, kind, ordinal);
  const jobs = (await observe(page)).jobs.filter(job => job.kind === kind);
  assert.equal(jobs.length, ordinal, 'Held transport count matches its expected ordinal');
  return jobs[ordinal - 1];
}
async function atBoundary(page, job, phase, options = {}) {
  if (phase === 'json') {
    await release(page, job.id, { ...options, holdJSON: true });
    await page.waitForFunction(id => window.ownership.observe().jobs[id - 1].jsonStarted, {}, job.id);
  }
}
async function finishBoundary(page, job, phase, options = {}) {
  if (phase === 'json') await decode(page, job.id);
  else await release(page, job.id, options);
  await page.waitForFunction(id => window.ownership.observe().jobs[id - 1].requestDone, {}, job.id);
}
async function done(page, kind, count) {
  await page.waitForFunction((kind, count) => window.ownership.observe().tokens.filter(token => token.kind === kind && token.done).length >= count, {}, kind, count);
  assert.equal((await observe(page)).tokens.filter(token => token.kind === kind && token.done).length, count, 'Completed production function count matches its expected count');
}
async function idle(page) {
  await page.waitForFunction(() => window.ownership.observe().tokens.every(token => token.done) && window.ownership.observe().pendingMutations === 0);
}
async function locale(page, language) {
  await page.select('.language-switcher select', language);
  await page.waitForFunction(language => document.documentElement.lang === language, {}, language);
}
async function ready(page) {
  await page.waitForSelector(`${section} .language-version-tabs`);
  assert.equal(await page.$(`${section} .loading-panel`), null, 'Current generation has finished loading');
}
async function latestUI(page) {
  await ready(page);
  assert.equal(await page.$eval(`${section} .language-version-tabs`, node => node.textContent.trim()), 'zh-CN', 'Stale content/language responses cannot add or remove current language tabs');
  assert.equal(await page.$(`${section} [role="alert"]`), null, 'Stale errors cannot replace current success');
  if (!await page.$(`${section} .language-version-create`)) await page.click(add);
  assert.equal(await page.$eval(`${section} .language-version-create select`, node => node.value), 'en', 'Current configured target language remains available');
  assert.equal(await page.$eval(ai, node => node.disabled), false, 'Stale capabilities cannot disable the current AI action');
}
async function openRealEditorSource(page, target = null) {
  await page.waitForSelector('.home-grid .content-row');
  await idle(page); // Finish App's home /content before any child can share it.
  const home = (await observe(page)).jobs.filter(job => job.kind === 'content');
  assert.equal(home.length, 1, 'One completed startup content transport');
  assert.equal(home[0].jsonReleased, true, 'Startup JSON is not a held child read');
  const before = await observe(page);
  await arm(page, target); // Never hold App's startup/home content transport.
  await page.click('.home-grid .content-row');
  await page.waitForSelector(source);
  await page.waitForSelector(section);
  assert.equal(await page.$eval(source, node => node.value === 'Synthetic saved body'), true, 'Real document API populates the source editor');
  assert.equal(await page.evaluate(() => window.ownership.rememberEditor()), true);
  return before;
}
async function openRealEditor(page) {
  await openRealEditorSource(page);
  await ready(page);
  await page.waitForSelector('.editor-aside button[name="extra.topics"]:enabled');
  await idle(page);
  const state = await observe(page);
  assert.ok(state.jobs.filter(job => job.kind === 'content').length >= 2, 'Child reads occur after completed startup content; overlapping choices/context calls may share pending transport');
  assert.equal(state.jobs.filter(job => job.kind === 'capabilities').length, 1, 'Exactly one initial language-context group, independently of shared content transport');
  assert.equal(await page.$eval(source, node => node.value === 'Synthetic saved body'), true, 'Real document API populates the source editor');
  assert.equal(await page.evaluate(() => window.ownership.rememberEditor()), true);
}

export async function checkLocalizedContentOwnership(browser) {
  const bundle = await bundleFixture();
  const designedCases = [];

  // Real App + real DocumentEditor: dirty state, backup baseline/revision and DOM
  // identity must survive loaded locale switches without *any* new read/write.
  designedCases.push('real-App: loaded dirty source editor, exact draft/baseline/revision, save controls and mounted nodes across locale roundtrip, no GET');
  await inRealm(browser, bundle, 'real-App', null, async page => {
    await openRealEditor(page);
    assert.equal(await page.$eval(save, node => node.disabled), true);
    await page.click(source);
    await page.keyboard.press('End');
    await page.type(source, ' dirty');
    await page.evaluate(() => window.ownership.flushDraft());
    assert.equal(await page.evaluate(() => window.ownership.rememberDraft()), true);
    assert.equal(await page.evaluate(() => window.ownership.draftIntact()), true);
    const before = (await observe(page)).jobs;
    for (const language of ['en', 'zh-CN']) {
      await locale(page, language);
      assert.equal(await page.evaluate(() => window.ownership.sameEditor()), true, 'Real App keeps the editor and controls mounted');
      await page.evaluate(() => window.ownership.flushDraft());
      assert.equal(await page.evaluate(() => window.ownership.draftIntact()), true, 'Locale cannot rebase the dirty document backup');
      assert.equal(await page.$eval(source, node => node.value === 'Synthetic saved body dirty'), true);
      assert.equal(await page.$eval(save, node => node.disabled), false, 'Dirty document save remains enabled');
      assert.equal(await page.$eval(add, node => node.disabled), true, 'Dirty document cannot create a translation');
      assert.deepEqual((await observe(page)).jobs, before, 'Loaded locale change issues no GET or mutation');
      assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true, 'App still receives the real child dirty notification');
    }
  });

  for (const endpoint of endpoints) for (const phase of phases) {
    designedCases.push(`real-App: pending child ${endpoint} ${phase}, dirty source/draft identity through locale roundtrip, drained stale handlers cannot clear current loading/error/data; choices scope errors remain separate`);
    await inRealm(browser, bundle, 'real-App', null, async page => {
      const home = await openRealEditorSource(page, endpoint);
      const loadBase = home.tokens.filter(token => token.kind === 'load').length;
      const choicesBase = home.tokens.filter(token => token.kind === 'loadChoices').length;
      await page.waitForFunction(count => window.ownership.observe().tokens.filter(token => token.kind === 'load').length >= count, {}, loadBase + 1);
      const initial = await observe(page);
      assert.equal(initial.tokens.filter(token => token.kind === 'load').length, loadBase + 1, 'One initial child load after completed home work');
      // Choices and context may share /content, but /content-languages has two
      // real callers. Hold/drain every initial target transport, not fake groups.
      const oldJobs = initial.jobs.filter(job => job.kind === endpoint && job.id > home.jobs.length);
      assert.ok(oldJobs.length > 0, 'At least one pending child target transport');
      for (const job of oldJobs) await atBoundary(page, job, phase, { stale: true });
      if (endpoint === 'capabilities') await done(page, 'loadChoices', choicesBase + 1);
      await page.click(source);
      await page.keyboard.press('End');
      await page.type(source, ' dirty');
      await page.evaluate(() => window.ownership.flushDraft());
      assert.equal(await page.evaluate(() => window.ownership.rememberDraft()), true);
      assert.equal(await page.evaluate(() => window.ownership.draftIntact()), true);
      const first = await observe(page);
      assert.equal(first.tokens.filter(token => token.kind === 'load').length, loadBase + 1, 'Dirty notification does not replace the pending child read');
      assert.equal(first.tokens.filter(token => token.kind === 'load' && token.done).length, loadBase, 'Initial child group remains held while editing');
      const firstTokens = first.tokens.flatMap((token, index) => token.done ? [] : [index]);
      const initialTargetCount = first.jobs.filter(job => job.kind === endpoint).length;
      const checkDirtyEditor = async () => {
        assert.equal(await page.evaluate(() => window.ownership.sameEditor()), true, 'Pending locale replacement preserves actual editor nodes');
        assert.equal(await page.$eval(source, node => node.value === 'Synthetic saved body dirty'), true);
        assert.equal(await page.$eval(save, node => node.disabled), false, 'Dirty source remains saveable while language context is pending');
        await page.evaluate(() => window.ownership.flushDraft());
        assert.equal(await page.evaluate(() => window.ownership.draftIntact()), true, 'Current editor still backs up its original baseline/revision');
        assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true, 'Real App retains the child dirty notification');
      };
      const checkChoices = async () => {
        // These are deliberately NOT language-child errors: loadChoices has no
        // locale replacement. Its known scope rejection is asserted, not hidden,
        // retried, or turned into a readiness requirement for the child fixture.
        if (endpoint === 'capabilities') assert.equal(await page.$('.editor-aside [role="alert"]'), null, 'Completed choices are unaffected by held capabilities');
        else assert.equal(await page.evaluate(() => window.ownership.hasChoicesScopeError()), true, 'Existing choices scope error remains separately visible');
        assert.equal(await page.$('.editor-page > [role="alert"]'), null, 'Language reads do not become a document load/save error');
      };
      await locale(page, 'en');
      const replacement = await held(page, endpoint, initialTargetCount + 1);
      await atBoundary(page, replacement, phase, { status: 502 });
      for (const job of oldJobs) await finishBoundary(page, job, phase, { stale: true });
      await page.waitForFunction(indices => {
        const state = window.ownership.observe();
        return indices.every(index => state.tokens[index].done);
      }, {}, firstTokens);
      await done(page, 'load', loadBase + 1);
      await done(page, 'loadChoices', choicesBase + 1);
      assert.notEqual(await page.$(`${section} .loading-panel`), null, 'Drained initial finally cannot clear the pending real-App replacement');
      assert.equal(await page.$(`${section} [role="alert"]`), null, 'Old language results cannot publish errors');
      await checkDirtyEditor();
      await checkChoices();
      const second = await observe(page);
      const secondTokens = second.tokens.flatMap((token, index) => token.done ? [] : [index]);
      await locale(page, 'zh-CN');
      const current = await held(page, endpoint, initialTargetCount + 2);
      await finishBoundary(page, replacement, phase, { status: 502 });
      await page.waitForFunction(indices => {
        const state = window.ownership.observe();
        return indices.every(index => state.tokens[index].done);
      }, {}, secondTokens);
      await done(page, 'load', loadBase + 2);
      assert.notEqual(await page.$(`${section} .loading-panel`), null, 'Drained replacement finally cannot clear roundtrip loading');
      assert.equal(await page.$(`${section} [role="alert"]`), null, 'Stale failure cannot poison the real-App current child');
      await checkDirtyEditor();
      await release(page, current.id);
      await done(page, 'load', loadBase + 3);
      await idle(page);
      await ready(page);
      await checkDirtyEditor();
      await checkChoices();
      assert.equal(await page.$(`${section} [role="alert"]`), null);
      assert.equal(await page.$eval(add, node => node.disabled), true, 'Loaded child still blocks translation for the preserved dirty source');
      const settled = await observe(page);
      assert.equal(settled.jobs.filter(job => job.kind === 'document').length, 1, 'Locale roundtrip never reloads or navigates the document');
      assert.equal(settled.jobs.filter(job => ['save', 'manual', 'ai'].includes(job.kind)).length, 0, 'Editing and locale never save or translate implicitly');
      // Only after proving dirty preservation, explicitly revert via normal input
      // so the unchanged latestUI checks can exercise enabled language actions.
      await page.click(source);
      await page.keyboard.press('Control+a');
      await page.type(source, 'Synthetic saved body');
      await page.waitForFunction(selector => document.querySelector(selector)?.disabled === true, {}, save);
      await latestUI(page);
      assert.equal(await page.evaluate(() => window.ownership.sameEditor()), true);
      assert.deepEqual((await observe(page)).jobs, settled.jobs, 'Explicit source revert and language controls do not refetch or mutate');
    });
  }

  for (const kind of ['manual', 'ai']) {
    for (const outcome of ['success', 'conflict']) {
      designedCases.push(`real-App: ${kind} POST ${outcome} once, busy/identity across locale, original revision and ${outcome === 'success' ? 'one translated document open' : 'persistent conflict without reads/replay'}`);
      await inRealm(browser, bundle, 'real-App', null, async page => {
        await openRealEditor(page);
        await page.click(add);
        await page.click(kind === 'manual' ? manual : ai);
        const post = await held(page, kind, 1);
        await page.waitForFunction(() => window.ownership.observe().pendingMutations === 1);
        const before = (await observe(page)).jobs;
        for (const language of ['en', 'zh-CN']) {
          await locale(page, language);
          assert.equal(await page.evaluate(() => window.ownership.sameEditor()), true);
          assert.equal(await page.$eval(manual, node => node.disabled), true, 'Pending translation stays busy across locale');
          assert.equal(await page.$eval(ai, node => node.disabled), true);
          assert.equal(await page.$eval('.editor-save-actions button.danger', node => node.disabled), true, 'Real DocumentEditor receives translation working state');
          assert.deepEqual((await observe(page)).jobs, before, 'Locale never replays a POST or starts a loaded GET');
        }
        assert.equal(await page.evaluate(kind => window.ownership.matchesMutation(kind), kind), true, 'POST uses the original saved revision and selected target exactly once');
        await release(page, post.id, outcome === 'conflict' ? { status: 409, conflict: true } : {});
        await done(page, 'translate', 1);
        await idle(page);
        if (outcome === 'success') {
          await page.waitForFunction(() => document.querySelector('.title-field input')?.value === 'Synthetic translation');
          assert.equal(await page.evaluate(() => window.ownership.sameEditor()), false, 'Successful translation opens a new real DocumentEditor');
          const documents = (await observe(page)).jobs.filter(job => job.kind === 'document');
          assert.equal(documents.length, 2, 'One original document read and exactly one translated document read');
        } else {
          assert.equal(await page.evaluate(() => window.ownership.hasConflict()), true, 'Current HTTP 409 is visible');
          assert.equal(await page.evaluate(() => window.ownership.sameEditor()), true, 'Conflict cannot navigate or rebase the editor');
          assert.equal(await page.$eval(source, node => node.value === 'Synthetic saved body'), true);
          assert.equal(await page.$eval('.editor-save-actions button.danger', node => node.disabled), false, 'Conflict clears working state');
          const failed = (await observe(page)).jobs;
          await locale(page, 'en');
          assert.equal(await page.evaluate(() => window.ownership.hasConflict()), true, 'Translation conflict persists on locale change');
          assert.deepEqual((await observe(page)).jobs, failed, 'Conflict is not retried or refetched automatically');
        }
        assert.equal((await observe(page)).jobs.filter(job => job.kind === kind).length, 1);
      });
    }
  }

  // Supplemental direct-child scheduling: actual component/API/InflightQuery/
  // reactivity, not App navigation or authentication acceptance. Sole caller of
  // each GET here makes handler ownership observable without App/choices noise.
  for (const endpoint of endpoints) for (const phase of phases) {
    designedCases.push(`direct-child: ${endpoint} ${phase}, zh-CN/en/zh-CN latest-wins, old finally cannot clear newer loading, stale success/error settle explicitly`);
    await inRealm(browser, bundle, 'direct-child', endpoint, async page => {
      const first = await held(page, endpoint, 1);
      await atBoundary(page, first, phase, { stale: true });
      await locale(page, 'en');
      const second = await held(page, endpoint, 2);
      await atBoundary(page, second, phase, { status: 502 });
      await finishBoundary(page, first, phase, { stale: true });
      await done(page, 'load', 1);
      assert.notEqual(await page.$(`${section} .loading-panel`), null, 'Old finally must not clear the replacement loading state');
      assert.equal(await page.$(`${section} [role="alert"]`), null);
      await locale(page, 'zh-CN');
      const third = await held(page, endpoint, 3);
      await finishBoundary(page, second, phase, { status: 502 });
      await done(page, 'load', 2);
      assert.notEqual(await page.$(`${section} .loading-panel`), null, 'Roundtrip replacement still owns loading');
      assert.equal(await page.$(`${section} [role="alert"]`), null, 'Stale HTTP error cannot surface in the new generation');
      await release(page, third.id);
      await done(page, 'load', 3);
      await idle(page);
      await latestUI(page);
      assert.equal((await observe(page)).opens, 0);
    });

    designedCases.push(`direct-child: ${endpoint} ${phase}, forced manual load retry retains refresh=1 across locale, revision supersedes pending retry`);
    await inRealm(browser, bundle, 'direct-child', endpoint, async page => {
      const initial = await held(page, endpoint, 1);
      await release(page, initial.id, { status: 502 });
      await done(page, 'load', 1);
      await idle(page);
      assert.equal(await page.evaluate(() => window.ownership.hasReadError()), true);
      await page.click(`${section} [role="alert"] button`);
      const forced = await held(page, endpoint, 2);
      await atBoundary(page, forced, phase, { stale: true });
      await locale(page, 'en');
      const replacement = await held(page, endpoint, 3);
      await atBoundary(page, replacement, phase, { status: 502 });
      if (endpoint === 'content') await page.waitForFunction(() => window.ownership.observe().tokens.filter(token => token.kind === 'load' && token.done).length >= 2);
      const contentJobs = (await observe(page)).jobs.filter(job => job.kind === 'content');
      assert.equal(contentJobs.length, 3, 'One content transport per load, including forced locale replacement');
      assert.deepEqual(contentJobs.map(job => job.refresh), [false, true, true], 'Locale replacement preserves the explicit refresh obligation');
      await finishBoundary(page, forced, phase, { stale: true });
      await done(page, 'load', 2);
      assert.notEqual(await page.$(`${section} .loading-panel`), null);
      await event(page, 'revision');
      // The pending forced obligation survives revision replacement too. A
      // forced content read invalidates the previous pending InflightQuery.
      const revisionJob = await held(page, endpoint, 4);
      await finishBoundary(page, replacement, phase, { status: 502 });
      // Within the same API scope, obsolete /content readers follow the newest
      // InflightQuery rather than completing at their old transport boundary.
      if (endpoint !== 'content') await done(page, 'load', 3);
      assert.notEqual(await page.$(`${section} .loading-panel`), null, 'Revision replacement retains loading ownership');
      assert.equal(await page.$(`${section} [role="alert"]`), null);
      await release(page, revisionJob.id);
      await done(page, 'load', 4);
      await idle(page);
      await latestUI(page);
    });
  }

  designedCases.push('direct-child: forced retry finishes while obsolete ordinary content transport stays held; no ordinary pending read satisfies refresh');
  await inRealm(browser, bundle, 'direct-child', 'capabilities', async page => {
    const failure = await held(page, 'capabilities', 1);
    await release(page, failure.id, { status: 502 });
    await done(page, 'load', 1);
    await idle(page);
    await arm(page, 'content');
    await page.evaluate(() => window.ownership.ordinaryContent());
    const ordinary = await held(page, 'content', 2);
    await page.click(`${section} [role="alert"] button`);
    const forced = await held(page, 'content', 3);
    assert.equal(forced.refresh, true);
    await release(page, forced.id);
    await done(page, 'load', 2);
    await ready(page);
    await latestUI(page);
    await page.waitForFunction(() => window.ownership.observe().supplementalDone);
    assert.equal((await observe(page)).supplementalCorrect, true, 'Ordinary reader adopts the current forced result rather than stale held content');
    assert.equal((await observe(page)).jobs[ordinary.id - 1].released, false, 'Current forced group completed without waiting for obsolete ordinary transport');
    await release(page, ordinary.id, { stale: true });
    await idle(page); // Orphan production request handler is explicitly drained.
    await latestUI(page);
  });

  designedCases.push('direct-child: dirty/busy/parent-handler rerenders do not start GET groups');
  await inRealm(browser, bundle, 'direct-child', null, async page => {
    await ready(page);
    await idle(page);
    const before = (await observe(page)).jobs;
    await event(page, 'dirty');
    assert.equal(await page.$eval(add, node => node.disabled), true);
    await event(page, 'busy');
    assert.equal(await page.$eval(add, node => node.disabled), true);
    await event(page, 'handlers');
    assert.equal(await page.$eval(add, node => node.disabled), false);
    await locale(page, 'en');
    assert.deepEqual((await observe(page)).jobs, before);
  });

  for (const endpoint of endpoints) for (const failure of ['409', '502', 'transportTimeout']) {
    designedCases.push(`direct-child: current ${endpoint} ${failure} persists across locale roundtrip without automatic GET/retry`);
    await inRealm(browser, bundle, 'direct-child', endpoint, async page => {
      const job = await held(page, endpoint, 1);
      await release(page, job.id, failure === 'transportTimeout' ? { timeout: true } : { status: Number(failure) });
      await done(page, 'load', 1);
      await idle(page);
      assert.equal(await page.evaluate(timeout => window.ownership.hasReadError(timeout), failure === 'transportTimeout'), true, 'Current read error is visible, with the real transport TimeoutError mapping');
      const before = (await observe(page)).jobs;
      for (const language of ['en', 'zh-CN']) {
        await locale(page, language);
        assert.equal(await page.evaluate(timeout => window.ownership.hasReadError(timeout), failure === 'transportTimeout'), true, 'Locale cannot discard the current read failure');
        assert.deepEqual((await observe(page)).jobs, before);
      }
    });
  }

  for (const endpoint of endpoints) for (const phase of phases) for (const boundary of ['path', 'kind', 'session', 'id', 'method', 'csrf', 'expires', 'unmount']) {
    designedCases.push(`direct-child: ${endpoint} ${phase}, ${boundary} invalidates stale GET handlers`);
    await inRealm(browser, bundle, 'direct-child', endpoint, async page => {
      const old = await held(page, endpoint, 1);
      await atBoundary(page, old, phase, { stale: true });
      await event(page, boundary);
      if (!['path', 'kind'].includes(boundary)) {
        if (boundary === 'session') await event(page, 'session-return');
        else if (boundary !== 'unmount') await event(page, 'fields-return');
        await finishBoundary(page, old, phase, { stale: true });
        await done(page, 'load', 1);
        await idle(page);
        if (boundary === 'unmount') assert.equal(await page.$(section), null);
        else {
          assert.equal((await observe(page)).jobs.filter(job => job.kind === endpoint).length, 1, 'Session A/B/A permanently retires the old controller without new reads');
          assert.equal(await page.$(`${section} .language-version-tabs button`), null, 'Retired controller cannot regain loaded language actions');
          assert.equal(await page.$(`${section} [role="alert"]`), null);
        }
      } else if (endpoint === 'content') {
        // Same-scope non-forced readers share this actual pending transport.
        // Their handlers, not invented network jobs, have distinct owners.
        await event(page, boundary + '-return');
        assert.notEqual(await page.$(`${section} .loading-panel`), null);
        await finishBoundary(page, old, phase, { stale: true });
        await done(page, 'load', 3);
        await idle(page);
        assert.equal((await observe(page)).jobs.filter(job => job.kind === 'content').length, 1, 'Prop roundtrip shares one pending content transport');
        await ready(page);
        assert.deepEqual(await page.$$eval(`${section} [role="tab"]`, nodes => nodes.map(node => node.textContent.trim())), ['zh-CN', 'en'], 'Latest article owner filters mixed article/page rows from the actual shared response');
        assert.equal(await page.$(`${section} [role="alert"]`), null);
        await page.click(`${section} [role="tab"]:not([aria-selected="true"])`);
        assert.equal(await page.evaluate(() => window.ownership.openedCorrectly()), true, 'Current shared result can open exactly its existing translation');
      } else {
        const middle = await held(page, endpoint, 2);
        await event(page, boundary + '-return');
        const current = await held(page, endpoint, 3);
        await finishBoundary(page, old, phase, { stale: true });
        await release(page, middle.id, { status: 502 });
        await done(page, 'load', 2);
        assert.notEqual(await page.$(`${section} .loading-panel`), null, 'Boundary roundtrip keeps its newest loading ownership');
        await release(page, current.id);
        await done(page, 'load', 3);
        await idle(page);
        await latestUI(page);
      }
      assert.equal((await observe(page)).opens, endpoint === 'content' && ['path', 'kind'].includes(boundary) ? 1 : 0, 'Only the explicit current translation-tab click may open a document');
    });
  }

  for (const boundary of ['path', 'kind', 'session', 'id', 'method', 'csrf', 'expires', 'unmount']) for (const outcome of ['success', 'conflict']) for (const phase of phases) {
    designedCases.push(`direct-child: ${boundary} roundtrip fences pending POST ${outcome} at ${phase}, no stale open/error/working callback`);
    await inRealm(browser, bundle, 'direct-child', null, async page => {
      await ready(page);
      await idle(page);
      await page.click(add);
      await page.click(manual);
      const post = await held(page, 'manual', 1);
      await page.waitForFunction(() => window.ownership.observe().working.at(-1) === true);
      await atBoundary(page, post, phase, outcome === 'conflict' ? { status: 409, conflict: true } : {});
      await event(page, boundary);
      if (boundary === 'path' || boundary === 'kind') await event(page, boundary + '-return');
      else if (boundary === 'session') await event(page, 'session-return');
      else if (['id', 'method', 'csrf', 'expires'].includes(boundary)) await event(page, 'fields-return');
      // Reverse cleanup / ownership retirement must release directly, before
      // the held POST can run its finally. A -> B -> A must not revive it.
      const afterBoundary = (await observe(page)).working;
      assert.deepEqual(afterBoundary, [true, false], 'Boundary releases working exactly once before POST settles');
      await finishBoundary(page, post, phase, outcome === 'conflict' ? { status: 409, conflict: true } : {});
      await done(page, 'translate', 1);
      await idle(page);
      const state = await observe(page);
      assert.equal(state.opens, 0, 'Stale mutation result cannot navigate');
      assert.deepEqual(state.working, afterBoundary, 'Stale mutation finally cannot emit working into the new owner');
      assert.equal(state.jobs.filter(job => job.kind === 'manual').length, 1, 'Session/prop change never replays a mutation');
      assert.equal(await page.evaluate(() => window.ownership.hasConflict()), boundary === 'unmount' ? undefined : false, 'Stale conflict cannot poison the new context');
      if (boundary === 'path' || boundary === 'kind') await latestUI(page);
      else if (boundary !== 'unmount') {
        assert.equal(state.jobs.filter(job => job.kind === 'capabilities').length, 1, 'Retired session controller issues no new reads');
        assert.equal(await page.$(`${section} .language-version-tabs button`), null, 'Session roundtrip cannot reactivate the old context');
      }
    });
  }

  for (const outcome of ['success', 'conflict']) {
    designedCases.push(`direct-child: POST ${outcome} survives locale and revision exactly once; settled read error cannot release working`);
    await inRealm(browser, bundle, 'direct-child', null, async page => {
      await ready(page);
      await idle(page);
      await page.click(add);
      await page.click(manual);
      const post = await held(page, 'manual', 1);
      await arm(page, 'capabilities');
      await event(page, 'revision');
      const oldReload = await held(page, 'capabilities', 2);
      await locale(page, 'en');
      const failedReload = await held(page, 'capabilities', 3);
      await release(page, failedReload.id, { status: 502 });
      await done(page, 'load', 3); // Old scope and current failure settle; content waits for write.
      await release(page, oldReload.id);
      await page.waitForFunction(id => window.ownership.observe().jobs[id - 1].requestDone, {}, oldReload.id);
      await ready(page);
      assert.equal(await page.evaluate(() => window.ownership.hasReadError()), true);
      assert.equal((await observe(page)).pendingMutations, 1);
      assert.deepEqual((await observe(page)).working, [true], 'Settled revision read group cannot release pending POST working');
      assert.equal(await page.$eval(manual, node => node.disabled), true, 'Revision reload cannot release pending POST busy state');
      await release(page, post.id, outcome === 'conflict' ? { status: 409, conflict: true } : {});
      await done(page, 'translate', 1);
      await idle(page);
      assert.equal(await page.evaluate(() => window.ownership.openedCorrectly()), outcome === 'success', 'Locale/revision cannot cancel or replay the once-started mutation');
      assert.equal(await page.evaluate(() => window.ownership.hasConflict()), outcome === 'conflict');
      assert.equal(await page.evaluate(() => window.ownership.matchesMutation('manual')), true);
      assert.deepEqual((await observe(page)).working, [true, false], 'Exactly one working lifecycle for the mutation');
      const before = (await observe(page)).jobs;
      await locale(page, 'zh-CN');
      assert.deepEqual((await observe(page)).jobs, before, 'Settled error state remains loaded across locale');
      assert.equal(await page.evaluate(() => window.ownership.hasConflict()), outcome === 'conflict');
    });
  }
  designedCases.push('direct-child: translation conflict survives revision reload failure and is acknowledged only by explicit read retry, never replayed');
  await inRealm(browser, bundle, 'direct-child', null, async page => {
    await ready(page);
    await idle(page);
    await page.click(add);
    await page.click(manual);
    const post = await held(page, 'manual', 1);
    await release(page, post.id, { status: 409, conflict: true });
    await done(page, 'translate', 1);
    await arm(page, 'capabilities');
    await event(page, 'revision');
    const reload = await held(page, 'capabilities', 2);
    await release(page, reload.id, { status: 502 });
    await done(page, 'load', 2);
    await idle(page);
    assert.equal(await page.evaluate(() => window.ownership.hasConflict()), true, 'Translation conflict retains display priority over an independent current reload failure');
    await page.click(`${section} [role="alert"] button`);
    const retry = await held(page, 'capabilities', 3);
    await release(page, retry.id);
    await done(page, 'load', 3);
    await idle(page);
    assert.equal(await page.evaluate(() => window.ownership.hasReadError()), false, 'Successful manual load retry clears only the read error');
    assert.equal(await page.evaluate(() => window.ownership.hasConflict()), false, 'Explicit retry acknowledges the settled translation conflict without replaying POST');
    assert.equal((await observe(page)).jobs.filter(job => job.kind === 'manual').length, 1);
    const before = (await observe(page)).jobs;
    await locale(page, 'en');
    assert.equal(await page.evaluate(() => window.ownership.hasConflict()), false);
    assert.deepEqual((await observe(page)).jobs, before);
    assert.equal((await observe(page)).opens, 0);
  });

  return {
    designedCases,
    evidenceBoundary: 'Synthetic scheduling assertions only; real App/source DocumentEditor and supplemental direct-child cases are labelled separately. Returned case descriptions are a design inventory, not a CI pass claim.',
    realmCount: designedCases.length,
    completion: 'Every realm attempts unmount, explicitly releases all held transport/JSON jobs, and waits for production load/translate/loadChoices/api/request completion counters plus pendingMutations=0 before closing. Cleanup failures retain fixed stage classifications without replacing an original scenario failure.',
    limitations: ['No local execution or CI result implied.', 'No server persistence, authentication acceptance, CSS/layout, rich editor, native WebView or physical input acceptance.', 'AST-inserted counters observe async completion but add instrumentation; ordinary Puppeteer clicks/selects use real enabled controls without forced DOM activation.', 'The real API deliberately blocks content GET behind pending mutations: while POST is held the revision group is tested settling by a current capabilities failure, not a fabricated successful content read.', 'Real-App pending child GET transport/JSON cases cover locale roundtrips and dirty source preservation; forced retry/revision and session/prop boundary matrices remain supplemental direct-child evidence, not full navigation/authentication coverage. Existing DocumentEditor choices scope errors are asserted separately, not repaired or hidden.', 'No POST deadline is claimed: production POST has no API timeout; TimeoutError conversion cases are GET transport rejection only.'],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to Chrome/Chromium.');
  const browser = await puppeteer.launch({ headless: true, executablePath });
  try {
    const summary = await checkLocalizedContentOwnership(browser);
    console.log(JSON.stringify(summary, null, 2));
  } finally { await browser.close(); }
}
