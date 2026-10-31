import assert from 'node:assert/strict';
import test from 'node:test';
import {createProvider, normalizePage, resultURL, excerpt, SearchSession, type SearchPage} from '../src/components/search/provider';
const site = 'https://blog.example.com';
const empty: SearchPage = {items:[],page:0,pages:0,total:0};
test('search URLs remain on the configured site and preserve anchors safely', () => {
  for (const url of ['javascript:alert(1)','data:text/html,hello','https://evil.example/x','//evil.example/x','/\\evil.example','https://user:password@blog.example.com/','\n/foo']) assert.equal(resultURL(url, site), undefined, url);
  assert.equal(resultURL(`${site}/articles/a/#heading`, site), '/articles/a/#heading');
  assert.equal(resultURL(`${site}//evil.example/path`, site), '/evil.example/path');
  assert.equal(resultURL('/en/article/?q=x', site), '/en/article/?q=x');
});
test('normalizes both scraper schemas, rejects malformed responses and avoids unsafe highlights', () => {
  const payload = {hits:[
    {url:`${site}/a/#h`,hierarchy_lvl2:'Article',hierarchy_lvl3:'Section',content:'Some text',_highlightResult:{content:{value:'<img src=x onerror=alert(1)>'}}},
    {url:`${site}/a/#h`,title:'Duplicate'}, {url:'javascript:alert(1)',title:'Unsafe'},
    {url:`${site}/b/`,hierarchy:{lvl2:'Other article',lvl3:'Heading'},content:'<script>alert(1)</script>'}
  ],totalHits:9,totalPages:2};
  const response = normalizePage(payload,'meilisearch','text',0,site);
  assert.equal(response.items.length,2);assert.equal(response.items[0].excerpt,'Some text');
  assert.equal(response.items[1].section,'Heading');assert.equal(response.items[1].excerpt,'<script>alert(1)</script>');
  assert.equal(response.pages,2);assert.equal(response.total,9);
  assert.equal(normalizePage({...payload,nbPages:3,nbHits:14},'algolia','',1,site).pages,3);
  assert.throws(()=>normalizePage({},'meilisearch','',0,site), /Invalid/);
  assert.deepEqual(normalizePage({hits:[],totalHits:0,totalPages:0},'meilisearch','',0,site),empty);
});
test('excerpt includes a late match and caps long content', () => {
  const value = excerpt('x'.repeat(300) + 'needle' + 'y'.repeat(300),'needle');
  assert.ok(value.includes('needle'));assert.ok(value.startsWith('…'));assert.ok(value.length<=182);
});
test('legacy Algolia records retain path and content-only results', () => {
  const page = normalizePage({hits:[{path:'/legacy/',content:'Legacy article content'}],nbHits:1,nbPages:1}, 'algolia', 'article', 0, site);
  assert.equal(page.items[0].url,'/legacy/');
  assert.equal(page.items[0].title,'Legacy article content');
});
test('provider preserves Meilisearch config and converts pagination to one-based', async () => {
  let captured: {url:string;init?:RequestInit} | undefined;
  const request: typeof fetch = async (url,init) => {captured={url:String(url),init};return new Response(JSON.stringify({hits:[],totalPages:0,totalHits:0}));};
  await createProvider({engine:'meilisearch',meilisearch:{host:'https://search.example.com/',indexName:'blog',apiKey:'public-search-key'}},site,request)('hello',2,new AbortController().signal);
  assert.equal(captured?.url,'https://search.example.com/indexes/blog/search');
  assert.deepEqual(JSON.parse(String(captured?.init?.body)),{q:'hello',page:3,hitsPerPage:6});
  assert.equal((captured?.init?.headers as Record<string,string>).Authorization,'Bearer public-search-key');
});
test('Algolia uses zero-based pages and public search authentication', async () => {
  const request: typeof fetch = async (url,init) => {
    assert.equal(String(url),'https://APP-dsn.algolia.net/1/indexes/blog/query');
    assert.deepEqual(JSON.parse(String(init?.body)),{query:'hello',page:2,hitsPerPage:6});
    assert.equal((init?.headers as Record<string,string>)['X-Algolia-API-Key'],'search-only');
    return new Response(JSON.stringify({hits:[],nbPages:0,nbHits:0}));
  };
  await createProvider({engine:'algolia',algolia:{appId:'APP',apiKey:'search-only',indexName:'blog'}},site,request)('hello',2,new AbortController().signal);
});
test('failed response surfaces an error and the same provider can retry', async () => {
  let calls=0;
  const request: typeof fetch = async () => ++calls===1 ? new Response('',{status:404}) : new Response(JSON.stringify({hits:[],totalHits:0,totalPages:0}));
  const session=new SearchSession(createProvider({engine:'meilisearch',meilisearch:{host:'https://search.example.com',indexName:'blog'}},site,request));
  await assert.rejects(session.run('hello',0), /404/);
  assert.deepEqual(await session.run('hello',0),empty);
});
test('typing cancels stale requests even when a provider ignores its abort signal', async () => {
  const resolvers: ((page:SearchPage)=>void)[]=[];
  const session = new SearchSession(()=>new Promise(resolve=>resolvers.push(resolve)));
  const first=session.run('old',0);session.cancel();
  const second=session.run('new',0);resolvers[1]({...empty,total:2});
  assert.equal((await second)?.total,2);resolvers[0]({...empty,total:1});assert.equal(await first,undefined);
});
test('request deadline produces retryable error without permanently disabling search', async () => {
  let calls=0;
  const session=new SearchSession(()=>++calls===1?new Promise(()=>{}):Promise.resolve(empty),10);
  await assert.rejects(session.run('timeout',0),/interrupted/);
  assert.deepEqual(await session.run('retry',0),empty);
});
