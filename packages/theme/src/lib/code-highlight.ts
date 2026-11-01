import {createRequire} from 'node:module';

interface PrismRuntime {
  languages: Record<string, object>;
  highlight(source: string, grammar: object, language: string): string;
}
interface LanguageDefinition { alias?: string | string[] }
const require = createRequire(import.meta.url);
let prism: PrismRuntime | undefined;
let languages: Record<string, LanguageDefinition> | undefined;
let loadLanguages: ((language: string) => void) | undefined;
const escapeCode = (source: string) => source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Resolve only registered Prism grammars; no browser language bundle is needed. */
export function highlightCode(source: string, requested: string): string {
  if (!/^[a-z][a-z0-9-]*$/i.test(requested)) return escapeCode(source);
  languages ??= require('prismjs/components.json').languages;
  const name = requested.toLowerCase();
  const canonical = Object.hasOwn(languages!, name) && name !== 'meta' ? name
    : Object.entries(languages!).find(([, value]) => value.alias && [value.alias].flat().includes(name))?.[0];
  if (!canonical) return escapeCode(source);
  prism ??= require('prismjs');
  loadLanguages ??= require('prismjs/components/index.js');
  if (!Object.hasOwn(prism!.languages, canonical)) loadLanguages!(canonical);
  const grammar = prism!.languages[canonical];
  return grammar ? prism!.highlight(source, grammar, canonical) : escapeCode(source);
}
