import assert from 'node:assert/strict';

export async function checkNavigationAccessibility({ page, screenshots }) {
  for (const width of [320, 390, 760]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    await page.waitForFunction(() => document.querySelector('.sidebar')?.inert);
    await page.click('.mobile-menu');
    await page.waitForFunction(() => document.activeElement?.classList.contains('navigation-close'));
    assert.equal(await page.$eval('.main-shell', node => node.inert), true);
    assert.equal(await page.$eval('.mobile-menu', node => node.getAttribute('aria-expanded')), 'true');
    await page.keyboard.down('Shift');
    try { await page.keyboard.press('Tab'); }
    finally { await page.keyboard.up('Shift'); }
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.sidebar')), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('navigation-close')), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.classList.contains('mobile-menu'));
    assert.equal(await page.$eval('.sidebar', node => node.inert), true);
    assert.equal(await page.$eval('.main-shell', node => node.inert), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}`);
    await page.screenshot({ path: `${screenshots}/navigation-${width}.png`, fullPage: true });
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.waitForFunction(() => !document.querySelector('.sidebar')?.inert);
  assert.equal(await page.$eval('.sidebar button[aria-current="page"]', node => node.textContent.trim()), '工作台');
}
