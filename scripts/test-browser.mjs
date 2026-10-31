import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const screenshots=path.resolve(process.env.WONDERSHINE_SCREENSHOTS || 'temp/browser');await mkdir(screenshots,{recursive:true});
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['node_modules/astro/bin/astro.mjs','preview','--root',path.resolve('examples/demo'),'--host','127.0.0.1','--port',String(port)],{env:{...process.env,ASTRO_PREVIEW_BACKGROUND:'1'},stdio:['ignore','pipe','pipe']});
let logs='';server.stderr.on('data',v=>logs+=v);let browser;
try {
 for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}if(i===99)throw new Error(logs);await new Promise(r=>setTimeout(r,100));}
 const executablePath=process.env.STUDIO_TEST_BROWSER||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
 assert.ok(executablePath,'Set STUDIO_TEST_BROWSER to a Chrome executable');
 browser=await puppeteer.launch({headless:true,executablePath});const page=await browser.newPage();await page.setViewport({width:1440,height:900});
 const failures=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().startsWith(origin)&&r.status()>=400)failures.push(r.url()+' '+r.status());});
 await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(origin)||r.url().startsWith('data:')?r.continue():r.abort());
 for(const[name,route]of [['home','/'],['article','/articles/welcome/'],['thread','/thread/11111111-2222-4333-8444-555555555555/'],['series','/collections/field-notes/'],['tags','/tags/design/'],['chinese','/zh-CN/']]){
  const response=await page.goto(origin+route,{waitUntil:'networkidle0'});assert.equal(response.status(),200,route);
  await page.waitForFunction(()=>{const el=document.querySelector('#loading-box .loading-bg');return !el||getComputedStyle(el).visibility==='hidden';});await page.screenshot({path:path.join(screenshots,'blog-'+name+'.png')});
  const broken=await page.$$eval('img',imgs=>imgs.filter(i=>i.offsetParent&&i.complete&&!i.naturalWidth).map(i=>i.src));assert.deepEqual(broken,[],route);
 }
 await page.goto(origin,{waitUntil:'networkidle0'});await page.evaluate(()=>window.__navigationProbe='persistent');await page.click('a[href="/articles/"]');await page.waitForFunction(()=>location.pathname==='/articles/');await page.waitForFunction(()=>document.querySelector('#loading-box')?.classList.contains('loaded'));assert.equal(await page.evaluate(()=>window.__navigationProbe),'persistent');
 await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-astro-transition'));
 await page.locator('details.nav-language-switch summary').click();
 await page.locator('.nav-language-option[hreflang="zh-CN"]').click();
 await page.waitForFunction(()=>location.pathname==='/zh-CN/articles/');
 await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-astro-transition'));
 assert.equal(await page.evaluate(()=>window.__navigationProbe),'persistent');
 for(const [name,width,height]of [['medium',1165,773],['mobile',390,844]]){await page.setViewport({width,height});await page.goto(origin,{waitUntil:'networkidle0'});await page.waitForFunction(()=>{const el=document.querySelector('#loading-box .loading-bg');return !el||getComputedStyle(el).visibility==='hidden';});await page.screenshot({path:path.join(screenshots,'blog-'+name+'.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' horizontal overflow');}
 assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);await writeFile(path.join(screenshots,'browser.json'),JSON.stringify({pages:6,clientRouter:'passed',languageSwitch:'passed',responsiveWidths:[1165,390],errors,failures},null,2));console.log('Browser passed: routes, assets, ClientRouter, language switch and responsive layout.');
} finally {if(browser)await browser.close();server.kill('SIGTERM');}
