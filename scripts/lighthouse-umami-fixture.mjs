import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

// Use the stock SDK with a loopback collector. No measurement leaves the CI runner.
export async function startUmamiFixture() {
  const source = await fetch('https://raw.githubusercontent.com/umami-software/umami/60eaaaff60a38efb3c779a250742187ec9201944/src/tracker/index.js');
  if (!source.ok) throw new Error('Cannot fetch the pinned Umami tracker');
  const raw = await source.text();
  if (createHash('sha256').update(raw).digest('hex') !== 'd8ad18b76f6c60794b3ec118cea2ab6d4dde5372dfbf2d55b0ec47d6b8b10540') {
    throw new Error('Unexpected Umami tracker checksum');
  }
  const js = raw.replace('__COLLECT_API_HOST__', '').replace('__COLLECT_API_ENDPOINT__', '/api/send');
  const visits = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/script.js') {
      res.writeHead(200, { 'Content-Type':'text/javascript' }).end(js);
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4399');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-umami-cache');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.url !== '/api/send' || req.method !== 'POST') return res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const event = JSON.parse(body);
    if (!event.payload.name) visits.push(new URL(event.payload.url).pathname);
    res.writeHead(200, { 'Content-Type':'application/json' }).end('{}');
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(4400, '127.0.0.1', resolve));
  return { server, visits };
}
