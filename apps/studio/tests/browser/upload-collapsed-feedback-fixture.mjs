import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const target = fileURLToPath(new URL('../../src/components/MediaUpload.tsx', import.meta.url));
const requireThat = condition => { if (!condition) throw new Error('observer'); };

// Exact-file observational edits only. No upload statement, ref, response, emit,
// lifecycle guard or API implementation is replaced. Fail closed on source drift.
function observeUpload(source) {
  const setup = '  (props, emit, expose) => {';
  const emission = '      emit("feedback", { ...snapshot });';
  for (const anchor of [setup, emission]) requireThat(source.split(anchor).length === 2);
  source = source.replace(setup, `${setup}\n    const __feedbackOwner = globalThis.__uploadTrace.owner();\n    onBeforeUnmount(() => globalThis.__uploadTrace.retire(__feedbackOwner));`)
    .replace(emission, `      globalThis.__uploadTrace.feedback(__feedbackOwner, snapshot);\n${emission}`);
  const tree = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'upload') functions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  requireThat(functions.length === 1);
  const fn = functions[0];
  requireThat(fn.body && fn.parameters.length === 1 && fn.parameters[0].name.getText(tree) === 'files'
    && fn.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword));
  const start = fn.body.getStart(tree) + 1, end = fn.body.end - 1;
  return source.slice(0, start)
    + '\nconst __feedbackCall = globalThis.__uploadTrace.begin(__feedbackOwner); try {\n'
    + source.slice(start, end)
    + '\n} finally { globalThis.__uploadTrace.end(__feedbackCall); }\n'
    + source.slice(end);
}

export async function bundleUploadFeedbackFixture() {
  let hits = 0;
  const result = await build({
    stdin: { resolveDir: studio, loader: 'tsx', sourcefile: 'upload-collapsed-feedback-fixture.tsx', contents: fixtureSource },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty' },
    plugins: [fixtureAssetPlugin(), {
      name: 'upload-feedback-exact-observer',
      setup(builder) {
        builder.onLoad({ filter: /\/MediaUpload\.tsx$/ }, async ({ path }) => {
          requireThat(path === target && ++hits === 1);
          return { contents: observeUpload(await readFile(path, 'utf8')), loader: 'tsx', resolveDir: join(studio, 'src/components') };
        });
      },
    }],
  });
  requireThat(hits === 1 && result.outputFiles.length === 1);
  return result.outputFiles[0].text;
}

export async function uploadFeedbackStyles() {
  // Same order as main.ts; resolve real local CSS/font bytes, never synthetic geometry.
  const paths = ['platform/mobile.css', 'src/style.css', 'src/forms.css', 'src/composer.css',
    'src/workspace.css', 'src/creation-tools.css', 'src/accessibility.css'];
  const [parts, variables, font] = await Promise.all([
    Promise.all(paths.map(path => readFile(join(studio, path), 'utf8'))),
    readFile(join(studio, '../../packages/theme/styles/components/common/variables.css'), 'utf8'),
    readFile(join(studio, '../../packages/theme/assets/icon/fonts/icomoon.woff')),
  ]);
  // As in app-locale-scope, omit only the unrelated Vditor editor import.
  // Every Studio stylesheet affecting media and shared dialogs remains real.
  const css = parts.join('\n')
    .replace("@import '../../../packages/theme/styles/components/common/variables.css';", variables)
    .replace("@import 'vditor/dist/index.css';", '')
    .replace("url('../../../packages/theme/assets/icon/fonts/icomoon.woff')", `url('data:font/woff;base64,${font.toString('base64')}')`);
  // Only inlined data resources are permitted. New relative/external resources
  // require explicit local resolution, not a permissive request allowlist.
  requireThat(!/@import\b/i.test(css));
  for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)/gi)) requireThat(match[1].startsWith('data:'));
  return css;
}

