import { translationReviewChanges } from './translation-review.js';
import { posix } from 'node:path';
import { parse } from 'smol-toml';
import type { Article, ArticleSummary, ArticleReference, Json, Settings, Field } from '../shared/types.js';
import { settingsSchemas, documentFields } from '../shared/settings.js';
import { getValue, patchToml, splitDocument, updateDocument, formDocumentMetadata, removeTomlFields } from './content.js';
import { type Repository, validatePath } from './repository.js';
import { StudioError } from './errors.js';
import { stringValues } from '../shared/choices.js';
import { dateParts } from '../shared/form-fields.js';
import { contentLink } from '../shared/content-links.js';
import { fillFieldDefaults } from '../shared/form-defaults.js';
import { prepareNoteTaxonomies, validateNoteTaxonomies, prepareLocalizedTaxonomies, validateLocalizedTaxonomies } from './note-taxonomies.js';
import { validateContentRelations } from './content-relations.js';
import { topicPath, topicChanges } from './topics.js';
import { noteLanguages, notePath, noteWriteGuard, noteRouteChanges } from './notes.js';
import { pageSettingsSchemas } from '../shared/page-settings.js';
import { translationLocation } from '../shared/translation.js';
import { localeSectionWrites } from './content-locales.js';
import { settingsSource } from './localized-settings.js';

const allSettingsSchemas = [...settingsSchemas, ...pageSettingsSchemas];

