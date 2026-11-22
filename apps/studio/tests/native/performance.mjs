import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const output = resolve('temp/studio-native-performance');
const packages = resolve('temp/studio-performance-packages');
const webdriver = 'http://127.0.0.1:9515';
const workspaceId = '0db26f9a-a18e-4e71-9a15-3bf4100f9f7e';
const profile = { id: workspaceId, label: 'Performance fixture', provider: 'generic',
  url: 'https://example.invalid/blog.git', branch: 'main', username: 'fixture',
  authorName: 'Fixture', authorEmail: 'fixture@example.invalid' };
const fixture = { articles: 300, threads: 180, images: 384 };
const runs = process.env.STUDIO_PERFORMANCE_RUNS?.split(',') || [];
assert.ok(runs.length >= 1 && runs.length <= 2 && runs.every(run => /^[0-9]+$/.test(run)));
await mkdir(output, { recursive: true });

async function command(method, path, body) {
  const response = await fetch(webdriver + path, {
    method, signal: AbortSignal.timeout(90_000),
    ...(body && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const { value } = await response.json();
  if (!response.ok) throw new Error(path + ': ' + (value?.message || response.status));
  return value;
}

function procStat(pid) {
  const line = readFileSync('/proc/' + pid + '/stat', 'utf8');
  return line.slice(line.lastIndexOf(') ') + 2).split(' ');
}

const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
function sampleProcesses(binary) {
  const samples = [];
  let rootPid;
  const started = Date.now();
  const timer = setInterval(() => {
    const at = Date.now();
    const stats = new Map();
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const fields = procStat(pid);
        if (!rootPid && readlinkSync('/proc/' + pid + '/exe') === binary) rootPid = pid;
        stats.set(pid, fields);
      } catch { /* A process can exit between listing and reading. */ }
    }
    if (!rootPid || !stats.has(rootPid)) return;
    const app = new Set([rootPid]);
    for (let count = 0; count !== app.size;) {
      count = app.size;
      for (const [pid, fields] of stats) if (app.has(fields[1])) app.add(pid);
    }
    const processes = [];
    for (const pid of app) {
      const fields = stats.get(pid);
      try {
        const pss = Number(/^Pss:\s+(\d+)/m.exec(readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8'))?.[1]);
        if (Number.isFinite(pss)) processes.push({ pid, cpuMs: (Number(fields[11]) + Number(fields[12])) / ticks * 1000, pssKiB: pss });
      } catch { /* WebKit may replace child processes between samples. */ }
    }
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    samples.push({ at, processes, launchAt: at - uptime * 1000 + Number(stats.get(rootPid)[19]) / ticks * 1000 });
  }, 200);
  return {
    samples,
    get launchAt() { return samples[0]?.launchAt ?? started; },
    stop() { clearInterval(timer); },
  };
}

function cpuBetween(previous, current) {
  return current.processes.reduce((sum, process) => {
    const before = previous.processes.find(entry => entry.pid === process.pid);
    return sum + Math.max(0, process.cpuMs - (before?.cpuMs ?? 0));
  }, 0);
}
function usage(samples) {
  const intervals = samples.slice(1).map((sample, index) => ({
    ms: sample.at - samples[index].at, cpuMs: cpuBetween(samples[index], sample),
  }));
  const pss = samples.map(sample => sample.processes.reduce((sum, process) => sum + process.pssKiB, 0) / 1024);
  return {
    cpuMs: Math.round(intervals.reduce((sum, value) => sum + value.cpuMs, 0)),
    meanCpuPercentOfCore: Math.round(100 * intervals.reduce((sum, value) => sum + value.cpuMs, 0) /
      Math.max(1, intervals.reduce((sum, value) => sum + value.ms, 0))),
    peakCpuPercentOfCore: Math.round(Math.max(0, ...intervals.map(value => 100 * value.cpuMs / value.ms))),
    peakPssMiB: Math.round(Math.max(0, ...pss)),
  };
}

const imageDirectory = join(output, '../studio-performance-images');
await mkdir(imageDirectory, { recursive: true });
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1600x1000:rate=10',
  '-frames:v', '12', '-threads', '1', '-q:v', '3', join(imageDirectory, '%02d.jpg')]);
const executableStat = packagePath => join(packagePath, 'app/usr/bin/wondershine-studio');
async function seed(data) {
  const root = join(data, 'wang.jiaxiang.wondershine-studio/workspaces', workspaceId, 'repo');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.toml'), 'title="Studio performance fixture"\nbase_url="https://example.invalid"\ndefault_language="zh-CN"\n');
  await writeFile(join(root, 'data.toml'), '');
  for (const [kind, count] of [['articles', fixture.articles], ['threads', fixture.threads]]) {
    await mkdir(join(root, 'content', kind), { recursive: true });
    for (let index = 0; index < count; index++) {
      const name = 'Core ' + (kind === 'articles' ? 'article' : 'thread') + ' ' + String(index).padStart(3, '0');
      const directory = join(root, 'content', kind, String(index).padStart(3, '0'));
      await mkdir(directory);
      const body = kind === 'articles' ? ('## Fixture heading\n\nA deterministic article for the native editor. **Formatted text**.\n\n').repeat(24)
        : 'A deterministic thread for reading and navigation.\n';
      await writeFile(join(directory, 'index.md'), '+++\ntitle="' + name + '"\ndate="2026-11-20T10:00:00+08:00"\ndraft=true\n+++\n' + body);
    }
  }
  for (let index = 0; index < fixture.images; index++) {
    const directory = join(root, 'public/photos', String(Math.floor(index / 16)).padStart(2, '0'));
    await mkdir(directory, { recursive: true });
    await copyFile(join(imageDirectory, String(index % 12 + 1).padStart(2, '0') + '.jpg'),
      join(directory, String(index).padStart(3, '0') + '.jpg'));
  }
  git('init', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Seed isolated fixture');
  git('remote', 'add', 'origin', profile.url);
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
  return root;
}

// Executed in the installed App's WebKit. Completion is sampled on render frames.
function observe() {
  const frameGaps = [];
  const failedImages = [];
  const nativeRequests = {};
  const run = { frameGaps, metrics: [], nativeRequests, failedImages, activeStep: 'connection-visible' };
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = (resource, options) => {
    const match = typeof resource === 'string' && /^ipc:\/\/localhost\/([\w%|-]+)$/.exec(resource);
    if (!match) return fetchOriginal(resource, options);
    const commands = nativeRequests[run.activeStep] ??= {};
    const command = decodeURIComponent(match[1]);
    const entry = commands[command] ??= { count: 0, totalMs: 0, rejected: 0 };
    const start = performance.now();
    entry.count++;
    return fetchOriginal(resource, options).then(response => {
      entry.totalMs += Math.round(performance.now() - start);
      return response;
    }, error => {
      entry.rejected++;
      throw error;
    });
  };
  window.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.closest('.media-card')) return;
    const url = image.currentSrc || image.src;
    const entry = { path: image.closest('.media-card').dataset.mediaPath,
      at: performance.timeOrigin + performance.now(), source: new URL(url).protocol };
    failedImages.push(entry);
    if (entry.source === 'blob:') {
      void fetchOriginal(url).then(response => response.arrayBuffer()).then(
        bytes => { entry.blobBytes = bytes.byteLength; },
        error => { entry.blobReadError = error.name; },
      );
    }
  }, true);
  let previous = performance.now();
  function frame(at) {
    const interval = at - previous;
    if (interval >= 50) frameGaps.push({ at: performance.timeOrigin + previous, ms: Math.round(interval) });
    previous = at;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.studioPerformance = run;
  return {
    at: performance.timeOrigin + performance.now(),
    navigationAt: performance.timeOrigin,
    paints: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, ms: Math.round(entry.startTime) })),
  };
}

