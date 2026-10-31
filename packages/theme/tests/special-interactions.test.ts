import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function inlineScript(component:string):string {
  const source=readFileSync(new URL(`../src/components/special/${component}.astro`,import.meta.url),'utf8');
  const script=source.match(/<script is:inline[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script,`${component} has an inline interaction script`);
  return script;
}

test('random friend reveals a localized preview before opening the selected link',()=>{
  let click:()=>void=()=>{},preview:any;
  const opened:any[]=[];
  const document={
    documentElement:{lang:'en'},
    querySelectorAll:(selector:string)=>selector.includes('cf-friends-link')?[{href:'https://example.org/',title:'Example <b>'}]:[],
    querySelector:()=>({addEventListener:(_event:string,handler:()=>void)=>{click=handler}})
  };
  vm.runInNewContext(inlineScript('FriendsPage'),{document,window:{Snackbar:{show:(options:any)=>{preview=options}},open:(...args:any[])=>opened.push(args)}});
  click();
  assert.deepEqual(opened,[]);
  assert.equal(preview.text,'Your random discovery: Example &lt;b&gt;');
  assert.equal(preview.actionText,'Visit');
  const element={style:{opacity:'1'}};preview.onActionClick(element);
  assert.deepEqual(opened,[['https://example.org/','_blank','noopener,noreferrer']]);
  assert.equal(element.style.opacity,'0');
});

async function statisticsFixture(reducedMotion=false) {
  const rows:any[]=[],started:number[]=[],events:Record<string,()=>void>={};
  let intersect:((entries:{isIntersecting:boolean}[])=>void)|undefined;
  const statistic={isConnected:true,dataset:{statApi:'/statistics.json',statLabels:JSON.stringify({today_pv:'Views today',yesterday_pv:'Views yesterday'})},append:(row:any)=>rows.push(row)};
  class IntersectionObserver {
    constructor(callback:typeof intersect){intersect=callback;}
    observe(){}
    disconnect(){}
  }
  class CountUp {
    value:number;
    constructor(_element:any,_start:number,value:number){this.value=value;}
    start(){started.push(this.value);}
  }
  const document={
    readyState:'loading',documentElement:{dataset:{theme:'light'}},
    querySelector:()=>null,getElementById:()=>statistic,
    addEventListener:(event:string,callback:()=>void)=>{events[event]=callback},
    createElement:()=>({textContent:'',children:[] as any[],append(...children:any[]){this.children.push(...children)}})
  };
  vm.runInNewContext(inlineScript('AboutPage'),{
    document,window:{CountUp,IntersectionObserver},IntersectionObserver,
    MutationObserver:class {observe(){}disconnect(){}},
    matchMedia:()=>({matches:reducedMotion}),
    fetch:async()=>({ok:true,json:async()=>({today_pv:1234,yesterday_pv:'invalid'})}),
    setInterval,clearInterval
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {rows,started,events,intersect:()=>intersect};
}

test('about statistics wait for deferred libraries and animate only in the viewport',async()=>{
  const state=await statisticsFixture();
  assert.equal(state.rows.length,1);
  assert.equal(state.rows[0].children[0].textContent,'Views today');
  assert.deepEqual(state.started,[]);
  assert.equal(state.intersect(),undefined);
  state.events.DOMContentLoaded();
  state.intersect()?.([{isIntersecting:false}]);
  assert.deepEqual(state.started,[]);
  state.intersect()?.([{isIntersecting:true}]);
  assert.deepEqual(state.started,[1234]);
});

test('about statistics remain readable without animation when reduced motion is enabled',async()=>{
  const state=await statisticsFixture(true);
  state.events.DOMContentLoaded();
  assert.equal(state.rows[0].children[1].textContent,'1,234');
  assert.equal(state.intersect(),undefined);
  assert.deepEqual(state.started,[]);
});

test('reading progress initializes on footerless and non-scrolling pages',()=>{
  const source=readFileSync(new URL('../assets/js/main.js',import.meta.url),'utf8');
  const percent=source.slice(source.indexOf('function percent()'),source.indexOf('// 今日推荐展示更多'));
  for(const height of [771,2000]){
    const label={textContent:'',innerHTML:0},classes=new Set<string>();
    const window:{scrollY:number;pageYOffset:number;onscroll?:unknown}={scrollY:0,pageYOffset:0};
    const document={documentElement:{scrollTop:0,scrollHeight:height,offsetHeight:height,clientHeight:771},body:{scrollHeight:height,offsetHeight:height,clientHeight:771},getElementById:()=>null,querySelector:(selector:string)=>selector==='#percent'?label:{classList:{add:(value:string)=>classes.add(value),remove:(value:string)=>classes.delete(value)}}};
    vm.runInNewContext(percent+';percent();',{document,window,GLOBAL_CONFIG:{i18n:{back_top:'Back to top'}},$:()=>({addClass(){},removeClass(){}})});
    assert.equal(typeof window.onscroll,'function');
    assert.equal(height===771?label.textContent:label.innerHTML,height===771?'Back to top':0);
  }
});
