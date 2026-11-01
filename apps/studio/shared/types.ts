export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export interface FileSnapshot { path: string; text: string; revision: string }
export interface SaveResult { revision: string; commit?: string; branch?: string; branchPending?: boolean; message: string }
export type ArticleReference = { kind: 'internal'; path: string } | { kind: 'external'; url: string; title: string };
export interface ArticleSummary {
  path: string; title: string; date: string; draft: boolean; kind: 'article' | 'page' | 'collection' | 'note' | 'topic';
  tags: string[]; categories: string[]; displayTags?: string[]; layout?: string; error?: string;
  id?: string; topics?: string[]; updated?: string; lang?: string; availableLanguages?: string[];
  translationKey?: string; references?: ArticleReference[];
  publicPath?: string; linkWarning?: string; description?: string; render?: boolean; weight?: number;
}
export interface Article extends FileSnapshot { body: string; metadata: Record<string, Json> }
export interface Field { path: string; label: string; hint?: string; kind: 'text' | 'textarea' | 'boolean' | 'number' | 'structured'; default: Json }
export interface SettingsSchema { id: string; title: string; description: string; file: string; fields: Field[] }
export interface Settings extends SettingsSchema { values: Record<string, Json>; revision: string }
export interface Identity { id: string; name: string; method: 'password' | 'oidc' }

export interface ContentLanguages { defaultLanguage: string; languages: string[] }
