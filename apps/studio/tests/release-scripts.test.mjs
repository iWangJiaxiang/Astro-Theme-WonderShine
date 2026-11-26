import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { stableVersion, releaseContext } from '../scripts/release/context.mjs';
import { validateIOSSdk, validateIOSExportCompliance } from '../scripts/release/verify-ios-sdk.mjs';
import { validateSigningConfiguration } from '../scripts/release/signing-preflight.mjs';
import { nextTestFlightBuildNumber } from '../scripts/release/testflight-build-number.mjs';

const script = name => fileURLToPath(new URL(`../scripts/release/${name}.mjs`, import.meta.url));
test('only stable Studio release tags publish; pushes and PRs never publish', () => {
  for (const value of ['0.0.0', '1.2.3-beta', '1.2.3\nmalicious', '1.2', '01.2.3', '2.100.0', '2001.0.0']) assert.throws(() => stableVersion(value));
  assert.equal(stableVersion('0.2.0'), '0.2.0');
  for (const event of ['push', 'pull_request']) assert.equal(releaseContext(event, {}, '0.1.0', 'abc').release, 'false');
  assert.equal(releaseContext('workflow_dispatch', { ref: 'refs/heads/main', inputs: { version: '0.2.0', publish: 'true' } }, '0.1.0', 'abc').tag, 'studio-v0.2.0');
  assert.equal(releaseContext('release', { release: { tag_name: 'studio-v0.3.0' } }, '0.1.0', 'abc').version, '0.3.0');
  assert.throws(() => releaseContext('release', { release: { tag_name: 'theme-v1.0.0' } }, '0.1.0', 'abc'));
  assert.throws(() => releaseContext('release', { release: { tag_name: 'studio-v1.0.0', prerelease: true } }, '0.1.0', 'abc'));
});

test('iOS-only distribution signs and uploads without publishing a GitHub Release', () => {
  const context = releaseContext('workflow_dispatch', { ref: 'refs/heads/main', inputs: { target: 'ios', version: '0.2.0', publish: 'true' } }, '0.1.0', 'abc');
  assert.equal(context.target, 'ios');
  assert.equal(context.iosRelease, 'true');
  assert.equal(context.testflight, 'true');
  assert.equal(context.release, 'false');
  assert.equal(context.version, '0.2.0');
  const preview = releaseContext('workflow_dispatch', { ref: 'refs/heads/main', inputs: { target: 'ios', publish: 'false' } }, '0.1.0', 'abc', true);
  assert.equal(preview.target, 'ios');
  assert.equal(preview.iosRelease, 'false');
  assert.equal(preview.testflight, 'false');
  assert.equal(preview.release, 'false');
});

test('full releases retain optional TestFlight while push and PR cannot opt in', () => {
  const event = { ref: 'refs/heads/main', inputs: { target: 'all', publish: 'true' } };
  for (const enabled of [false, true]) {
    const context = releaseContext('workflow_dispatch', event, '0.1.0', 'abc', enabled);
    assert.equal(context.release, 'true');
    assert.equal(context.iosRelease, 'true');
    assert.equal(context.testflight, String(enabled));
    const tag = releaseContext('release', { release: { tag_name: 'studio-v0.2.0' } }, '0.1.0', 'abc', enabled);
    assert.equal(tag.target, 'all');
    assert.equal(tag.testflight, String(enabled));
  }
  for (const name of ['push', 'pull_request']) {
    const context = releaseContext(name, { inputs: { target: 'ios', publish: 'true' } }, '0.1.0', 'abc', true);
    assert.equal(context.target, 'all');
    assert.equal(context.release, 'false');
    assert.equal(context.iosRelease, 'false');
    assert.equal(context.testflight, 'false');
  }
  assert.throws(() => releaseContext('workflow_dispatch', { ref: 'refs/heads/main', inputs: { target: 'unknown' } }, '0.1.0', 'abc'), /target/);
});

