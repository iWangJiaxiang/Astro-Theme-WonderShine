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
  assert.equal(await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    return document.activeElement === node && !node.closest('[inert]') &&
      rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
      rect.right <= innerWidth && rect.bottom <= innerHeight &&
      node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  }), true, `${selector} must own focus and be visible and unobscured`);
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
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.waitForFunction(() => !document.querySelector('.sidebar')?.inert && Math.abs(document.querySelector('.sidebar').getBoundingClientRect().left) < 0.5);
  assert.equal(await page.$eval('.sidebar button[aria-current="page"]', node => node.textContent.trim()), '工作台');
}