export const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
function validateChanges(changes: unknown, fields: Field[]): asserts changes is Record<string, Json> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new StudioError(400, '修改内容必须是字段对象');
  for (const [path, value] of Object.entries(changes)) {
    const field = fields.find(f => f.path === path);
    if (!field) throw new StudioError(400, '不允许修改字段：{path}', { path });
    const valid = field.kind === 'structured' ? Array.isArray(field.default) ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value)
      : field.kind === 'boolean' ? typeof value === 'boolean' : field.kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === 'string';
    if (!valid) throw new StudioError(400, '字段“{path}”的格式不正确', { path });
    if (path === 'base_url') {
      let url: URL | undefined;
      try { url = new URL(String(value)); } catch { /* Reject incomplete site addresses below. */ }
      if (!url || !/^https?:\/\/\S+$/i.test(String(value)) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw new StudioError(400, '站点地址必须是完整的 HTTP(S) 地址，例如 https://blog.example.com');
      }
    }
    if (path.endsWith('_skin') && !/^#[\da-fA-F]{6}$/.test(String(value))) throw new StudioError(400, '主题色需要使用六位十六进制颜色');
    if (path.endsWith('color_scheme') && !['system', 'dark', 'light'].includes(String(value))) throw new StudioError(400, '颜色模式应为 system、light 或 dark');
    if ((path === 'date' || path === 'updated') && value !== '' && !dateParts(String(value))) throw new StudioError(400, '请选择有效的日期和时间');
  }
}
function documentPath(path: string) { validatePath(path); if (!path.startsWith('content/')) throw new StudioError(400, '请选择文章或页面路径'); }
export class ContentService {
  constructor(private repository: Repository, private now: () => Date = () => new Date()) {}
  async settings(id: string, language?: string): Promise<Settings> {
    const schema = allSettingsSchemas.find(s => s.id === id);
    if (!schema) throw new StudioError(404, '未找到配置分组');
    const source = await settingsSource(this.repository, schema, language);
    const values = Object.fromEntries(schema.fields.map(field => [field.path, fillFieldDefaults(field.path, asJson(getValue(source.data, field.path) ?? field.default), field.default)]));
    return { ...schema, file: source.path, values, revision: source.revision };
  }
  async saveSettings(id: string, changes: unknown, revision: string | null, language?: string) {
    const schema = allSettingsSchemas.find(s => s.id === id);
    if (!schema) throw new StudioError(404, '未找到配置分组');
    validateChanges(changes, schema.fields);
    const source = await settingsSource(this.repository, schema, language);
    if ((source.revision || null) !== (revision || null)) throw new StudioError(409, '文件已更新，请重新加载并合并修改');
    const mapped = Object.fromEntries(Object.entries(changes).map(([path, value]) => [source.mapPath(path), value]));
    const text = source.path.endsWith('.json') ? JSON.stringify({ ...(source.file ? JSON.parse(source.file.text) : {}), ...mapped }, null, 2) + '\n'
      : patchToml(source.file?.text ?? '', mapped);
    const saved = await this.repository.write(source.path, text, source.file?.revision ?? null, source.guard);
    return { ...saved, revision: source.revisionAfter(saved.revision) };
  }
  async languages() {
    const file = await this.repository.read('config.toml');
    return noteLanguages(file ? parse(file.text) : {});
  }
  async list(): Promise<ArticleSummary[]> {
    const [files, configFile] = await Promise.all([this.repository.list(), this.repository.read('config.toml')]);
    const config = configFile ? asJson(parse(configFile.text)) as Record<string, Json> : {};
    const languages = noteLanguages(config);
    const summaries: ArticleSummary[] = files.map(file => {
      const kind = file.path.startsWith('content/articles/') ? 'article' : file.path.startsWith('content/pages/') ? 'page' : file.path.startsWith('content/notes/') ? 'note' : file.path.startsWith('content/topics/') ? 'topic' : 'collection';
      try {
        const document = splitDocument(file.text);
        const metadata = parse(document.header);
        const localized = (kind === 'note' || kind === 'topic') && !/\/_index(?:\.[^.]+)?\.md$/.test(file.path) ? (kind === 'topic' ? topicPath : notePath)(file.path, languages) : undefined;
        const locale = translationLocation(file.path, languages.defaultLanguage, languages);
        return { path: file.path, title: String(metadata.title || (kind === 'note' && localized ? document.body.replace(/[#*`>\[\]]/g, '').trim().slice(0, 80) : '') || file.path.split('/').slice(-2).join('/')), date: metadata.date instanceof Date ? metadata.date.toISOString() : typeof metadata.date === 'string' ? metadata.date : '',
          lang: locale.sourceLanguage, translationKey: locale.translationKey,
          ...(localized ? { id: String(getValue(metadata, 'extra.id') || '') } : {}),
          references: (getValue(metadata, 'extra.references') || []) as ArticleReference[],
          updated: metadata.updated instanceof Date ? metadata.updated.toISOString() : typeof metadata.updated === 'string' ? metadata.updated : '', topics: stringValues(getValue(metadata, 'extra.topics')),
          draft: metadata.draft === true, kind, tags: stringValues(getValue(metadata, 'taxonomies.tags')), categories: stringValues(getValue(metadata, 'taxonomies.categories')),
          displayTags: stringValues(getValue(metadata, 'extra.tags')), layout: typeof metadata.layout === 'string' ? metadata.layout : undefined,
          ...contentLink(file.path, asJson(metadata) as Record<string, Json>, config),
          description: typeof metadata.description === 'string' ? metadata.description : '', render: metadata.render !== false,
          weight: typeof metadata.weight === 'number' ? metadata.weight : 0 } satisfies ArticleSummary;
      } catch {
        let lang: string | undefined;
        try { lang = kind === 'note' || kind === 'topic' ? (kind === 'topic' ? topicPath : notePath)(file.path, languages).lang : translationLocation(file.path, languages.defaultLanguage, languages).sourceLanguage; } catch { /* Unknown or malformed paths remain visible for repair. */ }
        return { path: file.path, title: file.path, date: '', draft: false, kind, tags: [], categories: [], lang, error: 'TOML 格式需要检查' } satisfies ArticleSummary;
      }
    });
    return summaries.map(item => ({ ...item, availableLanguages: item.translationKey ? summaries.filter(other => other.translationKey === item.translationKey && other.lang).map(other => other.lang!).sort() : [] }));
  }
  async document(path: string): Promise<Article> {
    documentPath(path);
    const file = await this.repository.read(path);
    if (!file) throw new StudioError(404, '未找到文章');
    const doc = splitDocument(file.text);
    return { ...file, body: doc.body, metadata: asJson(formDocumentMetadata(doc.header)) as Record<string, Json> };
  }
  async saveDocument(path: string, changes: unknown, body: string, revision: string | null) {
    documentPath(path); validateChanges(changes, documentFields);
    if (typeof body !== 'string') throw new StudioError(400, '正文必须是文本');
    const current = await this.repository.read(path);
    if ((current?.revision ?? null) !== (revision || null)) throw new StudioError(409, '文件已更新，请重新加载并合并修改');
    if (!current && path.startsWith('content/collections/') && !/^content\/collections\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path)) {
      const parent = /\/(?:_?index)(?:\.[A-Za-z0-9-]+)?\.md$/.test(path) ? posix.dirname(posix.dirname(path)) : posix.dirname(path);
      const languages = await this.languages();
      const parents = await Promise.all(languages.languages.map(language => this.repository.read(translationLocation(`${parent}/_index.md`, language, languages).path)));
      if (!parents.some(Boolean)) throw new StudioError(400, '请先创建上级专栏或合集');
    }
    const isSection = /\/_index(?:\.[^.]+)?\.md$/.test(path);
    const isNote = path.startsWith('content/notes/') && !isSection;
    const isTopic = path.startsWith('content/topics/') && !isSection;
    const noteTaxonomies = isNote ? await prepareNoteTaxonomies(this.repository, path, current, changes) : !isTopic ? await prepareLocalizedTaxonomies(this.repository, path, current, changes) : undefined;
    const contentChanges = isTopic ? await topicChanges(this.repository, path, current, changes, this.now()) : noteTaxonomies?.changes ?? changes;
    const effectiveChanges = translationReviewChanges(current?.text, contentChanges, body);
    if (isNote) Object.assign(effectiveChanges, noteRouteChanges(path, current?.text, contentChanges, await this.languages()));
    const defaults = { draft: true, ...(path.startsWith('content/pages/') ? { layout: 'empty', 'extra.type': 'page' } : {}), ...(isSection && path.startsWith('content/collections/') ? { 'extra.cover': '/img/default-cover.svg', 'extra.tags': [] } : {}), ...(isSection ? {} : { date: isNote ? new Date().toISOString() : new Date().toISOString().slice(0, 10), ...(isTopic ? {} : noteTaxonomies?.defaults ?? { 'taxonomies.tags': [], 'taxonomies.categories': [] }) }) };
    let base = noteTaxonomies?.base ?? current?.text ?? `+++\n${patchToml('', defaults)}+++\n`;
    if (isNote && current) {
      const document = splitDocument(base);
      base = base.slice(0, document.start) + removeTomlFields(document.header, ['extra.thread_root', 'extra.reply_to']) + base.slice(document.end);
    }
    const text = updateDocument(base, effectiveChanges, body);
    const metadata = parse(splitDocument(text).header);
    const needsDate = (!isSection && !path.startsWith('content/pages/')) || ['post', 'collection-content'].includes(String(metadata.layout)) || (isSection && !!metadata.updated);
    if (needsDate && !metadata.date && (effectiveChanges.date === '' || (isSection && !!effectiveChanges.updated))) throw new StudioError(400, '这类内容需要发布时间，请选择日期后保存');
    if (!isNote && (!metadata.title || typeof metadata.title !== 'string')) throw new StudioError(400, '请填写标题');
    const sections = await localeSectionWrites(this.repository, path);
    return this.repository.writeBatch([{ path, text, expectedRevision: revision || null }, ...sections.entries], async repository => {
      await sections.guard(repository);
      if (!current && path.startsWith('content/collections/') && !/^content\/collections\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path)) {
        const parent = /\/(?:_?index)(?:\.[A-Za-z0-9-]+)?\.md$/.test(path) ? posix.dirname(posix.dirname(path)) : posix.dirname(path);
        const configuration = await repository.read('config.toml');
        const languages = noteLanguages(configuration ? parse(configuration.text) : {});
        const parents = await Promise.all(languages.languages.map(language => repository.read(translationLocation(`${parent}/_index.md`, language, languages).path)));
        if (!parents.some(Boolean)) throw new StudioError(409, '上级内容已更新，请重新加载后保存');
      }
      const config = await repository.read('config.toml');
      validateLocalizedTaxonomies(path, text, config ? parse(config.text) : {});
      if (isNote) {
        validateNoteTaxonomies(path, text, config ? parse(config.text) : {});
        await noteWriteGuard(path, text)(repository);
      }
      await validateContentRelations(repository, path, text);
    });
  }
  async removeDocument(path: string, revision: string) {
    documentPath(path);
    return this.repository.write(path, null, revision, repository => validateContentRelations(repository, path, null));
  }
}
