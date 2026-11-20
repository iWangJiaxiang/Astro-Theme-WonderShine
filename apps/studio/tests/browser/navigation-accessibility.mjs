import assert from 'node:assert/strict';

// Focus and inert update before the 200ms transform transition finishes. Wait for
// both the final geometry and animation completion, including reduced-motion mode.
async function waitForDrawer(page, open) {
  await page.waitForFunction(open => {
    const sidebar = document.querySelector('.sidebar');
    const main = document.querySelector('.main-shell');
    if (!sidebar || !main || sidebar.classList.contains('open') !== open) return false;
    const rect = sidebar.getBoundingClientRect();
    const settled = !sidebar.getAnimations().some(animation => animation.playState !== 'finished' && animation.playState !== 'idle');
    const geometry = open
      ? Math.abs(rect.left) < 0.5 && rect.right <= innerWidth && rect.width > 0
      : rect.right <= 0 && Math.abs(rect.right) < 0.5;
    return settled && geometry && sidebar.inert === !open && main.inert === open;
  }, { polling: 'raf' }, open);
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
      activeElement: document.activeElement?.outerHTML.slice(0, 500),
      hitElement: hit?.outerHTML.slice(0, 500),
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
    return sidebar && !sidebar.inert && !sidebar.classList.contains('open') &&
      Math.abs(sidebar.getBoundingClientRect().left) < 0.5 &&
      !document.querySelector('.main-shell')?.inert;
  });
  // Include queued focus migration, even when no drawer state changed.
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
    await waitForDrawer(page, false);
    await page.waitForFunction(() => document.activeElement?.matches('.mobile-menu'));
    await assertFocusedControl(page, '.mobile-menu');

    // A focused close button disappears when the open drawer becomes desktop navigation.
    await page.keyboard.press('Enter');
    await waitForDrawer(page, true);
    await page.waitForFunction(() => document.activeElement?.matches('.navigation-close'));
    await resize(desktop);
    await waitForDesktopNavigation(page);
    await assertFocusedControl(page, current);
    await page.keyboard.press('Tab');
    await assertFocusedControl(page, '.sidebar nav button[aria-current="page"] + button');

    // A drawer navigation item stays usable on desktop and must retain focus.
    await resize(mobile);
    await waitForDrawer(page, false);
    await page.waitForFunction(() => document.activeElement?.matches('.mobile-menu'));
    await page.keyboard.press('Enter');
    await waitForDrawer(page, true);
    await page.waitForFunction(() => document.activeElement?.matches('.navigation-close'));
    await page.keyboard.press('Tab');
    await assertFocusedControl(page, current);
    await resize(desktop);
    await waitForDesktopNavigation(page);
    await assertFocusedControl(page, current);

    // The closed drawer trigger also disappears on desktop.
    await resize(mobile);
    await waitForDrawer(page, false);
    await page.waitForFunction(() => document.activeElement?.matches('.mobile-menu'));
    await resize(desktop);
    await waitForDesktopNavigation(page);
    await assertFocusedControl(page, current);

    // Ordinary content focus must survive both directions without being stolen.
    await page.focus(content);
    await resize(mobile);
    await waitForDrawer(page, false);
    await assertFocusedControl(page, content);
    await resize(desktop);
    await waitForDesktopNavigation(page);
    await assertFocusedControl(page, content);
  }
}

