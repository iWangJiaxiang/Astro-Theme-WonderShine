import assert from 'node:assert/strict';
async function waitForMobileNavigation(page) {
  await page.waitForFunction(() => document.querySelector('.sidebar')?.hidden &&
    !document.querySelector('.mobile-tabbar')?.hidden &&
    !document.querySelector('.main-shell')?.inert);
}

async function openMore(page) {
  await page.waitForSelector('.mobile-menu[aria-current="page"]');
  await page.waitForSelector('.more-page h1', { visible: true });
}

async function assertFocusedControl(page, selector) {
  const state = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      focused: document.activeElement === node,
      interactive: !node.closest('[inert]'),
      visible: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
        rect.right <= innerWidth && rect.bottom <= innerHeight,
      unobscured: node.contains(hit),
      activeElement: { tag:document.activeElement?.tagName, target:document.activeElement === node },
      hitElement: hit ? { tag:hit.tagName, target:node.contains(hit) } : null,
      rect: rect.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.equal(state.focused && state.interactive && state.visible && state.unobscured,
    true, `${selector} must own focus and be visible and unobscured: ${JSON.stringify(state)}`);
}

async function waitForDesktopNavigation(page) {
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.sidebar');
    return sidebar && !sidebar.hidden &&
      Math.abs(sidebar.getBoundingClientRect().left) < 0.5 &&
      !document.querySelector('.main-shell')?.inert;
  });
  // Include queued focus migration after the breakpoint hides a navigation surface.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function checkBreakpointFocus(page) {
  const current = '.sidebar nav button[aria-current="page"]';
  const content = '.main-content .page-heading .primary';
  for (const [desktop, mobile] of [[761, 760], [1440, 390]]) {
    const resize = width => page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    await resize(desktop);
    await waitForDesktopNavigation(page);
    await page.focus(current);
    await resize(mobile);
    await waitForMobileNavigation(page);
    await page.waitForFunction(() => document.activeElement?.matches('.mobile-menu'));
    await assertFocusedControl(page, '.mobile-menu');

    await resize(desktop);
    await waitForDesktopNavigation(page);
    await assertFocusedControl(page, current);

    // Ordinary content focus must survive both directions without being stolen.
    await page.focus(content);
    await resize(mobile);
    await waitForMobileNavigation(page);
    await assertFocusedControl(page, content);
    await resize(desktop);
    await waitForDesktopNavigation(page);
    await assertFocusedControl(page, content);
  }
}

async function checkWorkspaceLayout(page, screenshots) {
  const sizes = [[320, 568], [390, 844], [768, 1024], [844, 390], [1024, 768], [1440, 900], [1920, 1080]];
  await page.select('.studio-preferences select', 'en');
  try {
    for (const [width, height] of sizes) {
      await page.setViewport({ width, height });
      if (width <= 760) await waitForMobileNavigation(page);
      else await waitForDesktopNavigation(page);
      const layout = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const topbar = rect('.topbar');
        const card = rect('.stat-card');
        const modesVisible = !!document.querySelector('.composer-mode-tabs')?.getClientRects().length;
        const bar = rect('.mobile-tabbar');
        const overflow = [...document.querySelectorAll('.topbar :is(button, select, a), .composer-publish :is(button, select)')]
          .filter(node => node.getClientRects().length)
          .some(node => node.getBoundingClientRect().right > innerWidth + 1 || node.getBoundingClientRect().left < 0);
        return {
          overflow: overflow || document.documentElement.scrollWidth > innerWidth + 1,
          docked: Math.abs(bar.bottom - innerHeight) < 1 && bar.width === innerWidth,
          barHeight: bar.height,
          headerHeight: topbar.height,
          primaryAboveNavigation: rect('.composer-publish .save-button-main').bottom <= bar.top,
          modesVisible,
          cardWidth: card.width,
        };
      });
      assert.equal(layout.overflow, false, `Workspace controls overflow at ${width}x${height}`);
      assert.ok(layout.cardWidth >= (width <= 760 ? 60 : 120), `Dashboard cards squeezed at ${width}x${height}`);
      assert.ok(layout.headerHeight <= 76, `Header wraps at ${width}x${height}`);
      if (width <= 760) assert.ok(layout.docked && layout.barHeight >= 48, 'Phone navigation is anchored and touch sized');
      else assert.equal(layout.barHeight, 0, 'Desktop uses the sidebar');
      if (width === 320) assert.ok(layout.primaryAboveNavigation, 'Small phones show the composer action above navigation on launch');
      assert.equal(layout.modesVisible, false, 'Writing starts without technical mode controls');
      await page.screenshot({ path: `${screenshots}/workspace-${width}x${height}-en.png` });
    }
  } finally {
    await page.select('.studio-preferences select', 'zh-CN');
  }
}

