import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { SUMMARY_INDEX_CACHE_RECIPE } from '../core/summary-index.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'summary-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = join(root, 'site'), client = join(root, 'client'), state = join(root, 'state');
  await Promise.all([mkdir(site), mkdir(client)]);
  const env = { STUDIO_ORIGIN: 'http://localhost:5173', STUDIO_SESSION_SECRET: 'x'.repeat(32), STUDIO_ADMIN_USER: 'owner',
    STUDIO_ADMIN_PASSWORD_HASH: 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(128), STUDIO_SITE_ROOT: site, STUDIO_STATE_DIR: state };
  return { root, site, client, state, env };
}

test('server persistence requires explicit serving boundaries and excludes online Git', async t => {
  const { env, client } = await fixture(t);
  assert.equal(loadConfig(env).summaryStore, undefined);
  assert.ok(loadConfig(env, { servingRoots: [client] }).summaryStore);
  const online = { ...env, STUDIO_GIT_URL: 'https://git.example/site.git' };
  assert.equal(loadConfig(online, { servingRoots: [client] }).summaryStore, undefined);
  // Blob production passes through the same online Git exclusion before any cache construction.
});

test('client/source serving roots disable unsafe persistence without failing startup', async t => {
  const { env, client, root } = await fixture(t);
  assert.equal(loadConfig({ ...env, STUDIO_STATE_DIR: join(client, 'private-looking-state') }, { servingRoots: [client] }).summaryStore, undefined);
  assert.equal(loadConfig(env, { servingRoots: [root] }).summaryStore, undefined, 'Vite source /@fs allow roots are forbidden too');
});

test('server preview store is lazy, usable after authentication creates state, and repository-bound', async t => {
  const { env, client, root } = await fixture(t);
  const configured = loadConfig(env, { servingRoots: [client] });
  assert.ok(configured.summaryStore);
  assert.equal(await configured.summaryStore.load(), null, 'missing state is a cache miss, not a startup error');
  await configured.state.set('fixture-session', { authenticated: true });
  if (process.platform === 'win32') return; // Adapter intentionally refuses unproved Windows ACLs.
  const record = { version: 1 as const, recipe: SUMMARY_INDEX_CACHE_RECIPE, scope: configured.summaryScope!, state: 'clean' as const, rows: [] } satisfies import('../core/summary-index.js').SummaryIndexCacheRecord;
  await configured.summaryStore.save(record);
  assert.deepEqual(await configured.summaryStore.load(), record);
  const otherSite = join(root, 'other-site');
  await mkdir(otherSite);
  const redirected = loadConfig({ ...env, STUDIO_SITE_ROOT: otherSite }, { servingRoots: [client] });
  assert.notEqual(redirected.summaryScope, configured.summaryScope);
  assert.equal(configured.summaryScope?.includes(env.STUDIO_SESSION_SECRET), false);
  assert.equal(configured.summaryScope?.includes(env.STUDIO_ADMIN_PASSWORD_HASH), false);
});