async function checkWorkspaceLayout(page, screenshots) {
  const sizes = [[320, 568], [390, 844], [768, 1024], [844, 390], [1024, 768], [1440, 900], [1920, 1080]];
  await page.select('.topbar select', 'en');
  try {
    for (const [width, height] of sizes) {
      await page.setViewport({ width, height });
      if (width <= 760) await waitForDrawer(page, false);
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
    await page.select('.topbar select', 'zh-CN');
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
    await waitForDrawer(phone, false);
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
    await phone.tap(tab('thread'));
    await active('thread');
    await phone.tap(tab('media'));
    await active('media');
    await phone.waitForSelector('.media-card');
    await phone.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.ok(await phone.evaluate(() => document.querySelector('.studio-footer').getBoundingClientRect().bottom <=
      document.querySelector('.mobile-tabbar').getBoundingClientRect().top + 1), 'The final page content clears the bar');
    await phone.tap(tab('media'));
    await phone.waitForFunction(() => scrollY === 0);
    await phone.tap('.mobile-menu');
    await waitForDrawer(phone, true);
    await phone.tap('.sidebar nav button[aria-current="page"] + button');
    await waitForDrawer(phone, false);
    assert.equal(await phone.$eval('.mobile-menu', node => node.getAttribute('aria-current')), 'true');
    await phone.tap(tab('article'));
    await phone.tap('.topbar .icon-button');
    await phone.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await phone.screenshot({ path: `${screenshots}/phone-navigation-dark.png` });
    await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true });
    await waitForDrawer(phone, false);
    await phone.tap(tab('media'));
    await active('media');
    await phone.tap('.media-search input');
    assert.equal(await phone.$eval('.mobile-tabbar', node => getComputedStyle(node).visibility), 'hidden');
    await phone.$eval('.media-search input', node => node.blur());
    await phone.tap(tab('article'));
    await active('article');
    await phone.screenshot({ path: `${screenshots}/phone-navigation-landscape.png` });
  } finally {
    await context.close();
  }
}

export async function checkNavigationAccessibility({ page, screenshots }) {
  for (const width of [320, 390, 760]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    await waitForDrawer(page, false);
    await page.focus('.mobile-menu');
    await page.keyboard.press('Enter');
    await waitForDrawer(page, true);
    await page.waitForFunction(() => document.activeElement?.classList.contains('navigation-close'));
    await assertFocusedControl(page, '.navigation-close');
    assert.equal(await page.$eval('.mobile-menu', node => node.getAttribute('aria-expanded')), 'true');
    assert.equal(await page.$eval('.mobile-menu', node => node.getAttribute('aria-controls')), 'studio-navigation');
    assert.equal(await page.$eval('.sidebar-backdrop', node => {
      const rect = node.getBoundingClientRect();
      return rect.left === 0 && rect.top === 0 && rect.right === innerWidth && rect.bottom === innerHeight;
    }), true, `Backdrop must cover the viewport at ${width}`);
    // Inert must prevent actual focus, not merely appear as an attribute.
    await page.$eval('.mobile-menu', node => node.focus());
    await assertFocusedControl(page, '.navigation-close');
    await page.screenshot({ path: `${screenshots}/navigation-open-${width}.png` });
    await page.keyboard.down('Shift');
    try { await page.keyboard.press('Tab'); }
    finally { await page.keyboard.up('Shift'); }
    await assertFocusedControl(page, '.sidebar-bottom button');
    await page.keyboard.press('Tab');
    await assertFocusedControl(page, '.navigation-close');
    await page.keyboard.press('Tab');
    await assertFocusedControl(page, '.sidebar nav button');
    await page.keyboard.press('Escape');
    await waitForDrawer(page, false);
    await page.waitForFunction(() => document.activeElement?.classList.contains('mobile-menu'));
    await assertFocusedControl(page, '.mobile-menu');
    await page.$eval('.navigation-close', node => node.focus());
    await assertFocusedControl(page, '.mobile-menu');
    assert.equal(await page.$eval('.mobile-menu', node => node.getAttribute('aria-expanded')), 'false');
    assert.equal(await page.$('.sidebar-backdrop'), null);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.main-shell') && !document.activeElement.closest('[inert]')), true, 'Closed drawer must not receive Tab focus');
    await page.focus('.mobile-menu');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}`);
    await page.screenshot({ path: `${screenshots}/navigation-${width}.png`, fullPage: true });
  }
  await checkTouchNavigation(page, screenshots);
  await checkWorkspaceLayout(page, screenshots);
  await checkBreakpointFocus(page);
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await waitForDesktopNavigation(page);
  assert.equal(await page.$eval('.sidebar button[aria-current="page"]', node => node.textContent.trim()), '工作台');
  console.log('PASS: navigation drawer focus, inert isolation, keyboard containment and breakpoint focus migration.');
}