const fixtureSource = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import MediaBrowser from './src/components/MediaBrowser';
import MediaPicker from './src/components/MediaPicker';
import type { MediaUploadFeedback } from './src/components/MediaUpload';
import { session, reauthentication, pendingMutations, setApiTransport } from './src/api';
import { mediaUploading, mediaLoading, mediaListing } from './src/media-store';
import { setMediaResolver } from './shared/media';
import { setLocale, t } from './src/i18n';
import { installMobileShell } from './platform/mobile';
import { batch } from './src/reactivity';
const owners = [], calls = [], events = [], jobs = [];
let listings = 0, unexpected = 0, unhandled = 0, draining = false, disposed = false;
const limit = 160;
function check(value) { if (!value) throw new Error('fixture'); }
function boundedPush(array, value) { check(array.length < limit); array.push(value); }
const scalar = value => ({ active: value.active, total: value.total, completed: value.completed,
  uploaded: value.uploaded, failed: value.failed, skipped: value.skipped, paused: value.paused,
  validation: !!value.validation });
globalThis.__uploadTrace = {
  owner() { const id = owners.length + 1; boundedPush(owners, { id, retired: false }); return id; },
  retire(id) { check(owners[id - 1] && !owners[id - 1].retired); owners[id - 1].retired = true; },
  begin(owner) { const id = calls.length + 1; boundedPush(calls, { id, owner, done: false }); return id; },
  end(id) { check(calls[id - 1] && !calls[id - 1].done); calls[id - 1].done = true; },
  feedback(owner, value: MediaUploadFeedback) {
    boundedPush(events, { owner, retired: owners[owner - 1].retired, ...scalar(value) });
  },
};
const rejectUnhandled = () => { unhandled = Math.min(limit + 1, unhandled + 1); };
window.addEventListener('unhandledrejection', rejectUnhandled);
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==';
const initial = { path: 'public/uploads/fixture-existing.png', name: 'fixture-existing.png',
  directory: 'public/uploads', mime: 'image/png', size: 70 };
