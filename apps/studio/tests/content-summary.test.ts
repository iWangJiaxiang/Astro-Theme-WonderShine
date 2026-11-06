import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import type { ArticleReference, ArticleSummary, Json } from '../shared/types.js';
import { getValue, splitDocument } from '../core/content.js';
import { threadLanguages, threadPath } from '../core/threads.js';
import { topicPath } from '../core/topics.js';
import { stringValues } from '../shared/choices.js';
import { contentLink } from '../shared/content-links.js';
import { translationLocation } from '../shared/translation.js';
import { contentSummarySteps, createContentSummaryContext, projectContentSummaries, readContentSummaryFacts, updateContentSummaryFacts } from '../core/content-summary.js';

const file = (path: string, header = 'title="Example"', body = 'Body') => ({ path, text: `+++\n${header}\n+++\n${body}` });
const config: Record<string, Json> = { default_language: 'zh-CN', languages: { en: {} } };

// Frozen pre-extraction projection oracle, deliberately independent of the facts implementation.
function legacy(files: { path: string; text: string }[], config: Record<string, Json>): ArticleSummary[] {
  const languages = threadLanguages(config);
  const summaries: ArticleSummary[] = files.map(file => {
    const kind = file.path.startsWith('content/articles/') ? 'article' : file.path.startsWith('content/pages/') ? 'page' : file.path.startsWith('content/threads/') ? 'thread' : file.path.startsWith('content/topics/') ? 'topic' : 'collection';
    try {
      const document = splitDocument(file.text);
      const metadata = parse(document.header);
      const localized = (kind === 'thread' || kind === 'topic') && !/\/_index(?:\.[^.]+)?\.md$/.test(file.path) ? (kind === 'topic' ? topicPath : threadPath)(file.path, languages) : undefined;
      const locale = translationLocation(file.path, languages.defaultLanguage, languages);
      return { path: file.path, title: String(metadata.title || (kind === 'thread' && localized ? document.body.replace(/[#*`>\[\]]/g, '').trim().slice(0, 80) : '') || file.path.split('/').slice(-2).join('/')), date: metadata.date instanceof Date ? metadata.date.toISOString() : typeof metadata.date === 'string' ? metadata.date : '',
        lang: locale.sourceLanguage, translationKey: locale.translationKey,
        ...(localized ? { id: String(getValue(metadata, 'extra.id') || '') } : {}),
        references: (getValue(metadata, 'extra.references') || []) as ArticleReference[],
        updated: metadata.updated instanceof Date ? metadata.updated.toISOString() : typeof metadata.updated === 'string' ? metadata.updated : '', topics: stringValues(getValue(metadata, 'extra.topics')),
        draft: metadata.draft === true, kind, tags: stringValues(getValue(metadata, 'taxonomies.tags')), categories: stringValues(getValue(metadata, 'taxonomies.categories')),
        displayTags: stringValues(getValue(metadata, 'extra.tags')), layout: typeof metadata.layout === 'string' ? metadata.layout : undefined,
        ...contentLink(file.path, JSON.parse(JSON.stringify({ path: metadata.path, slug: metadata.slug })), config),
        description: typeof metadata.description === 'string' ? metadata.description : '', render: metadata.render !== false,
        weight: typeof metadata.weight === 'number' ? metadata.weight : 0 };
    } catch {
      let lang: string | undefined;
      try { lang = kind === 'thread' || kind === 'topic' ? (kind === 'topic' ? topicPath : threadPath)(file.path, languages).lang : translationLocation(file.path, languages.defaultLanguage, languages).sourceLanguage; } catch { /* Repair entry. */ }
      return { path: file.path, title: file.path, date: '', draft: false, kind, tags: [], categories: [], lang, error: 'TOML 格式需要检查' };
    }
  });
  for (const item of summaries) item.availableLanguages = item.translationKey ? summaries.filter(other => other.translationKey === item.translationKey && other.lang).map(other => other.lang!).sort() : [];
  return summaries;
}

const fixtures = [
  file('content/articles/2026-01-02-MixedCase/index.md', 'title="Story"\ndate=2026-01-02T13:14:15+08:00\nupdated="tomorrow"\ndraft=true\nrender=false\nweight=4\nlayout="post"\ndescription="Description"\n[taxonomies]\ntags=["one",4,""]\ncategories=["category"]\n[extra]\ntags=["display"]\ntopics=["t_one"]'),
  file('content/articles/2026-01-02-MixedCase/index.en.md'),
  file('content/articles/2026-01-02-MixedCase/index.en.md'),
  file('content/pages/about.md', 'title=[]\npath="/custom/"'),
  file('content/articles/中文.md'),
  file('content/articles/slug.md', 'title=42\nslug="Custom Slug"'),
  file('content/articles/date-path.md', 'path=2026-01-02\nslug=2026-01-02'),
  file('content/articles/malformed-fields.md', 'title=false\npath=42\nslug=[]\ndate=42\nupdated=false'),
  file('content/collections/book/_index.en.md'),
  file('content/threads/n_one/index.md', 'date=2026-01-01\n[extra]\nid="n_one"\nreferences=[{kind="external",url="https://example.com",title="Example"}]', '# Body-derived *title*\n' + 'tail '.repeat(100)),
  file('content/threads/n_one/index.en.md', '', ' '),
  file('content/threads/_index.md', '', 'Not a title'),
  file('content/threads/n_one/index.zh-CN.md'),
  file('content/threads/n_one/index.fr.md'),
  file('content/topics/t_one/index.en.md'),
  file('content/topics/_index.en.md'),
  file('content/_index.md'),
  file('content/threads/invalid.md'),
  file('unknown.md'),
  file('content/articles/broken/index.en.md', 'title = ['),
  { path: 'content/articles/no-header.md', text: 'plain body' },
  { path: 'content/articles/multiline.md', text: '\uFEFF+++ \r\ntitle="""\r\n+++\r\ninside\r\n"""\r\n+++\r\nBody' },
  { path: 'content/articles/literal.md', text: "+++\ntitle='''\n+++\ninside\n'''\n+++" },
  file('content/articles/empty.md', ''),
];

test('facts projection preserves legacy content, links, errors and locales when references have valid shapes', () => {
  const facts = fixtures.map(readContentSummaryFacts);
  const configurations: Record<string, Json>[] = [config, {}, { ...config, slugify: { paths: 'off', paths_keep_dates: true } }, { ...config, slugify: { paths: 'safe' } }, { default_language: 'en', languages: { fr: {}, 'zh-CN': {} } }];
  for (const configuration of configurations) {
    // TOML tables have null prototypes; compare reference field values as exposed
    // by the JSON API while keeping strict checks (including undefined) elsewhere.
    const expected = legacy(fixtures, configuration).map(row => row.references
      ? { ...row, references: row.references.map(reference => ({ ...reference })) }
      : row);
    assert.deepEqual(projectContentSummaries(facts, createContentSummaryContext(configuration)), expected);
  }
});

test('facts keep selected summary data and an 80-character thread excerpt, never source or custom metadata', () => {
  const large = 'private custom '.repeat(10000);
  const source = { ...file('content/threads/n_one/index.md', `[extra]\ncustom="${large}"`, '# ' + 'a'.repeat(100) + 'BODY_SECRET'), get revision(): never { throw new Error('Revision accessed'); } };
  const facts = readContentSummaryFacts(source);
  assert.equal(facts.fields?.threadTitle, 'a'.repeat(80));
  assert.deepEqual(Object.keys(facts).sort(), ['fields', 'kind', 'path']);
  assert.ok(!JSON.stringify(facts).includes('private custom'));
  assert.ok(!JSON.stringify(facts).includes('BODY_SECRET'));
  const article = readContentSummaryFacts(file('content/articles/one.md', '', 'BODY_SECRET'));
  assert.equal(article.fields?.threadTitle, '');
});

test('reference facts deliberately normalize malformed or private metadata instead of preserving the legacy cast', () => {
  const headers = [
    '[extra]\nreferences="legacy malformed value"',
    '[extra.references]\nprivate={token="PRIVATE_SECRET",nested={body="PRIVATE_BODY"}}',
    '[extra]\nreferences=[{kind="internal",path="articles/story/index.md",private={token="PRIVATE_SECRET"}}]',
    '[extra]\nreferences=[{kind="external",url="https://example.com",title="Example",private={nested={token="PRIVATE_SECRET"}}}]',
    '[extra]\nreferences=[{kind="internal",path={private="PRIVATE_SECRET"}}]',
    '[extra]\nreferences=[{kind="external",url="https://example.com",title={private="PRIVATE_SECRET"}}]',
    '[extra]\nreferences=[{kind="unknown",private="PRIVATE_SECRET"}]',
    '[extra]\nreferences=[{kind="external",url="https://example.com"}]',
    '[extra]\nreferences=[{kind="internal",path="articles/story/index.md"},42]',
    '[extra]\nreferences=2026-01-02',
    '[extra]\nreferences=[2026-01-02]',
    '[extra]\nreferences=[{kind="internal",path=2026-01-02}]',
    '[extra]\nreferences=[{kind="external",url="https://example.com",title=2026-01-02T01:02:03+08:00}]',
    '[extra]\nreferences=[{kind="external",url=2026-01-02,title="Example"}]',
    '[extra]\nreferences=[' + Array.from({ length: 13 }, () => '{kind="internal",path="articles/story/index.md"}').join(',') + ']',
  ];
  for (const header of headers) {
    const source = file('content/articles/story/index.md', header);
    const fact = readContentSummaryFacts(source);
    assert.ok(fact.fields, 'valid TOML remains a visible summary despite malformed references');
    assert.deepEqual(fact.fields.references, []);
    const [summary] = projectContentSummaries([fact], createContentSummaryContext(config));
    assert.equal(summary.error, undefined);
    assert.deepEqual(summary.references, []);
    assert.ok(!JSON.stringify(fact).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(summary).includes('PRIVATE_'));
    assert.notDeepEqual(summary.references, legacy([source], config)[0].references, 'normalization intentionally differs from the old unchecked cast');
  }
});

test('reference whitelist retains only typed fields and returns independent scalar-only objects', () => {
  const expected: ArticleReference[] = [
    { kind: 'internal', path: 'articles/story/index.md' },
    { kind: 'external', url: 'https://example.com', title: 'Example' },
  ];
  const fact = readContentSummaryFacts(file('content/articles/story/index.md', '[extra]\nreferences=[{kind="internal",path="articles/story/index.md"},{kind="external",url="https://example.com",title="Example"}]'));
  assert.deepEqual(fact.fields?.references, expected);
  const context = createContentSummaryContext(config);
  const [summary] = projectContentSummaries([fact], context);
  assert.deepEqual(summary.references, expected);
  assert.notEqual(summary.references![0], fact.fields!.references[0]);
  if (summary.references![0].kind === 'internal') summary.references![0].path = 'mutated';
  assert.deepEqual(projectContentSummaries([fact], context)[0].references, expected);
});

test('single-path updates repair and delete translation siblings without reading unchanged documents', () => {
  let reads = 0;
  const sources = ['content/articles/one/index.md', 'content/articles/one/index.en.md', 'content/articles/two.md'].map(path => ({ path, get text() { reads++; return '+++\ntitle="Before"\n+++\nBody'; } }));
  const facts = sources.map(readContentSummaryFacts);
  const context = createContentSummaryContext(config);
  const original = projectContentSummaries(facts, context);
  const broken = readContentSummaryFacts(file(sources[1].path, 'title=['));
  const changed = updateContentSummaryFacts(facts, new Map([[broken.path, broken]]));
  assert.equal(changed[0], facts[0]);
  assert.equal(changed[2], facts[2]);
  assert.deepEqual(projectContentSummaries(changed, context)[0].availableLanguages, ['zh-CN']);
  assert.equal(projectContentSummaries(changed, context)[1].error, 'TOML 格式需要检查');
  const repaired = readContentSummaryFacts(file(broken.path, 'title="After"'));
  const restored = updateContentSummaryFacts(changed, new Map([[repaired.path, repaired]]));
  assert.deepEqual(projectContentSummaries(restored, context)[0].availableLanguages, ['en', 'zh-CN']);
  assert.equal(projectContentSummaries(restored, context)[1].title, 'After');
  const removed = updateContentSummaryFacts(restored, new Map([[repaired.path, null]]));
  assert.deepEqual(projectContentSummaries(removed, context).map(item => item.path), [sources[0].path, sources[2].path]);
  assert.deepEqual(projectContentSummaries(removed, context)[0].availableLanguages, ['zh-CN']);
  assert.equal(reads, sources.length);
  assert.deepEqual(projectContentSummaries(facts, context), original, 'updates do not mutate old snapshots');
});

test('config reprojection regroups suffixes, recovers path errors and changes links without reparsing', () => {
  let reads = 0;
  const sources = [file('content/articles/MixedCase.md'), file('content/articles/MixedCase.fr.md'), file('content/threads/n_one/index.fr.md', '', 'Body title')];
  const facts = sources.map(source => readContentSummaryFacts({ path: source.path, get text() { reads++; return source.text; } }));
  const before = projectContentSummaries(facts, createContentSummaryContext(config));
  assert.deepEqual(before[0].availableLanguages, ['zh-CN']);
  assert.equal(before[2].error, 'TOML 格式需要检查');
  const configuration = { default_language: 'zh-CN', languages: { fr: {} }, slugify: { paths: 'off' } };
  const after = projectContentSummaries(facts, createContentSummaryContext(configuration));
  assert.deepEqual(after, legacy(sources, configuration));
  assert.deepEqual(after[0].availableLanguages, ['fr', 'zh-CN']);
  assert.equal(after[0].publicPath, '/articles/MixedCase/');
  assert.equal(after[2].title, 'Body title');
  assert.equal(after[2].error, undefined);
  assert.equal(reads, sources.length);
});

test('cooperative projection keeps duplicate language entries and independent arrays', () => {
  const source = file('content/articles/story/index.en.md', '[extra]\nreferences=[{kind="internal",path="content/pages/about.md"}]');
  const fact = readContentSummaryFacts(source);
  const facts = [fact, fact];
  const steps = contentSummarySteps(facts, createContentSummaryContext(config));
  let count = 0, step = steps.next();
  while (!step.done) { count++; step = steps.next(); }
  assert.equal(count, 5, 'two documents, one group, two rows');
  assert.deepEqual(step.value[0].availableLanguages, ['en', 'en']);
  step.value[0].availableLanguages!.push('mutated');
  step.value[0].references!.push({ kind: 'internal', path: 'mutated' });
  assert.deepEqual(step.value[1].availableLanguages, ['en', 'en']);
  assert.equal(projectContentSummaries(facts, createContentSummaryContext(config))[0].references!.length, 1);
  const added = readContentSummaryFacts(file('content/pages/new.md'));
  // Appending is only this helper's contract, not parity with repository enumeration.
  // Runtime indexes must refetch unseen paths unless repository ordering is supplied.
  assert.deepEqual(updateContentSummaryFacts(facts, new Map([[added.path, added], [fact.path, fact]])).map(item => item.path), [fact.path, fact.path, added.path]);
  assert.throws(() => updateContentSummaryFacts(facts, new Map([['wrong', added]])), /path mismatch/);
});
