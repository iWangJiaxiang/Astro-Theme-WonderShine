import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const run = (args, timeout = 120000) => execFileSync('xcrun', args, { encoding: 'utf8', timeout });
const output = resolve('apps/studio/test-results/ios-simulator');
await mkdir(output, { recursive: true });
async function findApp(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const path = join(directory, item.name);
    if (item.name.endsWith('.app')) return path;
    const found = await findApp(path); if (found) return found;
  }
}
const bundleDirectory = process.argv[2];
const app = await findApp(resolve(bundleDirectory || 'apps/studio/src-tauri/gen/apple/build'));
assert.ok(app, 'Simulator .app must exist');
const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')], { encoding: 'utf8' }));
assert.equal(plist.CFBundleIdentifier, 'wang.jiaxiang.wondershine-studio');
assert.equal(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName, 'AppIcon');
const icons = plist.CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles;
assert.ok(icons?.length, 'Compiled app must reference icon files');
const files = await readdir(app);
const compiledIcon = files.find(file => /AppIcon.*\.png$/.test(file));
assert.ok(compiledIcon, 'Compiled icon resources must be present');
await copyFile(join(app, compiledIcon), join(output, 'compiled-app-icon.png'));
const sourceIcon = bundleDirectory ? join(bundleDirectory, 'app-icon-1024.png')
  : 'apps/studio/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';
await copyFile(sourceIcon, join(output, 'app-icon-1024.png'));
const listing = JSON.parse(run(['simctl', 'list', 'devices', 'available', '-j']));
const devices = Object.entries(listing.devices).filter(([runtime]) => runtime.includes('iOS'))
  .sort(([left], [right]) => right.localeCompare(left, 'en', { numeric: true }))
  .flatMap(([, list]) => list);
const device = devices.find(device => device.name.startsWith('iPhone') && device.isAvailable);
assert.ok(device, 'An iPhone simulator is required');
console.log(`Launching ${plist.DTSDKName} build on ${device.name}`);
try {
  if (device.state !== 'Booted') run(['simctl', 'boot', device.udid]);
  run(['simctl', 'bootstatus', device.udid, '-b'], 240000);
  run(['simctl', 'status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100']);
  run(['simctl', 'install', device.udid, app]);
  const launchArgs = ['simctl', 'launch', device.udid, plist.CFBundleIdentifier];
  run(['simctl', 'ui', device.udid, 'appearance', 'light']);
  let launch;
  try {
    launch = run(launchArgs, 60_000);
  } catch (error) {
    if (error.code !== 'ETIMEDOUT') throw error;
    // On a new runtime FrontBoard may leave the first open request pending
    // without spawning the app. Keep the installed binary and restart the simulator.
    console.log('The simulator did not complete its launch request. Restarting the installed simulator once.');
    run(['simctl', 'shutdown', device.udid]);
    run(['simctl', 'bootstatus', device.udid, '-b'], 240000);
    launch = run(launchArgs);
  }
  for (const appearance of ['light', 'dark']) {
    const dark = appearance === 'dark';
    if (dark) {
      run(['simctl', 'terminate', device.udid, plist.CFBundleIdentifier]);
      run(['simctl', 'ui', device.udid, 'appearance', 'dark']);
      run(launchArgs);
    }
    const capture = join(output, dark ? 'studio-launch-dark.png' : 'studio-launch.png');
    const deadline = Date.now() + 60_000;
    let painted = false;
    do {
      await new Promise(resolve => setTimeout(resolve, 2000));
      run(['simctl', 'io', device.udid, 'screenshot', capture]);
      const { data, info } = await sharp(capture).resize({ width: 160 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      // The full-width submit button distinguishes the painted form from the OS launch screen.
      for (let y = Math.floor(info.height * 0.20); y < info.height * 0.90 && !painted; y++) {
        let width = 0;
        for (let x = 0; x < info.width; x++) {
          const offset = (y * info.width + x) * info.channels;
          const [r, g, b] = data.subarray(offset, offset + 3);
          const accent = dark ? r - b > 75 && g - b > 45 : b - r > 75 && b - g > 45;
          width = accent ? width + 1 : 0;
          if (width > info.width * 0.55) { painted = true; break; }
        }
      }
      if (painted && dark) {
        // Sample the connection-page gutter, outside the card and system bars.
        const gutter = (Math.floor(info.height / 2) * info.width + 2) * info.channels;
        const rgb = [...data.subarray(gutter, gutter + 3)];
        assert.ok(rgb.every(channel => channel < 55), `Dark launch painted a light background: ${rgb}`);
      }
    } while (!painted && Date.now() < deadline);
    if (!painted) {
      const diagnostics = run(['simctl', 'spawn', device.udid, 'log', 'show', '--last', '2m', '--style', 'compact',
        '--predicate', 'process == "' + plist.CFBundleExecutable + '" OR (process == "com.apple.WebKit.WebContent" AND messageType == error)']);
      await writeFile(join(output, 'launch-diagnostics.log'), diagnostics);
    }
    assert.ok(painted, `The workspace connection screen must appear after a ${appearance} launch`);
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ identifier: plist.CFBundleIdentifier, icon: 'AppIcon', device: device.name, launch: launch.trim(), checks: ['compiled icon references', 'install', 'light launch', 'dark launch', 'screenshots'], limitation: 'Pinch, keyboard and assistive interactions still require device acceptance.' }, null, 2));
} finally {
  run(['simctl', 'shutdown', device.udid]);
}
