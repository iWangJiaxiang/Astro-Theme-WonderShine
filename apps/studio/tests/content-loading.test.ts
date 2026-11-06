import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContentService } from '../core/content-service.js';
import { createContentSummaryContext, projectContentSummaries, readContentSummaryFacts } from '../core/content-summary.js';
import { LocalRepository } from '../server/repository.js';
import type { Repository } from '../shared/repository.js';
import type { FileSnapshot } from '../shared/types.js';

const snapshot = (path: string, text = '+++\ntitle="Example"\n+++\nBody') => ({ path, text, revision: 'fixture' });
function repositoryFor(files: FileSnapshot[]): Repository {
  // No filesystem operations: isolate CPU work from asynchronous I/O yielding.
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  return {
    mode: 'local',
    list: async () => files,
    read: async () => snapshot('config.toml', 'default_language="zh-CN"\n[languages.en]\n'),
    listMedia: unexpected, readMedia: unexpected, uploadMedia: unexpected,
    write: unexpected, writeBatch: unexpected,
  };
}
function service(files: FileSnapshot[]) {
  return new ContentService(repositoryFor(files));
}

for (const summaryOnly of [false, true]) test(`large summary lists yield to timer tasks before parsing all documents (${summaryOnly ? 'summary-only' : 'fallback'})`, async () => {
  let parsed = 0;
  const files = Array.from({ length: 257 }, (_, index) => ({
    path: `content/articles/story-${index}/index.md`, revision: 'fixture',
    get text() { parsed++; return '+++\ntitle="Example"\n+++\nBody'; },
  }));
  const repository = repositoryFor(files);
  if (summaryOnly) repository.listForSummary = async () => files;
  const progress: number[] = [];
  const timer = setInterval(() => progress.push(parsed), 0);
  try {
    const result = await new ContentService(repository).list();
    assert.equal(result.length, files.length);
    assert.deepEqual(result.map(item => item.path), files.map(file => file.path));
    assert.ok(progress.some(count => count > 0 && count < files.length), 'input tasks must run during summary parsing, not just after it');
    assert.ok(progress.filter(count => count > 0 && count < files.length).length > 1);
  } finally { clearInterval(timer); }
});

test('indexed language groups preserve duplicates, ordering, isolation and repair entries', async () => {
  const files = [
    snapshot('content/articles/story/index.md'),
    snapshot('content/articles/story/index.en.md'),
    snapshot('content/articles/story/index.en.md'),
    snapshot('content/articles/other/index.md'),
    snapshot('content/articles/broken/index.en.md', '+++\ntitle = [\n+++\n'),
  ];
  const result = await service(files).list();
  assert.deepEqual(result.map(item => item.path), files.map(file => file.path));
  for (const item of result) {
    const expected = item.translationKey ? result.filter(other => other.translationKey === item.translationKey && other.lang).map(other => other.lang!).sort() : [];
    assert.deepEqual(item.availableLanguages, expected);
  }
  assert.deepEqual(result[0].availableLanguages, ['en', 'en', 'zh-CN']);
  result[0].availableLanguages!.push('mutated');
  assert.deepEqual(result[1].availableLanguages, ['en', 'en', 'zh-CN']);
  assert.equal(result[4].error, 'TOML 格式需要检查');
  assert.equal(result[4].lang, 'en');
  assert.deepEqual(result[4].availableLanguages, []);
});

test('summary-only reads preserve full list results without accessing revisions or legacy list', async () => {
  const files = [
    snapshot('content/articles/story/index.md', '+++\ntitle="Story"\nslug="Custom Slug"\ndate=2099-01-01T12:00:00Z\ndraft=true\nrender=false\n[extra]\ncustom="' + 'large metadata '.repeat(1000) + '"\n+++\nBody'),
    snapshot('content/articles/story/index.en.md'),
    snapshot('content/pages/about.md', '+++\ntitle="About"\npath="/custom-about/"\n+++\nBody'),
    snapshot('content/collections/book/_index.md'),
    snapshot('content/threads/n_one/index.md', '+++\ndate=2026-01-01T12:00:00Z\n[extra]\nid="n_one"\ntopics=["t_one"]\nreferences=[{kind="external",url="https://example.com",title="Example"}]\n+++\n# Body-derived *title*'),
    snapshot('content/topics/t_one/index.en.md'),
    snapshot('content/articles/broken/index.en.md', '+++\ntitle = [\n+++\n'),
  ];
  const expected = await service(files).list();
  const repository = repositoryFor(files);
  let summaryReads = 0;
  repository.list = async () => { throw new Error('Revision-bearing list must not be used'); };
  repository.listForSummary = async function () {
    assert.equal(this, repository, 'optional methods retain their repository receiver');
    summaryReads++;
    return files.map(({ path, text }) => ({ path, text, get revision(): never { throw new Error('Summary read accessed revision'); } }));
  };
  const result = await new ContentService(repository).list();
  assert.equal(summaryReads, 1);
  assert.deepEqual(result, expected);
  assert.deepEqual(result, projectContentSummaries(files.map(readContentSummaryFacts), createContentSummaryContext({ default_language: 'zh-CN', languages: { en: {} } })));
  assert.equal(result[0].publicPath, '/articles/custom-slug/');
  assert.equal(result[2].publicPath, '/custom-about/');
  assert.equal(result[4].title, 'Body-derived title');
  assert.equal(result[4].id, 'n_one');
  assert.equal(result[6].error, 'TOML 格式需要检查');
  assert.ok(result.every(item => !('revision' in item) && !('text' in item)));
});

