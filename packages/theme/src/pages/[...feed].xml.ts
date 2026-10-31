import {loadSite} from '../lib/content';
import {feeds,renderFeed} from '../lib/feeds';
import type {APIContext} from 'astro';
export async function getStaticPaths(){const site=await loadSite();return feeds(site).map(feed=>({params:{feed:feed.path},props:{site,feed}}));}
export function GET({props}:APIContext){return new Response(renderFeed(props.site,props.feed),{headers:{'Content-Type':'application/xml; charset=utf-8'}});}
