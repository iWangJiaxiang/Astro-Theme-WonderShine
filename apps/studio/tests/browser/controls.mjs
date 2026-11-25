import assert from 'node:assert/strict';

export async function revealField(page, selector) {
  await page.waitForSelector(selector);
  // Structured forms now start collapsed; open their summaries from the outside in.
  await page.evaluate(selector => {
    const summaries = [];
    for (let node = document.querySelector(selector)?.parentElement; node; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement && !node.open) summaries.unshift(node.querySelector(':scope > summary'));
      if (node.classList.contains('structured-item')) {
        const toggle = node.querySelector(':scope > button.structured-toggle[aria-expanded="false"]');
        if (toggle) summaries.unshift(toggle);
      }
    }
    for (const summary of summaries) summary.click();
  }, selector);
  await page.waitForSelector(selector, { visible: true });
}

// Exercise real radios/checkboxes and the dialog, without hidden native selects.
export function chooser(page) {
  return async (name, value) => {
    const root = `[data-field="${name}"]`;
    await page.waitForSelector(root);
    await revealField(page, root);
    await page.waitForFunction(root => { const el = document.querySelector(root); return el && !el.querySelector('fieldset:disabled, button.choice-trigger:disabled'); }, {}, root);
    const trigger = `${root} > .choice-trigger`;
    if (await page.$(trigger)) {
      await page.locator(trigger).click();
      await page.waitForSelector('.selection-dialog[open]');
      await page.waitForSelector(`.selection-dialog[open] input[value="${value}"]`);
      await page.click(`.selection-dialog[open] input[value="${value}"]`);
      await page.click('.selection-dialog[open] .selection-footer button');
      await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
    } else {
      await page.waitForSelector(`${root} input[value="${value}"]`);
      await page.click(`${root} input[value="${value}"]`);
    }
  };
}

