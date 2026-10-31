import {loadSite} from '../lib/content';
import {routes} from '../lib/routes';
import {xml} from '../lib/feeds';
export async function GET(){const site=await loadSite();return new Response(`<?xml version="1.0" encoding="utf-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes(site).filter(r=>!r.redirect).map(r=>`<url><loc>${xml(new URL(r.path,site.config.base_url).href)}</loc>${r.document?.updated?`<lastmod>${xml(r.document.updated)}</lastmod>`:''}</url>`).join('')}</urlset>`,{headers:{'Content-Type':'application/xml'}});}
