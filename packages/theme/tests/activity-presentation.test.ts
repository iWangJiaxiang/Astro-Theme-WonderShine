import assert from 'node:assert/strict';
import test from 'node:test';
import {activitySummary,formatDateTime} from '../src/lib/queries';
import type {Document,Site} from '../src/lib/types';

const doc=(overrides:Partial<Document>={}):Document=>({id:'source',relativePath:'threads/example/index.md',path:'/threads/example/',url:'/threads/example/',lang:'en',title:'Example',description:'',draft:false,extra:{},taxonomies:{},body:'',html:'',toc:[],aliases:[],translations:[],kind:'thread',slug:'example',weight:0,render:true,transparent:false,paginateBy:0,ancestors:[],frontmatter:{},assets:[],wordCount:0,readingTime:0,...overrides});
const site=():Site=>({root:'/nonexistent-fixture',config:{extra:{activity:{enable:true}}},data:{},localizedData:{en:{menu:{nav_menu:[]}}},documents:[],sections:[],languages:['zh-CN','en'],defaultLanguage:'zh-CN',assets:[]});

test('seconds use Shanghai time including midnight, without mutating source precision',()=>{
  const original='2026-01-01T16:00:09.123Z';
  for(const lang of ['en','zh-CN']) {
    assert.match(formatDateTime(original,lang),/2026/);
    assert.match(formatDateTime(original,lang),/00:00:09 \(UTC\+08:00\)$/);
  }
  assert.equal(original,'2026-01-01T16:00:09.123Z');
  assert.equal(formatDateTime('invalid'),'');
  assert.equal(formatDateTime(), '');
});

test('sidebar counts and topics share the language and publication boundary',()=>{
  const source=site();
  source.sections=[doc({relativePath:'threads/_index.md',draft:true})];
  source.documents=[doc({extra:{topics:['public']}}),doc({kind:'article',extra:{topics:['public']}}),doc({kind:'topic',extra:{id:'public'}}),
    ...[{draft:true},{render:false},{date:'2999-01-01'},{lang:'zh-CN'},{ancestors:['threads/_index.md']}].flatMap(overrides=>[
      doc(overrides),doc({...overrides,kind:'topic',extra:{id:'private'}}),doc({...overrides,kind:'article'}),
    ])];
  const summary=activitySummary(source,'en');
  assert.equal(summary.articleCount,1);
  assert.equal(summary.threadCount,1);
  assert.equal(summary.topics.length,1);
  assert.equal(summary.topics[0].count,2);
  assert.equal(summary.recent.length,1);
  source.documents=Array.from({length:7},(_,i)=>doc({url:`/threads/${i}/`}));
  assert.equal(activitySummary(source,'en').recent.length,4);
  source.documents=[];
  assert.deepEqual(activitySummary(source,'en'),{articleCount:0,threadCount:0,recent:[],topics:[]});
});
