import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { RevisionRegistry } from '../apps/studio/core/revision.js';
import { createSummaryIndexBuilder } from '../apps/studio/core/summary-index.js';
import { createSummaryRuntime } from '../apps/studio/core/summary-runtime.js';
import type { Repository } from '../apps/studio/shared/repository.js';

// Remote CI measurements use bounded synthetic data only, never a site checkout.
// Counts are structural budgets; elapsed times are observations, not speed claims.
const documentCount = 1000;
const scope = 'responsiveness-budget-fixture';
const articlePath = (index: number) => `content/articles/fixture-${index}/index.md`;
const articleText = (title = 'Synthetic article') => `+++\ntitle=${JSON.stringify(title)}\ndate=2026-11-01\n+++\n${'Synthetic body. '.repeat(16)}`;
const initialConfig = 'default_language="en"\n';
const countKeys = ['summaryScans', 'revisionLists', 'documentReads', 'configReads', 'summaryDocuments', 'summaryTextAccesses', 'writes'] as const;
type Counts = Record<typeof countKeys[number], number>;
const emptyCounts = (): Counts => ({ summaryScans: 0, revisionLists: 0, documentReads: 0, configReads: 0, summaryDocuments: 0, summaryTextAccesses: 0, writes: 0 });

function memoryRepository(onSummaryText?: (accesses: number) => void) {
  const files = new Map(Array.from({ length: documentCount }, (_, index) => [articlePath(index), articleText()]));
  files.set('config.toml', initialConfig);
  const revisions = new RevisionRegistry();
  const counts = emptyCounts();
  const repository: Repository = {
    mode: 'local',
    async read(path) {
      if (path === 'config.toml') counts.configReads++;
      else counts.documentReads++;
      const text = files.get(path);
      return text === undefined ? null : { path, text, revision: revisions.revision(scope, path, text) };
    },
    async list() {
      counts.revisionLists++;
      throw new Error('Summary measurements must not request revision-bearing enumeration');
    },
    async listForSummary() {
      counts.summaryScans++;
      return [...files].filter(([path]) => path.startsWith('content/')).map(([path, text]) => {
        counts.summaryDocuments++;
        return {
          path,
          // Observe real builder text consumption, not an estimated parser count.
          // This getter neither parses text nor performs asynchronous work.
          get text() {
            counts.summaryTextAccesses++;
            onSummaryText?.(counts.summaryTextAccesses);
            return text;
          },
        };
      });
    },
    async write(path, text, expectedRevision, guard) {
      return repository.writeBatch([{ path, text, expectedRevision }], guard);
    },
    async writeBatch(changes, guard) {
      await guard?.(repository);
      // Per-path baselines keep fixture saves independent of the summary cache.
      for (const change of changes) {
        const current = files.get(change.path);
        const revision = current === undefined ? null : revisions.revision(scope, change.path, current);
        assert.equal(change.expectedRevision, revision, 'fixture write requires the current per-path revision');
      }
      let revision = '';
      for (const change of changes) {
        counts.writes++;
        if (change.text === null) files.delete(change.path);
        else {
          files.set(change.path, change.text);
          revision = revisions.revision(scope, change.path, change.text);
        }
      }
      return { revision, message: 'Saved synthetic fixture' };
    },
    async listMedia() { throw new Error('Unexpected media operation'); },
    async readMedia() { throw new Error('Unexpected media operation'); },
    async uploadMedia() { throw new Error('Unexpected media operation'); },
  };
  return { repository, files, counts: () => ({ ...counts }) };
}

async function measure<T>(t: TestContext, stage: string, counts: () => Counts, operation: () => Promise<T>) {
  const before = counts(), started = performance.now();
  const value = await operation();
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const after = counts(), delta = emptyCounts();
  for (const key of countKeys) delta[key] = after[key] - before[key];
  // Only fixed labels, counts and timings enter CI diagnostics: no paths or text.
  t.diagnostic(JSON.stringify({ scenario: 'synthetic-summary-costs', documents: documentCount, stage, elapsedMs, ...delta }));
  return { value, delta };
}

function budget(actual: Counts, expected: Partial<Counts>) {
  assert.deepEqual(actual, { ...emptyCounts(), ...expected });
}

