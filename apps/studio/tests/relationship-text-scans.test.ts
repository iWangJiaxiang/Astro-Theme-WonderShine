import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRepository } from '../server/repository.js';
import type { Repository } from '../shared/repository.js';
import type { FileSnapshot } from '../shared/types.js';
import { listRepositoryText } from '../core/repository-text.js';
import { topicChanges } from '../core/topics.js';
import { threadWriteGuard } from '../core/threads.js';
import { validateArticleReferences } from '../core/article-references.js';
import { validateContentRelations } from '../core/content-relations.js';
import { prepareThreadTaxonomies } from '../core/thread-taxonomies.js';

type TextFile = Pick<FileSnapshot, 'path' | 'text'>;
const languages = { defaultLanguage: 'zh', languages: ['zh', 'en'] };
const date = '2026-10-27T01:00:00Z';
const now = new Date('2026-10-28T01:00:00Z');
const document = (header: string) => `+++\n${header}\n+++\nBody`;
const articlePath = 'content/articles/story/index.md';
const topicPath = 'content/topics/research/index.md';
const threadPath = 'content/threads/note/index.md';
const linked = document('title="Linked"\nextra.topics=["research"]');
const referenced = document('title="Reference"\nextra.references=[{kind="internal",path="articles/story/index.md"}]');
const topic = (created = date) => document(`title="Research"\nlayout="topic"\ndate="${created}"\nupdated="${date}"\ndraft=true\nextra.kind="topic"\nextra.id="research"`);
const thread = (id = 'note') => document(`title="Note"\npath="threads/${id.toLowerCase()}"\ndate="${date}"\nextra.kind="thread"\nextra.id="${id}"`);

function fixture(summaryOnly: boolean, initial: TextFile[] = []) {
  let files = initial;
  const counts = { summary: 0, full: 0, revisions: 0 };
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  const repository: Repository = {
    mode: 'local',
    read: async path => {
      assert.equal(path, 'config.toml', 'scans must not read every document for revisions');
      return { path, text: 'default_language="zh"\ntaxonomies=[{name="tags"}]\n[languages.en]\n', revision: 'config' };
    },
    list: async function () {
      assert.equal(this, repository);
      counts.full++;
      return files.map(file => { counts.revisions++; return { ...file, revision: 'legacy' }; });
    },
    listMedia: unexpected, readMedia: unexpected, uploadMedia: unexpected,
    write: unexpected, writeBatch: unexpected,
  };
  if (summaryOnly) repository.listForSummary = async function () {
    assert.equal(this, repository, 'optional method retains its receiver');
    counts.summary++;
    return files.map(file => ({ ...file, get revision(): never { throw new Error('Text scan accessed a revision'); } }));
  };
  return { repository, counts, replace: (next: TextFile[]) => { files = next; } };
}

const scans: { name: string; run(repository: Repository): Promise<unknown> }[] = [
  { name: 'topic creation date', run: repository => topicChanges(repository, topicPath, null, {}, now) },
  { name: 'thread route guard', run: repository => threadWriteGuard(threadPath, thread())(repository) },
  { name: 'article reference creation', run: repository => validateArticleReferences(repository, threadPath, referenced, languages) },
  { name: 'last article translation deletion', run: repository => validateArticleReferences(repository, articlePath, null, languages) },
  { name: 'last topic translation deletion', run: repository => validateContentRelations(repository, topicPath, null) },
  { name: 'topic creation date guard', run: repository => validateContentRelations(repository, topicPath, topic()) },
  { name: 'topic association guard', run: repository => validateContentRelations(repository, threadPath, linked) },
  { name: 'thread taxonomy inheritance', run: repository => prepareThreadTaxonomies(repository, 'content/threads/note/index.en.md', null, { 'taxonomies.tags': ['Research'] }) },
];

