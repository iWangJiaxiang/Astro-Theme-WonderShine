// Remote only: after studio:build, run npx tsx apps/studio/tests/browser/gesture-diagnostics.mjs.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareBrowserFixture } from './site-fixture.mjs';
import { hashPassword } from '../../server/password.ts';
import { configureViewport, exerciseScroll, exercisePinch, inspectGestureEnvironment } from './ui-audit-gestures.mjs';

const studio = fileURLToPath(new URL('../../', import.meta.url)), output = join(studio, 'test-results/gesture-diagnostics');
const base = await mkdtemp(join(tmpdir(), 'studio-gesture-diagnostics-')), site = join(base, 'site');
const started = Date.now(), password = randomBytes(24).toString('hex');
const report = { viewport:[390,844], startedAt:new Date().toISOString(), surfaces:['static','login','chooser'].map(id => ({id,status:'not-run'})), errors:[], limitations:[
  'Headless Chromium/CDP only; not physical touch, Safari, native WebView or OS zoom evidence.',
  'Unchanged audit helpers sample one largest eligible scroller, including overflow-hidden document roots. Static nested scrolling is additionally dispatched independently.',
  'Protocol returned means command completion, not gesture success. Baseline failures remain failures even if independent dispatch works; cleanup never counts as restoration.',
  'Passive capture listeners count trusted/untrusted delivery and retain at most 120 geometry-only scroll/focus events per phase; no values, HTML, text or URLs are collected.',
  'Event buckets are document-wide time windows, not per-command or per-target attribution; delayed events can cross phases and a 250ms settle window does not prove inertia ended.',
  'Browser command-line values and positional arguments are redacted except selected diagnostic flags. No CDP Tracing is collected.',
  'Chooser setup authenticates the fixture via HTTP and programmatically opens navigation/disclosures; it is not pointer-navigation, disclosure or login UX acceptance. Only the chooser trigger uses a pointer click.',
] };
let browser, page, raw, client, server, phase = 'setup', active, touchState = 'idle';
const errorKind = error => error?.name || 'Error'; // Do not persist exception messages that could contain URLs or credentials.
function safeBaseline(value) {
  // Shared helpers also catch page/evaluation errors outside our CDP wrapper.
  // Keep all statuses/findings/geometry, but never persist their raw messages.
  if (Array.isArray(value)) return value.map(safeBaseline);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,entry]) =>
    [key,key === 'message' ? '<redacted diagnostic error>' : safeBaseline(entry)]));
  return value;
}
async function save() {
  report.elapsedSeconds = Math.round((Date.now()-started)/1000);
  report.failed = report.errors.length > 0 || report.surfaces.some(s => s.status !== 'passed');
  await mkdir(output,{recursive:true});
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  const rows = report.surfaces.map(s => `| ${s.id} | ${s.status} | ${s.baselineScroll?.results.map(r => `${r.method}: ${r.status}`).join(', ') || 'not-run'} | ${s.baselinePinch?.status || 'not-run'} | ${s.drags?.map(r => `${r.id}: ${r.status}`).join(', ') || 'not-run'} | ${s.dispatchPinch?.status || 'not-run'} | ${s.snapshot ? `[snapshot](${s.snapshot})` : 'not-captured'} |`);
  await writeFile(join(output,'report.md'),`# Remote gesture diagnostics\n\nElapsed: ${report.elapsedSeconds}s; failed: ${report.failed}.\n\n| Surface | Overall | Synthetic scroll (includes wheel) | Synthetic pinch | Dispatch drag | Dispatch pinch | Initial snapshot |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\nSee report.json for genuine before/after geometry, per-phase events, CDP returned statuses, cleanup and errors. A missing result is not a pass.\n\n${report.limitations.map(s => `- ${s}`).join('\n')}\n`);
}
function installObserver() {
  window.__gestureDiagnostics?.stop();
  const controller = new AbortController();
  let counts = {}, trace = [], dropped = 0;
  const ids = new WeakMap(); let next = 0;
  const identify = node => {
    if (node === document) node = document.scrollingElement;
    if (!(node instanceof Element)) return null;
    if (!ids.has(node)) ids.set(node,++next);
    return {id:ids.get(node),tag:node.tagName,top:node.scrollTop,left:node.scrollLeft};
  };
  const visual = () => ({scale:visualViewport?.scale ?? 1,width:visualViewport?.width ?? innerWidth,height:visualViewport?.height ?? innerHeight,offsetTop:visualViewport?.offsetTop ?? 0,offsetLeft:visualViewport?.offsetLeft ?? 0});
  for (const type of ['wheel','touchstart','touchmove','touchend','touchcancel','pointerdown','pointermove','pointerup','pointercancel','scroll','focusin','focusout']) {
    document.addEventListener(type,event => {
      const key = `${type}:${event.isTrusted ? 'trusted' : 'untrusted'}`; counts[key] = (counts[key] || 0)+1;
      if (/^(scroll|focus)/.test(type)) {
        if (trace.length < 120) trace.push({type,trusted:event.isTrusted,time:Math.round(performance.now()),target:identify(event.target),focus:identify(document.activeElement),visual:visual()}); else dropped++;
      }
    },{capture:true,passive:true,signal:controller.signal});
  }
  window.__gestureDiagnostics = {
    stop() { controller.abort(); },
    drain() { const result = {counts,trace,dropped}; counts = {}; trace = []; dropped = 0; return result; },
    read(selector) { const node = selector ? document.querySelector(selector) : null; return {visual:visual(),root:identify(document.scrollingElement),body:identify(document.body),target:node ? {...identify(node),max:node.scrollHeight-node.clientHeight} : null}; },
  };
}
const read = selector => page.evaluate(selector => window.__gestureDiagnostics.read(selector),selector);
const drain = () => page.evaluate(() => window.__gestureDiagnostics.drain());
const settle = () => delay(250); // Finite post-input inertia/visual-viewport observation window.
async function safeDrain(step) {
  try { return await drain(); }
  catch (error) {
    report.errors.push({surface:active?.id ?? null,phase,step,error:errorKind(error)});
    return {unavailable:true,error:errorKind(error)};
  }
}
function requireIdleTouch() {
  if (touchState === 'idle') return;
  report.gestureRunAborted ??= {surface:active?.id ?? null,phase,reason:'touch-state-not-idle',touchState};
  throw new Error('Touch cleanup did not establish idle state');
}
async function measured(name, run) {
  phase = name; await safeDrain('measurement-before');
  try { return await run(); }
  finally { active.events[phase] = await safeDrain('measurement-after'); }
}
async function touch(points, type) {
  touchState = 'unknown';
  await client.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y]) => ({id,x,y,radiusX:1,radiusY:1,force:1}))});
  touchState = type === 'touchEnd' || type === 'touchCancel' ? 'idle' : 'active';
}
async function stroke(from, to) {
  await touch(from,'touchStart');
  for (let i = 1; i <= 16; i++) {
    await touch(from.map(([id,x,y],j) => [id,x+(to[j][1]-x)*i/16,y+(to[j][2]-y)*i/16]),'touchMove');
    await delay(16);
  }
  await touch([],'touchEnd'); await settle();
}
async function cleanup(record, selector, { settleAfter = true } = {}) {
  const out = record.cleanup = {touchStateBefore:touchState,before:null,after:null,steps:{}};
  async function attempt(step, run) {
    try {
      const value = await run(); out.steps[step] = {status:'returned'}; return value;
    } catch (error) {
      out.steps[step] = {status:'failed',error:errorKind(error)};
      report.errors.push({surface:active?.id ?? null,phase,step,error:errorKind(error)});
      return null;
    }
  }
  out.before = await attempt('read-before',() => read(selector));
  if (touchState === 'idle') out.steps.cancel = {status:'skipped-no-active-touch'};
  else await attempt('cancel',() => touch([],'touchCancel'));
  await attempt('reset-scale',() => client.send('Emulation.setPageScaleFactor',{pageScaleFactor:1}));
  if (selector) await attempt('reset-scroll',() => page.$eval(selector,node => { node.scrollTop = 0; }));
  else out.steps['reset-scroll'] = {status:'not-applicable'};
  if (settleAfter) await attempt('settle',settle);
  else out.steps.settle = {status:'skipped-final-close'};
  out.after = await attempt('read-after',() => read(selector));
  out.touchStateAfter = touchState;
}
async function dispatchDrag(target) {
  const result = {id:target.id,applicable:target.applicable,status:'running'}; active.drags.push(result);
  try {
    await measured(`prepare-drag-${target.id}`,async () => {
      result.preparation = {before:await read(target.selector)};
      if (target.selector) await page.$eval(target.selector,node => { node.scrollTop = 0; });
      await settle(); result.preparation.after = await read(target.selector);
    });
    await measured(`dispatch-drag-${target.id}`,async () => {
      result.before = await read(target.selector);
      result.environment = await inspectGestureEnvironment(page,target.point);
      const {x,y} = target.point, distance = Math.min(160,Math.max(20,y-16));
      await stroke([[0,x,y]],[[0,x,y-distance]]); result.down = await read(target.selector);
      await stroke([[0,x,y]],[[0,x,Math.min(828,y+distance)]]); result.up = await read(target.selector);
      result.downChanged = (result.down.target?.top ?? 0) > (result.before.target?.top ?? 0)+1;
      result.upChanged = (result.up.target?.top ?? 0) < (result.down.target?.top ?? 0)-1;
      result.status = target.applicable ? result.downChanged && result.upChanged ? 'passed' : 'failed' : 'not-applicable';
    });
  } catch (error) { result.status = 'failed'; result.error = errorKind(error); }
  finally { await measured(`cleanup-drag-${target.id}`,() => cleanup(result,target.selector)); }
  requireIdleTouch();
}
async function dispatchPinch(center) {
  const startRadius = 80, endRadius = 150, spanSlop = 30, minScalingSpan = 125;
  const result = active.dispatchPinch = {status:'running',center,reverse:{status:'not-run'},geometryModel:{
    sourceRevision:'a733b5afbb3ba618844ff8876b89ad1a774b2f18',
    sources:['third_party/blink/public/devtools_protocol/domains/Input.pdl:9-15 (TouchPoint viewport CSS pixels)',
      'content/browser/devtools/protocol/input_handler.cc:1551-1573 (ScaleFactor includes pinch page scale), 567-568 and 1688-1691 (WebTouch coordinate conversion), 1653-1668 (feature-selected dispatch path)',
      'content/public/common/content_features.cc:1248-1251 (SyntheticPointerActions disabled by default)',
      'ui/events/gesture_detection/scale_gesture_detector.cc:217-253,289-311 (slop-compensated incremental span ratio)',
      'content/common/input/synthetic_touchscreen_pinch_gesture.cc:145-162 (SetupCoordinatesAndStopTime)',
      'ui/events/gesture_detection/gesture_configuration.h','ui/events/gesture_detection/gesture_configuration_aura.cc'],
    browserRevision:report['Browser.getVersion']?.value?.revision ?? null,
    startRadius,endRadius,spanSlop,minScalingSpan,reverseEndRadius:startRadius,
    formula:'q = before.scale / beforeRestore.scale; reverseStartRadius = reverseEndRadius / q + spanSlop / 2',
    coordinateFormula:'cdpPoint = widgetPoint / strokeStart.visualScale, including both center coordinates; no visualViewport offsets',
    stroke:'touchStart / ONE touchMove / touchEnd; endpoint-only diagnostic, not smooth or physical touch',
    factorProvenance:{browserZoomFactor:{value:1,status:'assumed-not-runtime-measured'},
      embeddingCSSZoomFactor:{value:1,status:'ordinary-top-frame-model-not-runtime-measured'},
      browserSideScaleFactor:'Not directly measured; visualViewport.scale is the observed page-scale proxy.'},
    featureCaveat:'The reviewed revision defaults SyntheticPointerActions off. Command-line flags do not prove the runtime feature state; the alternative synthetic-pointer path is not this WebTouch conversion model.',
    limitation:'Source-supported, runtime-unverified hypothesis: one endpoint move uses the stroke-start inverse scale under the ordinary top-frame/browser-zoom-1 model. Protocol returned and matching page observations do not prove browser-side ScaleFactor synchronization. Linux/Aura recognizer defaults are not runtime-measured. Observed final geometry governs pass, not predicted geometry or cleanup. No retries or endpoint clamps.',
  }};
  try {
    await measured('dispatch-pinch',async () => {
      result.before = await read(); result.environment = await inspectGestureEnvironment(page,center);
      const points = radius => [[0,center.x-radius,center.y],[1,center.x+radius,center.y]];
      function geometry(fromRadius, toRadius) {
        const [width,height] = report.viewport, from = points(fromRadius), to = points(toRadius);
        const inBounds = [fromRadius,toRadius].every(radius => Number.isFinite(radius) && radius > 0)
          && [...from,...to].every(([,x,y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < width && y >= 0 && y < height);
        return {status:inBounds ? 'passed' : 'failed',fromRadius,toRadius,from,to,bounds:{width,height},
          coordinates:'Planned root-widget/DIP endpoints in the configured 390x844 viewport, not raw CDP parameters. CDP parameters inverse-transform all coordinates by the observed stroke-start scale; no visualViewport offsets.',
          entirePath:'Endpoint-only stroke, no interpolated moves. Boundary check covers planned endpoints and their convex sequential-pointer intermediate positions only; runtime conversion/synchronization remains unverified.'};
      }
      async function endpointStroke(record, expectedScale) {
        const observe = () => page.evaluate(() => ({visualScale:window.visualViewport?.scale ?? null,
          isTopFrame:window === window.top,frame:'page.evaluate main frame',
          factorStatus:'Observed visual scale only; browser-side ScaleFactor and browser zoom factor not directly measured.'}));
        record.strokeStart = await observe();
        const scale = record.strokeStart.visualScale;
        record.scaleCheck = {expectedScale,observedScale:scale,status:Number.isFinite(expectedScale) && expectedScale > 0
          && Number.isFinite(scale) && scale > 0 && scale === expectedScale && record.strokeStart.isTopFrame ? 'passed' : 'failed',
          limitation:'Exact page-observation agreement is a precondition, not proof of browser-side factor synchronization.'};
        if (record.scaleCheck.status !== 'passed') {
          record.status = 'failed'; record.reason = 'stroke-start-scale-or-frame-mismatch'; return false;
        }
        const convert = points => points.map(([id,x,y]) => [id,x/scale,y/scale]);
        const from = convert(record.geometry.from), to = convert(record.geometry.to);
        const params = (points, type) => ({type,touchPoints:points.map(([id,x,y]) => ({id,x,y,radiusX:1,radiusY:1,force:1}))});
        record.cdp = {appliedPageScale:scale,inverseFactor:1/scale,center:{x:center.x/scale,y:center.y/scale},from,to,
          params:[params(from,'touchStart'),params(to,'touchMove'),params([],'touchEnd')],
          paramsStatus:'Planned parameters; surface.protocol records commands actually sent and their returned/rejected status.',
          factorProvenance:result.geometryModel.factorProvenance,
          model:'One fixed inverse factor for this endpoint-only stroke; source-supported hypothesis, runtime-unverified. No offsets.'};
        record.status = 'running';
        await touch(from,'touchStart');
        record.beforeMove = await observe();
        record.beforeMove.scaleMatchesStart = Number.isFinite(record.beforeMove.visualScale) && record.beforeMove.visualScale > 0
          && record.beforeMove.visualScale === scale && record.beforeMove.isTopFrame;
        if (!record.beforeMove.scaleMatchesStart) {
          record.status = 'failed'; record.reason = 'pre-move-scale-or-frame-mismatch'; return false;
        }
        await touch(to,'touchMove');
        await touch([],'touchEnd');
        record.status = 'returned'; return true;
      }
      result.outward = {status:'not-run',geometry:geometry(startRadius,endRadius)};
      if (result.outward.geometry.status !== 'passed') {
        result.outward.status = 'failed'; result.outward.reason = 'geometry-out-of-bounds';
        result.reverse.reason = 'outward-geometry-failed'; result.status = 'failed'; return;
      }
      if (!await endpointStroke(result.outward,result.before.visual.scale)) {
        result.reverse.reason = 'outward-stroke-precondition-failed'; result.status = 'failed'; return;
      }
      await page.waitForFunction(scale => visualViewport.scale > scale+.05,{timeout:2500},result.before.visual.scale).catch(() => {});
      result.zoomed = await read(); result.beforeRestore = await read();
      result.zoomChanged = result.zoomed.visual.scale > result.before.visual.scale+.05 && result.zoomed.visual.width < result.before.visual.width-1;
      if (!result.zoomChanged) {
        result.reverse.reason = 'no-zoom'; result.status = 'failed'; return;
      }
      const beforeScale = result.before.visual.scale, restoreScale = result.beforeRestore.visual.scale;
      if (!Number.isFinite(beforeScale) || !Number.isFinite(restoreScale) || beforeScale <= 0 || restoreScale <= beforeScale) {
        result.reverse.reason = 'invalid-scale-ratio'; result.status = 'failed'; return;
      }
      const q = beforeScale/restoreScale, reverseStartRadius = startRadius/q+spanSlop/2;
      result.reverse = {status:'not-run',q,startRadius:reverseStartRadius,endRadius:startRadius,geometry:geometry(reverseStartRadius,startRadius)};
      if (result.reverse.geometry.status !== 'passed') {
        result.reverse.status = 'failed'; result.reverse.reason = 'geometry-out-of-bounds'; result.status = 'failed'; return;
      }
      if (!await endpointStroke(result.reverse,restoreScale)) { result.status = 'failed'; return; }
      await page.waitForFunction(scale => Math.abs(visualViewport.scale-scale)<.06,{timeout:2500},result.before.visual.scale).catch(() => {});
      result.restored = await read();
      result.reverseRestored = Math.abs(result.restored.visual.scale-result.before.visual.scale)<.06;
      result.status = result.zoomChanged && result.reverseRestored ? 'passed' : 'failed';
    });
  } catch (error) {
    result.status = 'failed'; result.error = errorKind(error);
    if (result.outward?.status === 'running') result.outward.status = 'failed';
    if (result.reverse.status === 'running') result.reverse.status = 'failed';
    else if (result.reverse.status === 'not-run') result.reverse.reason ??= 'pinch-error';
  } finally { await measured('cleanup-pinch',() => cleanup(result)); }
  requireIdleTouch();
}
await mkdir(output,{recursive:true});
const watchdog = setTimeout(() => {
  report.errors.push({phase,error:'180-second wall-clock budget exceeded'});
  void (async () => { report.watchdogDrain = await Promise.race([safeDrain('watchdog-drain'),delay(500).then(() => ({timedOut:true}))]); browser?.process()?.kill('SIGKILL'); server?.kill('SIGKILL'); await save(); await rm(base,{recursive:true,force:true}); })().finally(() => process.exit(1));
},180_000);
try {
  await prepareBrowserFixture(site);
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0,'127.0.0.1',resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath,['dist/server.mjs'],{cwd:studio,env:{...process.env,STUDIO_ORIGIN:origin,STUDIO_HOST:'127.0.0.1',PORT:String(port),STUDIO_SITE_ROOT:site,
    STUDIO_STATE:'file',STUDIO_STATE_DIR:join(base,'state'),STUDIO_GIT_URL:'',STUDIO_GIT_WORKSPACE:'',STUDIO_OIDC_ISSUER:'',STUDIO_ADMIN_USER:'owner',
    STUDIO_ADMIN_PASSWORD_HASH:await hashPassword(password),STUDIO_SESSION_SECRET:randomBytes(32).toString('hex')},stdio:'ignore'});
  server.on('error',error => report.errors.push({phase:'server',error:errorKind(error)}));
  const deadline = Date.now()+20_000;
  while (true) {
    try { if ((await fetch(origin+'/api/auth/config',{signal:AbortSignal.timeout(1000)})).ok) break; } catch {}
    if (Date.now()>deadline || server.exitCode !== null) throw new Error('Fixture server unavailable');
    await delay(100);
  }
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER');
  browser = await puppeteer.launch({headless:true,executablePath,protocolTimeout:20_000});
  page = await browser.newPage(); raw = await page.createCDPSession();
  client = {async send(method,params) {
    if (method === 'Input.synthesizeScrollGesture' && phase === 'synthetic-scroll') {
      active.events['synthetic-wheel-scroll'] = await safeDrain('synthetic-wheel-scroll'); phase = 'synthetic-touch-scroll';
    }
    if (method === 'Input.synthesizePinchGesture' && phase === 'synthetic-pinch') {
      active.events['synthetic-pinch-setup'] = await safeDrain('synthetic-pinch-setup'); phase = 'synthetic-pinch-input';
    }
    if (method === 'Emulation.setPageScaleFactor' && phase === 'synthetic-pinch-input') {
      active.events[phase] = await safeDrain('synthetic-pinch-input'); phase = 'synthetic-pinch-cleanup';
    }
    const entry = {phase,method,params,status:'pending'}, tracked = /^(Input\.|Emulation.setPageScaleFactor$)/.test(method);
    if (tracked && active) active.protocol.push(entry);
    try { const response = await raw.send(method,params); entry.status = 'returned'; entry.response = response; return response; }
    catch (error) { entry.status = 'rejected'; entry.error = errorKind(error); throw new Error(entry.error); }
    finally { if (tracked) entry.completedAtMs = Date.now()-started; }
  }};
  for (const method of ['Browser.getVersion','Browser.getBrowserCommandLine']) {
    try {
      const value = await raw.send(method);
      if (value.arguments) value.arguments = value.arguments.map(arg => /^--(headless|touch-events|enable-features|disable-features|ozone-platform|use-gl|use-angle)=/.test(arg) ? arg.replace(/https?:\S+/g,'<redacted>') : arg.startsWith('--') ? arg.split('=')[0]+(arg.includes('=') ? '=<redacted>' : '') : '<positional redacted>');
      report[method] = {status:'returned',value};
    } catch (error) { report[method] = {status:'unsupported-or-rejected',error:errorKind(error)}; }
  }
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(20_000);
  await page.evaluateOnNewDocument(installObserver); await page.evaluate(installObserver);
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator,'languages',{get:() => ['zh-CN']}));
  await page.setRequestInterception(true);
  page.on('request',request => void (request.url().startsWith(origin+'/') || /^(data:|blob:)/.test(request.url()) ? request.continue() : request.abort()));
  for (const surface of report.surfaces) {
    active = surface; surface.status = 'running'; surface.protocol = []; surface.events = {}; surface.drags = [];
    try {
      phase = `${surface.id}-setup`; await configureViewport(page,client,390,844,true);
      if (surface.id === 'static') {
        await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Static gesture control</title><style>body{margin:16px;font:16px sans-serif}#nested{height:220px;overflow:auto;border:2px solid}#nested div{height:1400px;background:linear-gradient(#eef,#ccd)}main{height:2600px;background:linear-gradient(#fff,#ddd)}</style><h1>Static gesture control</h1><section id="nested"><div>Nested scrollport</div></section><main>Long document</main>');
        await page.evaluate(installObserver); // document.write used by setContent clears document listeners.
      } else {
        if (surface.id === 'chooser') {
          const login = await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'owner',password}),signal:AbortSignal.timeout(10_000)});
          if (!login.ok) throw new Error('Fixture authentication failed');
          const cookie = login.headers.get('set-cookie').split(';')[0], split = cookie.indexOf('=');
          await browser.setCookie({name:cookie.slice(0,split),value:cookie.slice(split+1),domain:'127.0.0.1',path:'/',httpOnly:true});
        }
        await page.goto(origin,{waitUntil:'domcontentloaded'});
        await page.waitForSelector(surface.id === 'login' ? 'input[name=username]' : '.studio-shell');
        if (surface.id === 'chooser') {
          await page.select('.language-switcher select','zh-CN');
          await page.waitForFunction(() => [...document.querySelectorAll('.sidebar button')].some(n => n.textContent.trim() === '导航菜单'));
          await page.evaluate(() => [...document.querySelectorAll('.sidebar button')].find(n => n.textContent.trim() === '导航菜单').click());
          await page.waitForSelector('.settings-grid');
          await page.evaluate(() => { document.querySelectorAll('.main-content details').forEach(n => { n.open = true; }); document.querySelectorAll('.structured-toggle[aria-expanded=false]').forEach(n => n.click()); });
          await page.waitForSelector('button[name="menu.nav_menu.0.menus.0.icon"]');
          await page.click('button[name="menu.nav_menu.0.menus.0.icon"]');
          await page.waitForSelector('dialog[open] .selection-results',{visible:true});
          await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && document.querySelectorAll('dialog[open] .selection-results input').length > 5);
          surface.chooser = 'navigation icon SelectionField: menu.nav_menu.0.menus.0.icon (appearance schema has no icon field)';
        }
      }
      await page.screenshot({path:join(output,`${surface.id}.png`),fullPage:false}); surface.snapshot = `${surface.id}.png`;
      await configureViewport(page,client,390,844,true);
      surface.baselineScroll = safeBaseline(await measured('synthetic-scroll',() => exerciseScroll(page,client,{touch:true})));
      surface.baselinePinch = safeBaseline(await measured('synthetic-pinch',() => exercisePinch(page,client)));
      await configureViewport(page,client,390,844,true);
      const target = surface.baselineScroll.results[0];
      await dispatchDrag({id:'baseline-target',selector:target.applicable ? '[data-ui-audit-scroll="0"]' : null,point:target.point,applicable:target.applicable});
      if (surface.id === 'static') {
        const point = await page.$eval('#nested',node => { const r = node.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height*.8)}; });
        await dispatchDrag({id:'nested',selector:'#nested',point,applicable:true});
      }
      await dispatchPinch(surface.baselinePinch.center || {x:195,y:422});
      surface.status = surface.baselineScroll.failures.length || surface.baselinePinch.status !== 'passed' || surface.drags.some(r => r.status === 'failed') || surface.dispatchPinch.status !== 'passed' ? 'failed' : 'passed';
    } catch (error) { surface.status = 'error'; surface.error = errorKind(error); }
    finally {
      if (touchState !== 'idle') {
        surface.finalCleanup = {};
        await measured(`${surface.id}-cleanup`,() => cleanup(surface.finalCleanup));
      }
      surface.events.finalDrain = await safeDrain('surface-final-drain');
      if (!surface.snapshot) await page.screenshot({path:join(output,`${surface.id}-setup-failure.png`),fullPage:false}).then(() => { surface.setupSnapshot = `${surface.id}-setup-failure.png`; }).catch(() => {});
      await save();
    }
    // A failed cancellation permanently stops this run, even if surface teardown later recovers.
    if (report.gestureRunAborted || touchState !== 'idle') {
      report.gestureRunAborted ??= {surface:surface.id,phase,reason:'touch-state-not-idle',touchState};
      break;
    }
  }
} catch (error) { report.errors.push({phase,error:errorKind(error)}); }
finally {
  phase = 'final-cleanup';
  if (client) {
    report.finalDrain = await safeDrain('global-final-drain');
    report.finalCleanup = {};
    // Use the reporting wrapper even when no surface reached setup; never silently discard reset failures.
    await cleanup(report.finalCleanup,null,{settleAfter:false});
  }
  await browser?.close().catch(() => { browser?.process()?.kill('SIGKILL'); });
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit',resolve)); server.kill('SIGTERM');
    await Promise.race([exited,delay(1000)]); if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited; }
  }
  await rm(base,{recursive:true,force:true}); await save(); clearTimeout(watchdog);
  if (report.failed) process.exitCode = 1;
}
