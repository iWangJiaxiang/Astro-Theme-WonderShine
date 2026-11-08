import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const studio = fileURLToPath(new URL('../../', import.meta.url));

// Runs inside the fixture realm. Only fixed enums, numbers, booleans and local
// ordinals leave it. Labels and the entered draft are compared here, not exported.
function installGeometry() {
  const need = (value, code) => { if (!value) throw new Error(code); };
  const near = (a, b) => Math.abs(a - b) <= 1;
  const number = value => { need(Number.isFinite(value) && Math.abs(value) < 100000, 'geometry'); return value; };
  const box = node => {
    const r = node.getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom].map(number);
  };
  const content = node => {
    const r = box(node), s = getComputedStyle(node);
    return [r[0] + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
      r[1] + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop),
      r[2] - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight),
      r[3] - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom)].map(number);
  };
  const fragments = node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    need(rects.length > 0 && rects.length <= 32, 'label');
    return rects.map(r => [r.left, r.top, r.right, r.bottom].map(number));
  };
  const lines = rects => {
    const tops = [];
    for (const r of rects) if (!tops.some(top => near(top, r[1]))) tops.push(r[1]);
    return tops.length;
  };
  const selector = surface => surface === 'login' ? '.account-login-buttons' : '.workspace-sync-actions';
  const expected = {
    en: { login: ['Sign in with GitHub', 'Sign in with CNB'], workspace: ['Commit locally', 'Sync Git', 'Commit and synchronize'] },
    'zh-CN': { login: ['使用 GitHub 登录', '使用 CNB 登录'], workspace: ['提交到设备', '同步 Git', '提交并同步'] },
  };
  function inspect(surface, language, providers, width, platform) {
    const group = document.querySelector(selector(surface)); need(group, 'geometry');
    const buttons = [...group.children];
    const labels = surface === 'workspace' ? expected[language].workspace : expected[language].login.filter((_, i) => providers === 'both' || i === (providers === 'github' ? 0 : 1));
    need(buttons.length === labels.length && buttons.length <= 3, 'label');
    const cs = getComputedStyle(group), c = content(group), capacity = c[2] - c[0];
    const gap = surface === 'login' ? 10 : 12;
    need(cs.display === 'flex' && cs.flexWrap === 'wrap' && near(parseFloat(cs.columnGap), gap) && near(parseFloat(cs.rowGap), gap), 'gap');
    const grow = surface === 'login' || width <= 600;
    if (surface === 'workspace') need(cs.justifyContent === 'flex-end', 'alignment');
    const samples = buttons.map((button, id) => {
      need(button.tagName === 'BUTTON' && button.textContent.trim() === labels[id], 'label');
      const s = getComputedStyle(button), r = box(button), inner = content(button), text = fragments(button);
      need(s.flexBasis === 'auto' && Number(s.flexGrow) === Number(grow) && Number(s.flexShrink) === 1 && s.minInlineSize === '0px' && s.maxInlineSize === '100%' && s.whiteSpace === 'normal' && s.overflowWrap === 'anywhere', 'intrinsic');
      need(near(parseFloat(s.paddingLeft), 18) && near(parseFloat(s.paddingRight), 18) && near(parseFloat(s.paddingTop), 10) && near(parseFloat(s.paddingBottom), 10), 'padding');
      need(r[3] - r[1] >= (platform === 'android' ? 48 : platform === 'ios' ? 44 : 42) - 1, 'target');
      need(text.every(t => t[0] >= inner[0] - 1 && t[2] <= inner[2] + 1 && t[1] >= inner[1] - 1 && t[3] <= inner[3] + 1), 'label');
      // Measure the actual styled button in the same ancestry, outside flex flow.
      // Only this ephemeral clone receives measurement-only geometry overrides.
      const clone = button.cloneNode(true);
      clone.removeAttribute('id'); clone.setAttribute('aria-hidden', 'true'); clone.tabIndex = -1;
      Object.assign(clone.style, { position: 'fixed', left: '-20000px', top: '0', visibility: 'hidden', pointerEvents: 'none', flex: 'none', inlineSize: 'max-content', minInlineSize: '0', maxInlineSize: 'none' });
      let natural, naturalLines;
      try { group.append(clone); natural = number(clone.getBoundingClientRect().width); naturalLines = lines(fragments(clone)); }
      finally { clone.remove(); }
      need(natural > 0 && naturalLines === 1, 'intrinsic');
      // A whole intrinsic label that fits one group may not be compressed into
      // text wrapping to preserve an equal-width row (the old flex:1 failure).
      if (natural <= capacity + 1) need(lines(text) === 1 && r[2] - r[0] >= natural - 1, 'wrap');
      need(r[0] >= c[0] - 1 && r[2] <= c[2] + 1, 'overflow');
      return { id, box: r, natural, textLines: lines(text), disabled: button.disabled };
    });
    const predicted = [];
    let used = 0;
    for (const item of samples) {
      const size = Math.min(item.natural, capacity);
      if (!predicted.length || (used > 0 && used + gap + size > capacity + 0.02)) { predicted.push([]); used = 0; }
      predicted.at(-1).push(item.id); used += (used ? gap : 0) + size;
    }
    const rows = [];
    for (const item of samples) {
      if (!rows.length || !near(samples[rows.at(-1)[0]].box[1], item.box[1])) rows.push([]);
      rows.at(-1).push(item.id);
    }
    need(JSON.stringify(rows) === JSON.stringify(predicted), 'wrap');
    rows.forEach((row, index) => {
      const members = row.map(id => samples[id]), first = members[0], last = members.at(-1);
      need(near(last.box[2], c[2]), 'alignment');
      for (let i = 1; i < members.length; i++) need(near(members[i].box[0] - members[i - 1].box[2], gap), 'gap');
      const total = members.reduce((sum, b) => sum + Math.min(b.natural, capacity), 0) + gap * (members.length - 1);
      if (grow) {
        need(near(first.box[0], c[0]), 'grow');
        const extra = (capacity - total) / members.length;
        for (const b of members) need(near(b.box[2] - b.box[0], Math.min(b.natural, capacity) + extra), 'grow');
      } else {
        need(near(first.box[0] - c[0], capacity - total), 'alignment');
        for (const b of members) need(near(b.box[2] - b.box[0], Math.min(b.natural, capacity)), 'intrinsic');
      }
      if (index) {
        const previousBottom = Math.max(...rows[index - 1].map(id => samples[id].box[3]));
        need(near(first.box[1] - previousBottom, gap), 'gap');
      }
    });
    if (width === 1440 && surface === 'workspace') need(rows.length === 1 && samples[0].box[0] - c[0] > 12, 'alignment');
    // Check the real clipping ancestors, not just document scrollWidth.
    for (let parent = group; parent; parent = parent.parentElement) {
      const p = box(parent), s = getComputedStyle(parent);
      need(parent.scrollWidth <= parent.clientWidth + 1, 'overflow');
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX)) need(samples.every(b => b.box[0] >= p[0] - 1 && b.box[2] <= p[2] + 1), 'overflow');
      if (/(hidden|clip|auto|scroll)/.test(s.overflowY)) need(samples.every(b => b.box[1] >= p[1] - 1 && b.box[3] <= p[3] + 1), 'overflow');
    }
    need(document.documentElement.scrollWidth <= innerWidth + 1, 'overflow');
    return { surface, capacity, rows, buttons: samples };
  }
  function visible(node, focus = false) {
    need(!!node, 'visibility');
    const r = box(node), view = visualViewport;
    let left = view?.offsetLeft ?? 0, top = view?.offsetTop ?? 0;
    let right = left + (view?.width ?? innerWidth), bottom = top + (view?.height ?? innerHeight);
    for (let p = node.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p), b = box(p);
      need(s.display !== 'none' && s.visibility === 'visible' && !p.inert, 'visibility');
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX)) { left = Math.max(left, b[0] + p.clientLeft); right = Math.min(right, b[0] + p.clientLeft + p.clientWidth); }
      if (/(hidden|clip|auto|scroll)/.test(s.overflowY)) { top = Math.max(top, b[1] + p.clientTop); bottom = Math.min(bottom, b[1] + p.clientTop + p.clientHeight); }
    }
    const margin = focus ? 6 : 0;
    need(r[2] > r[0] && r[3] > r[1] && r[0] - margin >= left - 1 && r[2] + margin <= right + 1 && r[1] - margin >= top - 1 && r[3] + margin <= bottom + 1, 'visibility');
    need([[.5, .5], [.08, .08], [.92, .08], [.08, .92], [.92, .92]].every(([x, y]) => node.contains(document.elementFromPoint(r[0] + (r[2] - r[0]) * x, r[1] + (r[3] - r[1]) * y))), 'visibility');
    if (focus) {
      const s = getComputedStyle(node);
      need(node === document.activeElement && node.matches(':focus-visible') && s.outlineStyle === 'solid' && near(parseFloat(s.outlineWidth), 3) && near(parseFloat(s.outlineOffset), 3) && s.outlineColor !== 'rgba(0, 0, 0, 0)', 'focus');
    }
    return true;
  }
  window.nativeActionGeometry = {
    inspect, visible,
    target(surface) { return selector(surface); },
    focus(surface) {
      const group = document.querySelector(selector(surface)), buttons = [...group.children], active = document.activeElement;
      const id = buttons.indexOf(active);
      if (id >= 0) { need(!active.disabled, 'focus'); visible(active, true); }
      return { id, enabled: buttons.map((b, i) => b.disabled ? -1 : i).filter(i => i >= 0) };
    },
  };
}

