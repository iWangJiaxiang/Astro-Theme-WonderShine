import { checkPackageRevision, readThemePackage, themePackageWrites } from './theme-package.js';
import { channelPath, pinPath, versionPath, themePin, themeChannel, resolveThemeVersion } from './theme-channel.js';
import { saveBatch, validateSaveMode } from './save.js';
import { translationReviewChanges } from './translation-review.js';
import { posix, revisionOf } from './portable.js';
import { parse } from 'smol-toml';
import type { Article, ArticleSummary, DocumentVersion, Json, Settings, Field } from '../shared/types.js';
import { settingsSchemas, legacyAppearance, documentFields } from '../shared/settings.js';
import { getValue, patchToml, splitDocument, updateDocument, formDocumentMetadata, removeTomlFields } from './content.js';
import { type Repository, type RepositoryWrite, validatePath } from '../shared/repository.js';
import { StudioError } from './errors.js';
import { dateParts } from '../shared/form-fields.js';
import { fillFieldDefaults } from '../shared/form-defaults.js';
import { prepareThreadTaxonomies, validateThreadTaxonomies, prepareLocalizedTaxonomies, validateLocalizedTaxonomies } from './thread-taxonomies.js';
import { validateContentRelations } from './content-relations.js';
import { topicChanges } from './topics.js';
import { threadLanguages, threadWriteGuard, threadRouteChanges } from './threads.js';
import { pageSettingsSchemas } from '../shared/page-settings.js';
import { translationLocation } from '../shared/translation.js';
import { localeSectionWrites } from './content-locales.js';
import { settingsSource } from './localized-settings.js';
import { contentSummarySteps, createContentSummaryContext, readContentSummaryFacts } from './content-summary.js';