for (const summaryOnly of [true, false]) {
  test(`all relationship scans use fresh ${summaryOnly ? 'text-only' : 'legacy fallback'} reads`, async () => {
    const { repository, counts } = fixture(summaryOnly, [
      { path: articlePath, text: document('title="Story"') },
      { path: topicPath, text: topic() },
      { path: threadPath, text: document('taxonomies.tags=["Research"]') },
    ]);
    for (const scan of scans) await scan.run(repository);
    assert.equal(counts.summary, summaryOnly ? scans.length : 0);
    assert.equal(counts.full, summaryOnly ? 0 : scans.length);
    assert.equal(counts.revisions, summaryOnly ? 0 : scans.length * 3);
  });

  test(`topic relationships retain translation, deletion and freshness rules (${summaryOnly})`, async () => {
    const { repository, replace } = fixture(summaryOnly, [{ path: topicPath, text: topic() }]);
    await validateContentRelations(repository, 'content/articles/story/index.en.md', linked);
    replace([]);
    await assert.rejects(validateContentRelations(repository, threadPath, linked), /关联话题.*不存在/);
    replace([{ path: topicPath, text: topic() }, { path: threadPath, text: linked }]);
    await assert.rejects(validateContentRelations(repository, topicPath, null), /仍被内容关联/);
    replace([{ path: 'content/topics/research/index.en.md', text: topic() }, { path: threadPath, text: linked }]);
    await validateContentRelations(repository, topicPath, null);
    await assert.rejects(validateContentRelations(repository, topicPath, topic(now.toISOString())), /创建时间/);
    const changes = await topicChanges(repository, topicPath, null, {}, now);
    assert.equal(changes.date, date);
    assert.equal(changes.updated, now.toISOString());
    replace([{ path: 'content/topics/research/index.en.md', text: topic(now.toISOString()) }]);
    assert.equal((await topicChanges(repository, topicPath, null, {}, now)).date, now.toISOString());
    replace([{ path: topicPath, text: document('invalid TOML') }]);
    await assert.rejects(validateContentRelations(repository, threadPath, linked), /TOML/);
    replace([]);
    await validateContentRelations(repository, topicPath, topic().replace('extra.id="research"', 'extra.id="research"\nextra.topics=["research"]'));
    await assert.rejects(validateContentRelations(repository, threadPath, linked.replace('["research"]', '["research","research"]')), /不重复/);
  });

  test(`article references retain last-translation protection and fresh target parsing (${summaryOnly})`, async () => {
    const { repository, replace } = fixture(summaryOnly, [{ path: 'content/articles/story/index.en.md', text: document('title="Story"\ndraft=true') }]);
    await validateArticleReferences(repository, threadPath, referenced, languages);
    replace([]);
    await assert.rejects(validateArticleReferences(repository, threadPath, referenced, languages), /不存在/);
    replace([{ path: articlePath, text: document('invalid TOML') }]);
    await assert.rejects(validateArticleReferences(repository, threadPath, referenced, languages));
    replace([{ path: threadPath, text: referenced }]);
    await assert.rejects(validateArticleReferences(repository, articlePath, null, languages), /仍被.*引用/);
    replace([{ path: threadPath, text: referenced }, { path: 'content/articles/story/index.en.md', text: document('title="Story"') }]);
    await validateArticleReferences(repository, articlePath, null, languages);
    replace([{ path: threadPath, text: document('title="Unlinked"') }]);
    await validateArticleReferences(repository, articlePath, null, languages);
  });

  test(`reused thread guards recheck canonical route collisions without parsing unrelated threads (${summaryOnly})`, async () => {
    const id = 'ABCDEF12-1234-1234-1234-ABCDEF123456';
    const path = `content/threads/${id}/index.md`;
    const guard = threadWriteGuard(path, thread(id));
    const { repository, replace } = fixture(summaryOnly, [{ path: 'content/threads/broken/index.md', text: document('invalid TOML') }]);
    await guard(repository);
    replace([{ path: `content/threads/${id.toLowerCase()}/index.md`, text: document('invalid TOML') }]);
    await assert.rejects(guard(repository), /公开路径已被/);
    replace([{ path, text: thread(id) }]);
    await guard(repository);
  });

  test(`taxonomy inheritance is based on current sibling text (${summaryOnly})`, async () => {
    const { repository, replace } = fixture(summaryOnly, [{ path: threadPath, text: document('taxonomies.tags=["Research"]') }]);
    const prepare = () => prepareThreadTaxonomies(repository, 'content/threads/note/index.en.md', null, { 'taxonomies.tags': ['Research'] });
    assert.deepEqual((await prepare()).changes, {});
    replace([{ path: threadPath, text: document('taxonomies.tags=["Changed"]') }]);
    await assert.rejects(prepare(), /未配置/);
    replace([{ path: threadPath, text: document('invalid TOML') }]);
    await assert.rejects(prepare(), /TOML/);
  });
}