test('automatic TestFlight signs only main Studio changes and leaves public releases manual', () => {
  const main = { ref: 'refs/heads/main' }, feature = { ref: 'refs/heads/feature' };
  const code = ['apps/studio/src/App.tsx'];
  const context = releaseContext('push', main, '0.2.0', 'abc', true, code);
  assert.equal(context.iosRelease, 'true');
  assert.equal(context.testflight, 'true');
  assert.equal(context.release, 'false');
  for (const [name, event, enabled, paths] of [
    ['push', feature, true, code], ['pull_request', main, true, code],
    ['push', { ...main, deleted: true }, true, code], ['push', main, false, code],
    ['push', main, true, ['packages/theme/index.ts', 'apps/studio/README.md', 'apps/studio/tests/a.ts', 'apps/studio/src-tauri/tests/a.rs']],
  ]) {
    const skipped = releaseContext(name, event, '0.2.0', 'abc', enabled, paths);
    assert.equal(skipped.iosRelease, 'false');
    assert.equal(skipped.testflight, 'false');
  }
  assert.throws(() => releaseContext('workflow_dispatch', { ...feature, inputs: { target: 'ios', publish: 'true' } }, '0.2.0', 'abc'), /from main/);
});

test('iOS signing and TestFlight preflight require only Apple credentials and never disclose values', () => {
  const env = { APPLE_DEVELOPMENT_TEAM: 'private-team-fixture', IOS_CERTIFICATE: 'certificate-fixture', IOS_CERTIFICATE_PASSWORD: 'password-fixture', IOS_MOBILE_PROVISION: 'profile-fixture' };
  assert.doesNotThrow(() => validateSigningConfiguration('ios', env));
  const upload = { ...env, STUDIO_UPLOAD_TESTFLIGHT: 'true' };
  assert.throws(() => validateSigningConfiguration('ios', upload), error => {
    assert.match(error.message, /APPLE_API_ISSUER/);
    assert.match(error.message, /APPLE_API_KEY_BASE64/);
    assert.doesNotMatch(error.message, /ANDROID_|private-team-fixture|password-fixture/);
    return true;
  });
  Object.assign(upload, { APPLE_API_ISSUER: 'issuer-fixture', APPLE_API_KEY: 'key-fixture', APPLE_API_KEY_BASE64: 'p8-fixture' });
  assert.doesNotThrow(() => validateSigningConfiguration('ios', upload));
  assert.throws(() => validateSigningConfiguration('ios', { ...upload, APPLE_DEVELOPMENT_TEAM: '' }), /APPLE_DEVELOPMENT_TEAM/);
  assert.throws(() => validateSigningConfiguration('android', upload), /ANDROID_KEYSTORE_BASE64/);
  assert.doesNotThrow(() => validateSigningConfiguration('android', { ANDROID_KEYSTORE_BASE64: 'keystore', ANDROID_STORE_PASSWORD: 'password', ANDROID_KEY_ALIAS: 'alias', ANDROID_KEY_PASSWORD: 'password', STUDIO_UPLOAD_TESTFLIGHT: 'true' }));
  assert.throws(() => validateSigningConfiguration('unknown', env), /platform/);
});

