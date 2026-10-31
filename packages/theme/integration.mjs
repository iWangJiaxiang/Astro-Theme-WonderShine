import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { assetSourceDirectories, isSiteInput, prepareAssets, siteConfigurationFiles } from './dist/assets.mjs';

/** Theme assets and routes are package-owned; authored files always remain in siteRoot. */
export default function wondershine(options = {}) {
  let root, files, user, publicDir, timer, closed = false, refresh = Promise.resolve();
  return { name: '@wondershine/theme', hooks: {
    'astro:config:setup': async ({ config, command, updateConfig, addWatchFile, injectRoute }) => {
      root = path.resolve(options.siteRoot || process.env.ASTRO_SITE_ROOT || fileURLToPath(config.root));
      user = parse(await fs.readFile(path.join(root, 'config.toml'), 'utf8'));
      process.env.ASTRO_SITE_ROOT = root;
      const output = path.resolve(process.env.ASTRO_OUT_DIR || fileURLToPath(config.outDir));
      const identity = createHash('sha256').update(root + '\0' + output).digest('hex').slice(0, 16);
      publicDir = path.join(root, '.astro-assets', identity, command);
      process.env.ASTRO_IMAGE_MANIFEST_PATH = path.join(publicDir, '_images/manifest.json');
      files = siteConfigurationFiles(root, user.extra?.i18n?.catalog_path);
      updateConfig({ site: process.env.ASTRO_SITE_URL || user.base_url, output: 'static', trailingSlash: 'ignore',
        publicDir: pathToFileURL(publicDir + path.sep), outDir: pathToFileURL(output + path.sep),
        devToolbar: { enabled: false }, vite: { server: { fs: { allow: [root, fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(config.root)] },
          watch: { ignored: ['**/.astro-assets/**'] } } } });
      for (const file of files) addWatchFile(file);
      for (const [pattern, component] of [['/[...path]', '[...path].astro'], ['/[...feed].xml', '[...feed].xml.ts'],
        ['/[...alias].html', '[...alias].html.ts'], ['/sitemap.xml', 'sitemap.xml.ts'], ['/robots.txt', 'robots.txt.ts'], ['/404', '404.astro']]) {
        injectRoute({ pattern, entrypoint: fileURLToPath(new URL('./src/pages/' + component, import.meta.url)), prerender: true });
      }
      if (command === 'dev' || command === 'build') await prepareAssets(root, publicDir);
    },
    'astro:server:setup': ({ server, logger }) => {
      closed = false;
      server.watcher.add([path.join(root, 'content'), ...assetSourceDirectories(root), ...files,
        ...['data.toml', '_headers', '_redirects', ...Object.keys(user.languages || {}).map(lang => 'data.' + lang + '.toml')].map(file => path.join(root, file))]);
      server.watcher.on('all', (event, file) => {
        if (closed || files.includes(path.resolve(file)) || !['add','change','unlink','addDir','unlinkDir'].includes(event) || !isSiteInput(file, root, user.extra?.i18n?.catalog_path)) return;
        clearTimeout(timer);
        timer = setTimeout(() => { refresh = refresh.then(async () => {
          if (closed) return;
          await prepareAssets(root, publicDir);
          if (!closed) await server.restart();
        }).catch(error => logger.error('Content reload failed: ' + error.message)); }, 150);
      });
    },
    'astro:server:done': () => { closed = true; clearTimeout(timer); },
  } };
}