async function checkTouchNavigation(page, screenshots) {
  // Isolate the unsaved draft and keep touch emulation off the desktop page.
  const context = await page.browser().createBrowserContext();
  try {
    await context.setCookie(...await page.browserContext().cookies());
    const phone = await context.newPage();
    const origin = new URL(page.url()).origin;
    await phone.setRequestInterception(true);
    phone.on('request', request => request.url().startsWith(origin + '/') || request.url().startsWith('data:') ? request.continue() : request.abort());
    await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await phone.goto(page.url());
    await waitForMobileNavigation(phone);
    const tab = id => `.mobile-tabbar [data-destination="${id}"]`;
    const active = id => phone.waitForSelector(tab(id) + '[aria-current="page"]');
    await active('home');
    const source = '.thread-composer .markdown-source';
    await phone.waitForSelector(source);
    await phone.type(source, 'Keep this draft');
    await phone.tap(tab('home'));
    assert.equal(await phone.$eval(source, node => node.value), 'Keep this draft');
    const cancelled = new Promise(resolve => phone.once('dialog', async dialog => { await dialog.dismiss(); resolve(); }));
    await Promise.all([cancelled, phone.tap(tab('media'))]);
    await active('home');
    assert.equal(await phone.$eval(source, node => node.value), 'Keep this draft');
    phone.once('dialog', dialog => dialog.accept());
    await phone.tap(tab('article'));
    await active('article');
    await phone.tap(tab('home'));
    await phone.waitForSelector('.composer-recovery');
    await phone.screenshot({ path: `${screenshots}/phone-draft-recovery.png` });
    await phone.tap(tab('article'));
    await active('article');
    const swipe = async (from, to, y) => {
      const touch = await phone.touchscreen.touchStart(from, y);
      await touch.move(Math.round((from + to) / 2), y);
      await touch.move(to, y);
      await touch.end();
    };
    const tabY = await phone.$eval(tab('article'), node => node.getBoundingClientRect().top + 20);
    await swipe(220, 100, tabY);
    await active('thread');
    await swipe(8, 135, 200);
    await active('article');
    const row = '.content-library .content-row[data-path^="content/articles/"]';
    await phone.waitForSelector(row);
    await phone.tap(row);
    const body = '.editor-page .markdown-source';
    await phone.waitForSelector(body);
    await phone.type(body, 'Keep this article edit');
    await phone.$eval(body, node => node.blur());
    const draft = await phone.$eval(body, node => node.value);
    let declined = false;
    phone.once('dialog', async dialog => { declined = true; await dialog.dismiss(); });
    await swipe(8, 135, 200);
    assert.ok(declined, 'Edge back asks before leaving a dirty article');
    assert.equal(await phone.$eval(body, node => node.value), draft);
    phone.once('dialog', dialog => dialog.accept());
    await swipe(8, 135, 200);
    await phone.waitForSelector(row);
    await phone.tap('.mobile-menu');
    await openMore(phone);
    await swipe(8, 135, 200);
    await active('article');
    await phone.tap(tab('media'));
    await active('media');
    await phone.waitForSelector('.media-card');
    await phone.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.ok(await phone.evaluate(() => document.querySelector('.studio-footer').getBoundingClientRect().bottom <=
      document.querySelector('.mobile-tabbar').getBoundingClientRect().top + 1), 'The final page content clears the bar');
    await phone.tap(tab('media'));
    await phone.waitForFunction(() => scrollY === 0);
    await phone.tap('.mobile-menu');
    await openMore(phone);
    await phone.tap('.more-page nav:first-of-type button:first-child');
    await phone.waitForSelector('.more-page', { hidden: true });
    assert.equal(await phone.$eval('.mobile-menu', node => node.getAttribute('aria-current')), 'true');
    await phone.tap(tab('article'));
    await phone.tap('.mobile-menu');
    await openMore(phone);
    if (!await phone.$eval('.studio-preferences', el => el.open)) await phone.tap('.studio-preferences summary');
    await phone.tap('.theme-switch');
    await phone.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await phone.screenshot({ path: `${screenshots}/phone-navigation-dark.png` });
    await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true });
    await waitForMobileNavigation(phone);
    await phone.tap(tab('media'));
    await active('media');
    await phone.tap('.media-search input');
    assert.equal(await phone.$eval('.mobile-tabbar', node => getComputedStyle(node).visibility), 'hidden');
    await phone.$eval('.media-search input', node => node.blur());
    await phone.tap(tab('article'));
    await active('article');
    await phone.screenshot({ path: `${screenshots}/phone-navigation-landscape.png` });
    await phone.tap('.mobile-menu');
    await openMore(phone);
    if (!await phone.$eval('.studio-preferences', el => el.open)) await phone.tap('.studio-preferences summary');
    await phone.tap('.theme-switch');
    await phone.select('.studio-preferences select', 'zh-CN');
    await phone.waitForSelector('.more-page nav[aria-label="站点设置"]');
    await phone.$eval('.more-page nav[aria-label="站点设置"]', nav => [...nav.querySelectorAll('button')].find(button => button.textContent.trim() === '站点信息').click());
    await phone.waitForSelector('.settings-card input');
    for (const [width, height] of [[390, 844], [768, 900], [1180, 768]]) {
      await phone.setViewport({ width, height, isMobile: true, hasTouch: true, isLandscape: width > height });
      if (width <= 1024) await waitForMobileNavigation(phone);
      else await waitForDesktopNavigation(phone);
      await phone.evaluate(() => scrollTo(0, 240));
      await phone.waitForFunction(() => scrollY > 24);
      const pinned = await phone.evaluate(() => {
        const header = document.querySelector('.topbar').getBoundingClientRect();
        const theme = document.querySelector('.topbar .visit-site').getBoundingClientRect();
        const bar = document.querySelector('.mobile-tabbar').getBoundingClientRect();
        return {
          top: header.top, height: header.height,
          canTap: !!document.elementFromPoint(theme.x + theme.width / 2, theme.y + theme.height / 2)?.closest('.topbar .visit-site'),
          actionsTop: document.querySelector('.settings-page > .page-heading').getBoundingClientRect().top,
          bottom: bar.height ? bar.bottom : null,
        };
      });
      assert.ok(Math.abs(pinned.top) <= 1 && pinned.canTap, `Scrolled header at ${width} stays visible and touchable`);
      assert.ok(pinned.actionsTop >= pinned.height - 1, `Settings actions clear the header at ${width}`);
      assert.equal(pinned.bottom, width <= 1024 ? height : null);
      await phone.screenshot({ path: `${screenshots}/scrolled-settings-${width}.png` });
    }
  } finally {
    await context.close();
  }
}

