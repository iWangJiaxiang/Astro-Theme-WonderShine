import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// Non-executable helper. No runner, product bundle, image encoder or DOM substitute.
export const SIZES = Object.freeze([[320, 568], [844, 390], [390, 844]].map(Object.freeze));
export const REPOSITORY_PATH = 'public/img/residual-fixture/long-directory-segment-alpha-0123456789/long-directory-segment-beta-0123456789/long-directory-segment-gamma-0123456789/tail-evidence.svg';
export const SITE_PATH = '/' + REPOSITORY_PATH.slice(7);
export const PNG_SLOTS = Object.freeze(['initial', ...Array.from({ length: 8 }, (_, i) => `down-${String(i + 1).padStart(2, '0')}`), 'return-top', 'keyboard-last', 'failure']);
export const CAPS = Object.freeze({ workerMs: 90000, parentMs: 143000, slices: [35000, 35000, 10000], pending: 32, wheels: 18, tabs: 6, clicks: 2, hovers: 18, samples: 128, controllerSamples: 32, events: 64, controllerEvents: 16, pngBytes: 2097152, pngs: 12, mediaBytes: 393216, controllerBytes: 32768, summaryBytes: 32768, totalReportBytes: 851968 });
export const REQUEST_CAPS = Object.freeze([1, 1, 2, 1, 2, 1, 1, 2]);
// counts: wheels, tabs, clicks, hovers, readiness, harness focus, harness scroll,
// page errors, warnings, dialogs, external, mutations, GET/HEAD, data/blob,
// request finished, request failed, peak tracked operations.
export const COUNT = Object.freeze({ wheel: 0, tab: 1, click: 2, hover: 3, ready: 4, focus: 5, scroll: 6, page: 7, warning: 8, dialog: 9, external: 10, mutation: 11, get: 12, local: 13, finished: 14, failed: 15, peak: 16 });
export function need(value, code = 'probe') { if (!value) throw new Error(code); }

export async function fixtureSite(site, call) {
  need(REPOSITORY_PATH.length === 164 && SITE_PATH.length === 158, 'fixture');
  const files = [
    ['config.toml', 'title="Residual evidence fixture"\nbase_url="https://example.com"\ndefault_language="en"\n'],
    ['data.toml', '[post]\ntags=[]\ncategories=[]\n'],
    ['content/articles/example/index.md', '+++\ntitle="Example"\ndraft=true\n+++\nFictitious content.\n'],
    [REPOSITORY_PATH, '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64"><rect width="96" height="64" fill="#345678"/><path d="M0 64 48 0 96 64Z" fill="#abcdef"/></svg>'],
  ];
  for (const [name, text] of files) {
    await call(() => mkdir(dirname(join(site, name)), { recursive: true }));
    await call(() => writeFile(join(site, name), text));
  }
}

