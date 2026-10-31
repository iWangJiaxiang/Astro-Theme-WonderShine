import { vditorRoot } from '../../server/vendor.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as reservePort } from 'node:net';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../../server/app.ts';
import { LocalRepository } from '../../server/repository.ts';
import { FileState } from '../../server/state.ts';
import { hashPassword } from '../../server/password.ts';

// Manual browser checks use disposable content and a separate loopback-only API/Vite instance.
// The default password is only for this temporary local fixture; override it with STUDIO_DELETE_FIXTURE_PASSWORD.
const studio = fileURLToPath(new URL('../../', import.meta.url));
const base = await mkdtemp(join(tmpdir(), 'studio-delete-'));
const site = join(base, 'site');
let backend, vite;
async function put(path, text) { await mkdir(dirname(join(site, path)), { recursive: true }); await writeFile(join(site, path), text); }
const article = (title, body = 'Saved content.') => `+++\ntitle="${title}"\ndate=2026-10-01\ndraft=true\n+++\n${body}\n`;
const note = (title, id, extra = '') => `+++\ntitle="${title}"\ndate=2026-10-01\ndraft=true\n[extra]\nkind="note"\nid="${id}"\n${extra}\n+++\nSaved note.\n`;
try {
  await put('config.toml', 'title="Delete fixture"\nbase_url="https://example.com"\ndefault_language="zh-CN"\n[languages.en]\n');
  await put('data.toml', '[post]\ntags=[]\ncategories=[]\n');
  await put('content/articles/example/index.md', article('Example deletion'));
  await put('content/articles/example/index.en.md', article('Example English'));
  await put('content/articles/example/cover.png', 'asset-to-retain');
  await put('content/articles/referenced/index.md', article('Referenced article'));
  await put('content/articles/stale/index.md', article('Stale article'));
  await put('content/notes/n_reference/index.md', note('Reference note', 'n_reference', 'references=[{kind="internal",path="articles/referenced/index.md"}]'));
  await put('content/notes/n_delete/index.md', note('Delete this note', 'n_delete'));
  await put('content/notes/n_delete/index.en.md', note('Keep English note', 'n_delete'));
  await put('content/notes/n_delete/photo.png', 'note-asset-to-retain');
  const reservation = reservePort();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`, password = process.env.STUDIO_DELETE_FIXTURE_PASSWORD || 'delete-fixture-only-local';
  const app = createApp({ config: { origin, secureCookies: false, sessionSecret: randomBytes(32).toString('hex'), sessionSeconds: 3600, username: 'owner', passwordHash: await hashPassword(password) }, repository: new LocalRepository(site), state: new FileState(join(base, 'state')) });
  app.get('/vendor/vditor/*', serveStatic({ root: vditorRoot, rewriteRequestPath: path => path.replace('/vendor/vditor', '') }));
  backend = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise(resolve => backend.listening ? resolve() : backend.once('listening', resolve));
  vite = await createViteServer({ root: studio, cacheDir: join(base, 'vite-cache'), server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${backend.address().port}`, '/vendor': `http://127.0.0.1:${backend.address().port}` } } });
  await vite.listen();
  console.log(JSON.stringify({ origin, site, username: 'owner' }));
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
} finally {
  await vite?.close();
  if (backend) await new Promise(resolve => backend.close(resolve));
  await rm(base, { recursive: true, force: true });
}
