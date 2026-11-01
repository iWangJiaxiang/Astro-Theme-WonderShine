import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Remote diagnostic only. Does not modify site content or performance settings.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'examples/demo');
const device = process.env.AUDIT_DEVICE || 'mobile';
if (!['mobile', 'desktop'].includes(device)) throw new Error('Unsupported audit device');
const output = path.join(root, 'temp/lighthouse', device);
await mkdir(output, { recursive: true });
const requireSite = createRequire(path.join(site, 'package.json'));
const astro = path.join(path.dirname(requireSite.resolve('astro/package.json')), 'bin/astro.mjs');
const origin = 'http://127.0.0.1:4399';
const pages = [
  ['home', '/'], ['article', '/articles/welcome/'], ['timeline', '/timeline/'],
  ['collection', '/collections/field-notes/'], ['chinese-home', '/zh-CN/'],
];
const preview = spawn(process.execPath, [astro, 'preview', '--root', site, '--host', '127.0.0.1', '--port', '4399'], { cwd: site, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '', serverError;
preview.stdout.on('data', data => { serverLog += data; });
preview.stderr.on('data', data => { serverLog += data; });
preview.on('error', error => { serverError = error; });
let current;
async function run(args) {
  await new Promise((resolve, reject) => {
    current = spawn('npx', ['--yes', 'lighthouse@13.6.0', ...args], { cwd: root, stdio: 'inherit' });
    current.on('error', reject);
    current.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Lighthouse exited ${code || signal}`)));
  });
  current = undefined;
}
const metricIds = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'];
const results = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (serverError) throw serverError;
    if (preview.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Preview is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Preview did not become ready: ' + serverLog);
  for (const [name, route] of pages) {
    const response = await fetch(origin + route);
    if (!response.ok) throw new Error(`Audit page ${route}: HTTP ${response.status}`);
    const runs = [];
    for (let repeat = 1; repeat <= 3; repeat++) {
      const basename = path.join(output, `${name}-${repeat}`);
      console.log(`Audit ${device} ${route}, run ${repeat}/3`);
      await run([origin + route, '--output=json', '--output=html', `--output-path=${basename}`,
        '--only-categories=performance,accessibility,best-practices,seo', '--chrome-flags=--headless --disable-dev-shm-usage',
        '--quiet', ...(device === 'desktop' ? ['--preset=desktop'] : [])]);
      const report = JSON.parse(await readFile(basename + '.report.json', 'utf8'));
      if (report.runtimeError) throw new Error(JSON.stringify(report.runtimeError));
      const categories = Object.fromEntries(Object.entries(report.categories).map(([key, value]) => [key, value.score === null ? null : Math.round(value.score * 100)]));
      if (Object.values(categories).some(value => value === null)) throw new Error(`Incomplete categories for ${name}`);
      runs.push({ file: path.basename(basename) + '.report.html', categories,
        lighthouseVersion: report.lighthouseVersion, userAgent: report.userAgent, configSettings: report.configSettings,
        metrics: Object.fromEntries(metricIds.map(id => [id, { value: report.audits[id]?.numericValue, display: report.audits[id]?.displayValue }])),
        findings: Object.values(report.audits).filter(audit => audit.score !== null && audit.score < 1).map(audit => ({
          id: audit.id, title: audit.title, score: audit.score, display: audit.displayValue,
          details: JSON.stringify(audit.details?.items?.slice(0, 5) || []).slice(0, 6000),
        })), warnings: report.runWarnings,
      });
    }
    const ordered = [...runs].sort((a, b) => a.categories.performance - b.categories.performance);
    results.push({ name, route, performanceRange: [ordered[0].categories.performance, ordered[2].categories.performance],
      allScores: runs.map(run => run.categories), representative: ordered[1] });
    await writeFile(path.join(output, 'summary.json'), JSON.stringify({ source: process.env.GITHUB_SHA, device, fixture: 'theme-demo',
      limitations: 'Production-built fictional demo on Astro preview, not the personal blog or CDN. Default Lighthouse simulated throttling. Three fresh Chrome runs; representative is median performance score.', results }, null, 2));
  }
  const rows = results.map(({ name, performanceRange, representative: run }) => `| ${name} | ${run.categories.performance} (${performanceRange.join('–')}) | ${run.categories.accessibility} | ${run.categories['best-practices']} | ${run.categories.seo} | ${run.metrics['largest-contentful-paint'].display} | ${run.metrics['total-blocking-time'].display} | ${run.metrics['cumulative-layout-shift'].display} |`);
  await writeFile(path.join(output, 'summary.md'), `# Lighthouse ${device}\n\nTheme demo production preview. Median performance run of three; not a deployed personal-site score.\n\n| Page | Performance (range) | Accessibility | Best practices | SEO | LCP | TBT | CLS |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n`);
} finally {
  current?.kill('SIGTERM');
  preview.kill('SIGTERM');
}
