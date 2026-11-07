import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { splitDocument } from '../../server/content.ts';
import { revealField } from './controls.mjs';
import { openImagePicker } from './image-picker.mjs';

export async function checkUploads({ page, base, theme, screenshots, click, heading, fill, mediaDiagnostics, folderClearDiagnostics }) {
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
  const disclosureState = async (selector, open, nextTraceStage) => {
    const waitId = mediaDiagnostics?.nextWait();
    let outcome = 'failed';
    try {
      await page.waitForFunction(({ selector, open, waitId }) => {
        const node = document.querySelector(selector);
        const matched = node?.open === open;
        // Sample this exact predicate invocation; do not introduce a second poll.
        try { window.__mediaDisclosureDiagnostics?.sampleWait(waitId, node, matched, open, selector.includes('media-library') ? 'library' : 'picker'); } catch {}
        return matched;
      }, {}, { selector, open, waitId });
      outcome = 'passed';
    } finally {
      // The collector retains diagnostic errors, never replaces this wait's error.
      await mediaDiagnostics?.endWait(waitId, outcome, { nextTraceStage });
    }
    assert.equal(await page.$eval(`${selector} > summary`, node => {
      const minimum = document.documentElement.dataset.nativePlatform === 'android' ? 48 : 44;
      const box = node.getBoundingClientRect();
      return !!node.textContent.trim() && box.height >= minimum && box.width >= minimum;
    }), true, 'disclosure has a meaningful name and the platform touch target');
  };
  const initialPreview = async root => {
    // Capture pre-readiness geometry, including any partially translated sidebar.
    await mediaDiagnostics?.snapshot(root.startsWith('.media-library') ? 'library-preview-pre-ready' : 'picker-preview-pre-ready');
    await page.waitForFunction(root => {
      const browser = document.querySelector(root);
      const loaded = browser?.getAttribute('aria-busy') === 'false' && [...browser.querySelectorAll('.media-thumbnail img')].some(image => image.complete && image.naturalWidth > 0);
      const sidebar = document.querySelector('.sidebar');
      const sidebarReady = !!sidebar && sidebar.getBoundingClientRect().right <= 0 && sidebar.inert && !sidebar.classList.contains('open') && !document.querySelector('.sidebar-backdrop');
      try { window.__mediaDisclosureDiagnostics?.previewSample(root.startsWith('.media-library') ? 'library' : 'picker', !!loaded, sidebarReady); } catch {}
      return loaded && sidebarReady;
    }, {}, root);
    if (root.startsWith('.media-library')) {
      const context = await page.evaluate(() => ({
        windowX: window.scrollX, windowY: window.scrollY,
        rootX: document.scrollingElement.scrollLeft, rootY: document.scrollingElement.scrollTop,
      }));
      assert.deepEqual(context, { windowX: 0, windowY: 0, rootX: 0, rootY: 0 }, 'initial library preview is measured at the actual unscrolled window/root context, without a test scroll reset');
    }
    const target = root.startsWith('.media-library') ? 'library' : 'picker';
    let preview;
    try {
      preview = await page.$eval(root, browser => {
        const body = browser.closest('.media-dialog-body');
        const footer = browser.closest('dialog')?.querySelector('.selection-footer');
        const clip = body?.getBoundingClientRect();
        const top = Math.max(0, clip?.top ?? 0);
        let footerBox;
        const bottom = Math.min(innerHeight, clip?.bottom ?? innerHeight, (footerBox = footer?.getBoundingClientRect())?.top ?? innerHeight);
        const images = [...browser.querySelectorAll('.media-thumbnail img')];
        const candidates = images.filter(image => image.complete && image.naturalWidth > 0);
        const visited = [];
        let visitedTotal = 0, captureFailed = false, bodyScrollReadForPredicate = false, bodyScrollTopForPredicate = null;
        const remember = entry => {
          try { if (visited.length < 24) visited.push(entry); } catch { captureFailed = true; }
        };
        const imageMatched = candidates.some(image => {
          visitedTotal++;
          const box = image.getBoundingClientRect();
          const left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
          const visibleTop = Math.max(top, box.top), visibleBottom = Math.min(bottom, box.bottom);
          // Show at least a square half-thumbnail region, not a one-pixel sliver.
          const meaningful = Math.min(box.width, box.height) / 2;
          if (meaningful <= 0 || right - left < meaningful || visibleBottom - visibleTop < meaningful) {
            remember({ image, box, left, right, visibleTop, visibleBottom, meaningful, geometryPassed: false, hitTestCalled: false, hit: null, cardContainsHit: null });
            return false;
          }
          const hit = document.elementFromPoint((left + right) / 2, (visibleTop + visibleBottom) / 2);
          const cardContainsHit = image.closest('.media-card').contains(hit);
          remember({ image, box, left, right, visibleTop, visibleBottom, meaningful, geometryPassed: true, hitTestCalled: true, hit, cardContainsHit });
          return cardContainsHit;
        });
        const matched = imageMatched && (!body || (bodyScrollReadForPredicate = true, (bodyScrollTopForPredicate = body.scrollTop) === 0));
        // No extra DOM reads precede matched; retained rectangles/hits are from the predicate.
        let sample;
        try {
          const faults = [];
          let droppedFaults = 0;
          const read = (stage, action) => {
            try { return action(); } catch { if (faults.length < 8) faults.push(stage); else droppedFaults++; return null; }
          };
          const numeric = n => typeof n === 'number' && Number.isFinite(n) ? n : null;
          const rect = box => box ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, numeric(box[key])])) : null;
          const role = node => !node ? null : node.matches('img') ? 'img' : node.closest('.media-card') ? 'media-card' : node.closest('.selection-footer') ? 'footer' : node.closest('.media-dialog-body') ? 'body' : node.closest('dialog') ? 'dialog' : 'other';
          const scroll = node => node ? { scrollTop: numeric(node.scrollTop), clientHeight: numeric(node.clientHeight), scrollHeight: numeric(node.scrollHeight) } : null;
          sample = {
            status: 'available', imageMatched, bodyPresent: !!body, bodyScrollReadForPredicate,
            bodyScrollTopForPredicate: numeric(bodyScrollTopForPredicate), bodyAtZero: imageMatched ? (!body || bodyScrollTopForPredicate === 0) : null,
            totalImageCount: images.length, loadedCount: candidates.length, visitedTotal,
            unvisitedCount: candidates.length - visitedTotal, droppedCandidates: visitedTotal - visited.length,
            droppedImageLayouts: Math.max(0, images.length - 24),
            clipTop: numeric(top), clipBottom: numeric(bottom), bodyRect: rect(clip), footerRect: rect(footerBox),
            candidates: visited.map((entry, index) => ({
              index, imageOrdinal: images.indexOf(entry.image), rect: rect(entry.box), meaningful: numeric(entry.meaningful),
              intersection: { left: numeric(entry.left), right: numeric(entry.right), top: numeric(entry.visibleTop), bottom: numeric(entry.visibleBottom), width: numeric(entry.right - entry.left), height: numeric(entry.visibleBottom - entry.visibleTop) },
              geometryPassed: entry.geometryPassed, hitTestCalled: entry.hitTestCalled,
              intersectionCenter: entry.hitTestCalled ? { x: numeric((entry.left + entry.right) / 2), y: numeric((entry.visibleTop + entry.visibleBottom) / 2) } : null,
              cardContainsHit: entry.cardContainsHit, matched: entry.cardContainsHit === true,
              hitRoleAtSampling: entry.hitTestCalled ? read('hit-role', () => role(entry.hit)) : null,
            })),
            atSampling: read('context', () => {
              const dialog = browser.closest('dialog');
              return {
                mediaLayout: read('media-layout', () => {
                  const startedAt = numeric(performance.now());
                  const imageLayouts = images.slice(0, 24).map((image, ordinal) => ({
                    ordinal,
                    loaded: read('image-loaded', () => image.complete && image.naturalWidth > 0),
                    rect: read('image-rect', () => rect(image.getBoundingClientRect())),
                  }));
                  const upload = read('upload-layout', () => {
                    const disclosure = browser.querySelector('.media-upload-disclosure');
                    return disclosure ? { open: disclosure.open, rect: rect(disclosure.getBoundingClientRect()) } : null;
                  });
                  const boxes = Object.fromEntries([
                    ['toolbar', '.media-toolbar'], ['filter', '.media-filter-disclosure'], ['grid', '.media-grid'],
                  ].map(([name, selector]) => [name, read(`${name}-rect`, () => rect(browser.querySelector(selector)?.getBoundingClientRect()))]));
                  return { startedAt, finishedAt: numeric(performance.now()), images: imageLayouts, upload, ...boxes };
                }),
                dialogRect: read('dialog-rect', () => rect(dialog?.getBoundingClientRect())),
                bodyScroll: read('body-scroll', () => scroll(body)), dialogScroll: read('dialog-scroll', () => scroll(dialog)),
                active: read('active', () => ({ role: role(document.activeElement), inBody: body ? body.contains(document.activeElement) : null })),
                innerWidth: numeric(innerWidth), innerHeight: numeric(innerHeight),
                compact: document.documentElement.hasAttribute('data-compact-viewport'),
                visualViewport: read('visual-viewport', () => {
                  const vv = window.visualViewport;
                  return vv ? { width: numeric(vv.width), height: numeric(vv.height), offsetLeft: numeric(vv.offsetLeft), offsetTop: numeric(vv.offsetTop), pageLeft: numeric(vv.pageLeft), pageTop: numeric(vv.pageTop), scale: numeric(vv.scale) } : null;
                }),
                css: read('css', () => {
                  const style = getComputedStyle(document.documentElement);
                  return Object.fromEntries(['--native-visible-height', '--native-visible-top', '--studio-visible-left', '--studio-visible-width'].map(name => {
                    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px)?$/.exec(style.getPropertyValue(name).trim());
                    return [name, match ? { number: numeric(Number(match[1])), unit: match[2] ?? 'number' } : null];
                  }));
                }),
              };
            }),
            faults, droppedFaults,
          };
          if (captureFailed) { if (faults.length < 8) faults.push('candidate-capture'); else sample.droppedFaults++; }
          if (faults.length || sample.droppedFaults || sample.droppedCandidates || sample.droppedImageLayouts) sample.status = 'partial';
        } catch { sample = { status: 'unavailable', faults: ['post-predicate'], droppedFaults: 0 }; }
        return { matched, sample };
      });
    } catch (error) {
      try { mediaDiagnostics?.recordPreview(target, null, 'rpc-failed'); } catch {}
      throw error;
    }
    let recordFailed = false;
    try { mediaDiagnostics.recordPreview(target, preview); } catch { recordFailed = true; }
    assert.ok(preview.matched, 'initial 320x568 view shows a meaningful loaded image preview, unobscured by the footer, without scrolling');
    if (recordFailed) throw new Error('Media disclosure diagnostic: preview-record unavailable');
  };
  const retainUploadAcrossBrowseToggle = async disclosure => {
    const handles = await Promise.all(['.media-upload', '.upload-file-input', '.upload-results'].map(selector => page.$(selector)));
    const before = await page.$eval('.upload-results', node => node.textContent);
    try {
      for (const open of [false, true]) {
        await page.locator(`${disclosure} > summary`).click();
        await disclosureState(disclosure, open);
        for (const [index, selector] of ['.media-upload', '.upload-file-input', '.upload-results'].entries()) {
          assert.equal(await handles[index].evaluate((node, selector) => node.isConnected && node === document.querySelector(selector), selector), true, `${selector} is retained across browsing disclosure toggles`);
        }
        assert.equal(await page.$eval('.upload-results', node => node.textContent), before, 'completed upload results and per-file errors survive browsing disclosure toggles');
      }
    } finally {
      await Promise.all(handles.map(handle => handle.dispose()));
    }
  };
  const checkResponsiveChooserClose = async (name, candidate, confirmTraceStage) => {
    const picker = 'dialog.media-dialog[open]', disclosure = `${picker} .media-filter-disclosure`;
    const trigger = `${picker} button[name="${name}"]`, chooser = '.selection-dialog[open]';
    const parentState = () => page.$eval(picker, dialog => ({
      selected: [...dialog.querySelectorAll('.media-card.selected')].map(node => node.dataset.mediaPath),
      pending: dialog.querySelector('.media-pending').textContent,
    }));
    const before = await parentState();
    for (const confirm of [false, true]) {
      await page.setViewport({ width: 1440, height: 1000 });
      await disclosureState(disclosure, true, confirm ? confirmTraceStage : undefined);
      const current = await page.$eval(trigger, node => node.textContent);
      await page.locator(trigger).click();
      await page.waitForSelector(chooser, { visible: true });
      await page.locator(`${chooser} input[value="${candidate}"]`).click();
      assert.equal(await page.$eval(`${chooser} input[value="${candidate}"]`, node => node.checked), true, 'chooser candidate is pending');
      assert.equal(await page.$eval(trigger, node => node.textContent), current, 'candidate does not publish before confirmation');
      await page.setViewport({ width: 390, height: 844 });
      await disclosureState(disclosure, false);
      assert.equal(await page.$eval(chooser, node => node.open && node.matches(':modal')), true, 'responsive folding leaves the portaled chooser open');
      assert.deepEqual(await parentState(), before, 'pending chooser candidate does not alter parent image selection');
      if (confirm) await page.locator(`${chooser} .selection-footer button.primary`).click();
      else await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
      assert.equal(await page.$eval(picker, node => node.open && node.matches(':modal')), true, 'responsive chooser close leaves the outer media dialog modal');
      assert.equal(await page.$eval(`${disclosure} > summary`, node => {
        const box = node.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        return node === document.activeElement && box.width > 0 && box.height >= 44 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && node.contains(document.elementFromPoint(x, y));
      }), true, 'closing the chooser focuses the visible, hit-testable summary instead of its folded trigger');
      assert.deepEqual(await parentState(), before, 'responsive chooser cancel/confirm preserves parent image selection');
      const published = await page.$eval(trigger, node => node.textContent);
      if (confirm) assert.notEqual(published, current, 'confirmation publishes the chosen filter');
      else assert.equal(published, current, 'Escape preserves the current filter');
    }
  };
  await page.setViewport({ width: 1440, height: 1000 });
  await click('媒体库'); await heading('媒体库');
  await page.waitForFunction(() => !document.querySelector('.upload-file-input').disabled);
  const libraryDisclosure = '.media-library .media-directory-disclosure';
  await disclosureState(libraryDisclosure, true);
  await page.$eval(`${libraryDisclosure} .directory-all`, node => node.focus({ preventScroll: true }));
  await page.setViewport({ width: 320, height: 568 });
  await disclosureState(libraryDisclosure, false, 'library-mobile');
  assert.equal(await page.$eval(`${libraryDisclosure} > summary`, node => node === document.activeElement), true, 'crossing to mobile moves focus from the folding tree to its summary');
  await initialPreview('.media-library .media-browser');
  await page.screenshot({ path: screenshots + '/media-library-initial-320x568.png' });
  await page.locator(`${libraryDisclosure} > summary`).click();
  await disclosureState(libraryDisclosure, true);
  await page.locator(`${libraryDisclosure} > summary`).click();
  await disclosureState(libraryDisclosure, false);
  await fill('.media-library [aria-label="搜索仓库图片"]', 'public/');
  await disclosureState(libraryDisclosure, false);
  await fill('.media-library [aria-label="搜索仓库图片"]', '');
  await page.setViewport({ width: 1440, height: 1000 });
  await disclosureState(libraryDisclosure, true);
  await page.locator(`${libraryDisclosure} .directory-choice[title="public"]`).click();
  await page.waitForFunction(() => document.querySelector('.media-directory-row.active .directory-choice')?.title === 'public');
  assert.ok(await page.$$eval('.media-library .media-card', nodes => nodes.length > 0 && nodes.every(node => node.dataset.mediaPath.startsWith('public/')) && nodes.some(node => node.dataset.mediaPath.slice('public/'.length).includes('/'))), 'library directory selection still includes descendant directories');
  assert.match(await page.$eval(`${libraryDisclosure} > summary`, node => node.textContent), /public/, 'directory summary shows the active path');
  await page.locator(`${libraryDisclosure} .directory-all`).click();
  await page.waitForSelector(`${libraryDisclosure} .directory-all.active`);
  await upload(['上传 配图.webp', 'invalid.webp']); await finished();
  assert.equal(await page.$$eval('.upload-results li', nodes => nodes.length), 2);
  assert.match(await page.$eval('.upload-error', el => el.textContent), /格式不匹配/);
  await retainUploadAcrossBrowseToggle(libraryDisclosure);
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
  await page.setViewport({ width: 320, height: 568 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  await openImagePicker(page, 'extra.site.logo');
  const filterDisclosure = 'dialog.media-dialog[open] .media-filter-disclosure';
  await disclosureState(filterDisclosure, false, 'public-picker-initial');
  assert.match(await page.$eval(`${filterDisclosure} > summary`, node => node.textContent), /Folder.*All folders/, 'closed picker summary describes its current filter');
  await initialPreview('dialog.media-dialog[open] .media-browser');
  await page.screenshot({ path: screenshots + '/media-picker-initial-320x568-en.png' });
  await page.setViewport({ width: 390, height: 844 });
  await disclosureState(filterDisclosure, false);
  // Hold this one real upload before sending it, to observe a stable pending
  // queue while the separate filter disclosure is opened and closed.
  const heldHandles = [], heldErrors = [];
  try {
    await page.evaluate(() => {
      const original = window.fetch;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      window.__uploadDisclosureGate = { release, restore: () => { window.fetch = original; } };
      window.fetch = async (...args) => {
        if (String(args[0]).startsWith('/api/media/upload?')) await gate;
        return original(...args);
      };
    });
    const queuedUpload = await page.$('dialog.media-dialog[open] .media-upload');
    if (queuedUpload) heldHandles.push(queuedUpload);
    assert.ok(queuedUpload, 'held upload has its mounted upload node');
    const queuedInput = await page.$('dialog.media-dialog[open] .upload-file-input');
    if (queuedInput) heldHandles.push(queuedInput);
    assert.ok(queuedInput, 'held upload has its original file input');
    await upload(['cover-upload.png']);
    const progress = await page.waitForSelector('dialog.media-dialog[open] .upload-progress', { visible: true });
    if (progress) heldHandles.push(progress);
    assert.ok(progress, 'held upload exposes progress');
    const queue = await progress.evaluate(node => node.textContent);
    for (const open of [true, false, true]) {
      await page.locator(`${filterDisclosure} > summary`).click();
      await disclosureState(filterDisclosure, open);
      assert.equal(await queuedUpload.evaluate(node => node.isConnected && node === document.querySelector('dialog.media-dialog[open] .media-upload')), true, 'filter disclosure keeps the mounted upload node');
      assert.equal(await queuedInput.evaluate(node => node.isConnected && node === document.querySelector('dialog.media-dialog[open] .upload-file-input')), true, 'filter disclosure keeps the original file input');
      assert.equal(await progress.evaluate(node => node.isConnected && node === document.querySelector('dialog.media-dialog[open] .upload-progress') && node.textContent), queue, 'filter disclosure preserves the pending queue and progress');
    }
  } catch (error) {
    heldErrors.push(error);
  } finally {
    // Each cleanup is attempted even if acquisition, evaluation or disposal
    // failed. Preserve the original failure alongside every cleanup failure.
    const cleanup = await Promise.allSettled([
      () => page.evaluate(() => window.__uploadDisclosureGate?.release()),
      () => page.evaluate(() => window.__uploadDisclosureGate?.restore()),
      ...heldHandles.map(handle => () => handle.dispose()),
    ].map(action => Promise.resolve().then(action)));
    for (const result of cleanup) if (result.status === 'rejected') heldErrors.push(result.reason);
    const deletion = await Promise.allSettled([Promise.resolve().then(() => page.evaluate(() => { delete window.__uploadDisclosureGate; }))]);
    for (const result of deletion) if (result.status === 'rejected') heldErrors.push(result.reason);
  }
  if (heldErrors.length) throw new AggregateError(heldErrors, 'Held upload disclosure check or cleanup failed');
  await finished();
  assert.equal(await selected(), 'public/uploads/cover-upload.png');
  assert.equal(await page.$eval('[name="extra.site.logo"]', el => el.value), original, 'upload does not change a form before confirmation');
  assert.match(await page.$eval('.upload-results', el => el.textContent), /Uploaded:/);
  await retainUploadAcrossBrowseToggle(filterDisclosure);
  await page.focus(`${filterDisclosure} button[name="media-folder"]`);
  await page.setViewport({ width: 1440, height: 1000 });
  await disclosureState(filterDisclosure, true);
  await page.setViewport({ width: 390, height: 844 });
  await disclosureState(filterDisclosure, false, 'held-upload-responsive');
  assert.equal(await page.$eval(`${filterDisclosure} > summary`, node => node === document.activeElement), true, 'crossing to mobile moves focus from folded filters to their summary');
  await page.locator(`${filterDisclosure} > summary`).click();
  await disclosureState(filterDisclosure, true);
  assert.ok(await page.$eval('.media-dialog-body', el => el.scrollWidth <= el.clientWidth), 'upload controls fit a mobile dialog');
  const picker = 'dialog.media-dialog[open]', body = `${picker} .media-dialog-body`;
  const layoutUploadRequests = [];
  const trackLayoutUpload = request => { if (new URL(request.url()).pathname === '/api/media/upload') layoutUploadRequests.push(request.url()); };
  page.on('request', trackLayoutUpload);
  try {
    for (const width of [320, 390]) {
      await page.setViewport({ width, height: 844 });
      await disclosureState(filterDisclosure, true);
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
    await revealField(page, folderTrigger);
    await disclosureState(filterDisclosure, true, 'nested-choosers');
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

    await checkResponsiveChooserClose('media-folder', 'public/uploads');
    await assertParentSelection();
    await revealField(page, folderTrigger);
    await page.locator(folderTrigger).click();
    await page.waitForSelector(chooser, { visible: true });
    await page.locator(`${chooser} input[value="public/uploads"]`).click();
    await page.locator(`${chooser} .selection-footer button.primary`).click();
    await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
    assert.equal(await page.$eval(folderTrigger, el => document.activeElement === el), true, 'folder confirm restores trigger focus');
    assert.ok(await page.$$eval(`${picker} .media-card`, nodes => nodes.length > 0 && nodes.every(node => node.dataset.mediaPath.slice(0, node.dataset.mediaPath.lastIndexOf('/')) === 'public/uploads')), 'picker folder filter still matches the exact directory, not its subtree');
    assert.match(await page.$eval(`${filterDisclosure} > summary`, node => node.textContent), /Folder.*public\/uploads/, 'filter summary shows the active full directory path');
    await assertParentSelection();
    // One diagnostic install RPC before the original folder-clear input sequence.
    await folderClearDiagnostics?.install();
    await page.locator(folderTrigger).click();
    await page.waitForSelector(chooser, { visible: true });
    await page.locator(`${chooser} input[type="radio"][value=""]`).click();
    await page.locator(`${chooser} .selection-footer button.primary`).click();
    await page.waitForFunction(() => {
      const matched = !document.querySelector('.selection-dialog[open]');
      try { window.__folderClearDiagnostics?.sampleWait(matched); } catch {}
      return matched;
    }, {});
    assert.ok(await page.$$eval(`${picker} .media-card`, nodes => {
      const matched = nodes.some(node => !node.dataset.mediaPath.startsWith('public/uploads/'));
      try { window.__folderClearDiagnostics?.sampleAssertion(nodes, matched); } catch {}
      return matched;
    }), 'clearing the folder restores other fixture images');
    await assertParentSelection();
    await folderClearDiagnostics?.stop('passed');
    const folderClearErrors = folderClearDiagnostics?.takeErrors() ?? [];
    if (folderClearErrors.length) throw new AggregateError(folderClearErrors, 'Folder clear diagnostics failed');

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
  await disclosureState(filterDisclosure, true, 'reopened-picker');
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
  await disclosureState(filterDisclosure, true, 'document-insert');
  await revealField(page, 'dialog.media-dialog[open] button[name="media-source"]');
  assert.match(await page.$eval(`${filterDisclosure} > summary`, node => node.textContent), /图片来源.*全部.*文件夹.*全部文件夹/, 'document picker summary describes both active source and folder');
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
  await checkResponsiveChooserClose('media-source', 'public', 'media-source-final');
  await revealField(page, 'dialog.media-dialog[open] button[name="media-source"]');
  await page.locator('dialog.media-dialog[open] button[name="media-source"]').click();
  await page.waitForSelector('.selection-dialog[open]', { visible: true });
  await page.locator('.selection-dialog[open] input[value="all"]').click();
  await page.locator('.selection-dialog[open] .selection-footer button.primary').click();
  await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
  assert.equal(await page.$eval('dialog.media-dialog[open] button[name="media-source"]', node => node === document.activeElement), true, 'ordinary source confirmation still restores its visible trigger');
  await page.setViewport({ width: 1440, height: 1000 });
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
  console.log('PASS: batch and drag uploads, mixed failures, duplicate renaming, public and bundle paths, picker cancel/confirm, responsive directory/filter disclosure defaults and focus, meaningful initial 320x568 previews, upload queue/node/result retention, 320/390px English layout, bidirectional browser wheel scrolling, nested compact chooser cancel/confirm and focus, and saved cover/Markdown.');
}