export async function checkNavigationAccessibility({ page, screenshots }) {
  for (const [width, height] of [[320, 568], [320, 844], [390, 844], [760, 844]]) {
    const imageSize = height === 844 ? String(width) : `${width}x${height}`;
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await waitForMobileNavigation(page);
    await page.focus('.mobile-menu');
    await page.keyboard.press('Enter');
    await openMore(page);
    await page.waitForFunction(() => document.activeElement?.matches('.more-page h1'));
    await assertFocusedControl(page, '.more-page h1');
    assert.equal(await page.$('dialog[open], .sidebar-backdrop'), null);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}`);
    await page.keyboard.press('Tab');
    await assertFocusedControl(page, '.more-page nav button:first-child');
    await page.screenshot({ path: `${screenshots}/navigation-more-${imageSize}.png`, fullPage: true });
    await page.click('.mobile-tabbar [data-destination="home"]');
    await page.waitForSelector('.more-page', { hidden: true });
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await waitForDesktopNavigation(page);
  await checkTouchNavigation(page, screenshots);
  await checkWorkspaceLayout(page, screenshots);
  await checkBreakpointFocus(page);
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await waitForDesktopNavigation(page);
  assert.equal(await page.$eval('.sidebar button[aria-current="page"]', node => node.textContent.trim()), '工作台');
  console.log('PASS: More page navigation, keyboard focus and breakpoint focus migration.');
}
