import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stableVersion, releaseContext } from '../scripts/release/context.mjs';

const script = name => fileURLToPath(new URL(`../scripts/release/${name}.mjs`, import.meta.url));
test('only stable Studio release tags publish; pushes and PRs never publish', () => {
  for (const value of ['0.0.0', '1.2.3-beta', '1.2.3\nmalicious', '1.2', '01.2.3', '2.100.0', '2001.0.0']) assert.throws(() => stableVersion(value));
  assert.equal(stableVersion('0.2.0'), '0.2.0');
  for (const event of ['push', 'pull_request']) assert.equal(releaseContext(event, {}, '0.1.0', 'abc').release, 'false');
  assert.equal(releaseContext('workflow_dispatch', { inputs: { version: '0.2.0', publish: 'true' } }, '0.1.0', 'abc').tag, 'studio-v0.2.0');
  assert.equal(releaseContext('release', { release: { tag_name: 'studio-v0.3.0' } }, '0.1.0', 'abc').version, '0.3.0');
  assert.throws(() => releaseContext('release', { release: { tag_name: 'theme-v1.0.0' } }, '0.1.0', 'abc'));
  assert.throws(() => releaseContext('release', { release: { tag_name: 'studio-v1.0.0', prerelease: true } }, '0.1.0', 'abc'));
});

test('version injection changes only Studio versions in runner fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-release-version-'));
  try {
    await mkdir(join(root, 'apps/studio/src-tauri'), { recursive: true });
    for (const file of ['apps/studio/package.json', 'apps/studio/src-tauri/tauri.conf.json']) await writeFile(join(root, file), JSON.stringify({ version: '0.1.0' }));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '9.9.9', packages: { 'apps/studio': { version: '0.1.0' }, 'packages/theme': { version: '9.9.9' } } }));
    for (const file of ['Cargo.toml', 'Cargo.lock']) await writeFile(join(root, 'apps/studio/src-tauri', file), 'name = "wondershine-studio"\nversion = "0.1.0"\n\nname = "other"\nversion = "2.0.0"\n');
    execFileSync(process.execPath, [script('version')], { cwd: root, env: { ...process.env, STUDIO_VERSION: '10.2.3', GITHUB_RUN_NUMBER: '123', GITHUB_RUN_ATTEMPT: '2' } });
    for (const file of ['apps/studio/package.json', 'apps/studio/src-tauri/tauri.conf.json']) assert.equal(JSON.parse(await readFile(join(root, file))).version, '10.2.3');
    assert.equal(JSON.parse(await readFile(join(root, 'apps/studio/src-tauri/tauri.conf.json'))).bundle.iOS.bundleVersion, '123.2');
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json')));
    assert.equal(lock.packages['apps/studio'].version, '10.2.3');
    assert.equal(lock.packages['packages/theme'].version, '9.9.9');
    assert.match(await readFile(join(root, 'apps/studio/src-tauri/Cargo.lock'), 'utf8'), /version = "10.2.3"/);
    assert.match(await readFile(join(root, 'apps/studio/src-tauri/Cargo.lock'), 'utf8'), /version = "2.0.0"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('collector refuses empty outputs and debug Android artifacts for a release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-release-artifacts-'));
  try {
    await mkdir(join(root, 'bundle'));
    const env = { ...process.env, STUDIO_PLATFORM: 'android', STUDIO_RELEASE: 'true', STUDIO_VERSION: '0.2.0', STUDIO_SOURCE: 'abc', STUDIO_BUNDLE_DIR: 'bundle' };
    const collect = () => execFileSync(process.execPath, [script('collect')], { cwd: root, env, stdio: 'pipe' });
    assert.throws(collect, /No installable output/);
    await writeFile(join(root, 'bundle/app-debug.apk'), 'debug');
    assert.throws(collect, /signed APK and AAB/);
    await rm(join(root, 'bundle/app-debug.apk'));
    await writeFile(join(root, 'bundle/app-release.apk'), 'signed fixture apk');
    await writeFile(join(root, 'bundle/app-release.aab'), 'signed fixture aab');
    collect();
    const manifest = JSON.parse(await readFile(join(root, 'temp/studio-artifacts/android.json')));
    assert.equal(manifest.files.length, 2);
    assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release publication is recoverable after marker upload fails and completed versions are immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-release-publish-'));
  try {
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'bundle'));
    const stateFile = join(root, 'github.json');
    await writeFile(stateFile, JSON.stringify({ sha: null, release: null, calls: [] }));
    const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE));