// Fixture-only AST insertions: original statements/awaits/catches remain intact.
// Each named async function gets a synchronous token and an outer finally. The
// effect's ORIGINAL then/catch promise is observed without replacing its identity.
function observeModule(text, target) {
  const file = ts.createSourceFile(target, text, ts.ScriptTarget.Latest, true, target.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) throw new Error('bundle');
  const names = target.endsWith('api.ts') ? ['api', 'request'] : ['review', 'action'];
  const hits = new Map(names.map(name => [name, 0]));
  const edits = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && hits.has(node.name.text)) {
      const name = node.name.text;
      hits.set(name, hits.get(name) + 1);
      if (!node.body || !node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) || hits.get(name) !== 1) throw new Error('bundle');
      // Use a collision-checked local; no source printer or business rewrite.
      if (text.includes('__nativeActionCompletion')) throw new Error('bundle');
      edits.push([node.body.getStart(file) + 1, node.body.getStart(file) + 1, `\nconst __nativeActionCompletion = window.nativeActionCompletion.begin('${name}');\ntry {`]);
      edits.push([node.body.end - 1, node.body.end - 1, `\n} finally { window.nativeActionCompletion.end(__nativeActionCompletion); }\n`]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if ([...hits.values()].some(count => count !== 1)) throw new Error('bundle');
  if (!target.endsWith('api.ts')) {
    const anchor = `api<WorkspaceStatus>('/workspace').then(value => {
      if (active && sequence === requestSequence.current) setStatus(value);
    }).catch(reason => { if (active && sequence === requestSequence.current) setError(errorMessage(reason)); })`;
    const start = text.indexOf(anchor);
    if (start < 0 || text.indexOf(anchor, start + 1) !== -1) throw new Error('bundle');
    edits.push([start, start + anchor.length, `window.nativeActionCompletion.chain(window.nativeActionCompletion.begin('effect'), ${anchor})`]);
  }
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  return text;
}

