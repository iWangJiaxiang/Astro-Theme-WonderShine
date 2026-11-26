import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { configureGestureEmulation, inspectGestureEnvironment, exerciseScroll, exercisePinch } from './ui-audit-gestures.mjs';
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
const nativeGestureRecords = [];
const gestureFindings = () => nativeGestureRecords.flatMap(record => (record.findings || []).map(finding => ({ name:record.name, ...finding })));
const commands = new Set();
const reviewClaims = new Set();
let reviewEpoch, resumeGate;
const reviewRestart = '创作窗口已重新加载，请完全退出并重启应用后重新确认工作区';
let allowOAuthHttp = false, oauthApproved = false, oauthFailureStage = null;
const themeTags = 'https://registry.npmjs.org/-/package/@wondershine%2ftheme/dist-tags';
const cnbRemote = 'https://cnb.cool/fixture-writer/blog.git';
let reauthorizing = false, cnbUsername = 'fixture-writer';
let accountGate = Promise.resolve(), releaseAccount = () => {};
let allowCloneHttp = false, failNextHttp = false, failNextBranchWrite = false;
let releaseDownload = () => {}, releaseCheckout = () => {};
let downloadGate = Promise.resolve(), checkoutGate = Promise.resolve();
let writeGate = Promise.resolve(), releaseWrite = () => {};
let workspaceReadGate = Promise.resolve();
const requests = new Map(), responses = new Map(), fileHandles = new Map();
const keyring = new Map();
const offlineRequests = [];
let siteOpened;
const openedSite = new Promise(resolve => { siteOpened = resolve; });
let nextResource = 1, worktreeScans = 0, gitInspections = 0;
let mediaDirectoryReads = 0, thumbnailSourceReads = 0, thumbnailSourceStats = 0;
let markMediaSnapshotWritten;
const mediaSnapshotWritten = new Promise(resolve => { markMediaSnapshotWritten = resolve; });
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
  const themeSeed = join(base, 'theme-seed');
  const themeGit = (...args) => execFileSync('git', ['-C', themeSeed, ...args], { stdio: 'pipe' }).toString().trim();
  await fs.mkdir(themeSeed);
  themeGit('init', '-b', 'main');
  await fs.writeFile(join(themeSeed, 'theme.txt'), 'Pinned theme');
  themeGit('add', 'theme.txt');
  themeGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Pinned theme');
  const themePin = themeGit('rev-parse', 'HEAD');
  await fs.writeFile(join(themeSeed, 'theme.txt'), 'New theme');
  themeGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-am', 'New theme');
  themeGit('clone', '--bare', themeSeed, join(base, 'theme.git'));
  const themePath = 'themes/wondershine';
  await fs.writeFile(join(root, '.gitmodules'), `[submodule "theme"]\n\tpath = ${themePath}\n\turl = ../theme.git\n`);
  git(['add', '.gitmodules']);
  git(['update-index', '--add', '--cacheinfo', `160000,${themePin},${themePath}`]);
  git(['commit', '-m', 'initial']);
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
        if (resumeGate) await resumeGate;
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
      } else if (command === 'native_workspace_stat') {
        const path = confined(args.path);
        assert.match(path.slice(appData.length), /^\/workspaces\/[0-9a-f-]{36}\/repo(?:\/|$)/);
        if (path === join(root, 'public/uploads/example.png')) thumbnailSourceStats++;
        const info = await fs.lstat(path).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (info?.isSymbolicLink()) throw new Error('Private workspace path contains a symlink');
        value = info && { ...fileInfo(info), mtimeMs: info.mtime.getTime(), ctimeMs: info.birthtime.getTime(),
          kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' };
      } else if (command === 'plugin:dialog|open') { value = selectedFolder; folderGranted = !!value; }
      else if (command === 'plugin:path|resolve_directory') value = appData;
      else if (command === 'plugin:fs|write_file') {
        const path = confined(decodeURIComponent(options.headers.path));
        await writeGate;
        if (failNextBranchWrite && path.includes('/.git/objects/')) { throw new Error('Simulated branch write failure'); }
        if (path.includes('.clone-') && path.endsWith('/config.toml')) await checkoutGate;
        await fs.writeFile(path, new Uint8Array(args));
      } else if (command === 'plugin:fs|rename') {
        await fs.rename(confined(args.oldPath), confined(args.newPath));
        if (args.newPath === join(root, '../state/media-list-v1/snapshot.json')) markMediaSnapshotWritten();
      } else if (command === 'plugin:fs|open') {
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
          case 'read_file':
            if (path === join(root, 'public/uploads/example.png')) thumbnailSourceReads++;
            value = [...await fs.readFile(path)]; break;
          case 'read_dir':
            if (path === root) await workspaceReadGate;
            if (path === join(root, 'public') || path.startsWith(join(root, 'public') + sep)) mediaDirectoryReads++;
            assert.ok(!gitInspections || !path.endsWith('/repo/assets/git-fixture'), 'Mobile Git never enumerates tracked assets via WebView IPC');
            value = (await fs.readdir(path, { withFileTypes: true })).map(item => ({ name: item.name, isFile: item.isFile(), isDirectory: item.isDirectory(), isSymlink: item.isSymbolicLink() })); break;
          case 'remove': { const stat = await fs.lstat(path); if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rmdir(path); else await fs.unlink(path); break; }
          case 'stat': case 'lstat':
            if (path === join(root, 'public/uploads/example.png')) thumbnailSourceStats++;
            value = fileInfo(await fs[operation](path)); break;
          default: throw new Error('Unsupported fixture FS command: ' + command);
        }
      } else if (command === 'plugin:keyring-store|get_passwords') value = args.accounts.map(key => keyring.get(key) ?? null);
      else if (command === 'plugin:keyring-store|set_passwords') { for (const { account, secret } of args.entries) keyring.set(account, secret); }
      else if (command === 'plugin:keyring-store|delete_passwords') { for (const key of args.accounts) keyring.delete(key); }
      else if (command === 'plugin:opener|open_url' && args.url === 'https://example.com/') siteOpened();
      else if (!allowOAuthHttp && command === 'plugin:http|fetch') {
        offlineRequests.push([args.clientConfig.method, args.clientConfig.url]);
        throw new Error('Fixture is offline');
      } else if (allowOAuthHttp && command === 'plugin:opener|open_url') {
        assert.ok(/^https:\/\/(github.com\/login\/device|cnb.cool\/oauth2\/device)/.test(args.url));
      } else if (allowOAuthHttp && command === 'cnb_account_get') {
        assert.equal(args.token, 'oauth-fixture-token');
        assert.ok(['account', 'repos'].includes(args.resource));
        assert.deepEqual(Object.keys(args).sort(), (args.resource === 'repos' ? ['page', 'resource', 'token'] : ['resource', 'token']));
        const stage = args.resource;
        if (stage === 'account') await accountGate;
        else {
          assert.equal(reauthorizing, false, 'Reauthorization does not discover or replace repositories');
          assert.equal(args.page, 1);
        }
        const failed = oauthFailureStage === stage;
        const body = failed ? '' : JSON.stringify(stage === 'account'
          ? {username:cnbUsername,nickname:'Fixture Writer'}
          : [{id:'1',path:'fixture-writer/blog',visibility_level:'Public'}]);
        value = {status:failed?403:200,headers:[['x-trace-id','0123456789abcdef']],body};
      } else if (allowOAuthHttp && command.startsWith('plugin:http|')) {
        const operation = command.split('|')[1];
        if (operation === 'fetch') {
          const config = args.clientConfig, url = new URL(config.url);
          assert.notEqual(url.origin, 'https://api.cnb.cool', 'CNB discovery must use the narrow command, not the Origin-injecting HTTP plugin');
          assert.ok(config.url === themeTags || ['https://github.com', 'https://api.github.com', 'https://cnb.cool'].includes(url.origin));
          assert.equal(config.maxRedirections, 0, 'OAuth must disable redirects in the actual native client');
          if (config.url !== themeTags) assert.equal(new Map(config.headers).get('user-agent'), 'WonderShine-Studio');
          value = nextResource++; requests.set(value, config);
        } else if (operation === 'fetch_send') {
          const config = requests.get(args.rid), url = new URL(config.url), github = url.hostname.includes('github');
          let body, stage;
          if (config.url === themeTags) {
            stage = 'theme-tags'; body = { latest: '1.2.3', canary: '1.2.4-canary.0' };
          } else if (url.pathname === '/login/device/code' || url.pathname === '/oauth2/device/auth') {
            stage = 'device';
            body = {device_code:'device-fixture',user_code:'TEST-CODE',expires_in:600,interval:1,verification_uri:github?'https://github.com/login/device':'https://cnb.cool/oauth2/device/verify'};
          } else if (url.pathname === '/login/oauth/access_token' || url.pathname === '/oauth2/token') {
            stage = 'token';
            body = oauthApproved ? {access_token:'oauth-fixture-token',token_type:'bearer'} : {error:'authorization_pending'};
            if (reauthorizing && oauthApproved) Object.assign(body, { expires_in: 600, refresh_token: 'oauth-fixture-refresh', refresh_token_expires_in: 7200 });
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
        if (args.job.action === 'checkRemote' && args.profile.url === mobile.url) assert.equal(args.password, 'fixture-token');
        if (args.profile.url === cnbRemote) {
          if (['checkRemote', 'sync', 'publish'].includes(args.job.action)) assert.equal(args.password === 'oauth-fixture-token', true, 'Git uses the replacement grant');
          args = { ...args, profile: { ...args.profile, url: mobile.url } };
        }
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
      return { error: error.gitDetail ? { message: error.message, gitDetail: error.gitDetail } : error.message };
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
    // Navigation can reapply session-local emulation; check the reopened WebView too.
    await setViewport(page.viewport());
  };
  const noOverflow = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, label + ' must fit viewport');
  const gestureClient = await page.createCDPSession();
  const setViewport = async viewport => {
    await page.setViewport(viewport);
    // The gesture session also owns a metrics override. Update both owners before
    // business input, not just before/after screenshots, without reloading the app.
    await configureGestureEmulation(page, gestureClient, {
      ...viewport, mobile:!!viewport.isMobile, hasTouch:!!viewport.hasTouch,
    });
    await page.waitForFunction(({ width, height }) =>
      Math.abs(innerWidth - width) <= 1 && Math.abs(innerHeight - height) <= 1
      && (document.compatMode !== 'CSS1Compat' || (
        Math.abs(document.documentElement.clientWidth - width) <= 1
        && Math.abs(document.documentElement.clientHeight - height) <= 1))
      && Math.abs((visualViewport?.scale ?? 0) - 1) <= .06,
    {}, viewport);
  };
  const screenshot = async (name, fullPage = true) => {
    await page.evaluate(async () => { window.scrollTo(0, 0); await document.fonts.ready; for (const animation of document.getAnimations()) { if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) { try { animation.finish(); } catch {} } } await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.screenshot({ path: join(screenshots, name + '.png'), fullPage });
    // CDP activates mobile touch without reloading the fixture or losing dialogs.
    // Keep these actual synthetic inputs distinct from viewport-only screenshots.
    const viewport = page.viewport();
    if (process.env.STUDIO_TEST_GESTURES === 'true' && viewport && viewport.width <= 844) {
      const record = { name, viewport, findings:[], evidence:'Chromium synthetic touch + mocked Tauri IPC; not OS WebView or hardware' };
      nativeGestureRecords.push(record);
      try {
        record.afterScreenshot = await inspectGestureEnvironment(page);
        await configureGestureEmulation(page, gestureClient, { ...viewport, mobile:true, hasTouch:true });
        record.beforeGestures = await inspectGestureEnvironment(page);
        const actual = record.beforeGestures;
        if (Math.abs(actual.layout.width-viewport.width)>1 || Math.abs(actual.layout.height-viewport.height)>1 || Math.abs((actual.visual?.scale ?? 0)-1)>.06) {
          record.findings.push({type:'unexpected-gesture-viewport',expected:{width:viewport.width,height:viewport.height,scale:1},actual:{layout:actual.layout,visual:actual.visual}});
        }
        if (actual.maxTouchPoints < 1) record.findings.push({type:'touch-emulation-unavailable',maxTouchPoints:actual.maxTouchPoints});
        // Independent exercises preserve pinch coverage even if scroll setup/input fails.
        for (const [phase, exercise] of [
          ['scroll', () => exerciseScroll(page, gestureClient, { touch:true })],
          ['pinch', () => exercisePinch(page, gestureClient)],
        ]) {
          try {
            record[phase] = await exercise();
            record.findings.push(...record[phase].failures.map(finding => ({phase,...finding})));
          } catch (error) {
            record.findings.push({type:'gesture-exercise-error',phase,message:error.message});
          }
        }
      } catch (error) {
        record.findings.push({type:'gesture-setup-error',message:error.message});
      } finally {
        try {
          await configureGestureEmulation(page, gestureClient, { ...viewport, mobile:!!viewport.isMobile, hasTouch:!!viewport.hasTouch });
          record.afterCleanup = await inspectGestureEnvironment(page);
        } catch (error) {
          record.findings.push({type:'gesture-cleanup-error',message:error.message});
        }
        record.status = record.findings.length ? 'failed' : 'passed';
        await fs.writeFile(join(screenshots, 'gesture-report.json'), JSON.stringify(nativeGestureRecords, null, 2));
      }
      // Findings remain failures, but must not hide later native business/gesture coverage.
      if (record.findings.length) console.error(`Native synthetic gesture findings: ${name} (${record.findings.length}); continuing fixture.`);
    }
  };
  async function auditNativePage(name) {
    const originalViewport = page.viewport();
    for (const { width, height, screenshot: capture } of await auditViewports(page)) {
      await setViewport({ ...originalViewport, width, height });
      if (capture) await screenshot(`audit-${name}-${width}`, false);
      await noOverflow(`${name} ${width}x${height}`);
    }
    await setViewport(originalViewport);
  }
  await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(origin, { waitUntil: 'networkidle0' }); await heading('连接创作工作区');
  assert.equal(runtimeChunks.some(name => loadedScripts.has(name)), false, 'Connection screen must not load the Git/content runtime before opening a workspace');
  assert.equal(await page.$$('.workspace-record').then(records => records.length), 2, 'Git and service records share the initial chooser');
  assert.equal(await page.$('.connection-form-fields'), null, 'saved workspaces start at the chooser');
  await page.evaluate(() => [...document.querySelectorAll('.workspace-record')].find(record => record.textContent.includes('Saved Studio')).querySelector('button').click());
  assert.equal(await page.$eval('input[placeholder="https://studio.example.com"]', input => input.value), 'https://studio.example.test');
  await page.waitForSelector('.connection-form-fields button[type=submit]:focus');
  assert.ok(await page.$eval('.native-connect form', form => form.getBoundingClientRect().bottom <= document.querySelector('.workspace-chooser').getBoundingClientRect().top));
  const recordAction = async (id, text) => {
    const record = `[data-workspace-id="${id}"]`;
    if (text !== '恢复记录' && !await page.$(`${record} .record-management[open]`)) {
      await page.click(`${record} .record-management > summary`);
    }
    const buttons = await page.$$(`${record} button`);
    for (const button of buttons) {
      if (await button.evaluate((node, label) => node.textContent.trim() === label && !node.disabled, text)) {
        await button.click();
        return;
      }
    }
    throw new Error('Missing record action: ' + text);
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
  await screenshot('connection-git-desktop'); await auditNativePage('git'); await noOverflow('desktop connection');
  await click('本地文件夹'); await screenshot('connection-folder-desktop'); await auditNativePage('folder');
  await page.click('.folder-picker');
  assert.equal(await page.$('.selected-repository'), null, 'cancelled picker does not select a folder');
  selectedFolder = localRoot; await page.click('.folder-picker'); await page.waitForSelector('.selected-repository');
  await click('本地文件夹');
  assert.ok(await page.$('.selected-repository'), 'Reselecting the active mode preserves the unsaved folder');
  await screenshot('connection-folder-selected-desktop');
  await page.click('.connection-options summary'); await screenshot('connection-folder-options-desktop');
  await setViewport({width:390,height:844}); await screenshot('connection-folder-options-mobile'); await noOverflow('local folder options');
  await setViewport({width:1440,height:1000});
  await click('打开工作区'); await heading('今天，写点什么？');
  assert.ok(runtimeChunks.some(name => loadedScripts.has(name)), 'Opening a workspace loads the deferred native runtime');
  await click('动态'); await page.waitForSelector('.thread-composer textarea');
  assert.equal(await page.$eval('.thread-composer .save-button-main', e => e.textContent), '保存动态', 'folder without an HTTPS remote offers a file save');
  await click('工作区同步'); await page.waitForSelector('.workspace-status-grid');
  assert.equal(await page.$$eval('button', buttons => buttons.find(b => b.textContent.trim() === '同步 Git').disabled), true, 'local repository without a remote disables sync');
  await click('切换工作区'); await heading('连接创作工作区');
  assert.equal(await page.$('.studio-shell'), null, 'switch tears down the previous App before choosing another workspace');
  assert.equal(await page.$$('.workspace-record').then(records => records.length), 3, 'local, clone and service records coexist');
  await click('远程仓库');

  await click('连接自建创作中心'); await page.waitForSelector('input[placeholder="https://studio.example.com"]'); await screenshot('connection-remote-desktop'); await auditNativePage('service');
  await setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('connection-remote-mobile'); await noOverflow('mobile remote connection');
  await click('远程仓库'); await screenshot('connection-git-mobile'); await noOverflow('mobile Git connection');
  await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await click('打开工作区'); await heading('今天，写点什么？'); await page.waitForFunction(() => Number(document.querySelector('.stat-card strong')?.textContent) > 0);
  await screenshot('dashboard-desktop'); await noOverflow('desktop dashboard');
  await setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('dashboard-mobile'); await noOverflow('mobile dashboard');
  await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  for (const [label, name, ready] of [['动态', 'threads', '.thread-composer textarea'], ['话题管理', 'topics', '.localized-library'], ['站点信息', 'site-settings', '.settings-grid']]) {
    await click(label); await heading(label);
    if (name !== 'topics') await page.waitForSelector(ready);
    await screenshot(name + '-desktop'); await noOverflow(name + ' desktop');
    await setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot(name + '-mobile'); await noOverflow(name + ' mobile');
    await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
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
  await page.focus('.save-button-toggle');
  await page.keyboard.press('Tab');
  const nextAfterSave = await page.evaluateHandle(() => document.activeElement);
  await page.click('.save-button-toggle');
  await page.waitForSelector('.save-mode-menu [role=radio]:focus');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  await page.waitForSelector('.save-mode-menu', { hidden: true });
  assert.equal(await page.$eval('.save-button-toggle', button => button === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.save-mode-menu [role=radio]:focus');
  await page.keyboard.press('Tab');
  await page.waitForSelector('.save-mode-menu', { hidden: true });
  assert.ok(await nextAfterSave.evaluate(node => node === document.activeElement), 'forward exit follows the opener in document order');
  await nextAfterSave.dispose();
  await page.click('.save-button-toggle'); await page.waitForSelector('.save-mode-menu');
  await page.waitForFunction(() => document.activeElement?.matches('.save-mode-menu [value=local]'));
  assert.ok(await page.evaluate(() => {
    const before = document.activeElement;
    return before.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }))
      && document.activeElement === before;
  }), 'modified arrow remains available to the browser');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.matches('.save-mode-menu [value=branch][aria-checked=true]'));
  assert.equal(await page.$$eval('.save-mode-menu [role=radio]', items => items.filter(item => item.tabIndex === 0).length), 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.save-mode-default')), true);
  await page.keyboard.press('Enter');
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
    await setViewport({width,height});
    await page.click('.save-button-toggle'); await page.waitForSelector('.save-mode-menu');
    await screenshot(`save-menu-${width}`); await noOverflow('save menu');
    assert.equal(await page.$eval('.save-mode-menu', e => { const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight; }), true);
    await page.keyboard.press('Escape');
  }
  await setViewport({width:1440,height:1000});
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
  await heading('今天，写点什么？');
  assert.equal(reviewClaims.has(profile.id), true, 'Reload reuses the existing workspace claim');
  await screenshot('connection-reload-restored');
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
  const firstTile = '.media-card[data-media-path="public/uploads/example.png"]';
  const mediaThumbnail = firstTile + ' img';
  const waitForThumbnail = () => page.waitForFunction(selector => {
    const image = document.querySelector(selector);
    return image?.complete && image.naturalWidth > 0 && image.src.startsWith('blob:');
  }, {}, mediaThumbnail);
  await click('媒体库'); await waitForThumbnail();
  await page.waitForFunction(() => new Promise(resolve => {
    const open = indexedDB.open('wondershine-media-thumbnails', 1);
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('thumbnails')) { db.close(); resolve(false); return; }
      const cursor = db.transaction('thumbnails', 'readonly').objectStore('thumbnails').openCursor();
      cursor.onsuccess = () => {
        db.close();
        resolve(cursor.result?.value.bytes instanceof ArrayBuffer && cursor.result.value.bytes.byteLength > 0);
      };
      cursor.onerror = () => { db.close(); resolve(false); };
    };
  }));
  let snapshotTimeout;
  try {
    await Promise.race([mediaSnapshotWritten, new Promise((_, reject) => {
      snapshotTimeout = setTimeout(() => reject(new Error('Media snapshot was not persisted')), 10000);
    })]);
  } finally { clearTimeout(snapshotTimeout); }
  assert.ok(mediaDirectoryReads > 0 && thumbnailSourceReads > 0 && thumbnailSourceStats > 0,
    'The initial media visit scans, checks and reads the thumbnail source');
  const beforeMediaReopen = { directories: mediaDirectoryReads, sourceReads: thumbnailSourceReads };
  await restartNativeFixture(); await heading('连接创作工作区'); await click('打开工作区'); await heading('今天，写点什么？');
  const beforeMediaVisit = thumbnailSourceStats;
  await click('媒体库'); await waitForThumbnail();
  assert.deepEqual({ directories: mediaDirectoryReads, sourceReads: thumbnailSourceReads }, beforeMediaReopen,
    'Reopening the App reuses the media metadata and thumbnail without enumerating or reading the original');
  assert.equal(thumbnailSourceStats, beforeMediaVisit, 'The cached thumbnail does not check the original');
  await screenshot('media-desktop');
  await page.click(firstTile);
  await page.waitForFunction(() => {
    const image = document.querySelector('.media-details[open] img');
    return image?.src.includes('/__asset/') && image.complete && image.naturalWidth > 0;
  });
  assert.ok(thumbnailSourceStats > beforeMediaVisit, 'Opening the original still checks the current file');
  await screenshot('media-preview-desktop');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.media-details[open]', { hidden: true });
  let releaseWorkspaceRead;
  workspaceReadGate = new Promise(resolve => { releaseWorkspaceRead = resolve; });
  try {
    await click('工作区同步');
    await page.waitForSelector('.workspace-panel .loading-skeleton', { visible: true });
    assert.equal(await page.$('.workspace-status-grid'), null, 'Workspace counts are pending during the Git scan');
    await screenshot('workspace-loading-desktop', false);
    await setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('workspace-loading-mobile', false);
    await noOverflow('mobile workspace skeleton');
  } finally {
    releaseWorkspaceRead();
    await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  }
  await page.waitForSelector('.workspace-status-grid');
  await page.waitForSelector('.workspace-panel .loading-skeleton', { hidden: true });
  await screenshot('workspace-desktop'); await auditNativePage('workspace'); await noOverflow('desktop workspace');
  await setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('workspace-mobile'); await noOverflow('mobile workspace');
  await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await click('客户端 API 设置'); await heading('客户端 API 设置');
  await page.waitForSelector('.native-ai-settings form');
  const fillSetting = async (label, value) => {
    const input = await page.evaluateHandle(label => [...document.querySelectorAll('.native-ai-settings label')].find(node => node.querySelector('span')?.textContent === label)?.querySelector('input'), label);
    try {
      await input.type(value);
      assert.equal(await input.evaluate((node, expected) => node.value === expected, value), true, `After input: ${label} input retained expected value`);
    } finally {
      await input.dispose();
    }
  };
  const apiSettings = [
    ['API 地址', 'http://127.0.0.1:18361/v1'],
    ['文本模型', 'fixture-text'],
    ['图片模型（可选）', 'fixture-image'],
    ['API Key', 'browser-fixture-secret'],
  ];
  for (const [label, value] of apiSettings) await fillSetting(label, value);
  const beforeApiSubmit = await page.evaluate(settings => ({
    retained: settings.map(([label, expected]) => [...document.querySelectorAll('.native-ai-settings label')].find(node => node.querySelector('span')?.textContent === label)?.querySelector('input')?.value === expected),
    valid: document.querySelector('.native-ai-settings form')?.checkValidity() === true,
  }), apiSettings);
  for (const [index, [label]] of apiSettings.entries()) assert.equal(beforeApiSubmit.retained[index], true, `Before submit: ${label} input retained expected value`);
  assert.equal(beforeApiSubmit.valid, true, 'Before submit: API settings form passed validity checks');
  await click('保存 API 配置'); await page.waitForSelector('.native-ai-settings .notice.success');
  assert.equal(await page.$eval('.native-ai-settings input[type="password"]', input => input.value), '');
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('browser-fixture-secret')), false);
  await screenshot('api-settings-desktop'); await auditNativePage('api-settings');
  await setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('api-settings-mobile'); await noOverflow('mobile API settings');
  await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.select('.language-switcher select', 'en'); await heading('Client API settings');
  assert.match(await page.$eval('.native-ai-settings .notice.success', node => node.textContent), /Local configuration saved/, 'existing feedback follows the selected language');
  await screenshot('api-settings-en-desktop'); await noOverflow('English API settings');
  await setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('api-settings-en-mobile'); await noOverflow('English mobile API settings');
  await setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.select('.language-switcher select', 'zh-CN'); await heading('客户端 API 设置');
  await click('清除密钥'); await page.waitForFunction(() => document.querySelector('.native-ai-settings')?.textContent.includes('尚未配置密钥'));
  await restartNativeFixture(); await heading('连接创作工作区');
  await click('打开工作区'); await heading('今天，写点什么？');
  await click('客户端 API 设置'); await page.waitForSelector('.native-ai-settings form');
  assert.equal(await page.$eval('.native-ai-settings input[type="url"]', input => input.value), 'http://127.0.0.1:18361/v1');
  assert.ok(await page.$eval('.native-ai-settings', node => node.textContent.includes('尚未配置密钥')));
  const logout = '#studio-navigation .sidebar-bottom button[aria-label="退出登录"]';
  await page.waitForFunction(selector => {
    const button = document.querySelector(selector);
    if (!button || button.disabled || button.closest('[inert], [hidden], details:not([open])')) return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
      && rect.right <= document.documentElement.clientWidth && rect.bottom <= document.documentElement.clientHeight
      && button.contains(hit);
  }, { polling:'raf' }, logout);
  await page.locator(logout).click(); await heading('连接创作工作区');
  assert.equal(await page.$('.studio-shell'), null);
  assert.ok(offlineRequests.length > 0, 'Opening the HTTPS checkout checks for updates');
  assert.deepEqual([...new Set(offlineRequests.map(([method, url]) => method + ' ' + url))],
    ['GET ' + profile.url + '/info/refs?service=git-upload-pack'], 'Offline startup only attempts read-only Git discovery');
  dismissNextDialog = true;
  await recordAction(profile.id, '删除记录');
  assert.ok(await page.$(`.workspace-record[data-workspace-id="${profile.id}"]`), 'cancelling deletion keeps the record');
  await recordAction(profile.id, '删除记录');
  await page.waitForFunction(id => !document.querySelector(`[data-workspace-id="${id}"]`), {}, profile.id);
  assert.ok(await fs.stat(root), 'deleting the connection record preserves the checkout');
  assert.ok(await page.evaluate(key => localStorage.getItem(key), recoveryKey), 'deleting the record preserves drafts');
  await page.evaluate(()=>localStorage.setItem('wondershine.native.workspaces.v1','[]'));
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
  await setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.reload({waitUntil:'networkidle0'});await heading('连接创作工作区');
  assert.equal(await page.$('.connection-modes'), null, 'Mobile omits the single repository mode');
  await page.waitForSelector('.connection-url input', { visible: true });
  await click('连接自建创作中心'); await page.waitForSelector('input[placeholder="https://studio.example.com"]');
  await click('返回仓库连接'); await page.waitForSelector('.connection-url input');
  assert.equal(await page.$('.folder-picker'), null, 'Returning from remote service uses the mobile repository URL mode');

  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await restartNativeFixture(); await heading('连接创作工作区');
  assert.equal(await page.$eval('html', node => node.dataset.nativeMobile), 'true');
  assert.doesNotMatch(await page.$eval('meta[name=viewport]', node => node.content), /maximum-scale=1|user-scalable=no/);
  assert.equal(await page.evaluate(() => {const event = new Event('gesturestart', {cancelable:true}); document.dispatchEvent(event); return event.defaultPrevented;}), false, 'Intentional magnification is not cancelled');
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
      await setViewport({width:390,height:430,isMobile:true,hasTouch:true});
      await page.waitForFunction(() => parseFloat(document.documentElement.style.getPropertyValue('--native-visible-height')) < 500);
      assert.ok(await page.$eval('.oauth-dialog', node => node.getBoundingClientRect().bottom <= visualViewport.height + visualViewport.offsetTop + 1), 'Repository picker fits visible keyboard viewport');
      await screenshot('oauth-keyboard-' + provider.toLowerCase());
      await setViewport({width:390,height:844,isMobile:true,hasTouch:true});
      await page.click('.oauth-repository'); await page.waitForFunction(() => !document.querySelector('.oauth-dialog'));
      assert.equal(await page.$eval('.connection-url input', node => node.value), `https://${provider === 'GitHub' ? 'github.com' : 'cnb.cool'}/fixture-writer/blog.git`);
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('oauth-fixture-token')), false);
    }
    allowOAuthHttp = false;
    await click('连接自建创作中心');
    await click('返回仓库连接');
  }
  await page.waitForSelector('.connection-url input');
  const submoduleOption = '.connection-form-fields input[type=checkbox]';
  assert.equal(await page.$eval(submoduleOption, input => input.checked), false);
  for (const [width, height, name] of [[390, 844, 'iphone'], [430, 932, 'iphone-large'], [768, 1024, 'ipad'], [844, 390, 'landscape'], [375, 667, 'compact']]) {
    await setViewport({ width, height, isMobile: true, hasTouch: true });
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
  await setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await screenshot('connection-first-launch-mobile');
  await page.click('.connection-options summary');await screenshot('connection-options-mobile');await noOverflow('mobile connection options');
  await page.select('.language-switcher select','en');await screenshot('connection-options-en-mobile');await noOverflow('English connection options');
  // Download an actual temporary Git repository through the native HTTP adapter.
  console.log('PASS: offline native UI; starting real clone fixture.');
  await page.select('.language-switcher select','zh-CN');
  await page.type('.connection-url input',mobile.url);
  assert.equal(await page.$eval('input[placeholder="自动识别默认分支"]', input => input.value), '');
  assert.equal(await page.$eval('input[placeholder="自动识别默认分支"]', input => input.required), false);
  if (!await page.$eval('.connection-options', node => node.open)) await page.click('.connection-options summary');
  await page.type('.connection-fields input[type=password]', 'fixture-token');
  await page.click('.connection-options summary');
  allowCloneHttp = true; failNextHttp = true;
  await click('下载并开始创作'); await page.waitForSelector('[role=alert]');
  assert.equal(await page.$('.connection-progress'),null,'failed connection removes stale progress');
  await page.click('.native-connect [role=alert] .error-more');
  await page.waitForSelector('.error-dialog[open]');
  assert.match(await page.$eval('.error-dialog textarea', node => node.value), /libgit2 fetch/);
  await screenshot('error-details-mobile', false);
  await noOverflow('Mobile error report');
  await page.click('.error-actions .secondary');
  await page.waitForFunction(() => !document.querySelector('.error-dialog[open]'));
  await screenshot('clone-error-mobile'); console.log('PASS: clone error releases connection state.');
  await page.click('.connection-options summary');
  await page.click(submoduleOption);
  await page.click('.connection-options summary');
  assert.equal(await page.$eval(submoduleOption, input => input.checked), true);
  downloadGate = new Promise(resolve => { releaseDownload = resolve; });
  checkoutGate = new Promise(resolve => { releaseCheckout = resolve; });
  await click('下载并开始创作'); await page.waitForSelector('.connection-progress progress');
  assert.equal(await page.$eval('.connection-progress progress', el => el.hasAttribute('value')),false);
  await screenshot('clone-connecting-mobile'); await noOverflow('connecting repository');
  console.log('PASS: indeterminate connection progress.'); releaseDownload();
  await page.waitForSelector('.connection-progress progress[value]',{timeout:20000});
  for(const [width,height,name] of [[1440,1000,'desktop'],[1024,768,'medium'],[390,844,'mobile']]){
    await setViewport({width,height,isMobile:true,hasTouch:true});await screenshot('clone-progress-'+name);await noOverflow('clone progress '+name);
  }
  await page.select('.language-switcher select','en');await screenshot('clone-progress-en-mobile');
  console.log('PASS: real clone progress at three widths.'); releaseCheckout();await heading('What will you write today?');
  const saved = await page.evaluate(()=>JSON.parse(localStorage.getItem('wondershine.native.workspaces.v1')));
  assert.equal(saved[0].branch,'release/blog');
  const phoneRepo = join(appData, 'workspaces', saved[0].id, 'repo');
  const phoneGit = (...args) => execFileSync('git', ['-C', phoneRepo, ...args]).toString().trim();
  assert.equal(phoneGit('branch', '--show-current'), 'release/blog');
  assert.equal(phoneGit('rev-parse', '--is-shallow-repository'), 'true');
  assert.equal(phoneGit('rev-list', '--count', 'HEAD'), '1');
  assert.equal(await fs.readFile(join(phoneRepo, themePath, 'theme.txt'), 'utf8'), 'Pinned theme');
  await page.select('.language-switcher select', 'zh-CN');
  assert.ok([...keyring.values()].some(secret => JSON.parse(secret).token === 'fixture-token'));
  assert.ok(!await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-token')));
  allowCloneHttp = false;
  await page.evaluate(() => localStorage.setItem('studio-appearance', JSON.stringify({ 'extra.style.color_scheme': 'dark' })));
  let finishResume;
  resumeGate = new Promise(resolve => { finishResume = resolve; });
  try {
    await restartNativeFixture();
    await page.waitForSelector('.native-connect .loading-panel', { visible: true });
    const backgrounds = await page.evaluate(() => ['html', '.native-shell-connecting', '.native-connect'].map(
      selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
    assert.deepEqual(backgrounds, Array(3).fill('rgb(24, 23, 29)'), 'Every full-screen layer stays dark while the checkout opens');
    await page.screenshot({ path: join(screenshots, 'phone-dark-workspace-resume.png') });
  } finally {
    finishResume();
    resumeGate = undefined;
  }
  await heading('今天，写点什么？');
  await page.waitForSelector('.thread-composer textarea');
  assert.equal(await page.$eval('html', node => node.dataset.theme), 'dark', 'The restored workspace keeps the startup appearance');
  assert.equal(await page.$('.native-connect'), null, 'A cold phone launch reopens the last checkout offline');
  await page.evaluate(() => localStorage.removeItem('studio-appearance'));
  const claimsBeforeReload = [...reviewClaims];
  await page.reload({ waitUntil: 'networkidle0' });
  await heading('今天，写点什么？');
  await page.waitForSelector('.thread-composer textarea');
  assert.deepEqual([...reviewClaims], claimsBeforeReload, 'Mobile reload resumes without new recovery claims');
  await page.click('.visit-site');
  await page.waitForFunction(() => !!document.querySelector('.topbar button.navigation-refresh[aria-disabled=false][aria-label="同步 Git 并刷新当前内容"]'));
  await Promise.race([openedSite, new Promise((_, reject) => { const deadline = setTimeout(() => reject(new Error('Native URL handler did not receive the site URL')), 5000); deadline.unref(); })]);
  await screenshot('phone-composer', false);
  assert.ok(await page.$eval('.composer-tools .choice-compact .choice-trigger', button => {
    const icon = button.querySelector('svg').getBoundingClientRect();
    const label = button.querySelector('span[id]').getBoundingClientRect();
    return icon.right <= label.left + 1 && Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2) < 2;
  }), 'The mobile tag label is aligned to the right of its icon');
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
  await page.$eval('.publish-dialog > details', node => { node.open = true; });
  await page.$eval('.publish-credential', node => { node.open = true; });
  await screenshot('phone-publish-review', false);
  assert.ok(await page.$eval('.publish-dialog', node => node.scrollWidth <= node.clientWidth));
  assert.ok(await page.$eval('.publish-credential input', node => node.getBoundingClientRect().height >= 44));
  await auditNativePage('publish-review');
  await click('稍后');
  assert.equal(await page.$('dialog.publish-dialog[open]'), null);
  assert.equal(await page.$eval('.thread-composer textarea', input => input.value), 'Phone publication fixture');
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
  await page.waitForFunction(() => document.querySelector('.thread-composer textarea')?.value === '' && document.querySelector('.composer-initial-language'));
  await screenshot('phone-composer-after-publish', false);
  const syncArticle = 'content/articles/quick-sync-fixture/index.md';
  await fs.mkdir(join(phoneRepo, 'content/articles/quick-sync-fixture'), { recursive: true });
  const syncBody = '+++\ntitle = "Navigation sync article"\ndate = 2030-01-01\n+++\nBody';
  await fs.writeFile(join(phoneRepo, syncArticle), syncBody);
  execFileSync('git', ['-C', phoneRepo, 'add', syncArticle]);
  execFileSync('git', ['-C', phoneRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', 'commit', '-m', 'Quick sync fixture']);
  assert.equal(await page.$$eval('.topbar .navigation-refresh', buttons => buttons.length), 1);
  await page.locator('.topbar .navigation-refresh[aria-disabled=false][aria-label="同步 Git 并刷新当前内容"]').click();
  await page.waitForFunction(() => document.querySelector('.quick-sync-progress')?.textContent.includes('分支已同步'));
  assert.equal(execFileSync('git', [...remoteArgs, 'log', '-1', '--format=%s', 'release/blog']).toString().trim(), 'Quick sync fixture');
  await page.waitForSelector('.quick-sync-progress', { hidden: true });
  await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Navigation sync article'));
  await fs.writeFile(join(phoneRepo, syncArticle), syncBody.replace('Navigation sync article', 'Local refresh without a commit'));
  await page.locator('.topbar .navigation-refresh[aria-disabled=false]').click();
  await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Local refresh without a commit'));
  assert.equal(phoneGit('log', '-1', '--format=%s'), 'Quick sync fixture');
  await fs.writeFile(join(phoneRepo, syncArticle), syncBody);
  await click('切换工作区'); await heading('连接创作工作区');
  assert.equal(await page.$('.studio-shell'), null, 'Explicit switching leaves the chooser open');
  await click('添加工作区');
  assert.equal(await page.$eval(submoduleOption, input => input.checked), false);
  await page.type('.connection-url input', mobile.url);
  await click('下载并开始创作'); await heading('今天，写点什么？');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wondershine.native.workspaces.v1')).map(item => item.id)), [saved[0].id], 'adding the same mobile repository reopens its original checkout');
  await click('站点信息'); await page.waitForSelector('.settings-card input');
  assert.deepEqual(await page.$$eval('.settings-card input:not([type=checkbox]):not([type=radio]):not([type=color]), .settings-card select, .settings-card textarea', fields => fields.filter(node => node.getClientRects().length && (parseFloat(getComputedStyle(node).fontSize) < 16 || node.getBoundingClientRect().height < 44)).map(node => node.outerHTML.slice(0,80))), [], 'Native iOS settings retain readable editing size and touch targets');
  await screenshot('settings-iphone'); await noOverflow('iPhone settings');
  const legacyHead = git(['rev-parse','HEAD']);
  assert.equal(await mobile.invoke({ profile,job:{ action:'open',clone:false } }),profile.branch);
  assert.equal(git(['rev-parse','HEAD']),legacyHead,'Upgrading the earlier isomorphic-git checkout preserves its commits');
  // Exercise direct publication to main independently of the detected release/blog branch.
  const mainProfile = { ...saved[0], id: crypto.randomUUID(), branch: 'main' };
  await fs.mkdir(join(appData, 'workspaces', mainProfile.id, 'state'), { recursive: true });
  await mobile.invoke({ profile: mainProfile, job: { action: 'open', clone: true } });
  await assert.rejects(fs.stat(join(appData, 'workspaces', mainProfile.id, 'repo', themePath, 'theme.txt')), { code: 'ENOENT' });
  assert.deepEqual(await mobile.invoke({ profile: mainProfile, job: { action: 'checkRemote' } }), { ahead: 0, behind: 0 });
  assert.equal(execFileSync('git', ['-C', join(appData, 'workspaces', mainProfile.id, 'repo'), 'rev-parse', '--is-shallow-repository']).toString().trim(), 'true');
  const conflictRefs = await mobile.verifySync(mainProfile);
  const mainKey = 'git-' + createHash('sha256').update(JSON.stringify([mainProfile.id, mainProfile.url, mainProfile.provider, mainProfile.username])).digest('hex');
  keyring.set(mainKey, JSON.stringify({ token: 'fixture-token' }));
  await page.evaluate(profile => localStorage.setItem('wondershine.native.workspaces.v1', JSON.stringify([profile])), mainProfile);
  await restartNativeFixture();
  await heading('今天，写点什么？');
  await click('工作区同步');
  await click('同步 Git');
  await click('确认执行');
  await page.waitForSelector('.workspace-panel [role=alert]');
  await screenshot('workspace-merge-conflict-mobile', false);
  await click('处理合并冲突');
  const resolver = '.workspace-confirm[open]';
  await page.waitForSelector(resolver + ' .merge-file select');
  assert.equal(await page.$eval(resolver + ' .publish-actions .primary', button => button.disabled), true);
  await page.select(resolver + ' .merge-file select', 'remote');
  await screenshot('workspace-merge-review-mobile', false);
  await click('保存合并结果');
  await page.waitForFunction(() => document.querySelector('.workspace-panel .notice')?.textContent.includes('冲突已合并到本地'));
  const mainRepo = join(appData, 'workspaces', mainProfile.id, 'repo');
  const parents = execFileSync('git', ['-C', mainRepo, 'log', '-1', '--format=%P']).toString().trim();
  assert.equal(parents, conflictRefs.head + ' ' + conflictRefs.remote);
  assert.equal(await fs.readFile(join(mainRepo, 'data.toml'), 'utf8'), 'title="remote change"');
  assert.equal(execFileSync('git', [...remoteArgs, 'rev-parse', 'main']).toString().trim(), conflictRefs.remote);


  await click('清空待推送记录');
  await page.waitForSelector('.workspace-confirm[open]');
  await screenshot('workspace-uncommit-review', false);
  await click('取消');
  assert.equal(execFileSync('git', ['-C', mainRepo, 'log', '-1', '--format=%P']).toString().trim(), parents);
  await click('清空待推送记录');
  await click('确认执行');
  await page.waitForFunction(() => document.querySelector('.workspace-panel .notice')?.textContent.includes('待推送记录已清空'));
  assert.equal(execFileSync('git', ['-C', mainRepo, 'rev-parse', 'HEAD']).toString().trim(), conflictRefs.remote);
  assert.equal(await fs.readFile(join(mainRepo, 'data.toml'), 'utf8'), 'title="remote change"');

  if (process.env.STUDIO_TEST_OAUTH === 'fixture') {
    const cnb = { ...saved[0], id: crypto.randomUUID(), label: 'CNB fixture', provider: 'cnb', username: cnbUsername, url: cnbRemote };
    const cnbRepo = join(appData, 'workspaces', cnb.id, 'repo');
    // Keep the real mobile Git engine on the fixture remote behind the mocked IPC boundary.
    await fs.cp(phoneRepo, cnbRepo, { recursive: true });
    const key = 'git-' + createHash('sha256').update(JSON.stringify([cnb.id, cnb.url, cnb.provider, cnb.username])).digest('hex');
    const expired = JSON.stringify({ token: 'expired-fixture', expiresAt: 1, clientId: 'studio-ci-cnb' });
    const registryKey = 'wondershine.native.workspaces.v1';
    const records = [cnb, ...saved];
    await page.evaluate((key, records) => localStorage.setItem(key, JSON.stringify(records)), registryKey, records);
    allowOAuthHttp = reauthorizing = true;
    const reopenWithExpiredGrant = async () => {
      keyring.set(key, expired);
      await restartNativeFixture();
      await heading('今天，写点什么？');
      await page.waitForSelector('.topbar button.navigation-refresh[aria-disabled=false][aria-label="同步 Git 并刷新当前内容"]');
    };
    const startReauthorization = async () => {
      oauthApproved = false;
      await page.waitForSelector('.account-reauthorize button:not(:disabled)', { visible: true });
      await page.click('.account-reauthorize button');
      await page.waitForSelector('.oauth-dialog[open] .oauth-code');
    };
    const finishReauthorization = async () => {
      oauthApproved = true;
      await page.waitForSelector('.oauth-dialog', { hidden: true });
      const grant = JSON.parse(keyring.get(key));
      assert.ok(grant.token === 'oauth-fixture-token' && grant.refreshToken === 'oauth-fixture-refresh');
      assert.ok(grant.expiresAt > Date.now() && grant.refreshExpiresAt > grant.expiresAt);
    };
    const commitOffline = message => execFileSync('git', ['-C', cnbRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-m', message]);
    const remoteHead = () => execFileSync('git', [...remoteArgs, 'log', '-1', '--format=%s', cnb.branch]).toString().trim();

    await reopenWithExpiredGrant();
    commitOffline('CNB quick sync after reauthorization');
    await page.locator('.topbar .navigation-refresh[aria-disabled=false][aria-label="同步 Git 并刷新当前内容"]').click();
    await page.waitForFunction(() => document.querySelector('.quick-sync-progress .account-reauthorize button') && !document.querySelector('.quick-sync-progress [role=alert]'));
    await screenshot('cnb-quick-sync-expired', false);
    await startReauthorization();
    cnbUsername = 'another-fixture-account'; oauthApproved = true;
    await page.waitForFunction(() => document.querySelector('.oauth-dialog [role=alert]')?.textContent.includes('原来的 Git 账号'));
    assert.equal(keyring.get(key) === expired, true, 'A different account leaves the saved grant alone');
    cnbUsername = cnb.username;
    await click('重新登录');
    await finishReauthorization();
    assert.notEqual(remoteHead(), 'CNB quick sync after reauthorization', 'Signing in alone does not push');
    await click('重试同步');
    await page.waitForFunction(() => document.querySelector('.quick-sync-progress')?.textContent.includes('分支已同步'));
    assert.equal(remoteHead(), 'CNB quick sync after reauthorization');

    await reopenWithExpiredGrant();
    await page.waitForSelector('.thread-composer textarea');
    await page.type('.thread-composer textarea', 'CNB publication after reauthorization');
    await click('发布动态');
    await click('确认发布');
    await page.waitForSelector('.publish-dialog .account-reauthorize button');
    await screenshot('cnb-publish-expired', false);
    await startReauthorization();
    await screenshot('cnb-publish-device-authorization', false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.oauth-dialog', { hidden: true });
    assert.ok(await page.$('.publish-dialog[open]'), 'Canceling OAuth leaves the publication open');
    assert.equal(keyring.get(key) === expired, true, 'Canceling leaves the saved grant alone');
    await startReauthorization();
    await finishReauthorization();
    await page.waitForFunction(() => document.querySelector('.publish-actions .primary')?.textContent === '确认发布');
    await screenshot('cnb-publish-review-after-reauthorization', false);
    assert.equal(remoteHead(), 'CNB quick sync after reauthorization');
    await click('确认发布');
    await page.waitForFunction(() => document.querySelector('.publish-dialog h2')?.textContent === '动态已发送到仓库');
    assert.match(execFileSync('git', [...remoteArgs, 'grep', '-l', 'CNB publication after reauthorization', cnb.branch, '--', 'content/threads']).toString(), /index.*\.md/);
    await click('完成');

    await reopenWithExpiredGrant();
    commitOffline('CNB workspace sync after reauthorization');
    await click('工作区同步'); await page.waitForSelector('.workspace-status-grid');
    await page.click('.workspace-sync-actions button:nth-child(2)');
    await click('确认执行');
    await startReauthorization();
    await finishReauthorization();
    await page.waitForSelector('.workspace-panel .workspace-confirm:modal .publish-actions .primary:not(:disabled)');
    assert.notEqual(remoteHead(), 'CNB workspace sync after reauthorization');
    await click('确认执行');
    await page.waitForFunction(() => document.querySelector('.workspace-panel [role=status]')?.textContent.includes('已与 Git 远端同步'));
    assert.equal(remoteHead(), 'CNB workspace sync after reauthorization');
    await reopenWithExpiredGrant();
    await click('主题维护'); await click('检查更新'); await click('请求重新构建');
    await page.waitForSelector('.theme-progress[open] .account-reauthorize button');
    assert.equal(await page.$('.theme-progress [role=alert]'), null);
    const rebuildTip = execFileSync('git', ['-C', cnbRepo, 'rev-parse', 'HEAD']).toString().trim();
    const beforeThemeSync = remoteHead();
    await screenshot('cnb-theme-update-expired-mobile', false);
    await startReauthorization();
    await finishReauthorization();
    assert.equal(remoteHead(), beforeThemeSync);
    await page.click('.theme-progress .primary');
    await page.waitForFunction(() => document.querySelector('.theme-progress ol')?.textContent.includes('主题更新已推送'));
    assert.equal(execFileSync('git', [...remoteArgs, 'rev-parse', cnb.branch]).toString().trim(), rebuildTip, 'Retry pushes the existing theme commit');
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), registryKey), records, 'Reauthorization keeps the saved workspace and branch');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('oauth-fixture-token')), false);
  }
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []); assert.deepEqual(failedResources, []);
  assert.deepEqual(gestureFindings(), [], 'Native synthetic gesture findings (all reached mobile screenshot surfaces; see gesture-report.json)');
  console.log('Native UI passed: desktop/mobile connection modes, offline dashboard, source save, bundled Vditor, native asset preview, client API settings, secret redaction, configuration reopen, logout.');
  console.log('Screenshots: ' + screenshots);
} catch (error) {
  const diagnostics = { failure:String(error), stack:error.stack, viewport:page?.viewport(), commands:[...commands], ipcFailures, errors, cspErrors, failedResources,
    gestureCoverage:{ reachedSurfaces:nativeGestureRecords.length, findings:gestureFindings(),
      scope:'Only reached mobile screenshot surfaces; a business-flow failure can still block later surfaces.' } };
  if (page && !page.isClosed()) {
    try {
      // Capture geometry before failure.png: screenshots can alter emulated metrics.
      diagnostics.ui = await page.evaluate(() => {
        const describe = node => {
          if (!node) return null;
          const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { tag:node.tagName, rect:rect.toJSON(), display:style.display, visibility:style.visibility,
            pointerEvents:style.pointerEvents, disabled:node.matches(':disabled'), inert:!!node.closest('[inert]'),
            hidden:!!node.closest('[hidden]'), folded:!!node.closest('details:not([open])'),
            expanded:node.getAttribute('aria-expanded'), hit:hit ? {tag:hit.tagName,id:hit.id} : null,
            unobscured:node.contains(hit) };
        };
        return {
          headings: [...document.querySelectorAll('h1')].map(node => node.textContent),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
          viewport:{ layout:{width:innerWidth,height:innerHeight},
            client:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight},
            visual:visualViewport ? {width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,
              offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop} : null },
          navigation:{ sidebar:describe(document.querySelector('#studio-navigation')),
            trigger:describe(document.querySelector('.mobile-menu')),
            logout:describe(document.querySelector('.sidebar-bottom button')) },
        };
      });
    } catch (diagnosticError) { diagnostics.uiError = diagnosticError.message; }
    try { await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true }); }
    catch (diagnosticError) { diagnostics.screenshotError = diagnosticError.message; }
  }
  try {
    await fs.mkdir(screenshots, { recursive: true });
    const report = JSON.stringify(diagnostics, null, 2).replace(/browser-fixture-secret|oauth-fixture-token|oauth-fixture-refresh|expired-fixture|device-fixture|TEST-CODE/g, '[redacted]');
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