function measure({ name, action, target, targetText, ready, readyText }, done) {
  const all = selector => [...document.querySelectorAll(selector)];
  const visible = node => {
    const bounds = node.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && getComputedStyle(node).visibility === 'visible'
      && !node.closest('[inert], [hidden]');
  };
  const find = (selector, text) => all(selector).find(node => visible(node) && !node.disabled && (!text || node.textContent.trim() === text));
  const started = performance.now();
  window.studioPerformance.activeStep = name;
  const deadline = started + 60_000;
  let clicked = !action;
  let trigger = started;
  function render() {
    try {
      if (!clicked) {
        const node = find(target, targetText);
        if (node) {
          trigger = performance.now();
          if (action === 'type') {
            node.focus();
            node.setSelectionRange(node.value.length, node.value.length);
            document.execCommand('insertText', false, '\nCore Flow edit.\n');
          } else if (action === 'scroll') {
            window.scrollBy({ top: node.clientHeight, behavior: 'smooth' });
          } else node.click();
          clicked = true;
        }
      }
      let complete;
      let failedPaths;
      if (ready === 'first-image') complete = all('.media-card img').some(image => image.complete && image.naturalWidth > 0);
      else if (ready === 'visible-images') {
        const tiles = all('.media-card').filter(tile => {
          const bounds = tile.getBoundingClientRect();
          return bounds.bottom > 0 && bounds.top < innerHeight;
        });
        failedPaths = tiles.filter(tile => tile.closest('.media-error-item')).map(tile => tile.dataset.mediaPath);
        complete = tiles.length > 0 && tiles.every(tile => {
          const image = tile.querySelector('img');
          return tile.closest('.media-error-item') || (image?.complete && image.naturalWidth > 0);
        });
      } else if (ready === 'original-image') {
        const image = document.querySelector('.media-details[open] img');
        complete = image?.complete && image.naturalWidth > 0;
      } else if (ready === 'dialog-closed') complete = !document.querySelector('.media-details[open]');
      else if (ready === 'typed') complete = document.querySelector(target)?.value.includes('Core Flow edit.');
      else if (ready === 'scrolled') complete = window.scrollY >= 120 && performance.now() - trigger >= 350;
      else complete = find(ready, readyText);
      if (clicked && complete) {
        requestAnimationFrame(() => {
          const at = performance.now();
          const result = { name, at: performance.timeOrigin + trigger, ms: Math.round(at - trigger),
            totalMs: Math.round(at - started), ...(failedPaths?.length && { failedPaths }) };
          window.studioPerformance.metrics.push(result);
          done(result);
        });
        return;
      }
      if (performance.now() > deadline) {
        done({ error: name + ': ' + document.body.innerText.trim().slice(0, 950) });
        return;
      }
      requestAnimationFrame(render);
    } catch (error) { done({ error: name + ': ' + error }); }
  }
  requestAnimationFrame(render);
}

