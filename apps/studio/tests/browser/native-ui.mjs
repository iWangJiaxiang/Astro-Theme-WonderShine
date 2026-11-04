import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

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
let browser, server;
let allowOAuthHttp = false, oauthApproved = false;
let allowCloneHttp = false, failNextHttp = false, failNextBranchWrite = false;
let releaseDownload = () => {}, releaseCheckout = () => {};
let downloadGate = Promise.resolve(), checkoutGate = Promise.resolve();
let writeGate = Promise.resolve(), releaseWrite = () => {};
const requests = new Map(), responses = new Map();
let nextResource = 1;
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
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial']);
  git(['config', 'user.name', 'Folder writer']); git(['config', 'user.email', 'folder@example.test']);
  await fs.cp(root, localRoot, { recursive: true });
  execFileSync('git', ['clone', '--bare', root, join(base, 'remote.git')], {stdio:'pipe'});
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
  const page = await browser.newPage(), errors = [], cspErrors = [], failedResources = [];
  const loadedScripts = new Set();
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
  const commands = new Set();
  await page.exposeFunction('tauriInvoke', async (command, args, options) => {
    commands.add(command);
    try {
      let value;
      if (command === 'plugin:dialog|open') { value = selectedFolder; folderGranted = !!value; }
      else if (command === 'plugin:path|resolve_directory') value = appData;
      else if (command === 'plugin:fs|write_file') {
        const path = confined(decodeURIComponent(options.headers.path));
        await writeGate;
        if (failNextBranchWrite && path.includes('/.git/objects/')) { throw new Error('Simulated branch write failure'); }
        if (path.includes('.clone-') && path.endsWith('/config.toml')) await checkoutGate;
        await fs.writeFile(path, new Uint8Array(args));
      } else if (command === 'plugin:fs|rename') await fs.rename(confined(args.oldPath), confined(args.newPath));
      else if (command.startsWith('plugin:fs|')) {
        const path = confined(args.path), operation = command.split('|')[1];
        switch (operation) {
          case 'mkdir': await fs.mkdir(path, { recursive: !!args.options?.recursive }); break;
          case 'read_file': value = [...await fs.readFile(path)]; break;
          case 'read_dir': value = (await fs.readdir(path, { withFileTypes: true })).map(item => ({ name: item.name, isFile: item.isFile(), isDirectory: item.isDirectory(), isSymlink: item.isSymbolicLink() })); break;
          case 'remove': { const stat = await fs.lstat(path); if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rmdir(path); else await fs.unlink(path); break; }
          case 'stat': case 'lstat': {
            const stat = await fs[operation](path);
            value = { size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink(),
              mtime: stat.mtime.toISOString(), atime: stat.atime.toISOString(), birthtime: stat.birthtime.toISOString(),
              readonly: false, fileAttributes: null, mode: null, dev: null, ino: null, nlink: null, uid: null, gid: null, rdev: null, blksize: null, blocks: null };
            break;
          }
          default: throw new Error('Unsupported fixture FS command: ' + command);
        }
      } else if (allowOAuthHttp && command === 'plugin:opener|open_url') {
        assert.ok(/^https:\/\/(github.com\/login\/device|cnb.cool\/oauth2\/device)/.test(args.url));
      } else if (allowOAuthHttp && command.startsWith('plugin:http|')) {
        const operation = command.split('|')[1];
        if (operation === 'fetch') {
          const config = args.clientConfig, url = new URL(config.url);
          assert.ok(['https://github.com', 'https://api.github.com', 'https://cnb.cool', 'https://api.cnb.cool'].includes(url.origin));
          assert.equal(config.maxRedirections, 0, 'OAuth must disable redirects in the actual native client');
          assert.equal(new Map(config.headers).get('user-agent'), 'WonderShine-Studio');
          value = nextResource++; requests.set(value, config);
        } else if (operation === 'fetch_send') {
          const config = requests.get(args.rid), url = new URL(config.url), github = url.hostname.includes('github');
          let body;
          if (url.pathname === '/login/device/code' || url.pathname === '/oauth2/device/auth') {
            body = {device_code:'device-fixture',user_code:'TEST-CODE',expires_in:600,interval:1,verification_uri:github?'https://github.com/login/device':'https://cnb.cool/oauth2/device/verify'};
          } else if (url.pathname === '/login/oauth/access_token' || url.pathname === '/oauth2/token') {
            body = oauthApproved ? {access_token:'oauth-fixture-token',token_type:'bearer'} : {error:'authorization_pending'};
          } else {
            assert.equal(new Map(config.headers).get('authorization'), 'Bearer oauth-fixture-token');
            if (url.pathname === '/user') body = github ? {login:'fixture-writer',name:'Fixture Writer'} : {username:'fixture-writer',nickname:'Fixture Writer'};
            else if (url.pathname === '/user/repos') body = github ? [{id:1,full_name:'fixture-writer/blog',default_branch:'main',permissions:{push:true},private:false}] : [{id:'1',path:'fixture-writer/blog',visibility_level:'Public'}];
            else throw new Error('Unexpected OAuth fixture endpoint');
          }
          const rid = nextResource++; responses.set(rid, Buffer.from(JSON.stringify(body))); requests.delete(args.rid);
          value = {rid,status:200,statusText:'OK',url:config.url,headers:[['content-type','application/json']]};
        } else if (operation === 'fetch_read_body') {
          const body = responses.get(args.rid); value = body?.length ? [...body,0] : [1]; responses.delete(args.rid);
        } else if (operation === 'fetch_cancel' || operation === 'fetch_cancel_body') {
          requests.delete(args.rid); responses.delete(args.rid);
        } else throw new Error('Unexpected OAuth HTTP operation');
      } else if (allowCloneHttp && command.startsWith('plugin:http|')) {
        const operation = command.split('|')[1];
        if (operation === 'fetch') {
          const config = args.clientConfig, url = new URL(config.url);
          assert.equal(url.origin, 'https://git.example.test');
          assert.ok(['/remote.git/info/refs', '/remote.git/git-upload-pack'].includes(url.pathname));
          value = nextResource++; requests.set(value, config);
        } else if (operation === 'fetch_send') {
          await downloadGate;
          if (failNextHttp) { failNextHttp = false; requests.delete(args.rid); throw new Error('Simulated unavailable repository'); }
          const config = requests.get(args.rid), url = new URL(config.url);
          const headers = new Map(config.headers);
          const backend = join(execFileSync('git', ['--exec-path']).toString().trim(), 'git-http-backend');
          const bytes = execFileSync(backend, [], {input:Buffer.from(config.data || []), env:{...process.env,
            GIT_PROJECT_ROOT:base,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,REQUEST_METHOD:config.method,
            QUERY_STRING:url.search.slice(1),CONTENT_TYPE:headers.get('content-type')||'',REMOTE_ADDR:'127.0.0.1'}});
          const end = bytes.indexOf('\r\n\r\n'); assert.ok(end >= 0);
          const entries = bytes.subarray(0,end).toString().split('\r\n').map(line => { const colon = line.indexOf(':'); return [line.slice(0,colon),line.slice(colon+1).trim()]; });
          const rid = nextResource++; responses.set(rid, bytes.subarray(end+4));
          value = {rid,status:200,statusText:'OK',url:config.url,headers:entries};
          requests.delete(args.rid);
        } else if (operation === 'fetch_read_body') {
          const body = responses.get(args.rid);
          value = body?.length ? [...body,0] : [1]; responses.delete(args.rid);
        } else if (operation === 'fetch_cancel_body' || operation === 'fetch_cancel') {
          requests.delete(args.rid); responses.delete(args.rid);
        } else throw new Error('Unexpected HTTP operation: ' + operation);
      } else throw new Error('Unexpected native command, external HTTP is disabled: ' + command);
      return { value };
    } catch (error) { return { error: error.message }; }
  });
  await page.evaluateOnNewDocument(profile => {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] });
    if (!localStorage.getItem('wondershine.native.workspaces.v1')) localStorage.setItem('wondershine.native.workspaces.v1', JSON.stringify([profile, { id: 'a6347560-bbe9-4c35-9d89-b0429108882b', source: 'service', label: 'Saved Studio', address: 'https://studio.example.test' }]));
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}, options) => {
        const value = args instanceof Uint8Array ? Array.from(args) : args;
        const result = await window.tauriInvoke(command, value, options);
        if (result.error) throw result.error;
        return result.value;
      },
      convertFileSrc: path => location.origin + '/__asset/' + encodeURIComponent(path),
      transformCallback: () => { throw new Error('Unexpected native callback in filesystem smoke'); },
    };
  }, profile);
  const click = async text => {
    if (text === '打开工作区' && !await page.$('.connection-form-fields')) {
      await page.evaluate(() => document.querySelector('.workspace-record button')?.click());
    }
    await page.waitForFunction(text => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === text && !button.disabled), {}, text);
    await page.evaluate(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text && !button.disabled).click(), text);
  };
  const heading = text => page.waitForFunction(text => [...document.querySelectorAll('h1')].some(node => node.textContent.trim() === text), {}, text);
  const noOverflow = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, label + ' must fit viewport');
  const screenshot = async name => {
    await page.evaluate(async () => { window.scrollTo(0, 0); await document.fonts.ready; for (const animation of document.getAnimations()) { if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) { try { animation.finish(); } catch {} } } await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    return page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true });
  };
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
    assert.equal(await page.$(`.workspace-record[data-workspace-id="${id}"]`), null);
    await page.reload({waitUntil:'networkidle0'});
    await page.click('.archived-workspaces summary');
    await recordAction(id, '恢复记录');
    await page.waitForSelector(`.workspace-record[data-workspace-id="${id}"]`);
  }
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).body, recoveryKey), 'Archive recovery fixture', 'archive/restore retains the original draft identity');
  assert.ok(await fs.stat(root), 'archive/restore retains the original checkout');
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('wondershine.native.workspaces.v1')));
  assert.deepEqual(restored.find(record => record.id === profile.id), profile, 'restore preserves the complete original record and recovery ID');
  await screenshot('connection-git-desktop'); await noOverflow('desktop connection');
  await click('本地文件夹'); await screenshot('connection-folder-desktop');
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

  await click('连接自建创作中心'); await page.waitForSelector('input[placeholder="https://studio.example.com"]'); await screenshot('connection-remote-desktop');
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
  await page.reload({waitUntil:'networkidle0'}); await heading('连接创作工作区'); await click('打开工作区'); await heading('今天，写点什么？');
  await page.waitForSelector('.thread-composer .save-button-main');
  assert.equal(await page.$eval('.thread-composer .save-button-main', e => e.textContent), '分支保存 · 可发布', 'default persists across app reload');
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
  await screenshot('workspace-desktop'); await noOverflow('desktop workspace');
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
  await screenshot('api-settings-desktop');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('api-settings-mobile'); await noOverflow('mobile API settings');
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.select('.language-switcher select', 'en'); await heading('Client API settings');
  assert.match(await page.$eval('.native-ai-settings .notice.success', node => node.textContent), /Local configuration saved/, 'existing feedback follows the selected language');
  await screenshot('api-settings-en-desktop'); await noOverflow('English API settings');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await screenshot('api-settings-en-mobile'); await noOverflow('English mobile API settings');
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.select('.language-switcher select', 'zh-CN'); await heading('客户端 API 设置');
  await click('清除密钥'); await page.waitForFunction(() => document.querySelector('.native-ai-settings')?.textContent.includes('尚未配置密钥'));
  await page.reload({ waitUntil: 'networkidle0' }); await heading('连接创作工作区');
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
  await page.reload({waitUntil:'networkidle0'}); await heading('连接创作工作区');
  assert.equal(await page.$eval('html', node => node.dataset.nativeMobile), 'true');
  assert.match(await page.$eval('meta[name=viewport]', node => node.content), /maximum-scale=1/);
  assert.equal(await page.evaluate(() => {const event = new Event('gesturestart', {cancelable:true}); document.dispatchEvent(event); return event.defaultPrevented;}), true);
  assert.ok(await page.$eval('.connection-url input', node => parseFloat(getComputedStyle(node).fontSize) >= 16), 'iOS inputs avoid focus zoom');
  if (process.env.STUDIO_TEST_OAUTH === 'fixture') {
    assert.ok(await page.$eval('.account-login button', node => node.getBoundingClientRect().height >= 44));

    allowOAuthHttp = true;
    for (const provider of ['GitHub', 'CNB']) {
      oauthApproved = false;
      await click(`使用 ${provider} 登录`); await page.waitForSelector('.oauth-code');
      assert.equal(await page.$eval('.oauth-code', node => node.textContent), 'TEST-CODE');
      await screenshot('oauth-device-' + provider.toLowerCase());
      oauthApproved = true; await page.waitForSelector('.oauth-repository');
      await page.type('.oauth-dialog input', 'blog');
      await screenshot('oauth-repositories-' + provider.toLowerCase());
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
      const footer = document.querySelector('.native-update-footer').getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(main).paddingTop);
      return { top: card.top, padding, footerBottom: footer.bottom, height: document.documentElement.scrollHeight, viewport: innerHeight };
    });
    assert.ok(Math.abs(layout.top - layout.padding) <= 1, name + ': connection card starts at safe-area padding, without a centering gap');
    if (height >= 844) {
      assert.ok(layout.height <= layout.viewport + 1, name + ': first launch does not add a footer beyond the viewport');
      assert.ok(layout.footerBottom <= layout.viewport + 1, name + ': updates stay visible without scrolling');
    } else {
      await page.$eval('.native-update-footer button', node => node.scrollIntoView({ block: 'end' }));
      assert.ok(await page.$eval('.native-update-footer button', node => node.getBoundingClientRect().bottom <= innerHeight + 1), name + ': short screens retain access to updates');
      await page.evaluate(() => scrollTo(0, 0));
    }
    await screenshot('connection-first-launch-' + name); await noOverflow(name + ' first launch');
  }
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await screenshot('connection-first-launch-mobile');
  await page.click('.connection-options summary');await screenshot('connection-options-mobile');await noOverflow('mobile connection options');
  await page.select('.language-switcher select','en');await screenshot('connection-options-en-mobile');await noOverflow('English connection options');
  // Download an actual temporary Git repository through the native HTTP adapter.
  console.log('PASS: offline native UI; starting real clone fixture.');
  await page.select('.language-switcher select','zh-CN');
  await page.type('.connection-url input','https://git.example.test/remote.git');
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
  await click('站点信息'); await page.waitForSelector('.settings-card input');
  assert.deepEqual(await page.$$eval('.settings-card input:not([type=checkbox]):not([type=radio]):not([type=color]), .settings-card select, .settings-card textarea', fields => fields.filter(node => node.getClientRects().length && (parseFloat(getComputedStyle(node).fontSize) < 16 || node.getBoundingClientRect().height < 44)).map(node => node.outerHTML.slice(0,80))), [], 'Native iOS settings retain readable editing size and touch targets');
  await screenshot('settings-iphone'); await noOverflow('iPhone settings');
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []); assert.deepEqual(failedResources, []);
  console.log('Native UI passed: desktop/mobile connection modes, offline dashboard, source save, bundled Vditor, native asset preview, client API settings, secret redaction, configuration reopen, logout.');
  console.log('Screenshots: ' + screenshots);
} catch (error) {
  if (browser) { const pages = await browser.pages(); await pages.at(-1)?.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true }); }
  throw error;
} finally {
  releaseDownload(); releaseCheckout(); releaseWrite();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(base, { recursive: true, force: true });
}