// The timeout is only a broad deadlock watchdog, not a latency acceptance target.
test('1000-document runtime: measured fresh, warm, delta, config and unknown-sync costs', { timeout: 120_000 }, async t => {
  const memory = memoryRepository();
  const runtime = createSummaryRuntime(memory.repository, { scope });
  t.after(() => runtime.dispose());
  const run = <T>(stage: string, operation: () => Promise<T>) => measure(t, stage, memory.counts, operation);
  const fullScan = { summaryScans: 1, configReads: 1, summaryDocuments: documentCount, summaryTextAccesses: documentCount };

  const fresh = await run('initial-full-scan', () => runtime.list());
  budget(fresh.delta, fullScan);
  assert.equal(fresh.value.length, documentCount);
  assert.ok(fresh.value.every(row => row.title === 'Synthetic article' && row.lang === 'en' && !row.error));

  const warm = await run('five-warm-lists', async () => {
    for (let index = 0; index < 5; index++) assert.deepEqual(await runtime.list(), fresh.value);
  });
  budget(warm.delta, {});

  const edit = await run('one-existing-document-edit-and-list', async () => {
    const current = await runtime.repository.read(articlePath(0));
    assert.ok(current);
    await runtime.repository.write(current.path, articleText('Synthetic edited article'), current.revision);
    return runtime.list();
  });
  budget(edit.delta, { documentReads: 1, writes: 1 });
  assert.equal(edit.value.length, documentCount);
  assert.equal(edit.value[0].title, 'Synthetic edited article');
  assert.deepEqual(edit.value.slice(1), fresh.value.slice(1));

  const config = await run('config-reprojection-and-list', async () => {
    const current = await runtime.repository.read('config.toml');
    assert.ok(current);
    await runtime.repository.write(current.path, 'default_language="fr"\n', current.revision);
    return runtime.list();
  });
  budget(config.delta, { configReads: 1, writes: 1 });
  assert.equal(config.value.length, documentCount);
  assert.ok(config.value.every(row => row.lang === 'fr' && !row.error));
  assert.equal(config.value[0].title, 'Synthetic edited article');

  // Compare current full-scan and incremental work on identical final content.
  // This is not a historical pre-change benchmark or a timing-ratio assertion.
  const baseline = await run('same-content-forced-full-scan', () => runtime.list({ fresh: true }));
  budget(baseline.delta, fullScan);
  assert.deepEqual(baseline.value, config.value);
  t.diagnostic(JSON.stringify({
    comparison: 'current-full-scan-versus-observed-write', documents: documentCount,
    fullScanDocumentReads: baseline.delta.summaryDocuments + baseline.delta.documentReads,
    existingEditDocumentReads: edit.delta.summaryDocuments + edit.delta.documentReads,
    configDocumentReads: config.delta.summaryDocuments + config.delta.documentReads,
    warmDocumentReads: warm.delta.summaryDocuments + warm.delta.documentReads,
  }));

  const sync = await run('unknown-sync-and-rebuild', async () => {
    await runtime.withUnobservedMutation(async () => {
      memory.files.set(articlePath(1), articleText('Synthetic synchronized article'));
    });
    return runtime.list();
  });
  budget(sync.delta, fullScan);
  assert.equal(sync.value.length, documentCount);
  assert.equal(sync.value[1].title, 'Synthetic synchronized article');
  assert.ok(sync.value.every(row => row.lang === 'fr' && !row.error));
  const settled = await run('warm-after-rebuild', () => runtime.list());
  budget(settled.delta, {});
  assert.deepEqual(settled.value, sync.value);
});

test('1000-document fresh parsing lets a real timer run before parsing completes', { timeout: 120_000 }, async t => {
  let textAccesses = 0, accessesAtHeartbeat = 0, completedAtHeartbeat = true, completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveHeartbeat!: () => void;
  const heartbeat = new Promise<void>(resolve => { resolveHeartbeat = resolve; });
  const memory = memoryRepository(accesses => {
    textAccesses = accesses;
    if (accesses !== 1) return;
    // Schedule inside parsing, not before repository I/O. A microtask-only yield
    // cannot satisfy this heartbeat until the whole parsing loop has completed.
    timer = setTimeout(() => {
      accessesAtHeartbeat = textAccesses;
      completedAtHeartbeat = completed;
      resolveHeartbeat();
    }, 0);
  });
  t.after(() => { if (timer !== undefined) clearTimeout(timer); });
  const started = performance.now();
  // Keep the production default timer scheduler; no mocked or no-op yield hook.
  const snapshot = await createSummaryIndexBuilder(memory.repository).fresh();
  completed = true;
  assert.equal(textAccesses, documentCount);
  assert.equal(snapshot.facts.length, documentCount);
  assert.ok(snapshot.facts.every(fact => fact.fields?.title === 'Synthetic article'));
  await heartbeat;
  assert.equal(completedAtHeartbeat, false, 'timer must run during parsing, not during later projection');
  assert.ok(accessesAtHeartbeat > 0 && accessesAtHeartbeat < documentCount, 'a real task must run before all documents are consumed');
  t.diagnostic(JSON.stringify({
    scenario: 'synthetic-parsing-heartbeat', documents: documentCount,
    parsedDocuments: snapshot.facts.length, summaryTextAccesses: textAccesses,
    documentsConsumedAtHeartbeat: accessesAtHeartbeat,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  }));
});