const firstRun = [
  ['workspace-open', { action: 'click', target: '.native-connect button[type=submit]', ready: 'main h1', readyText: '今天，写点什么？' }],
  ['dashboard-articles', { ready: 'main .content-row' }],
  ['article-list', { action: 'click', target: '#studio-navigation button', targetText: '文章', ready: '.content-library .content-row' }],
  ['article-open', { action: 'click', target: '.content-library .content-row', ready: '.markdown-source' }],
  ['rich-editor', { action: 'click', target: '.editor-tabs button', targetText: '可视化编辑', ready: '.vditor-ir [contenteditable=true]' }],
  ['source-editor', { action: 'click', target: '.editor-tabs button', targetText: 'Markdown 源码', ready: '.markdown-source' }],
  ['editor-input', { action: 'type', target: '.markdown-source', ready: 'typed' }],
  ['editor-save', { action: 'click', target: '.editor-save-actions button.save-button-main', ready: '.notice.success' }],
  ['thread-list', { action: 'click', target: '#studio-navigation button', targetText: '动态', ready: 'main .content-row' }],
  ['thread-detail', { action: 'click', target: 'main .content-row', ready: '.thread-reading-card' }],
  ['media-list', { action: 'click', target: '#studio-navigation button', targetText: '媒体库', ready: '.media-card' }],
  ['media-first-image', { ready: 'first-image' }],
  ['media-viewport', { ready: 'visible-images' }],
  ['media-preview', { action: 'click', target: '.media-card', ready: 'original-image' }],
  ['media-preview-close', { action: 'click', target: '.media-details[open] .media-details-close', ready: 'dialog-closed' }],
  ['media-scroll', { action: 'scroll', target: '.media-library', ready: 'scrolled' }],
  ['workspace-status', { action: 'click', target: '#studio-navigation button', targetText: '工作区同步', ready: '.workspace-status-grid' }],
];

const processes = [];
function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

async function session(binary, kind, tag, body) {
  const sampler = kind === 'seed' ? undefined : sampleProcesses(binary);
  const video = kind === 'seed' ? null : spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0',
    '-framerate', '30', '-video_size', '1440x1000', '-i', process.env.DISPLAY, '-threads', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', join(output, tag + '.mp4')], { stdio: 'inherit' });
  const videoAt = Date.now();
  let sid;
  try {
    const { sessionId } = await command('POST', '/session', { capabilities: { alwaysMatch: {
      'webkitgtk:browserOptions': { binary },
    } } });
    sid = '/session/' + sessionId;
    await command('POST', sid + '/timeouts', { script: 65_000 });
    const call = (fn, ...args) => command('POST', sid + '/execute/sync', { script: 'return (' + fn + ')(...arguments)', args });
    async function step(name, input) {
      const result = await command('POST', sid + '/execute/async', { script: '(' + measure + ')(...arguments)', args: [{ name, ...input }] });
      assert.ok(!result.error, result.error);
      console.log(tag, name, result.ms + ' ms');
      return result;
    }
    try {
      await call(observe);
      const startup = await step('connection-visible', { ready: '.native-connect h1' });
      const result = await body({ call, step, sid });
      const page = await call(() => ({
        ...window.studioPerformance,
        navigationAt: performance.timeOrigin,
        paints: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, ms: Math.round(entry.startTime) })),
        loadDiagnostics: JSON.parse(localStorage.getItem('wondershine.native.load-diagnostics.v1') || 'null'),
      }));
      if (!sampler) return result;
      assert.ok(sampler.samples.length >= 2, 'No App process tree samples');
      const launchAt = sampler.launchAt;
      const data = { startupMs: Math.round(startup.at + startup.ms - launchAt), startupReadyAt: startup.at + startup.ms,
        launchAt, videoAt, ...page, resourceUsage: usage(sampler.samples), samples: sampler.samples };
      await writeFile(join(output, tag + '.json'), JSON.stringify(data, null, 2));
      return data;
    } catch (error) {
      await command('GET', sid + '/screenshot').then(data =>
        writeFile(join(output, tag + '-failure.png'), Buffer.from(data, 'base64'))).catch(() => {});
      throw error;
    }
  } finally {
    sampler?.stop();
    if (video) await stop(video, 'SIGINT');
    if (sid) await command('DELETE', sid).catch(error => console.error(error));
  }
}

