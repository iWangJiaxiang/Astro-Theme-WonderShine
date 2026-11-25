import assert from 'node:assert/strict';

// Exercise the shipped browser module with a delayed SDK and deterministic card sizes.
export async function checkThreadImpressions(browser, origin) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 300 });
    await page.setRequestInterception(true);
    const requestedSdk = page.waitForRequest(request => new URL(request.url()).pathname === '/__test/tracker.js');
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/__test/tracker.js') return;
      if (path === '/__test/unavailable.js') return request.abort();
      if (path !== '/__test/cards') return request.continue();
      return request.respond({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head>
        <style>*{margin:0}article{height:100px}</style></head><body>
        <div id="loading-box"></div><main data-thread-surface="home">
        ${Array.from({length:12}, (_, i) => '<article data-thread-id="' + (i === 0 ? 'covered' : i) + '"></article>').join('')}
        </main><script type="module" src="/js/analytics.js" data-umami-src="/__test/tracker.js"
        data-website-id="test"></script></body></html>` });
    });
    await page.goto(origin + '/__test/cards', {waitUntil:'domcontentloaded'});
    // Give the observer a rendering opportunity while the loading mask is up.
    const paint = () => page.evaluate(() => new Promise(done =>
      requestAnimationFrame(() => requestAnimationFrame(done))));
    await paint();
    await page.evaluate(() => {
      // The first card under the mask must never be counted.
      document.querySelector('article').dataset.threadId = '0';
      document.querySelector('#loading-box').hidden = true;
    });
    await paint();
    await page.evaluate(() => {
      // A navigation completed before the tracker was ready.
      document.dispatchEvent(new Event('astro:before-swap'));
      const next = document.body.cloneNode(true);
      next.querySelector('main').dataset.threadSurface = 'timeline';
      next.querySelector('main').lastElementChild.remove();
      document.body.replaceWith(next);
      history.pushState({}, '', '/__test/timeline');
      document.documentElement.lang = 'zh-CN';
      document.dispatchEvent(new Event('astro:page-load'));
    });
    const sdkRequest = await requestedSdk;
    await sdkRequest.respond({contentType:'text/javascript', body:`
      window.testEvents = [];
      window.umami = {track: callback => window.testEvents.push(callback({}))};`});
    await page.waitForFunction(() => window.testEvents?.length >= 8);
    assert.ok(await page.evaluate(() => {
      const sdk = performance.getEntriesByName(location.origin + '/__test/tracker.js')[0];
      const navigation = performance.getEntriesByType('navigation')[0];
      return sdk && navigation.loadEventEnd > 0 && sdk.startTime >= navigation.loadEventEnd;
    }), 'Download Umami after the first page load');
    let events = await page.evaluate(() => window.testEvents);
    assert.deepEqual(events.filter(e => !e.name).map(e => new URL(e.url).pathname), ['/__test/cards','/__test/timeline']);
    for (const [surface, lang, path] of [['home','en','/__test/cards'],['timeline','zh-CN','/__test/timeline']]) {
      const hits = events.filter(e => e.data?.surface === surface);
      assert.deepEqual(hits.map(e => e.data.thread_id), ['0','1','2']);
      assert.ok(hits.every(e => e.name === 'thread_impression' && e.data.lang === lang && new URL(e.url).pathname === path));
    }
    await page.evaluate(() => scrollTo(0, 100));
    await page.waitForFunction(() => window.testEvents.some(e => e.data?.thread_id === '3'));
    await page.evaluate(() => {
      scrollTo(0, 0);
      const a = document.createElement('a');
      a.dataset.umamiEvent = 'outbound-link-click';
      a.dataset.umamiEventUrl = 'https://example.org/';
      document.body.append(a);
      a.click();
    });
    await paint();
    events = await page.evaluate(() => window.testEvents);
    assert.equal(events.filter(e => e.data?.surface === 'timeline').length, 4);
    assert.ok(events.some(e => e.name === 'outbound-link-click' && e.data.url === 'https://example.org/'));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable:true, value:'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      scrollTo(0, 500);
    });
    await paint();
    assert.equal(await page.evaluate(() => window.testEvents.length), events.length);
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.testEvents.some(e => e.data?.thread_id === '7'));
    const failure = page.waitForRequest(request => request.url().endsWith('/__test/unavailable.js'));
    await page.evaluate(() => {
      const body = document.body.cloneNode(true);
      body.querySelector('script[data-umami-src]').dataset.umamiSrc = '/__test/unavailable.js';
      document.body.replaceWith(body);
      document.dispatchEvent(new Event('astro:page-load'));
    });
    await failure;
    await page.waitForFunction(() => window.umami?.track);
    const count = await page.evaluate(() => window.testEvents.length);
    await page.evaluate(() => {
      const body = document.body.cloneNode(true);
      body.querySelector('script[data-umami-src]').remove();
      document.body.replaceWith(body);
      document.dispatchEvent(new Event('astro:page-load'));
      document.querySelector('a').click();
    });
    await paint();
    assert.equal(await page.evaluate(() => window.testEvents.length), count);

  } finally {
    await page.close();
  }
}
