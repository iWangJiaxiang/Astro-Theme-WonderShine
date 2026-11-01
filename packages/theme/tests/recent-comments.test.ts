import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {parseFragment, type DefaultTreeAdapterMap} from 'parse5';

// Small DOM harness exercises the actual inline renderer without loading a browser or SDK.
class Element {
  children: Element[]=[];
  parent?: Element;
  get parentElement(){return this.parent;}
  isConnected=true;
  getBoundingClientRect(){return {width:200,height:100,top:0,bottom:100,left:0,right:200};}
  className=''; id=''; href=''; src=''; title=''; dateTime=''; alt=''; loading=''; decoding='';
  private value='';
  constructor(readonly tagName: string) {}
  append(...children:Element[]) {for(const child of children){child.parent=this;this.children.push(child);}}
  replaceChildren() {this.children=[];this.value='';}
  get textContent():string {return this.value+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string) {this.children=[];this.value=value;}
  remove() {if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  replaceWith(replacement:Element) {if(!this.parent)return;const index=this.parent.children.indexOf(this);replacement.parent=this.parent;this.parent.children.splice(index,1,replacement);}
  querySelectorAll(selector:string):Element[] {
    const matches=(node:Element)=>selector.split(',').some(raw=>{const part=raw.trim();return part==='a[href]'?node.tagName==='a'&&Boolean(node.href):node.tagName===part;});
    return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);
  }
}
function convert(node:DefaultTreeAdapterMap['childNode']):Element {
  const element=new Element(node.nodeName);
  if('value' in node)element.textContent=node.value;
  if('attrs' in node)for(const attr of node.attrs){if(attr.name==='href')element.href=attr.value;if(attr.name==='src')element.src=attr.value;}
  if('childNodes' in node)element.append(...node.childNodes.map(convert));
  return element;
}
const source=readFileSync(new URL('../src/components/shell/RecentComments.astro',import.meta.url),'utf8');
const script=source.slice(source.indexOf("document.addEventListener('astro:page-load'"),source.lastIndexOf('</script>'));
const now=Date.parse('2026-10-30T04:00:00Z');
class FixedDate extends Date { static now(){return now;} }
async function render(items:unknown[],lang='zh-CN') {
  const sidebar=new Element('div');sidebar.id='newcomm';const consoleList=new Element('div');
  let onLoad:(()=>Promise<void>)|undefined;
  runInNewContext(script,{
    window:{addEventListener:(_event:string,callback:()=>Promise<void>)=>{onLoad=callback;}},
    document:{removeEventListener(){},addEventListener:(_event:string,callback:()=>Promise<void>)=>{onLoad=callback;},querySelector:()=>consoleList,getElementById:()=>sidebar,createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>{const node=new Element('#text');node.textContent=text;return node;}},
    DOMParser:class {parseFromString(html:string){const body=new Element('body');body.append(...parseFragment(html).childNodes.map(convert));return {body};}},
    settings:{site:'https://blog.example.com',system:'twikoo',count:5,lang,empty:lang==='zh-CN'?'暂无评论':'No comments yet',error:'error',labels:lang==='zh-CN'?{image:'[图片]',link:'[链接]',code:'[代码]'}:{image:'[Image]',link:'[Link]',code:'[Code]'},dates:lang==='zh-CN'?{just:'刚刚',minute:'分钟前',hour:'小时前',day:'天前'}:{just:'Just now',minute:' min ago',hour:' hours ago',day:' days ago'}},
    saveToLocal:{get:()=>JSON.stringify(items)},URL,Date:FixedDate,Intl,AbortController,innerHeight:800,innerWidth:1000,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
  });
  await onLoad!();
  return {sidebar,consoleList};
}
const item={nick:'Visitor',avatar:'https://example.com/avatar.png',content:'Hello',url:'/post/#comment-42',date:'2026-10-27T04:00:00Z'};

test('sidebar attribution stays visible inside .content > .name while console retains its own layout',async()=>{
  const {sidebar,consoleList}=await render([item]);
  const [thumb,content]=sidebar.children[0].children;
  assert.equal(thumb.children.length,1);assert.equal(thumb.children[0].tagName,'img');
  const [comment,attribution]=content.children;
  assert.equal(comment.href,'https://blog.example.com/post/#comment-42');
  assert.equal(comment.title,'Hello');assert.equal(attribution.className,'name');
  assert.equal(attribution.children[0].textContent,'Visitor / ');
  assert.equal(attribution.children[1].tagName,'time');assert.equal(attribution.children[1].textContent,'3天前');
  assert.equal(attribution.children[1].dateTime,'2026-10-27T04:00:00.000Z');
  assert.equal(consoleList.children[0].children[0].children[1].className,'name');
  assert.equal(consoleList.children[0].children[1].children[1].tagName,'time');
});
test('HTML links, images and code become safe localized placeholders',async()=>{
  const malicious={...item,nick:'<img src=x onerror=alert(1)>',content:'text &amp; <a href="https://example.com"><b>nested link</b></a><img src=x onerror="alert(1)"><pre><code>code\nline</code></pre><script>alert(1)</script>'};
  const {sidebar}=await render([malicious]);
  const content=sidebar.children[0].children[1];
  assert.equal(content.children[0].textContent,'text & [链接][图片][代码]');
  assert.equal(content.children[1].children[0].textContent,'<img src=x onerror=alert(1)> / ');
  assert.equal(sidebar.querySelectorAll('script').length,0);
  assert.equal(sidebar.querySelectorAll('img').length,1);
  const en=await render([malicious],'en');
  assert.equal(en.sidebar.children[0].children[1].children[0].textContent,'text & [Link][Image][Code]');
  assert.equal(en.sidebar.children[0].children[1].children[1].children[1].textContent,'3 days ago');
});
test('invalid links are omitted and blank avatars do not become site URL requests',async()=>{
  const {sidebar}=await render([{...item,url:'javascript:alert(1)'},{...item,avatar:''}]);
  assert.equal(sidebar.children.length,1);assert.equal(sidebar.children[0].children[0].children.length,0);
});
test('sidebar and console obey separate counts and summarize long comments',async()=>{
  const {sidebar,consoleList}=await render(Array.from({length:8},()=>({...item,content:'a'.repeat(151)})));
  assert.equal(sidebar.children.length,5);assert.equal(consoleList.children.length,6);
  assert.equal(sidebar.children[0].children[1].children[0].textContent,'a'.repeat(150)+'...');
});
test('empty comments and invalid timestamps remain readable',async()=>{
  assert.equal((await render([])).sidebar.textContent,'暂无评论');
  const {sidebar}=await render([{...item,date:'bad-date'}]);
  assert.equal(sidebar.children[0].children[1].children[1].children[1].textContent,'');
});

