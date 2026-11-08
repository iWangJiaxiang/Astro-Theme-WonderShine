import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const need = value => { if (!value) throw new Error('observer'); };

// Product contract approved at e8af56c; exact source observers still fail closed
// on drift. Approval is not evidence that any bundle or browser case has run.
export const productContract = Object.freeze({
  approved: true,
  selectors: Object.freeze({ reload: 'section.notice[role="status"] > button:not(.settings-exit)', exit: '.settings-exit', retired: '.settings-retired', errorRetry: 'p.notice.error[role="alert"] > button' }),
  neutralMessage: '先前保存的结果无法确认，当前表单和版本信息未更新。',
  // Additional bounded guard probes are separate from the approved 108 Settings
  // capability calls: three sticky-obligation saves and four SaveButton handlers.
  stickyGuardCalls: 3,
  saveButtonGuardCalls: 4,
});

export const mountedCases = Object.freeze([
  { id: 1, mode: 'compat', requests: 0, puts: 0, capabilities: 0, m: 0, r: 0, s: 0 },
  { id: 2, mode: 'direct', requests: 3, puts: 1, capabilities: 0, m: 1, r: 1, s: 1 },
  { id: 3, mode: 'direct', requests: 4, puts: 0, capabilities: 0, m: 2, r: 2, s: 0 },
  { id: 4, mode: 'direct', requests: 4, puts: 0, capabilities: 0, m: 2, r: 2, s: 0 },
  { id: 5, mode: 'direct', requests: 4, puts: 1, capabilities: 0, m: 1, r: 2, s: 2 },
  { id: 6, mode: 'direct', requests: 4, puts: 1, capabilities: 0, m: 1, r: 2, s: 2 },
  { id: 7, mode: 'direct', requests: 4, puts: 1, capabilities: 0, m: 1, r: 2, s: 2 },
  { id: 8, mode: 'direct', requests: 3, puts: 1, capabilities: 14, m: 3, r: 3, s: 3 },
  { id: 9, mode: 'direct', requests: 3, puts: 1, capabilities: 14, m: 3, r: 3, s: 3 },
  { id: 10, mode: 'direct', requests: 3, puts: 1, capabilities: 14, m: 3, r: 3, s: 3 },
  { id: 11, mode: 'direct', requests: 2, puts: 0, capabilities: 10, m: 3, r: 3, s: 2 },
  { id: 12, mode: 'direct', requests: 2, puts: 0, capabilities: 14, m: 3, r: 3, s: 2 },
  { id: 13, mode: 'direct', requests: 3, puts: 1, capabilities: 14, m: 3, r: 3, s: 3 },
  { id: 14, mode: 'direct', requests: 3, puts: 1, capabilities: 14, m: 3, r: 3, s: 3 },
  { id: 15, mode: 'direct', requests: 3, puts: 1, capabilities: 14, m: 3, r: 3, s: 3 },
  { id: 16, mode: 'app', requests: 8, puts: 1, capabilities: 0, m: 1, r: 1, s: 1 },
  { id: 17, mode: 'app', requests: 12, puts: 1, capabilities: 0, m: 1, r: 1, s: 1 },
  { id: 18, mode: 'app', requests: 11, puts: 0, capabilities: 0, m: 1, r: 1, s: 0 },
  // Separate approved regression delta; never merge it into the original 18 rows.
  { id: 19, mode: 'direct', requests: 6, puts: 0, capabilities: 0, m: 3, r: 3, s: 0 },
].map(Object.freeze));

const functions = Object.freeze({
  'api.ts': ['api', 'request'],
  'components/SettingsView.tsx': ['load', 'loadRelations', 'save'],
  'App.tsx': ['checkSession', 'bootstrap', 'loadArticles', 'loadDashboardPreview'],
  'components/DocumentEditor.tsx': ['loadDocument', 'loadChoices'],
});

function insertions(source, edits) {
  let boundary = source.length;
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) {
    need(start >= 0 && start <= end && end <= boundary);
    source = source.slice(0, start) + text + source.slice(end);
    boundary = start;
  }
  return source;
}
function exact(source, anchor, replacement) {
  need(source.split(anchor).length === 2);
  return source.replace(anchor, replacement);
}
function completionProbe(source, file, names) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set(), edits = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      const name = node.name.text;
      need(!found.has(name) && node.body && node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
      if (file === 'api.ts') need(ts.isSourceFile(node.parent));
      else {
        need(ts.isBlock(node.parent) && ts.isArrowFunction(node.parent.parent));
        const call = node.parent.parent.parent;
        need(ts.isCallExpression(call) && call.arguments[0]?.getText(tree) === JSON.stringify(file === 'App.tsx' ? 'App' : file === 'components/SettingsView.tsx' ? 'SettingsView' : 'DocumentEditor'));
      }
      found.add(name);
      const kind = file === 'api.ts' ? name : file === 'components/SettingsView.tsx' ? 'settings-' + name : file + ':' + name;
      edits.push([node.body.getStart(tree) + 1, node.body.getStart(tree) + 1,
        `\nconst __mountedCompletion = globalThis.__mountedTrace.begin(${JSON.stringify(kind)}); try {\n`]);
      edits.push([node.body.end - 1, node.body.end - 1, '\n} finally { globalThis.__mountedTrace.end(__mountedCompletion); }\n']);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); need(found.size === names.length);
  return insertions(source, edits);
}

