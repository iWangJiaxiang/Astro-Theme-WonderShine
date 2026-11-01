import { parse } from 'smol-toml';
import type { FileSnapshot, SettingsSchema } from '../shared/types.js';
import { getValue } from './content.js';
import { noteLanguages } from './notes.js';
import type { Repository, WriteGuard } from '../shared/repository.js';
import { revisionOf } from './portable.js';
import { StudioError } from './errors.js';

const parseFile = (file: FileSnapshot | null): Record<string, unknown> => file ? file.path.endsWith('.json') ? JSON.parse(file.text) : parse(file.text) : {};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

// Tables inherit individual fields; arrays and authored scalar values replace the base.
export function mergeLocaleData(base: unknown, override: unknown): unknown {
  if (!object(base) || !object(override)) return override === undefined ? base : override;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])]
    .filter(key => !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(key => [key, Object.hasOwn(override, key) ? mergeLocaleData(base[key], override[key]) : base[key]]));
}

export async function settingsSource(repository: Repository, schema: SettingsSchema, language?: string) {
  const base = await repository.read(schema.file);
  const baseData = parseFile(base);
  const config = language ? schema.file === 'config.toml' ? base : await repository.read('config.toml') : null;
  const languages = noteLanguages(config ? parse(config.text) : {});
  if (language && (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(language) || !languages.languages.includes(language))) throw new StudioError(400, '目标语言未在站点中配置');
  if (!language) return {
    path: schema.file, file: base, data: baseData, revision: base?.revision ?? '',
    mapPath: (path: string) => path, revisionAfter: (revision: string) => revision,
    guard: undefined as WriteGuard | undefined,
  };
  if (language === languages.defaultLanguage) {
    const identity = (revision: string | null) => revisionOf(JSON.stringify([language, schema.file, revision, schema.file === 'config.toml' ? revision : config?.revision ?? null]));
    const revision = await identity(base?.revision ?? null);
    return {
      path: schema.file, file: base, data: baseData, revision,
      mapPath: (path: string) => path, revisionAfter: (next: string) => identity(next),
      guard: async (current: Repository) => {
        if ((await settingsSource(current, schema, language)).revision !== revision) throw new StudioError(409, '文件已更新，请重新加载并合并修改');
      },
    };
  }
  if (!schema.id.startsWith('page-') && !['about', 'friends', 'taxonomies', 'navigation', 'recommendations'].includes(schema.id)) throw new StudioError(400, '此配置分组使用全站设置，不支持单独语言覆盖');
  const path = schema.file === 'config.toml' ? schema.file : schema.file === 'data.toml' ? `data.${language}.toml` : `public/data/friends.${language}.json`;
  const file = path === schema.file ? base : await repository.read(path);
  const overlay = schema.file === 'config.toml' ? getValue(baseData, `extra.locale.${language}`) : parseFile(file);
  const data = schema.file === 'config.toml' ? { ...baseData, extra: mergeLocaleData(baseData.extra, overlay) } : mergeLocaleData(baseData, overlay) as Record<string, unknown>;
  const identity = (targetRevision: string | null) => revisionOf(JSON.stringify([
    language, path, targetRevision, schema.file === path ? targetRevision : base?.revision ?? null,
    path === 'config.toml' ? targetRevision : config?.revision ?? null,
  ]));
  const revision = await identity(file?.revision ?? null);
  return {
    path, file, data, revision,
    mapPath: (field: string) => schema.file === 'config.toml' ? `extra.locale.${language}.${field.replace(/^extra\./, '')}` : field,
    revisionAfter: (next: string) => identity(next),
    guard: async (current: Repository) => {
      const latest = await settingsSource(current, schema, language);
      if (latest.revision !== revision) throw new StudioError(409, '文件已更新，请重新加载并合并修改');
    },
  };
}