const allSettingsSchemas = [...settingsSchemas, legacyAppearance, ...pageSettingsSchemas];

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
  constructor(private repository: Repository, private now: () => Date = () => new Date(), private themeFetch: typeof fetch = fetch) {}
  async settings(id: string, language?: string): Promise<Settings> {
    const schema = allSettingsSchemas.find(s => s.id === id);
    if (!schema) throw new StudioError(404, '未找到配置分组');
    const source = await settingsSource(this.repository, schema, language);
    const values = Object.fromEntries(schema.fields.map(field => [field.path, fillFieldDefaults(field.path, asJson(getValue(source.data, field.path) ?? field.default), field.default)]));
    return { ...schema, file: source.path, values, revision: source.revision };
  }
  async saveSettings(id: string, changes: unknown, revision: string | null, language?: string, saveMode?: unknown, retryPackage?: unknown) {
    validateSaveMode(this.repository, saveMode);
    const schema = allSettingsSchemas.find(s => s.id === id);
    if (!schema) throw new StudioError(404, '未找到配置分组');
    validateChanges(changes, schema.fields);
    const source = await settingsSource(this.repository, schema, language);
    if ((source.revision || null) !== (revision || null)) throw new StudioError(409, '文件已更新，请重新加载并合并修改');
    const mapped = Object.fromEntries(Object.entries(changes).map(([path, value]) => [source.mapPath(path), value]));
    let pinnedThemeVersion: string | null | undefined;
    let packages: RepositoryWrite[] = [];
    let original = source.file?.text ?? '';
    const isTheme = id === 'theme' || id === 'appearance';
    const selecting = isTheme && [channelPath, pinPath, versionPath].some(path => Object.hasOwn(changes, path));
    const retrying = isTheme && saveMode === 'branch' && typeof retryPackage === 'string';
    const site = selecting || retrying ? await readThemePackage(this.repository) : null;
    if (retrying && (!site || await revisionOf(JSON.stringify([site.file.text, site.lockFile?.text ?? null])) !== retryPackage)) {
      throw new StudioError(409, '文件已更新，请重新加载并合并修改');
    }
    if (selecting) {
      pinnedThemeVersion = await themePin(source.data, changes, this.themeFetch);
      if (site) {
        const channel = themeChannel(changes[channelPath] ?? getValue(source.data, channelPath));
        const target = pinnedThemeVersion ?? await resolveThemeVersion(channel, this.themeFetch);
        packages = await themePackageWrites(site, target, this.themeFetch);
      }
      if (pinnedThemeVersion) mapped[versionPath] = pinnedThemeVersion;
      else {
        delete mapped[versionPath];
        original = removeTomlFields(original, [versionPath]);
      }
    }
    const text = source.path.endsWith('.json') ? JSON.stringify({ ...(source.file ? JSON.parse(source.file.text) : {}), ...mapped }, null, 2) + '\n'
      : patchToml(original, mapped);
    if (site && saveMode === 'branch') {
      for (const file of [site.file, site.lockFile]) {
        if (file && !packages.some(entry => entry.path === file.path)) packages.push({ path: file.path, text: file.text, expectedRevision: file.revision });
      }
    }
    const saved = await saveBatch(this.repository, [{ path: source.path, text, expectedRevision: source.file?.revision ?? null }, ...packages], async current => {
      await source.guard?.(current);
      if (selecting || retrying) await checkPackageRevision(current, site);
    }, saveMode);
    const themeBranchRevision = saved.branchPending && site ? await revisionOf(JSON.stringify(
      ['package.json', 'package-lock.json'].map(path => packages.find(entry => entry.path === path)?.text ?? null),
    )) : undefined;
    return { ...saved, themeBranchRevision, ...(pinnedThemeVersion !== undefined && { pinnedThemeVersion }), revision: await source.revisionAfter(saved.revision) };
  }
  async languages(repository = this.repository) {
    const file = await repository.read('config.toml');
    return threadLanguages(file ? parse(file.text) : {});
  }
  async list(): Promise<ArticleSummary[]> {
    const [files, configFile] = await Promise.all([
      this.repository.listForSummary ? this.repository.listForSummary() : this.repository.list(),
      this.repository.read('config.toml'),
    ]);
    const config = configFile ? asJson(parse(configFile.text)) as Record<string, Json> : {};
    const context = createContentSummaryContext(config);
    // Timer tasks (not microtasks) let the native WebView handle input and paint.
    let sliceStarted = performance.now(), sliceItems = 0;
    const shouldYield = () => ++sliceItems >= 32 || performance.now() - sliceStarted >= 8;
    const yieldToUI = async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      sliceStarted = performance.now(); sliceItems = 0;
    };
    // Parse lazily so timer slices still cover document parsing, not only projection.
    const facts = function* () { for (const file of files) yield readContentSummaryFacts(file); };
    const steps = contentSummarySteps(facts(), context);
    let step = steps.next();
    while (!step.done) {
      if (shouldYield()) await yieldToUI();
      step = steps.next();
    }
    return step.value;
  }
  async document(path: string): Promise<Article> {
    documentPath(path);
    const file = await this.repository.read(path);
    if (!file) throw new StudioError(404, '未找到文章');
    const doc = splitDocument(file.text);
    return { ...file, body: doc.body, metadata: asJson(formDocumentMetadata(doc.header)) as Record<string, Json> };
  }
  async saveDocument(path: string, changes: unknown, body: string, revision: string | null, saveMode?: unknown) {
    validateSaveMode(this.repository, saveMode);
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
    const isThread = path.startsWith('content/threads/') && !isSection;
    const isTopic = path.startsWith('content/topics/') && !isSection;
    const threadTaxonomies = isThread ? await prepareThreadTaxonomies(this.repository, path, current, changes) : !isTopic ? await prepareLocalizedTaxonomies(this.repository, path, current, changes) : undefined;
    const contentChanges = isTopic ? await topicChanges(this.repository, path, current, changes, this.now()) : threadTaxonomies?.changes ?? changes;
    const effectiveChanges = translationReviewChanges(current?.text, contentChanges, body);
    if (isThread) {
      Object.assign(effectiveChanges, threadRouteChanges(path, current?.text, contentChanges, await this.languages()));
      delete effectiveChanges.aliases;
      delete effectiveChanges['extra.comment_path'];
    }
    const defaults = { draft: true, ...(path.startsWith('content/pages/') ? { layout: 'empty', 'extra.type': 'page' } : {}), ...(isSection && path.startsWith('content/collections/') ? { 'extra.cover': '/img/default-cover.svg', 'extra.tags': [] } : {}), ...(isSection ? {} : { date: this.now().toISOString(), ...(isTopic ? {} : threadTaxonomies?.defaults ?? { 'taxonomies.tags': [], 'taxonomies.categories': [] }) }) };
    let base = threadTaxonomies?.base ?? current?.text ?? `+++\n${patchToml('', defaults)}+++\n`;
    if (isThread && current) {
      const document = splitDocument(base);
      base = base.slice(0, document.start) + removeTomlFields(document.header, ['aliases', 'extra.comment_path', 'extra.thread_root', 'extra.reply_to']) + base.slice(document.end);
    }
    const text = updateDocument(base, effectiveChanges, body);
    const metadata = parse(splitDocument(text).header);
    const needsDate = (!isSection && !path.startsWith('content/pages/')) || ['post', 'collection-content'].includes(String(metadata.layout)) || (isSection && !!metadata.updated);
    if (needsDate && !metadata.date && (effectiveChanges.date === '' || (isSection && !!effectiveChanges.updated))) throw new StudioError(400, '这类内容需要发布时间，请选择日期后保存');
    if (!isThread && (!metadata.title || typeof metadata.title !== 'string')) throw new StudioError(400, '请填写标题');
    const sections = await localeSectionWrites(this.repository, path);
    return saveBatch(this.repository, [{ path, text, expectedRevision: revision || null }, ...sections.entries], async repository => {
      await sections.guard(repository);
      if (!current && path.startsWith('content/collections/') && !/^content\/collections\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path)) {
        const parent = /\/(?:_?index)(?:\.[A-Za-z0-9-]+)?\.md$/.test(path) ? posix.dirname(posix.dirname(path)) : posix.dirname(path);
        const configuration = await repository.read('config.toml');
        const languages = threadLanguages(configuration ? parse(configuration.text) : {});
        const parents = await Promise.all(languages.languages.map(language => repository.read(translationLocation(`${parent}/_index.md`, language, languages).path)));
        if (!parents.some(Boolean)) throw new StudioError(409, '上级内容已更新，请重新加载后保存');
      }
      const config = await repository.read('config.toml');
      validateLocalizedTaxonomies(path, text, config ? parse(config.text) : {});
      if (isThread) {
        validateThreadTaxonomies(path, text, config ? parse(config.text) : {});
        await threadWriteGuard(path, text)(repository);
      }
      await validateContentRelations(repository, path, text);
    }, saveMode);
  }
  async documentVersions(path: string, repository = this.repository): Promise<DocumentVersion[]> {
    documentPath(path);
    const config = await this.languages(repository);
    if (config.languages.some(language => !/^[A-Za-z0-9-]+$/.test(language))) throw new StudioError(400, '内容语言代码无效，请检查站点语言配置。');
    const versions = await Promise.all(config.languages.map(async language => {
      const candidate = translationLocation(path, language, config).path;
      const file = await repository.read(candidate);
      return file && { path: candidate, language, revision: file.revision };
    }));
    return versions.filter((version): version is DocumentVersion => version !== null);
  }
  async removeDocumentVersions(path: string, revisions: unknown) {
    const versions = await this.documentVersions(path);
    const conflict = () => new StudioError(409, '语言版本已变化，请重新打开删除窗口。');
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)
      || !Object.hasOwn(revisions, path) || !versions.some(version => version.path === path)) throw conflict();
    const matches = (current: DocumentVersion[]) => current.length === Object.keys(revisions).length
      && current.every(version => (revisions as Record<string, unknown>)[version.path] === version.revision);
    if (!matches(versions)) throw conflict();
    const paths = new Set(versions.map(version => version.path));
    return this.repository.writeBatch(versions.map(version => ({
      path: version.path, text: null, expectedRevision: version.revision,
    })), async repository => {
      // A new translation invalidates the preview even if all selected revisions still match.
      if (!matches(await this.documentVersions(path, repository))) throw conflict();
      await validateContentRelations(repository, path, null, paths);
    });
  }
  async removeDocument(path: string, revision: string) {
    documentPath(path);
    return this.repository.write(path, null, revision, repository => validateContentRelations(repository, path, null));
  }
}