// This function is installed only after the real component has selected the SVG.
// All media DOM operations below are observational: no focus/style/scroll writes.
function installMediaProbe(repository, site, width, height) {
  const check = value => { if (!value) throw new Error('probe'); };
  const originalDocument = document;
  const details = document.querySelector('.media-library .media-details');
  const tiles = [...document.querySelectorAll('.media-library .media-card')].filter(n => n.dataset.mediaPath === repository);
  check(details && tiles.length === 1);
  const tile = tiles[0], image = details.querySelector('img');
  const back = details.querySelector(':scope > .media-details-back');
  const buttons = [...details.querySelectorAll(':scope > .row > button')];
  const dd = [...details.querySelectorAll(':scope > dl > dd')];
  check(dd.length === 3 && buttons.length === 2 && back && image);
  const paths = dd.slice(1), expected = [repository, site];
  const owner = document.scrollingElement;
  const ids = new WeakMap(); let next = 0;
  const id = node => { if (!node) return 0; if (!ids.has(node)) { check(next < 4096); ids.set(node, ++next); } return ids.get(node); };
  const role = node => [details, back, ...buttons, tile].indexOf(node) + 1;
  const events = []; let wheels = 0, tabs = 0, clicks = 0, focus = 0, nonownerFaults = 0;
  let expectedWheel = null, expectedKey = null, originalLayout = null;
  let hoverPoint = [0, 0, 0]; // Last direct point and validated main-content hit enum.
  const scan = () => {
    const nodes = [...document.querySelectorAll('*')]; check(nodes.length <= 2048);
    const scrollables = nodes.filter(n => n !== owner && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) && /(auto|scroll|hidden|clip|overlay)/.test(getComputedStyle(n).overflow + getComputedStyle(n).overflowX + getComputedStyle(n).overflowY));
    check(scrollables.length <= 64); return scrollables;
  };
  const nonowners = scan().map(n => [n, n.scrollLeft, n.scrollTop]);
  const scanScroll = () => {
    for (const [n, x, y] of nonowners) if (!n.isConnected || n.scrollLeft !== x || n.scrollTop !== y) nonownerFaults++;
    for (const n of scan()) if (!nonowners.some(([old]) => old === n)) nonownerFaults++;
    check(nonownerFaults === 0 && scrollX === 0 && owner.scrollLeft === 0);
  };
  const record = (kind, event, delta = 0) => {
    check(events.length < 64);
    events.push([kind, role(event.target), Number(event.isTrusted), delta]);
  };
  const onWheel = event => {
    wheels++; record(0, event, event.deltaY);
    if (!event.isTrusted || event.deltaY !== expectedWheel || !validHit(event.target)) nonownerFaults++;
  };
  const onKey = event => { if (event.key === 'Tab') { tabs++; record(1, event, Number(event.shiftKey)); if (!event.isTrusted || expectedKey !== Number(event.shiftKey)) nonownerFaults++; } else if (event.key !== 'Shift' || !event.isTrusted || expectedKey !== 1) nonownerFaults++; };
  const onClick = event => { clicks++; record(2, event); };
  const onFocus = event => { focus++; record(3, event); };
  const onScroll = () => { try { scanScroll(); } catch { nonownerFaults++; } };
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('focusin', onFocus, true);
  document.addEventListener('scroll', onScroll, true);
  function validHit(node) {
    if (!(node instanceof Element) || !node.closest('.main-content') || node.closest('.sidebar,.topbar,dialog,[inert]')) return false;
    let n = node;
    while (n && n !== owner) {
      const css = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(css.overflowY) && n.scrollHeight > n.clientHeight + 1) return false;
      n = n.parentElement;
    }
    return n === owner;
  }
  const rect = n => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const visibleStyle = n => {
    const css = getComputedStyle(n);
    check(css.display !== 'none' && !['hidden', 'collapse'].includes(css.visibility) && Number(css.opacity) > 0 && !n.closest('[inert],[hidden]'));
    return css;
  };
  const clip = n => {
    const v = visualViewport;
    const result = [Math.max(0, v.offsetLeft), Math.max(0, v.offsetTop), Math.min(innerWidth, v.offsetLeft + v.width), Math.min(innerHeight, v.offsetTop + v.height)];
    let count = 0;
    for (let p = n; p; p = p.parentElement) {
      check(++count <= 32); const css = visibleStyle(p), r = p.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip|overlay)/.test(css.overflowX)) { result[0] = Math.max(result[0], r.left + p.clientLeft); result[2] = Math.min(result[2], r.left + p.clientLeft + p.clientWidth); }
      if (/(auto|scroll|hidden|clip|overlay)/.test(css.overflowY)) { result[1] = Math.max(result[1], r.top + p.clientTop); result[3] = Math.min(result[3], r.top + p.clientTop + p.clientHeight); }
      check(p.scrollWidth <= p.clientWidth + 1);
    }
    return result;
  };
  const inClip = (r, c, padding = 0) => r.left - padding >= c[0] - 1 && r.top - padding >= c[1] - 1 && r.right + padding <= c[2] + 1 && r.bottom + padding <= c[3] + 1;
  const hits = (n, r, five = false) => {
    const points = five ? [[.1, .1], [.9, .1], [.5, .5], [.1, .9], [.9, .9]] : [[.05, .5], [.5, .5], [.95, .5]];
    return points.every(([x, y]) => { const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y); return hit && (hit === n || n.contains(hit)); });
  };
  const geometry = () => paths.map((n, pathIndex) => {
    check(n.textContent === expected[pathIndex] && n.childNodes.length === 1 && n.firstChild.nodeType === Node.TEXT_NODE);
    const css = visibleStyle(n), box = n.getBoundingClientRect();
    check(css.textOverflow !== 'ellipsis' && (css.webkitLineClamp === 'none' || css.webkitLineClamp === '0') && n.scrollWidth <= n.clientWidth + 1);
    const all = document.createRange(); all.selectNodeContents(n);
    const lines = [...all.getClientRects()].filter(r => r.width > 0 && r.height > 0); check(lines.length > 0 && lines.length <= 64);
    const left = box.left + n.clientLeft + parseFloat(css.paddingLeft), right = box.left + n.clientLeft + n.clientWidth - parseFloat(css.paddingRight);
    for (const r of lines) check(r.left >= left - 1 && r.right <= right + 1);
    const c = clip(n), chars = [], bits = [];
    for (let i = 0; i < expected[pathIndex].length; i++) {
      const range = document.createRange(); range.setStart(n.firstChild, i); range.setEnd(n.firstChild, i + 1);
      const rs = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0); check(rs.length === 1);
      const r = rs[0], line = lines.find(l => r.top >= l.top - 1 && r.bottom <= l.bottom + 1 && r.left >= l.left - 1 && r.right <= l.right + 1);
      check(line); chars.push([r.left + scrollX, r.top + scrollY, r.width, r.height]);
      // Count a character only when its WHOLE line survives clipping and hit tests.
      bits.push(Number(inClip(line, c) && hits(n, line)));
    }
    return { lines: lines.length, chars, bits };
  });
  function state(phase) {
    check(document === originalDocument && details.isConnected && tile.isConnected && image.isConnected && paths.every(n => n.isConnected));
    check(document.querySelector('.media-library .media-details') === details && tile.classList.contains('selected') && tile.getAttribute('aria-pressed') === 'true' && !tile.disabled);
    check(document.querySelectorAll('.media-library .media-card').length === 1 && details.querySelector('img') === image && [...details.querySelectorAll(':scope > dl > dd')].every((n, i) => n === dd[i]) && details.querySelectorAll(':scope > dl > dd').length === 3);
    check(details.querySelector(':scope > .media-details-back') === back && buttons.every((n, i) => n.isConnected && !n.disabled && details.querySelectorAll(':scope > .row > button')[i] === n) && details.querySelectorAll(':scope > .row > button').length === 2);
    check(image.complete && image.naturalWidth === 96 && image.naturalHeight === 64 && !details.querySelector('input,[role="status"]'));
    check(document.hasFocus() && !document.querySelector('dialog[open],.sidebar-backdrop') && !document.querySelector('[aria-busy="true"],.loading-panel,.error'));
    check(innerWidth === width && innerHeight === height && Math.abs(visualViewport.scale - 1) <= .001);
    check(Math.abs(scrollY - owner.scrollTop) <= 1 && nonownerFaults === 0 && clicks === 0);
    scanScroll();
    const sidebar = document.querySelector('.sidebar'); check(sidebar);
    const s = getComputedStyle(sidebar), sr = sidebar.getBoundingClientRect();
    check(!sidebar.getAnimations({ subtree: true }).some(a => a.playState === 'running'));
    if (width === 320) check(sidebar.inert && (sr.right <= 0 || sr.left >= innerWidth));
    else check(!sidebar.inert && !sidebar.classList.contains('open') && s.position === 'fixed' && s.transform === 'none' && sr.left === 0 && sr.right > 0 && sr.right < innerWidth);
    const unlocked = !['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY) && !['hidden', 'clip'].includes(getComputedStyle(document.documentElement).overflowY);
    check(unlocked);
    const g = geometry();
    const layout = g.flatMap(p => p.chars.flat());
    if (originalLayout) check(layout.length === originalLayout.length && layout.every((n, i) => Math.abs(n - originalLayout[i]) <= 1));
    else originalLayout = layout;
    if (width === 320) check(g[0].lines > 1);
    const active = document.activeElement, css = getComputedStyle(active);
    const vv = visualViewport;
    check(vv.width === width && vv.height === height && vv.offsetLeft === 0 && vv.offsetTop === 0 && Math.abs(vv.pageTop - scrollY) <= 1);
    const color = css.outlineColor;
    const alpha = color !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$|\/\s*0(?:\.0+)?\s*\)$/.test(color);
    const sample = [phase, scrollX, scrollY, Math.max(0, owner.scrollHeight - owner.clientHeight), innerWidth, innerHeight, visualViewport.scale, role(active), wheels, tabs, clicks, focus, id(details), id(tile), id(owner), nonownerFaults, g[0].lines, g[1].lines, Number(unlocked), width === 320 ? 0 : 1,
      ...[details, back, ...buttons, tile, ...paths].flatMap(rect), parseFloat(css.outlineWidth) || 0, parseFloat(css.outlineOffset) || 0, Number(css.outlineStyle === 'solid'), Number(alpha), vv.width, vv.height, vv.offsetLeft, vv.offsetTop, vv.pageTop, ...hoverPoint];
    check(sample.length === 60 && sample.every(Number.isFinite));
    return { sample, bits: g.map(p => p.bits), layout };
  }
  window.__residualMedia = {
    read: state,
    point() {
      for (const [x, y] of [[.5, .55], [.8, .55], [.5, .8]]) {
        const point = [x * innerWidth, y * innerHeight];
        if (validHit(document.elementFromPoint(...point))) return point;
      }
      throw new Error('wheel');
    },
    armWheel(x, y, delta) { check(validHit(document.elementFromPoint(x, y))); hoverPoint = [x, y, 1]; expectedWheel = delta; },
    armKey(reverse) { expectedKey = Number(reverse); },
    async settle() {
      let previous = null, same = 0;
      for (let i = 0; i < 90; i++) {
        await new Promise(done => requestAnimationFrame(done));
        const now = [scrollX, scrollY, owner.scrollHeight, ...rect(details)];
        same = previous && now.every((n, k) => Math.abs(n - previous[k]) <= .01) ? same + 1 : 0;
        if (i >= 7 && same >= 5) return true;
        previous = now;
      }
      return false;
    },
    tail() {
      const r = details.getBoundingClientRect(), b = buttons[1].getBoundingClientRect();
      check(inClip(b, clip(buttons[1])) && hits(buttons[1], b, true) && r.bottom <= visualViewport.offsetTop + visualViewport.height + 1 && r.bottom > 0);
    for (const x of [.05, .5, .95]) { const hit = document.elementFromPoint(r.left + r.width * x, r.bottom - 2); check(hit && (hit === details || details.contains(hit))); }
      return true;
    },
    keyboard(expectedRole) {
      const active = document.activeElement;
      check(role(active) === expectedRole && active instanceof HTMLButtonElement && !active.disabled && !active.closest('[inert]') && active.matches(':focus-visible'));
      const css = visibleStyle(active), r = active.getBoundingClientRect();
      const outline = parseFloat(css.outlineWidth), offset = parseFloat(css.outlineOffset);
      check(outline > 0 && css.outlineStyle === 'solid' && css.outlineColor !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$|\/\s*0(?:\.0+)?\s*\)$/.test(css.outlineColor));
      // Outward outlines are clipped by ancestors/viewport, not the button's
      // own overflow-hidden client box. Text/content clip(n) stays unchanged.
      check(active.parentElement && r.width > 0 && r.height > 0);
      const outlineClip = clip(active.parentElement);
      check(inClip(r, outlineClip) && inClip(r, outlineClip, Math.max(0, outline + offset)) && hits(active, r, true));
      if (expectedRole === 5) check(outline === 2 && offset === 1);
      return true;
    },
    events: () => events.map(e => [...e]),
    dispose() {
      window.removeEventListener('wheel', onWheel, true); window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('click', onClick, true); window.removeEventListener('focusin', onFocus, true); document.removeEventListener('scroll', onScroll, true);
      return true;
    },
  };
  state(0);
}

