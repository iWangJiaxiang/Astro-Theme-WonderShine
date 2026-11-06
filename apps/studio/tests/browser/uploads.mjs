import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { splitDocument } from '../../server/content.ts';
import { revealField } from './controls.mjs';
import { openImagePicker } from './image-picker.mjs';

export async function checkUploads({ page, base, theme, screenshots, click, heading, fill }) {
  const source = base + '/upload-fixtures'; await mkdir(source);
  await cp(theme + '/public/img/logo.webp', source + '/上传 配图.webp');
  await writeFile(source + '/invalid.webp', 'not an image');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(source + '/cover-upload.png', png);
  const revealUpload = async () => {
    await revealField(page, '.upload-file-input');
    await page.waitForSelector('.media-upload-disclosure[open] .upload-actions', { visible: true });
  };
  const upload = async files => {
    await revealUpload();
    // Exercise the visible upload action rather than injecting files into a
    // closed disclosure's native input, which is intentionally display:none.
    const [chooser] = await Promise.all([
      page.waitForFileChooser(),
      page.locator('.media-upload-disclosure[open] .upload-actions button').click(),
    ]);
    await chooser.accept(files.map(file => source + '/' + file));
  };
  const finished = () => page.waitForFunction(() => !document.querySelector('.upload-progress') && document.querySelector('.upload-results li'));
  const selected = () => page.$eval('.media-card.selected', el => el.dataset.mediaPath);
  await click('媒体库'); await heading('媒体库');
  await page.waitForFunction(() => !document.querySelector('.upload-file-input').disabled);
  await upload(['上传 配图.webp', 'invalid.webp']); await finished();
  assert.equal(await page.$$eval('.upload-results li', nodes => nodes.length), 2);
  assert.match(await page.$eval('.upload-error', el => el.textContent), /格式不匹配/);
  assert.equal(await selected(), 'public/uploads/上传 配图.webp');
  assert.deepEqual(await readFile(base + '/site/public/uploads/上传 配图.webp'), await readFile(source + '/上传 配图.webp'));
  await upload(['上传 配图.webp']); await finished();
  await page.waitForFunction(() => document.querySelector('.upload-results')?.textContent.includes('上传 配图-'));
  const renamed = await selected(); assert.match(renamed, /^public\/uploads\/上传 配图-[a-f0-9]+\.webp$/);
  assert.deepEqual(await readFile(base + '/site/' + renamed), await readFile(source + '/上传 配图.webp'));
  await page.screenshot({ path: screenshots + '/upload-library.png', fullPage: true });

  // Drag and drop uses the same upload path as the file chooser.
  await page.evaluate(bytes => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'dragged.png', { type: 'image/png' }));
    document.querySelector('.media-upload').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [...png]);
  await finished(); await page.waitForSelector('[data-media-path="public/uploads/dragged.png"]');
  assert.deepEqual(await readFile(base + '/site/public/uploads/dragged.png'), png);

  await click('站点信息'); await heading('站点信息');
  const original = await page.$eval('[name="extra.site.logo"]', el => el.value);
  await page.select('.language-switcher select', 'en');
  await heading('Site information');
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  await openImagePicker(page, 'extra.site.logo');
  await upload(['cover-upload.png']); await finished();
  assert.equal(await selected(), 'public/uploads/cover-upload.png');
  assert.equal(await page.$eval('[name="extra.site.logo"]', el => el.value), original, 'upload does not change a form before confirmation');
  assert.match(await page.$eval('.upload-results', el => el.textContent), /Uploaded:/);
  assert.ok(await page.$eval('.media-dialog-body', el => el.scrollWidth <= el.clientWidth), 'upload controls fit a mobile dialog');
  const picker = 'dialog.media-dialog[open]', body = `${picker} .media-dialog-body`;
  const layoutUploadRequests = [];
  const trackLayoutUpload = request => { if (new URL(request.url()).pathname === '/api/media/upload') layoutUploadRequests.push(request.url()); };
  page.on('request', trackLayoutUpload);
  try {
    for (const width of [320, 390]) {
      await page.setViewport({ width, height: 844 });
      const layout = await page.$eval(picker, dialog => {
        const rect = selector => dialog.querySelector(selector).getBoundingClientRect().toJSON();
        const rendered = node => {
          if (!node) return false;
          const box = node.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) return false;
          for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || ancestor.hidden) return false;
          }
          return true;
        };
        const compact = selector => {
          const control = dialog.querySelector(selector), label = control.querySelector(':scope > span');
          const field = control.querySelector(':scope > .choice-compact'), trigger = field?.querySelector(':scope > button.choice-trigger');
          const innerLabel = field?.querySelector(':scope > .sr-only');
          return {
            label: label?.textContent, visibleLabel: rendered(label), trigger: rendered(trigger),
            accessibleLabel: !!innerLabel && trigger?.getAttribute('aria-labelledby')?.split(' ').includes(innerLabel.id),
            fullWidth: !!trigger && Math.abs(trigger.getBoundingClientRect().width - control.getBoundingClientRect().width) <= 2,
            wraps: !!trigger && getComputedStyle(trigger.querySelector('span')).whiteSpace !== 'nowrap',
            flatOptions: control.querySelectorAll('.choice-options').length,
          };
        };
        return {
          toolbar: rect('.media-toolbar'), search: rect('.media-search input'), refresh: rect('.media-toolbar > button'),
          touchControls: [...dialog.querySelectorAll('.media-search input, .media-toolbar > button, .upload-actions > button, .upload-directory-control .choice-trigger, .media-filter-control .choice-trigger')]
            .map(node => ({ name: node.getAttribute('name') || node.type, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
          directory: compact('.upload-directory-control'), folder: compact('.media-filter-control'),
          folderValue: (() => {
            const trigger = dialog.querySelector('button[name="media-folder"]');
            return { text: trigger.textContent, name: trigger.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent.trim()).join(' ') };
          })(),
          filters: dialog.querySelectorAll('.media-filter-control').length,
          duplicateHeadings: dialog.querySelectorAll('.upload-actions strong').length,
          results: rendered(dialog.querySelector('.upload-results li button')), note: rendered(dialog.querySelector('.upload-note')),
          fitsViewport: dialog.getBoundingClientRect().left >= 0 && dialog.getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
        };
      });
      assert.ok(layout.search.width >= layout.toolbar.width - 2, `${width}px search uses the full toolbar row`);
      assert.ok(Math.abs(layout.search.left - layout.toolbar.left) <= 2 && Math.abs(layout.search.right - layout.toolbar.right) <= 2, `${width}px search aligns with toolbar edges`);
      assert.ok(layout.refresh.top >= layout.search.bottom, `${width}px refresh moves below search`);
      assert.ok(Math.abs(layout.refresh.right - layout.toolbar.right) <= 2, `${width}px refresh aligns right on its own row`);
      for (const control of layout.touchControls) assert.ok(control.width >= 44 && control.height >= 44, `${width}px ${control.name} has a nonzero 44px touch target`);
      assert.equal(layout.touchControls.length, 5, 'search, refresh, upload, directory and folder controls are measured');
      for (const [control, label] of [[layout.directory, 'Save to'], [layout.folder, 'Folder']]) {
        assert.equal(control.label, label);
        assert.ok(control.visibleLabel && control.trigger && control.accessibleLabel && control.fullWidth && control.wraps, `${width}px ${label} stays a labelled full-width compact trigger with wrapping text`);
        assert.equal(control.flatOptions, 0, `${label} does not render an inline option grid`);
      }
      assert.match(layout.folderValue.text, /All folders/, `${width}px empty folder selection displays its matched option label`);
      assert.equal(layout.folderValue.name, 'Folder All folders', `${width}px folder accessible name resolves both label and selected value IDs`);
      assert.equal(layout.filters, 1, 'public-image picker has the folder filter');
      assert.equal(layout.duplicateHeadings, 0, 'upload disclosure does not repeat its heading inside the actions');
      assert.ok(layout.results && layout.note, `${width}px uploaded result and save reminder remain rendered, not CSS-hidden`);
      assert.ok(layout.fitsViewport, `${width}px dialog and page fit the viewport`);
      assert.ok(await page.$eval(body, el => el.scrollWidth <= el.clientWidth), `${width}px upload controls fit without horizontal overflow`);
      await page.screenshot({ path: screenshots + (width === 390 ? '/upload-picker-mobile-en.png' : '/upload-picker-mobile-en-320.png') });

      // Existing fixture images plus the expanded upload panel must overflow.
      // Wheel in the body's padding, not over nested upload-results scrolling.
      const target = await page.$eval(body, node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        const x = box.left + node.clientLeft + parseFloat(style.paddingLeft) / 2;
        const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
        return { x, y, top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
          height: node.clientHeight, overflow: node.scrollHeight > node.clientHeight,
          scrollable: /^(auto|scroll)$/.test(style.overflowY), safePoint: document.elementFromPoint(x, y) === node };
      });
      assert.ok(target.height > 0 && target.overflow && target.scrollable, `${width}px fixture guarantees an overflowing media dialog body`);
      assert.ok(target.max > target.top + 1 && target.safePoint, `${width}px wheel starts in body padding with room to scroll down`);
      await page.mouse.move(target.x, target.y);
      await page.mouse.wheel({ deltaY: 160 });
      await page.waitForFunction(({ body, top }) => document.querySelector(body).scrollTop > top + 1, {}, { body, top: target.top });
      const down = await page.$eval(body, node => node.scrollTop);
      assert.ok(down > target.top + 1, `${width}px browser wheel actually scrolls the media body down`);
      await page.mouse.wheel({ deltaY: -160 });
      await page.waitForFunction(({ body, top }) => document.querySelector(body).scrollTop < top - 1, {}, { body, top: down });
      assert.ok(await page.$eval(body, node => node.scrollTop) < down - 1, `${width}px browser wheel actually scrolls the media body up`);
    }

    const directoryTrigger = `${picker} button[name="upload-directory"]`;
    const folderTrigger = `${picker} button[name="media-folder"]`;
    const chooser = '.selection-dialog[open]';
    const defaultDestination = await page.$eval(`${picker} .upload-destination`, el => el.textContent);
    assert.match(defaultDestination, /public\/uploads$/, 'public picker keeps the default upload destination');
    const pending = await page.$eval(`${picker} .media-pending`, el => el.textContent);
    const assertParentSelection = async () => {
      assert.equal(await page.$eval(picker, dialog => dialog.open && dialog.matches(':modal')), true, 'nested chooser leaves the parent media dialog open and modal');
      assert.equal(await selected(), 'public/uploads/cover-upload.png');
      assert.equal(await page.$eval(`${picker} .media-pending`, el => el.textContent), pending);
      assert.equal(await page.$eval(`${picker} .upload-destination`, el => el.textContent), defaultDestination);
    };
    await page.locator(directoryTrigger).click();
    await page.waitForSelector(chooser, { visible: true });
    await page.locator(`${chooser} input[value="public/img"]`).click();
    assert.equal(await page.$eval(`${chooser} input[value="public/img"]`, el => el.checked), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
    assert.equal(await page.$eval(directoryTrigger, el => document.activeElement === el), true, 'directory cancel restores trigger focus');
    await assertParentSelection();
    await page.locator(directoryTrigger).click();
    await page.waitForSelector(chooser, { visible: true });
    assert.equal(await page.$eval(`${chooser} input[value="public/uploads"]`, el => el.checked), true, 'cancelled directory candidate was not retained');
    await page.locator(`${chooser} .selection-footer button.primary`).click();
    await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
    assert.equal(await page.$eval(directoryTrigger, el => document.activeElement === el), true, 'directory confirm restores trigger focus');
    await assertParentSelection();

    await page.locator(folderTrigger).click();
    await page.waitForSelector(chooser, { visible: true });
    await page.locator(`${chooser} input[value="public/uploads"]`).click();
    await page.locator(`${chooser} .selection-footer button.primary`).click();
    await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
    assert.equal(await page.$eval(folderTrigger, el => document.activeElement === el), true, 'folder confirm restores trigger focus');
    assert.ok(await page.$$eval(`${picker} .media-card`, nodes => nodes.length > 0 && nodes.every(node => node.dataset.mediaPath.startsWith('public/uploads/'))), 'confirmed folder filters the image list');
    await assertParentSelection();
    await page.locator(folderTrigger).click();
    await page.waitForSelector(chooser, { visible: true });
    await page.locator(`${chooser} input[value=""]`).click();
    await page.locator(`${chooser} .selection-footer button.primary`).click();
    await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
    assert.ok(await page.$$eval(`${picker} .media-card`, nodes => nodes.some(node => !node.dataset.mediaPath.startsWith('public/uploads/'))), 'clearing the folder restores other fixture images');
    await assertParentSelection();

    const fileInput = await page.$(`${picker} .upload-file-input`);
    const results = await page.$(`${picker} .upload-results`);
    try {
      await page.locator(`${picker} .media-upload-disclosure > summary`).click();
      await page.waitForFunction(selector => !document.querySelector(selector).open, {}, `${picker} .media-upload-disclosure`);
      assert.equal(await fileInput.evaluate(node => node.isConnected && node.ownerDocument.defaultView === window && node === document.querySelector('dialog.media-dialog[open] .upload-file-input')), true, 'collapse retains the same file input in the same window');
      await page.locator(`${picker} .media-upload-disclosure > summary`).click();
      await page.waitForSelector(`${picker} .media-upload-disclosure[open] .upload-actions`, { visible: true });
      assert.equal(await fileInput.evaluate(node => node.isConnected && node.ownerDocument.defaultView === window && node === document.querySelector('dialog.media-dialog[open] .upload-file-input')), true, 'reopen retains the original file input node without reading its value');
      assert.equal(await results.evaluate(node => node.isConnected && node === document.querySelector('dialog.media-dialog[open] .upload-results') && node.getBoundingClientRect().height > 0), true, 'reopen retains and renders the original upload results');
      await assertParentSelection();
    } finally {
      await fileInput.dispose();
      await results.dispose();
    }
    assert.deepEqual(layoutUploadRequests, [], 'layout, nested choosers and disclosure toggles do not upload again');
  } finally {
    page.off('request', trackLayoutUpload);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('[name="extra.site.logo"]', el => el.value), original, 'cancel leaves the form unchanged');
  assert.deepEqual(await readFile(base + '/site/public/uploads/cover-upload.png'), png, 'cancel retains the uploaded image');
  await page.setViewport({ width: 1440, height: 1000 });
  await page.select('.language-switcher select', 'zh-CN');
  await openImagePicker(page, 'extra.site.logo');
  await fill('dialog.media-dialog[open] [aria-label="搜索仓库图片"]', 'cover-upload.png');
  await page.waitForSelector('[data-media-path="public/uploads/cover-upload.png"]');
  await page.click('[data-media-path="public/uploads/cover-upload.png"]'); await click('使用这张图片');
  await click('本地保存'); await page.waitForSelector('.notice.success');
  assert.equal(parse(await readFile(base + '/site/config.toml', 'utf8')).extra.site.logo, '/uploads/cover-upload.png');

  await click('文章'); await heading('文章');
  await page.waitForSelector('[data-path="content/articles/studio-browser-test/index.md"]');
  await page.click('[data-path="content/articles/studio-browser-test/index.md"]');
  await page.waitForSelector('.markdown-source');
  await openImagePicker(page, 'extra.cover');
  await revealUpload();
  await page.waitForSelector('.upload-destination', { visible: true });
  assert.equal(await page.$eval('.upload-destination', el => el.textContent), '文件位置：content/articles/studio-browser-test');
  await upload(['cover-upload.png']); await finished();
  assert.equal(await selected(), 'content/articles/studio-browser-test/cover-upload.png');
  await click('使用这张图片');
  assert.equal(await page.$eval('[name="extra.cover"]', el => el.value), 'cover-upload.png');
  await page.$eval('.markdown-source', el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await click('插入图片'); await page.waitForSelector('dialog.media-dialog[open]');
  assert.deepEqual(await page.$$eval('dialog.media-dialog[open] .media-filter-control', controls => controls.map(control => {
    const label = control.querySelector(':scope > span'), field = control.querySelector(':scope > .choice-compact');
    const trigger = field?.querySelector(':scope > button.choice-trigger'), innerLabel = field?.querySelector(':scope > .sr-only');
    return { label: label?.textContent, visible: !!label && label.getBoundingClientRect().width > 0 && label.getBoundingClientRect().height > 0 && getComputedStyle(label).visibility === 'visible',
      compact: !!trigger && !!innerLabel && trigger.getAttribute('aria-labelledby')?.split(' ').includes(innerLabel.id),
      flatOptions: control.querySelectorAll('.choice-options').length };
  })), [
    { label: '图片来源', visible: true, compact: true, flatOptions: 0 },
    { label: '文件夹', visible: true, compact: true, flatOptions: 0 },
  ], 'document picker source and folder filters both use labelled compact triggers');
  await upload(['上传 配图.webp']); await finished();
  assert.equal(await selected(), 'content/articles/studio-browser-test/上传 配图.webp');
  await click('使用这张图片'); await click('本地保存'); await page.waitForSelector('.editor-page > .notice.success');
  const saved = splitDocument(await readFile(base + '/site/content/articles/studio-browser-test/index.md', 'utf8'));
  assert.equal(parse(saved.header).extra.cover, 'cover-upload.png');
  assert.match(saved.body, /!\[上传 配图.webp\]\(%E4%B8%8A%E4%BC%A0%20%E9%85%8D%E5%9B%BE.webp\)/);
  assert.deepEqual(await readFile(base + '/site/content/articles/studio-browser-test/cover-upload.png'), png);
  // A cloud capability response must lower the client limit without changing the local server.
  await click('媒体库'); await heading('媒体库');
  await page.evaluate(() => {
    window.originalUploadTestFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.originalUploadTestFetch(...args);
      if (String(args[0]).startsWith('/api/media?')) {
        const data = await response.clone().json();
        return new Response(JSON.stringify({ ...data, maxFileSize: 4 * 1024 * 1024 }), { status: response.status, headers: response.headers });
      }
      return response;
    };
  });
  await click('刷新仓库');
  await revealUpload();
  await page.waitForFunction(() => document.querySelector('.upload-actions')?.textContent.includes('4 MB'));
  await writeFile(source + '/cloud-too-large.png', Buffer.alloc(4 * 1024 * 1024 + 1));
  const uploadRequests = [];
  const track = request => { if (request.url().includes('/api/media/upload')) uploadRequests.push(request.url()); };
  page.on('request', track);
  await upload(['cloud-too-large.png']); await finished();
  assert.match(await page.$eval('.upload-error', el => el.textContent), /4 MB/);
  assert.deepEqual(uploadRequests, [], 'oversized cloud uploads must be rejected before sending');
  page.off('request', track);
  await page.evaluate(() => { window.fetch = window.originalUploadTestFetch; delete window.originalUploadTestFetch; });
  await click('刷新仓库');
  await page.waitForFunction(() => document.querySelector('.upload-actions')?.textContent.includes('20 MB'));
  console.log('PASS: batch and drag uploads, mixed failures, duplicate renaming, public and bundle paths, picker cancel/confirm, 320/390px English layout, bidirectional browser wheel scrolling, nested compact chooser cancel/confirm and focus, disclosure node retention and saved cover/Markdown.');
}
