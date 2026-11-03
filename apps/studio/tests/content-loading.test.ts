import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentService } from '../core/content-service.js';
import { FileRepository } from '../platform/file-repository.js';
import type { WorkspaceFiles } from '../platform/filesystem.js';
import type { FileSnapshot } from '../shared/types.js';

const snapshot = (path: string, text = '+++\ntitle="Example"\n+++\nBody') => ({ path, text, revision: 'fixture' });
function service(files: FileSnapshot[]) {
  // No filesystem operations: isolate CPU work from asynchronous I/O yielding.
  const repository = new FileRepository({} as WorkspaceFiles, '/unused', '/unused-state');
  repository.list = async () => files;
  repository.read = async () => snapshot('config.toml', 'default_language="zh-CN"\n[languages.en]\n');
  return new ContentService(repository);
}

test('large summary lists yield to timer tasks before parsing all documents', async () => {
  let parsed = 0;
  const files = Array.from({ length: 257 }, (_, index) => ({
    path: `content/articles/story-${index}/index.md`, revision: 'fixture',
    get text() { parsed++; return '+++\ntitle="Example"\n+++\nBody'; },
  }));
  const progress: number[] = [];
  const timer = setInterval(() => progress.push(parsed), 0);
  try {
    const result = await service(files).list();
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

test('summary parsing preserves TOML multiline delimiters, dates and visibility metadata', async () => {
  const [item] = await service([snapshot('content/articles/story/index.md', '\uFEFF+++\r\ntitle="Example"\r\ndescription="""\r\n+++\r\ninside\r\n"""\r\ndate=2099-01-01T12:00:00Z\r\ndraft=true\r\nrender=false\r\n+++\r\nBody')]).list();
  assert.equal(item.error, undefined);
  assert.equal(item.title, 'Example');
  assert.ok(item.description?.includes('+++'));
  assert.equal(item.date, '2099-01-01T12:00:00.000Z');
  assert.equal(item.draft, true);
  assert.equal(item.render, false);
});