test('summary-only reads refresh content and config on every list call', async () => {
  const repository = repositoryFor([]);
  let text = '+++\ntitle="Before"\n+++\nBody';
  let config = 'default_language="zh-CN"\n[slugify]\npaths="on"\n';
  let summaryReads = 0, configReads = 0;
  repository.listForSummary = async () => { summaryReads++; return [{ path: 'content/articles/MixedCase.md', text }]; };
  repository.read = async path => { assert.equal(path, 'config.toml'); configReads++; return snapshot(path, config); };
  const content = new ContentService(repository);
  const [before] = await content.list();
  text = text.replace('Before', 'After');
  config = config.replace('"on"', '"off"');
  const [after] = await content.list();
  assert.equal(before.title, 'Before');
  assert.equal(before.publicPath, '/articles/mixedcase/');
  assert.equal(after.title, 'After');
  assert.equal(after.publicPath, '/articles/MixedCase/');
  assert.equal(summaryReads, 2);
  assert.equal(configReads, 2);
});

test('summary-only failures propagate without retrying an expensive full list', async () => {
  const repository = repositoryFor([]);
  const failure = new Error('Summary read failed');
  let fullLists = 0;
  repository.list = async () => { fullLists++; return []; };
  repository.listForSummary = async () => { throw failure; };
  await assert.rejects(new ContentService(repository).list(), error => error === failure);
  assert.equal(fullLists, 0);
});

test('summary reads do not replace real document revisions or weaken save conflicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-summary-revisions-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const path = 'content/pages/about.md';
  const original = '+++\ntitle="Before"\n+++\nOriginal body';
  await mkdir(join(root, 'content/pages'), { recursive: true });
  await writeFile(join(root, path), original);
  const repository: Repository = new LocalRepository(root);
  let summaryReads = 0;
  repository.listForSummary = async () => {
    summaryReads++;
    return [{ path, text: await readFile(join(root, path), 'utf8') }];
  };
  const content = new ContentService(repository);
  assert.equal((await content.list())[0].title, 'Before');
  const document = await content.document(path);
  assert.equal(document.revision, (await repository.read(path))!.revision);
  assert.ok(document.revision);
  assert.equal((await repository.read(path))!.text, original);
  assert.equal(document.body, 'Original body');
  const saved = await content.saveDocument(path, { title: 'Saved' }, 'Saved body', document.revision);
  const savedText = await readFile(join(root, path), 'utf8');
  assert.equal(saved.revision, (await repository.read(path))!.revision);
  assert.notEqual(saved.revision, document.revision);
  const externalText = savedText.replace('Saved body', 'External body');
  await writeFile(join(root, path), externalText);
  await content.list();
  const external = await content.document(path);
  assert.equal(external.revision, (await repository.read(path))!.revision);
  assert.notEqual(external.revision, saved.revision);
  assert.equal(external.body, 'External body');
  await assert.rejects(content.saveDocument(path, { title: 'Stale' }, 'Stale body', saved.revision), { status: 409 });
  assert.equal(await readFile(join(root, path), 'utf8'), externalText);
  assert.equal(summaryReads, 2, 'document and save operations must not use summary-only reads');
});

test('summary parsing preserves TOML multiline delimiters, dates and visibility metadata', async () => {
  const [item] = await service([snapshot('content/articles/story/index.md', '\uFEFF+++\r\ntitle="Example"\r\ndescription="""\r\n+++\r\ninside\r\n"""\r\ndate=2099-01-01T12:00:00Z\r\ndraft=true\r\nrender=false\r\n+++\r\nBody')]).list();
  assert.equal(item.error, undefined);
  assert.equal(item.title, 'Example');
  assert.ok(item.description?.includes('+++'));
  assert.equal(item.date, '2099-01-01T12:00:00.000Z');
  assert.equal(item.draft, true);
  assert.equal(item.render, false);
});
