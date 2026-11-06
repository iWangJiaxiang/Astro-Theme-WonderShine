import { revealField } from './controls.mjs';

export async function openImagePicker(page, name) {
  const field = `[data-image-field="${name}"]`, selector = `${field} .secondary`;
  const key = `__studioImagePickerTrace_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let locator, actions = 0;
  const onAction = () => { actions++; };
  try {
    await page.evaluate((selector, key) => {
      const structure = node => node instanceof Element ? {
        tag: node.tagName, class: [...node.classList].slice(0, 8).map(value => value.slice(0, 64)),
      } : null;
      const rect = node => node?.getBoundingClientRect().toJSON() ?? null;
      const geometry = node => {
        const style = getComputedStyle(node);
        return {
          ...structure(node), rect: rect(node),
          overflowX: style.overflowX, overflowY: style.overflowY, position: style.position,
          display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
          scrollTop: node.scrollTop, scrollLeft: node.scrollLeft,
          clientWidth: node.clientWidth, clientHeight: node.clientHeight,
          scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
        };
      };
      const trace = [];
      const record = event => {
        trace.push({
          event: event?.type || 'start', time: Math.round(performance.now()),
          x: scrollX, y: scrollY, rect: rect(document.querySelector(selector)),
          target: structure(event?.target), active: structure(document.activeElement),
        });
        if (trace.length > 32) trace.shift();
      };
      window[key] = {
        cleanup() {
          document.removeEventListener('scroll', record, true);
          document.removeEventListener('focusin', record, true);
        },
        snapshot() {
          const matches = document.querySelectorAll(selector), button = matches[0];
          const box = button?.getBoundingClientRect();
          const x = box ? box.left + box.width / 2 : -1, y = box ? box.top + box.height / 2 : -1;
          const outside = x < 0 || y < 0 || x >= innerWidth || y >= innerHeight;
          const ancestors = [];
          for (let node = button?.parentElement; node && ancestors.length < 24; node = node.parentElement) {
            ancestors.push(geometry(node));
          }
          const preview = button?.closest('[data-image-field]')?.querySelector('.image-field-preview img');
          const viewport = visualViewport;
          const dialogs = [...document.querySelectorAll('dialog[open]')];
          return {
            count: matches.length,
            button: button ? {
              ...geometry(button), connected: button.isConnected, disabled: button.matches(':disabled'),
              inert: !!button.closest('[inert]'), hidden: !!button.closest('[hidden]'),
            } : null,
            center: { x, y, outside, hit: outside ? null : structure(document.elementFromPoint(x, y)) },
            active: structure(document.activeElement), scroll: { x: scrollX, y: scrollY },
            viewport: {
              width: innerWidth, height: innerHeight,
              visual: viewport ? { width: viewport.width, height: viewport.height, scale: viewport.scale,
                offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft,
                pageTop: viewport.pageTop, pageLeft: viewport.pageLeft } : null,
            },
            root: document.scrollingElement ? geometry(document.scrollingElement) : null,
            dialogCount: dialogs.length,
            dialogs: dialogs.slice(0, 16).map(node => ({ ...structure(node), modal: node.matches(':modal') })),
            ancestors,
            preview: preview ? { rect: rect(preview), complete: preview.complete,
              naturalWidth: preview.naturalWidth, naturalHeight: preview.naturalHeight } : null,
            trace: trace.slice(),
          };
        },
      };
      document.addEventListener('scroll', record, { capture: true, passive: true });
      document.addEventListener('focusin', record, true);
      record();
    }, selector, key);
    await revealField(page, field);
    await page.$eval(selector, async button => {
      button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    locator = page.locator(selector);
    locator.on('action', onAction);
    await locator.click();
    await page.waitForSelector('dialog.media-dialog[open]');
  } catch (error) {
    const state = await page.evaluate(key => window[key]?.snapshot() ?? { unavailable: true }, key)
      .catch(() => ({ unavailable: true }));
    try { console.error(`Image picker interaction failed: ${JSON.stringify({ actions, state })}`); } catch {}
    throw error;
  } finally {
    try { locator?.off('action', onAction); } catch {}
    await page.evaluate(key => {
      try { window[key]?.cleanup(); } finally { delete window[key]; }
    }, key).catch(() => {});
  }
}
