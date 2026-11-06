import assert from 'node:assert/strict';

const library = '.content-library';
const rows = `${library} .content-row`;
const source = '.editor-page .markdown-source';
const search = `${library} .search-box input`;
const tile = '.media-card[data-media-path="public/img/navigation-context.png"]';

async function clickText(page, selector, text) {
  await page.waitForFunction((selector, text) => [...document.querySelectorAll(selector)].some(node => node.textContent.trim() === text && !node.disabled), {}, selector, text);
  const handles = await page.$$(selector);
  try {
    for (const handle of handles) {
      if (await handle.evaluate((node, text) => node.textContent.trim() === text, text)) {
        await handle.click();
        return;
      }
    }
    throw new Error(`Missing ${selector}: ${text}`);
  } finally { await Promise.all(handles.map(handle => handle.dispose())); }
}

// Flush layout, MutationObserver and its scheduled placement, not a timed sleep.
async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

async function readyLibrary(page) {
  await page.waitForFunction(selector => {
    const section = document.querySelector(selector);
    return section && !section.querySelector('.loading-panel') && section.querySelectorAll('.content-row').length === 20 && section.querySelector('.library-footer');
  }, {}, library);
}

async function headingAtTop(page, selector, text) {
  await page.waitForSelector(selector);
  await page.waitForFunction((selector, text) => {
    const heading = document.querySelector(selector);
    return heading && (!text || heading.textContent.trim() === text) && document.activeElement === heading && Math.abs(scrollY) <= 1;
  }, {}, selector, text);
  await frames(page);
  assert.equal(await page.$eval(selector, node => node === document.activeElement), true, `${selector} retains destination heading focus`);
  assert.ok(Math.abs(await page.evaluate(() => scrollY)) <= 1, 'A new destination starts at the page top');
}

async function navigate(page, text) {
  const mobile = await page.$eval('.mobile-menu', node => !node.hidden && getComputedStyle(node).display !== 'none');
  if (mobile) {
    await page.click('.mobile-menu');
    await page.waitForSelector('.sidebar.open');
    // Wait for the real drawer transition/hit target, rather than clicking an
    // offscreen control or synthesizing a DOM click.
    await page.waitForFunction(() => {
      const node = document.querySelector('.sidebar.open nav button');
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === node;
    });
  }
  await clickText(page, '.sidebar nav button', text);
  if (mobile) await page.waitForSelector('.sidebar.open', { hidden: true });
}

async function scrollLibrary(page) {
  await readyLibrary(page);
  await page.mouse.move(380, 620);
  const before = await page.evaluate(() => scrollY);
  await page.mouse.wheel({ deltaY: 1000 });
  await page.waitForFunction(before => scrollY > before + 500, {}, before);
  await frames(page);
  const down = await page.evaluate(() => scrollY);
  await page.mouse.wheel({ deltaY: -260 });
  await page.waitForFunction(down => scrollY < down - 150 && scrollY > 300, {}, down);
  await frames(page);
}

async function openVisibleArticle(page) {
  const target = await page.evaluate(selector => [...document.querySelectorAll(selector)].find(node => {
    const rect = node.getBoundingClientRect();
    return node.dataset.path.includes('/navigation-context-') && rect.top > 60 && rect.bottom < innerHeight - 60;
  })?.dataset.path, rows);
  assert.ok(target, 'A synthetic article is fully visible after real bidirectional scrolling');
  const selector = `${rows}[data-path="${target}"]`;
  const title = await page.$eval(`${selector} strong`, node => node.textContent.trim());
  const y = await page.evaluate(() => scrollY);
  await page.click(selector);
  await page.waitForSelector(source);
  await headingAtTop(page, '.editor-page h1', title);
  return { y, path: target };
}

