import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

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
const app = await findApp(resolve('apps/studio/src-tauri/gen/apple/build'));
assert.ok(app, 'Simulator .app must exist');
const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')], { encoding: 'utf8' }));
assert.equal(plist.CFBundleIdentifier, 'wang.jiaxiang.wondershine-studio');
assert.equal(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName, 'AppIcon');
const icons = plist.CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles;
assert.ok(icons?.length, 'Compiled app must reference icon files');
const files = await readdir(app);
assert.ok(files.some(file => /AppIcon.*\.png$/.test(file)), 'Compiled icon resources must be present');
const listing = JSON.parse(run(['simctl', 'list', 'devices', 'available', '-j']));
const devices = Object.entries(listing.devices).filter(([runtime]) => runtime.includes('iOS')).flatMap(([, list]) => list);
const device = devices.find(device => device.name.startsWith('iPhone') && device.isAvailable);
assert.ok(device, 'An iPhone simulator is required');
try {
  if (device.state !== 'Booted') run(['simctl', 'boot', device.udid]);
  run(['simctl', 'bootstatus', device.udid, '-b'], 240000);
  run(['simctl', 'status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100']);
  run(['simctl', 'install', device.udid, app]);
  const launch = run(['simctl', 'launch', device.udid, plist.CFBundleIdentifier]);
  await new Promise(resolve => setTimeout(resolve, 6000));
  run(['simctl', 'io', device.udid, 'screenshot', join(output, 'studio-launch.png')]);
  await writeFile(join(output, 'result.json'), JSON.stringify({ identifier: plist.CFBundleIdentifier, icon: 'AppIcon', device: device.name, launch: launch.trim(), checks: ['compiled icon references', 'install', 'launch', 'screenshot'], limitation: 'Pinch, keyboard and assistive interactions still require device acceptance.' }, null, 2));
} finally {
  run(['simctl', 'shutdown', device.udid]);
}
