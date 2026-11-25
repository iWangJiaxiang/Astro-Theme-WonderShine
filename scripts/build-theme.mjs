import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { buildThemeCss } from './build-theme-css.mjs';
// Remove only generated output so previous builds cannot leak files into npm packs.
await rm('packages/theme/dist', {recursive:true, force:true});
await rm('packages/theme/assets/dist', {recursive:true, force:true});
await mkdir('packages/theme/dist', {recursive:true});
await build({absWorkingDir:process.cwd(),entryPoints:['packages/theme/scripts/astro-assets.ts'],outfile:'packages/theme/dist/assets.mjs',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
await mkdir('packages/theme/assets/dist/css', {recursive:true});
try {
  buildThemeCss();
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode ?? 1);
}
