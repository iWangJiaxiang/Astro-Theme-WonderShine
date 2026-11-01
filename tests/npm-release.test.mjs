import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { themeVersion, themeReleaseContext } from '../scripts/npm-release.mjs';
import { assertUnpublishedPackage } from '../scripts/npm-bootstrap.mjs';
import { artifactManifest, verifyArtifact } from '../scripts/npm-artifact.mjs';

const repository = 'fixture/theme', sha = 'a'.repeat(40);
const pkg = { name: '@wondershine/theme', version: '0.2.0', repository: { url: `https://github.com/${repository}.git` } };
const release = (tag_name, prerelease = false) => ({ release: { tag_name, prerelease } });

test('theme versions reject unsafe and noncanonical values; prereleases never become latest', () => {
  for (const version of ['1.2', '01.2.3', '1.2.3+build', '1.2.3-beta.01', '1.2.3\nmalicious', '1.2.3\n', '../0.2.0', '1.2.3-', undefined]) assert.throws(() => themeVersion(version));
  assert.equal(themeVersion('0.2.0').distTag, 'latest');
  assert.equal(themeVersion('0.2.0-beta.1').distTag, 'next');
  assert.equal(themeVersion('1.2.3-0').distTag, 'next');
});

test('manual validation cannot publish; theme releases must match version, prerelease state and provenance source', () => {
  assert.equal(themeReleaseContext('workflow_dispatch', { inputs: { publish: 'true' } }, pkg, repository, sha).publish, 'false');
  assert.equal(themeReleaseContext('release', release('theme-v0.2.0'), pkg, repository, sha).publish, 'true');
  const preview = { ...pkg, version: '0.3.0-beta.1' };
  assert.equal(themeReleaseContext('release', release('theme-v0.3.0-beta.1', true), preview, repository, sha).distTag, 'next');
  for (const event of [release('studio-v0.2.0'), release('theme-v0.3.0'), release('theme-v0.2.0', true), { release: { tag_name: 'theme-v0.2.0', draft: true } }]) {
    assert.throws(() => themeReleaseContext('release', event, pkg, repository, sha));
  }
  assert.throws(() => themeReleaseContext('release', release('theme-v0.3.0-beta.1'), preview, repository, sha));
  assert.throws(() => themeReleaseContext('push', {}, pkg, repository, sha));
  assert.throws(() => themeReleaseContext('workflow_dispatch', {}, { ...pkg, private: true }, repository, sha));
  assert.throws(() => themeReleaseContext('workflow_dispatch', {}, pkg, 'other/repo', sha));
  assert.throws(() => themeReleaseContext('workflow_dispatch', {}, pkg, repository, 'HEAD'));
});

test('publishing verifies the exact tested package bytes, version, repository and source', () => {
  const bytes = Buffer.from('isolated install-tested package');
  const expected = { version: '0.2.0', repository, source: sha };
  const manifest = artifactManifest(bytes, expected.version, repository, sha);
  assert.deepEqual(verifyArtifact(manifest, bytes, expected), manifest);
  assert.throws(() => verifyArtifact(manifest, Buffer.from('changed'), expected), /sha256/);
  for (const [key, value] of Object.entries({ version: '0.3.0', repository: 'another/repo', source: 'b'.repeat(40) })) {
    assert.throws(() => verifyArtifact(manifest, bytes, { ...expected, [key]: value }));
  }
  assert.throws(() => verifyArtifact({ ...manifest, filename: '../package.tgz' }, bytes, expected), /filename/);
  assert.throws(() => verifyArtifact({ ...manifest, distTag: 'next' }, bytes, expected), /distTag/);
});

test('Studio distribution and isolated acceptance identifiers stay separate and agree with their fixture path', () => {
  const config = JSON.parse(readFileSync(new URL('../apps/studio/src-tauri/tauri.conf.json', import.meta.url)));
  const rust = readFileSync(new URL('../apps/studio/src-tauri/src/native_smoke.rs', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../apps/studio/tests/native/macos.mjs', import.meta.url), 'utf8');
  assert.equal(config.identifier, 'wang.jiaxiang.wondershine-studio');
  assert.ok(rust.includes(`"${config.identifier}.acceptance"`));
  assert.ok(runner.includes(`${config.identifier}.acceptance/workspaces`));
});


test('first publication requires an explicit manual bootstrap input; releases keep OIDC', () => {
  for (const input of [undefined, false, 'false', 'yes']) {
    const context = themeReleaseContext('workflow_dispatch', { inputs: { bootstrap: input } }, pkg, repository, sha);
    assert.equal(context.publish, 'false');
    assert.equal(context.bootstrap, 'false');
  }
  for (const input of [true, 'true']) {
    const context = themeReleaseContext('workflow_dispatch', { inputs: { bootstrap: input } }, pkg, repository, sha);
    assert.equal(context.publish, 'true');
    assert.equal(context.bootstrap, 'true');
  }
  const event = { ...release('theme-v0.2.0'), inputs: { bootstrap: 'true' } };
  assert.equal(themeReleaseContext('release', event, pkg, repository, sha).bootstrap, 'false');
});

test('bootstrap rejects existing packages and fails closed on registry errors', () => {
  assert.doesNotThrow(() => assertUnpublishedPackage(404));
  for (const status of [200, 301, 401, 403, 429, 500, 503]) assert.throws(() => assertUnpublishedPackage(status));
});
