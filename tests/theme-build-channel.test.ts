import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hook = fileURLToPath(new URL('../examples/starter/scripts/theme-channel.mjs', import.meta.url));
test('a standalone npm build follows moved tags and honors a pin without Studio', async t => {
  const root = await mkdtemp(join(tmpdir(), 'theme-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = '@wondershine/theme', latest = '1.0.0', preview = '1.1.0-beta.1', newer = '1.1.0-beta.2', canary = '1.1.0-canary.1', nextCanary = '1.1.0-canary.2';
  const tags = { latest, next: preview, canary };
  const versions: Record<string, object> = {};
  const tarballs = new Map<string, Buffer>();
  let lookups = 0;
  const server = createServer((req, res) => {
    if (decodeURIComponent(req.url!) === '/' + name) {
      lookups++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name, 'dist-tags': tags, versions }));
    } else if (tarballs.has(req.url!)) res.end(tarballs.get(req.url!));
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const fixture = join(root, 'fixture'), site = join(root, 'site');
  await mkdir(fixture); await mkdir(site);
  const env = { ...process.env, npm_config_registry: registry, npm_config_cache: join(root, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
  for (const version of [latest, preview, newer, canary, nextCanary]) {
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name, version }));
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', root], { cwd: fixture, env });
    const file = '/' + JSON.parse(stdout)[0].filename;
    const bytes = await readFile(join(root, file));
    tarballs.set(file, bytes);
    versions[version] = { name, version, dist: { tarball: registry + file, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } };
  }
  const parser = dirname(dirname(createRequire(import.meta.url).resolve('smol-toml')));
  const manifest = JSON.stringify({ name: 'fixture', private: true, scripts: { prebuild: 'node "' + hook + '"', build: 'node --version', 'theme:update': 'node "' + hook + '" --write-lock' },
    dependencies: { [name]: latest, 'smol-toml': 'file:' + parser } });
  await writeFile(join(site, 'package.json'), manifest);
  const npm = (...args: string[]) => exec('npm', args, { cwd: site, env });
  await npm('install');
  const lock = await readFile(join(site, 'package-lock.json'), 'utf8');
  const build = async () => {
    await npm('run', 'build');
    assert.equal(await readFile(join(site, 'package.json'), 'utf8'), manifest);
    assert.equal(await readFile(join(site, 'package-lock.json'), 'utf8'), lock);
    return JSON.parse(await readFile(join(site, 'node_modules', name, 'package.json'), 'utf8')).version;
  };
  assert.equal(await build(), latest);
  await writeFile(join(site, 'config.toml'), '[extra.theme]\nchannel="next"\n');
  assert.equal(await build(), preview);
  tags.next = newer;
  await writeFile(join(site, 'config.toml'), '# WonderShine Studio theme rebuild: next 2026-11-22T04:00:00.000Z\n[extra.theme]\nchannel="next"\n');
  assert.equal(await build(), newer);
  await npm('ci');
  await writeFile(join(site, 'config.toml'), '[extra.theme]\nchannel="next"\npinned=true\nversion="1.0.0"\n');
  const before = lookups;
  assert.equal(await build(), latest);
  assert.equal(lookups, before);

  // A pipeline persists the selection before npm ci installs it in a clean checkout.
  const update = async (expected: string) => {
    await npm('run', 'theme:update');
    const pkg = JSON.parse(await readFile(join(site, 'package.json'), 'utf8'));
    const locked = JSON.parse(await readFile(join(site, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.dependencies[name], expected);
    assert.equal(locked.packages[''].dependencies[name], expected);
    assert.equal(locked.packages['node_modules/' + name].version, expected);
    await npm('ci');
    assert.equal(JSON.parse(await readFile(join(site, 'node_modules', name, 'package.json'), 'utf8')).version, expected);
  };
  await writeFile(join(site, 'config.toml'), '[extra.theme]\nchannel="canary"\n');
  await update(canary);
  tags.canary = nextCanary;
  await update(nextCanary);
  await writeFile(join(site, 'config.toml'), `[extra.theme]\nchannel="canary"\npinned=true\nversion="${nextCanary}"\n`);
  tags.canary = canary;
  const beforePin = lookups;
  await npm('run', 'theme:update');
  assert.equal(lookups, beforePin);
  assert.equal(JSON.parse(await readFile(join(site, 'package.json'), 'utf8')).dependencies[name], nextCanary);
});