const versions = [];
for (const run of runs) {
  const directory = join(packages, run);
  const pkg = JSON.parse(await readFile(join(directory, 'linux-x64.json'), 'utf8'));
  const binary = executableStat(directory);
  versions.push({ run, sha: pkg.source, binary, sha256: createHash('sha256').update(await readFile(binary)).digest('hex') });
}
const results = [];
await writeFile(join(output, 'environment.json'), JSON.stringify({
  versions, fixture, os: release(), logicalCores: availableParallelism(), cpu: cpus()[0]?.model,
  webkit: execFileSync('dpkg-query', ['-W', '-f=${Version}', 'libwebkit2gtk-4.1-0'], { encoding: 'utf8' }),
  desktop: { width: 1440, height: 1000, videoFramesPerSecond: 30 },
}, null, 2));

try {
  for (let repeat = 0; repeat < 3; repeat++) {
    const order = repeat % 2 ? [...versions].reverse() : versions;
    for (const { run, binary } of order) {
      const data = join(output, '../studio-performance-fixture', run + '-' + repeat);
      const root = await seed(data);
      const driver = spawn('WebKitWebDriver', ['--port=9515'], { stdio: 'inherit', env: {
        ...process.env, TAURI_WEBVIEW_AUTOMATION: 'true', XDG_DATA_HOME: data, XDG_CACHE_HOME: join(data, 'cache'),
        XDG_CONFIG_HOME: join(data, 'config'), XDG_STATE_HOME: join(data, 'state'),
      } });
      processes.push(driver);
      try {
        for (let retry = 0; ; retry++) {
          try { await command('GET', '/status'); break; }
          catch (error) { if (retry >= 50 || driver.exitCode !== null) throw error; await delay(100); }
        }
        await session(binary, 'seed', run + '-seed-' + repeat, async ({ call }) => {
          await call(item => {
            localStorage.setItem('wondershine.native.workspaces.v1', JSON.stringify([item]));
            localStorage.setItem('studio-language', 'zh-CN');
          }, profile);
        });
        const cold = await session(binary, 'cold', run + '-cold-' + repeat, async ({ call, step, sid }) => {
          await step('select-workspace', { action: 'click', target: '.workspace-record button', targetText: '选择工作区', ready: '.native-connect button[type=submit]' });
          for (const [name, input] of firstRun) await step(name, input);
          const document = readdirSync(join(root, 'content/articles')).flatMap(directory => {
            const file = join(root, 'content/articles', directory, 'index.md');
            return readFileSync(file, 'utf8').includes('Core Flow edit.') ? [file] : [];
          });
          assert.equal(document.length, 1, 'The editor did not write the fixture article');
          await command('POST', sid + '/window/rect', { width: 650, height: 900 });
          await step('more-page', { action: 'click', target: '.mobile-tabbar button[data-destination=more]', ready: 'main h1', readyText: '更多' });
          await call(() => window.scrollTo(0, 0));
        });
        const warm = await session(binary, 'warm', run + '-warm-' + repeat, async ({ step }) => {
          await step('select-workspace', { action: 'click', target: '.workspace-record button', targetText: '选择工作区', ready: '.native-connect button[type=submit]' });
          for (const [name, input] of firstRun.filter(([name]) => ['workspace-open', 'dashboard-articles',
            'media-list', 'media-first-image', 'media-viewport', 'media-preview', 'media-preview-close'].includes(name))) await step(name, input);
        });
        results.push({ run, repeat, cold: [cold.startupMs, cold.resourceUsage], warm: [warm.startupMs, warm.resourceUsage] });
        await writeFile(join(output, 'runs.json'), JSON.stringify(results, null, 2));
      } finally {
        await stop(driver);
        await rm(data, { recursive: true, force: true });
      }
    }
  }
} finally {
  for (const child of processes) await stop(child);
}