export async function mediaCase(context) {
  const { page, client, report, directory, call, reserve } = context;
  const [width, height] = SIZES[report.index];
  const evaluate = (fn, ...args) => call(() => page.evaluate(fn, ...args));
  await call(() => client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true }));
  await call(() => client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }));
  await call(() => client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }));
  await call(() => page.waitForFunction(path => [...document.querySelectorAll('.media-card')].filter(n => n.dataset.mediaPath === path).length === 1, {}, REPOSITORY_PATH));
  const tile = await call(() => page.$(`.media-card[data-media-path="${REPOSITORY_PATH}"]`));
  need(tile, 'open');
  try {
    reserve(COUNT.click, 2);
    await call(() => tile.click()); // One real setup activation; no retry.
  } finally { await call(() => tile.dispose()); }
  await call(() => page.waitForFunction(() => document.activeElement === document.querySelector('.media-details') && document.querySelector('.media-details img')?.complete));
  await evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  await evaluate(installMediaProbe, REPOSITORY_PATH, SITE_PATH, width, height);
  let last;
  const read = async phase => {
    need(report.samples.length < CAPS.samples, 'counter');
    const ordinal = report.samples.length;
    report.samples.push(Array(60).fill(0)); // Reserve before the observational RPC.
    const result = await evaluate(phase => window.__residualMedia.read(phase), phase);
    report.samples[ordinal] = result.sample; last = result; return result;
  };
  const settle = async () => need(await evaluate(() => window.__residualMedia.settle()), 'wheel');
  const capture = async slot => {
    need(report.pngs.length < CAPS.pngs && !report.pngs.some(p => p.slot === slot), 'screenshot');
    // Reserve the slot before dispatch. Never repair metrics or retry capture.
    const entry = { slot, bytes: 0, coverage: [[], []] }; report.pngs.push(entry);
    const pre = await read(slot);
    const raw = await call(() => client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
    // FIRST operation after capture is observational. No Emulation reassertion.
    const post = await read(slot);
    need(pre.sample.every((n, i) => Math.abs(n - post.sample[i]) <= (i === 6 ? .001 : [2, 3, 56].includes(i) || (i >= 20 && i < 48) ? 1 : 0)) && JSON.stringify(pre.bits) === JSON.stringify(post.bits) && pre.layout.length === post.layout.length && pre.layout.every((n, i) => Math.abs(n - post.layout[i]) <= 1), 'identity');
    const bytes = Buffer.from(raw.data, 'base64');
    need(bytes.length <= CAPS.pngBytes && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height, 'screenshot');
    const file = join(directory, PNG_SLOTS[slot] + '.png');
    await call(() => writeFile(file, bytes, { flag: 'wx' }));
    need((await call(() => stat(file))).size === bytes.length, 'screenshot');
    entry.bytes = bytes.length; entry.coverage = pre.bits;
  };
  await capture(0); report.phases[0] = true;
  const wheel = async delta => {
    const before = await read(delta > 0 ? 20 : 21);
    const beforeEvents = await evaluate(() => window.__residualMedia.events());
    need(before.sample[7] === 1, 'identity');
    const point = await evaluate(() => window.__residualMedia.point());
    reserve(COUNT.hover, 18); await call(() => page.mouse.move(...point));
    await evaluate((point, delta) => window.__residualMedia.armWheel(...point, delta), point, delta);
    reserve(COUNT.wheel, 18); await call(() => page.mouse.wheel({ deltaY: delta }));
    await settle(); const after = await read(delta > 0 ? 20 : 21);
    need(after.sample[8] === before.sample[8] + 1 && after.sample[9] === before.sample[9] && after.sample[11] === before.sample[11] && Math.abs(after.sample[3] - before.sample[3]) <= 1, 'wheel');
    const afterEvents = await evaluate(() => window.__residualMedia.events());
    need(afterEvents.length === beforeEvents.length + 1 && afterEvents.at(-1)[0] === 0 && afterEvents.at(-1)[2] === 1 && afterEvents.at(-1)[3] === delta, 'wheel');
    return after.sample[2] - before.sample[2];
  };
  let movedDown = false, tail = false;
  for (let i = 0; i < 8; i++) {
    const delta = await wheel(160); movedDown ||= delta > 1;
    need(delta > 1 || last.sample[3] - last.sample[2] <= 1, 'wheel');
    await capture(i + 1);
    if (last.sample[3] - last.sample[2] <= 1) { tail = true; break; }
  }
  need(tail && movedDown, 'wheel-range');
  need(await evaluate(() => window.__residualMedia.tail()), 'tail');
  for (let p = 0; p < 2; p++) {
    const length = p ? 158 : 164;
    need(Array.from({ length }, (_, i) => report.pngs.some(png => png.coverage[p][i] === 1)).every(Boolean), 'path');
  }
  need(Math.abs(await wheel(160)) <= 1 && last.sample[3] - last.sample[2] <= 1, 'edge');
  need(await evaluate(() => window.__residualMedia.tail()), 'tail'); report.phases[1] = true;
  let movedUp = false;
  for (let i = 0; i < 8 && last.sample[2] > 1; i++) { const delta = await wheel(-160); movedUp ||= delta < -1; need(delta < -1 || last.sample[2] <= 1, 'wheel'); }
  need(movedUp && last.sample[2] <= 1, 'top');
  need(Math.abs(await wheel(-160)) <= 1 && last.sample[2] <= 1, 'edge');
  await capture(9); report.phases[2] = true;
  const expected = [2, 3, 4, 3, 2, 5];
  for (let i = 0; i < expected.length; i++) {
    const reverse = i >= 3, before = await read(22);
    await evaluate(reverse => window.__residualMedia.armKey(reverse), reverse);
    reserve(COUNT.tab, 6);
    if (reverse) await call(() => page.keyboard.down('Shift'));
    await call(() => page.keyboard.press('Tab'));
    if (reverse) await call(() => page.keyboard.up('Shift'));
    await settle(); need(await evaluate(role => window.__residualMedia.keyboard(role), expected[i]), 'keyboard');
    const after = await read(22); need(after.sample[9] === before.sample[9] + 1 && after.sample[11] === before.sample[11] + 1 && after.sample[7] === expected[i], 'keyboard');
    if (i === 2) { await capture(10); report.phases[3] = true; }
  }
  report.phases[4] = true;
  report.events = await evaluate(() => window.__residualMedia.events());
  need(report.events.filter(e => e[0] === 1).length === 6 && report.events.filter(e => e[0] === 3).map(e => e[1]).join(',') === expected.join(','), 'keyboard');
  need(await evaluate(() => window.__residualMedia.dispose()), 'cleanup');
}

