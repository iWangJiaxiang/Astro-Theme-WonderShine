import { cp, mkdir, readFile, readdir, realpath, lstat, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { patchToml, removeTomlFields, splitDocument } from '../apps/studio/server/content.js';

export async function migrateSite(sourcePath: string, destinationPath: string, themeArchive: string, headingAliases?: string) {
  const source = await realpath(sourcePath), destination = resolve(destinationPath);
  const parent = await realpath(dirname(destination));
  if (destination === source || (join(parent, destination.split('/').at(-1)!) + '/').startsWith(source + '/')) throw new Error('Choose a new directory outside the source site.');
  await readFile(join(source, 'config.toml'), 'utf8');
  await lstat(join(source, 'content'));
  const archive = await realpath(themeArchive);
  await mkdir(destination); // Exclusive creation: an existing site is never overwritten.
  const copy = async (from: string, to: string) => cp(from, to, { recursive: true, filter: async file => !(await lstat(file)).isSymbolicLink() && !relative(source,file).split('/').some(part => part.startsWith('.') || part === 'node_modules') && !/^(?:static|public)\/(?:admin|admin-sveltia)(?:\/|$)/.test(relative(source,file)) });
  await copy(join(source, 'content'), join(destination, 'content'));
  for (const file of await readdir(source)) if (/^data(?:\.[\w-]+)?\.toml$/.test(file)) await copy(join(source, file), join(destination, file));
  for (const dir of ['static', 'public']) {
    try { const stat = await lstat(join(source, dir)); if (stat.isDirectory()) await copy(join(source, dir), join(destination, 'public')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let config = removeTomlFields(await readFile(join(source, 'config.toml'), 'utf8'), ['theme', 'compile_sass', 'build_search_index', 'minify_html']);
  await writeFile(join(destination, 'config.toml'), config);
  let documents = 0;
  async function convert(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) await convert(file);
      else if (item.name.endsWith('.md')) {
        const text = await readFile(file, 'utf8'), doc = splitDocument(text), meta = parse(doc.header);
        const changes: Record<string, string> = {};
        for (const [oldKey, newKey] of [['template', 'layout'], ['page_template', 'child_layout']]) {
          if (typeof meta[oldKey] === 'string' && !meta[newKey]) changes[newKey] = String(meta[oldKey]).replace(/^page\//, '').replace(/\.html$/, '');
        }
        await writeFile(file, '+++\n' + patchToml(removeTomlFields(doc.header, ['template', 'page_template']), changes) + '\n+++\n' + doc.body);
        documents++;
      }
    }
  }
  await convert(join(destination, 'content'));
  if (headingAliases) {
    const text = await readFile(headingAliases, 'utf8'); JSON.parse(text);
    await mkdir(join(destination, 'compatibility'), { recursive: true });
    await writeFile(join(destination, 'compatibility/heading-aliases.json'), text);
  }
  await writeFile(join(destination, 'package.json'), JSON.stringify({ name: 'wondershine-site', private: true, type: 'module', scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' }, dependencies: { '@wondershine/theme': 'file:' + archive, astro: '7.4.4' } }, null, 2) + '\n');
  await writeFile(join(destination, 'astro.config.mjs'), "import { defineConfig } from 'astro/config';\nimport wondershine from '@wondershine/theme';\nexport default defineConfig({integrations:[wondershine()]});\n");
  await writeFile(join(destination, '.gitignore'), 'node_modules/\ndist/\n.astro/\n.astro-assets/\n.studio-history/\n.env*\n');
  return { documents, destination };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((items, value, index, args) => index % 2 ? items : [...items, [value, args[index + 1]]], []));
  if (!values['--source'] || !values['--destination'] || !values['--theme']) throw new Error('Usage: npm run migrate:site -- --source OLD_SITE --destination NEW_SITE --theme THEME.tgz [--heading-aliases FILE.json]');
  console.log(JSON.stringify(await migrateSite(values['--source'], values['--destination'], values['--theme'], values['--heading-aliases']), null, 2));
}
