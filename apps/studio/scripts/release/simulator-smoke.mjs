import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const phases = new Set(['prepare-output', 'find-app', 'app-metadata', 'verify-icons', 'copy-icons', 'list-devices', 'select-device', 'boot', 'bootstatus', 'status-bar', 'install', 'launch', 'settle', 'screenshot', 'shutdown', 'write-result']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGINT', 'SIGHUP', 'SIGPIPE', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGALRM', 'SIGXCPU', 'SIGXFSZ']);
const errorCodes = new Set(['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EROFS', 'ERR_ASSERTION', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);

function diagnostic(phase, elapsed, error, command) {
  assert.ok(phases.has(phase));
  return {
    phase,
    elapsedMs: Number.isFinite(elapsed) ? Math.min(3600000, Math.max(0, Math.round(elapsed))) : 0,
    timedOut: error?.code === 'ETIMEDOUT',
    exitStatus: error ? (Number.isInteger(error.status) && error.status >= 0 && error.status <= 255 ? error.status : null) : (command ? 0 : null),
    signal: error?.signal ? (signals.has(error.signal) ? error.signal : 'UNKNOWN') : null,
    errorCode: error ? (errorCodes.has(error.code) ? error.code : 'UNKNOWN') : null,
  };
}

// Never retain the raw error as a cause: child-process errors include arguments and output.
function failure(record) {
  return Object.assign(new Error(`Simulator smoke failed during ${record.phase}.`), record);
}

export async function runSimulatorSmoke({
  exec = execFileSync,
  io = { mkdir, readdir, writeFile, copyFile },
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => performance.now(),
} = {}) {
  const output = resolve('apps/studio/test-results/ios-simulator');
  const result = { schemaVersion: 1, success: false, phases: [] };
  async function stage(phase, action, command = false) {
    const started = now();
    try {
      const value = await action();
      result.phases.push(diagnostic(phase, now() - started, null, command));
      return value;
    } catch (error) {
      const record = diagnostic(phase, now() - started, error, command);
      result.phases.push(record);
      throw failure(record);
    }
  }
  const run = (phase, args, timeout = 120000) => stage(phase, () => exec('xcrun', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }), true);
  async function findApp(directory) {
    for (const item of await io.readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      const path = join(directory, item.name);
      if (item.name.endsWith('.app')) return path;
      const found = await findApp(path); if (found) return found;
    }
  }
  let device;
  let primary;
  let shutdownError;
  try {
    await stage('prepare-output', () => io.mkdir(output, { recursive: true }));
    const app = await stage('find-app', async () => {
      const app = await findApp(resolve('apps/studio/src-tauri/gen/apple/build'));
      assert.ok(app, 'Simulator .app must exist');
      return app;
    });
    const plist = await stage('app-metadata', () => JSON.parse(exec('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), true);
    const compiledIcon = await stage('verify-icons', async () => {
      assert.equal(plist.CFBundleIdentifier, 'wang.jiaxiang.wondershine-studio');
      assert.equal(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName, 'AppIcon');
      const icons = plist.CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles;
      assert.ok(icons?.length, 'Compiled app must reference icon files');
      const files = await io.readdir(app);
      const compiledIcon = files.find(file => /AppIcon.*\.png$/.test(file));
      assert.ok(compiledIcon, 'Compiled icon resources must be present');
      return compiledIcon;
    });
    await stage('copy-icons', async () => {
      await io.copyFile(join(app, compiledIcon), join(output, 'compiled-app-icon.png'));
      await io.copyFile(resolve('apps/studio/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), join(output, 'app-icon-1024.png'));
    });
    const listing = await run('list-devices', ['simctl', 'list', 'devices', 'available', '-j']);
    device = await stage('select-device', () => {
      const devices = Object.entries(JSON.parse(listing).devices).filter(([runtime]) => runtime.includes('iOS')).flatMap(([, list]) => list);
      const device = devices.find(device => device.name.startsWith('iPhone') && device.isAvailable);
      assert.ok(device, 'An iPhone simulator is required');
      return device;
    });
    if (device.state !== 'Booted') await run('boot', ['simctl', 'boot', device.udid]);
    await run('bootstatus', ['simctl', 'bootstatus', device.udid, '-b'], 240000);
    await run('status-bar', ['simctl', 'status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100']);
    await run('install', ['simctl', 'install', device.udid, app]);
    await run('launch', ['simctl', 'launch', device.udid, plist.CFBundleIdentifier]);
    await stage('settle', () => wait(6000));
    await run('screenshot', ['simctl', 'io', device.udid, 'screenshot', join(output, 'studio-launch.png')]);
  } catch (error) {
    primary = error;
  }
  // Cleanup is independent of both the primary operation and diagnostic persistence.
  if (device) {
    try { await run('shutdown', ['simctl', 'shutdown', device.udid]); }
    catch (error) { shutdownError = error; }
  }
  result.success = !primary && !shutdownError;
  let diagnosticError;
  const started = now();
  try { await io.writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); }
  catch (error) { diagnosticError = failure(diagnostic('write-result', now() - started, error, false)); }
  const errors = [primary, shutdownError, diagnosticError].filter(Boolean);
  if (errors.length > 1) throw new AggregateError(errors, 'Simulator smoke failed; secondary failures are included.', { cause: errors[0] });
  if (errors.length) throw errors[0];
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSimulatorSmoke();
}
