import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = {
  siteRoot: path.join(workspace, 'examples/demo'),
  pages: [
    ['home', '/'], ['article', '/articles/welcome/'],
    ['threads', '/threads/'], ['thread', '/threads/11111111-2222-4333-8444-555555555555/'],
    ['series', '/collections/field-notes/'], ['tags', '/tags/design/'], ['timeline', '/timeline/'],
    ['chinese', '/zh-CN/'],
  ],
  navigation: { path: '/articles/', language: 'zh-CN', translatedPath: '/zh-CN/articles/' },
};

export async function checkBrowser(options = demo) {
  const siteRoot = path.resolve(options.siteRoot);
  const screenshots = path.resolve(process.env.WONDERSHINE_SCREENSHOTS || options.screenshots || 'temp/browser');
  await mkdir(screenshots, { recursive: true });
  const requireSite = createRequire(path.join(siteRoot, 'package.json'));
  const astro = path.join(path.dirname(requireSite.resolve('astro/package.json')), 'bin/astro.mjs');
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [astro, 'preview', '--root', siteRoot, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: siteRoot, env: { ...process.env, ASTRO_PREVIEW_BACKGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', spawnError, browser;
  server.stderr.on('data', value => { logs += value; });
  server.stdout.on('data', value => { logs += value; });
  server.on('error', error => { spawnError = error; });
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error(`Preview exited: ${logs}`);
      try { if ((await fetch(origin)).ok) break; } catch {}
      if (attempt === 149) throw new Error(`Preview did not start: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const executablePath = process.env.STUDIO_TEST_BROWSER || [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
    ].find(existsSync);
    assert.ok(executablePath, 'Set STUDIO_TEST_BROWSER to a Chrome executable');
    browser = await puppeteer.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1440, height: 900 });
    const failures = [], errors = [], requests = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(origin) && response.status() >= 400) failures.push(`${response.url()} ${response.status()}`);
    });
    const twikooAPI = origin + '/__test/twikoo';
    const emojiJSON = twikooAPI + '/emoji.json';
    // Use the real Twikoo bundle with local responses for the service and emoji catalog.
    const commentFixtures = new Map([
      [twikooAPI, {data:[], config:{SHOW_EMOTION:'true', EMOTION_CDN:emojiJSON}}],
      [emojiJSON, {Emoji:{type:'emoticon', container:[{icon:'🙂', text:'Smile'}]}}],
    ]);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (options === demo && commentFixtures.has(url)) {
        return request.respond({contentType:'application/json', body:JSON.stringify(commentFixtures.get(url))});
      }
      return url.startsWith(origin) || url.startsWith('data:') ? request.continue() : request.abort();
    });
    const settled = () => page.waitForFunction(() => {
      const background = document.querySelector('#loading-box .loading-bg');
      return (!background || getComputedStyle(background).visibility === 'hidden') && !document.documentElement.hasAttribute('data-astro-transition');
    });
    const finishLayout = () => page.evaluate(async () => {
      // Wait for short layout animations without requiring a frame after a viewport change.
      const animations = document.getAnimations().filter(animation =>
        animation.playState === 'running' && animation.effect?.getComputedTiming().endTime <= 1000);
      if (!animations.length) return;
      let timeout;
      try {
        await Promise.race([
          Promise.allSettled(animations.map(animation => animation.finished)),
          new Promise(resolve => { timeout = setTimeout(resolve, 1000); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    });
    for (const [name, route] of options.pages) {
      console.log(`Checking ${route}`);
      requests.length = 0;
      const response = await page.goto(origin + route, { waitUntil: 'networkidle0' });
      assert.equal(response.status(), 200, route);
      await settled();
      if (options === demo && ['home', 'chinese'].includes(name)) {
        const prefix = name === 'chinese' ? '/zh-CN' : '';
        const thread = prefix + '/threads/11111111-2222-4333-8444-555555555555/';
        const timeline = prefix + '/timeline/';
        const menu = '#nav .menus_item > a[href="' + prefix + '/threads/"]';
        const submenu = menu + ' + .menus_item_child';
        const drawer = '#sidebar-menus[data-home-drawer]';
        const trigger = '#toggle-menu button';
        assert.equal(await page.$eval('#home-threads-title', heading => heading.textContent), prefix ? '最新动态' : 'Latest thread');
        assert.deepEqual(await page.$$eval('.home-threads a', links => links.map(link => link.pathname)), [prefix + '/threads/', thread]);
        assert.equal(await page.$$eval('#home_top > section', cards => cards.length), 1);
        assert.equal(await page.$('.compact-more'), null);
        assert.ok(await page.$('#recent-top-post-group ~ .home-threads'));
        assert.equal(await page.$eval('#todayCard', link => link.pathname), prefix + '/articles/welcome/');
        const recommendations = '#recommendations-toggle';
        const recommendationLink = '#home-recommendations .recommendation-link';
        assert.equal(await page.$eval(recommendationLink, link => link.pathname), prefix + '/collections/field-notes/first/');
        await page.setViewport({width:1440,height:900});
        await page.waitForSelector(recommendations, {visible:true});
        await page.waitForSelector('#banners', {visible:true});
        if (!prefix) {
          const heights = await page.$eval('#banners', banner => {
            const iconGroup = document.createElement('div');
            iconGroup.className = 'tags-group-all';
            iconGroup.style.height = '80rem';
            banner.prepend(iconGroup);
            try {
              const expected = 328 + parseFloat(getComputedStyle(document.documentElement).fontSize) / 2;
              const row = document.querySelector('#recent-post-top').getBoundingClientRect().height;
              return [expected, row, banner.getBoundingClientRect().height,
                document.querySelector('#todayCard').getBoundingClientRect().height];
            } finally {
              iconGroup.remove();
            }
          });
          const [expected, ...actual] = heights;
          assert.ok(actual.every(height => Math.abs(height - expected) < 1), JSON.stringify(heights));
        }
        assert.equal(await page.$eval(recommendationLink, link => link.checkVisibility({visibilityProperty:true})), false);
        await finishLayout();
        await page.screenshot({path:path.join(screenshots, 'blog-' + name + '-featured.png')});
        await page.click(recommendations);
        await page.waitForSelector(recommendationLink, {visible:true});
        await finishLayout();
        await page.waitForFunction(() => !document.querySelector('#todayCard').checkVisibility({visibilityProperty:true}));
        await page.screenshot({path:path.join(screenshots, 'blog-' + name + '-recommendations.png')});
        await page.mouse.move(0,0);
        await page.waitForSelector(recommendations + '[aria-expanded="false"]');
        await page.focus(recommendations);
        await page.keyboard.press('Enter');
        await page.waitForSelector(recommendations + '[aria-expanded="true"]');
        await page.focus(recommendationLink);
        await page.keyboard.press('Escape');
        await page.waitForSelector(recommendations + '[aria-expanded="false"]');
        assert.equal(await page.$eval(recommendations, button => button === document.activeElement), true);
        await page.$eval(recommendations, button => button.blur());

        for (const width of [1440, 1165]) {
          await page.setViewport({width, height:900});
          await page.waitForSelector(menu, {visible:true});
          await page.waitForSelector('.home-thread', {visible:true});
          assert.equal(await page.$eval(trigger, button => button.checkVisibility()), false);
          if (width === 1440) await (await page.$(menu)).hover();
          else await page.focus(menu);
          await page.waitForSelector(submenu, {visible:true});
          assert.equal(await page.$eval(submenu + ' a', link => link.pathname), timeline);
          await finishLayout();
          if (width === 1440) await page.screenshot({path:path.join(screenshots, 'blog-' + name + '-submenu.png')});
          await page.mouse.move(0,0);
          await page.$eval(menu, link => link.blur());
        }

        await page.setViewport({width:390, height:844});
        await page.waitForSelector(trigger, {visible:true});
        await page.waitForSelector('.home-thread', {visible:true});
        await finishLayout();
        assert.equal(await page.$eval(menu, link => link.checkVisibility({visibilityProperty:true})), false);
        await page.waitForSelector(recommendationLink, {visible:true});
        assert.equal(await page.$eval('#todayCard', link => link.checkVisibility()), false);
        assert.ok(await page.$eval('#bannerGroup .banners-link', links => links.checkVisibility()));
        await page.screenshot({path:path.join(screenshots, 'blog-' + name + '-mobile.png')});
        await page.click(trigger);
        await page.waitForSelector(drawer + '[open]');
        await finishLayout();
        const open = await page.$eval(drawer, panel => {
          const bounds = panel.getBoundingClientRect();
          const mask = getComputedStyle(panel,'::backdrop');
          return {edge:bounds.right, width:bounds.width, mask:mask.backdropFilter, opacity:mask.opacity,
            duration:getComputedStyle(panel).transitionDuration, overflow:document.body.style.overflow};
        });
        await page.screenshot({path:path.join(screenshots, 'blog-' + name + '-drawer.png')});
        assert.equal(open.edge, 390);
        assert.equal(open.width, 300);
        assert.match(open.mask, /blur\(20px\)/);
        assert.equal(open.opacity, '1');
        assert.match(open.duration, /0\.5s/);
        assert.equal(open.overflow, 'hidden');
        assert.ok(await page.$(drawer + ' a[href="' + timeline + '"]'));

        const closed = async () => {
          await page.waitForFunction(selector => !document.querySelector(selector).open && document.body.style.overflow !== 'hidden', {}, drawer);
          assert.equal(await page.$eval(trigger, button => button.getAttribute('aria-expanded')), 'false');
          await finishLayout();
        };
        await page.mouse.click(30,300);
        await closed();
        await page.click(trigger);
        await page.keyboard.press('Escape');
        await closed();
        assert.equal(await page.$eval(trigger, button => button === document.activeElement), true);
        await page.click(trigger);
        await page.setViewport({width:1440,height:900});
        await closed();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

        if (!prefix) {
          await page.setViewport({width:320,height:720});
          await page.waitForSelector(trigger, {visible:true});
          assert.ok(await page.$eval('#recent-post-top', row => {
            row.scrollLeft = row.scrollWidth;
            const scrolled = row.scrollLeft > 0;
            row.scrollLeft = 0;
            return scrolled && document.documentElement.scrollWidth <= innerWidth;
          }));
          const layout = await page.evaluate(() => {
            const link = document.querySelector('#site-name');
            const title = link.querySelector('span');
            const toolbar = document.querySelector('#nav-right');
            const originalTitle = title.textContent;
            const search = document.createElement('div');
            search.id = 'search-button';
            search.innerHTML = '<button class="site-page nav-item" type="button">Search</button>';
            try {
              title.textContent = 'WonderShine: a very long site title with every navigation tool enabled';
              toolbar.prepend(search);
              return {
                titleRight: link.getBoundingClientRect().right,
                titleWidth: link.clientWidth,
                titleScrollWidth: link.scrollWidth,
                toolbarLeft: toolbar.getBoundingClientRect().left,
                groupWidth: document.querySelector('#nav-group').clientWidth,
                groupDisplay: getComputedStyle(document.querySelector('#nav-group')).display,
                toolbarRight: toolbar.getBoundingClientRect().right,
                viewportWidth: innerWidth,
              };
            } finally {
              title.textContent = originalTitle;
              search.remove();
            }
          });
          assert.ok(layout.titleRight <= layout.toolbarLeft && layout.titleScrollWidth > layout.titleWidth &&
            layout.toolbarRight <= layout.viewportWidth, JSON.stringify(layout));
        }

        if (!prefix) {
          await page.emulateMediaFeatures([{name:'prefers-reduced-motion', value:'reduce'}]);
          await page.setViewport({width:390,height:844});
          await page.click(trigger);
          assert.equal(await page.$eval(drawer, panel => getComputedStyle(panel).transitionDuration), '0s');
          await page.evaluate(() => {window.__homeDrawerNavigationProbe = true;});
          await page.click(drawer + ' a[href="/threads/"]');
          await page.waitForFunction(() => location.pathname === '/threads/');
          await settled();
          await page.goBack();
          await page.waitForSelector(drawer);
          await settled();
          assert.equal(await page.evaluate(() => window.__homeDrawerNavigationProbe), true);
          await page.click(trigger);
          await page.waitForSelector(drawer + '[open]');
          await page.keyboard.press('Escape');
          await closed();
          await page.emulateMediaFeatures([]);
          await page.setViewport({width:1440,height:900});
        }
      }
      if (options === demo && ['thread', 'threads'].includes(name)) {
        assert.equal(await page.$eval('#aside-content .card-recent-post .title', link => link.pathname), '/articles/welcome/');
        assert.ok(await page.$('#aside-content .activity-topic-counts a'));
        await page.setViewport({width:390,height:844});
        await finishLayout();
        assert.ok(await page.evaluate(() => {
          const aside = document.querySelector('#aside-content').getBoundingClientRect();
          const links = document.querySelectorAll('#aside-content .card-recent-post .title, #aside-content .activity-topic-counts a');
          return [...links].every(link => link.getBoundingClientRect().height > 0) && aside.height > 0 && aside.top >= document.querySelector('.activity-main').getBoundingClientRect().bottom
            && document.documentElement.scrollWidth <= innerWidth;
        }));
        await page.$eval('#aside-content', aside => aside.scrollIntoView({behavior:'instant'}));
        await page.screenshot({path:path.join(screenshots, 'blog-' + name + '-sidebar-mobile.png')});
        await page.setViewport({width:1440,height:900});
        await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      }
      if (options === demo && ['thread', 'timeline'].includes(name)) {
        const times = await page.$$eval('.thread-author time, .timeline-event[data-kind="thread"] .timeline-date time', nodes => nodes.map(node => ({text:node.textContent,date:node.getAttribute('datetime')})));
        assert.ok(times.length, 'Thread publication times are present');
        for (const time of times) {
          assert.match(time.text, /\d{2}:\d{2}:\d{2} \(UTC\+08:00\)/);
          assert.ok(Number.isFinite(Date.parse(time.date)), 'Machine timestamp remains intact');
        }
      }
      if (options === demo && name === 'timeline') {
        assert.equal(await page.$$eval('.activity-subscriptions a', links => links.length), 2);
        assert.equal(await page.$$eval('.activity-counts a', links => links.length), 3);
        assert.ok(await page.$$eval('.activity-recent li', items => items.length <= 4));
        await page.setViewport({width:390,height:844});
        const layout = await page.evaluate(() => {
          const main = document.querySelector('.activity-main').getBoundingClientRect();
          const aside = document.querySelector('.activity-aside').getBoundingClientRect();
          return {after:aside.top >= main.bottom, visible:aside.height > 0, overflow:document.documentElement.scrollWidth > innerWidth};
        });
        assert.deepEqual(layout,{after:true,visible:true,overflow:false});
        await page.screenshot({path:path.join(screenshots,'blog-activity-mobile.png')});
        await page.setViewport({width:1440,height:900});
      }
      await finishLayout();
      await page.screenshot({ path: path.join(screenshots, `blog-${name}.png`) });
      const broken = await page.$$eval('img', images => images.filter(image => image.offsetParent && image.complete && !image.naturalWidth && image.src.startsWith(location.origin)).map(image => image.src));
      assert.deepEqual(broken, [], route);
      if (options === demo && ['home', 'timeline'].includes(name)) {
        assert.deepEqual(requests.filter(url => /\/libs\/(prism\/.*\.js|katex\/|qrcode\/)/.test(url)), [], 'Reading libraries must not load on '+name);
        assert.ok(!requests.some(url => url.endsWith('/dist/css/global.css')), 'Split styles must not also request all-page global.css');
      }
    }
    if (options === demo) {
      const thread = '/threads/11111111-2222-4333-8444-555555555555/';
      const commentRoutes = [['/threads/', false], [thread, true], ['/zh-CN/threads/', false], ['/zh-CN' + thread, false], ['/articles/welcome/', true], ['/timeline/', false], [thread, true]];
      const checkCommentJump = async (route, expected) => {
        assert.equal(await page.$$eval('#post-comment', nodes => nodes.length), Number(expected), route + ': comment area');
        assert.equal(await page.$$eval('#to_comment', nodes => nodes.length), Number(expected), route + ': jump matches area');
        if (expected) {
          assert.equal(await page.$eval('#to_comment', node => node.getAttribute('href')), '#post-comment');
          assert.notEqual(await page.$eval('#to_comment', node => getComputedStyle(node).display), 'none', route + ': available comments are not hidden');
        }
      };
      // Check emitted HTML before any scripts, then first loads and repeated ClientRouter swaps.
      for (const [route, expected] of commentRoutes) {
        const html = await (await fetch(origin + route)).text();
        assert.equal(html.includes('id="to_comment"'), expected, route + ': static HTML jump');
        await page.goto(origin + route, {waitUntil:'networkidle0'}); await settled();
        await checkCommentJump(route, expected);
      }
      await page.evaluate(() => {window.__commentNavigationProbe = true;});
      for (const [route, expected] of commentRoutes) {
        await page.evaluate(route => window.pjax.loadUrl(route), route);
        await page.waitForFunction(route => location.pathname === route, {}, route); await settled();
        assert.equal(await page.evaluate(() => window.__commentNavigationProbe), true);
        await checkCommentJump(route, expected);
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.screenshot({path:path.join(screenshots,'blog-comment-jump.png')});
      await page.setViewport({width:390, height:844});
      await page.goto(origin, {waitUntil:'networkidle0'}); await settled();
      await page.evaluate(async envId => {
        await window.getScript('/libs/twikoo/twikoo.all.min.js');
        await window.twikoo.getRecentComments({envId, pageSize:1});
        window.__commentNavigationProbe = true;
      }, twikooAPI);
      await page.locator(`.home-thread[href="${thread}"]`).click();
      for (const [index, route] of [thread, '/articles/welcome/', thread].entries()) {
        if (index) await page.evaluate(route => window.pjax.loadUrl(route), route);
        await page.waitForFunction(route => location.pathname === route, {}, route); await settled();
        assert.equal(await page.evaluate(() => window.__commentNavigationProbe), true);
        await page.evaluate(async envId => {
          const mount = document.createElement('div');
          mount.id = 'twikoo-wrap';
          document.getElementById('post-comment').append(mount);
          await window.twikoo.init({el:'#twikoo-wrap', envId});
        }, twikooAPI);
        const emoji = await page.waitForSelector('#twikoo .OwO-logo');
        const width = await emoji.evaluate(node => node.querySelector('svg').getBoundingClientRect().width);
        assert.ok(width > 0 && width <= 32, `${route}: emoji icon width is ${width}px`);
        assert.equal(await page.$eval('#twikoo .OwO-body', node => getComputedStyle(node).display), 'none');
        assert.equal(await page.$eval('#twikoo .tk-submit', node => getComputedStyle(node).display), 'flex');
        await emoji.click();
        await page.waitForSelector('#twikoo .OwO-item', {visible:true});
        if (index === 0) await page.screenshot({path:path.join(screenshots,'blog-thread-comment-emoji-mobile.png')});
      }
      await page.setViewport({width:1440, height:900});
      await page.goto(origin, {waitUntil:'networkidle0'}); await settled();
      await page.evaluate(() => {window.__codeNavigationProbe = true; window.pjax.loadUrl('/code-check/');});
      await page.waitForFunction(() => location.pathname === '/code-check/');
      await settled();
      await page.waitForSelector('[data-code-copy]');
      assert.equal(await page.evaluate(() => window.__codeNavigationProbe), true);
      assert.ok(await page.$('.post-content code .token.keyword'), 'Code arrives highlighted');
      assert.equal(await page.$eval('code[data-lang="unknown-language"]', code => code.textContent.trim()), '<script>This remains text.</script>');
      const fold = await page.$('[data-code-fold]');
      if (fold) {await fold.click(); assert.equal(await fold.evaluate(button => button.getAttribute('aria-expanded')), 'false'); await fold.click();}
      await page.evaluate(() => {Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.__copiedCode = text;}}});});
      await (await page.$('[data-code-copy]')).click();
      await page.waitForFunction(() => window.__copiedCode?.includes('const greeting: string'));
      await page.screenshot({path:path.join(screenshots,'blog-code.png')});
      await page.evaluate(() => window.pjax.loadUrl('/'));
      await page.waitForFunction(() => location.pathname === '/'); await settled();
      await page.evaluate(() => window.pjax.loadUrl('/code-check/'));
      await page.waitForFunction(() => location.pathname === '/code-check/'); await settled();
      await page.waitForSelector('[data-code-copy]');
      assert.equal(await page.$$eval('.ws-code-toolbar', bars => bars.length), 2, 'Code tools reinitialize exactly once per block');
    }
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await settled();
    await page.evaluate(() => { window.__navigationProbe = 'persistent'; });
    await page.evaluate(() => {
      document.addEventListener('astro:before-swap', event => {
        const style = event.newDocument.createElement('style');
        style.textContent = '::view-transition-old(root), ::view-transition-new(root) { animation-duration: 450ms !important; }';
        event.newDocument.head.append(style);
        window.__loadingTiming = {};
        event.viewTransition.updateCallbackDone.then(() => {
          window.__loadingTiming.afterSwap = !document.getElementById('loading-box')?.classList.contains('loaded');
        });
        event.viewTransition.finished.then(() => {
          window.__loadingTiming.atFinished = !document.getElementById('loading-box')?.classList.contains('loaded');
        });
      }, {once:true});
    });
    const navigation = options.navigation;
    await page.locator(`a[href="${navigation.path}"]`).click();
    await page.waitForFunction(expected => location.pathname === expected, {}, navigation.path);
    await settled();
    assert.equal(await page.evaluate(() => window.__navigationProbe), 'persistent', 'ClientRouter must preserve document');
    assert.deepEqual(await page.evaluate(() => window.__loadingTiming), {afterSwap:true, atFinished:true}, 'Loading stays visible through DOM replacement and the outgoing snapshot');
    await page.locator('details.nav-language-switch summary').click();
    await page.locator(`.nav-language-option[hreflang="${navigation.language}"]`).click();
    await page.waitForFunction(expected => location.pathname === expected, {}, navigation.translatedPath);
    await settled();
    assert.equal(await page.evaluate(() => window.__navigationProbe), 'persistent', 'Language switch must preserve document');
    for (const [name, width, height] of [['medium', 1165, 773], ['mobile', 390, 844]]) {
      await page.setViewport({ width, height });
      await page.goto(origin, { waitUntil: 'networkidle0' });
      await settled();
      await page.screenshot({ path: path.join(screenshots, `blog-${name}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
    }
    assert.deepEqual(failures, [], 'Local HTTP failures');
    assert.deepEqual(errors, [], 'Browser exceptions');
    const report = { pages: options.pages.length, clientRouter: 'passed', languageSwitch: 'passed', responsiveWidths: [1165, 390], errors, failures };
    await writeFile(path.join(screenshots, 'browser.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options = demo;
  if (process.argv[2]) {
    const config = path.resolve(process.argv[2]);
    options = JSON.parse(await readFile(config, 'utf8'));
    options.siteRoot = path.resolve(path.dirname(config), options.siteRoot);
  }
  await checkBrowser(options);
}