export async function checkControls({ page, click, heading, fill, base, screenshots, choose }) {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { patchToml, splitDocument } = await import('../../server/content.ts');
  const { parse } = await import('smol-toml');
  const configFile = base + '/site/config.toml';
  const themeResponse = method => page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/settings/theme' && response.request().method() === method);
  async function saveTheme(expectedRevision) {
    const [response] = await Promise.all([themeResponse('PUT'), click('本地保存')]);
    const submitted = JSON.parse(response.request().postData());
    if (expectedRevision !== undefined) assert.equal(submitted.revision, expectedRevision, 'save submits the revision returned by the fresh settings GET');
    assert.equal(response.status(), 200, 'blog theme save must succeed directly, without conflict retries');
    await page.waitForFunction(() => {
      const button = document.querySelector('.settings-page .page-heading .primary');
      return button?.disabled && document.querySelector('.settings-page .notice.success') && !document.querySelector('.settings-page .notice.error');
    });
    return response.json();
  }
  await page.$eval('.studio-preferences', node => { node.open = true; });
  const beforeAppearance = await readFile(configFile, 'utf8');
  await click('外观样式'); await heading('外观样式');
  assert.equal(await page.$('[data-field="extra.theme.channel"]'), null);
  assert.equal(await page.$('[data-field="extra.style.universe"]'), null);
  await choose('extra.style.color_scheme', 'dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await readFile(configFile, 'utf8'), beforeAppearance);
  await page.screenshot({ path: screenshots + '/studio-appearance-desktop.png' });
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#studio-navigation').getBoundingClientRect().right <= 1);
  const schemeChoices = '[data-field="extra.style.color_scheme"] input[type=radio]';
  const choices = await page.$$eval(schemeChoices, inputs => inputs.map(input => {
    const tile = input.closest('label');
    const box = tile.getBoundingClientRect();
    return { checked: input.checked, top: box.top, width: box.width, height: box.height,
      indicatorOpacity: getComputedStyle(input).opacity, background: getComputedStyle(tile).backgroundColor };
  }));
  assert.equal(choices.length, 3);
  assert.equal(new Set(choices.map(choice => choice.top)).size, 1, 'short radio choices share a row');
  assert.ok(choices.every(choice => choice.indicatorOpacity === '0' && choice.width >= 44 && choice.height >= 44),
    'the label replaces the radio circle and retains a touch target');
  assert.notEqual(choices.find(choice => choice.checked).background, choices.find(choice => !choice.checked).background);
  await page.screenshot({ path: screenshots + '/studio-appearance-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewport({ width: 1440, height: 1000 });
  for (const [accent, foreground] of [['#222222', 'rgb(255, 255, 255)'], ['#eeeeee', 'rgb(0, 0, 0)']]) {
    await fill('[name="extra.style.theme_dark_skin"]', accent);
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.brand-mark')).color === color, {}, foreground);
    const ratio = await page.$eval('.studio-preferences [aria-current=page]', button => {
      const ctx = document.createElement('canvas').getContext('2d');
      function luminance(colors) {
        for (const color of colors) { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); }
        const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].map(byte => {
          const value = byte / 255;
          return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
      }
      const style = getComputedStyle(button);
      const background = luminance([getComputedStyle(button.closest('.sidebar')).backgroundColor, style.backgroundColor]);
      const text = luminance([style.color]);
      return (Math.max(background, text) + .05) / (Math.min(background, text) + .05);
    });
    assert.ok(ratio >= 4.5, 'active navigation text stays readable on its tinted surface');
  }
  await click('恢复站点默认外观');
  await click('主题维护'); await heading('主题维护');
  assert.equal(await page.$$eval('[data-field="extra.style.color_scheme"] input[type=radio]', nodes => nodes.length), 3);
  assert.equal(await page.$$eval('[data-field="extra.style.font_family"] input[type=radio]', nodes => nodes.length), 5, 'exactly five values remain flat');
  const themeChannel = '[data-field="extra.theme.channel"]';
  assert.equal(await page.$eval(themeChannel + ' input:checked', el => el.value), 'latest');
  assert.equal(await page.$eval('[name="extra.theme.pinned"]', el => el.checked), false);
  assert.equal(await page.$('[name="extra.theme.version"]'), null);
  await page.click('[name="extra.theme.pinned"]');
  await fill('[name="extra.theme.version"]', '0.2.1');
  await choose('extra.theme.channel', 'canary');
  assert.equal(await page.$eval('[name="extra.theme.version"]', el => el.value), '');
  await fill('[name="extra.theme.version"]', '0.2.1');
  await page.screenshot({ path: screenshots + '/theme-version-desktop.png' });
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#studio-navigation').getBoundingClientRect().right <= 1);
  await page.screenshot({ path: screenshots + '/theme-version-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.click('[name="extra.theme.pinned"]');
  await choose('extra.style.color_scheme', 'light');
  await fill('[aria-label="选择浅色主题色"]', '#3355aa');
  assert.equal(await page.$eval('[name="extra.style.theme_light_skin"]', e => e.value), '#3355aa');
  assert.equal(await page.$eval('[data-field="extra.style.theme_light_skin"] .color-swatch', e => getComputedStyle(e).backgroundColor), 'rgb(51, 85, 170)');
  await saveTheme();
  const packageFile = base + '/site/package.json';
  assert.equal(JSON.parse(await readFile(packageFile, 'utf8')).dependencies['@wondershine/theme'], '1.2.3-canary.0');
  assert.equal(parse(await readFile(base + '/site/config.toml', 'utf8')).extra.style.theme_light_skin, '#3355aa');
  assert.equal(parse(await readFile(base + '/site/config.toml', 'utf8')).extra.theme.channel, 'canary');
  await page.screenshot({ path: screenshots + '/form-colors.png', fullPage: true });

  await click('检查更新');
  await page.waitForFunction(() => document.querySelector('.theme-update-controls')?.textContent.includes('1.2.3-canary.1'));
  const beforeRebuild = await readFile(configFile, 'utf8');
  await page.screenshot({ path: screenshots + '/theme-update-result-desktop.png' });
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#studio-navigation').getBoundingClientRect().right <= 1);
  await page.screenshot({ path: screenshots + '/theme-update-result-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewport({ width: 1440, height: 1000 });
  const [rebuild] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/theme-update' && response.request().method() === 'POST'), click('更新到此版本')]);
  assert.equal(rebuild.status(), 200);
  const rebuiltText = await readFile(configFile, 'utf8');
  assert.equal(JSON.parse(await readFile(packageFile, 'utf8')).dependencies['@wondershine/theme'], '1.2.3-canary.1');
  assert.deepEqual(parse(rebuiltText), parse(beforeRebuild));
  await page.waitForSelector('.settings-page .notice.success');
  await page.waitForSelector('.theme-progress[open]');
  await page.click('.theme-progress > button');
  await click('工作台'); await heading('今天，写点什么？');
  await writeFile(configFile, patchToml(await readFile(configFile, 'utf8'), { 'extra.style.font_family': 'Custom Font' }));
  const [freshResponse] = await Promise.all([themeResponse('GET'), click('主题维护')]);
  assert.equal(freshResponse.status(), 200);
  const freshAppearance = await freshResponse.json();
  assert.equal(freshAppearance.values['extra.style.font_family'], 'Custom Font');
  assert.equal(typeof freshAppearance.revision, 'string');
  assert.ok(freshAppearance.revision);
  await heading('主题维护');
  await page.waitForSelector('button[name="extra.style.font_family"]');
  assert.equal(await page.$('[data-field="extra.style.font_family"] fieldset'), null, 'six values use a modal, including existing custom value');
  await page.click('button[name="extra.style.font_family"]'); await page.waitForSelector('.selection-dialog[open]');
  assert.equal(await page.$eval('.selection-dialog[open] .selection-results', el => el.querySelectorAll('input').length), 6);
  assert.equal(await page.$eval('.selection-dialog[open] input[value="Custom Font"]', el => el.checked), true, 'legacy values are retained');
  assert.ok(await page.$eval('.selection-field-panel > .selection-results', node => {
    const last = [...node.querySelectorAll('.choice-tile')].at(-1);
    const style = getComputedStyle(node);
    if (!last) return false;
    const gap = node.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
    return gap >= -1 && gap <= parseFloat(style.paddingBottom) + 2 && node.scrollHeight <= node.clientHeight + 1;
  }), 'short option lists fit their content without a fixed-height blank results area');
  await page.click('.selection-dialog[open] input[value="system-ui"]');
  await click('取消');
  assert.ok(await page.$eval('button[name="extra.style.font_family"]', el => el.textContent.includes('Custom Font')));
  await choose('extra.style.font_family', 'PingFang SC');
  await saveTheme(freshAppearance.revision);
  assert.equal(parse(await readFile(configFile, 'utf8')).extra.style.font_family, 'PingFang SC');

  await click('导航菜单'); await heading('导航菜单');
  const name = 'menu.nav_menu.0.menus.0.icon';
  await page.waitForSelector(`button[name="${name}"]`);
  await revealField(page, `button[name="${name}"]`);
  await page.click(`button[name="${name}"]`); await page.waitForSelector('.selection-dialog[open]');
  assert.ok(await page.$eval('.selection-field-panel', panel => {
    const results = panel.querySelector('.selection-results'), footer = panel.querySelector('.selection-footer');
    const view = window.visualViewport;
    const bottom = (view?.offsetTop ?? 0) + (view?.height ?? innerHeight);
    return results.clientHeight > 0 && results.scrollHeight > results.clientHeight && footer.getBoundingClientRect().bottom <= bottom;
  }), 'long option lists scroll within the visible viewport and keep confirmation reachable');
  for (const width of [1440, 390]) {
    const height = width === 390 ? 844 : 1000;
    await page.setViewport({ width, height });
    // CDP acknowledges the resize before the page's resize listeners necessarily
    // publish the matching overlay constraints. Establish readiness before the
    // one-shot target snapshot; never poll geometry/hit validity or replay input.
    await page.waitForFunction(({ width, height }) => {
      const view = window.visualViewport, root = document.documentElement.style;
      return innerWidth === width && innerHeight === height &&
        (!view || (view.width === width && view.height === height && view.scale === 1 && view.offsetLeft === 0 && view.offsetTop === 0)) &&
        parseFloat(root.getPropertyValue('--studio-visible-width')) === (view?.width ?? innerWidth) &&
        parseFloat(root.getPropertyValue('--native-visible-height')) === (view?.height ?? innerHeight) &&
        parseFloat(root.getPropertyValue('--studio-visible-left')) === (view?.offsetLeft ?? 0) &&
        parseFloat(root.getPropertyValue('--native-visible-top')) === (view?.offsetTop ?? 0);
    }, { timeout: 5000 }, { width, height });
    const selector = '.selection-dialog[open] .selection-results';
    const target = await page.$eval(selector, (node, expected) => {
      const rect = node.getBoundingClientRect();
      const target = { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2, top:node.scrollTop };
      const view = window.visualViewport, root = document.documentElement.style;
      const hit = document.elementFromPoint(target.x, target.y);
      target.validity = {
        unique: document.querySelectorAll(expected.selector).length === 1,
        connected: node.isConnected,
        viewportMatches: innerWidth === expected.width && innerHeight === expected.height &&
          (!view || (view.width === expected.width && view.height === expected.height && view.scale === 1 && view.offsetLeft === 0 && view.offsetTop === 0)),
        trackerMatches: parseFloat(root.getPropertyValue('--studio-visible-width')) === (view?.width ?? innerWidth) &&
          parseFloat(root.getPropertyValue('--native-visible-height')) === (view?.height ?? innerHeight) &&
          parseFloat(root.getPropertyValue('--studio-visible-left')) === (view?.offsetLeft ?? 0) &&
          parseFloat(root.getPropertyValue('--native-visible-top')) === (view?.offsetTop ?? 0),
        finitePoint: Number.isFinite(target.x) && Number.isFinite(target.y),
        pointInViewport: target.x >= 0 && target.x < innerWidth && target.y >= 0 && target.y < innerHeight,
        hitInResults: !!hit && node.contains(hit),
        downwardRange: node.scrollHeight > node.clientHeight && node.scrollTop < node.scrollHeight - node.clientHeight,
      };
      return target;
    }, { selector, width, height: width === 390 ? 844 : 1000 });
    // Fail before dispatch; never repair, clamp or retry an invalid input target.
    assert.deepEqual(target.validity, {
      unique:true, connected:true, viewportMatches:true, trackerMatches:true,
      finitePoint:true, pointInViewport:true, hitInResults:true, downwardRange:true,
    }, 'Icon chooser wheel target invalid or viewport/layout snapshot mismatched');
    await page.mouse.move(target.x, target.y);
    await page.mouse.wheel({ deltaY:160 });
    await page.waitForFunction(({selector,top}) => document.querySelector(selector).scrollTop > top + 1, {}, {selector,top:target.top});
    const down = await page.$eval(selector, node => node.scrollTop);
    await page.mouse.wheel({ deltaY:-160 });
    await page.waitForFunction(({selector,top}) => document.querySelector(selector).scrollTop < top - 1, {}, {selector,top:down});
    await page.screenshot({ path: screenshots + `/form-icon-scroll-${width}.png` });
  }
  await page.setViewport({ width:1440, height:1000 });
  await fill('.selection-dialog[open] input[type=search]', 'github');
  await page.click('.selection-dialog[open] input[value="icon-github"]');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
  assert.equal(await page.evaluate(name => document.activeElement?.getAttribute('name') === name, name), true, 'Escape restores focus');
  assert.equal(await page.$eval('.settings-page .page-heading .primary', e => e.disabled), true, 'cancel must not change form');
  await choose(name, 'icon-github');
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.$eval(`[data-field="${name}"] .studio-glyph`, el => el.textContent.length > 0 && getComputedStyle(el).fontFamily.includes('studio-icons')));
  await click('本地保存'); await page.waitForSelector('.notice.success');
  assert.equal(parse(await readFile(base + '/site/data.toml', 'utf8')).menu.nav_menu[0].menus[0].icon, 'icon-github');

  await click('关于页设置'); await heading('关于页设置');
  const emojiField = 'extra.about.author_info_left_tags.0';
  await page.waitForSelector(`[name="${emojiField}"]`);
  const before = await page.$eval(`[name="${emojiField}"]`, el => el.value);
  await choose(emojiField + '-emoji', '🚀');
  assert.ok(await page.$eval(`[name="${emojiField}"]`, el => el.value.includes('🚀') && el.value.includes('数码科技爱好者')));
  await click('本地保存'); await page.waitForSelector('.notice.success');
  assert.notEqual(before, parse(await readFile(base + '/site/config.toml', 'utf8')).extra.about.author_info_left_tags[0]);

  await click('首页推荐'); await heading('首页推荐');
  const path = 'articles/welcome/index.md';
  await choose('post.today_recommend.post_path', path);
  await click('本地保存'); await page.waitForSelector('.notice.success');
  assert.equal(parse(await readFile(base + '/site/data.toml', 'utf8')).post.today_recommend.post_path, path);

  // Creation form remains open when Enter is pressed in a nested chooser.
  await click('页面'); await heading('页面');
  const createButton = '.content-library .page-heading button.primary';
  await page.locator(createButton).click();
  await fill('.modal input[placeholder="给它取个名字"]', 'Enter should not create');
  await fill('.modal input[placeholder="my-first-story"]', 'do-not-create');
  await page.click('button[name="page-template"]'); await page.waitForSelector('.selection-dialog[open]');
  await page.type('.selection-dialog[open] input[type=search]', '装备'); await page.keyboard.press('Enter');
  assert.ok(await page.$('.modal'), 'Enter inside dialog must not submit parent creation form');
  assert.ok(await page.$('.selection-dialog[open]'));
  await page.focus('.selection-dialog[open] input[value="equipment"]'); await page.keyboard.press('Enter');
  assert.ok(await page.$('.modal'), 'Enter on a radio must not submit the creation form');
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.$eval('.selection-dialog[open]', el => el.getBoundingClientRect().width <= innerWidth));
  await page.screenshot({ path: screenshots + '/form-picker-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.selection-dialog', { hidden: true });
  assert.ok(await page.$eval('.creation-dialog', dialog => dialog.matches(':modal')), 'creation stays modal after the chooser closes');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.creation-dialog', { hidden: true });
  assert.ok(await page.$eval(createButton, button => button === document.activeElement), 'closing creation returns focus to the opener');
  await page.setViewport({ width: 1440, height: 1000 });

  // Resume the same creation draft after its saved language disappears.
  await page.locator(createButton).click();
  await choose('create-language', 'zh-CN');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.creation-dialog', { hidden: true });
  await choose('library-language', 'zh-CN');
  await page.evaluate(() => {
    const fetchOriginal = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      if (new URL(response.url).pathname !== '/api/content-languages') return response;
      window.fetch = fetchOriginal;
      return Response.json({ defaultLanguage: 'en', languages: ['en'] });
    };
  });
  await click('刷新内容');
  await page.waitForSelector('[name="library-language"][value="en"]:checked');
  assert.equal(await page.$('[name="library-language"][value="zh-CN"]'), null);
  await page.locator(createButton).click();
  assert.equal(await page.$('.creation-dialog [name="create-language"][value="zh-CN"]'), null);
  await page.waitForSelector('.creation-dialog .primary:disabled');
  assert.equal(await page.$eval('[name="creation-title"]', node => node.value), 'Enter should not create');
  await choose('create-language', 'en');
  await page.waitForSelector('.creation-dialog .primary:not(:disabled)');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.creation-dialog', { hidden: true });

  await mkdir(base + '/site/content/articles/date-control', { recursive: true });
  const dateFile = base + '/site/content/articles/date-control/index.md';
  await writeFile(dateFile, '+++\ntitle="Calendar control test"\ndate=2026-10-24T00:30:12.123456+08:00\nupdated=2026-10-25T10:20:30Z\n[taxonomies]\ntags=[]\ncategories=[]\n+++\nCalendar body.');
  await click('文章'); await heading('文章');
  await page.waitForSelector('.content-row[data-path="content/articles/date-control/index.md"]');
  await page.click('.content-row[data-path="content/articles/date-control/index.md"]');
  await page.waitForSelector('input[name="date"][type=date]');
  assert.equal(await page.$eval('input[name="date"]', el => el.value), '2026-10-24', 'must show original calendar day, not UTC previous day');
  await fill('input[name="date"]', '2026-10-26');
  await fill('input[name="updated"]', '');
  await click('本地保存'); await page.waitForSelector('.notice.success');
  const dateData = parse(splitDocument(await readFile(dateFile, 'utf8')).header);
  assert.equal(dateData.date, '2026-10-26T00:30:12.123456+08:00');
  assert.equal(Object.hasOwn(dateData, 'updated'), false, 'clearing updated removes the field, not an invalid empty datetime');
  await page.screenshot({ path: screenshots + '/form-date-editor.png', fullPage: true });
  await fill('input[name="date"]', ''); await click('本地保存');
  await page.waitForSelector('.editor-page > .notice.error');
  assert.match(await page.$eval('.editor-page > .notice.error', el => el.textContent), /需要发布时间/);
  assert.equal(parse(splitDocument(await readFile(dateFile, 'utf8')).header).date, '2026-10-26T00:30:12.123456+08:00');
  await click('← 返回内容库');


  await click('页面'); await heading('页面');
  await page.waitForSelector('.content-row[data-path="content/pages/about.md"]');
  await page.click('.content-row[data-path="content/pages/about.md"]'); await page.waitForSelector('.page-editor-tabs'); await click('页面设置');
  await click('技能清单'); await page.waitForSelector('[name="skill.items.0.name"]');
  await choose('skill.items.0.svg_symbol_id', 'python');
  await page.waitForFunction(() => document.querySelector('[data-field="skill.items.0.svg_symbol_id"] use')?.getAttribute('href')?.endsWith('#python'));
  await click('本地保存设置'); await page.waitForSelector('.embedded-settings .notice.success');
  const skills = parse(await readFile(base + '/site/data.toml', 'utf8')).skill;
  assert.equal(skills.items[0].svg_symbol_id, 'python');
  assert.equal(Object.hasOwn(skills.items[0], 'svg_sprite'), false, 'inherited sprite must stay absent');
  await click('赞赏名单'); await page.waitForSelector('[name="extra.about_reward.reward.name"]');
  await click('＋ 添加赞赏者');
  await page.waitForSelector('[name="extra.about_reward.sponsors.2.date"]');
  assert.match(await page.$eval('[name="extra.about_reward.sponsors.2.date"]', el => el.value), /^\d{4}-\d{2}-\d{2}$/);
  await click('放弃更改并重新加载');

  console.log('PASS: flat choices, color previews, icon font, emoji text preservation, file references and nested modal keyboard behavior.');
}