test('TestFlight build numbers are scoped to the iOS version and include pending uploads', async () => {
  const bundle = 'studio.fixture';
  const previous = '0.2.0';
  const next = '0.2.1';
  const nextPage = 'https://api.appstoreconnect.apple.com/v1/builds?cursor=second';
  const builds = versions => ({ data: versions.map(version => ({ attributes: { version } })) });
  const get = async (resource, params) => {
    if (resource === 'apps') {
      assert.equal(params['filter[bundleId]'], bundle);
      return { data: [{ id: 'app' }] };
    }
    if (resource === nextPage) return builds(['299.1']);
    if (resource === 'builds') {
      assert.equal(params['filter[app]'], 'app');
      assert.equal(params['filter[preReleaseVersion.platform]'], 'IOS');
      assert.ok([previous, next].includes(params['filter[preReleaseVersion.version]']));
      return params['filter[preReleaseVersion.version]'] === previous
        ? { ...builds(['98', '280.9']), links: { next: nextPage } }
        : builds([]);
    }
    assert.equal(resource, 'apps/app/buildUploads');
    assert.equal(params['filter[platform]'], 'IOS');
    assert.ok([previous, next].includes(params['filter[cfBundleShortVersionString]']));
    return { data: [] };
  };
  assert.equal(await nextTestFlightBuildNumber(get, bundle, previous), '300');
  assert.equal(await nextTestFlightBuildNumber(get, bundle, next), '1');
  const getPending = async (resource, params) => resource === 'apps/app/buildUploads'
    ? { data: [{ attributes: { cfBundleVersion: '300' } }] }
    : get(resource, params);
  assert.equal(await nextTestFlightBuildNumber(getPending, bundle, previous), '301');
  const getUnavailable = async (resource, params) => {
    if (resource === 'apps/app/buildUploads') throw new Error('Apple unavailable');
    return get(resource, params);
  };
  await assert.rejects(nextTestFlightBuildNumber(getUnavailable, bundle, next), /Apple unavailable/);
  await assert.rejects(nextTestFlightBuildNumber(async () => ({ data: [] }), bundle, next), /could not find/);
  await assert.rejects(nextTestFlightBuildNumber(
    (resource, params) => resource === 'builds' ? builds(['unexpected']) : get(resource, params), bundle, previous,
  ), /invalid iOS build number/);
});