// One realm, one real factory, one remember/enter. No business code is executed
// by source-only validation; this loader runs only in the remote worker.
export async function controllerCase({ page, report, call, reserve, studio }) {
  const sourceFile = join(studio, 'src/navigation-position.ts');
  need((await call(() => stat(sourceFile))).size <= 16384, 'controller');
  const source = await call(() => readFile(sourceFile, 'utf8'));
  need(Buffer.byteLength(source) <= 16384 && !/^\s*import\b/m.test(source), 'controller');
  const module = stripTypeScriptTypes(source, { mode: 'strip' });
  await call(() => page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }));
  await call(() => page.setContent('<!doctype html><style>body{margin:0}#app{min-height:2400px}#remembered-target{position:absolute;top:640px}</style><button id="outside-target">Outside fixture</button><div id="app"><main class="main-content"><h1 id="destination-heading" tabindex="-1">Destination fixture</h1><button id="remembered-target">Remembered fixture</button><div class="loading-panel" id="readiness-gate"></div><div id="mutation-slot"></div></main></div>'));
  await call(() => page.addScriptTag({ type: 'module', content: module + '\nwindow.__residualFactory = navigationPosition;' }));
  await call(() => page.waitForFunction(() => typeof window.__residualFactory === 'function'));
  reserve(COUNT.focus, 2); reserve(COUNT.focus, 2);
  reserve(COUNT.scroll, 3); reserve(COUNT.scroll, 3); reserve(COUNT.scroll, 3);
  const evidence = await call(() => page.evaluate(async () => {
    const check = value => { if (!value) throw new Error('controller'); };
    const originalDocument = document, target = document.getElementById('remembered-target'), heading = document.getElementById('destination-heading'), outside = document.getElementById('outside-target');
    const gate = document.getElementById('readiness-gate');
    const controller = window.__residualFactory(), events = [], samples = [], phases = Array(8).fill(false);
    let entered = false;
    const onEvent = e => { if (!entered) return; check(events.length < 16); events.push([e.type === 'focusin' ? 3 : 4, e.target === target ? 1 : e.target === heading ? 2 : e.target === outside ? 3 : 0, Number(e.isTrusted), 0]); };
    const types = ['focusin', 'wheel', 'touchstart', 'pointerdown', 'keydown'];
    types.forEach(type => window.addEventListener(type, onEvent, true));
    const frame = () => new Promise(done => requestAnimationFrame(done));
    const sample = phase => {
      check(samples.length < 32 && document === originalDocument && target.isConnected && target.ownerDocument === originalDocument && !target.closest('[inert]') && heading.isConnected && document.hasFocus() && scrollX === 0 && document.documentElement.scrollHeight - innerHeight + 1 >= 480 && !document.querySelector('dialog[open]'));
      check(document.getElementById('remembered-target') === target && document.getElementById('destination-heading') === heading && (phase <= 2 ? gate.isConnected && gate.matches('.main-content .loading-panel') : !gate.isConnected));
      const row = [phase, scrollY, document.activeElement === target ? 1 : document.activeElement === heading ? 2 : document.activeElement === outside ? 3 : 0, Number(document === originalDocument), Number(target.isConnected), document.documentElement.scrollHeight, events.length, 0]; samples.push(row); return row;
    };
    const hold = async (phase, frames, y, role) => {
      for (let i = 0; i < frames; i++) { await frame(); check(Math.abs(scrollY - y) <= 1 && (role === 1 ? document.activeElement === target : document.activeElement === outside)); }
      sample(phase); phases[phase] = true;
    };
    target.focus({ preventScroll: true }); window.scrollTo(0, 480);
    await hold(0, 8, 480, 1); controller.remember('fixture');
    outside.focus({ preventScroll: true }); window.scrollTo(0, 64);
    await hold(1, 8, 64, 3); entered = true; controller.enter('fixture', true);
    await hold(2, 8, 64, 3); check(events.length === 0);
    document.getElementById('readiness-gate').remove();
    let restored = false;
    for (let i = 0; i < 90; i++) { await frame(); check(document.activeElement !== heading); if (document.activeElement === target && Math.abs(scrollY - 480) <= 1) { restored = true; break; } }
    check(restored && events.length === 1 && events[0][0] === 3 && events[0][1] === 1); sample(3); phases[3] = true;
    await hold(4, 8, 480, 1);
    // No focus/input/clear/dispose/enter after restoration until ALL challenges end.
    window.scrollTo(0, 160); await hold(5, 8, 160, 1);
    const mutation = document.createElement('span'); mutation.hidden = true;
    document.getElementById('mutation-slot').append(mutation); await hold(6, 8, 160, 1);
    mutation.remove(); await hold(7, 8, 160, 1);
    check(events.length === 1); controller.dispose();
    types.forEach(type => window.removeEventListener(type, onEvent, true));
    return { samples, events, phases };
  }), 9000);
  report.samples = evidence.samples; report.events = evidence.events; report.phases = evidence.phases;
}
