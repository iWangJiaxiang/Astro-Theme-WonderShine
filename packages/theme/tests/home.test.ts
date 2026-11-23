import assert from 'node:assert/strict';
import test from 'node:test';
import {featuredDocument,pageNumbers,taxonomyTerms} from '../src/components/home/data';
import type {Site,Document} from '../src/lib/types';
function document(overrides:Partial<Document>={}):Document {
 return {id:'source',relativePath:'articles/source.md',path:'/source/',url:'/source/',lang:'zh-CN',title:'Source',description:'',draft:false,extra:{},taxonomies:{tags:['Mixed Case']},body:'',html:'',toc:[],aliases:[],translations:[],kind:'article',slug:'source',weight:0,render:true,transparent:false,paginateBy:0,ancestors:[],frontmatter:{},assets:[],wordCount:0,readingTime:0,...overrides};
}
function site():Site {return {root:'/',config:{},data:{post:{tags:[{id:'Mixed Case',name:'Display tag',index:2},{id:'first',name:'First',index:1}]}},localizedData:{},documents:[],sections:[],languages:['zh-CN','en'],defaultLanguage:'zh-CN',assets:[]};}
test('taxonomy navigation shares route slugs, metadata ordering and public counts',()=>{
 const source=site();source.documents=[document({taxonomies:{tags:['Mixed Case','first','unlisted']}}),document({draft:true,taxonomies:{tags:['private']}})];
 assert.deepEqual(taxonomyTerms(source,'zh-CN','tags',true).map(term=>term.term),['first','Mixed Case']);
 const terms=taxonomyTerms(source,'zh-CN','tags');assert.deepEqual(terms.map(term=>term.term),['first','Mixed Case','unlisted']);assert.equal(terms[1].url,'/tags/mixed-case/');assert.equal(terms[1].name,'Display tag');assert.equal(terms[1].count,1);assert.deepEqual(taxonomyTerms(source,'en','tags'),[]);
});
test('featured content resolves a published translation and never exposes an unavailable locale',()=>{
 const source=site(),original=document(),translation=document({lang:'en',url:'/en/translated/',relativePath:'articles/source.en.md'});original.translations=[translation];source.documents=[original,translation];
 assert.equal(featuredDocument(source,original.relativePath,'en'),translation);translation.draft=true;assert.equal(featuredDocument(source,original.relativePath,'en'),undefined);
});
test('pagination preserves first and last page without duplicated current numbers',()=>{
 assert.deepEqual(pageNumbers(1,3),[1,2,3]);assert.deepEqual(pageNumbers(5,20),[1,'…',3,4,5,6,7,'…',20]);assert.deepEqual(pageNumbers(20,20),[1,'…',18,19,20]);
});
