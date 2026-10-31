import type { ContentLanguages, Json } from './types.js';

export interface TranslationSettings { baseUrl: string; model: string; apiKey: string }
export interface TranslationCapabilities { enabled: boolean; model?: string }
export interface TranslationRequest { path: string; revision: string; language: string }
export interface TranslationResult { path: string; revision: string }

export function translationLocation(path: string, language: string, config: ContentLanguages) {
  if (!/^content\/(?:(?:articles|pages|collections|notes|topics)\/.+|_index(?:\.[A-Za-z0-9-]+)?)\.md$/.test(path)) throw new Error('此类内容暂不支持创建翻译版本');
  if (!config.languages.includes(language)) throw new Error('目标语言未在站点中配置');
  const suffix = path.match(/\.([A-Za-z0-9-]+)\.md$/)?.[1];
  const sourceLanguage = suffix && config.languages.includes(suffix) ? suffix : config.defaultLanguage;
  const stem = suffix && config.languages.includes(suffix) ? path.slice(0, -(suffix.length + 4)) : path.slice(0, -3);
  return { path: `${stem}${language === config.defaultLanguage ? '' : `.${language}`}.md`, sourceLanguage, translationKey: `${stem}.md` };
}

export function translationTextChanged(before: Record<string, Json>, after: Record<string, Json>, oldBody: string, body: string): boolean {
  return oldBody !== body || ['title', 'description'].some(key => String(before[key] ?? '') !== String(after[key] ?? ''));
}
