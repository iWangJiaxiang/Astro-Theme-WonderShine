import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAppRelease, compareVersions, releaseRepository, selectAppRelease, updateDestination } from '../platform/app-updates';

const repository = 'example/studio';
const record = (version: string) => ({ tag_name: `studio-v${version}`, html_url: `https://github.com/${repository}/releases/tag/studio-v${version}`, draft: false, prerelease: false, assets: [{ name: 'studio-release.json', state: 'uploaded', size: 200 }] });

test('updates use numeric stable version ordering, never offer downgrades', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0.0-beta', '1.0.0'));
  assert.equal(selectAppRelease([record('0.9.0'), record('0.10.0'), record('0.8.1')], '0.8.0', repository)?.version, '0.10.0');
  assert.equal(selectAppRelease([record('0.9.0')], '0.10.0', repository), null);
});

test('incomplete, theme, draft, prerelease and forged links are ignored', () => {
  const stable = record('0.2.0');
  const invalid = [
    { ...stable, assets: [] }, { ...stable, draft: true }, { ...stable, prerelease: true },
    { ...stable, tag_name: 'v0.2.0' }, { ...stable, html_url: 'https://evil.example/download' },
    { ...stable, assets: [{ name: 'studio-release.json', state: 'new', size: 0 }] },
    { ...record('01.2.3') }, null, 5,
  ];
  assert.equal(selectAppRelease(invalid, '0.1.0', repository), null);
  assert.equal(selectAppRelease([...invalid, stable], '0.1.0', repository)?.version, '0.2.0');
});

test('download destinations cannot escape GitHub release or approved iOS hosts', () => {
  const release = { version: '0.2.0', url: record('0.2.0').html_url };
  assert.equal(updateDestination(release, repository, false, ''), release.url);
  assert.equal(updateDestination(release, repository, true, 'https://testflight.apple.com/join/abcd'), 'https://testflight.apple.com/join/abcd');
  for (const url of ['http://apps.apple.com/a', 'https://apps.apple.com.evil.example/a', 'https://user@apps.apple.com/a', 'file:///tmp/a', 'javascript:alert(1)']) assert.throws(() => updateDestination(release, repository, true, url));
  assert.throws(() => updateDestination({ ...release, url: 'https://evil.example' }, repository, false, ''));
  assert.throws(() => releaseRepository('example/studio/../../secret'));
});

test('pagination finds Studio releases beyond a full page of theme versions', async () => {
  const urls: string[] = [];
  const request: typeof fetch = async input => {
    urls.push(String(input));
    return Response.json(urls.length === 1 ? Array.from({ length: 100 }, () => ({ tag_name: 'theme-v1' })) : [record('1.0.0')]);
  };
  const result = await checkAppRelease('0.1.0', repository, request, new AbortController().signal);
  assert.equal(result?.version, '1.0.0');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /page=2$/);
});

test('HTTP failures and malformed data are reported to manual checks', async () => {
  await assert.rejects(checkAppRelease('0.1.0', repository, async () => new Response('', { status: 403 }), new AbortController().signal), /403/);
  await assert.rejects(checkAppRelease('0.1.0', repository, async () => Response.json({ message: 'error' }), new AbortController().signal), /Invalid release response/);
});
