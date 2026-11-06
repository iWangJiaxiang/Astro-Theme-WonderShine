import { vditorRoot } from './vendor.js';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { loadStartupConfig } from './startup.js';
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
// Vite serves source through /@fs as well as its configured root/publicDir.
// Do not widen Vite's allowlist for optional preview persistence.
const options = loadStartupConfig(vite.config.server.fs.strict ? { servingRoots: [vite.config.root, ...vite.config.server.fs.allow,
  ...(vite.config.publicDir ? [vite.config.publicDir] : []), vditorRoot] } : undefined);
const app = new Hono();
app.route('/', createApp(options));
app.get('/vendor/vditor/*', serveStatic({ root: vditorRoot, rewriteRequestPath: path => path.replace('/vendor/vditor', '') }));
const listener = getRequestListener(app.fetch);
const port = Number(new URL(options.config.origin).port || 5173);
createHttpServer((req, res) => {
  if (req.url?.startsWith('/api/') || req.url?.startsWith('/vendor/vditor/')) void listener(req, res);
  else vite.middlewares(req, res);
}).listen(port, '127.0.0.1', () => console.log(`Creator Studio: ${options.config.origin}`));
