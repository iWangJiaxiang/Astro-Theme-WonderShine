import { prepareBrowserFixture } from './site-fixture.mjs';
import { hashPassword } from '../../server/password.ts';
import { settingsSchemas } from '../../shared/settings.ts';
import { childLayoutChoices, pageProfile, pageSettingsSchemas } from '../../shared/page-settings.ts';
import { AUDIT_SIZES, SYNTHETIC_LIMITATIONS, configureViewport, exerciseScroll, exercisePinch } from './ui-audit-gestures.mjs';
import { inspectLayout, settleLayout } from './ui-audit-inspection.mjs';
import { createTopicsDiagnosticRun } from './topics-click-diagnostics.mjs';
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as retryDelay } from 'node:timers/promises';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const output = join(studio, 'test-results/form-audit');
const topicsClickDiagnostics = createTopicsDiagnosticRun();
const base = await mkdtemp(join(tmpdir(), 'studio-form-audit-'));
const site = join(base, 'site');
const password = 'studio-form-test-2026';
const started = Date.now();
const maxRuntime = 40 * 60_000;
const shardIndex = Number(process.env.STUDIO_AUDIT_SHARD_INDEX || 1);
const shardCount = Number(process.env.STUDIO_AUDIT_SHARD_COUNT || 1);
if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardCount < 1 || shardIndex < 1 || shardIndex > shardCount) throw new Error('Invalid audit shard index/count');
let browser, page, client, server, logs = '', current = 'setup';
const report = {
  schemaVersion: 2, startedAt: new Date().toISOString(), engine: 'Chromium (Puppeteer/CDP, headless)',
  sizes: AUDIT_SIZES, shard: {index:shardIndex,count:shardCount}, limitations: SYNTHETIC_LIMITATIONS, inventory: {}, surfaces: [], records: [], errors: [],
  delegated: [
    { surface:'native connection chooser / folder / repository / service / clone progress / OAuth / client API / workspace / recovery', runner:'native-ui.mjs', status:'separate-workflow-step', reason:'Requires mocked Tauri host; not available in the file-backed service bootstrap. See native-ui artifacts and step outcome; not counted as expanded six-size coverage.' },
    { surface:'AI generation success / billing services / OS file chooser / browser color picker / expired authentication / conflict recovery', status:'not-exercised', reason:'No paid or external services; deterministic audit inspects reachable forms/dialogs without submitting destructive actions. Browser/OS-owned widgets are outside DOM inspection.' },
  ],
};
const surfaces = [];
const add = (id, category, open, options = {}) => surfaces.push({id, category, open, ...options});
const slug = value => value.replace(/[^a-zA-Z0-9_-]/g, '-');
const expectedSizesFor = surface => surface.onlyMobile ? AUDIT_SIZES.filter(([width]) => width <= 390) : AUDIT_SIZES;
const reflowEvidence = {sourceViewport:[1440,1000],percent:200,method:'half CSS viewport; visualViewport.scale=1; not browser UI zoom'};
const markdownCell = value => String(value ?? '').replaceAll('|','&#124;').replace(/[\r\n]+/g,' ');
const shellSettled = async () => {
  await page.waitForFunction(() => ![...document.querySelectorAll('.sidebar')].some(node => node.getAnimations().some(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))));
  await settleLayout(page);
};
const ready = async selector => { await page.waitForSelector(selector, {visible:true}); await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')); await shellSettled(); };
const click = async (text, scope = 'body') => {
  await page.waitForFunction(({text,scope}) => [...document.querySelectorAll(`${scope} button`)].some(node => node.textContent.trim().replace(/^✦\s*/, '') === text && !node.disabled), {}, {text,scope});
  // Navigation/setup is programmatic; the recorded gesture and hit tests are real input/CDP.
  await page.evaluate(({text,scope}) => [...document.querySelectorAll(`${scope} button`)].find(node => node.textContent.trim().replace(/^✦\s*/, '') === text && !node.disabled).click(), {text,scope});
};
const navigate = async label => { await click(label, '.sidebar'); await settleLayout(page); };
const selectChoice = async (name, value) => {
  // Library choices arrive asynchronously after the toolbar itself. Wait for
  // the actual field, not merely its surrounding library shell.
  await ready(`[data-field="${name}"]`);
  const inline = await page.$(`input[name="${name}"][value="${value}"]`);
  if (inline) { await inline.evaluate(node => node.click()); await inline.dispose(); }
  else {
    await page.click(`button[name="${name}"]`); await ready('.selection-dialog[open]');
    await page.evaluate(value => {
      const dialog = [...document.querySelectorAll('.selection-dialog[open]')].filter(node => node.matches(':modal')).at(-1);
      const input = [...(dialog?.querySelectorAll('input') || [])].find(node => node.value === value);
      if (!input) throw new Error('Missing choice in top selection dialog');
      input.click();
      const confirm = [...dialog.querySelectorAll('button')].find(node => node.textContent.trim() === '确认选择');
      if (!confirm || confirm.disabled) throw new Error('Top selection dialog has no enabled confirm action');
      confirm.click();
    },value);
  }
  await settleLayout(page);
};
const article = async () => {
  await navigate('文章');
  await ready('.content-row[data-path="content/articles/welcome/index.md"]');
  await page.click('.content-row[data-path="content/articles/welcome/index.md"]');
  await ready('.markdown-source');
};
const threads = async () => { await navigate('动态'); await ready('.thread-composer textarea'); };
const expand = async () => {
  await page.evaluate(() => {
    document.querySelectorAll('.main-content details').forEach(node => { node.open = true; });
    document.querySelectorAll('.structured-toggle[aria-expanded=false]').forEach(node => node.click());
  });
  await settleLayout(page);
};
async function saveReport() {
  report.updatedAt = new Date().toISOString();
  report.elapsedSeconds = Math.round((Date.now()-started)/1000);
  report.summary = {
    inventorySurfaces:surfaces.length, plannedSurfaces:report.assignedSurfaceIds?.length ?? 0,
    completedSurfaces:report.surfaces.filter(s => s.status === 'completed').length,
    blockedSurfaces:report.surfaces.filter(s => ['blocked','error'].includes(s.status)).length,
    unfinishedSurfaces:report.surfaces.filter(s => ['pending','running'].includes(s.status)).length,
    records:report.records.length, passedRecords:report.records.filter(r => r.status === 'passed').length,
    unfinishedRecords:report.records.filter(r => ['not-run','running'].includes(r.status)).length,
    blockedRecords:report.records.filter(r => r.status === 'blocked').length,
    findings:report.records.reduce((n,r) => n+(r.findings?.length || 0),0), errors:report.errors.length,
  };
  await writeFile(join(output,'report.json'), JSON.stringify(report,null,2)+'\n');
  const rows = report.records.map(record => {
    const pinchExpected = record.mode === 'responsive' && Number(record.size.split('x')[0]) <= 1024;
    return `| ${record.surface} | ${record.size} | ${record.mode} | ${record.status} | ${markdownCell(record.error)} | ${record.scroll?.results.map(r => `${r.method}:${r.status}`).join(', ') || 'not-run'} | ${record.pinch?.status || (pinchExpected ? 'not-run' : 'not-applicable')} | ${record.findings?.length || 0} | ${Object.values(record.screenshots || {}).map(file => `[image](${file})`).join(' ')} |`;
  });
  await writeFile(join(output,'report.md'), `# Studio remote UI audit\n\n${JSON.stringify(report.summary)}\n\n## Evidence limits\n${report.limitations.map(s => `- ${s}`).join('\n')}\n\n## Per-surface/size evidence\nCollection completion is not a pass: findings, errors and not-run records remain failures.\n\n| Surface | Size | Mode | Status | Error | Scroll | Pinch | Findings | Screenshots |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n## Blocked surfaces\n${report.surfaces.filter(s => s.status !== 'completed').map(s => `- ${s.id}: ${markdownCell(s.error || s.status)}${s.setupScreenshot ? ` [setup only; not size evidence](${s.setupScreenshot})` : ''}`).join('\n')}\n\n## Delegated / not exercised\n${report.delegated.map(s => `- ${s.surface}: ${s.reason}`).join('\n')}\n`);
}
async function capture(surface, width, height, mode = 'responsive') {
  const mobile = width <= 1024;
  const record = report.records.find(record => record.surface === surface.id && record.size === `${width}x${height}` && record.mode === mode);
  if (!record || record.status !== 'not-run') throw new Error('Capture missing from planned matrix or already attempted');
  record.status = 'running';
  try {
    await configureViewport(page,client,width,height,mobile && mode === 'responsive');
    await shellSettled();
    if (surface.ensure) await surface.ensure();
    record.initialViewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight,scale:visualViewport?.scale ?? 1}));
    if (Math.abs(record.initialViewport.width-width)>1 || Math.abs(record.initialViewport.height-height)>1 || Math.abs(record.initialViewport.scale-1)>.06) record.findings.push({type:'unexpected-layout-viewport',expected:{width,height,scale:1},actual:record.initialViewport});
    const image = async phase => {
      const file = `${slug(surface.id)}-${width}x${height}-${mode}-${phase}.png`;
      await page.screenshot({path:join(output,file),fullPage:false});
      record.screenshots[phase] = file;
    };
    record.inspection = await inspectLayout(page,{mobile,reflow:mode==='reflow-200'});
    record.findings.push(...record.inspection.findings);
    await image('initial');
    record.scroll = await exerciseScroll(page,client,{touch:mobile && mode === 'responsive',onDown:async () => {
      record.scrolledInspection = await inspectLayout(page,{mobile,reflow:mode==='reflow-200'});
      record.findings.push(...record.scrolledInspection.findings.map(f => ({...f,phase:'scrolled'})));
      await image('scroll-down');
    },onUp:() => image('scroll-up')});
    record.findings.push(...record.scroll.failures);
    // Reflow is explicitly isolated from visual pinch zoom.
    if (mobile && mode === 'responsive') {
      record.pinch = await exercisePinch(page,client,() => image('pinch-in'),() => image('pinch-restored'));
      record.findings.push(...record.pinch.failures);
      await image('pinch-cleanup');
    }
    record.status = record.findings.length ? 'findings' : 'passed';
  } catch (error) {
    record.status = 'error'; record.error = error.message;
    report.errors.push({surface:surface.id,size:record.size,mode,error:error.message});
  } finally { await saveReport(); }
}

