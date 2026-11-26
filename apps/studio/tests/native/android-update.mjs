// Run on a disposable CI emulator with two debug APKs signed by the same runner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const id = 'wang.jiaxiang.wondershine_studio';
const directory = 'temp/studio-artifacts';
const previous = join(directory, readdirSync(directory).find(name => name.endsWith('.apk')));
const next = process.env.STUDIO_NEXT_APK;
const version = process.env.STUDIO_NEXT_VERSION;
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const privateShell = command => adb('shell', 'run-as', id, 'sh', '-c', "'" + command + "'");
async function until(read, label) {
  let last;
  for (let i = 0; i < 75; i++) {
    try { const result = await read(); if (result) return result; } catch (e) { last = e; }
    await delay(800);
  }
  throw new Error('Timeout waiting for ' + label, { cause: last });
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function stage(file) {
  const digest = await fileHash(file);
  adb('push', file, '/data/local/tmp/studio-update.apk');
  privateShell('mkdir -p cache/studio-update && cp /data/local/tmp/studio-update.apk cache/studio-update/' + digest + '.apk');
  return { version, size: statSync(file).size, sha256: digest, automatic: false, name: 'android-test.apk' };
}
async function tapSystemControl(action) {
  await until(() => {
    adb('shell', 'uiautomator', 'dump', '/sdcard/studio-ui.xml');
    const xml = adb('shell', 'cat', '/sdcard/studio-ui.xml');
    const nodes = [...xml.matchAll(/<node\b[^>]+>/g)].map(match => match[0]);
    const node = nodes.find(tag => {
      if (action === 'allow') return xml.includes('Allow from this source') && tag.includes('package="com.android.settings"') && tag.includes('checkable="true"') && tag.includes('checked="false"');
      if (!/package="[^"]*(?:packageinstaller|permissioncontroller)"/i.test(tag)) return false;
      return (action === 'cancel' ? /text="Cancel"|resource-id="android:id\/button2"/i : /text="(Update|Install)"|resource-id="android:id\/button1"/i).test(tag);
    });
    const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) return false;
    adb('shell', 'input', 'tap', String((+bounds[1] + +bounds[3]) >> 1), String((+bounds[2] + +bounds[4]) >> 1));
    return true;
  }, action + ' system control');
}

adb('install', '-r', previous);
adb('shell', 'monkey', '-p', id, '1');
const browserURL = await until(async () => {
  const pid = adb('shell', 'pidof', id);
  if (!pid) return;
  adb('forward', 'tcp:9222', 'localabstract:webview_devtools_remote_' + pid);
  if ((await fetch('http://127.0.0.1:9222/json/list')).ok) return 'http://127.0.0.1:9222';
}, 'Studio WebView');
const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
try {
  const page = await until(async () => (await browser.pages()).find(p => /tauri\.localhost|tauri:\/\//.test(p.url())), 'local Studio page');
  // Seed one unpublished draft and one real local commit in private workspace storage.
  const fixture = 'temp/android-update-repo';
  execFileSync('git', ['init', '-q', fixture]);
  execFileSync('git', ['-C', fixture, '-c', 'user.name=Studio CI', '-c', 'user.email=ci@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'offline edit']);
  const head = readFileSync(join(fixture, '.git/HEAD'), 'utf8').trim().slice(5);
  const commit = readFileSync(join(fixture, '.git', head), 'utf8').trim();
  execFileSync('tar', ['-cf', 'temp/android-update-workspace.tar', '-C', fixture, '.']);
  adb('push', 'temp/android-update-workspace.tar', '/data/local/tmp/studio-repo.tar');
  const repo = 'files/workspaces/00000000-0000-4000-8000-000000000001/repo';
  privateShell('mkdir -p ' + repo + ' && cd ' + repo + ' && tar xf /data/local/tmp/studio-repo.tar && echo unpublished > draft.md');

  async function prepare(asset) {
    return page.evaluate(args => {
      const api = window.__TAURI_INTERNALS__;
      return api.invoke('plugin:studio-apk|download', { ...args, progress: '__CHANNEL__:' + api.transformCallback(() => {}) })
        .catch(error => { throw Error(error?.message || JSON.stringify(error)); });
    }, asset);
  }

  const invalid = await stage(process.env.STUDIO_OTHER_SIGNER_APK);
  await assert.rejects(prepare(invalid), /INVALID_APK/);
  const asset = await stage(next);
  await prepare(asset);
  const install = () => page.evaluate(args => {
    window.studioInstallError = '';
    window.__TAURI_INTERNALS__.invoke('plugin:studio-apk|install', args).catch(e => { window.studioInstallError = String(e?.message || e); });
  }, { version, sha256: asset.sha256 });
  await install();
  // Android pauses WebView animation frames while Settings owns the foreground.
  await tapSystemControl('allow');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await until(() => adb('shell', 'dumpsys', 'activity', 'activities').split('\n').some(line => line.includes('topResumedActivity') && line.includes(id)), 'return to Studio');
  await until(() => page.evaluate(() => window.studioInstallError === 'PERMISSION'), 'permission response');
  await install();
  await tapSystemControl('cancel');
  await page.waitForFunction(() => window.studioInstallError === 'CANCELLED');
  await install();
  await tapSystemControl('update');
  await until(() => adb('shell', 'dumpsys', 'package', id).includes('versionName=' + version + '\n'), 'new installed version');
  adb('shell', 'monkey', '-p', id, '1');
  assert.equal(privateShell('cat ' + repo + '/draft.md'), 'unpublished');
  assert.equal(privateShell('cat ' + repo + '/.git/' + head), commit);
} catch (error) {
  console.error(adb('shell', 'df', '-h', '/data'));
  console.error(adb('shell', 'dumpsys', 'activity', 'activities').split('\n').filter(line => line.includes('ResumedActivity')).slice(-3));
  console.error('Native install test failed:', error);
  const hierarchy = spawnSync('adb', ['shell', 'cat', '/sdcard/studio-ui.xml'], { encoding: 'utf8' });
  if (hierarchy.status === 0) console.error(hierarchy.stdout.slice(-6500));
  console.error(adb('logcat', '-d', '-t', '1500').split('\n').filter(line => /InstallResult|PackageInstaller|Background activity|ActivityTaskManager.*START|AndroidRuntime.*Exception/i.test(line)).slice(-25).join('\n'));
  throw error;
} finally { await browser.disconnect(); spawnSync('adb', ['forward', '--remove', 'tcp:9222']); }