// Hold a real server-bound list request until the destination's loading DOM is
// observable. The API body and readiness transitions remain production behavior.
async function holdContent(page, origin) {
  let held;
  const intercept = request => {
    const url = new URL(request.url());
    if (!held && url.origin === origin && url.pathname === '/api/content' && request.method() === 'GET') {
      held = request;
      return;
    }
    void request.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', intercept);
  return {
    async loading() {
      // The DOM wait has Puppeteer's normal timeout if navigation never requests
      // content; do not let a missing request leave CI hanging indefinitely.
      await page.waitForSelector(`${library} .loading-panel`);
      // A DOM commit may precede the CDP request notification. This bounded
      // request observation is not a timing assumption about React's commit.
      if (!held) await page.waitForRequest(request => new URL(request.url()).pathname === '/api/content' && request.method() === 'GET');
      assert.ok(held, 'Returning to the library reloads its list');
    },
    async release() {
      assert.ok(held, 'A content request was held');
      await held.continue();
      held = undefined;
      page.off('request', intercept);
      await page.setRequestInterception(false);
    },
    async dispose() {
      page.off('request', intercept);
      if (held && !held.isInterceptResolutionHandled()) await held.continue();
      await page.setRequestInterception(false);
    },
  };
}

async function returnContext(page, origin, context, userInput = false) {
  const gate = await holdContent(page, origin);
  try {
    await clickText(page, '.editor-page .page-heading button', '← 返回内容库');
    await gate.loading();
    // A loading heading alone must not consume the saved position.
    await frames(page);
    assert.ok(await page.$(`${library} .loading-panel`), 'Exercise a genuinely delayed destination');
    let userY;
    if (userInput) {
      await page.click(search);
      await page.type(search, 'Navigation context');
      await frames(page);
      userY = await page.evaluate(() => scrollY);
      assert.ok(Math.abs(userY - context.y) > 200, 'User input occurs away from the pending saved position');
    }
    await gate.release();
    await readyLibrary(page);
    if (!userInput) {
      await page.waitForFunction(y => Math.abs(scrollY - y) <= 2, {}, context.y);
      await frames(page);
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - context.y) <= 2, 'Return restores the actual pre-open library viewport after list readiness');
    } else {
      await frames(page);
      assert.equal(await page.$eval(search, node => document.activeElement === node && node.value === 'Navigation context'), true, 'Delayed restore must not steal focus from user input');
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - userY) <= 2, 'Delayed restore must not move the viewport after user input');
      // Another real input causes another list mutation while any forgotten
      // observer is still live; cancellation must be permanent, not one frame.
      await page.keyboard.type(' 0');
      await page.waitForFunction(selector => document.querySelectorAll(selector).length === 10, {}, rows);
      await frames(page);
      assert.equal(await page.$eval(search, node => document.activeElement === node), true);
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - userY) <= 2, 'Later list mutations cannot revive a cancelled restoration');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await readyLibrary(page);
    }
  } finally { await gate.dispose(); }
}

async function cancelledDraftNavigation(page, acceptDialog) {
  await page.select('.editor-page select[aria-label="自动保存间隔"]', '0');
  await page.click(source);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nUnsaved navigation context marker.');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector);
    return node.value.includes('Unsaved navigation context marker.') && node.scrollTop > 0;
  }, {}, source);
  // Keep the window and the textarea independently scrolled. The gutter wheel
  // targets the document, not the textarea's own scrollable content.
  await page.mouse.move(385, 700);
  const start = await page.evaluate(() => scrollY);
  await page.mouse.wheel({ deltaY: 400 });
  await page.waitForFunction(start => scrollY > start + 100, {}, start);
  await frames(page);
  const textarea = await page.$(source);
  const before = await textarea.evaluate(node => ({ value: node.value, top: node.scrollTop, start: node.selectionStart, end: node.selectionEnd, y: scrollY }));
  let confirm;
  page.off('dialog', acceptDialog);
  const dismiss = async dialog => { confirm = { type: dialog.type(), message: dialog.message() }; await dialog.dismiss(); };
  page.on('dialog', dismiss);
  try {
    // Keyboard activation permits cancelling from a deep viewport without
    // Puppeteer's click auto-scroll moving the page to the Back button first.
    const buttons = await page.$$('.editor-page .page-heading button');
    try {
      const back = [];
      for (const button of buttons) if (await button.evaluate(node => node.textContent.trim() === '← 返回内容库')) back.push(button);
      assert.equal(back.length, 1);
      await back[0].evaluate(node => node.focus({ preventScroll: true }));
      await page.keyboard.press('Enter');
    } finally { await Promise.all(buttons.map(button => button.dispose())); }
    // waitForFunction also bounds a missing confirmation without fixed sleeps.
    await page.waitForFunction(selector => document.activeElement?.matches(`${selector} .page-heading button`), {}, '.editor-page');
    await frames(page);
    assert.equal(confirm?.type, 'confirm', 'Dirty navigation must ask before leaving');
    assert.match(confirm.message, /未保存/);
    const after = await textarea.evaluate(node => ({ connected: node.isConnected, same: node === document.querySelector('.editor-page .markdown-source'), value: node.value, top: node.scrollTop, start: node.selectionStart, end: node.selectionEnd, y: scrollY }));
    assert.equal(after.connected && after.same, true, 'Cancelled navigation retains the exact mounted textarea');
    assert.deepEqual({ value: after.value, top: after.top, start: after.start, end: after.end }, { value: before.value, top: before.top, start: before.start, end: before.end }, 'Cancelled navigation retains draft text, textarea scroll and selection');
    assert.ok(Math.abs(after.y - before.y) <= 2, 'Cancelled navigation cannot reset document scroll');
    assert.equal(await page.$(library), null, 'Cancelled navigation does not mount the destination library');
  } finally {
    page.off('dialog', dismiss);
    page.on('dialog', acceptDialog);
    await textarea.dispose();
  }
}