test('version injection changes only Studio versions in runner fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-release-version-'));
  try {
    await mkdir(join(root, 'apps/studio/src-tauri'), { recursive: true });
    for (const file of ['apps/studio/package.json', 'apps/studio/src-tauri/tauri.conf.json']) await writeFile(join(root, file), JSON.stringify({ version: '0.1.0', ...(file.endsWith('tauri.conf.json') ? { bundle: { iOS: { infoPlist: 'Info.ios.plist' } } } : {}) }));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '9.9.9', packages: { 'apps/studio': { version: '0.1.0' }, 'packages/theme': { version: '9.9.9' } } }));
    for (const file of ['Cargo.toml', 'Cargo.lock']) await writeFile(join(root, 'apps/studio/src-tauri', file), 'name = "wondershine-studio"\nversion = "0.1.0"\n\nname = "other"\nversion = "2.0.0"\n');
    const env = { ...process.env, STUDIO_VERSION: '10.2.3', GITHUB_RUN_NUMBER: '123', GITHUB_RUN_ATTEMPT: '2' };
    delete env.STUDIO_IOS_BUILD_NUMBER;
    const stamp = () => execFileSync(process.execPath, [script('version')], { cwd: root, env, stdio: 'pipe' });
    const iosConfig = async () => JSON.parse(await readFile(join(root, 'apps/studio/src-tauri/tauri.conf.json'))).bundle.iOS;
    stamp();
    for (const file of ['apps/studio/package.json', 'apps/studio/src-tauri/tauri.conf.json']) assert.equal(JSON.parse(await readFile(join(root, file))).version, '10.2.3');
    assert.equal((await iosConfig()).bundleVersion, '123.2');
    env.STUDIO_IOS_BUILD_NUMBER = '1';
    stamp();
    assert.deepEqual(await iosConfig(), { bundleVersion: '1', infoPlist: 'Info.ios.plist' });
    env.STUDIO_IOS_BUILD_NUMBER = '0';
    assert.throws(stamp, /Invalid TestFlight build number/);
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
    assert.throws(collect, /signed APK/);
    await rm(join(root, 'bundle/app-debug.apk'));
    await writeFile(join(root, 'bundle/app-release.apk'), 'signed fixture apk');
    // Ignore stale App Bundles even when present alongside an APK.
    await writeFile(join(root, 'bundle/app-release.aab'), 'not published');
    collect();
    const manifest = JSON.parse(await readFile(join(root, 'temp/studio-artifacts/android.json')));
    assert.equal(manifest.files.length, 1);
    assert.match(manifest.files[0].name, /\.apk$/);
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
    await mkdir(join(root, 'apps/studio/src-tauri'), { recursive: true });
    await writeFile(join(root, 'apps/studio/src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: { pubkey: '' } } }));
    const platforms = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64', 'windows-arm64', 'android', 'ios'];
    for (const platform of platforms) {
      await rm(join(root, 'bundle'), { recursive: true });
      await mkdir(join(root, 'bundle'));
      const files = platform === 'android' ? ['app-release.apk'] : platform === 'ios' ? ['app.ipa'] : platform.startsWith('linux') ? ['app.deb', 'app.rpm', 'app.AppImage'] : platform.startsWith('macos') ? ['app.dmg', 'app.app.tar.gz'] : ['app.exe'];
      for (const file of files) await writeFile(join(root, 'bundle', file), `${platform} fixture`);
      for (const file of files.filter(name => /\.(deb|rpm|AppImage|exe|gz)$/.test(name))) {
        await writeFile(join(root, 'bundle', file + '.sig'), 'fixture signature');
      }
      env.STUDIO_PLATFORM = platform;
      run('collect');
    }
    assert.throws(() => run('publish'));
    let state = JSON.parse(await readFile(stateFile));
    assert.equal(state.release.draft, false);
    const updater = JSON.parse(await readFile(join(root, 'temp/studio-artifacts/studio-updater.json')));
    assert.equal(Object.keys(updater.platforms).length, 10);
    assert.match(updater.platforms['linux-aarch64-rpm'].url, /studio-v0\.2\.0\/linux-arm64-app\.rpm$/);
    assert.equal(updater.platforms['darwin-x86_64-app'].signature, 'fixture signature');
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


test('signed IPA SDK validation rejects old, simulator and missing metadata', () => {
  for (const value of ['', 'iphoneos18.5', 'iphonesimulator26.2', 'iphoneos26junk', '26']) assert.throws(() => validateIOSSdk(value));
  for (const value of ['iphoneos26', 'iphoneos26.2', 'iphoneos27.0']) assert.equal(validateIOSSdk(value), value);
});

test('signed IPA export declaration must be the boolean false', () => {
  for (const value of [undefined, null, true, 'false', 'NO', 0]) {
    assert.throws(() => validateIOSExportCompliance({ ITSAppUsesNonExemptEncryption: value }), /ITSAppUsesNonExemptEncryption/);
  }
  assert.throws(() => validateIOSExportCompliance({}), /ITSAppUsesNonExemptEncryption/);
  assert.doesNotThrow(() => validateIOSExportCompliance({ ITSAppUsesNonExemptEncryption: false }));
});

test('TestFlight requires explicit Apple success even with exit zero, and always removes API keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-testflight-'));
  try {
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'temp/studio-artifacts'), { recursive: true });
    await writeFile(join(root, 'temp/studio-artifacts/ios.json'), JSON.stringify({ files: [{ name: 'fixture.ipa' }] }));
    const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: root,
      APPLE_API_KEY: 'FIXTUREKEY', APPLE_API_ISSUER: 'private-issuer-fixture', APPLE_API_KEY_BASE64: Buffer.from('private-p8-fixture').toString('base64') };
    for (const fixture of [
      { output: 'UPLOAD FAILED with 1 error: SDK version issue. private-issuer-fixture', exit: 0, success: false },
      { output: 'No confirmation from Apple. private-issuer-fixture', exit: 0, success: false },
      { output: 'UPLOAD SUCCEEDED', exit: 1, success: false },
      { output: 'UPLOAD SUCCEEDED but Validation failed', exit: 0, success: false },
      { output: 'UPLOAD SUCCEEDED', exit: 0, success: true },
      { output: 'No errors uploading', exit: 0, success: true },
    ]) {
      await writeFile(join(root, 'bin/xcrun'), `#!/usr/bin/env node\nconsole.error(${JSON.stringify(fixture.output)});process.exit(${fixture.exit});\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [script('testflight')], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status === 0, fixture.success);
      assert.doesNotMatch(result.stdout + result.stderr, /private-issuer-fixture|private-p8-fixture|FIXTUREKEY/);
      await assert.rejects(readFile(join(root, 'studio-appstore/private_keys/AuthKey_FIXTUREKEY.p8')), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
