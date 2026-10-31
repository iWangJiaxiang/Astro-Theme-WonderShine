import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('packages/theme/dist', {recursive:true});
await build({absWorkingDir:process.cwd(),entryPoints:['packages/theme/scripts/astro-assets.ts'],outfile:'packages/theme/dist/assets.mjs',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
await mkdir('packages/theme/assets/dist/css', {recursive:true});
for(const name of ['global','index','post','about','archive','equipment','friend','collection','taxonomy','wechat','404-page']) {
  const result=spawnSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','packages/theme/styles/'+name+'.css','-o','packages/theme/assets/dist/css/'+(name==='404-page'?'404':name)+'.css','--minify'],{stdio:'inherit'});
  if(result.status)process.exit(result.status);
}
