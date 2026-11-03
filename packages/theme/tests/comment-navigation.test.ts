import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {commentsEnabled,hasCommentArea} from '../src/lib/comments';
import {localizeConfig} from '../src/lib/locale';
import type {Site} from '../src/lib/types';

const config={extra:{comments:{enable:true},friend:{enable_comment:true}}};
const document={extra:{}};
const supported=['post','thread','collection-detail','collection-content','equipment','links'];
const unsupported=['index','threads','timeline','topics','topic','archives','taxonomy','taxonomy-list','collection-list','collection-category','about','page','music','wechat','404'];

test('only layouts with a comment area emit the jump, even when lists have documents',()=>{
  for(const type of supported) assert.equal(hasCommentArea(type,config,document),true,type);
  for(const type of unsupported) {
    assert.equal(hasCommentArea(type,config,document),false,type);
    assert.equal(hasCommentArea(type,config),false,type);
  }
  for(const type of ['post','thread','collection-detail','collection-content']) assert.equal(hasCommentArea(type,config),false,type);
  for(const type of ['equipment','links']) assert.equal(hasCommentArea(type,config),true,type);
});

test('global and per-document disabling agree with Comments; friend switch affects only friends',()=>{
  for(const type of supported) {
    assert.equal(hasCommentArea(type,{extra:{comments:{enable:false}}},document),false,type);
    assert.equal(hasCommentArea(type,config,{extra:{disable_comment:true}}),false,type);
    assert.equal(hasCommentArea(type,{extra:{}},document),false,type);
    assert.equal(hasCommentArea(type,{extra:{...config.extra,friend:{enable_comment:false}}},document),type!=='links',type);
  }
  assert.equal(commentsEnabled(config,document),true);
  assert.equal(commentsEnabled(config,{extra:{disable_comment:true}}),false);
});

test('localized settings govern both language routes without requiring SDK credentials',()=>{
  const site={config:{...config,extra:{...config.extra,locale:{en:{comments:{enable:false}}}}},defaultLanguage:'zh-CN'} as unknown as Site;
  for(const lang of ['zh-CN','en']) {
    const localized=localizeConfig(site,lang);
    assert.equal(hasCommentArea('threads',localized,document),false,lang);
    assert.equal(hasCommentArea('thread',localized,document),lang==='zh-CN',lang);
  }
  for(const system of ['twikoo','artalk','waline']) {
    const lazy={extra:{comments:{enable:true,system,lazy_load:true}}};
    assert.equal(commentsEnabled(lazy,document),true);
    assert.equal(hasCommentArea('thread',lazy,document),true,'Do not wait for lazy SDK loading');
  }
});

test('server-rendered Chrome receives the document and shares the Comments enable predicate',()=>{
  const read=(path:string)=>readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');
  assert.match(read('layouts/SiteLayout.astro'),/<Chrome[^>]*document=\{doc\}/);
  const chrome=read('components/shell/Chrome.astro');
  assert.match(chrome,/hasCommentArea\(pageType,config,document\)&&<a id="to_comment"/);
  assert.doesNotMatch(chrome,/transition:persist/);
  assert.match(read('components/Comments.astro'),/commentsEnabled\(config,document\) && <div id="post-comment"/);
});
