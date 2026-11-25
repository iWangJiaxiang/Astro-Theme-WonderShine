import assert from 'node:assert/strict';

// Exercise the shipped browser module with a delayed SDK and deterministic card sizes.
export async function checkThreadImpressions(browser, origin) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 300 });
    await page.setRequestInterception(true);
    let sdkRequest;
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/__test/tracker.js') { sdkRequest = request; return; }
      if (path !== '/__test/cards') return request.continue();
      return request.respond({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head>
        <style>*{margin:0}article{height:100px}</style></head><body>
        <div id="loading-box"></div><main data-thread-surface="home">
        ${Array.from({length:12}, (_, i) => '<article data-thread-id="' + i + '"></article>').join('')}
        </main><script type="module" src="/js/analytics.js" data-umami-src="/__test/tracker.js"
        data-website-id="test"></script></body></html>` });
    });
    await page.goto(origin + '/__test/cards', {waitUntil:'domcontentloaded'});
    // Give the observer a rendering opportunity while the loading mask is up.
    const paint = () => page.evaluate(() => new Promise(done =>
      requestAnimationFrame(() => requestAnimationFrame(done))));
    await paint();
    await page.evaluate(() => { document.querySelector('#loading-box').hidden = true; });
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
    await page.waitForFunction(() => document.querySelector('script[src="/__test/tracker.js"]') !== null);
    assert.ok(sdkRequest);
    await sdkRequest.respond({contentType:'text/javascript', body:`
      window.testEvents = [];
      window.umami = {track: callback => window.testEvents.push(callback({}))};`});
    await page.waitForFunction(() => window.testEvents?.length >= 8);
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
  } finally {
    await page.close();
  }
}
