import assert from 'node:assert/strict';

export async function checkViewTransitions({ page, click, fill, heading }) {
  // Keep the real WAAPI effects so even a slow CI runner can inspect short transitions.
  const probe = await page.evaluateHandle(() => {
    const surface = document.querySelector('.home-grid').closest('.main-content > div');
    const effects = [];
    surface.animate = function (...args) {
      const animation = Element.prototype.animate.apply(this, args);
      effects.push(animation.effect);
      return animation;
    };
    return {
      frames: () => effects.splice(0).map(effect => effect.getKeyframes()[0]),
      dispose: () => { delete surface.animate; },
    };
  });
  const frames = () => probe.evaluate(record => record.frames());

  const dashboardTitle = await page.$eval('.home-grid .content-row strong', node => node.textContent);
  await page.waitForSelector('.thread-composer .markdown-source');
  await fill('.thread-composer .markdown-source', 'Keep this unsaved dashboard draft.');
  page.removeAllListeners('dialog');
  const dismissed = new Promise(resolve => page.once('dialog', async dialog => { await dialog.dismiss(); resolve(); }));
  await page.$eval('.home-grid .content-row', node => node.click());
  await dismissed;
  await heading('今天，写点什么？');
  assert.equal(await page.$eval('.thread-composer .markdown-source', node => node.value), 'Keep this unsaved dashboard draft.');
  assert.deepEqual(await frames(), [], 'Cancelling navigation keeps the draft and starts no animation');
  page.on('dialog', dialog => dialog.accept());
  await fill('.thread-composer .markdown-source', '');
  await page.$eval('.home-grid .content-row', node => node.click());
  await heading(dashboardTitle);
  await page.waitForSelector('.editor-page .markdown-source');
  assert.ok((await frames()).some(frame => frame.transform === 'translateX(6px)'), 'Opening the editor moves forward');

  await click('工作台');
  await heading('今天，写点什么？');
  assert.ok((await frames()).some(frame => frame.transform === 'translateX(-6px)'), 'Leaving the editor moves back');
  // Two committed navigations in consecutive frames interrupt the return transition.
  await page.evaluate(async () => {
    const tab = id => document.querySelector(`.mobile-tabbar [data-destination="${id}"]`).click();
    tab('media');
    await new Promise(requestAnimationFrame);
    tab('article');
  });
  await heading('文章');
  const peer = await frames();
  assert.ok(peer.some(frame => 'opacity' in frame) && peer.every(frame => !frame.transform), 'Peer sections only fade');

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  try {
    await click('工作台');
    await heading('今天，写点什么？');
    assert.deepEqual(await frames(), [], 'Reduced motion switches sections immediately');
    await page.waitForSelector('.home-grid .content-row');
    await page.$eval('.home-grid .content-row', node => node.click());
    await heading(dashboardTitle);
    assert.deepEqual(await frames(), [], 'Reduced motion also skips directional transitions');
    await click('工作台');
    await heading('今天，写点什么？');
  } finally {
    await page.emulateMediaFeatures([]);
    await probe.evaluate(record => record.dispose());
    await probe.dispose();
  }
}
