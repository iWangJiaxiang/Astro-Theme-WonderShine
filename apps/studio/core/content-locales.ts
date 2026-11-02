import { posix } from './portable.js';
import { parse } from 'smol-toml';
import type { Repository, RepositoryWrite, WriteGuard } from '../shared/repository.js';
import { threadLanguages } from './threads.js';
import { translationLocation } from '../shared/translation.js';
import { removeTomlFields, splitDocument } from './content.js';
import { taxonomyNames } from './thread-taxonomies.js';
import { StudioError } from './errors.js';

// Translated ancestor sections retain the same structural options in the content model.
// These scaffolds intentionally have no body; their inherited titles can be edited later.
export async function localeSectionWrites(repository: Repository, path: string): Promise<{ entries: RepositoryWrite[]; guard: WriteGuard }> {
  const configFile = await repository.read('config.toml');
  const config = configFile ? parse(configFile.text) : {};
  const languages = threadLanguages(config);
  const language = translationLocation(path, languages.defaultLanguage, languages).sourceLanguage;
  const entries: RepositoryWrite[] = [];
  const sources: { path: string; revision: string }[] = [];
  let directory = posix.dirname(path);
  if (/\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path)) directory = posix.dirname(directory);
  while (directory === 'content' || directory.startsWith('content/')) {
    const base = `${directory}/_index.md`;
    const target = translationLocation(base, language, languages).path;
    if (!await repository.read(target)) {
      for (const candidateLanguage of languages.languages) {
        if (candidateLanguage === language) continue;
        const candidate = await repository.read(translationLocation(base, candidateLanguage, languages).path);
        if (!candidate) continue;
        const doc = splitDocument(candidate.text), metadata = parse(doc.header);
        const names = taxonomyNames(config, language);
        const unsupported = Object.keys(metadata.taxonomies || {}).filter(name => !names.has(name)).map(name => `taxonomies.${name}`);
        const header = removeTomlFields(doc.header, ['path', 'aliases', 'extra.ai_translation', 'extra.translation_reviewed', 'extra.translation_source', ...unsupported]);
        entries.push({ path: target, text: `+++\n${header.trim()}\n+++\n`, expectedRevision: null });
        sources.push({ path: candidate.path, revision: candidate.revision });
        break;
      }
    }
    directory = posix.dirname(directory);
  }

  return { entries, guard: async current => {
    if ((await current.read('config.toml'))?.revision !== configFile?.revision) throw new StudioError(409, '站点语言配置已更新，请重新加载后保存');
    for (const source of sources) if ((await current.read(source.path))?.revision !== source.revision) throw new StudioError(409, '上级内容已更新，请重新加载后保存');
  } };
}
