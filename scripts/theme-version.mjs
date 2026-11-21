import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeVersion } from './npm-release.mjs';

export function nextCanary(current, runId) {
  const { version, prerelease } = themeVersion(current);
  if (!/^[1-9]\d*$/.test(runId)) throw new Error('Expected a positive run ID');
  const [major, minor, patch] = version.split('-')[0].split('.');
  return `${major}.${minor}.${prerelease ? patch : BigInt(patch) + 1n}-canary.${runId}`;
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const theme = 'packages/theme';
  const pkg = read(theme + '/package.json');
  const version = process.argv[2] === '--canary'
    ? nextCanary(pkg.version, process.env.GITHUB_RUN_ID)
    : themeVersion(process.argv[2]).version;
  const lock = read('package-lock.json');
  pkg.version = lock.packages[theme].version = version;
  write(theme + '/package.json', pkg);
  for (const dir of ['examples/demo', 'examples/starter']) {
    const example = read(dir + '/package.json');
    example.dependencies[pkg.name] = lock.packages[dir].dependencies[pkg.name] = version;
    write(dir + '/package.json', example);
  }
  write('package-lock.json', lock);
  console.log(version);
}
