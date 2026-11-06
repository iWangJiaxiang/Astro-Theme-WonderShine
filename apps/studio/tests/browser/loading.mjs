import assert from 'node:assert/strict';

export async function checkLoading({ browser, origin, screenshots }) {
  const page = await browser.newPage();
  const pending = new Map();
  let holdInitial = true, failContent = false, failDocument = false;
  const requests = [], responses = [], failures = [], pageErrors = [];
  const workspaceRetry = '.main-content > .notice.error button';
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin && ['/api/bootstrap', '/api/content', '/api/content-languages', '/api/settings/taxonomies', '/api/document'].includes(url.pathname)) {
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
    assert.equal(await page.$('.main-content > .notice.error'), null, 'workspace recovery clears its own error');
    // Editor options own their failed read; refreshing dashboard counts does not
    // reload them. The notice remains in the collapsed publishing-settings DOM.
    const optionsError = '.thread-composer .metadata-card > .notice.error';
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('选项载入失败：连接已更换，请重试'), {}, optionsError);
    await page.click('.thread-composer .composer-tools > button[aria-expanded="false"]');
    await page.waitForSelector(optionsError + ' button', { visible: true });
    const [optionsContent, optionsTaxonomies] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/content?refresh=1'),
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/taxonomies'),
      page.click(optionsError + ' button'),
    ]);
    assert.equal(optionsContent.status(), 200, 'composer option retry reloads content');
    assert.equal(optionsTaxonomies.status(), 200, 'composer option retry completes taxonomy loading');
    // Error text clears at retry start; enabled controls prove loadChoices ended.
    await page.waitForSelector('.thread-composer [data-field="extra.topics"] .choice-trigger:not(:disabled)');
    await page.waitForSelector('.thread-composer .article-references .reference-heading button:not(:disabled)');
    assert.equal(await page.$('.notice.error'), null, 'workspace and child option errors both recover');
    await page.click('.thread-composer .article-references .reference-heading button');
    await page.waitForSelector('.reference-dialog[open] input[type="radio"]', { visible: true });
    assert.ok(await page.$$eval('.reference-dialog[open] input[type="radio"]', nodes => nodes.length > 0), 'recovered composer options contain article references');
    await page.click('.reference-dialog[open] .card-heading button');
    await page.waitForSelector('.reference-dialog[open]', { hidden: true });
    await page.click('.thread-composer .composer-tools > button[aria-expanded="true"]');
    failContent = true;
    const [failedLibrary] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/content'),
      page.click('aside nav button:nth-child(2)'),
    ]);
    assert.equal(failedLibrary.status(), 502, 'library navigation reaches the injected content failure');
    await page.waitForSelector('.content-library .notice.error button:not(:disabled)');
    assert.equal(await page.$('.content-library .empty-state'), null, 'failed library request is not an empty state');
    failContent = false;
    const [recoveredLibrary] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/content?refresh=1'),
      page.click('.content-library .notice.error button'),
    ]);
    assert.equal(recoveredLibrary.status(), 200, 'library retry receives fresh content');
    await page.waitForSelector('.library-row .content-row');
    assert.equal(await page.$('.notice.error'), null, 'library recovery leaves no hidden errors');
    failDocument = true;
    const [failedDocument] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/document'),
      page.click('.library-row .content-row'),
    ]);
    assert.equal(failedDocument.status(), 502, 'opening a document reaches the injected document failure');
    await page.waitForSelector('.main-content > .notice.error button', { visible: true });
    assert.equal(await page.$('.markdown-source'), null, 'failed document request must not expose an empty editable document');
    failDocument = false;
    const [recoveredDocument] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/document'),
      page.click('.main-content > .notice.error button'),
    ]);
    assert.equal(recoveredDocument.status(), 200, 'document retry receives the saved document');
    await page.waitForSelector('.markdown-source');
    await page.waitForSelector('.editor-page [data-field="taxonomies.tags"] :is(fieldset, button):not(:disabled)');
    assert.equal(await page.$('.notice.error'), null, 'document and its independently loaded options both recover');
    console.log('PASS: parallel workspace reads, slow feedback, retry, document failure safety, reduced motion and mobile loading.');
  } catch (error) {
    // smoke.mjs owns a different page; capture this page before finally closes it.
    const state = await page.evaluate(() => ({
      counts: [...document.querySelectorAll('.stat-card strong')].map(node => node.textContent),
      notices: [...document.querySelectorAll('.notice.error')].map(node => ({
        text: node.textContent,
        visible: node.getClientRects().length > 0,
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