for (const scan of scans) test(`${scan.name} propagates text-scan failures without a silent full-list fallback`, async () => {
  const { repository, counts } = fixture(true);
  const failure = new Error('Fresh text scan failed');
  repository.listForSummary = async () => { throw failure; };
  await assert.rejects(scan.run(repository), error => error === failure);
  assert.equal(counts.full, 0);
  assert.equal(counts.revisions, 0);
});

test('text helper never caches either capability and propagates fallback failures', async () => {
  for (const summaryOnly of [true, false]) {
    const { repository, replace } = fixture(summaryOnly, [{ path: articlePath, text: 'Before' }]);
    assert.equal((await listRepositoryText(repository))[0].text, 'Before');
    replace([{ path: articlePath, text: 'After' }]);
    assert.equal((await listRepositoryText(repository))[0].text, 'After');
  }
  const { repository } = fixture(false);
  const failure = new Error('Legacy scan failed');
  repository.list = async () => { throw failure; };
  await assert.rejects(listRepositoryText(repository), error => error === failure);
});

test('real writes scan fresh relationship text inside the lock without creating revisions for the library', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-relationship-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.toml'), 'default_language="zh"\n[languages.en]\n');
  for (const file of [
    { path: topicPath, text: topic() },
    ...Array.from({ length: 20 }, (_, index) => ({ path: `content/articles/unrelated-${index}.md`, text: document('title="Unrelated"') })),
  ]) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.text);
  }
  const revisionPaths: string[] = [];
  const repository = new LocalRepository(root, { revision: async (path, text) => {
    revisionPaths.push(path);
    return `fixture:${text}`;
  } });
  const listText = repository.listForSummary.bind(repository);
  let scansInLock = 0;
  repository.listForSummary = async () => {
    await access(join(root, '.studio-write-lock'));
    scansInLock++;
    return listText();
  };
  repository.list = async () => { throw new Error('Guard requested revision-bearing library'); };
  await repository.write(articlePath, linked, null, repo => validateContentRelations(repo, articlePath, linked));
  assert.equal(await readFile(join(root, articlePath), 'utf8'), linked);
  assert.deepEqual(revisionPaths, ['config.toml']);
  assert.equal(scansInLock, 1);
  await rm(join(root, topicPath));
  await assert.rejects(repository.write(threadPath, linked, null, repo => validateContentRelations(repo, threadPath, linked)), /关联话题.*不存在/);
  assert.equal(await repository.read(threadPath), null);
  assert.deepEqual(revisionPaths, ['config.toml', 'config.toml']);
  assert.equal(scansInLock, 2);
});

test('operations with no relationship scan retain their early returns', async () => {
  const { repository, counts } = fixture(true);
  await threadWriteGuard(threadPath, null)(repository);
  await validateArticleReferences(repository, threadPath, null, languages);
  await validateArticleReferences(repository, threadPath, document('title="No references"'), languages);
  await validateContentRelations(repository, threadPath, document('title="No topics"'));
  await topicChanges(repository, topicPath, { path: topicPath, text: topic(), revision: 'current' }, {}, now);
  await prepareThreadTaxonomies(repository, threadPath, { path: threadPath, text: thread(), revision: 'current' }, {});
  assert.equal(counts.summary, 0);
  assert.equal(counts.full, 0);
});
