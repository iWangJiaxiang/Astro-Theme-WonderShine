// Run from a standalone npm site after installing the committed dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';

const theme = '@wondershine/theme';
const requireSite = createRequire(join(process.cwd(), 'package.json'));
const themeManifest = requireSite.resolve(theme + '/package.json');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const dependencies = readJson('package.json').dependencies ?? {};
const dependency = dependencies[theme];
if (dependency?.startsWith('file:') || !themeManifest.includes(sep + 'node_modules' + sep)) {
  console.log('Using the local WonderShine theme dependency.');
} else {
  const { parse } = createRequire(themeManifest)('smol-toml');
  const config = existsSync('config.toml') ? parse(readFileSync('config.toml', 'utf8')) : {};
  const settings = config.extra?.theme ?? {};
  const channel = settings.channel ?? 'latest';
  const patterns = {
    latest: /^\d+\.\d+\.\d+$/,
    next: /^\d+\.\d+\.\d+-(?:beta|rc)\.\d+$/,
    canary: /^\d+\.\d+\.\d+-canary\.\d+$/,
  };
  if (!Object.hasOwn(patterns, channel) || typeof channel !== 'string') throw new Error('Unknown WonderShine theme channel');
  if (settings.pinned !== undefined && typeof settings.pinned !== 'boolean') throw new Error('Expected a boolean for extra.theme.pinned');
  const npm = (args, stdio) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8', stdio });
  const version = settings.pinned ? settings.version
    : JSON.parse(npm(['view', theme, 'dist-tags', '--json', '--prefer-online'], ['ignore', 'pipe', 'inherit']))[channel];
  if (typeof version !== 'string' || !(settings.pinned ? /^\d+\.\d+\.\d+(?:-(?:beta|rc|canary)\.\d+)?$/ : patterns[channel]).test(version)) throw new Error('Missing or invalid theme version for ' + channel);
  if (process.argv.includes('--write-lock')) {
    const lockPath = 'package-lock.json';
    const lockedVersion = () => readJson(lockPath).packages?.['node_modules/' + theme]?.version;
    if (dependency !== version || lockedVersion() !== version) {
      const targets = [theme + '@' + version];
      // Released themes declare their compatible Astro peer. Keep exact site pins in step.
      if (patterns.latest.test(dependencies.astro ?? '')) {
        const peer = npm(['view', theme + '@' + version, 'peerDependencies', '--json', '--prefer-online'], ['ignore', 'pipe', 'inherit']);
        const astro = peer.trim() && JSON.parse(peer).astro;
        if (typeof astro === 'string' && patterns.latest.test(astro) && astro !== dependencies.astro) targets.push('astro@' + astro);
      }
      npm(['install', '--package-lock-only', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', ...targets], 'inherit');
      if (readJson('package.json').dependencies[theme] !== version || lockedVersion() !== version) throw new Error('Theme lock does not match ' + version);
    }
  } else {
    if (readJson(themeManifest).version !== version) {
      npm(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', theme + '@' + version], 'inherit');
    }
    if (readJson(themeManifest).version !== version) throw new Error('Installed theme does not match ' + version);
  }
  console.log(`WonderShine theme ${version} (${channel}, ${settings.pinned ? 'pinned' : 'following channel'})`);
}
