import { isDeepStrictEqual } from './portable.js';
import { parse } from 'smol-toml';
import type { FileSnapshot, Json } from '../shared/types.js';
import type { Repository } from '../shared/repository.js';
import { getValue, patchToml, removeTomlFields, splitDocument } from './content.js';
import { threadLanguages, threadPath, threadMetadata } from './threads.js';
import { StudioError } from './errors.js';
import { translationLocation } from '../shared/translation.js';

export function taxonomyNames(config: Record<string, unknown>, language: string): Set<string> {
  const owner = language === threadLanguages(config).defaultLanguage ? config : getValue(config, `languages.${language}`);
  const configured = getValue(owner, 'taxonomies');
  return new Set(Array.isArray(configured) ? configured.flatMap(value => typeof value?.name === 'string' ? [value.name] : []) : []);
}
function taxonomyError(language: string, name: string): never {
  throw new StudioError(400, '语言 {language} 的分类 {name} 未配置，请先配置或移除此分类', { language, name });
}
export function validateThreadTaxonomies(path: string, text: string, config: Record<string, unknown>): void {
  const { lang } = threadPath(path, threadLanguages(config));
  const names = taxonomyNames(config, lang);
  const metadata = parse(splitDocument(text).header);
  const taxonomies = metadata.taxonomies;
  if (taxonomies && typeof taxonomies === 'object') {
    for (const name of Object.keys(taxonomies)) if (!names.has(name)) taxonomyError(lang, name);
  }
}

export async function prepareThreadTaxonomies(repository: Repository, path: string, current: FileSnapshot | null, changes: Record<string, Json>) {
  const configFile = await repository.read('config.toml');
  const config = configFile ? parse(configFile.text) : {};
  const languages = threadLanguages(config), location = threadPath(path, languages);
  const names = taxonomyNames(config, location.lang);
  const defaults = Object.fromEntries(['tags', 'categories'].filter(name => names.has(name)).map(name => [`taxonomies.${name}`, []]));
  const filtered = { ...changes };
  const originalMetadata = current ? threadMetadata(current) : {};
  const candidate = parse(patchToml(current ? splitDocument(current.text).header : '', changes));
  const taxonomies = candidate.taxonomies;
  const removed: string[] = [];
  const siblings = !current ? (await repository.list()).filter(file => file.path.startsWith(`content/threads/${location.id}/index`) && file.path !== path) : [];
  if (taxonomies && typeof taxonomies === 'object') for (const [name, value] of Object.entries(taxonomies)) {
    if (names.has(name)) continue;
    const inherited = siblings.some(file => isDeepStrictEqual(getValue(threadMetadata(file), `taxonomies.${name}`), value));
    if ((!Array.isArray(value) || value.length > 0) && !inherited) taxonomyError(location.lang, name);
    delete filtered[`taxonomies.${name}`];
    if (getValue(originalMetadata, `taxonomies.${name}`) !== undefined) removed.push(`taxonomies.${name}`);
  }
  let base = current?.text;
  if (base && removed.length) {
    const document = splitDocument(base);
    base = base.slice(0, document.start) + removeTomlFields(document.header, removed) + base.slice(document.end);
  }
  return { defaults, changes: filtered, base };
}

export async function prepareLocalizedTaxonomies(repository: Repository, path: string, current: FileSnapshot | null, changes: Record<string, Json>) {
  const configFile = await repository.read('config.toml');
  const config = configFile ? parse(configFile.text) : {};
  const languages = threadLanguages(config), language = translationLocation(path, languages.defaultLanguage, languages).sourceLanguage;
  if (language === languages.defaultLanguage) return undefined;
  const names = taxonomyNames(config, language);
  const filtered = { ...changes }, document = current ? splitDocument(current.text) : undefined;
  const metadata = parse(patchToml(document?.header ?? '', changes));
  const removed: string[] = [];
  for (const [name, value] of Object.entries(metadata.taxonomies || {})) {
    if (names.has(name)) continue;
    if (!Array.isArray(value) || value.length) taxonomyError(language, name);
    delete filtered[`taxonomies.${name}`]; removed.push(`taxonomies.${name}`);
  }
  const base = current && document ? current.text.slice(0, document.start) + removeTomlFields(document.header, removed) + current.text.slice(document.end) : undefined;
  return { changes: filtered, defaults: Object.fromEntries(['tags', 'categories'].filter(name => names.has(name)).map(name => [`taxonomies.${name}`, []])), base };
}

export function validateLocalizedTaxonomies(path: string, text: string, config: Record<string, unknown>): void {
  const languages = threadLanguages(config), language = translationLocation(path, languages.defaultLanguage, languages).sourceLanguage;
  if (language === languages.defaultLanguage) return;
  const names = taxonomyNames(config, language), metadata = parse(splitDocument(text).header);
  for (const name of Object.keys(metadata.taxonomies || {})) if (!names.has(name)) taxonomyError(language, name);
}
