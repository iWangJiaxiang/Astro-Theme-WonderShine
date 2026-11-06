import assert from 'node:assert/strict';

export async function checkLoading({ browser, origin, screenshots }) {
  const page = await browser.newPage();
  const pending = new Map();
  let holdInitial = true, failContent = false, failDocument = false;
  const requests = [], responses = [], failures = [], pageErrors = [];
  const workspaceRetry = '.main-content > .notice.error button';
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin && ['/api/bootstrap', '/api/content'].includes(url.pathname)) {
      responses.push({ path: url.pathname + url.search, status: response.status() });
    }
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api/')) {
      failures.push({ path: url.pathname + url.search, error: request.failure()?.errorText });
    }
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.evaluateOnNewDocument(() => localStorage.setItem('studio-language', 'zh-CN'));
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== origin) return request.abort();
      requests.push(url.pathname + url.search);
      // The dashboard and its embedded composer both request the content library.
      if (holdInitial && ['/api/bootstrap', '/api/content'].includes(url.pathname)) { pending.set(url.pathname, [...(pending.get(url.pathname) || []), request]); return; }
      if ((failContent && url.pathname === '/api/content') || (failDocument && url.pathname === '/api/document')) {
        return request.respond({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '请求失败，请稍后再试' }) });
      }
      return request.continue();
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-grid .loading-panel');
    assert.equal(pending.size, 2, 'bootstrap and content start in parallel');
    const counts = await page.$$eval('.stat-card strong', nodes => nodes.map(node => node.textContent));
    assert.ok(counts.length > 0 && counts.every(value => value === '—'), 'all content counts remain placeholders until loaded');
    assert.equal(await page.$('.home-grid .empty-state'), null, 'loading is not an empty library');
    await page.waitForFunction(() => document.body.innerText.includes('加载比平时久一些'), { timeout: 12_000 });
    await page.screenshot({ path: screenshots + '/loading-desktop.png', fullPage: true });
    await page.select('.language-switcher select', 'en');
    await page.waitForFunction(() => document.body.innerText.includes('This is taking longer than usual.'));
    await page.select('.language-switcher select', 'zh-CN');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.equal(await page.$eval('.loading-spinner', node => getComputedStyle(node).animationName), 'none');
    await page.setViewport({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'loading fits mobile');
    await page.screenshot({ path: screenshots + '/loading-mobile.png', fullPage: true });
    await page.setViewport({ width: 1280, height: 900 });
    // Locale changes invalidate the held content read before its injected 502.
    // Its error is visible while bootstrap is still pending, so a raw click here
    // would silently target a disabled workspace retry button.
    await page.waitForFunction(() => document.querySelector('.main-content > .notice.error')?.textContent.includes('连接已更换，请重试'));
    assert.equal(await page.$eval(workspaceRetry, button => button.disabled), true, 'workspace retry waits for the outstanding bootstrap');
    holdInitial = false;
    await Promise.all(pending.get('/api/bootstrap').map(request => request.continue()));
    await Promise.all(pending.get('/api/content').map(request => request.respond({ status: 502, contentType: 'application/json', body: '{"error":"请求失败，请稍后再试"}' })));
    pending.clear();
    await page.waitForSelector(workspaceRetry + ':not(:disabled)');
    assert.equal(await page.$('.home-grid .empty-state'), null, 'failure must not claim there is no content');
    // Exercise a live 502 as well: the original content request was cancelled by
    // the language change and its response cannot prove transport-error recovery.
    failContent = true;
    const [failedRetry] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/content?refresh=1'),
      page.click(workspaceRetry),
    ]);
    assert.equal(failedRetry.status(), 502, 'workspace retry reaches the injected content failure');
    await page.waitForFunction(() => document.querySelector('.main-content > .notice.error')?.textContent.includes('请求失败，请稍后再试'));
    await page.waitForSelector(workspaceRetry + ':not(:disabled)');
    assert.equal(await page.$('.home-grid .empty-state'), null, 'a live content failure is not an empty library');
    failContent = false;
    const [recoveredRetry] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/content?refresh=1'),
      page.click(workspaceRetry),
    ]);
    assert.equal(recoveredRetry.status(), 200, 'workspace retry receives fresh content');
    await page.waitForFunction(() => Number(document.querySelector('.stat-card strong')?.textContent) > 0);
    assert.ok(requests.includes('/api/content?refresh=1'), 'workspace retry reloads the failed content request');
    assert.equal(await page.$('.notice.error'), null);
    failContent = true;
    await page.click('aside nav button:nth-child(2)');
    await page.waitForSelector('.content-library .notice.error');
    assert.equal(await page.$('.content-library .empty-state'), null, 'failed library request is not an empty state');
    failContent = false;
    await page.click('.content-library .notice.error button');
    await page.waitForSelector('.library-row .content-row');
    failDocument = true;
    await page.click('.library-row .content-row');
    await page.waitForSelector('main .notice.error');
    assert.equal(await page.$('.markdown-source'), null, 'failed document request must not expose an empty editable document');
    failDocument = false;
    await page.click('main .notice.error button');
    await page.waitForSelector('.markdown-source');
    console.log('PASS: parallel workspace reads, slow feedback, retry, document failure safety, reduced motion and mobile loading.');
  } catch (error) {
    // smoke.mjs owns a different page; capture this page before finally closes it.
    const state = await page.evaluate(() => ({
      counts: [...document.querySelectorAll('.stat-card strong')].map(node => node.textContent),
      notices: [...document.querySelectorAll('.notice.error')].map(node => ({
        text: node.textContent,
        retryDisabled: node.querySelector('button')?.disabled,
      })),
      loading: [...document.querySelectorAll('.loading-panel')].map(node => node.textContent),
    })).catch(() => null);
    console.error('Loading check failed:', JSON.stringify({ state, requests, responses, failures, pageErrors }));
    await page.screenshot({ path: screenshots + '/loading-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    for (const requests of pending.values()) for (const request of requests) await request.abort().catch(() => {});
    await page.close();
  }
}
