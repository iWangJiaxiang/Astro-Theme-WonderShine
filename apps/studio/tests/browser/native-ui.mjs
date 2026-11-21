import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { auditViewports } from './audit-viewports.mjs';
import { mobileGitFixture } from './mobile-git-fixture.mjs';

// Real production React/native adapter code; only the Tauri IPC host is mocked.
const studio = fileURLToPath(new URL('../../', import.meta.url));
const distribution = join(studio, 'dist/client');
const screenshots = join(studio, 'test-results/native-ui');
const base = await fs.mkdtemp(join(tmpdir(), 'studio-native-ui-'));
const appData = join(base, 'appdata');
const profile = { id: 'f6347560-bbe9-4c35-9d89-b0429108882b', label: '本地写作测试', provider: 'generic',
  url: 'https://git.example.test/ui-fixture.git', branch: 'main', username: 'fixture', authorName: '本地作者', authorEmail: 'fixture@example.com' };
const root = join(appData, 'workspaces', profile.id, 'repo');
const localRoot = join(base, 'selected local blog');
let selectedFolder = null, folderGranted = false;
let browser, server, page, mobile;
const errors = [], cspErrors = [], failedResources = [], ipcFailures = [];
const commands = new Set();
const reviewClaims = new Set();
let reviewEpoch;
const reviewRestart = '创作窗口已重新加载，请完全退出并重启应用后重新确认工作区';
let allowOAuthHttp = false, oauthApproved = false, oauthFailureStage = null;
let accountGate = Promise.resolve(), releaseAccount = () => {};
let allowCloneHttp = false, failNextHttp = false, failNextBranchWrite = false;
let releaseDownload = () => {}, releaseCheckout = () => {};
let downloadGate = Promise.resolve(), checkoutGate = Promise.resolve();
let writeGate = Promise.resolve(), releaseWrite = () => {};
const requests = new Map(), responses = new Map(), fileHandles = new Map();
let nextResource = 1, worktreeScans = 0, gitInspections = 0;
try {
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(screenshots, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git(['init', '-b', 'main']);
  await fs.mkdir(join(root, 'content/articles/example'), { recursive: true });
  await fs.mkdir(join(root, 'public/uploads'), { recursive: true });
  await fs.writeFile(join(root, 'config.toml'), 'title="Native UI fixture"\nbase_url="https://example.com"\ndefault_language="zh-CN"\ntaxonomies=[{name="tags"},{name="categories"}]\n[languages.en]\ntaxonomies=[{name="tags"},{name="categories"}]\n');
  await fs.writeFile(join(root, 'data.toml'), '[post]\ntags=[]\ncategories=[]\n');
  await fs.writeFile(join(root, 'content/articles/example/index.md'), '+++\ntitle="离线文章示例"\ndraft=true\ndate="2026-10-31"\n+++\nNative UI fixture.\n');
  await fs.writeFile(join(root, 'public/uploads/example.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==', 'base64'));
  // Enough distinct tracked objects to exercise pack work and multiple checkout batches.
  const assets = join(root, 'assets', 'git-fixture');
  await fs.mkdir(assets, { recursive: true });
  for (let index = 0; index < 128; index++) {
    await fs.writeFile(join(assets, index + '.txt'), ('Asset ' + index + '\n').repeat(512));
  }
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial']);
  git(['config', 'user.name', 'Folder writer']); git(['config', 'user.email', 'folder@example.test']);
  await fs.cp(root, localRoot, { recursive: true });
  execFileSync('git', ['clone', '--bare', root, join(base, 'remote.git')], {stdio:'pipe'});
  execFileSync('git', ['--git-dir=' + join(base, 'remote.git'), 'config', 'http.receivepack', 'true']);
  execFileSync('git', ['--git-dir=' + join(base, 'remote.git'), 'branch', 'release/blog', 'main']);
  execFileSync('git', ['--git-dir=' + join(base, 'remote.git'), 'symbolic-ref', 'HEAD', 'refs/heads/release/blog']);
  git(['remote', 'add', 'origin', profile.url]); git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
  const config = JSON.parse(await fs.readFile(join(studio, 'src-tauri/tauri.conf.json'), 'utf8'));
  const csp = config.app.security.csp;
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
  function confined(path) {
    const location = resolve(path);
    if (location !== appData && !location.startsWith(appData + sep) && !(folderGranted && (location === localRoot || location.startsWith(localRoot + sep)))) throw new Error('Fixture filesystem request escaped AppData');
    return location;
  }
  function fileInfo(stat) {
    return { size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink(),
      mtime: stat.mtime.toISOString(), atime: stat.atime.toISOString(), birthtime: stat.birthtime.toISOString(),
      readonly: false, fileAttributes: null, mode: stat.mode, dev: stat.dev, ino: stat.ino, nlink: stat.nlink,
      uid: stat.uid, gid: stat.gid, rdev: stat.rdev, blksize: stat.blksize, blocks: stat.blocks };
  }
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      let path;
      if (url.pathname.startsWith('/__asset/')) {
        path = confined(decodeURIComponent(url.pathname.slice('/__asset/'.length)));
        if (!path.startsWith(join(root, 'public') + sep) && !path.startsWith(join(root, 'content') + sep)) throw new Error('Asset escaped content roots');
      } else {
        path = resolve(distribution, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (path !== distribution && !path.startsWith(distribution + sep)) throw new Error('Invalid resource path');
      }
      const bytes = await fs.readFile(path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Content-Security-Policy': csp }); response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to an installed Chromium executable.');
  browser = await puppeteer.launch({ headless: true, executablePath });
  page = await browser.newPage();
  const loadedScripts = new Set();
  mobile = await mobileGitFixture(base, appData, studio);
  const runtimeChunks = (await fs.readdir(join(distribution, 'assets'))).filter(name => /^native-runtime-.*\.js$/.test(name));
  assert.ok(runtimeChunks.length > 0, 'Native runtime must be a separate on-demand chunk');
  page.on('request', request => { if (request.resourceType() === 'script') loadedScripts.add(new URL(request.url()).pathname.split('/').at(-1)); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) cspErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) failedResources.push(`${response.status()} ${response.url()}`); });
  let dismissNextDialog = false;
  page.on('dialog', dialog => { if (dismissNextDialog) { dismissNextDialog = false; void dialog.dismiss(); } else void dialog.accept(); });
  await page.setRequestInterception(true);
  page.on('request', request => request.url().startsWith(origin + '/') || request.url().startsWith('data:') || request.url().startsWith('blob:') ? request.continue() : request.abort());
  await page.exposeFunction('tauriInvoke', async (command, args, options) => {
    commands.add(command);
    try {
      let value;
      if (command === 'native_review_owner') {
        // Mirror the process-lifetime Rust IPC contract, not its OS lock implementation.
        assert.deepEqual(Object.keys(args).sort(), ['claimRecovery', 'epoch', 'workspaceId']);
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        assert.match(args.workspaceId, uuid); assert.match(args.epoch, uuid);
        assert.equal(typeof args.claimRecovery, 'boolean');
        if (reviewEpoch !== undefined && reviewEpoch !== args.epoch) throw new Error(reviewRestart);
        reviewEpoch ??= args.epoch;
        if (args.claimRecovery) {
          assert.ok(reviewClaims.size < 4096 || reviewClaims.has(args.workspaceId));
          value = !reviewClaims.has(args.workspaceId);
          reviewClaims.add(args.workspaceId);
        } else {
          assert.ok(reviewClaims.has(args.workspaceId), 'Review operations require a prior recovery claim');
          value = false;
        }
      } else if (command === 'plugin:dialog|open') { value = selectedFolder; folderGranted = !!value; }
      else if (command === 'plugin:path|resolve_directory') value = appData;
      else if (command === 'plugin:fs|write_file') {
        const path = confined(decodeURIComponent(options.headers.path));
        await writeGate;
        if (failNextBranchWrite && path.includes('/.git/objects/')) { throw new Error('Simulated branch write failure'); }
        if (path.includes('.clone-') && path.endsWith('/config.toml')) await checkoutGate;
        await fs.writeFile(path, new Uint8Array(args));
      } else if (command === 'plugin:fs|rename') await fs.rename(confined(args.oldPath), confined(args.newPath));
      else if (command === 'plugin:fs|open') {
        const path = confined(args.path);
        assert.ok(args.options.read || (args.options.write && args.options.createNew));
        const handle = await fs.open(path, args.options.createNew ? 'wx' : 'r', args.options.mode);
        value = nextResource++;
        fileHandles.set(value, handle);
      } else if (command === 'plugin:fs|read') {
        const buffer = Buffer.alloc(args.len + 8);
        const { bytesRead } = await fileHandles.get(args.rid).read(buffer, 0, args.len);
        // The plugin appends the byte count as a big-endian u64.
        buffer.writeBigUInt64BE(BigInt(bytesRead), bytesRead);
        value = Array.from(buffer.subarray(0, bytesRead + 8));
      } else if (command === 'plugin:fs|write') {
        const result = await fileHandles.get(args.rid).write(Buffer.from(args.data));
        value = result.bytesWritten;
      } else if (command === 'plugin:fs|fstat') {
        value = fileInfo(await fileHandles.get(args.rid).stat());
      } else if (command === 'plugin:resources|close' && fileHandles.has(args.rid)) {
        await fileHandles.get(args.rid).close();
        fileHandles.delete(args.rid);
      } else if (command.startsWith('plugin:fs|')) {
        const path = confined(args.path), operation = command.split('|')[1];
        switch (operation) {
          case 'mkdir': await fs.mkdir(path, { recursive: !!args.options?.recursive, mode: args.options?.mode }); break;
          case 'read_file': value = [...await fs.readFile(path)]; break;
          case 'read_dir':
            assert.ok(!gitInspections || !path.endsWith('/repo/assets/git-fixture'), 'Mobile Git never enumerates tracked assets via WebView IPC');
            value = (await fs.readdir(path, { withFileTypes: true })).map(item => ({ name: item.name, isFile: item.isFile(), isDirectory: item.isDirectory(), isSymlink: item.isSymbolicLink() })); break;
          case 'remove': { const stat = await fs.lstat(path); if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rmdir(path); else await fs.unlink(path); break; }
          case 'stat': case 'lstat': value = fileInfo(await fs[operation](path)); break;
          default: throw new Error('Unsupported fixture FS command: ' + command);
        }
      } else if (allowOAuthHttp && command === 'plugin:opener|open_url') {
        assert.ok(/^https:\/\/(github.com\/login\/device|cnb.cool\/oauth2\/device)/.test(args.url));
      } else if (allowOAuthHttp && command === 'cnb_account_get') {
        assert.equal(args.token, 'oauth-fixture-token');
        assert.ok(['account', 'repos'].includes(args.resource));
        assert.deepEqual(Object.keys(args).sort(), (args.resource === 'repos' ? ['page', 'resource', 'token'] : ['resource', 'token']));
        const stage = args.resource;
        if (stage === 'account') await accountGate;
        else assert.equal(args.page, 1);
        const failed = oauthFailureStage === stage;
        const body = failed ? '' : JSON.stringify(stage === 'account'
          ? {username:'fixture-writer',nickname:'Fixture Writer'}
          : [{id:'1',path:'fixture-writer/blog',visibility_level:'Public'}]);
        value = {status:failed?403:200,headers:[['x-trace-id','0123456789abcdef']],body};
      } else if (allowOAuthHttp && command.startsWith('plugin:http|')) {
        const operation = command.split('|')[1];
        if (operation === 'fetch') {
          const config = args.clientConfig, url = new URL(config.url);
          assert.notEqual(url.origin, 'https://api.cnb.cool', 'CNB discovery must use the narrow command, not the Origin-injecting HTTP plugin');
          assert.ok(['https://github.com', 'https://api.github.com', 'https://cnb.cool'].includes(url.origin));
          assert.equal(config.maxRedirections, 0, 'OAuth must disable redirects in the actual native client');
          assert.equal(new Map(config.headers).get('user-agent'), 'WonderShine-Studio');
          value = nextResource++; requests.set(value, config);
        } else if (operation === 'fetch_send') {
          const config = requests.get(args.rid), url = new URL(config.url), github = url.hostname.includes('github');
          let body, stage;
          if (url.pathname === '/login/device/code' || url.pathname === '/oauth2/device/auth') {
            stage = 'device';
            body = {device_code:'device-fixture',user_code:'TEST-CODE',expires_in:600,interval:1,verification_uri:github?'https://github.com/login/device':'https://cnb.cool/oauth2/device/verify'};
          } else if (url.pathname === '/login/oauth/access_token' || url.pathname === '/oauth2/token') {
            stage = 'token';
            body = oauthApproved ? {access_token:'oauth-fixture-token',token_type:'bearer'} : {error:'authorization_pending'};
          } else {
            assert.equal(new Map(config.headers).get('authorization'), 'Bearer oauth-fixture-token');
            if (url.pathname === '/user') {
              stage = 'account';
              await accountGate;
              body = github ? {login:'fixture-writer',name:'Fixture Writer'} : {username:'fixture-writer',nickname:'Fixture Writer'};
            } else if (url.pathname === '/user/repos') {
              stage = 'repos';
              body = github ? [{id:1,full_name:'fixture-writer/blog',default_branch:'main',permissions:{push:true},private:false}] : [{id:'1',path:'fixture-writer/blog',visibility_level:'Public'}];
            } else throw new Error('Unexpected OAuth fixture endpoint');
          }
          const failed = oauthApproved && oauthFailureStage === stage;
          if (failed) body = {error:'fixture_failure',error_description:'private-response-body oauth-fixture-token device-fixture TEST-CODE'};
          const rid = nextResource++; responses.set(rid, Buffer.from(JSON.stringify(body))); requests.delete(args.rid);
          value = {rid,status:failed?403:200,statusText:failed?'Forbidden':'OK',url:config.url,headers:[['content-type','application/json']]};
        } else if (operation === 'fetch_read_body') {
          const body = responses.get(args.rid); value = body?.length ? [...body,0] : [1]; responses.delete(args.rid);
        } else if (operation === 'fetch_cancel' || operation === 'fetch_cancel_body') {
          requests.delete(args.rid); responses.delete(args.rid);
        } else throw new Error('Unexpected OAuth HTTP operation');
      } else if (command === 'mobile_git') {
        mobile.setOnline(allowCloneHttp);
        if (args.job.action === 'open' && args.job.clone) {
          await downloadGate;
          if (failNextHttp) { failNextHttp = false; mobile.setOnline(false); }
        }
        if (args.job.action === 'inspect') { gitInspections++; if (args.job.paths == null) worktreeScans++; }
        let sentProgress = false;
        value = await mobile.invoke(args, async event => {
          if (!sentProgress && event.total > 0) {
            sentProgress = true;
            await page.evaluate(event => window.gitProgress?.(event), event);
            await checkoutGate;
          }
        });
      } else throw new Error('Unexpected native command, external HTTP is disabled: ' + command);
      return { value };
    } catch (error) {
      // Record command names only: arguments and assertion messages can contain credentials.
      ipcFailures.push({ command, error: error.name, code: error.code ?? null });
      if (ipcFailures.length > 100) ipcFailures.shift();
      return { error: error.message };
    }
  });
  await page.evaluateOnNewDocument(profile => {
    if (location.href === 'about:blank') return;
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] });
    if (!localStorage.getItem('wondershine.native.workspaces.v1')) localStorage.setItem('wondershine.native.workspaces.v1', JSON.stringify([profile, { id: 'a6347560-bbe9-4c35-9d89-b0429108882b', source: 'service', label: 'Saved Studio', address: 'https://studio.example.test' }]));
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}, options) => {
        const value = args instanceof Uint8Array ? Array.from(args) : args;
        if (value.data instanceof Uint8Array) value.data = Array.from(value.data);
        if (command === 'mobile_git' && args.progress) window.gitProgress = event => args.progress.onmessage(event);
        const result = await window.tauriInvoke(command, value, options);
        if (result.error) throw result.error;
        return result.value;
      },
      convertFileSrc: path => location.origin + '/__asset/' + encodeURIComponent(path),
      transformCallback: () => 1,
    };
  }, profile);
  const click = async text => {
    if (text === '打开工作区' && !await page.$('.connection-form-fields')) {
      await page.evaluate(() => document.querySelector('.workspace-record button')?.click());
    }
    await page.waitForFunction(text => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === text && !button.disabled), {}, text);
    await page.evaluate(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text && !button.disabled).click(), text);
  };
  const heading = async text => {
    const dashboard = ['今天，写点什么？', 'What will you write today?'].includes(text);
    await page.waitForFunction((text, dashboard) => [...document.querySelectorAll('h1')].some(node => node.textContent.trim() === text)
      || dashboard && document.querySelector('.native-connect [role="alert"]'), {}, text, dashboard);
    if (dashboard) assert.equal(await page.$eval('body', node => node.querySelector('.native-connect [role="alert"]')?.textContent ?? null), null, 'Workspace connection failed before dashboard');
  };
  const restartNativeFixture = async () => {
    // Destroy the old WebView before simulating process exit. Plain reload must
    // retain the owner; only this explicit restart grants a fresh epoch/recovery.
    await page.goto('about:blank');
    reviewEpoch = undefined; reviewClaims.clear();
    await page.goto(origin, { waitUntil: 'networkidle0' });
  };
  const noOverflow = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, label + ' must fit viewport');
  const screenshot = async (name, fullPage = true) => {
    await page.evaluate(async () => { window.scrollTo(0, 0); await document.fonts.ready; for (const animation of document.getAnimations()) { if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) { try { animation.finish(); } catch {} } } await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    return page.screenshot({ path: join(screenshots, name + '.png'), fullPage });
  };
  async function auditNativePage(name) {
    const originalViewport = page.viewport();
    for (const { width, height, screenshot: capture } of await auditViewports(page)) {
      await page.setViewport({ ...originalViewport, width, height });
      if (capture) await screenshot(`audit-${name}-${width}`, false);
      await noOverflow(`${name} ${width}x${height}`);
    }
    await page.setViewport(originalViewport);
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(origin, { waitUntil: 'networkidle0' }); await heading('连接创作工作区');
  assert.equal(runtimeChunks.some(name => loadedScripts.has(name)), false, 'Connection screen must not load the Git/content runtime before opening a workspace');
  assert.equal(await page.$$('.workspace-record').then(records => records.length), 2, 'Git and service records share the initial chooser');
  assert.equal(await page.$('.connection-form-fields'), null, 'saved workspaces start at the chooser');
  await page.evaluate(() => [...document.querySelectorAll('.workspace-record')].find(record => record.textContent.includes('Saved Studio')).querySelector('button').click());
  assert.equal(await page.$eval('input[placeholder="https://studio.example.com"]', input => input.value), 'https://studio.example.test');
  const recordAction = async (id, text) => {
    await page.evaluate(({ id, text }) => {
      const record = document.querySelector(`[data-workspace-id="${id}"]`);
      const button = [...record.querySelectorAll('button')].find(button => button.textContent.trim() === text);
      if (!button || button.disabled) throw new Error('Missing record action: ' + text);
      button.click();
    }, { id, text });
  };
  const recoveryKey = `studio-draft:password:${profile.id}:content/articles/recovery/index.md`;
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ body: 'Archive recovery fixture' })), recoveryKey);
  for (const id of ['a6347560-bbe9-4c35-9d89-b0429108882b', profile.id]) {
    await recordAction(id, '归档记录');
    await page.waitForSelector(`.archived-workspaces [data-workspace-id="${id}"]`);
    assert.equal(await page.$(`.workspace-chooser > .workspace-record[data-workspace-id="${id}"]`), null);
    await page.reload({waitUntil:'networkidle0'});
    await page.click('.archived-workspaces summary');
    await recordAction(id, '恢复记录');
    await page.waitForSelector(`.workspace-chooser > .workspace-record[data-workspace-id="${id}"]`);
  }
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).body, recoveryKey), 'Archive recovery fixture', 'archive/restore retains the original draft identity');
  assert.ok(await fs.stat(root), 'archive/restore retains the original checkout');
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('wondershine.native.workspaces.v1')));
  assert.deepEqual(restored.find(record => record.id === profile.id), profile, 'restore preserves the complete original record and recovery ID');
  await page.click('.connection-about summary');
  await page.waitForSelector('.connection-about .native-update-controls button', { visible: true });
  await page.click('.connection-about summary');
  await recordAction('a6347560-bbe9-4c35-9d89-b0429108882b', '删除记录');
  await page.waitForFunction(() => !document.querySelector('[data-workspace-id="a6347560-bbe9-4c35-9d89-b0429108882b"]'));
  await screenshot('connection-git-desktop'); await auditNativePage('git'); await noOverflow('desktop connection');
  await click('本地文件夹'); await screenshot('connection-folder-desktop'); await auditNativePage('folder');
  await page.click('.folder-picker');
  assert.equal(await page.$('.selected-repository'), null, 'cancelled picker does not select a folder');
  selectedFolder = localRoot; await page.click('.folder-picker'); await page.waitForSelector('.selected-repository');
  await screenshot('connection-folder-selected-desktop');
  await page.click('.connection-options summary'); await screenshot('connection-folder-options-desktop');
  await page.setViewport({width:390,height:844}); await screenshot('connection-folder-options-mobile'); await noOverflow('local folder options');
  await page.setViewport({width:1440,height:1000});
  await click('打开工作区'); await heading('今天，写点什么？');
  assert.ok(runtimeChunks.some(name => loadedScripts.has(name)), 'Opening a workspace loads the deferred native runtime');
  await click('工作区同步'); await page.waitForSelector('.workspace-status-grid');
  assert.equal(await page.$$eval('button', buttons => buttons.find(b => b.textContent.trim() === '同步 Git').disabled), true, 'local repository without a remote disables sync');
  await click('切换工作区'); await heading('连接创作工作区');
  assert.equal(await page.$('.studio-shell'), null, 'switch tears down the previous App before choosing another workspace');
  assert.equal(await page.$$('.workspace-record').then(records => records.length), 3, 'local, clone and service records coexist');
  await click('远程仓库');

  await click('连接自建创作中心'); await page.waitForSelector('input[placeholder="https://studio.example.com"]'); await screenshot('connection-remote-desktop'); await auditNativePage('service');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('connection-remote-mobile'); await noOverflow('mobile remote connection');
  await click('远程仓库'); await screenshot('connection-git-mobile'); await noOverflow('mobile Git connection');
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await click('打开工作区'); await heading('今天，写点什么？'); await page.waitForFunction(() => Number(document.querySelector('.stat-card strong')?.textContent) > 0);
  await screenshot('dashboard-desktop'); await noOverflow('desktop dashboard');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('dashboard-mobile'); await noOverflow('mobile dashboard');
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  for (const [label, name, ready] of [['动态', 'threads', '.thread-composer textarea'], ['话题管理', 'topics', '.localized-library'], ['站点信息', 'site-settings', '.settings-grid']]) {
    await click(label); await heading(label);
    if (name !== 'topics') await page.waitForSelector(ready);
    await screenshot(name + '-desktop'); await noOverflow(name + ' desktop');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot(name + '-mobile'); await noOverflow(name + ' mobile');
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  }
  await click('工作台'); await heading('今天，写点什么？');
  await page.evaluate(() => [...document.querySelectorAll('.content-row')].find(node => node.textContent.includes('离线文章示例')).click());
  await heading('离线文章示例'); await page.waitForSelector('.markdown-source');
  await page.focus('.markdown-source'); await page.$eval('.markdown-source', element => element.select());
  await page.type('.markdown-source', '# Native UI saved\n\nOffline source editing.\n');
  dismissNextDialog = true;
  await click('切换工作区');
  assert.ok(await page.$('.markdown-source'), 'cancelled dirty-workspace switch keeps the editor mounted');
  writeGate = new Promise(resolve => { releaseWrite = resolve; });
  await click('本地保存');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '切换工作区')?.disabled);
  assert.ok(await page.$('.markdown-source'), 'pending writes block switching without unmounting the editor');
  releaseWrite(); await page.waitForSelector('.notice.success');
  const savedArticle = await fs.readFile(join(root, 'content/articles/example/index.md'), 'utf8');
  assert.match(savedArticle, /Native UI saved/); assert.doesNotMatch(savedArticle, /Native UI fixture\./);
  const originalHead = git(['rev-parse', 'HEAD']);
  const originalIndex = await fs.readFile(join(root, '.git/index'));
  await page.click('.save-button-toggle'); await page.waitForSelector('.save-mode-menu');
  await page.click('.save-mode-menu [role="radio"]:nth-child(2)');
  await page.click('.save-button-toggle'); await click('将当前方式设为默认');
  await click('Git 分支保存'); await page.waitForSelector('.saved-branch');
  const branch = await page.$eval('.saved-branch', e => e.textContent);
  assert.match(branch, /^studio\/save-/);
  assert.match(git(['show', `${branch}:content/articles/example/index.md`]), /Native UI saved/);
  assert.equal(git(['rev-parse', 'HEAD']), originalHead);
  assert.deepEqual(await fs.readFile(join(root, '.git/index')), originalIndex);
  const commit = git(['rev-parse', branch]);
  await click('Git 分支保存'); await page.waitForFunction(() => !document.querySelector('.save-button-main').disabled);
  assert.equal(git(['rev-parse', branch]), commit, 'unchanged saves reuse the commit');
  for (const [width, height] of [[1440,1000],[1024,768],[390,844]]) {
    await page.setViewport({width,height});
    await page.click('.save-button-toggle'); await page.waitForSelector('.save-mode-menu');
    await screenshot(`save-menu-${width}`); await noOverflow('save menu');
    assert.equal(await page.$eval('.save-mode-menu', e => { const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight; }), true);
    await page.keyboard.press('Escape');
  }
  await page.setViewport({width:1440,height:1000});
  await page.type('.markdown-source', '\nBranch retry retains this local edit.');
  failNextBranchWrite = true;
  await click('Git 分支保存'); await page.waitForSelector('.notice.error');
  assert.match(await page.$eval('.notice.error', e => e.textContent), /本地文件已保存/);
  assert.match(await fs.readFile(join(root, 'content/articles/example/index.md'), 'utf8'), /Branch retry/);
  assert.equal(git(['rev-parse', branch]), commit, 'failed commit does not advance branch');
  failNextBranchWrite = false;
  await click('Git 分支保存'); await page.waitForSelector('.notice.success');
  assert.match(git(['show', `${branch}:content/articles/example/index.md`]), /Branch retry/);
  await page.evaluate(() => {
    const original = window.setInterval;
    window.setInterval = (handler, delay, ...args) => original(handler, delay === 30000 ? 200 : delay, ...args);
  });
  await page.type('.markdown-source', '\nAutomatic branch save.');
  await page.select('.autosave-control select', '30');
  await page.waitForFunction(() => document.querySelector('.autosave-status')?.textContent.includes('自动保存于'));
  await page.select('.autosave-control select', '0');
  assert.match(git(['show', `${branch}:content/articles/example/index.md`]), /Automatic branch save/);
  assert.equal(git(['rev-parse', 'HEAD']), originalHead);
  await click('站点信息'); await page.waitForSelector('.settings-grid');
  assert.equal(await page.$eval('.save-button-main', e => e.textContent), 'Git 分支保存', 'default persists across editors');
  await page.reload({waitUntil:'networkidle0'}); await heading('连接创作工作区'); await click('打开工作区');
  await page.waitForSelector('.native-connect [role="alert"]');
  assert.equal(await page.$eval('.native-connect [role="alert"]', node => node.textContent), reviewRestart, 'WebView reload cannot replace the live process owner');
  assert.equal(await page.$('.studio-shell'), null, 'Reloaded WebView cannot expose workspace operations');
  await screenshot('connection-reload-requires-restart');
  await restartNativeFixture(); await heading('连接创作工作区'); await click('打开工作区'); await heading('今天，写点什么？');
  await page.waitForSelector('.thread-composer .save-button-main');
  assert.equal(await page.$eval('.thread-composer .save-button-main', e => e.textContent), '分支保存 · 可发布', 'default persists across app restart');
  await page.evaluate(() => [...document.querySelectorAll('.content-row')].find(node => node.textContent.includes('离线文章示例')).click());
  await page.waitForSelector('.markdown-source');
  await click('可视化编辑'); await page.waitForSelector('.vditor-ir [contenteditable="true"]', { timeout: 20000 });
  await page.waitForSelector('#vditor-icon-bold');
  await screenshot('rich-editor-desktop');
  await click('Markdown 源码');
  await click('可视化编辑'); await page.waitForSelector('.vditor-ir [contenteditable="true"]', { timeout: 20000 });
  assert.equal(await page.$$eval('#vditor-icon-bold', elements => elements.length), 1, 'reopening rich editor retains one icon sprite');
  await click('Markdown 源码');
  await click('媒体库'); await page.waitForSelector('.media-browser');
  await page.waitForFunction(() => [...document.querySelectorAll('img')].some(image => image.src.includes('/__asset') && image.complete && image.naturalWidth > 0));
  await screenshot('media-desktop');
  await click('工作区同步'); await page.waitForSelector('.workspace-status-grid');
  await screenshot('workspace-desktop'); await auditNativePage('workspace'); await noOverflow('desktop workspace');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('workspace-mobile'); await noOverflow('mobile workspace');
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await click('客户端 API 设置'); await heading('客户端 API 设置');
  await page.waitForSelector('.native-ai-settings form');
  const fillSetting = async (label, value) => {
    const input = await page.evaluateHandle(label => [...document.querySelectorAll('.native-ai-settings label')].find(node => node.querySelector('span')?.textContent === label)?.querySelector('input'), label);
    await input.type(value); await input.dispose();
  };
  await fillSetting('API 地址', 'http://127.0.0.1:18361/v1');
  await fillSetting('文本模型', 'fixture-text');
  await fillSetting('图片模型（可选）', 'fixture-image');
  await fillSetting('API Key', 'browser-fixture-secret');
  await click('保存 API 配置'); await page.waitForSelector('.native-ai-settings .notice.success');
  assert.equal(await page.$eval('.native-ai-settings input[type="password"]', input => input.value), '');
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('browser-fixture-secret')), false);
  await screenshot('api-settings-desktop'); await auditNativePage('api-settings');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('api-settings-mobile'); await noOverflow('mobile API settings');
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.select('.language-switcher select', 'en'); await heading('Client API settings');
  assert.match(await page.$eval('.native-ai-settings .notice.success', node => node.textContent), /Local configuration saved/, 'existing feedback follows the selected language');
  await screenshot('api-settings-en-desktop'); await noOverflow('English API settings');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('api-settings-en-mobile'); await noOverflow('English mobile API settings');
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.select('.language-switcher select', 'zh-CN'); await heading('客户端 API 设置');
  await click('清除密钥'); await page.waitForFunction(() => document.querySelector('.native-ai-settings')?.textContent.includes('尚未配置密钥'));
  await restartNativeFixture(); await heading('连接创作工作区');
  await click('打开工作区'); await heading('今天，写点什么？');
  await click('客户端 API 设置'); await page.waitForSelector('.native-ai-settings form');
  assert.equal(await page.$eval('.native-ai-settings input[type="url"]', input => input.value), 'http://127.0.0.1:18361/v1');
  assert.ok(await page.$eval('.native-ai-settings', node => node.textContent.includes('尚未配置密钥')));
  await page.click('[aria-label="退出登录"]'); await heading('连接创作工作区');
  assert.equal(await page.$('.studio-shell'), null);
  assert.equal([...commands].some(command => command.startsWith('plugin:http|')), false, 'offline workflow must not contact Git or other services');
  await page.evaluate(()=>localStorage.setItem('wondershine.native.workspaces.v1','[]'));
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.reload({waitUntil:'networkidle0'});await heading('连接创作工作区');
  assert.equal(await page.$eval('.connection-modes button[aria-pressed=true]',node=>node.textContent.trim()),'远程仓库','mobile first launch starts with usable repository URL entry');
  assert.equal(await page.$$eval('.connection-modes button', buttons => buttons.some(button => button.textContent.includes('本地文件夹'))), false, 'Mobile does not offer an unsupported folder picker');
  await click('连接自建创作中心'); await page.waitForSelector('input[placeholder="https://studio.example.com"]');
  await click('返回仓库连接'); await page.waitForSelector('.connection-url input');
  assert.equal(await page.$('.folder-picker'), null, 'Returning from remote service uses the mobile repository URL mode');

  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await restartNativeFixture(); await heading('连接创作工作区');
  assert.equal(await page.$eval('html', node => node.dataset.nativeMobile), 'true');
  assert.match(await page.$eval('meta[name=viewport]', node => node.content), /maximum-scale=1/);
  assert.equal(await page.evaluate(() => {const event = new Event('gesturestart', {cancelable:true}); document.dispatchEvent(event); return event.defaultPrevented;}), true);
  assert.ok(await page.$eval('.connection-url input', node => parseFloat(getComputedStyle(node).fontSize) >= 16), 'iOS inputs avoid focus zoom');
  if (process.env.STUDIO_TEST_OAUTH === 'fixture') {
    assert.ok(await page.$eval('.account-login button', node => node.getBoundingClientRect().height >= 44));

    allowOAuthHttp = true;
    for (const provider of ['GitHub', 'CNB']) {
      for (const stage of ['token', 'account', 'repos']) {
        oauthApproved = false; oauthFailureStage = stage;
        if (stage === 'account') accountGate = new Promise(resolve => { releaseAccount = resolve; });
        await click(`使用 ${provider} 登录`); await page.waitForSelector('.oauth-code');
        assert.equal(await page.$eval('.oauth-device [role=status]', node => node.textContent), '等待授权…');
        oauthApproved = true;
        if (stage === 'account') {
          await page.waitForSelector('.oauth-status');
          assert.equal(await page.$('.oauth-device'), null, 'Token receipt removes device actions before the account request completes');
          assert.equal(await page.$eval('.oauth-status', node => node.textContent), '正在连接…');
          assert.equal(await page.$('.oauth-dialog [role=alert]'), null);
          releaseAccount();
        }
        await page.waitForSelector('.oauth-dialog [role=alert]');
        await page.waitForFunction(() => [...document.querySelectorAll('.oauth-dialog button')].some(button => button.textContent === '重新登录' && !button.disabled));
        const diagnostic = await page.$eval('.oauth-dialog [role=alert]', node => node.textContent);
        assert.ok(diagnostic.includes(`stage=${stage}`), provider + ' reports the actual failed stage');
        assert.ok(diagnostic.includes('HTTP=403'));
        if (provider === 'CNB' && stage !== 'token') assert.ok(diagnostic.includes('x-trace-id=0123456789abcdef'), 'Native command metadata reaches safe stage errors');
        assert.equal(await page.$('.oauth-device'), null, 'Terminal failures remove expired code and authorization actions');
        assert.equal(await page.$('.oauth-dialog [role=status]'), null, 'Terminal failures never claim authorization or connection is pending');
        const dialogText = await page.$eval('.oauth-dialog', node => node.textContent);
        assert.doesNotMatch(dialogText, /等待授权|在浏览器中输入此代码|打开授权页面|没有可写入的仓库/);
        assert.doesNotMatch(dialogText, /private-response-body|oauth-fixture-token|device-fixture|TEST-CODE/, 'Errors do not expose response bodies or credentials');
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('oauth-fixture-token')), false);
        if (stage === 'repos') assert.ok(await page.$('.oauth-repositories'), 'Repository failure retains the picker without claiming an empty result');
        await screenshot(`oauth-error-${provider.toLowerCase()}-${stage}`); await noOverflow('OAuth ' + stage + ' error');
        await click('取消'); await page.waitForFunction(() => !document.querySelector('.oauth-dialog'));
      }
      oauthFailureStage = null;
      oauthApproved = false;
      await click(`使用 ${provider} 登录`); await page.waitForSelector('.oauth-code');
      assert.equal(await page.$eval('.oauth-code', node => node.textContent), 'TEST-CODE');
      await screenshot('oauth-device-' + provider.toLowerCase());
      await auditNativePage('oauth-device-' + provider.toLowerCase());
      oauthApproved = true; await page.waitForSelector('.oauth-repository');
      assert.equal(await page.$('.oauth-device'), null, 'Successful sign-in leaves the device authorization stage');
      assert.equal(await page.$('.oauth-dialog [role=alert]'), null, 'A fresh sign-in clears previous diagnostics');
      await page.type('.oauth-dialog input', 'blog');
      await screenshot('oauth-repositories-' + provider.toLowerCase());
      await auditNativePage('oauth-repositories-' + provider.toLowerCase());
      await page.setViewport({width:390,height:430,isMobile:true,hasTouch:true});
      await page.waitForFunction(() => parseFloat(document.documentElement.style.getPropertyValue('--native-visible-height')) < 500);
      assert.ok(await page.$eval('.oauth-dialog', node => node.getBoundingClientRect().bottom <= visualViewport.height + visualViewport.offsetTop + 1), 'Repository picker fits visible keyboard viewport');
      await screenshot('oauth-keyboard-' + provider.toLowerCase());
      await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
      await page.click('.oauth-repository'); await page.waitForFunction(() => !document.querySelector('.oauth-dialog'));
      assert.equal(await page.$eval('.connection-url input', node => node.value), `https://${provider === 'GitHub' ? 'github.com' : 'cnb.cool'}/fixture-writer/blog.git`);
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('oauth-fixture-token')), false);
    }
    allowOAuthHttp = false;
    await click('远程仓库');
  }
  await page.waitForSelector('.connection-url input');
  for (const [width, height, name] of [[390, 844, 'iphone'], [430, 932, 'iphone-large'], [768, 1024, 'ipad'], [844, 390, 'landscape'], [375, 667, 'compact']]) {
    await page.setViewport({ width, height, isMobile: true, hasTouch: true });
    await page.waitForFunction(height => Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--native-visible-height')) - height) < 1, {}, height);
    await page.evaluate(() => scrollTo(0, 0));
    const layout = await page.evaluate(() => {
      const main = document.querySelector('.native-connect');
      const card = document.querySelector('.connection-card').getBoundingClientRect();
      const footer = document.querySelector('footer');
      const padding = parseFloat(getComputedStyle(main).paddingTop);
      return { top: card.top, padding, hasFooter: !!footer, height: document.documentElement.scrollHeight, viewport: innerHeight };
    });
    assert.ok(Math.abs(layout.top - layout.padding) <= 1, name + ': connection card starts at safe-area padding, without a centering gap');
    assert.equal(layout.hasFooter, false, name + ': the native connection page has no footer');
    if (height >= 844) assert.ok(layout.height <= layout.viewport + 1, name + ': first launch fits the viewport');
    await screenshot('connection-first-launch-' + name); await noOverflow(name + ' first launch');
  }
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await screenshot('connection-first-launch-mobile');
  await page.click('.connection-options summary');await screenshot('connection-options-mobile');await noOverflow('mobile connection options');
  await page.select('.language-switcher select','en');await screenshot('connection-options-en-mobile');await noOverflow('English connection options');
  // Download an actual temporary Git repository through the native HTTP adapter.
  console.log('PASS: offline native UI; starting real clone fixture.');
  await page.select('.language-switcher select','zh-CN');
  await page.type('.connection-url input',mobile.url);
  assert.equal(await page.$eval('input[placeholder="自动识别默认分支"]', input => input.value), '');
  assert.equal(await page.$eval('input[placeholder="自动识别默认分支"]', input => input.required), false);
  await page.click('.connection-options summary');
  allowCloneHttp = true; failNextHttp = true;
  await click('下载并开始创作'); await page.waitForSelector('[role=alert]');
  assert.equal(await page.$('.connection-progress'),null,'failed connection removes stale progress');
  await screenshot('clone-error-mobile'); console.log('PASS: clone error releases connection state.');
  downloadGate = new Promise(resolve => { releaseDownload = resolve; });
  checkoutGate = new Promise(resolve => { releaseCheckout = resolve; });
  await click('下载并开始创作'); await page.waitForSelector('.connection-progress progress');
  assert.equal(await page.$eval('.connection-progress progress', el => el.hasAttribute('value')),false);
  await screenshot('clone-connecting-mobile'); await noOverflow('connecting repository');
  console.log('PASS: indeterminate connection progress.'); releaseDownload();
  await page.waitForSelector('.connection-progress progress[value]',{timeout:20000});
  for(const [width,height,name] of [[1440,1000,'desktop'],[1024,768,'medium'],[390,844,'mobile']]){
    await page.setViewport({width,height,isMobile:true,hasTouch:true});await screenshot('clone-progress-'+name);await noOverflow('clone progress '+name);
  }
  await page.select('.language-switcher select','en');await screenshot('clone-progress-en-mobile');
  console.log('PASS: real clone progress at three widths.'); releaseCheckout();await heading('What will you write today?');
  const saved = await page.evaluate(()=>JSON.parse(localStorage.getItem('wondershine.native.workspaces.v1')));
  assert.equal(saved[0].branch,'release/blog');
  assert.equal(execFileSync('git',['branch','--show-current'],{cwd:join(appData,'workspaces',saved[0].id,'repo')}).toString().trim(),'release/blog');
  await page.select('.language-switcher select', 'zh-CN');
  allowCloneHttp = false;
  await restartNativeFixture();
  await heading('今天，写点什么？');
  await page.waitForSelector('.thread-composer textarea');
  assert.equal(await page.$('.native-connect'), null, 'A cold phone launch reopens the last checkout offline');
  await screenshot('phone-composer', false);
  await page.type('.thread-composer textarea', 'Phone publication fixture');
  const inspectionsBeforeReview = gitInspections;
  await page.evaluate(() => {
    window.gitFrames = { count: 0, longest: 0 };
    let previous = performance.now();
    const tick = now => {
      if (!window.gitFrames) return;
      window.gitFrames.count++;
      window.gitFrames.longest = Math.max(window.gitFrames.longest, now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await click('发布动态');
  await page.waitForSelector('dialog.publish-dialog[open] ul li');
  const frames = await page.evaluate(() => { const result = window.gitFrames; delete window.gitFrames; return result; });
  assert.ok(gitInspections > inspectionsBeforeReview, 'The mobile review runs in the linked libgit2 engine');
  assert.ok(frames.count >= 2 && frames.longest < 1000, 'The WebView must keep drawing frames during Git review: ' + JSON.stringify(frames));
  console.log('Mobile Git review with 128 tracked assets:', JSON.stringify(frames));
  assert.equal(await page.$('.thread-composer .language-versions'), null, 'Language tools stay in More options after saving');
  assert.equal(await page.$('.thread-composer .notice.success'), null, 'The review is the active save feedback');
  await screenshot('phone-publish-review', false);
  await auditNativePage('publish-review');
  await click('稍后');
  assert.equal(await page.$('dialog.publish-dialog[open]'), null);
  const scansBeforePublish = worktreeScans;
  await click('发布动态');
  await page.waitForFunction(() => document.querySelector('.publish-actions .primary')?.textContent === '确认发布');
  const remoteArgs = ['--git-dir=' + join(base, 'remote.git')];
  assert.equal(execFileSync('git', [...remoteArgs, 'log', '-1', '--format=%s', 'release/blog']).toString().trim(), 'initial');
  allowCloneHttp = true;
  await click('确认发布');
  await page.waitForSelector('dialog.publish-dialog[open] [role=status]');
  await page.waitForFunction(() => document.querySelector('.publish-dialog h2')?.textContent === '动态已发送到仓库');
  assert.match(execFileSync('git', [...remoteArgs, 'grep', '-l', 'Phone publication fixture', 'release/blog', '--', 'content/threads']).toString(), /index.*\.md/);
  assert.equal(worktreeScans - scansBeforePublish, 1, 'An uninterrupted mobile publish visits unrelated tracked assets only during initial discovery');
  console.log('Mobile publish worktree scans:', worktreeScans - scansBeforePublish);
  await click('完成');
  await click('切换工作区'); await heading('连接创作工作区');
  assert.equal(await page.$('.studio-shell'), null, 'Explicit switching leaves the chooser open');
  await click('打开工作区'); await heading('今天，写点什么？');
  await click('站点信息'); await page.waitForSelector('.settings-card input');
  assert.deepEqual(await page.$$eval('.settings-card input:not([type=checkbox]):not([type=radio]):not([type=color]), .settings-card select, .settings-card textarea', fields => fields.filter(node => node.getClientRects().length && (parseFloat(getComputedStyle(node).fontSize) < 16 || node.getBoundingClientRect().height < 44)).map(node => node.outerHTML.slice(0,80))), [], 'Native iOS settings retain readable editing size and touch targets');
  await screenshot('settings-iphone'); await noOverflow('iPhone settings');
  const legacyHead = git(['rev-parse','HEAD']);
  assert.equal(await mobile.invoke({ profile,job:{ action:'open',clone:false } }),profile.branch);
  assert.equal(git(['rev-parse','HEAD']),legacyHead,'Upgrading the earlier isomorphic-git checkout preserves its commits');
  await mobile.verifySync(saved[0]);
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []); assert.deepEqual(failedResources, []);
  console.log('Native UI passed: desktop/mobile connection modes, offline dashboard, source save, bundled Vditor, native asset preview, client API settings, secret redaction, configuration reopen, logout.');
  console.log('Screenshots: ' + screenshots);
} catch (error) {
  const diagnostics = { failure: String(error), commands: [...commands], ipcFailures, errors, cspErrors, failedResources };
  if (page && !page.isClosed()) {
    try {
      diagnostics.ui = await page.evaluate(() => ({
        headings: [...document.querySelectorAll('h1')].map(node => node.textContent),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
      }));
    } catch (diagnosticError) { diagnostics.uiError = diagnosticError.message; }
    try { await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true }); }
    catch (diagnosticError) { diagnostics.screenshotError = diagnosticError.message; }
  }
  try {
    await fs.mkdir(screenshots, { recursive: true });
    const report = JSON.stringify(diagnostics, null, 2).replace(/browser-fixture-secret|oauth-fixture-token|device-fixture|TEST-CODE/g, '[redacted]');
    await fs.writeFile(join(screenshots, 'failure.json'), report + '\n');
    console.error(report);
  } catch (diagnosticError) { console.error('Could not write native UI failure diagnostics:', diagnosticError.message); }
  throw error;
} finally {
  releaseDownload(); releaseCheckout(); releaseWrite(); releaseAccount();
  await browser?.close();
  await mobile?.close();
  await Promise.all([...fileHandles.values()].map(handle => handle.close()));
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(base, { recursive: true, force: true });
}
