import {loadSite} from '../lib/content';
export async function GET(){const site=await loadSite();return new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap.xml',site.config.base_url).href}\n`,{headers:{'Content-Type':'text/plain'}});}
