import { prepareBrowserFixture } from './site-fixture.mjs';
import { buildAstro } from '../astro-build.ts';
import puppeteer from 'puppeteer-core';
import { checkLoading } from './loading.mjs';
import { checkNavigationAccessibility } from './navigation-accessibility.mjs';
import { checkLanguages } from './languages.mjs';
import { checkOnboarding } from './onboarding.mjs';
import { checkMedia } from './media.mjs';
import { checkUploads } from './uploads.mjs';
import { createMediaDisclosureDiagnostics } from './media-disclosure-diagnostics.mjs';
import { createChooserScrollDiagnostics } from './chooser-scroll-diagnostics.mjs';
import { chooser, checkControls } from './controls.mjs';
import { checkPageManagement } from './pages.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { patchToml, splitDocument } from '../../server/content.ts';
import { parse } from 'smol-toml';
import { hashPassword } from '../../server/password.ts';
const studio = fileURLToPath(new URL('../../', import.meta.url));
const base = await mkdtemp(join(tmpdir(), 'studio-browser-'));
const screenshots = join(studio, 'test-results');
await mkdir(screenshots, { recursive: true });
const theme = await prepareBrowserFixture(base + '/site');
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://localhost:${port}`;
const server = spawn(process.execPath, process.env.STUDIO_TEST_DEV ? ['--import', 'tsx', 'server/dev.ts'] : ['dist/server.mjs'], { cwd: studio, env: { ...process.env,
  STUDIO_ORIGIN: origin, PORT: String(port), STUDIO_HOST: '127.0.0.1', STUDIO_SITE_ROOT: base + '/site',
  STUDIO_STATE: 'file', STUDIO_STATE_DIR: base + '/state', STUDIO_GIT_URL: '', STUDIO_OIDC_ISSUER: '',
  STUDIO_ADMIN_USER: 'owner', STUDIO_ADMIN_PASSWORD_HASH: await hashPassword('studio-browser-test-2026'), STUDIO_SESSION_SECRET: randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stderr.on('data', data => { logs += data; });
const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
let browser, emulationOwner, smokeFailure, mediaDiagnostics, chooserDiagnostics;
const emulationOwnerReport = { schemaVersion:1, created:false, scope:'smoke-page',
  disposalMode:'browser-close', result:'not-created', serverCleanupGuaranteed:false };
const recordFailure = error => {
  smokeFailure = smokeFailure ? new AggregateError([smokeFailure,error], 'Smoke test/cleanup failed', { cause:smokeFailure }) : error;
};
const teardownTimeoutMs = 10_000, killTimeoutMs = 5_000;
const withTimeout = async (task, label, timeoutMs = teardownTimeoutMs) => {
  let timer;
  try {
    // Promise.race also handles a late rejection after the timeout has won.
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const processEnded = child => child.exitCode !== null || child.signalCode !== null;
const waitForProcessExit = async (child, label, stop, timeoutMs = teardownTimeoutMs) => {
  let onExit, onError;
  try {
    await withTimeout(() => new Promise((resolve, reject) => {
      onExit = () => processEnded(child) ? resolve() : reject(new Error(`${label} has no exit status`));
      onError = reject;
      // Observe before signalling; public status also covers an already-exited child.
      child.once('exit', onExit); child.once('close', onExit); child.once('error', onError);
      if (processEnded(child)) resolve();
      else stop?.();
    }), label, timeoutMs);
  } finally {
    if (onExit) { child.off('exit', onExit); child.off('close', onExit); }
    if (onError) child.off('error', onError);
  }
};
const signalProcess = (child, signal) => {
  if (!child.kill(signal) && !processEnded(child)) throw new Error(`Process did not accept ${signal}`);
};
const releaseProcessHandles = child => {
  // Leftover stdio (including inherited pipes) must not keep the harness alive.
  child.unref();
  for (const stream of child.stdio) stream?.destroy();
};
try {
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to an installed Chrome/Chromium executable.');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/auth/config')).ok) break; } catch {} if (i === 99) throw new Error('Server did not start: ' + logs); await new Promise(r => setTimeout(r, 100)); }
  browser = await puppeteer.launch({ headless: true, executablePath });
  const page = await browser.newPage(), errors = [], failures = [], reactWarnings = [];
  // One supplemental raw-emulation owner for this page; browser.close disposes it.
  // Never detach it between drawer sizes, keyboard checks or ordinary viewports.
  emulationOwner = await page.createCDPSession();
  emulationOwnerReport.created = true;
  emulationOwnerReport.result = 'attached';
  page.on('console', message => { const text = message.text(); if (/Cannot update a component|Invalid DOM property|Each child in a list|You provided a .*prop/i.test(text)) reactWarnings.push(text); });
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  let holdDocumentWrite = false, releaseDocumentWrite;
  const delayNextDocumentSave = () => { holdDocumentWrite = true; return () => { holdDocumentWrite = false; releaseDocumentWrite?.(); releaseDocumentWrite = undefined; }; };
  page.on('request', request => {
    if (request.url() === origin + '/api/ai/config') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: true, image: false }) });
    if (request.url() === origin + '/api/ai/text') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Reviewed browser summary fixture.' }) });
    if (holdDocumentWrite && request.url() === origin + '/api/document' && request.method() === 'PUT') { releaseDocumentWrite = () => request.continue(); return; }
    return request.url().startsWith(origin + '/') || request.url().startsWith('data:') ? request.continue() : request.abort();
  });
  const click = async text => { await page.waitForFunction(text => [...document.querySelectorAll('button')].some(button => button.innerText.trim() === text && !button.disabled), {}, text); const found = await page.evaluate(text => { const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === text); if (!button) return false; button.click(); return true; }, text); assert.ok(found, `button: ${text}`); };
  const choose = chooser(page);
  const heading = text => page.waitForFunction(text => [...document.querySelectorAll('h1')].some(e => e.textContent === text), {}, text);
  const fill = (selector, text) => page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  const waitText = text => page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
 await checkLanguages({ browser, origin, screenshots, base });
 await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] }));
 await page.goto(origin,{waitUntil:'networkidle0'});
 await page.screenshot({path:screenshots+'/login-desktop.png'});
 await page.type('[name=username]','owner');await page.type('[name=password]','studio-browser-test-2026');await click('进入创作中心');await heading('今天，写点什么？');
 await checkLoading({ browser, origin, screenshots });
 await checkOnboarding({ page, click, heading, screenshots });
 await page.waitForFunction(()=>Number(document.querySelector('.stat-card strong')?.textContent)>0);
 await page.screenshot({path:screenshots+'/dashboard-desktop.png'});
  await checkNavigationAccessibility({ page, screenshots, emulationOwner });
 const dashboardTitle = await page.$eval('.home-grid .content-row strong', node => node.textContent);
 await page.waitForSelector('.thread-composer .markdown-source');
 await fill('.thread-composer .markdown-source', 'Keep this unsaved dashboard draft.');
 page.removeAllListeners('dialog');
 const dismissedNavigation = new Promise(resolve => page.once('dialog', async dialog => { await dialog.dismiss(); resolve(); }));
 await page.$eval('.home-grid .content-row', node => node.click()); await dismissedNavigation;
 await heading('今天，写点什么？');
 assert.equal(await page.$eval('.thread-composer .markdown-source', node => node.value), 'Keep this unsaved dashboard draft.');
 page.on('dialog', dialog => dialog.accept());
 await fill('.thread-composer .markdown-source', '');
 await page.$eval('.home-grid .content-row', node => node.click());
 await heading(dashboardTitle); await page.waitForSelector('.editor-page .markdown-source');
 await click('工作台'); await heading('今天，写点什么？');
 console.log('PASS: dashboard article shortcut and cancelled navigation preserve the current draft.');
 await click('站点信息');await heading('站点信息');await fill('.settings-grid .field input','Studio integration fixture');await click('本地保存');await page.waitForSelector('.notice.success');
 assert.match(await readFile(base+'/site/config.toml','utf8'),/Studio integration fixture/);
 for(const name of ['导航菜单','友链管理','关于页设置','标签与分类','外观样式']){await click(name);await heading(name);assert.equal(await page.$('.notice.error'),null,name)}
 // Reproduce the Shanghai-after-midnight / previous-UTC-day boundary in the actual editor.
 await page.emulateTimezone('Asia/Shanghai');
 await page.evaluate(() => {
   window.originalDate = Date;
   window.Date = class extends Date {
     constructor(...args) { super(...(args.length ? args : ['2026-10-27T00:30:00+08:00'])); }
     static now() { return new window.originalDate('2026-10-27T00:30:00+08:00').getTime(); }
   };
 });
 await click('文章');await heading('文章');await click('新建文章');await fill('.modal input[placeholder="给它取个名字"]','Browser test story');await fill('.modal input[placeholder="my-first-story"]','studio-browser-test');await click('进入编辑器');await heading('Browser test story');
 assert.equal(await page.$eval('.metadata-card input[name=date]', input => input.value), '2026-10-26');
 assert.match(await page.$eval('.metadata-card input[name="date-time"]', input => input.value), /^16:30/);
 await page.evaluate(() => { window.Date = window.originalDate; delete window.originalDate; });
 await choose('taxonomies.tags', 'tech');
 await choose('taxonomies.categories', 'misc');
 assert.equal(await page.$('[data-field="layout"] input[value=""]'), null, 'empty layout must not be selectable');
 assert.equal(await page.$$eval('[aria-label="已选标签"] button', options => options.length), 1, 'selected terms cannot be duplicated');
 await page.click('[aria-label="移除标签：技术"]');
 await choose('taxonomies.tags', 'tech');
 assert.equal(await page.$('.metadata-card .structured-item input'), null, 'taxonomies must not use free text');
 await fill('.markdown-source','# A new story\n\nThis is a browser integration test.\n');
 await page.click('.ai-action'); await page.waitForSelector('.ai-assistant-dialog[open]');
 await click('生成摘要'); await click('应用摘要');
 await page.waitForSelector('.ai-assistant-dialog', { hidden: true });
 assert.equal(await page.$eval('#article-description', node => node.value), 'Reviewed browser summary fixture.');
 console.log('PASS: AI summary application updates the document and closes the dialog.');
 await page.$eval('.metadata-card input[type=checkbox]',el=>el.click());
 await click('本地保存');await page.waitForSelector('.notice.success');
 let source=await readFile(base+'/site/content/articles/studio-browser-test/index.md','utf8');assert.match(source,/draft = false/);assert.match(source,/# A new story/);
 assert.equal(Date.parse(String(parse(splitDocument(source).header).date)), Date.parse('2026-10-27T00:30:00+08:00'));
 assert.deepEqual({ ...parse(splitDocument(source).header).taxonomies }, { tags: ['tech'], categories: ['misc'] });
 await click('正文预览');await page.waitForSelector('.markdown-preview h1');
 await click('可视化编辑');await page.waitForSelector('.vditor-ir [contenteditable=true]',{timeout:15000});
 await page.screenshot({path:screenshots+'/editor-desktop.png'});
 await click('Markdown 源码');
 await writeFile(base+'/site/content/articles/studio-browser-test/index.md',source.replace('Browser test story','Changed externally'));
 await fill('.title-field input','My local edit');await click('本地保存');await page.waitForSelector('.notice.error');assert.match(await page.$eval('.notice.error',e=>e.textContent),/文件已更新/);
 assert.match(await readFile(base+'/site/content/articles/studio-browser-test/index.md','utf8'),/Changed externally/);
 await click('工作台');await heading('今天，写点什么？');
 await page.setViewport({width:390,height:844,deviceScaleFactor:1});await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);await page.screenshot({path:screenshots+'/dashboard-mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');
 await page.click('[aria-label="打开导航"]');await click('友链管理');await heading('友链管理');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile settings overflow');
 await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);await page.screenshot({path:screenshots+'/friends-mobile.png',fullPage:true});

  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await click('合集管理'); await heading('合集管理');
  for (const item of [{ type: 'column', title: 'Browser column', slug: 'studio-column', parent: '' }, { type: 'collection', title: 'Browser collection', slug: 'studio-collection', parent: 'studio-column' }, { type: 'chapter', title: 'Browser chapter', slug: 'chapter', parent: 'studio-column/studio-collection' }]) {
    await click('新建内容'); await choose('content-type', item.type);
    await fill('.modal input[placeholder="给它取个名字"]', item.title); await fill('.modal input[placeholder="my-first-story"]', item.slug);
    if (item.parent) await choose('collection-parent', item.parent);
    await click('进入编辑器'); await heading(item.title);
    await fill('.markdown-source', '# ' + item.title + '\n\nBrowser test content.\n');
    await page.$eval('.metadata-card input[type=checkbox]', el => el.click());
    await click('本地保存'); await page.waitForSelector('.notice.success');
    await click('← 返回内容库'); await heading('合集管理');
  }

  // The article flow can select an existing collection without typing a directory.
  await click('文章'); await heading('文章'); await click('新建文章');
  await fill('.modal input[placeholder="给它取个名字"]', 'Selected collection story');
  await fill('.modal input[placeholder="my-first-story"]', 'selected-story');
  await choose('article-collection', 'studio-column/studio-collection');
  await click('进入编辑器'); await heading('Selected collection story');
  await click('本地保存'); await page.waitForSelector('.notice.success');
  assert.ok((await readFile(base + '/site/content/collections/studio-column/studio-collection/selected-story/index.md', 'utf8')).includes('collection-content'));

  await click('页面'); await heading('页面'); await click('新建页面');
  await fill('.modal input[placeholder="给它取个名字"]', 'Browser page'); await fill('.modal input[placeholder="my-first-story"]', 'studio-page');
  await click('进入编辑器'); await heading('Browser page'); await fill('.markdown-source', '# Browser page');
  await page.$eval('.metadata-card input[type=checkbox]', el => el.click()); await click('本地保存'); await page.waitForSelector('.notice.success');
  await checkPageManagement({ page, base, screenshots, click, heading, fill, delayNextDocumentSave });
  chooserDiagnostics = createChooserScrollDiagnostics({ page, reportPath: `${screenshots}/chooser-scroll-diagnostics.json`, withTimeout });
  await checkControls({ page, click, heading, fill, base, screenshots, choose, chooserDiagnostics });
  const chooserDiagnosticErrors = chooserDiagnostics.takeErrors();
  if (chooserDiagnosticErrors.length) throw new AggregateError(chooserDiagnosticErrors, 'Chooser scroll diagnostics failed');
  await checkMedia({ page, base, theme, screenshots, click, heading, fill });
  mediaDiagnostics = createMediaDisclosureDiagnostics({ page, reportPath: `${screenshots}/media-disclosure-diagnostics.json`, withTimeout });
  await mediaDiagnostics.install();
  await checkUploads({ page, base, theme, screenshots, click, heading, fill, mediaDiagnostics });
  await mediaDiagnostics.stop('passed');
  const mediaDiagnosticErrors = mediaDiagnostics.takeErrors();
  if (mediaDiagnosticErrors.length) throw new AggregateError(mediaDiagnosticErrors, 'Media disclosure diagnostics failed');
  await page.click('[aria-label="退出登录"]');await page.waitForSelector('[name=username]');
 assert.equal(await page.evaluate(async()=> (await fetch('/api/content')).status),401);
 assert.deepEqual(errors,[]);
 console.log('PASS: production browser login, dashboard, settings persistence, all forms, new article, preview, Vditor local assets, stale-save rejection, mobile layout, logout.');

  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const path = 'content/articles/studio-regression/index.md';
  await mkdir(base + '/site/content/articles/studio-regression', { recursive: true });
  await writeFile(base + '/site/' + path, '+++\ntitle="Regression story"\ndate=2026-10-24\n[taxonomies]\ntags=[]\ncategories=[]\n+++\nOriginal body\n');
 await page.goto(origin,{waitUntil:'networkidle0'});await page.type('[name=username]','owner');await page.type('[name=password]','studio-browser-test-2026');await click('进入创作中心');await waitText('今天，写点什么？');
 const stored=await page.evaluate(async path=>{const d=await(await fetch('/api/document?path='+encodeURIComponent(path))).json();localStorage.setItem('studio-draft:password:owner:'+path,JSON.stringify({body:'Recovered writing\n',values:{title:'Regression story',draft:false},baseline:{title:'Regression story',draft:false},originalBody:d.body,revision:d.revision}));return d},path);
 await click('文章');await waitText('Regression story');await page.evaluate(()=>[...document.querySelectorAll('.content-row')].find(b=>b.innerText.includes('Regression story')).click());await page.waitForSelector('.markdown-source');
 if(await page.$eval('.metadata-card input[type=checkbox]',e=>e.checked))failures.push('existing document without draft incorrectly marked draft');
 await click('可视化编辑');await page.waitForSelector('.vditor-ir [contenteditable=true]');await click('恢复草稿');
 if(await page.$('.markdown-source')){assert.match(await page.$eval('.markdown-source',e=>e.value),/Recovered writing/);await click('可视化编辑');await page.waitForSelector('.vditor-ir [contenteditable=true]')}
 else if(!await page.$eval('.vditor-ir [contenteditable=true]',e=>e.textContent.includes('Recovered writing')))failures.push('recovery did not update visible rich editor');
 await page.click('.vditor-ir [contenteditable=true]');await page.keyboard.press('End');await page.keyboard.type('FAST-INPUT-TAIL');await click('本地保存');await page.waitForSelector('.notice.success');
 if(!(await readFile(base+'/site/'+path,'utf8')).includes('FAST-INPUT-TAIL'))failures.push('immediate save lost rich input');
 await page.click('.vditor-ir [contenteditable=true]');await page.keyboard.type('MODE-SWITCH-TAIL');await click('Markdown 源码');
 if(!await page.$eval('.markdown-source',e=>e.value.includes('MODE-SWITCH-TAIL')))failures.push('mode switch lost rich input');
 await page.$eval('.markdown-source',e=>{e.value+='SOURCE-AFTER-SWITCH';e.dispatchEvent(new Event('input',{bubbles:true}))});
 await new Promise(r=>setTimeout(r,1000));if(!await page.$eval('.markdown-source',e=>e.value.includes('SOURCE-AFTER-SWITCH')))failures.push('old rich callback replaced new source');
 await click('站点信息');await page.waitForSelector('.settings-grid');await page.$eval('.settings-grid input',e=>{e.value='Unsaved through reauthentication';e.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.evaluate(async()=>{const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'x-csrf-token':s.csrf}})});await click('本地保存');await page.waitForSelector('[name=username]');
 await page.type('[name=username]','owner');await page.type('[name=password]','studio-browser-test-2026');await click('进入创作中心');await page.waitForFunction(()=>!document.querySelector('[name=username]'));
 if(!await page.$('.settings-grid input'))failures.push('expired session discarded settings form');
 else if(await page.$eval('.settings-grid input',e=>e.value)!=='Unsaved through reauthentication')failures.push('reauthentication lost configuration changes');
 assert.deepEqual(failures,[]);console.log('PASS: draft defaults, recovery, immediate rich save/switch, stale callback, reauthentication preservation.');

  // Session storage survives a full navigation (including an OIDC round trip).
  await page.reload({ waitUntil: 'networkidle0' }); await waitText('今天，写点什么？');
  await click('站点信息'); await page.waitForSelector('.settings-grid input');
  assert.equal(await page.$eval('.settings-grid input', e => e.value), 'Unsaved through reauthentication');
  assert.deepEqual(errors, []);
  assert.deepEqual(reactWarnings, [], 'React must not report invalid DOM or lifecycle updates');
  buildAstro(base + '/site');
  {
    const html = async path => readFile(base + '/site/dist/' + path + '/index.html', 'utf8');
    const articleHTML = await html('articles/studio-browser-test');
    const insertedImage = await page.evaluate(html => {
      const image = new DOMParser().parseFromString(html, 'text/html').querySelector('img[alt="媒体 配图.webp"]');
      return { src: image?.getAttribute('src'), original: image?.getAttribute('data-original') };
    }, articleHTML);
    assert.equal(decodeURI(insertedImage.original || ''), '/img/媒体 配图.webp');
    assert.ok(insertedImage.src?.startsWith('/'));
    assert.ok((await readFile(join(base, 'site/dist', decodeURI(insertedImage.src)))).length > 0, 'rendered image variant must exist');
    assert.ok((await readFile(base + '/site/dist/img/媒体 配图.webp')).length > 0);
    assert.deepEqual(await readFile(base + '/site/dist/uploads/上传 配图.webp'), await readFile(base + '/site/public/uploads/上传 配图.webp'));
    assert.deepEqual(await readFile(base + '/site/dist/articles/studio-browser-test/cover-upload.png'), await readFile(base + '/site/content/articles/studio-browser-test/cover-upload.png'));
    assert.ok((await readFile(base + '/site/dist/articles/studio-browser-test/封面 配图.webp')).length > 0);
    assert.match(await html('equipment'), /Studio gear banner/);
    assert.match(await html('equipment'), /Studio laptop/);
    assert.match(await html('about'), /Studio skill/);
    assert.match(await html('wechat'), /Studio WeChat/);
    assert.match(await html('subscribe'), /studio-subscription/);
    // Verify the optional TOML friend source is also buildable.
    const currentConfig = await readFile(base + '/site/config.toml', 'utf8');
    await writeFile(base + '/site/config.toml', patchToml(currentConfig, { 'extra.friend.dynamic_render': false }));
    buildAstro(base + '/site');
    assert.match(await html('friends'), /Studio friends/);
    console.log('PASS: Astro builds content and renders page configuration, including static TOML friends.');
  }
  console.log('PASS: configuration recovery after full reload; screenshots in studio/test-results.');
} catch (error) {
  recordFailure(error);
  // Active collectors bracket the existing screenshot, not a retry.
  await chooserDiagnostics?.snapshot('failure-before-screenshot');
  await mediaDiagnostics?.snapshot('failure-before-screenshot');
  let failurePage;
  try {
    await withTimeout(async () => {
      if (browser) {
        const pages = await browser.pages(); failurePage = pages.at(-1);
        if (failurePage) await failurePage.screenshot({ path: screenshots + '/failure.png', fullPage: true });
      }
    }, 'Failure screenshot');
  } catch (diagnosticError) {
    recordFailure(diagnosticError);
  } finally {
    // Also attempted if screenshot/page lookup fails or its timeout expires.
    await chooserDiagnostics?.snapshot('failure-after-screenshot');
    await mediaDiagnostics?.snapshot('failure-after-screenshot');
  }
  try {
    await withTimeout(async () => {
      if (failurePage) console.error((await failurePage.evaluate(() => document.body.innerText)).slice(-2500));
    }, 'Failure diagnostics');
  } catch (diagnosticError) {
    recordFailure(diagnosticError);
  } finally {
    await chooserDiagnostics?.stop('failed');
    for (const diagnosticError of chooserDiagnostics?.takeErrors() ?? []) recordFailure(diagnosticError);
    await mediaDiagnostics?.stop('failed');
    for (const diagnosticError of mediaDiagnostics?.takeErrors() ?? []) recordFailure(diagnosticError);
  }
} finally {
  // Also covers partial installation; report serialization needs no live page.
  await chooserDiagnostics?.stop('interrupted');
  for (const diagnosticError of chooserDiagnostics?.takeErrors() ?? []) recordFailure(diagnosticError);
  await mediaDiagnostics?.stop('interrupted');
  for (const diagnosticError of mediaDiagnostics?.takeErrors() ?? []) recordFailure(diagnosticError);
  let browserProcess;
  try {
    if (browser) {
      browserProcess = browser.process();
      if (!browserProcess) throw new Error('Launched browser has no public process handle');
      emulationOwnerReport.browserProcessEnded = false;
      // Puppeteer may resolve close() after swallowing its close callback error.
      // Observe the actual child independently, before requesting browser.close().
      const stages = ['browser-process-exit', 'browser-close'];
      const outcomes = await Promise.allSettled([
        waitForProcessExit(browserProcess, 'Browser process exit'),
        withTimeout(() => browser.close(), 'Browser close'),
      ]);
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === 'rejected') {
          (emulationOwnerReport.browserCleanupFailures ??= []).push(stages[index]);
          recordFailure(outcome.reason);
        }
      }
      if (!processEnded(browserProcess)) {
        emulationOwnerReport.disposalMode = 'browser-process-kill';
        try {
          await waitForProcessExit(browserProcess, 'Browser SIGKILL exit', () => signalProcess(browserProcess, 'SIGKILL'), killTimeoutMs);
        } catch (error) {
          (emulationOwnerReport.browserCleanupFailures ??= []).push('browser-process-kill');
          recordFailure(error);
        }
      }
      if (outcomes.some(outcome => outcome.status === 'rejected') || !processEnded(browserProcess)) {
        try { await withTimeout(() => browser.disconnect(), 'Browser disconnect', killTimeoutMs); }
        catch (error) {
          (emulationOwnerReport.browserCleanupFailures ??= []).push('browser-disconnect');
          recordFailure(error);
        }
      }
      emulationOwnerReport.browserProcessEnded = processEnded(browserProcess);
      emulationOwnerReport.result = !emulationOwner ? 'not-created' : !processEnded(browserProcess) ? 'browser-close-failed'
        : emulationOwnerReport.disposalMode === 'browser-process-kill' ? 'disposed-by-process-kill' : 'disposed-by-browser-close';
    }
  } catch (error) {
    emulationOwnerReport.result = emulationOwner ? 'browser-close-failed' : 'not-created';
    emulationOwnerReport.failure = {kind:'browser-teardown'};
    recordFailure(error);
    if (browser) {
      try { await withTimeout(() => browser.disconnect(), 'Browser disconnect', killTimeoutMs); }
      catch (disconnectError) {
        (emulationOwnerReport.browserCleanupFailures ??= []).push('browser-disconnect');
        recordFailure(disconnectError);
      }
    }
  } finally {
    if (browserProcess) {
      try { releaseProcessHandles(browserProcess); }
      catch (error) { recordFailure(error); }
    }
    // Independent cleanup still runs after either graceful or forced browser failure.
    try {
      try {
        await waitForProcessExit(server, 'Server SIGTERM exit', () => signalProcess(server, 'SIGTERM'));
      } catch (error) {
        emulationOwnerReport.serverCleanupFailure = {kind:'server-graceful-teardown'};
        recordFailure(error);
        if (!processEnded(server)) {
          try {
            await waitForProcessExit(server, 'Server SIGKILL exit', () => signalProcess(server, 'SIGKILL'), killTimeoutMs);
          } catch (killError) {
            emulationOwnerReport.serverKillFailure = {kind:'server-forced-teardown'};
            recordFailure(killError);
          }
        }
      }
      emulationOwnerReport.serverCleanupGuaranteed = processEnded(server);
    } catch (error) {
      emulationOwnerReport.serverCleanupFailure = {kind:'server-teardown'};
      recordFailure(error);
    } finally {
      try { releaseProcessHandles(server); }
      catch (error) { recordFailure(error); }
      try { await withTimeout(() => rm(base, { recursive: true, force: true }), 'Fixture removal'); }
      catch (error) { recordFailure(error); }
    }
  }
  try {
    if (chooserDiagnostics) await withTimeout(() => chooserDiagnostics.writeReport(), 'Chooser scroll report write');
  } catch (error) {
    recordFailure(error);
  }
  try {
    if (mediaDiagnostics) await withTimeout(() => mediaDiagnostics.writeReport(), 'Media disclosure report write');
  } catch (error) {
    recordFailure(error);
  }
  try {
    await withTimeout(() => writeFile(`${screenshots}/navigation-emulation-owner.json`,JSON.stringify(emulationOwnerReport,null,2)+'\n'), 'Lifecycle report write');
  } catch (error) {
    recordFailure(error);
  }
}
if (smokeFailure) throw smokeFailure;
