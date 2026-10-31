import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const astroCli = join(require.resolve('astro/package.json'), '..', 'bin', 'astro.mjs');
export const siteApplication = fileURLToPath(new URL('../../../examples/demo/', import.meta.url));
export function buildAstro(siteRoot: string, outputRoot = join(siteRoot, 'dist')) {
  const modules = join(siteRoot, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(require.resolve('astro/package.json'), '..', '..'), modules, 'junction');
  // Astro places temporary prerender output under cwd when outDir is external.
  // Each fixture gets its own cwd so simultaneous browser/integration builds cannot collide.
  const result = spawnSync(process.execPath, [astroCli, 'build', '--root', siteApplication], { cwd: siteRoot,
    env: { ...process.env, ASTRO_SITE_ROOT: siteRoot, ASTRO_OUT_DIR: outputRoot }, encoding: 'utf8', maxBuffer: 16*1024*1024, timeout: 180000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr); return outputRoot;
}