state.calls.push(args);
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
const fail = text => { save(); console.error(text); process.exit(1); };
const result = value => { save(); console.log(JSON.stringify(value)); };
if (args[0] === 'api') {
  if (args[1].includes('/git/ref/')) state.sha ? result({ object: { sha: state.sha } }) : fail('HTTP 404');
  else if (args[1].includes('/commits/')) state.sha ? result({ sha: state.sha }) : fail('HTTP 422');
  else if (args[1].includes('/releases/tags/')) state.release ? result(state.release) : fail('HTTP 404');
  else fail('unexpected API');
} else if (args[1] === 'create') {
  state.sha = args[args.indexOf('--target') + 1]; state.release = { draft: true, prerelease: false, assets: [] }; save();
} else if (args[1] === 'edit') { state.release.draft = false; save(); }
else if (args[1] === 'view') result({ assets: state.release.assets });
else if (args[1] === 'upload') {
  for (const path of args.slice(3, args.indexOf('--repo')).filter(x => !x.startsWith('--'))) {
    const name = require('node:path').basename(path);
    if (name === 'studio-release.json' && !state.failedMarker) { state.failedMarker = true; fail('simulated upload interruption'); }
    if (!state.release.assets.some(a => a.name === name)) state.release.assets.push({ name });
  }
  save();
} else fail('unexpected gh invocation');
`;
    await writeFile(join(root, 'bin/gh'), mock, { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, GITHUB_REPOSITORY: 'fixture/studio', STUDIO_VERSION: '0.2.0', STUDIO_SOURCE: 'abc123', STUDIO_RELEASE: 'true', STUDIO_BUNDLE_DIR: 'bundle', STUDIO_UPLOAD_TESTFLIGHT: 'false' };
    for (const key of ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION', 'APPLE_DEVELOPMENT_TEAM']) env[key] = 'fixture';
    const run = name => execFileSync(process.execPath, [script(name)], { cwd: root, env, stdio: 'pipe' });
    // An absent tag must use the refs endpoint, not /commits which returns 422 for unknown refs.
    run('preflight');
    const platforms = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64', 'windows-arm64', 'android', 'ios'];
    for (const platform of platforms) {
      await rm(join(root, 'bundle'), { recursive: true });
      await mkdir(join(root, 'bundle'));
      const files = platform === 'android' ? ['app-release.apk', 'app-release.aab'] : platform === 'ios' ? ['app.ipa'] : platform.startsWith('linux') ? ['app.deb'] : platform.startsWith('macos') ? ['app.dmg'] : ['app.exe'];
      for (const file of files) await writeFile(join(root, 'bundle', file), `${platform} fixture`);
      env.STUDIO_PLATFORM = platform;
      run('collect');
    }
    assert.throws(() => run('publish'));
    let state = JSON.parse(await readFile(stateFile));
    assert.equal(state.release.draft, false);
    assert.equal(state.release.assets.some(a => a.name === 'studio-release.json'), false);
    run('preflight');
    run('publish');
    state = JSON.parse(await readFile(stateFile));
    assert.equal(state.release.assets.some(a => a.name === 'studio-release.json'), true);
    assert.throws(() => run('preflight'), /already complete/);
    assert.throws(() => run('publish'), /complete and immutable/);
    state.sha = 'another-source';
    await writeFile(stateFile, JSON.stringify(state));
    assert.throws(() => run('publish'), /another source commit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