await mkdir(output,{recursive:true});
// Hard wall-clock guard preserves partial evidence even for an unresponsive browser.
const watchdog = setTimeout(() => {
  report.errors.push({surface:current,error:'Audit exceeded 40-minute wall-clock budget'});
  void saveReport().finally(() => { browser?.process()?.kill('SIGKILL'); server?.kill('SIGKILL'); process.exit(1); });
},maxRuntime);
try {
  await prepareBrowserFixture(site);
  await rm(join(site,'content/articles/welcome/index.zh-CN.md'),{force:true});
  // Dedicated plain Markdown fixture makes all three editor modes feasible without altering source content.
  await mkdir(join(site,'content/articles/audit-modes'),{recursive:true});
  await writeFile(join(site,'content/articles/audit-modes/index.md'),'+++\ntitle="Audit editor modes"\ndraft=true\ndate="2026-01-01T12:00:00Z"\n+++\n# Audit modes\n\nPlain Markdown fixture.\n\n'+Array.from({length:30},(_,i) => `## Section ${i+1}\n\nFictional paragraph for scroll inspection.\n`).join('\n'));
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0,'127.0.0.1',resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath,['dist/server.mjs'],{cwd:studio,env:{...process.env,
    STUDIO_ORIGIN:origin,STUDIO_HOST:'127.0.0.1',PORT:String(port),STUDIO_SITE_ROOT:site,
    STUDIO_STATE:'file',STUDIO_STATE_DIR:join(base,'state'),STUDIO_GIT_URL:'',STUDIO_GIT_WORKSPACE:'',
    STUDIO_ADMIN_USER:'owner',STUDIO_ADMIN_PASSWORD_HASH:await hashPassword(password),STUDIO_SESSION_SECRET:randomBytes(32).toString('hex'),
  },stdio:['ignore','pipe','pipe']});
  server.on('error',error => report.errors.push({surface:'server',error:error.message}));
  for (const stream of [server.stdout,server.stderr]) stream.on('data',chunk => { logs = (logs+chunk).slice(-12000); });
  const deadline = Date.now()+20_000;
  while (true) {
    try { if ((await fetch(origin+'/api/auth/config',{signal:AbortSignal.timeout(1000)})).ok) break; } catch {}
    if (Date.now()>deadline || server.exitCode !== null) throw new Error('Fixture server unavailable: '+logs);
    await retryDelay(100); // Bounded server readiness polling, not a UI sleep.
  }
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to a Chromium executable');
  browser = await puppeteer.launch({headless:true,executablePath,protocolTimeout:20_000});
  report.browserVersion = await browser.version();
  page = await browser.newPage(); client = await page.createCDPSession();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(20_000);
  page.on('pageerror',error => report.errors.push({surface:current,error:error.message}));
  page.on('dialog',dialog => void dialog.accept());
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator,'languages',{get:() => ['zh-CN']}));
  await page.setRequestInterception(true);
  page.on('request',request => void (request.url().startsWith(origin+'/') || /^(data:|blob:)/.test(request.url()) ? request.continue() : request.abort()));
  const reset = async () => {
    await configureViewport(page,client,1440,1000,false);
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await ready('.studio-shell');
    await page.select('.language-switcher select','zh-CN');
    await settleLayout(page);
  };
  add('login','authentication',async () => { await page.goto(origin,{waitUntil:'domcontentloaded'}); await ready('input[name=username]'); },{unauthenticated:true});
  add('dashboard','page',async () => { await navigate('工作台'); await ready('.thread-composer textarea'); });
  add('onboarding-steps','onboarding',async () => { await navigate('工作台'); await ready('.guide-toggle'); await click('查看入门步骤'); await ready('.guide-steps'); });
  add('onboarding-help','onboarding',async () => { await navigate('使用指南'); await ready('.guide-page'); await expand(); });
  add('navigation-drawer','navigation',async () => { await configureViewport(page,client,390,844); await page.click('.mobile-menu'); await ready('.sidebar.open'); },{onlyMobile:true,ensure:async () => { if (!await page.$('.sidebar.open')) await page.click('.mobile-menu'); await ready('.sidebar.open'); }});
  for (const schema of settingsSchemas) add('settings-'+schema.id,'settings',async () => { await navigate(schema.title); await ready('.settings-grid'); await expand(); });
  for (const [kind,label,newLabel] of [['article','文章','新建文章'],['page','页面','新建页面'],['collection','合集管理','新建内容']]) {
    const library = async () => { await navigate(label); await ready('.content-library .content-row'); };
    add('library-'+kind,'library',library);
    add('create-'+kind,'dialog',async () => { await library(); await click(newLabel); await ready('.modal'); });
    if (kind === 'page') add('select-page-template','dialog',async () => { await library(); await click(newLabel); await page.click('button[name="page-template"]'); await ready('dialog[open] .selection-panel'); });
    if (kind === 'collection') for (const type of ['collection','chapter']) add('create-collection-'+type,'dialog',async () => { await library(); await click(newLabel); await selectChoice('content-type',type); await ready('.modal'); });
  }
  add('new-article-editor','editor',async () => {
    await navigate('文章'); await ready('.content-library'); await click('新建文章'); await ready('.modal');
    await page.type('.modal input[name="creation-title"]','新文章发布时间');
    await page.type('.modal input[placeholder="my-first-story"]','publication-audit');
    await click('进入编辑器'); await ready('.metadata-card input[name="date-time"]');
    if (!await page.$eval('.metadata-card input[name="date-time"]',node => node.value)) throw new Error('New article has no complete publication timestamp');
    await expand();
  });
  add('threads','page',threads);
  add('thread-publishing','editor',async () => { await threads(); await click('发布设置'); await ready('.thread-properties-heading'); });
  add('select-topics','dialog',async () => {
    await threads();
    await page.click('.thread-composer button[name="extra.topics"]');
    await ready('dialog[open]');
  });
  add('create-topic-inline','dialog',async () => {
    await threads();
    await topicsClickDiagnostics({ page, output, operation: async ({ mark, afterClick }) => {
      mark('click-entry');
      await page.click('.thread-composer button[name="extra.topics"]');
      mark('click-return');
      await afterClick();
      mark('ready-entry');
      await ready('dialog[open]');
      mark('ready-return');
    } });
    await page.type('dialog[open] input[type=search]','审计新话题');
  });
  for (const external of [false,true]) add('reference-'+(external?'external':'internal'),'dialog',async () => { await threads(); await click('引用文章'); await ready('dialog[open]'); if (external) await click('外部文章'); });
  add('publication-date','dialog',async () => {
    await threads(); await click('发布设置'); await ready('.thread-properties-heading');
    await page.waitForSelector('.thread-composer .thread-date-trigger', {visible:true});
    await page.click('.thread-composer .thread-date-trigger'); await ready('.publication-date-dialog[open]');
  });
  add('thread-detail','page',async () => { await threads(); await click('详情'); await ready('.thread-detail-page'); });
  add('thread-editor','editor',async () => { await threads(); await click('详情'); await ready('.thread-detail-page'); await click('编辑动态'); await ready('.thread-editor'); await expand(); });
  add('library-topics','library',async () => { await navigate('话题管理'); await ready('.localized-library'); });
  add('topic-editor','editor',async () => { await navigate('话题管理'); await ready('.localized-library'); await click('新建话题'); await ready('.editor-page'); await expand(); });
  add('article-editor','editor',async () => { await article(); await expand(); });
  add('add-language','editor',async () => { await article(); await click('＋ 添加语言'); await ready('.language-version-create'); });
  add('article-editor-en','editor',async () => { await article(); await page.select('.language-switcher select','en'); await settleLayout(page); });
  for (const [id,label] of [['ai-summary','AI 摘要'],['ai-cover','AI 生成封面'],['image-picker','选择或上传'],['delete-content','删除当前语言版本']]) add(id,'dialog',async () => { await article(); await expand(); await click(label); await ready('dialog[open]'); });
  add('save-mode-portal','portal',async () => { await article(); await page.click('.save-button-toggle'); await ready('.save-mode-menu'); },{ensure:async () => { if (!await page.$('.save-mode-menu')) await page.click('.save-button-toggle'); await ready('.save-mode-menu'); }});
  for (const [id,group,name] of [['icon','navigation','menu.nav_menu.0.menus.0.icon'],['article','recommendations','post.today_recommend.post_path']]) add('settings-select-'+id,'dialog',async () => {
    await navigate(settingsSchemas.find(schema => schema.id === group).title); await ready('.settings-grid'); await expand();
    await page.click(`button[name="${name}"]`); await ready('dialog[open] .selection-panel');
  });
  add('image-insert-picker','dialog',async () => { await article(); await click('插入图片'); await ready('.media-dialog[open]'); });
  for (const [id,label,selector] of [['source','Markdown 源码','.markdown-source'],['preview','正文预览','.markdown-preview'],['rich','可视化编辑','.vditor-ir [contenteditable=true]']]) add('editor-mode-'+id,'editor-mode',async () => {
    await navigate('文章'); await ready('.content-row[data-path="content/articles/audit-modes/index.md"]');
    await page.click('.content-row[data-path="content/articles/audit-modes/index.md"]'); await ready('.markdown-source');
    await click(label); await ready(selector);
  });
  add('collection-editor','editor',async () => { await navigate('合集管理'); await ready('.section-edit'); await page.click('.section-edit'); await ready('.editor-page'); await expand(); });
  add('library-collection-nested','library',async () => { await navigate('合集管理'); await ready('.content-row[data-path="content/collections/docs/_index.md"]'); await page.click('.content-row[data-path="content/collections/docs/_index.md"]'); await ready('.content-library'); });
  for (const [layout,path] of [['collection-category','content/collections/docs/_index.md'],['collection-detail','content/collections/docs/user/_index.md'],['collection-content','content/collections/docs/user/01 intro.md']]) add('editor-'+layout,'collection-template',async () => {
    await navigate('合集管理'); await ready('.content-library');
    await page.type('.content-library input[aria-label="搜索内容"]','Guide');
    await ready(`.content-row[data-path="${path}"]`);
    await page.$eval(`.content-row[data-path="${path}"]`,node => {
      const edit = node.closest('.library-row')?.querySelector('.section-edit');
      (edit || node).click();
    });
    await ready('.editor-page'); await expand();
  });
  // Enumerate every fixture page/language, not just the seven specialized templates.
  const pageFiles = (await readdir(join(site,'content/pages'))).filter(file => file.endsWith('.md') && !file.startsWith('_index')).sort();
  const pages = [];
  for (const file of pageFiles) {
    const text = await readFile(join(site,'content/pages',file),'utf8');
    const layout = text.match(/^layout\s*=\s*["']([^"']+)["']/m)?.[1] || 'empty';
    const groups = pageProfile(layout,text).groups;
    pages.push({file,layout,groups});
    const openPage = async () => {
      await navigate('页面'); await ready('.content-library');
      // Explicitly select content language; UI language is independent.
      const language = file.match(/\.([^.]+)\.md$/)?.[1] || 'en';
      await selectChoice('library-language',language);
      const path = `content/pages/${file}`;
      await ready(`.content-row[data-path="${path}"]`);
      await page.click(`.content-row[data-path="${path}"]`); await ready('.page-editor-tabs');
    };
    add('page-'+file,'page-template',openPage);
    // The same schema groups are shared across translations; inspect each once.
    if (!/\.[^.]+\.md$/.test(file)) {
      if (!groups.length) add('page-settings-'+file+'-empty','template-settings',async () => { await openPage(); await click('页面设置'); await ready('.page-template-settings'); });
      for (const [index,group] of groups.entries()) add('page-'+file+'-'+group.id,'template-settings',async () => {
        await openPage(); await click('页面设置'); await ready('.settings-group-tabs button');
        await page.click(`.settings-group-tabs button:nth-child(${index+1})`); await ready('.embedded-settings .settings-grid'); await expand();
      });
    }
  }
  add('media-library','library',async () => { await navigate('媒体库'); await ready('.media-browser'); });
  add('media-upload','editor',async () => { await navigate('媒体库'); await ready('.media-browser'); await page.click('.media-upload-disclosure summary'); await ready('.media-upload'); });
  add('media-details','page',async () => { await navigate('媒体库'); await ready('.media-card'); await page.click('.media-card'); await ready('.media-details img'); });
  add('media-library-en','library',async () => { await navigate('媒体库'); await ready('.media-browser'); await page.select('.language-switcher select','en'); });
  report.inventory = {
    globalSettings:settingsSchemas.map(({id,title}) => ({id,title})), pageSettings:pageSettingsSchemas.map(({id,title}) => ({id,title})),
    templateChoices:childLayoutChoices, pages, surfaceIds:surfaces.map(({id,category}) => ({id,category})),
    dialogComponents:['Modal (creation/reauthentication)','SelectionField (template/language/taxonomy/icon/collection/topic choices)','PublicationDateField','ArticleReferences','AiAssistant','MediaPicker','DeleteContentDialog','SaveButton body portal'],
  };
  await saveReport();
  // Disjoint stable inventory partitions retain every surface/size while keeping
  // each remote runner below the watchdog instead of dropping tail coverage.
  const assigned = surfaces.filter((_, index) => index % shardCount === shardIndex - 1);
  report.assignedSurfaceIds = assigned.map(surface => surface.id);
  for (const surface of assigned) {
    const expectedSizes = expectedSizesFor(surface);
    report.surfaces.push({id:surface.id,category:surface.category,status:'pending',expectedSizes:expectedSizes.map(size => size.join('x')),reflow200:!surface.onlyMobile});
    const matrix = expectedSizes.map(([width,height]) => ({size:`${width}x${height}`,mode:'responsive'}));
    if (!surface.onlyMobile) matrix.push({size:'720x500',mode:'reflow-200',reflow:reflowEvidence});
    for (const entry of matrix) report.records.push({surface:surface.id,category:surface.category,...entry,status:'not-run',findings:[],screenshots:{}});
  }
  await saveReport();
  let authenticated = false;
  for (const surface of assigned) {
    current = surface.id;
    const expectedSizes = expectedSizesFor(surface);
    const coverage = report.surfaces.find(entry => entry.id === surface.id);
    coverage.status = 'running';
    try {
      if (!surface.unauthenticated) {
        if (!authenticated) {
          await configureViewport(page,client,1440,1000,false);
          await page.goto(origin,{waitUntil:'domcontentloaded'}); await ready('input[name=username]');
          await page.type('[name=username]','owner'); await page.type('[name=password]',password); await click('进入创作中心');
          await ready('.studio-shell'); authenticated = true;
        } else await reset();
      }
      await surface.open();
      for (const [width,height] of expectedSizes) await capture(surface,width,height);
      if (!surface.onlyMobile) {
        // 1440x1000 at 200% desktop zoom has a 720x500 CSS layout viewport.
        await capture(surface,720,500,'reflow-200');
      }
      const records = report.records.filter(record => record.surface === surface.id);
      const missingSizes = expectedSizes.filter(([width,height]) => !records.some(record => record.size === `${width}x${height}` && record.mode === 'responsive'));
      if (missingSizes.length || (!surface.onlyMobile && !records.some(record => record.mode === 'reflow-200')) || records.some(record => !['passed','findings','error'].includes(record.status))) throw new Error('Surface did not collect its complete size/reflow matrix');
      coverage.status = records.some(record => record.status === 'error') ? 'error' : 'completed';
    } catch (error) {
      coverage.status = 'blocked'; coverage.error = error.message;
      report.errors.push({surface:surface.id,error:error.message});
      const blockedFile = `${slug(surface.id)}-blocked.png`;
      const blockedImage = await page?.screenshot({path:join(output,blockedFile),fullPage:false}).then(() => blockedFile).catch(() => undefined);
      coverage.setupScreenshot = blockedImage;
      // A setup screenshot is not per-size evidence: retain it on the surface,
      // and mark every unattempted responsive/reflow combination explicitly.
      for (const record of report.records.filter(record => record.surface === surface.id && record.status === 'not-run')) Object.assign(record,{status:'blocked',error:error.message});
    }
    await saveReport();
    console.log(`Audited ${surface.id}: ${coverage.status}`);
  }
} catch (error) {
  report.errors.push({surface:current,error:error.message});
} finally {
  report.finishedAt = new Date().toISOString();
  await saveReport();
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) {
    server.kill('SIGTERM');
    const kill = setTimeout(() => server.kill('SIGKILL'),3000);
    await new Promise(resolve => server.exitCode !== null || server.signalCode ? resolve() : server.once('exit',resolve));
    clearTimeout(kill);
  }
  await rm(base,{recursive:true,force:true});
  clearTimeout(watchdog);
}
console.log(JSON.stringify(report.summary,null,2));
if (report.errors.length || report.surfaces.length !== report.assignedSurfaceIds?.length || report.surfaces.some(surface => surface.status !== 'completed') || report.records.some(record => record.status !== 'passed' || record.findings.length)) {
  process.exitCode = 1;
  console.error('UI audit collected findings or blocked coverage; see test-results/form-audit/report.json and report.md');
}
