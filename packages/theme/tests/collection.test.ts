import assert from 'node:assert/strict';
import test from 'node:test';
import {childSections,sectionPages,ownerCollection,collectionAncestors} from '../src/components/collection/data';
import type {Document,Site} from '../src/lib/types';
function document(relativePath:string,options:Partial<Document>={}):Document {
  return {id:relativePath,relativePath,path:'/'+relativePath,url:'/'+relativePath,lang:'zh-CN',title:relativePath,description:'',draft:false,extra:{},taxonomies:{},body:'',html:'',toc:[],aliases:[],translations:[],kind:relativePath.includes('_index')?'section':'article',slug:'',weight:0,render:true,transparent:false,paginateBy:0,ancestors:[],frontmatter:{},assets:[],wordCount:0,readingTime:0,...options};
}
function fixture():Site {
  return {root:'/',config:{},data:{},localizedData:{},documents:[],sections:[],languages:['zh-CN','en'],defaultLanguage:'zh-CN',assets:[]};
}
test('collection navigation follows source hierarchy even with custom public paths',()=>{
  const site=fixture(),root=document('collections/_index.md'),category=document('collections/column/_index.md'),collection=document('collections/column/manual/_index.md'),chapter=document('collections/column/manual/chapter/_index.md');
  category.parent=root.relativePath;collection.parent=category.relativePath;chapter.parent=collection.relativePath;
  const page=document('collections/column/manual/chapter/topic.md',{url:'/custom-chapter/',parent:chapter.relativePath,ancestors:[root,category,collection,chapter].map(item=>item.relativePath)});
  site.sections=[root,category,collection,chapter];site.documents=[page];
  assert.deepEqual(childSections(site,collection),[chapter]);
  assert.deepEqual(sectionPages(site,collection),[]);
  assert.deepEqual(sectionPages(site,chapter),[page]);
  assert.equal(ownerCollection(site,page),chapter);
  assert.deepEqual(collectionAncestors(site,page),[category,collection,chapter]);
});
test('collection pages exclude unpublished and other language entries and sort titles',()=>{
  const site=fixture(),collection=document('collections/manual/_index.md');site.sections=[collection];
  const page=(title:string,options:Partial<Document>={})=>document(`collections/manual/${title}.md`,{title,parent:collection.relativePath,...options});
  const first=page('01'),second=page('02');site.documents=[second,page('draft',{draft:true}),page('future',{date:'2999-01-01'}),page('english',{lang:'en'}),first];
  assert.deepEqual(sectionPages(site,collection),[first,second]);
});
test('unrendered sections remain navigable folders but do not become list cards',()=>{
  const site=fixture(),root=document('collections/_index.md'),folder=document('collections/folder/_index.md',{render:false,parent:root.relativePath});site.sections=[root,folder];
  assert.deepEqual(childSections(site,root),[folder]);
  assert.deepEqual(childSections(site,root,true),[]);
});

test('collection cards preserve directory order when weights match',()=>{
 const site=fixture(),root=document('collections/_index.md');
 const column=document('collections/column/_index.md',{title:'文章系列',parent:root.relativePath}),album=document('collections/album/_index.md',{title:'专辑',parent:root.relativePath});
 site.sections=[root,column,album];assert.deepEqual(childSections(site,root,true),[album,column]);
});
