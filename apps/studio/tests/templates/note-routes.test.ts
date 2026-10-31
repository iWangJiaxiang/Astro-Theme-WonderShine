import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAstro } from '../astro-build.js';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { noteRouteId } from '../../shared/note-routes.js';
import { LocalRepository } from '../../server/repository.js';
import { ContentService } from '../../server/content-service.js';

const uuid = '8d7af1f2-de97-40fc-8909-b42954e689a9';
const legacy = 'n_8d7af1f2de9740fc8909b42954e689a9';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-astro-thread-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.toml'), 'base_url="https://example.test"\ndefault_language="zh"\n[languages.en]\n[extra.activity]\nenable=true\n');
  const repo = new LocalRepository(root);
  return { root, repo, content: new ContentService(repo) };
}
const note = (id: string) => ({ 'extra.kind': 'note', 'extra.id': id, draft: false, date: '2020-01-01T00:00:00Z' });
async function imported(repo: LocalRepository, id = legacy, language = '') {
  const path = `content/notes/${id}/index${language ? '.' + language : ''}.md`;
  await repo.write(path, `+++\ndate=2020-01-01T00:00:00Z\ndraft=false\n[extra]\nkind="note"\nid="${id}"\ncustom="keep"\n+++\nOriginal body`, null);
  return path;
}

test('Astro emits canonical thread pages and language-correct legacy redirects while excluding drafts', async t => {
  const { root, repo, content } = await fixture(t);
  await repo.write('content/notes/_index.md', '+++\ntitle="Notes"\nchild_layout="note"\n+++\n', null);
  for (const language of ['', 'en']) {
    const path = await imported(repo, legacy, language), source = await content.document(path);
    await content.saveDocument(path, {}, source.body + '\n![Photo](photo.png)', source.revision);
  }
  await writeFile(join(root, 'content/notes', legacy, 'photo.png'), 'fixture-image');
  const draftUuid = '994a4cfb-a217-422c-9073-f5bb908bbdab';
  const draftPath = `content/notes/${draftUuid}/index.md`;
  await content.saveDocument(draftPath, { ...note(draftUuid), draft: true }, 'Private draft', null);
  const oldDraft = 'n_a45bbbd7ba99455189e10859849278f4';
  const oldDraftPath = await imported(repo, oldDraft), oldDraftSource = await content.document(oldDraftPath);
  await content.saveDocument(oldDraftPath, { draft: true }, oldDraftSource.body, oldDraftSource.revision);
  const futureUuid = '994a4cfb-a217-422c-9073-f5bb908bbdac';
  await content.saveDocument(`content/notes/${futureUuid}/index.md`, { ...note(futureUuid), date: '2999-01-01T00:00:00Z' }, 'Future private text', null);
  assert.equal((await content.document(`content/notes/${futureUuid}/index.md`)).metadata.date, '2999-01-01T00:00:00Z');
  buildAstro(root);
  for (const language of ['', 'en/']) {
    const page = await readFile(join(root, 'dist', language, 'thread', uuid, 'index.html'), 'utf8');
    assert.match(page, /Original body/);
    const redirect = await readFile(join(root, 'dist', language, 'notes', legacy, 'index.html'), 'utf8');
    assert.ok(redirect.includes(`https://example.test/${language}thread/${uuid}/`));
    assert.equal(await readFile(join(root, 'dist', language, 'thread', uuid, 'photo.png'), 'utf8'), 'fixture-image');
  }
  await assert.rejects(readFile(join(root, 'dist/thread', draftUuid, 'index.html')));
  await assert.rejects(readFile(join(root, 'dist/thread', noteRouteId(oldDraft), 'index.html')));
  await assert.rejects(readFile(join(root, 'dist/notes', oldDraft, 'index.html')));
  await assert.rejects(readFile(join(root, 'dist/thread', futureUuid, 'index.html')));
});