const source = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import AccountLogin from './platform/AccountLogin';
import { WorkspacePanel } from './platform/WorkspacePanel';
import { setApiTransport, pendingMutations } from './src/api';
import { setLocale } from './src/i18n';
import { installMobileShell } from './platform/mobile';
// Shared main.ts imports precede the lazy NativeConnection stylesheet. Preserve
// real bytes, all @imports and asset loaders; no geometry stylesheet is invented.
import './platform/mobile.css';
import './src/style.css';
import './src/forms.css';
import './src/composer.css';
import './src/workspace.css';
import './src/creation-tools.css';
import './src/accessibility.css';
import './platform/native.css';
const need = (value, code) => { if (!value) throw new Error(code); };
const config = window.nativeActionConfig;
const status = { branch: 'main', dirty: true, changes: 1, managedChanges: ['content/a.md'], ahead: 1, behind: 0, diverged: false, head: '1'.repeat(40), remoteHead: '2'.repeat(40), lastSync: null, canSync: true };
const draft = 'docs(content): layout regression draft';
const counts = { get: 0, review: 0, unexpected: 0, started: 0, done: 0, oauth: 0, unhandled: 0 };
let saturated = false;
const count = key => { if (counts[key] >= 64) { saturated = true; throw new Error('counter'); } counts[key]++; };
let root, disposeShell, release, held = false, disposed = false, retiring = false, setDisabled;
let transportInstalled = false;
const jobs = new Set();
const faults = [];
const fault = code => { if (faults.length < 8) faults.push(code); else saturated = true; };
const unhandled = event => { event.preventDefault(); if (counts.unhandled < 64) counts.unhandled++; else saturated = true; };
const completionKinds = ['api', 'request', 'effect', 'review', 'action'];
const completions = Object.fromEntries(completionKinds.map(kind => [kind, { started: 0, done: 0 }]));
const callers = new Map();
let nextToken = 0, completionDrained = false;
// Hooks never throw or read exception objects, so original rejection identity and
// every original catch/finally are preserved, including pre-try failure paths.
window.nativeActionCompletion = {
  begin(kind) {
    completionDrained = false;
    if (!completionKinds.includes(kind) || nextToken >= 64) { saturated = true; return 0; }
    if (retiring || kind === 'action') fault('drain');
    const token = ++nextToken;
    let finish;
    const settled = new Promise(resolve => { finish = resolve; });
    callers.set(token, { kind, settled, finish }); completions[kind].started++;
    return token;
  },
  end(token) {
    const caller = callers.get(token);
    if (!caller) { fault('drain'); return; }
    completions[caller.kind].done++; callers.delete(token); caller.finish();
  },
  chain(token, promise) {
    // Observe the original full then/catch chain, not the initial api promise.
    // Return exactly that original promise. Both observer arms are nonthrowing.
    void promise.then(() => window.nativeActionCompletion.end(token), () => window.nativeActionCompletion.end(token));
    return promise;
  },
};
const completionSnapshot = () => ({ active: callers.size, drained: completionDrained,
  ...Object.fromEntries(completionKinds.flatMap(kind => [[kind + 'Started', completions[kind].started], [kind + 'Done', completions[kind].done]])) });