setMediaResolver(() => image);
const identity = id => ({ identity: { id, name: 'Fixture editor', method: 'password' as const }, csrf: 'fixture-csrf', expires: 9999999999 });
session.value = identity('fixture-A');
function respond(job, status) {
  check(job && !job.released);
  job.released = true;
  const item = { path: job.directory + '/' + job.name, name: job.name, directory: job.directory, mime: 'image/png', size: 70 };
  job.resolve(Response.json(status < 400 ? { item, message: 'Fixture saved' }
    : { messageKey: '操作失败' }, { status }));
}
setApiTransport((path, init) => {
  if (init.method === 'GET' && path === '/media') {
    listings++;
    return Promise.resolve(Response.json({ items: [initial], truncated: false, maxFileSize: 20 * 1024 * 1024 }));
  }
  if (init.method === 'POST' && path.startsWith('/media/upload?')) {
    const query = new URLSearchParams(path.split('?')[1]);
    const name = query.get('filename'), directory = query.get('directory');
    check(/^fixture-[0-9]{2}\\.png$/.test(name || '') && directory === 'public/uploads');
    check(init.body instanceof File && init.body.size > 0);
    return new Promise(resolve => {
      const job = { ordinal: jobs.length + 1, name, directory, resolve, released: false };
      boundedPush(jobs, job);
      if (draining) respond(job, 409);
    });
  }
  unexpected++;
  return Promise.reject(new Error('fixture'));
});
let root, disposeMobile, host, hide, addOther;
let publications = 0, closes = 0, fieldChanged = false;
function Host({ kind }) {
  const [open, setOpen] = useState(true), [other, setOther] = useState(false);
  const [selected, setSelected] = useState('');
  const [field, setField] = useState('/uploads/original.png');
  hide = () => setOpen(false);
  addOther = () => setOther(true);
  const browser = (id, secondary = false) => <section data-upload-host={id} className="media-library"><section className="card media-library-browser">
    <MediaBrowser mode="library" documentPath="" selected={secondary ? '' : selected} svgOnly={false}
      onSelect={item => { if (!secondary) setSelected(item.path); }} />
  </section></section>;
  return <div className="studio-shell"><div className="main-shell"><main className="main-content">
    {kind === 'picker' ? <><input id="fixture-field" readOnly value={field} aria-label="Fixture parent field" /><button id="fixture-trigger" type="button" onClick={() => setOpen(true)}>Open fixture picker</button></> : null}
    {open && (kind === 'picker' ? <MediaPicker mode="public" documentPath="" selected={field} svgOnly={false}
      onClose={() => { closes++; setOpen(false); }} onSelect={(_item, value) => { publications++; fieldChanged = true; setField(value); }} /> : browser('main'))}
    {other && browser('other', true)}
  </main></div></div>;
}
function mainBrowser() { return host === 'picker' ? document.querySelector('dialog.media-dialog .media-browser') : document.querySelector('[data-upload-host="main"] .media-browser'); }
function feedbackNode() { return mainBrowser()?.querySelector('.media-upload-feedback'); }
let remembered, activations = 0, toggles = 0, untrusted = 0;
const onActivation = event => {
  const summary = mainBrowser()?.querySelector('.media-upload-disclosure > summary');
  if (!summary || !summary.contains(event.target)) return;
  if (event.type === 'click') { activations++; if (!event.isTrusted) untrusted++; }
};
const onToggle = event => {
  if (event.target !== mainBrowser()?.querySelector('.media-upload-disclosure')) return;
  toggles++; if (!event.isTrusted) untrusted++;
};
document.addEventListener('click', onActivation, true);
document.addEventListener('toggle', onToggle, true);
const nodes = () => { const browser = mainBrowser(); return [browser, browser?.querySelector('.media-upload-disclosure'), browser?.querySelector('.media-upload'), browser?.querySelector('.upload-file-input'), feedbackNode()]; };
window.uploadFeedback = {
  start(kind, language, native) {
    check(!root); host = kind; setLocale(language); disposeMobile = installMobileShell(native);
    root = createRoot(document.getElementById('root')); root.render(<Host kind={kind} />);
  },
  remember() { remembered = { nodes: nodes(), owner: owners[0], identity: session.value?.identity.id }; return remembered.nodes.every(Boolean); },
  same() { return !!remembered && remembered.nodes.every((node, index) => node && node.isConnected && node === nodes()[index] && node.ownerDocument === document && node.ownerDocument.defaultView === window)
    && remembered.owner === owners[0] && !owners[0].retired && session.value?.identity.id === remembered.identity; },
  observe() {
    const browser = mainBrowser(), feedback = feedbackNode(), detail = browser?.querySelector('.media-upload-disclosure');
    const inner = browser?.querySelector('.media-upload');
    const progress = inner?.querySelector('progress');
    const latest = events.filter(event => event.owner === 1).at(-1);
    const text = feedback?.textContent || '';
    const summary = latest && latest.total > 0
      ? t('已处理 {completed}/{total}，已上传 {uploaded}，失败 {failed}，未尝试 {skipped}', latest) : '';
    const stateLabel = latest?.active ? t('正在处理上传') : latest?.paused ? t('上传已暂停') : t('上传处理结束');
    const localized = !!latest && (!latest.total || (text.includes(summary) && text.includes(stateLabel)))
      && (!latest.uploaded || text.includes(t('已上传的图片已保存到仓库，选用后仍需保存表单。')))
      && (!latest.validation || (text.includes(t('每次最多选择 20 张图片')) && (!latest.total || text.includes(t('上次上传')))));
    const errors = inner?.querySelectorAll('.upload-error').length || 0;
    return { activations, toggles, untrusted, listings, posts: jobs.length, held: jobs.filter(job => !job.released).length,
      calls: calls.length, done: calls.filter(call => call.done).length, owners: owners.length,
      retired: owners.filter(owner => owner.retired).length, events: events.length,
      late: events.filter(event => event.retired).length, latest: latest || null,
      uploading: mediaUploading.value, loading: mediaLoading.value, mutations: pendingMutations.value,
      reauthentication: reauthentication.value, unexpected, unhandled, publications, closes, fieldChanged,
      parentOriginal: host !== 'picker' || document.querySelector('#fixture-field')?.value === '/uploads/original.png',
      parentConfirmed: host === 'picker' && document.querySelector('#fixture-field')?.value === '/uploads/fixture-02.png',
      sessionA: session.value?.identity.id === 'fixture-A', sessionOidc: session.value?.identity.method === 'oidc', open: detail?.open ?? null,
      feedbackPresent: !!feedback, feedbackEmpty: !feedback?.textContent.trim(),
      localized, statusCount: browser?.querySelectorAll('.media-upload-feedback[role="status"]').length || 0,
      validationDuplicate: !!inner?.querySelector('.notice.error'),
      previousReminded: !latest?.validation || !latest.total || text.includes(t('上次上传')),
      nativeInstalled: document.documentElement.dataset.nativeMobile === 'true',
      shellHeight: parseFloat(document.documentElement.style.getPropertyValue('--native-visible-height')) > 0,
      status: feedback?.getAttribute('role') === 'status', atomic: feedback?.getAttribute('aria-atomic') === 'true',
      sibling: !!feedback && feedback.parentElement === detail?.parentElement && !detail.contains(feedback),
      duplicateLive: inner?.querySelectorAll('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])').length || 0,
      progressNamed: !progress || progress.getAttribute('aria-label') === t('图片上传进度'),
      progressPresent: !!progress,
      selectedOrdinal: (() => {
        const path = browser?.querySelector('.media-card.selected')?.getAttribute('data-media-path');
        if (!path) return -2;
        if (path === initial.path) return -1;
        const match = /fixture-([0-9]{2})\\.png$/.exec(path);
        return match ? Number(match[1]) : -3;
      })(),
      rows: inner?.querySelectorAll('.upload-results li').length || 0, successRows: inner?.querySelectorAll('.upload-results li button').length || 0, errorRows: errors,
      confirmationDisabled: host === 'picker' ? !!document.querySelector('.selection-footer > button')?.disabled : null,
      cancelDisabled: host === 'picker' ? !!document.querySelector('.media-dialog .card-heading > button')?.disabled : null,
      modal: !!document.querySelector('dialog.media-dialog[open]:modal'),
      otherEmpty: [...document.querySelectorAll('[data-upload-host="other"] .media-upload-feedback')].every(node => !node.textContent.trim()),
      otherCount: document.querySelectorAll('[data-upload-host="other"] .media-upload-feedback').length,
      otherDisabled: !!document.querySelector('[data-upload-host="other"] .upload-file-input')?.disabled,
      otherProgress: !!document.querySelector('[data-upload-host="other"] progress'),
      otherProgressNamed: !document.querySelector('[data-upload-host="other"] progress') || document.querySelector('[data-upload-host="other"] progress')?.getAttribute('aria-label') === t('图片上传进度'),
      inputDisabled: !!inner?.querySelector('input[type="file"]')?.disabled,
      facts: mediaListing.value.items.length,
    };
  },
  release(ordinal, status) { respond(jobs[ordinal - 1], status); },
  identityRoundtrip() { batch(() => { session.value = identity('fixture-B'); session.value = identity('fixture-A'); }); },
  methodBoundary() { session.value.identity.method = 'oidc'; },
  hide() { flushSync(hide); },
  other() { flushSync(addOther); },
  drop() {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([1])], 'fixture-20.png', { type: 'image/png' }));
    mainBrowser()?.querySelector('.media-upload')?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  },
  validationMatches() { return feedbackNode()?.textContent.includes(t('每次最多选择 20 张图片')) === true; },
  async drain() {
    draining = true;
    for (const job of jobs) if (!job.released) respond(job, 409);
    // Caller completion, not transport resolution, is the drain acceptance predicate.
    for (let turn = 0; turn < 80; turn++) {
      if (calls.every(call => call.done) && pendingMutations.value === 0 && !mediaUploading.value && jobs.every(job => job.released)) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('drain');
  },
  dispose() {
    if (disposed) return;
    disposed = true;
    const failures = [];
    for (const action of [() => root?.unmount(), () => disposeMobile?.(), () => setApiTransport(), () => setMediaResolver(),
      () => document.removeEventListener('click', onActivation, true), () => document.removeEventListener('toggle', onToggle, true)]) {
      try { action(); } catch { failures.push(new Error('cleanup')); }
    }
    if (failures.length) throw new AggregateError(failures, 'cleanup');
  },
  forget() {
    window.removeEventListener('unhandledrejection', rejectUnhandled);
    delete window.uploadFeedback; delete globalThis.__uploadTrace;
  },
};
`;
