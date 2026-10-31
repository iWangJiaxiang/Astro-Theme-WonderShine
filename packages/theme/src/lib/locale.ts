import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'smol-toml';
import { themePath } from './theme-paths';
import type { Site, Document } from './types';
import { isPublic, taxonomySlug } from './queries';

type Dictionary = Record<string, any>;
const catalogs = new Map<string, {version:string;data:Dictionary}>();
function readToml(file: string): Dictionary {
  if (!existsSync(file)) return {};
  return parse(readFileSync(file, 'utf8'));
}
export function mergeLocale(base: Dictionary, overlay: Dictionary): Dictionary {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) &&
      base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? mergeLocale(base[key], value) : value;
  }
  return result;
}
export function localizeConfig(site: Site, lang: string): Dictionary {
  const defaults = readToml(themePath('defaults/config.toml')).extra || {};
  const skeleton = {site:{logo:'/img/logo.webp',analytics:{},author:{}},style:{theme_light_skin:'#425AEF',theme_dark_skin:'#f2b94b',color_scheme:'system',translate:{}},nav:{right:{}},tool:{rightside:{},right_menu:{},nav_music:{},snackbar:{}},other:{loading_box:{},lazyload:{}},post:{abstract:{},copyrights:{}},sidebar:{},footer:{},about:{},about_reward:{},comments:{barrage:{}},activity:{},lib:{},code:{},top:{global_background:{}}};
  const config:Dictionary = {...site.config,extra:mergeLocale(mergeLocale(skeleton,defaults),site.config.extra || {})};
  const language = config.languages?.[lang] || {};
  return { ...config, ...language,
    extra: mergeLocale(config.extra || {}, config.extra?.locale?.[lang] || {}) };
}
export function localizeData(site: Site, lang: string): Dictionary {
  return site.localizedData?.[lang] || mergeLocale(site.data || {}, readToml(resolve(site.root || '.',`data.${lang}.toml`)));
}
export function t(key: string, lang: string, site?: Site, kind = 'theme'): string {
  const config = site?.config || {};
  const overridePath = kind === 'theme' ? config.extra?.i18n?.catalog_path : config.extra?.i18n?.activity_catalog_path;
  const file = overridePath ? resolve(site?.root || '.', overridePath) : themePath('locales', kind + '.toml');
  const stat=existsSync(file)?statSync(file):undefined;
  const version=stat?`${stat.ino}:${stat.mtimeMs}:${stat.size}`:'missing';
  if (catalogs.get(file)?.version!==version) catalogs.set(file, {version,data:readToml(file)});
  const catalog = mergeLocale(readToml(themePath('locales', kind + '.toml')), catalogs.get(file)!.data);
  const translations = lang === (site?.defaultLanguage || 'zh-CN') ? config.translations : config.languages?.[lang]?.translations;
  const override = translations?.[`${kind}_${key}`];
  if (override) return String(override);
  // Framework attribution follows the actual renderer after migration.
  if (key === 'built_with') return lang.startsWith('zh') ? '本站及主题基于 Astro 构建' : 'Built with Astro';
  return String(catalog[lang]?.[key] ?? catalog[lang.startsWith('zh') ? 'zh' : 'en']?.[key] ?? catalog.en?.[key] ?? key);
}
export function languageName(code: string, site?: Site): string {
  return site?.config.extra?.i18n?.language_names?.[code] ||
    (code.startsWith('zh') ? '中文' : code.startsWith('en') ? 'English' : code);
}
export function localeHome(lang: string, site: Site): string {
  return lang === site.defaultLanguage ? '/' : `/${lang}/`;
}
const routeKey = (path: string) => path.replace(/\/+$/, '') || '/';
export function localizeUrl(path: string, lang: string, site: Site): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || lang === site.defaultLanguage) return path;
  const [route] = path.split(/[?#]/);
  const suffix = path.slice(route.length);
  if (route === '/') return localeHome(lang, site) + suffix;
  const all = [...site.documents, ...site.sections];
  const source = all.find(doc => routeKey(doc.url) === routeKey(route));
  const translated = source?.lang === lang && isPublic(source, site) ? source : source?.translations?.find(doc => doc.lang === lang && isPublic(doc, site));
  if (translated) return translated.url + suffix;
  if (/^\/(tags|categories)(\/|$)/.test(route)) {
    const [, taxonomy, term] = route.split('/');
    const terms = site.documents.filter(doc => doc.lang === lang && isPublic(doc, site)).flatMap(doc => doc.taxonomies?.[taxonomy] || []);
    if ((!term && terms.length) || terms.some(value => taxonomySlug(site, value) === decodeURIComponent(term || ''))) return `/${lang}${route}` + suffix;
  }
  return path;
}
export function languageDestinations(site: Site, lang: string, doc?: Document) {
  return site.languages.map(code => {
    const version = code === doc?.lang && isPublic(doc, site) ? doc : doc?.translations?.find(item => item.lang === code && isPublic(item, site));
    return { code, name: languageName(code, site), current: code === lang,
      url: version?.url || localeHome(code, site), translated: Boolean(version) };
  });
}
