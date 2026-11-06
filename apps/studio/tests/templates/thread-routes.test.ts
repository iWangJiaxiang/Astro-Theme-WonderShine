import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAstro } from '../astro-build.js';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { threadRouteId } from '../../shared/thread-routes.js';
import { LocalRepository } from '../../server/repository.js';
import { ContentService } from '../../server/content-service.js';

const legacy = 'n_8d7af1f2de9740fc8909b42954e689a9';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-astro-thread-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  await writeFile(join(root, 'config.toml'), 'base_url="https://example.test"\ndefault_language="zh"\n[languages.en]\n[extra.activity]\nenable=true\n');
  const repo = new LocalRepository(root);
  return { root, repo, content: new ContentService(repo) };
}
const thread = (id: string) => ({ 'extra.kind': 'thread', 'extra.id': id, draft: false, date: '2020-01-01T00:00:00Z' });
async function imported(repo: LocalRepository, id = legacy, language = '') {
  const path = `content/threads/${id}/index${language ? '.' + language : ''}.md`;
  await repo.write(path, `+++\ndate=2020-01-01T00:00:00Z\ndraft=false\n[extra]\nkind="thread"\nid="${id}"\ncustom="keep"\n+++\nOriginal body`, null);
  return path;
}

test('Astro emits plural thread pages without legacy redirects while excluding drafts', async t => {
  const { root, repo, content } = await fixture(t);
  await repo.write('content/threads/_index.md', '+++\ntitle="Threads"\nchild_layout="thread"\n+++\n', null);
  for (const language of ['', 'en']) {
    const path = await imported(repo, legacy, language), source = await content.document(path);
    await content.saveDocument(path, {}, source.body + '\n![Photo](photo.png)', source.revision);
  }
  await writeFile(join(root, 'content/threads', legacy, 'photo.png'), 'fixture-image');
  const draftUuid = '994a4cfb-a217-422c-9073-f5bb908bbdab';
  const draftPath = `content/threads/${draftUuid}/index.md`;
  await content.saveDocument(draftPath, { ...thread(draftUuid), draft: true }, 'Private draft', null);
  const oldDraft = 'n_a45bbbd7ba99455189e10859849278f4';
  const oldDraftPath = await imported(repo, oldDraft), oldDraftSource = await content.document(oldDraftPath);
  await content.saveDocument(oldDraftPath, { draft: true }, oldDraftSource.body, oldDraftSource.revision);
  const futureUuid = '994a4cfb-a217-422c-9073-f5bb908bbdac';
  await content.saveDocument(`content/threads/${futureUuid}/index.md`, { ...thread(futureUuid), date: '2999-01-01T00:00:00Z' }, 'Future private text', null);
  assert.equal((await content.document(`content/threads/${futureUuid}/index.md`)).metadata.date, '2999-01-01T00:00:00Z');
  buildAstro(root);
  for (const language of ['', 'en/']) {
    const page = await readFile(join(root, 'dist', language, 'threads', legacy, 'index.html'), 'utf8');
    assert.match(page, /Original body/);
    assert.ok(page.includes(`https://example.test/${language}threads/${legacy}/`));
    for (const oldDirectory of ['notes', 'thread']) await assert.rejects(readFile(join(root, 'dist', language, oldDirectory, legacy, 'index.html')));
    assert.equal(await readFile(join(root, 'dist', language, 'threads', legacy, 'photo.png'), 'utf8'), 'fixture-image');
  }
  await assert.rejects(readFile(join(root, 'dist/threads', draftUuid, 'index.html')));
  await assert.rejects(readFile(join(root, 'dist/threads', threadRouteId(oldDraft), 'index.html')));
  await assert.rejects(readFile(join(root, 'dist/threads', oldDraft, 'index.html')));
  await assert.rejects(readFile(join(root, 'dist/threads', futureUuid, 'index.html')));
});