function observeSettings(source) {
  const setup = '  (props, emit, expose) => {';
  source = exact(source, setup, setup + '\n    const __mountedOwner = globalThis.__mountedTrace.owner();\n    onBeforeUnmount(() => globalThis.__mountedTrace.retire(__mountedOwner));');
  // Match the approved setup/render anchors, never wildcard business function
  // bodies or install a replacement ownership check.
  source = exact(source, '    return () =>\n', `    globalThis.__mountedTrace.model(__mountedOwner, () => ({ values: values.value, baseline: baseline.value,
      revision: settings.value?.revision ?? null, dirty: dirty.value, busy: busy.value, error: error.value,
      message: message.value, branchPending: branchPending.value, savedBranch: savedBranch.value,
      unknown: unknownSaveObligation.value, saveMode: saveMode.value }),
      { save, reload, load, relations: loadRelations });
    return () =>\n`);
  const tree = ts.createSourceFile('SettingsView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [], counts = { persist: 0, text: 0, structured: 0 }, emits = new Map();
  const capture = (node, kind) => {
    counts[kind]++;
    const original = node.getText(tree);
    edits.push([node.getStart(tree), node.end, `globalThis.__mountedTrace.capture(__mountedOwner, ${JSON.stringify(kind)}, ${original}${kind === 'persist' ? '' : ', field.path'})`]);
  };
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'emit') {
      const kind = node.arguments[0]?.getText(tree); emits.set(kind, (emits.get(kind) || 0) + 1);
      const original = node.getText(tree);
      edits.push([node.getStart(tree), node.end, `(globalThis.__mountedTrace.notification(__mountedOwner, !alive, ${node.arguments.map(arg => arg.getText(tree)).join(', ')}), ${original})`]);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'watch' && node.arguments[0]?.getText(tree) === '[values, baseline, () => settings.value?.revision]') {
      need(ts.isArrowFunction(node.arguments[1])); capture(node.arguments[1], 'persist');
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'element' && ['FormField', 'ValueEditor'].includes(node.arguments[0]?.getText(tree))) {
      const props = node.arguments[1]; need(props && ts.isObjectLiteralExpression(props));
      const updates = props.properties.filter(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === 'onUpdateModelValue');
      need(updates.length === 1);
      // Capture inside the satisfies expression, preserving the original function
      // object supplied to React. No business callback is wrapped or suppressed.
      let fn = updates[0].initializer;
      if (ts.isSatisfiesExpression(fn)) fn = fn.expression;
      while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
      need(ts.isArrowFunction(fn));
      capture(fn, node.arguments[0].getText(tree) === 'FormField' ? 'text' : 'structured');
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); need(Object.values(counts).every(n => n === 1) && emits.size === 3 && emits.get('"dirty"') === 2 && emits.get('"saved"') === 1 && emits.get('"exit"') === 1);
  return insertions(source, edits);
}