test('hidden console comments wait for visibility and cancel without requesting a service', async () => {
  const events=new Map<string,()=>unknown>();
  let cacheReads=0, disconnected=0;
  const hidden=new Element('div');
  hidden.getBoundingClientRect=()=>({width:0,height:0,top:0,bottom:0,left:0,right:0});
  runInNewContext(script,{
    window:{addEventListener(){},removeEventListener(){}},
    document:{body:{},addEventListener:(event:string,callback:()=>unknown)=>events.set(event,callback),removeEventListener:(event:string)=>events.delete(event),querySelector:()=>hidden,getElementById:()=>null},
    settings:{system:'twikoo'},saveToLocal:{get(){cacheReads++;return '[]';}},AbortController,
    innerHeight:800,innerWidth:1000,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    IntersectionObserver:class {observe(){} disconnect(){disconnected++;}},MutationObserver:class {observe(){} disconnect(){disconnected++;}},
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},
  });
  const pending=events.get('astro:page-load')!();
  assert.equal(cacheReads,0);
  events.get('astro:before-swap')!();
  await pending;
  assert.equal(cacheReads,0);
  assert.equal(disconnected,2);
});

test('an in-flight recent-comments request is aborted and cannot update a replacement page', async () => {
  const events=new Map<string,()=>unknown>();
  const container=new Element('div');container.textContent='Waiting';
  let signal:AbortSignal|undefined,respond:((value:unknown)=>void)|undefined,cacheWrites=0;
  const document={body:{},addEventListener:(event:string,callback:()=>unknown)=>events.set(event,callback),removeEventListener:(event:string)=>events.delete(event),querySelector:()=>container,getElementById:()=>null};
  runInNewContext(script,{
    window:{},document,settings:{system:'artalk',error:'error'},saveToLocal:{get(){},set(){cacheWrites++;}},
    GLOBAL_CONFIG:{source:{artalk:{artalkUrl:'https://comments.test',siteName:'test'}}},
    fetch:(_url:string,options:{signal:AbortSignal})=>{signal=options.signal;return new Promise(resolve=>{respond=resolve;});},
    AbortController,URLSearchParams,innerHeight:800,innerWidth:1000,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
  });
  const pending=events.get('astro:page-load')!();
  await Promise.resolve();
  const requestSignal=signal as AbortSignal|undefined;
  assert.ok(requestSignal);
  events.get('astro:before-swap')!();document.body={};
  assert.equal(requestSignal.aborted,true);
  respond!({ok:true,json:async()=>({data:[]})});
  await pending;
  assert.equal(container.textContent,'Waiting');
  assert.equal(cacheWrites,0);
});


test('an empty comment list loads when its containing card is visible', async () => {
  const events=new Map<string,()=>unknown>();
  const card=new Element('section'),container=new Element('div');card.append(container);
  container.getBoundingClientRect=()=>({width:200,height:0,top:0,bottom:0,left:0,right:200});
  let reads=0;
  runInNewContext(script,{
    window:{},document:{body:{},addEventListener:(event:string,callback:()=>unknown)=>events.set(event,callback),removeEventListener:(event:string)=>events.delete(event),querySelector:()=>container,getElementById:()=>null},
    settings:{system:'twikoo',empty:'No comments yet'},saveToLocal:{get(){reads++;return '[]';}},AbortController,
    innerHeight:800,innerWidth:1000,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
  });
  await events.get('astro:page-load')!();
  assert.equal(reads,1);
  assert.equal(container.textContent,'No comments yet');
});

test('revealing an initially transparent comment card starts loading once', async () => {
  const events=new Map<string,()=>unknown>();
  const container=new Element('div');
  let hidden=true,reads=0,changed:(()=>void)|undefined,frame:(()=>void)|undefined;
  runInNewContext(script,{
    window:{addEventListener(){},removeEventListener(){}},
    document:{body:{},addEventListener:(event:string,callback:()=>unknown)=>events.set(event,callback),removeEventListener:(event:string)=>events.delete(event),querySelector:()=>container,getElementById:()=>null},
    settings:{system:'twikoo',empty:'No comments yet'},saveToLocal:{get(){reads++;return '[]';}},AbortController,
    innerHeight:800,innerWidth:1000,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:hidden?'0':'1'}),
    IntersectionObserver:class {observe(){} disconnect(){}},MutationObserver:class {constructor(callback:()=>void){changed=callback;}observe(){} disconnect(){}},
    requestAnimationFrame:(callback:()=>void)=>{frame=callback;return 1;},cancelAnimationFrame(){},
  });
  const pending=events.get('astro:page-load')!();
  assert.equal(reads,0);
  hidden=false;changed!();frame!();
  await pending;
  assert.equal(reads,1);
  assert.equal(container.textContent,'No comments yet');
});
