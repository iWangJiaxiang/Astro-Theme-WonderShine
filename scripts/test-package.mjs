import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd(), temporary=await mkdtemp(path.join(tmpdir(),'wondershine-package-'));
function run(args,cwd=root){const r=spawnSync('npm',args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024,timeout:240000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
try {
 run(['run','build:theme']);
 await writeFile('packages/theme/dist/stale-build-probe.mjs', 'export const stale = true;');
 await writeFile('packages/theme/assets/dist/stale-build-probe.css', 'body { color: red; }');
 const [packed]=JSON.parse(run(['pack','./packages/theme','--pack-destination',temporary,'--json']));
 const names=packed.files.map(f=>f.path);
 assert.ok(!names.some(name=>name.includes('stale-build-probe')), 'prepack must remove stale generated output');
 for(const name of ['integration.mjs','dist/assets.mjs','assets/dist/css/global.css','defaults/config.toml','locales/theme.toml','src/pages/[...path].astro'])assert.ok(names.includes(name),name);
 assert.ok(!names.some(name=>/^(?:examples|apps|tests|content)\//.test(name)));
 const site=path.join(temporary,'site');
 await cp('examples/starter',site,{recursive:true,filter:file=>!/(?:^|\/)(?:node_modules|dist|\.astro|\.astro-assets)(?:\/|$)/.test(file)});
 const p=JSON.parse(await readFile(path.join(site,'package.json'),'utf8'));
 p.dependencies['@wondershine/theme']='file:'+path.join(temporary,packed.filename);
 await writeFile(path.join(site,'package.json'),JSON.stringify(p,null,2));
 run(['install','--no-audit','--no-fund','--fetch-retries=1','--fetch-timeout=30000'],site);
 run(['run','build'],site);
 for(const page of ['index.html','zh-CN/index.html','articles/welcome/index.html','zh-CN/articles/welcome/index.html','threads/11111111-2222-4333-8444-555555555555/index.html','collections/field-notes/first/index.html','sitemap.xml'])assert.ok((await readFile(path.join(site,'dist',page))).length,page);
 const html=await readFile(path.join(site,'dist/index.html'),'utf8');assert.match(html,/Make room/);assert.doesNotMatch(html,/blog\.jiaxiang\.wang|89889813571729408/);
 await mkdir('temp',{recursive:true});await cp(path.join(temporary,packed.filename),path.join('temp',packed.filename));
 console.log(JSON.stringify({package:packed.filename,files:names.length,bytes:packed.size,installedBuild:'passed',languages:['en','zh-CN']},null,2));
} finally { await rm(temporary,{recursive:true,force:true}); }
