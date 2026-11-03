import assert from 'node:assert/strict';
import test from 'node:test';
import {localizeConfig,localizeData,localizeUrl,languageDestinations,t} from '../src/lib/locale';
import type {Site,Document} from '../src/lib/types';

function document(overrides:Partial<Document>={}):Document {
  return {id:'source',relativePath:'articles/custom/index.md',path:'/custom/',url:'/custom/',lang:'zh-CN',title:'原文',description:'',draft:false,extra:{},taxonomies:{},body:'',html:'',toc:[],aliases:[],translations:[],kind:'article',slug:'custom',weight:0,render:true,transparent:false,paginateBy:0,ancestors:[],frontmatter:{},assets:[],wordCount:0,readingTime:0,...overrides};
}
function site(overrides:Partial<Site>={}):Site {
  return {root:'/nonexistent-isolated-site',config:{title:'中文站',default_language:'zh-CN',languages:{en:{title:'English site'}},extra:{site:{author:{name:'作者'}},locale:{en:{site:{author:{name:'Author'}}}}}},data:{menu:{nav_menu:[{name:'默认'}]}},localizedData:{en:{menu:{nav_menu:[{name:'Isolated fixture'}]}}},documents:[],sections:[],languages:['zh-CN','en'],defaultLanguage:'zh-CN',assets:[],...overrides};
}
test('language config merges defaults and locale properties without mutating source',()=>{
  const source=site();const english=localizeConfig(source,'en');
  assert.equal(english.title,'English site');assert.equal(english.extra.site.author.name,'Author');
  assert.ok(english.extra.site.logo);assert.ok(english.extra.post.abstract);
  assert.equal(source.config.extra.site.author.name,'作者');
});
test('language data uses the loaded site snapshot rather than the current repository',()=>{
  const source=site();assert.equal(localizeData(source,'en'),source.localizedData.en);
});
test('custom translated paths preserve query and fragment while assets remain unchanged',()=>{
  const original=document(),translation=document({id:'translation',url:'/en/custom-translated/',path:'/en/custom-translated/',lang:'en'});
  original.translations=[translation];const source=site({documents:[original,translation]});
  assert.equal(localizeUrl('/custom/?q=a#heading','en',source),'/en/custom-translated/?q=a#heading');
  assert.equal(localizeUrl('/img/cover.webp','en',source),'/img/cover.webp');
  assert.equal(localizeUrl('https://example.org','en',source),'https://example.org');
  assert.equal(localizeUrl('/','en',source),'/en/');
});
test('language menu falls back to home for missing or unpublished translations',()=>{
  const original=document();original.translations=[document({lang:'en',draft:true,url:'/en/private/'})];
  const destinations=languageDestinations(site(),'zh-CN',original);
  assert.equal(destinations[0].url,'/custom/');assert.equal(destinations[0].current,true);
  assert.equal(destinations[1].url,'/en/');assert.equal(destinations[1].translated,false);
});
test('language links never expose future, hidden or disabled activity translations',()=>{
  for(const overrides of [{date:'2999-01-01'}, {render:false}, {kind:'thread' as const}]) {
    const original=document(), translation=document({id:'translation',lang:'en',url:'/en/private/',...overrides});
    original.translations=[translation];
    const source=site({documents:[original,translation]});
    assert.equal(localizeUrl('/custom/','en',source),'/custom/');
    assert.equal(languageDestinations(source,'zh-CN',original)[1].url,'/en/');
    assert.equal(languageDestinations(source,'en',translation)[1].translated,false);
  }
});
test('taxonomy navigation uses public translated terms and their generated slugs',()=>{
  const translated=document({lang:'en',taxonomies:{tags:['Chinese 中文']}});
  const source=site({documents:[translated]});
  assert.equal(localizeUrl('/tags/chinese-zhong-wen/','en',source),'/en/tags/chinese-zhong-wen/');
  translated.date='2999-01-01';
  assert.equal(localizeUrl('/tags/','en',source),'/tags/');
});
test('framework catalog falls back to bundled labels and respects site overrides',()=>{
  const source=site();assert.equal(t('home','zh-CN',source),'返回博客主页');
  source.config.languages.en.translations={theme_home:'Custom home'};
  assert.equal(t('home','en',source),'Custom home');
  assert.match(t('built_with','en',source),/Astro/);
});

test('editing a translation catalog invalidates its cached labels',async()=>{
  const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'astro-locale-'));
  try{
    const source=site({root});source.config.extra.i18n={catalog_path:'labels.toml'};
    await fs.writeFile(path.join(root,'labels.toml'),'[en]\nhome="Before"\n');
    assert.equal(t('home','en',source),'Before');
    await fs.writeFile(path.join(root,'labels.toml'),'[en]\nhome="Updated label"\n');
    assert.equal(t('home','en',source),'Updated label');
  }finally{await fs.rm(root,{recursive:true,force:true})}
});