async function mediaContext(page, width, screenshots) {
  await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
  await frames(page);
  await page.waitForSelector(`${tile}:not(:disabled)`);
  await page.click(tile);
  await page.waitForFunction(selector => {
    const details = document.querySelector('.media-details');
    const back = details?.querySelector('.media-details-back');
    const rect = back?.getBoundingClientRect();
    return document.querySelector(selector)?.getAttribute('aria-pressed') === 'true' && document.activeElement === details && rect.top >= 0 && rect.bottom <= innerHeight;
  }, {}, tile);
  await page.waitForFunction(() => {
    const img = document.querySelector('.media-details img');
    return img?.complete && img.naturalWidth > 0;
  });
  const detailsY = await page.evaluate(() => scrollY);
  assert.ok(detailsY > 0, `${width}px selection scrolls down to details`);
  if (screenshots) await page.screenshot({ path: `${screenshots}/navigation-context-media-${width}.png` });
  await clickText(page, '.media-details-back', '返回图片列表');
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector), rect = node?.getBoundingClientRect();
    return node === document.activeElement && rect.top >= 0 && rect.bottom <= innerHeight;
  }, {}, tile);
  assert.ok(await page.evaluate(() => scrollY) < detailsY - 20, `${width}px Back scrolls up to the selected tile`);
  assert.equal(await page.$eval(tile, node => node.getAttribute('aria-pressed')), 'true', 'Back preserves media selection');
}

/** Remote-only regression, after checkRootModals on its disposable authenticated
 * fixture. Requires 48 Navigation context articles and navigation-context.png.
 * Owns request interception only while deliberately gating a library reload.
 * acceptDialog is the runner's existing handler, temporarily swapped only for
 * the explicit dirty-navigation cancellation (Puppeteer has no listeners API).
 */
export async function checkNavigationContext({ page, origin, screenshots, acceptDialog }) {
  // The modal suite deliberately leaves a dirty Example editor mounted. A full
  // app load starts independent navigation memory; its fixture draft is retained.
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.studio-shell');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await navigate(page, '文章');
  await readyLibrary(page);
  await headingAtTop(page, `${library} h1`, '文章');

  await scrollLibrary(page);
  const context = await openVisibleArticle(page);
  await returnContext(page, origin, context);
  // A completed restoration is one-shot even when the list mutates later.
  await page.mouse.move(380, 620);
  await page.mouse.wheel({ deltaY: 300 });
  await page.waitForFunction(y => scrollY > y + 100, {}, context.y);
  await frames(page);
  const movedY = await page.evaluate(() => scrollY);
  await page.evaluate(selector => {
    const marker = document.createElement('span');
    marker.textContent = 'Navigation mutation probe';
    marker.hidden = true;
    document.querySelector(`${selector} .library-footer`).append(marker);
    marker.remove();
  }, library);
  await frames(page);
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - movedY) <= 2, 'Completed restore never reasserts a saved viewport');

  const interrupted = await openVisibleArticle(page);
  await returnContext(page, origin, interrupted, true);
  if (screenshots) await page.screenshot({ path: `${screenshots}/navigation-context-interrupted-restore.png` });
  await scrollLibrary(page);
  await openVisibleArticle(page);
  await cancelledDraftNavigation(page, acceptDialog);
  if (screenshots) await page.screenshot({ path: `${screenshots}/navigation-context-cancelled-draft.png` });

  // The runner's default accept handler explicitly approves leaving this draft.
  // At the exact stacked-layout boundary the sidebar is directly clickable.
  await page.setViewport({ width: 1180, height: 844, deviceScaleFactor: 1 });
  await frames(page);
  await navigate(page, '媒体库');
  await headingAtTop(page, '.media-library h1', '媒体库');
  await mediaContext(page, 1180, screenshots);
  await mediaContext(page, 390, screenshots);
  console.log('PASS: 390px bidirectional document scroll; async destination heading focus/top; ready-only one-shot library return; user input cancels late restore; cancelled dirty navigation retains textarea/selection/scroll; 1180px/390px media details and selected-tile return.');
}
