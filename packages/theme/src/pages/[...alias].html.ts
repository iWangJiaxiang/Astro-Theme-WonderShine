import {loadSite} from '../lib/content';
import {routes} from '../lib/routes';
import {xml} from '../lib/feeds';
import type {APIContext} from 'astro';
export async function getStaticPaths(){
 const site=await loadSite();
 return routes(site).filter(r=>r.redirect&&r.path.endsWith('.html')).map(route=>({params:{alias:route.path.slice(1,-5)},props:{site,route}}));
}
export function GET({props}:APIContext){
 const {site,route}=props;
 const target=xml(route.redirect);
 return new Response(`<!doctype html><html lang="${xml(route.lang)}"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><link rel="canonical" href="${xml(new URL(route.redirect,site.config.base_url).href)}"><meta name="robots" content="noindex"><title>${xml(route.title)}</title></head><body><a href="${target}">${xml(route.title)}</a></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
}
