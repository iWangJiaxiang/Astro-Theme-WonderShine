import type { Document, Site } from './types';
import { articles, descendants, isPublic, notes, taxonomyDocuments, taxonomyName, taxonomySlug } from './queries';

export interface Route { path:string; lang:string; type:string; title:string; document?:Document; items?:Document[]; page?:number; pages?:number; base?:string; taxonomy?:string; term?:string; redirect?:string; }

export function routes(site: Site): Route[] {
  const result = new Map<string, Route>();
  const add = (route: Route) => {
    if (result.has(route.path)) throw new Error(`Duplicate route ${route.path}`);
    result.set(route.path, route);
  };
  const paginate = (route: Route, items: Document[], size: number, paginatePath = 'page') => {
    const pages = Math.max(1, Math.ceil(items.length / (size || items.length || 1)));
    for (let page = 1; page <= pages; page++) add({ ...route, path: page === 1 ? route.path : `${route.path}${paginatePath}/${page}/`, base: route.path, page, pages, items: size ? items.slice((page - 1) * size, page * size) : items });
    if (size) add({ ...route, path: `${route.path}${paginatePath}/1/`, redirect: route.path });
  };
  for (const document of [...site.sections, ...site.documents]) {
    if (!isPublic(document, site)) continue;
    const type = document.layout?.replace(/^page\//, '').replace(/\.html$/, '') || (document.kind === 'section' ? 'index' : document.kind === 'article' ? 'post' : document.kind);
    const route: Route = { path: document.url, lang: document.lang, type, title: document.title, document };
    const paginatePath = document.frontmatter.paginate_path || 'page';
    if (type === 'index') paginate(route, articles(site, document.lang), document.paginateBy || 8, paginatePath);
    else if (type === 'notes') paginate(route, notes(site, document.lang), document.paginateBy || 12, paginatePath);
    else if (type === 'archives' && document.paginateBy) paginate(route, articles(site, document.lang), document.paginateBy, paginatePath);
    else if (document.paginateBy) paginate(route, descendants(site, document), document.paginateBy, paginatePath);
    else add(route);
    for (const alias of document.aliases) if (alias !== document.url) add({ ...route, path: alias, redirect: document.url });
  }
  for (const lang of site.languages) {
    const prefix = lang === site.defaultLanguage ? '/' : `/${lang}/`;
    const taxonomyConfig = lang === site.defaultLanguage ? site.config.taxonomies : site.config.languages?.[lang]?.taxonomies;
    for (const taxonomy of taxonomyConfig || []) {
      const docs = taxonomyDocuments(site, lang, taxonomy.name);
      // Zola does not create a taxonomy root when that language has no terms.
      if (!docs.length) continue;
      const base = `${prefix}${taxonomy.name}/`;
      add({ path: base, lang, type: 'taxonomy-list', taxonomy: taxonomy.name, title: taxonomy.display_name || taxonomy.name, items: docs });
      for (const term of [...new Set(docs.flatMap(doc => doc.taxonomies[taxonomy.name]))].sort()) {
        const termPath = taxonomySlug(site, term);
        paginate({ path: `${base}${termPath}/`, lang, type: 'taxonomy', taxonomy: taxonomy.name, term, title: taxonomyName(site, taxonomy.name, term, lang) }, docs.filter(doc => doc.taxonomies[taxonomy.name].includes(term)), taxonomy.paginate_by || 0, taxonomy.paginate_path || 'page');
      }
    }
  }
  return [...result.values()];
}
