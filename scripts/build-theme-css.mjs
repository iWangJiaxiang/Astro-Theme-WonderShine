import { spawnSync } from 'node:child_process';

export function buildThemeCss(run = spawnSync) {
  for (const name of ['base','fancybox','global','index','post','about','archive','equipment','friend','collection','taxonomy','wechat','404-page']) {
    const result = run(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs','-i','packages/theme/styles/'+name+'.css','-o','packages/theme/assets/dist/css/'+(name==='404-page'?'404':name)+'.css','--minify'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      const reason = result.error?.message ?? (result.signal ? `terminated by ${result.signal}` : `exited with status ${result.status}`);
      const error = new Error(`CSS build failed for ${name}: ${reason}`, { cause: result.error });
      error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
      throw error;
    }
  }
}
