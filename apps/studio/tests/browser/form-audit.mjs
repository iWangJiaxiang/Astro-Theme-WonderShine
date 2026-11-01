import { prepareBrowserFixture } from './site-fixture.mjs';
import { hashPassword } from '../../server/password.ts';
import { settingsSchemas } from '../../shared/settings.ts';
import { pageProfile } from '../../shared/page-settings.ts';
import puppeteer from 'puppeteer-core';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const studio = fileURLToPath(new URL('../../', import.meta.url));
const base = await mkdtemp(join(tmpdir(), 'studio-form-audit-'));
const screenshots = join(studio, 'test-results/form-audit');
await mkdir(screenshots, { recursive: true });
await prepareBrowserFixture(join(base, 'site'));
await rm(join(base, 'site/content/articles/welcome/index.zh-CN.md')); // Exercise creation of a missing language version.
const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port; await new Promise(r => reserve.close(r));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server.mjs'], {cwd: studio, env:{...process.env, STUDIO_ORIGIN: origin, STUDIO_HOST:'127.0.0.1', PORT:String(port), STUDIO_SITE_ROOT:join(base,'site'), STUDIO_STATE:'file', STUDIO_STATE_DIR:join(base,'state'), STUDIO_GIT_URL:'', STUDIO_GIT_WORKSPACE:'', STUDIO_ADMIN_USER:'owner', STUDIO_ADMIN_PASSWORD_HASH:await hashPassword('studio-form-test-2026'), STUDIO_SESSION_SECRET:randomBytes(32).toString('hex')},stdio:['ignore','pipe','pipe']});
let logs='', browser; server.stderr.on('data',c=>logs+=c);
const records=[], errors=[];
try {
 for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/auth/config')).ok)break;}catch{} if(i===99)throw new Error(logs);await new Promise(r=>setTimeout(r,100));}
 browser=await puppeteer.launch({headless:true,executablePath:process.env.STUDIO_TEST_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage(); page.setDefaultTimeout(15000);
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR:',e.message)}); page.on('dialog',d=>d.accept());
 await page.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'languages',{get:()=>['zh-CN']}));
 await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(origin)||r.url().startsWith('data:')||r.url().startsWith('blob:')?r.continue():r.abort());
 const click=async text=>{await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim().replace(/^✦\s*/, '')===text&&!b.disabled),{},text);await page.evaluate(text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim().replace(/^✦\s*/, '')===text&&!b.disabled).click(),text);};
 const closeDialog=async()=>{await page.evaluate(()=>{const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);const cancel=[...dialog.querySelectorAll('button')].find(button=>button.textContent.trim()==='取消');if(!cancel)throw new Error('Dialog has no cancel action');cancel.click();});await page.waitForSelector('dialog[open]',{hidden:true});};
 const settle=()=>page.waitForFunction(()=>!document.querySelector('[aria-busy=true]'));
 const capture=async(name,{expand=false}={})=>{
  if(expand)await page.evaluate(()=>{document.querySelectorAll('.main-content details').forEach(e=>e.open=true);document.querySelectorAll('.structured-toggle[aria-expanded=false]').forEach(e=>e.click());});
  for(const [width,height]of [[1440,1000],[1024,768],[390,844]]){
   await page.setViewport({width,height,deviceScaleFactor:1});
   await page.evaluate(async()=>{window.scrollTo(0,0);await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.allSettled(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));});
   const issues=await page.evaluate(()=>{
    const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const bad=[];
    if(document.documentElement.scrollWidth>innerWidth+1)bad.push({type:'page-overflow',width:document.documentElement.scrollWidth});
    for(const e of document.querySelectorAll('input:not([type=hidden]):not([type=file]),select,textarea,dialog[open],.modal')){
     if(!visible(e)||e.closest('[inert]')||document.querySelector('dialog[open]')&&!e.closest('dialog[open]')||getComputedStyle(e).position==='absolute')continue;
     const r=e.getBoundingClientRect();if(r.width<1||r.height<1)continue;
     if(e.matches('input:not([type=checkbox]):not([type=radio]):not([type=color]),select,textarea')&&!e.closest('.composer-initial-language')&&r.width<72)bad.push({type:'control-squeezed',name:e.name||e.getAttribute('aria-label')||e.closest('label')?.textContent.trim()||e.className,width:Math.round(r.width)});
     if(r.left< -1||r.right>innerWidth+1)bad.push({type:'control-overflow',name:e.name||e.className,width:Math.round(r.width),left:Math.round(r.left)});
     if(e.matches('dialog,.modal')&&(r.top< -1||r.bottom>innerHeight+1))bad.push({type:'dialog-height',height:Math.round(r.height),top:Math.round(r.top)});
    }
    for(const field of document.querySelectorAll('.field-inline')){
     const [label,control]=field.children;if(!label||!control||!visible(label)||!visible(control)||document.querySelector('dialog[open]')&&!field.closest('dialog[open]'))continue;
     const a=label.getBoundingClientRect(),b=control.getBoundingClientRect();
     if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)bad.push({type:'label-control-overlap',name:label.textContent.trim()});
    }return bad;
   });
   const titleWidth=await page.$eval('.editor-page > .page-heading > div:first-child',e=>e.getBoundingClientRect().width).catch(()=>null);if(width===1024&&titleWidth!==null&&titleWidth<240)issues.push({type:'editor-title-squeezed',width:titleWidth});
   const sidebar=await page.$eval('.sidebar', e=>e.getBoundingClientRect().right).catch(()=>0);if(width===390&&sidebar>1)issues.push({type:'sidebar-obscures-content',right:sidebar});
   const file=`${name}-${width}.png`;await page.screenshot({path:join(screenshots,file),fullPage:!await page.$('dialog[open],.modal')});records.push({name,width,file,issues});
  }
  await page.setViewport({width:1440,height:1000});console.log('Captured '+name);
 };
 await page.goto(origin,{waitUntil:'networkidle0'});await capture('login');
 await page.type('[name=username]','owner');await page.type('[name=password]','studio-form-test-2026');await click('进入创作中心');await page.waitForSelector('.note-composer textarea');await capture('dashboard');
 for(const schema of settingsSchemas){await click(schema.title);await page.waitForFunction(title=>document.querySelector('.settings-page h1')?.textContent===title,{},schema.title);await page.waitForSelector('.settings-grid');await capture('settings-'+schema.id,{expand:true});}
 for(const [kind,newLabel]of [['文章','新建文章'],['页面','新建页面'],['合集管理','新建内容']]){
  await click(kind);await page.waitForSelector('.content-library');await click(newLabel);await page.waitForSelector('.modal');await capture('create-'+({'文章':'article','页面':'page','合集管理':'collection'}[kind]));
  if(kind==='页面'){await page.click('button[name="page-template"]');await page.waitForSelector('dialog[open]');await capture('select-template');await closeDialog();}
  await click('取消');
 }
 await click('文章');await click('新建文章');await page.waitForSelector('.modal');
 await page.type('.modal input[placeholder="给它取个名字"]','新文章发布时间');await page.type('.modal input[placeholder="my-first-story"]','publication-audit');await click('进入编辑器');
 await page.waitForSelector('.metadata-card input[name="date-time"]');
 if(!await page.$eval('.metadata-card input[name="date-time"]',e=>e.value))throw new Error('New articles need a complete publication timestamp');
 await capture('new-article-editor',{expand:true});
 await click('动态');await page.waitForSelector('.note-composer textarea');await capture('notes',{expand:true});
 await page.click('.note-composer button[name="extra.topics"]');await page.waitForSelector('dialog[open]');await capture('select-topics');await page.type('dialog[open] input[type=search]', '新话题');await capture('create-topic-inline');await closeDialog();
 await click('引用文章');await page.waitForSelector('dialog[open]');await capture('reference-internal');await click('外部文章');await capture('reference-external');await closeDialog();
 await click('发布设置');await page.waitForSelector('.note-properties-heading');await capture('note-publishing');
 await page.click('.note-composer .note-date-trigger');await page.waitForSelector('.publication-date-dialog[open]');await capture('publication-date');await closeDialog();
 await click('详情');await page.waitForSelector('.note-detail-page');await capture('note-detail');await click('编辑动态');await page.waitForSelector('.note-editor');await capture('note-editor',{expand:true});
 await click('话题管理');await click('新建话题');await page.waitForSelector('.editor-page');await capture('topic-editor',{expand:true});
 await click('文章');await page.waitForSelector('.content-row[data-path="content/articles/welcome/index.md"]');await page.click('.content-row[data-path="content/articles/welcome/index.md"]');await page.waitForSelector('.markdown-source');await capture('article-editor',{expand:true});
 await click('＋ 添加语言');await page.waitForSelector('.language-version-create');await capture('add-language');await click('＋ 添加语言');
 await page.select('.language-switcher select','en');await capture('article-editor-en');if(await page.$eval('.autosave-control select', el=>el.selectedOptions[0].textContent)!=='Off')throw new Error('Autosave must follow the UI language');await page.select('.language-switcher select','zh-CN');
 await click('AI 摘要');await page.waitForSelector('dialog[open]');await capture('ai-summary');await click('取消');
 await click('AI 生成封面');await page.waitForSelector('dialog[open]');await capture('ai-cover');await click('取消');
 await click('选择或上传');await page.waitForSelector('dialog[open]');await capture('image-picker');await closeDialog();
 await click('删除当前语言版本');await page.waitForSelector('dialog[open],.modal');await capture('delete-content');await click('取消');
 await click('合集管理');await page.waitForSelector('.section-edit');await page.click('.section-edit');await page.waitForSelector('.editor-page');await capture('collection-editor',{expand:true});
 for(const layout of ['about','equipment','friends','music','wechat','archives','subscribe']){
  await click('页面');await page.waitForSelector(`.content-row[data-path="content/pages/${layout}.md"]`);await page.click(`.content-row[data-path="content/pages/${layout}.md"]`);await page.waitForSelector('.page-editor-tabs');await click('页面设置');await page.waitForSelector('.settings-group-tabs button');
  const groups=pageProfile(layout==='subscribe'?'empty':layout,layout==='subscribe'?'{{ subscribe_list() }}':'').groups;
  for(const [index,group] of groups.entries()){await page.click(`.settings-group-tabs button:nth-child(${index+1})`);await page.waitForSelector('.embedded-settings .settings-grid');await settle();await capture('page-'+layout+'-'+group.id,{expand:true});}
 }
 await click('媒体库');await page.waitForSelector('.media-browser');await capture('media-library',{expand:true});
 await page.select('.language-switcher select','en');await capture('media-library-en');
 await writeFile(join(screenshots,'report.json'),JSON.stringify({records,errors},null,2));
 console.log(JSON.stringify({screenshots:records.length,issues:records.filter(r=>r.issues.length),errors},null,2));
 if(errors.length||records.some(r=>r.issues.length))throw new Error('Form audit detected layout or browser errors; see report.json');
} catch(error){if(browser){const pages=await browser.pages();await pages.at(-1)?.screenshot({path:join(screenshots,'failure.png'),fullPage:true});console.error((await pages.at(-1)?.evaluate(()=>document.body.innerText))?.slice(-2000));}throw error;}
finally{await browser?.close();server.kill('SIGTERM');await new Promise(r=>server.exitCode!==null||server.signalCode?r():server.once('exit',r));await rm(base,{recursive:true,force:true});}