function observeSaveButton(source) {
  const callsTree = ts.createSourceFile('SaveButton.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls = [], callNames = new Map();
  const visitCalls = node => {
    if (ts.isCallExpression(node) && ['onSave', 'onModeChange', 'rememberSaveMode', 'rememberPreference', 'setOpen', 'setError'].includes(node.expression.getText(callsTree))) {
      const name = node.expression.getText(callsTree); callNames.set(name, (callNames.get(name) || 0) + 1);
      calls.push([node.getStart(callsTree), node.end, `(globalThis.__mountedTrace.saveAction(${JSON.stringify(name)}), ${node.getText(callsTree)})`]);
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(callsTree);
  need(['onSave', 'onModeChange', 'rememberSaveMode', 'rememberPreference'].every(name => callNames.get(name) === 1) && callNames.get('setOpen') === 7 && callNames.get('setError') === 2);
  source = insertions(source, calls);
  const tree = ts.createSourceFile('SaveButton.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [], found = new Set();
  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(tree) === 'button') {
        const attrs = node.attributes.properties;
        const named = name => attrs.find(a => ts.isJsxAttribute(a) && a.name.getText(tree) === name);
        const className = named('className')?.initializer?.getText(tree);
        const role = named('role')?.initializer?.getText(tree);
        const kind = className === '"primary save-button-main"' ? 'save' : className === '"primary save-button-toggle"' ? 'toggle'
          : className === '"save-mode-default"' ? 'preference' : role === '"radio"' ? 'mode' : null;
        if (kind) {
          need(!found.has(kind)); found.add(kind);
          const expression = named('onClick')?.initializer;
          need(expression && ts.isJsxExpression(expression) && expression.expression);
          const fn = expression.expression;
          edits.push([fn.getStart(tree), fn.end, `globalThis.__mountedTrace.saveHandler(${JSON.stringify(kind)}, ${fn.getText(tree)}${kind === 'mode' ? ', choice' : ''})`]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); need(found.size === 4);
  return exact(insertions(source, edits), '  return <div className="save-button">',
    '  globalThis.__mountedTrace.saveState(() => ({ open, error }));\n  return <div className="save-button">');
}

const isolatedApp = new Set(['./components/LoginView', './components/ContentLibrary', './components/ThreadComposer',
  './components/ThreadDetail', './components/LocalizedContentLibrary', './components/MediaLibrary', './components/GettingStarted',
  '../platform/LegacyRecovery', '../platform/NativeAiSettings', '../platform/WorkspacePanel']);

export async function bundleMountedSafety() {
  if (!productContract.approved || Object.values(productContract.selectors).some(v => typeof v !== 'string') || typeof productContract.neutralMessage !== 'string') throw new Error('dependency');
  const result = new Map();
  // Exactly three in-memory bundles, reused across at most nineteen serial pages.
  for (const mode of ['compat', 'direct', 'app']) {
    const hits = new Map();
    const built = await build({
      stdin: { resolveDir: studio, sourcefile: 'settings-mounted-safety-fixture.tsx', loader: 'tsx', contents: fixtureSource(mode) },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' },
      plugins: [fixtureAssetPlugin(), {
        name: 'mounted-settings-exact-observers',
        setup(builder) {
          builder.onLoad({ filter: /\/src\/(?:api\.ts|App\.tsx|components\/(?:SettingsView|DocumentEditor)\.tsx)$/ }, async args => {
            const relative = args.path.slice(join(studio, 'src').length + 1);
            need(Object.hasOwn(functions, relative) && !hits.has(relative)); hits.set(relative, 1);
            let text = await readFile(args.path, 'utf8');
            if (relative === 'components/SettingsView.tsx') text = observeSettings(text);
            return { contents: completionProbe(text, relative, functions[relative]), loader: relative.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: join(studio, 'src', relative.includes('/') ? 'components' : '') };
          });
          builder.onLoad({ filter: /\/src\/components\/SaveButton\.tsx$/ }, async args => {
            need(args.path === join(studio, 'src/components/SaveButton.tsx') && !hits.has('SaveButton.tsx'));
            hits.set('SaveButton.tsx', 1);
            return { contents: observeSaveButton(await readFile(args.path, 'utf8')), loader: 'tsx' };
          });
          builder.onResolve({ filter: /(?:components\/|platform\/)/ }, args => {
            if (args.importer === join(studio, 'src/App.tsx') && isolatedApp.has(args.path)) return { path: args.path, namespace: 'mounted-unused' };
          });
          builder.onResolve({ filter: /^\.\/LocalizedContentContext$/ }, args => {
            if (args.importer === join(studio, 'src/components/DocumentEditor.tsx')) return { path: args.path, namespace: 'mounted-unused' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'mounted-unused' }, () => ({ loader: 'tsx', resolveDir: studio, contents: 'import React from "react"; const Child = React.forwardRef(() => null); export default Child; export { Child as LegacyRecovery, Child as NativeAiSettings, Child as WorkspacePanel };' }));
          builder.onResolve({ filter: /^vditor$/ }, () => ({ path: 'vditor', namespace: 'mounted-vditor' }));
          builder.onLoad({ filter: /.*/, namespace: 'mounted-vditor' }, () => ({ loader: 'js', contents: 'export default class Unused { constructor() { throw new Error("fixture"); } }' }));
          builder.onResolve({ filter: /^\.\/(?:FormField|ValueEditor|SaveButton|SelectionField)$/ }, args => {
            const parent = args.importer;
            if (parent === join(studio, 'src/components/SettingsView.tsx') || (args.path === './SelectionField' && parent === join(studio, 'src/components/FormField.tsx'))) {
              return { path: args.path.slice(2), namespace: 'mounted-child-observer' };
            }
          });
          builder.onLoad({ filter: /.*/, namespace: 'mounted-child-observer' }, args => ({ loader: 'tsx', resolveDir: studio, contents: `
import React, { useEffect } from 'react';
import Real from './src/components/${args.path}';
import { component } from './src/react-component';
import { inject } from './src/reactivity';
import { formContext } from './src/form-context';
const ContextObserver = component('MountedContextObserver', () => {
  globalThis.__mountedTrace.context(inject(formContext)); return () => null;
});
export default function Observed(props) {
  useEffect(() => { const id = globalThis.__mountedTrace.child(${JSON.stringify(args.path)}, props.name); return () => globalThis.__mountedTrace.childGone(id); }, []);
  return <><ContextObserver /><Real {...props} /></>;
}` }));
        },
      }],
    });
    const expected = mode === 'compat' ? ['api.ts'] : mode === 'direct' ? ['api.ts', 'components/SettingsView.tsx'] : Object.keys(functions);
    if (mode !== 'compat') expected.push('SaveButton.tsx');
    need(hits.size === expected.length && expected.every(file => hits.has(file)) && built.outputFiles.length === 1);
    result.set(mode, built.outputFiles[0].text);
  }
  return result;
}

function fixtureSource(mode) {
  return `
import React, { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { session, authenticationEpoch, identityEpoch, apiTransportGeneration, setApiTransport, pendingMutations, reauthentication } from './src/api';
import { component, element } from './src/react-component';
import { useSignals, batch, computed, watch } from './src/reactivity';
import { setLocale, t } from './src/i18n';
import { configureSaving, saveContext } from './src/save-preferences';
${mode === 'direct' ? "import SettingsView from './src/components/SettingsView';\nimport LanguageSwitcher from './src/components/LanguageSwitcher';" : ''}
${mode === 'app' ? "import App from './src/App';" : ''}
const mode = ${JSON.stringify(mode)}, contract = ${JSON.stringify(productContract)};
const fail = code => { throw new Error(code); };
const need = (condition, code = 'fixture') => { if (!condition) fail(code); };
const push = (array, item, cap) => { need(array.length < cap, 'counter'); array.push(item); return item; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => JSON.parse(JSON.stringify(value));
const identity = () => ({ identity: { id: 'mounted-safety', name: 'Synthetic editor', method: 'password' }, csrf: 'synthetic-csrf', expires: 9999999999 });
const initial = { title: 'Synthetic site', 'post.today_recommend.post_path': '', 'site.url': '/', 'fixture.items': ['original'] };
const path = 'content/pages/mounted-safety/index.md';
const documentKey = 'studio-draft:password:mounted-safety:' + path;
const keyFor = (group = 'site', language = 'default') => 'studio-settings:password:mounted-safety:' + group + ':' + language;
const preferenceKey = 'studio.save-default.v1:mounted-safety';
const keys = new Set([keyFor(), keyFor('page-music', 'zh-CN'), documentKey, preferenceKey]);
const tokens = [], owners = [], children = [], contexts = [], jobs = [], storage = [], notifications = [], portals = [], packs = [];
let caseID = 0, root, unmounted = false, cleanup = false, unhandled = 0, unexpected = 0, capabilityCalls = 0;
let stickyGuardCalls = 0, saveButtonGuardCalls = 0, saveActions = 0, saveRead;
const saveHandlers = new Map();
let retainedSaveHandlers;
let group = 'site', language, dirty = false, remembered, saved, boundarySnapshot, retirementSnapshot, documentSnapshot, compatUnmounts = 0;
const caps = { requests: 16, tokens: 192, owners: 4, portals: 4, storage: 256, notifications: 64 };
let invoking = [], measurement = false;
globalThis.__mountedTrace = {
  begin(kind) {
    const token = push(tokens, { id: tokens.length + 1, kind, done: false }, caps.tokens);
    invoking.push(token);
    // Only the synchronous entry stack is used to bind a transport to request().
    queueMicrotask(() => { invoking = invoking.filter(item => item !== token); });
    return token;
  },
  end(token) { need(tokens.includes(token) && !token.done, 'observer'); token.done = true; },
  owner() { const owner = push(owners, { id: owners.length + 1, gone: false, callbacks: {} }, caps.owners); return owner; },
  retire(owner) { need(!owner.gone, 'observer'); owner.gone = true; },
  model(owner, read, methods) { need(!owner.read, 'observer'); owner.read = read; owner.methods = methods; },
  capture(owner, kind, fn, field) {
    need(typeof fn === 'function', 'observer');
    // Capture the first actual callback for the named fixture field. It closes
    // over the real field object and remains the same retained function object.
    if (!owner.callbacks[kind] && (kind === 'persist' || kind === 'text' && field === 'title' || kind === 'structured' && field === 'fixture.items')) owner.callbacks[kind] = fn;
    return fn;
  },
  saveHandler(kind, fn, choice) {
    need(['save', 'toggle', 'mode', 'preference'].includes(kind) && typeof fn === 'function', 'observer');
    if (kind !== 'mode' || choice === 'local') saveHandlers.set(kind, fn);
    return fn;
  },
  saveState(read) { need(typeof read === 'function', 'observer'); saveRead = read; },
  saveAction(kind) { need(['onSave', 'onModeChange', 'rememberSaveMode', 'rememberPreference', 'setOpen', 'setError'].includes(kind) && saveActions < 128, 'observer'); saveActions++; },
  context(value) { if (value && !contexts.includes(value)) push(contexts, value, 4); },
  child(kind, name) { const child = push(children, { id: children.length + 1, kind, name, gone: false }, 64); return child; },
  childGone(child) { need(!child.gone, 'observer'); child.gone = true; },
  notification(owner, disposing, kind, value) {
    need(owners.includes(owner), 'observer');
    push(notifications, { owner, disposing, kind, value }, caps.notifications);
  },
};
const onUnhandled = () => { need(unhandled < 64, 'counter'); unhandled++; };
window.addEventListener('unhandledrejection', onUnhandled);
const originals = Object.fromEntries(['setItem', 'removeItem', 'clear'].map(name => [name, Storage.prototype[name]]));
for (const name of Object.keys(originals)) Storage.prototype[name] = function(...args) {
  if (measurement && (this === sessionStorage || this === localStorage) && (name === 'clear' || keys.has(String(args[0])))) push(storage, {
    kind: name, area: this === sessionStorage ? 'session' : 'local', target: name === 'clear' ? 'all' : args[0] === documentKey ? 'document' : args[0] === preferenceKey ? 'preference' : 'settings',
  }, caps.storage);
  return Reflect.apply(originals[name], this, args);
};
function row(marker, index) { return { path: 'content/articles/' + marker + index + '.md', title: marker + index,
  date: '2026-01-01', draft: false, kind: 'article', tags: [], categories: [], publicPath: '/' + marker + index }; }
function dataFor(job, obsolete = false) {
  if (job.kind === 'auth') return identity();
  if (job.kind === 'bootstrap') return { site: {}, appearance: {}, mode: 'local', saveScope: 'mounted-safety', saveCapabilities: { modes: ['local', 'branch'], defaultMode: 'local' }, groups: [{ id: 'site', title: '站点信息' }] };
  if (job.kind === 'preview') return null;
  if (job.kind === 'content') return mode === 'app' ? [{ path, title: 'Synthetic page', date: '2026-12-01', draft: false, kind: 'article', tags: [], categories: [], lang: 'zh-CN' }, ...Array.from({ length: 6 }, (_, i) => row(obsolete ? 'obsolete' : 'current', i))] : Array.from({ length: 6 }, (_, i) => row(obsolete ? 'obsolete' : 'current', i));
  if (job.kind === 'languages') return { defaultLanguage: 'zh-CN', languages: ['zh-CN', 'en'] };
  if (job.kind === 'document') return { path, text: 'Synthetic page file', metadata: { title: 'Synthetic page', layout: 'music', draft: false }, body: 'Synthetic saved body', revision: 'document-r1' };
  if (job.kind === 'taxonomy') return { id: 'taxonomies', title: '分类', fields: [], values: { 'post.tags': [], 'post.categories': [] }, revision: 'taxonomy-r1' };
  if (job.kind === 'put') return { revision: 'settings-r2', message: 'Synthetic saved' };
  need(job.kind === 'main', 'transport');
  return { id: mode === 'app' && caseID >= 17 ? 'page-music' : 'site', title: '站点信息', description: '', file: 'config.toml',
    fields: [{ path: 'title', label: '标题', kind: 'text', default: '' }, { path: 'post.today_recommend.post_path', label: '文章', kind: 'text', default: '' },
      { path: 'site.url', label: '链接', kind: 'text', default: '/' }, { path: 'fixture.items', label: '项目', kind: 'structured', default: [] }],
    values: { ...initial, title: obsolete ? 'Obsolete main' : initial.title }, revision: obsolete ? 'obsolete-r9' : 'settings-r1' };
}
function classify(endpoint, method) {
  if (endpoint === '/auth/session' && method === 'GET') return 'auth';
  if (endpoint === '/bootstrap' && method === 'GET') return 'bootstrap';
  if (endpoint === '/content-preview' && method === 'GET') return 'preview';
  if (['/content', '/content?refresh=1'].includes(endpoint) && method === 'GET') return 'content';
  if (endpoint === '/content-languages' && method === 'GET') return 'languages';
  if (endpoint === '/document?path=' + encodeURIComponent(path) && method === 'GET') return 'document';
  if (endpoint === '/settings/taxonomies?language=zh-CN' && method === 'GET') return 'taxonomy';
  if (['/settings/site', '/settings/page-music?language=zh-CN'].includes(endpoint)) return method === 'PUT' ? 'put' : method === 'GET' ? 'main' : 'unexpected';
  return 'unexpected';
}
function release(id, options = {}) {
  const job = jobs[id - 1]; need(job && !job.released, 'transport'); job.released = true;
  const status = options.status || 200;
  const response = Response.json(status === 200 ? dataFor(job, !!options.obsolete) : { error: 'Synthetic old failure', revision: 'must-not-adopt' }, { status });
  const original = response.json.bind(response);
  response.json = () => {
    need(!job.jsonStarted, 'transport'); job.jsonStarted = true;
    const read = () => { need(!job.jsonReleased, 'transport'); job.jsonReleased = true; return options.badJSON ? Promise.reject(new SyntaxError('fixture')) : original(); };
    if (!options.holdJSON || cleanup) return read();
    return new Promise((resolve, reject) => { job.decode = () => { read().then(resolve, reject); }; });
  };
  job.resolve(response);
}
const transport = (endpoint, init) => {
  const kind = classify(endpoint, init.method);
  if (kind === 'unexpected' || cleanup) unexpected++;
  const token = invoking.filter(item => item.kind === 'request' && !item.done).at(-1);
  need(token, 'observer');
  return new Promise(resolve => {
    const job = push(jobs, { id: jobs.length + 1, kind, method: init.method, locale: new Headers(init.headers).get('Accept-Language'),
      csrf: new Headers(init.headers).get('X-CSRF-Token'), generation: apiTransportGeneration.value, refresh: endpoint.endsWith('refresh=1'),
      body: init.body ? JSON.parse(String(init.body)) : null, requestToken: token, resolve, released: false, jsonStarted: false, jsonReleased: false }, caps.requests);
    if (cleanup || kind === 'unexpected') release(job.id, { status: 502 });
    else if (kind === 'put' || (caseID === 3 || caseID === 4 || caseID === 11) && ['main', 'content'].includes(kind)) { /* Driver owns these holds. */ }
    else if (caseID === 19 && kind === 'main' && jobs.filter(j => j.kind === 'main').length === 2) release(job.id, { status: 502 });
    else if ([5, 6, 7].includes(caseID) && kind === 'content' && jobs.filter(j => j.kind === 'content').length === 1) release(job.id, { status: 502 });
    else if ([5, 6, 7].includes(caseID) && kind === 'content') { /* Forced current relation hold. */ }
    else release(job.id);
  }); // Abort is deliberately ignored. Real callers and orphan request work drain.
};
function note(kind, value) { push(notifications, { kind, value }, caps.notifications); if (kind === 'dirty') dirty = value; }
const latest = () => { need(owners.length === 1 && owners[0].read, 'observer'); return owners[0]; };
const model = () => copy(latest().read());
const storageKey = () => [17, 18].includes(caseID) ? keyFor('page-music', 'zh-CN') : keyFor();
const draft = () => sessionStorage.getItem(storageKey());
function validateDraft(title = 'Synthetic site dirty', advanced = false) {
  const expectedBaseline = advanced ? { ...initial, title: 'Synthetic site dirty' } : initial;
  need(same(JSON.parse(draft() || 'null'), { values: { ...initial, title }, baseline: expectedBaseline, revision: advanced ? 'settings-r2' : 'settings-r1' }), 'draft');
}
function holdSnapshot() { return { model: model(), draft: draft(), storage: storage.length, notifications: notifications.length,
  api: tokens.filter(t => t.kind === 'api').length, requests: jobs.length }; }
function unchanged(before, allowReconciliation = false) {
  const a = model(), b = copy(before.model);
  // The first retained entry may publish the product's controlled unknown flag.
  // It is not adoption; every private data/branch/preference field stays exact.
  if (allowReconciliation && !b.unknown && a.unknown) {
    need(!latest().gone && pendingMutations.value === 1 && a.busy && b.busy, 'busy');
    delete a.unknown; delete b.unknown;
  }
  need(same(a, b) && draft() === before.draft && storage.length === before.storage && notifications.length === before.notifications, 'retirement');
  need(tokens.filter(t => t.kind === 'api').length === before.api && jobs.length === before.requests, 'transport');
}
function saveButtonGuards() {
  need(caseID === 12 && retainedSaveHandlers && portals.length === 1 && portals[0].node.isConnected && !latest().gone, 'observer');
  need(same(saveRead(), { open: true, error: false }) && model().saveMode === 'branch', 'observer');
  const before = holdSnapshot(), actions = saveActions, preference = copy(saveContext.value), stored = localStorage.getItem(preferenceKey);
  for (const kind of ['save', 'mode', 'toggle', 'preference']) {
    const fn = retainedSaveHandlers.get(kind); need(fn === saveHandlers.get(kind), 'observer');
    saveButtonGuardCalls++; fn();
    unchanged(before);
    need(saveActions === actions && same(saveContext.value, preference) && localStorage.getItem(preferenceKey) === stored && same(saveRead(), { open: true, error: false }), 'retirement');
  }
}
function capabilityPack() {
  const owner = latest(), before = holdSnapshot();
  const list = [owner.methods.save, owner.methods.reload, owner.methods.load, () => owner.methods.relations(true)];
  need(typeof owner.callbacks.persist === 'function' && (caseID === 11 || typeof owner.callbacks.text === 'function' && typeof owner.callbacks.structured === 'function'), 'observer');
  if (caseID !== 11) list.push(() => owner.callbacks.text('forbidden'), () => owner.callbacks.structured(['forbidden']));
  list.push(owner.callbacks.persist);
  need(list.every(fn => typeof fn === 'function'), 'observer');
  for (const fn of list) {
    capabilityCalls++;
    const value = fn();
    if (value && typeof value.then === 'function') {
      const record = push(packs, { done: false }, 64);
      void value.then(() => { record.done = true; }, () => { record.done = true; fail('retirement'); });
    }
  }
  unchanged(before, true);
}
function render() {
  ${mode === 'direct' ? 'root.render(<><LanguageSwitcher /><SettingsView key="stable-owner" group={group} language={language} embedded={!!language} onDirty={value => note("dirty", value)} onSaved={() => note("saved", true)} /></>);' : mode === 'app' ? 'root.render(<App />);' : 'root.render(<><Compatibility /><Bridge /></>);'}
}
let compatNodes, compatSetup = 0, compatCommits = 0, compatStop;
function Compatibility() {
  useSignals();
  useLayoutEffect(() => { compatCommits++; });
  useLayoutEffect(() => () => { compatUnmounts++; }, []);
  return <output id="compat">{session.value?.identity.name}:{authenticationEpoch.value}:{identityEpoch.value}</output>;
}
const Bridge = component('SessionBridge', () => {
  compatSetup++;
  const label = computed(() => session.value?.identity.name);
  compatStop = watch(label, () => {});
  return () => element('output', { id: 'bridge' }, label.value);
});
window.mountedSafety = {
  start(id) {
    need(!root && id >= 1 && id <= 19); caseID = id; setLocale('zh-CN');
    for (const key of keys) { Reflect.apply(originals.removeItem, sessionStorage, [key]); Reflect.apply(originals.removeItem, localStorage, [key]); }
    document.cookie = 'studio-autosave=0; Path=/; SameSite=Strict';
    measurement = true;
    if (mode !== 'app') {
      session.value = identity();
      configureSaving('mounted-safety', { modes: ['local', 'branch'] });
    }
    setApiTransport(transport); root = createRoot(document.getElementById('root')); flushSync(render);
  },
  observe() {
    return { requests: jobs.length, puts: jobs.filter(j => j.kind === 'put').length, capabilities: capabilityCalls, mutations: pendingMutations.value,
      stickyGuardCalls, saveButtonGuardCalls, owners: owners.length, ownerGone: owners[0]?.gone || false, tokens: tokens.map(({ id, kind, done }) => ({ id, kind, done })),
      jobs: jobs.map(({ id, kind, released, jsonStarted, jsonReleased, requestToken, refresh }) => ({ id, kind, released, jsonStarted, jsonReleased, done: requestToken.done, refresh })),
      packsDone: packs.every(p => p.done), unhandled, unexpected, storageCalls: storage.length, storageClearCalls: storage.filter(item => item.kind === 'clear').length,
      reauth: reauthentication.value, busy: owners[0]?.read?.().busy || false, dirty: owners[0]?.read?.().dirty || false,
      portalGone: portals.every(p => !p.node.isConnected && p.children.every(c => c.gone)), unmounted };
  },
  release,
  decode(id) { const job = jobs[id - 1]; need(job?.decode && !job.jsonReleased, 'transport'); job.decode(); },
  mark() { saved = holdSnapshot(); },
  checkDraft(title, advanced) { validateDraft(title, advanced); },
  checkSubmitted() {
    const put = jobs.filter(j => j.kind === 'put'); need(put.length === 1 && same(put[0].body, { revision: 'settings-r1', changes: { title: 'Synthetic site dirty' }, saveMode: 'local' }), 'transport');
  },
  checkPreserved() {
    const value = model();
    need(saved && draft() === saved.draft && same(value.values, saved.model.values) && same(value.baseline, saved.model.baseline) && value.revision === saved.model.revision && value.dirty, 'draft');
    need(!value.error && !value.message && !value.branchPending && !value.savedBranch && !notifications.some(n => n.kind === 'saved'), 'adoption');
    need(!storage.slice(saved.storage).some(item => item.target === 'settings' || item.kind === 'clear'), 'draft');
  },
  remember() { remembered = ['[data-settings-group]', '[data-settings-group] input[name="title"]', '[data-settings-group] .settings-save-actions .save-button-main'].map(s => document.querySelector(s)); need(remembered.every(Boolean), 'identity'); },
  same() { need(remembered.every((n, i) => n.isConnected && n === document.querySelector(['[data-settings-group]', '[data-settings-group] input[name="title"]', '[data-settings-group] .settings-save-actions .save-button-main'][i])), 'identity'); },
  checkSaveAdopted() {
    const value = model();
    need(caseID === 2 && value.revision === 'settings-r2' && value.dirty && !value.busy && !value.unknown && !value.error && !value.branchPending && !value.savedBranch && value.message === 'Synthetic saved', 'adoption');
    need(notifications.filter(n => n.kind === 'saved').length === 2, 'adoption');
  },
  capturePortal(kind) {
    const selector = kind === 'save' ? '.save-mode-menu' : 'dialog.selection-dialog[open]';
    const node = document.querySelector(selector); need(node && node.isConnected && node.textContent.length > 0, 'portal');
    const wanted = kind === 'save' ? ['SaveButton'] : ['SelectionField'];
    const active = children.filter(c => wanted.includes(c.kind) && !c.gone && (kind === 'save' || c.name === 'post.today_recommend.post_path')); need(active.length === 1, 'observer');
    need(kind === 'save' ? node.textContent.includes(t('将当前方式设为默认')) : node.textContent.includes('current0'), 'portal');
    push(portals, { node, children: active }, caps.portals);
    if (kind === 'save') {
      need(saveHandlers.size === 4 && saveRead && same(saveRead(), { open: true, error: false }), 'observer');
      need(model().saveMode === 'branch' && !node.querySelector('.save-mode-default').disabled, 'observer');
      retainedSaveHandlers = new Map(saveHandlers);
    }
  },
  checkRetired() {
    need(owners.length === 1 && !document.querySelector('[data-settings-group]') && !document.querySelector('dialog.selection-dialog, .save-mode-menu'), 'retirement');
    need(portals.every(p => !p.node.isConnected && p.children.every(c => c.gone)), 'portal');
    need(boundarySnapshot && draft() === boundarySnapshot.draft && same(model().values, boundarySnapshot.model.values) && same(model().baseline, boundarySnapshot.model.baseline) && model().revision === boundarySnapshot.model.revision, 'draft');
    const original = copy(boundarySnapshot.model), current = model();
    delete original.unknown; delete current.unknown;
    delete original.busy; delete current.busy;
    need(same(original, current), 'adoption');
    if (boundarySnapshot.model.busy) need(model().busy === (latest().gone || pendingMutations.value > 0), 'busy');
    if (!latest().gone) need(document.querySelector(contract.selectors.retired) && document.querySelector(contract.selectors.exit), 'retirement');
    if (!retirementSnapshot) retirementSnapshot = holdSnapshot();
    else {
      const before = copy(retirementSnapshot.model), after = model();
      if (before.busy && !latest().gone && pendingMutations.value === 0) {
        need(!after.busy, 'busy'); delete before.busy; delete after.busy;
      }
      need(same(before, after) && notifications.length === retirementSnapshot.notifications, 'retirement');
      need(!storage.slice(retirementSnapshot.storage).some(item => item.target !== 'document'), 'draft');
    }
  },
  checkExited() {
    need(latest().gone && saved && draft() === saved.draft && same(model().values, saved.model.values) && same(model().baseline, saved.model.baseline) && model().revision === saved.model.revision, 'draft');
    need(!document.querySelector('.settings-retired, .settings-exit, .page-template-settings'), 'retirement');
    need(!storage.slice(boundarySnapshot.storage).some(item => item.kind === 'clear' || item.kind === 'removeItem'), 'draft');
    const after = notifications.slice(retirementSnapshot.notifications);
    need(after.length === 1 && after[0].owner === latest() && after[0].disposing && after[0].kind === 'dirty' && after[0].value === false, 'retirement');
  },
  boundary(kind, pack = false) {
    boundarySnapshot = holdSnapshot();
    const a = authenticationEpoch.value, i = identityEpoch.value, g = apiTransportGeneration.value, previous = session.value;
    if (kind === 'session') session.value = identity();
    else if (kind === 'identity') session.value.identity = { ...session.value.identity };
    else if (kind === 'csrf' || kind === 'expires') batch(() => { const old = session.value[kind]; session.value[kind] = kind === 'csrf' ? 'next' : old + 1; need(authenticationEpoch.value === a + 1, 'epoch'); session.value[kind] = old; need(authenticationEpoch.value === a + 2, 'epoch'); });
    else if (kind === 'id' || kind === 'method') {
      batch(() => { const old = session.value.identity[kind]; session.value.identity[kind] = kind === 'id' ? 'other' : 'oidc'; need(identityEpoch.value === i + 1, 'epoch'); session.value.identity[kind] = old; need(identityEpoch.value === i + 2, 'epoch'); if (pack) capabilityPack(); });
      return;
    }
    else if (kind === 'null') {
      batch(() => { session.value = null; need(identityEpoch.value === i + 1, 'epoch'); session.value = previous; need(identityEpoch.value === i + 2, 'epoch'); if (pack) capabilityPack(); });
      return;
    }
    else if (kind === 'same-transport') {
      batch(() => { setApiTransport(transport); need(apiTransportGeneration.value === g + 1, 'epoch'); if (pack) capabilityPack(); setApiTransport(transport); need(apiTransportGeneration.value === g + 2, 'epoch'); });
      return;
    }
    else if (kind === 'default-transport') {
      batch(() => {
        setApiTransport(); need(apiTransportGeneration.value === g + 1, 'epoch');
        if (pack) { saveButtonGuards(); capabilityPack(); }
        setApiTransport(transport); need(apiTransportGeneration.value === g + 2, 'epoch');
      });
      return;
    }
    else if (kind === 'reset') { setApiTransport(transport); need(apiTransportGeneration.value === g + 1, 'epoch'); }
    else if (kind === 'unmount') { need(!unmounted); unmounted = true; flushSync(() => root.unmount()); }
    else fail('matrix');
    if (['session', 'identity'].includes(kind)) need(authenticationEpoch.value === a + 1 && identityEpoch.value === i, 'epoch');
    if (pack) capabilityPack();
  },
  prop(kind, back = false) {
    if (!back) boundarySnapshot = holdSnapshot();
    if (kind === 'group') group = back ? 'site' : 'recommendations';
    else if (kind === 'language') language = back ? undefined : 'en'; else fail('matrix');
    flushSync(render);
  },
  pack: capabilityPack,
  checkUnknown() { const value = model(); need(!value.busy && value.dirty && value.unknown && value.revision === 'settings-r1' && same(value.baseline, initial) && !reauthentication.value && !value.error, 'adoption'); need(!notifications.some(n => n.kind === 'saved'), 'adoption'); need([...document.querySelectorAll('[role="status"]')].some(n => n.textContent.includes(t(contract.neutralMessage))), 'adoption'); },
  async checkStickySave() {
    need([5, 6, 7].includes(caseID) && !model().busy && model().unknown, 'adoption');
    const before = holdSnapshot(); stickyGuardCalls++;
    await latest().methods.save(); unchanged(before);
    need(model().unknown, 'adoption');
  },
  checkCurrentRelations() {
    need(contexts.length === 1, 'observer'); const c = contexts[0];
    need(!c.loading.value && !c.error.value && c.posts.value.length === 6 && c.posts.value.every(p => p.value.includes('current')), 'relations');
  },
  checkForcedCurrent() { const r = jobs.filter(j => j.kind === 'content').at(-1); need(r.refresh && r.csrf === session.value.csrf && r.generation === apiTransportGeneration.value, 'transport'); },
  checkCounts(expected) {
    need(storage.every(item => item.kind !== 'clear'), 'draft');
    need(jobs.length === expected.requests && jobs.filter(j => j.kind === 'put').length === expected.puts && capabilityCalls === expected.capabilities, 'counter');
    need(stickyGuardCalls === ([5, 6, 7].includes(caseID) ? 1 : 0) && saveButtonGuardCalls === (caseID === 12 ? 4 : 0), 'counter');
    need(tokens.filter(t => t.kind === 'api').length === jobs.length, 'observer');
    for (const [kind, count] of [['settings-load', expected.m], ['settings-loadRelations', expected.r], ['settings-save', expected.s]]) need(tokens.filter(t => t.kind === kind).length === count && tokens.filter(t => t.kind === kind && t.done).length === count, 'completion');
    need(tokens.filter(t => t.kind === 'request').length === jobs.length, 'observer');
    for (const [kind, count] of [['App.tsx:checkSession', 1], ['App.tsx:bootstrap', 1], ['App.tsx:loadArticles', 2], ['App.tsx:loadDashboardPreview', 1], ['components/DocumentEditor.tsx:loadDocument', caseID >= 17 ? 1 : 0], ['components/DocumentEditor.tsx:loadChoices', caseID >= 17 ? 1 : 0]]) {
      const expectedCount = mode === 'app' ? count : 0;
      need(tokens.filter(t => t.kind === kind).length === expectedCount && tokens.filter(t => t.kind === kind && t.done).length === expectedCount, 'completion');
    }
    need(!reauthentication.value && unexpected === 0 && unhandled === 0 && packs.every(p => p.done), 'retirement');
  },
  checkReloadFailure() {
    const value = model();
    need(caseID === 19 && owners.length === 1 && !latest().gone && value.dirty && value.error && value.revision === null && !value.busy && !value.unknown, 'draft');
    need(same(value.values, saved.model.values) && same(value.baseline, saved.model.baseline) && draft() === null, 'draft');
    need(!document.querySelector('[data-settings-group]') && document.querySelector(contract.selectors.errorRetry), 'ready');
    need(jobs.length === 4 && jobs.filter(j => j.kind === 'content').at(-1).refresh, 'counter');
    boundarySnapshot = holdSnapshot();
  },
  checkRetryCancelled() { need(caseID === 19 && boundarySnapshot, 'matrix'); unchanged(boundarySnapshot); },
  checkReloadRecovered() {
    const value = model();
    need(caseID === 19 && owners.length === 1 && !latest().gone && !value.dirty && !value.error && !value.unknown && value.revision === 'settings-r1' && same(value.values, initial) && same(value.baseline, initial) && draft() === null, 'draft');
    need(jobs.length === 6 && jobs.filter(j => j.kind === 'content').slice(1).every(j => j.refresh), 'counter');
    need(!notifications.some(n => n.kind === 'saved'), 'adoption');
  },
  checkGuard() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); need(event.defaultPrevented, 'guard'); },
  checkDocumentDraft() {
    window.dispatchEvent(new Event('pagehide'));
    const raw = localStorage.getItem(documentKey), value = JSON.parse(raw || 'null');
    need(value?.body === 'Synthetic saved body dirty' && value.originalBody === 'Synthetic saved body' && value.revision === 'document-r1' && same(value.values, value.baseline), 'draft');
    if (documentSnapshot === undefined) documentSnapshot = raw;
    else need(raw === documentSnapshot, 'draft');
  },
  compatRemember() { compatNodes = [document.querySelector('#compat'), document.querySelector('#bridge')]; need(compatNodes.every(Boolean), 'compatibility'); },
  compatWrite(kind) {
    const current = session.value, oldIdentity = current.identity, a = authenticationEpoch.value, i = identityEpoch.value;
    if (kind === 'name') { current.identity.name = 'Renamed'; need(authenticationEpoch.value === a && identityEpoch.value === i, 'epoch'); }
    else if (kind === 'equal') { session.value = current; current.identity = oldIdentity; current.csrf = current.csrf; current.expires = current.expires; need(session.value === current && current.identity === oldIdentity && authenticationEpoch.value === a, 'compatibility'); }
    else if (kind === 'batch') batch(() => { const old = current.csrf; current.csrf = 'next'; need(authenticationEpoch.value === a + 1, 'epoch'); current.csrf = old; need(authenticationEpoch.value === a + 2 && identityEpoch.value === i, 'epoch'); });
    else fail('matrix');
    for (const counter of [authenticationEpoch, identityEpoch, apiTransportGeneration]) need(!Reflect.set(counter, 'value', -1), 'epoch');
    need(session.value === current && current.identity === oldIdentity, 'compatibility');
  },
  compatCheck() { need(compatNodes.every((node, i) => node.isConnected && node === document.querySelector(i ? '#bridge' : '#compat')) && compatSetup === 1 && compatUnmounts === 0 && compatCommits >= 2 && document.querySelector('#bridge').textContent === session.value.identity.name && document.querySelector('#compat').textContent.startsWith(session.value.identity.name + ':'), 'compatibility'); },
  cleanup() {
    cleanup = true;
    if (root && !unmounted) { unmounted = true; try { flushSync(() => root.unmount()); } finally { this.releaseAll(); } }
    else this.releaseAll();
  },
  releaseAll() { for (const job of jobs) { if (!job.released) release(job.id, { status: 502 }); if (job.decode && !job.jsonReleased) job.decode(); } },
  forget() { for (const [name, fn] of Object.entries(originals)) Storage.prototype[name] = fn; window.removeEventListener('unhandledrejection', onUnhandled); compatStop?.(); },
};
`;
}