const rejectOAuth = () => { count('oauth'); throw new Error('oauth'); };
window.nativeActionRejectOAuth = rejectOAuth;
function messagePreserved() { return document.querySelector('.workspace-panel .field input')?.value === draft; }
function FixtureLogin() {
  const [disabled, update] = useState(false); setDisabled = update;
  return <div className="native-shell native-shell-connecting">
    {config.state === 'disabled' && <button data-edge="before" type="button">Before</button>}
    <main className="native-connect"><section className="card connection-card"><AccountLogin disabled={disabled} onSelect={rejectOAuth} /></section></main>
    {config.state === 'disabled' && <button data-edge="after" type="button">After</button>}
  </div>;
}
function show(surface) {
  need(root && !retiring, 'fixture');
  flushSync(() => root.render(surface === 'login' ? <FixtureLogin /> : <div className="studio-shell"><div className="main-shell"><main className="main-content"><WorkspacePanel /></main></div></div>));
}
window.nativeActions = {
  show,
  disable(value) { need(setDisabled && !retiring, 'fixture'); flushSync(() => setDisabled(value)); },
  release() { release?.(); },
  messagePreserved,
  snapshot() { return { ...counts, held, active: jobs.size, mutations: pendingMutations.value, disposed, saturated, completion: completionSnapshot(), faults: [...faults] }; },
  async drain() {
    retiring = true; release?.();
    await Promise.allSettled([...jobs]);
    await Promise.all([...callers.values()].map(caller => caller.settled));
    need(!held && jobs.size === 0 && counts.started === counts.done && pendingMutations.value === 0 && callers.size === 0 && completionKinds.every(kind => completions[kind].started === completions[kind].done) && completions.action.started === 0, 'drain');
    // One real task checkpoint is only a late-fault observation window. Tokens,
    // not this task turn, establish request/API/component-caller completion.
    await new Promise(resolve => setTimeout(resolve, 0));
    need(callers.size === 0 && jobs.size === 0 && !held && pendingMutations.value === 0 && completionKinds.every(kind => completions[kind].started === completions[kind].done) && completions.action.started === 0 && !saturated && faults.length === 0, 'drain');
    completionDrained = true;
  },
  dispose() {
    if (disposed) return;
    // A failed/timed-out drain must not reset transport under live callers.
    need(completionDrained && callers.size === 0 && jobs.size === 0 && !held && pendingMutations.value === 0, 'drain');
    try { root?.unmount(); } catch { fault('cleanup'); }
    try { disposeShell?.(); } catch { fault('cleanup'); }
    try { if (transportInstalled) setApiTransport(); } catch { fault('cleanup'); }
    window.removeEventListener('unhandledrejection', unhandled);
    disposed = true;
  },
};
window.addEventListener('unhandledrejection', unhandled);
setLocale(config.locale);
disposeShell = installMobileShell(true);
setApiTransport((path, init) => {
  count('started');
  const operation = (async () => {
    need(!retiring, 'drain');
    if (path === '/workspace' && init.method === 'GET') { count('get'); return new Response(JSON.stringify(status)); }
    if (path === '/workspace/review' && init.method === 'POST' && config.state === 'review' && counts.review === 0) {
      count('review'); held = true;
      await new Promise(resolve => { release = () => { held = false; release = null; resolve(); }; });
      return new Response(JSON.stringify({ ...status, confirmation: 'layout-review-only' }));
    }
    count('unexpected'); throw new Error('transport');
  })();
  jobs.add(operation);
  void operation.finally(() => { try { count('done'); } finally { jobs.delete(operation); } }).catch(() => {});
  return operation;
});
transportInstalled = true;
(${installGeometry.toString()})();
root = createRoot(document.getElementById('root'));
show(config.state === 'review' ? 'workspace' : 'login');
`;

export async function bundleNativeActions() {
  const variants = new Map();
  for (const providers of ['both', 'github', 'cnb']) {
    let fetchHits = 0, openerHits = 0, apiHits = 0, workspaceHits = 0;
    const fixture = await build({
      stdin: { contents: source, resolveDir: studio, loader: 'tsx', sourcefile: 'native-actions-layout-fixture.tsx' },
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', outdir: 'native-actions-layout-fixture', logLevel: 'silent',
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env.VITE_STUDIO_GITHUB_CLIENT_ID': JSON.stringify(providers === 'cnb' ? '' : 'layout-github'),
        'import.meta.env.VITE_STUDIO_CNB_CLIENT_ID': JSON.stringify(providers === 'github' ? '' : 'layout-cnb'),
      },
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.eot': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.gif': 'dataurl' },
      plugins: [{ name: 'native-actions-exact-oauth-boundaries', setup(builder) {
        builder.onLoad({ filter: /[/\\](api\.ts|WorkspacePanel\.tsx)$/ }, async ({ path }) => {
          const isApi = path === join(studio, 'src/api.ts');
          const isWorkspace = path === join(studio, 'platform/WorkspacePanel.tsx');
          if ((!isApi && !isWorkspace) || (isApi ? ++apiHits : ++workspaceHits) !== 1) throw new Error('bundle');
          return { contents: observeModule(await readFile(path, 'utf8'), path), loader: isApi ? 'ts' : 'tsx', resolveDir: isApi ? join(studio, 'src') : join(studio, 'platform') };
        });
        builder.onLoad({ filter: /[/\\]provider-fetch\.ts$/ }, ({ path }) => {
          if (path !== join(studio, 'platform/provider-fetch.ts') || ++fetchHits !== 1) throw new Error('bundle');
          return { contents: 'export const providerFetch = (...args) => window.nativeActionRejectOAuth();', loader: 'js' };
        });
        builder.onResolve({ filter: /^@tauri-apps\/plugin-opener$/ }, ({ importer }) => {
          if (importer !== join(studio, 'platform/AccountLogin.tsx') || ++openerHits !== 1) throw new Error('bundle');
          return { path: 'opener', namespace: 'native-actions-opener' };
        });
        builder.onLoad({ filter: /^opener$/, namespace: 'native-actions-opener' }, () => ({ contents: 'export const openUrl = async () => window.nativeActionRejectOAuth();', loader: 'js' }));
      } }],
    });
    if (fetchHits !== 1 || openerHits !== 1 || apiHits !== 1 || workspaceHits !== 1 || fixture.outputFiles.length !== 2) throw new Error('bundle');
    const js = fixture.outputFiles.find(file => file.path.endsWith('.js'))?.text;
    const css = fixture.outputFiles.find(file => file.path.endsWith('.css'))?.text;
    if (!js || !css || /@import\s/i.test(css)) throw new Error('css');
    for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)/gi)) if (!match[1].startsWith('data:')) throw new Error('css');
    variants.set(providers, { js, css });
  }
  return variants;
}
