import assert from 'node:assert/strict';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
const excluded=new Set(['node_modules','.git','dist','.astro','.astro-assets','temp','test-results']);
async function walk(dir){let files=[];for(const item of await readdir(dir,{withFileTypes:true})){if(excluded.has(item.name))continue;const p=path.join(dir,item.name);assert.ok(!(await lstat(p)).isSymbolicLink(),'Unexpected source symlink: '+p);if(item.isDirectory())files.push(...await walk(p));else files.push(p);}return files;}
const files=await walk('.');
for(const file of files){
 assert.ok(!/(?:^|\/)(?:\.gitmodules|\.env)(?:$|\/)/.test(file),file);
 assert.ok(!/(?:^|\/)(?:\.state|\.studio-history|\.studio-review-owner-v1|content-revisions-v1|summary-preview-v1|reviews-v1|[^/]+\.studio-(?:reviews|revisions)-v1)(?:\/|$)/.test(file),'Private Studio state in source distribution: '+file);
 if(!/\.(ts|mjs|astro|vue|toml|json|css|html)$/.test(file)||file==='package-lock.json'||file.startsWith('scripts/'))continue;
 const text=await readFile(file,'utf8');
 assert.ok(!/blog\.jiaxiang\.wang|89889813571729408|王嘉祥|\/Users\/wjx/.test(text),'Personal production data: '+file);
 assert.ok(!/themes\/zola-theme|zola (?:serve|build)|git submodule/.test(text),'Legacy runtime dependency: '+file);
}
console.log(`Distribution audit passed: ${files.length} source files; no personal production data or Zola runtime dependency.`);
