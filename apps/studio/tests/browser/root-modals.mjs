import assert from 'node:assert/strict';
import { initialAiClickDiagnostics } from './root-modal-click-diagnostics.mjs';

const creation = 'dialog.creation-modal[open]';
const reauth = 'dialog.reauth-backdrop[open]';
const title = '.modal input[name="creation-title"]';
const slug = '.modal input[placeholder="my-first-story"]';

export const ROOT_MODAL_OUTCOMES = Object.freeze(['resume', 'cancel-before-release', 'unmount-after-defer']);

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
async function fill(page, selector, value) {
  await page.$eval(selector, (node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function containsFocus(page, selector) {
  await page.waitForFunction(selector => document.querySelector(selector)?.contains(document.activeElement), {}, selector);
}
async function pressTab(page, backwards = false) {
  if (backwards) await page.keyboard.down('Shift');
  try { await page.keyboard.press('Tab'); }
  finally { if (backwards) await page.keyboard.up('Shift'); }
}
async function assertKeyboardFocus(page, selector) {
  const state = await page.$eval(selector, dialog => {
    const active = document.activeElement;
    const rect = active?.getBoundingClientRect();
    let painted = false;
    for (let node = active; node && node !== dialog; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((node === active || node.matches('label')) &&
          ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)') || style.boxShadow !== 'none')) painted = true;
    }
    return {
      contained: active !== dialog && dialog.contains(active),
      documentFocused: document.hasFocus(),
      keyboardVisible: !!active?.matches(':focus-visible'),
      inViewport: !!rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      painted,
      // Never include values/outerHTML: this helper also inspects login fields.
      active: active ? `${active.tagName}.${active.className}[name="${active.getAttribute('name') || ''}"]` : null,
    };
  });
  assert.ok(state.contained && state.documentFocused && state.keyboardVisible && state.inViewport && state.painted,
    `Expected a visible keyboard focus target in ${selector}: ${JSON.stringify(state)}`);
}
async function tabBoundary(page, selector, first, last) {
  // Force both actual App boundaries; a fixed number of random Tab presses can
  // miss the boundary and cannot prove that focus progresses rather than sticks.
  for (const backwards of [false, true]) {
    await page.$eval(`${selector} ${backwards ? first : last}`, node => node.focus());
    await pressTab(page, backwards);
    assert.equal(await page.$eval(`${selector} ${backwards ? last : first}`, node => node === document.activeElement), true,
      `${backwards ? 'Shift+Tab' : 'Tab'} must wrap to the opposite App control in ${selector}`);
    await assertKeyboardFocus(page, selector);
  }
}
async function disclosureTabStops(page, selector) {
  // A small DOM fixture exercises the shared production trap with controls that
  // native closed-details rendering may still give layout rectangles.
  await page.$eval(selector, dialog => {
    const outer = document.createElement('details');
    outer.dataset.focusFixture = '';
    const summary = document.createElement('summary');
    summary.textContent = 'Disclosure focus fixture';
    const inner = document.createElement('details');
    inner.open = true;
    const innerSummary = document.createElement('summary');
    innerSummary.textContent = 'Nested disclosure';
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Nested focus fixture';
    inner.append(innerSummary, button); outer.append(summary, inner); dialog.append(outer);
  });
  const fixture = '[data-focus-fixture]';
  try {
    await tabBoundary(page, selector, '.card-heading button', `${fixture} > summary`);
    await page.$eval(`${selector} ${fixture}`, node => { node.open = true; });
    await tabBoundary(page, selector, '.card-heading button', `${fixture} button`);
    await page.$eval(`${selector} ${fixture}`, node => { node.open = false; });
    await tabBoundary(page, selector, '.card-heading button', `${fixture} > summary`);
  } finally {
    await page.$eval(`${selector} ${fixture}`, node => node.remove());
  }
}
async function tabContained(page, selector) {
  for (const backwards of [false, true]) {
    for (let i = 0; i < 18; i++) {
      await pressTab(page, backwards);
      await assertKeyboardFocus(page, selector);
    }
  }
}
async function expireSession(page) {
  assert.equal(await page.evaluate(async () => {
    const session = await (await fetch('/api/auth/session')).json();
    return (await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf } })).status;
  }), 200);
}
async function loginAgain(page, password, stage) {
  await page.waitForSelector(`${reauth} [name="username"]`);
  await fill(page, `${reauth} [name="username"]`, 'owner');
  await fill(page, `${reauth} [name="password"]`, password);
  const loginUrl = new URL('/api/auth/login', page.url()).href;
  const controller = new AbortController();
  try {
    // Register before the physical click; report a rejected login, not a later
    // modal timeout. Never inspect credentials, cookies or response bodies.
    await Promise.all([
      page.waitForResponse(response => response.url() === loginUrl && response.request().method() === 'POST', { signal: controller.signal })
        .then(response => assert.equal(response.status(), 200, `${stage}: login status ${response.status()}`)),
      clickText(page, `${reauth} button`, '进入创作中心'),
    ]);
  } finally { controller.abort(); }
  await page.waitForSelector(reauth, { hidden: true });
  await page.waitForFunction(() => document.querySelector('.studio-shell')?.inert === false);
}
async function assertBlockingReauth(page, underlying, screenshots, name) {
  await page.waitForSelector(reauth);
  await containsFocus(page, reauth);
  assert.equal(await page.$eval(reauth, node => node.matches(':modal') && !!node.getAttribute('aria-label')), true);
  assert.equal(await page.$eval('.studio-shell', node => node.inert), true);
  // A native dialog below another native dialog must not be focusable, even
  // though it was portalled outside the explicit inert studio shell.
  await page.$eval(underlying, node => node.querySelector('button')?.focus());
  await containsFocus(page, reauth);
  await tabBoundary(page, reauth, '.login-language select', '.login-help summary');
  await tabContained(page, reauth);
  await page.keyboard.press('Escape');
  assert.ok(await page.$(reauth), 'Escape cannot dismiss expired-session login');
  await page.mouse.click(2, 2);
  assert.ok(await page.$(reauth), 'Empty-space click cannot dismiss expired-session login');
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

// Hold the real owner's commit-boundary callbacks, not showModal or API code.
// React commits use its scheduler; the root blocking Modal must not use this timer.
async function holdOpenTimers(page) {
  await page.evaluate(() => {
    const set = window.setTimeout, clear = window.clearTimeout;
    const held = new Map();
    window.setTimeout = function (callback, delay, ...args) {
      if (delay !== 0 || typeof callback !== 'function') return set.call(window, callback, delay, ...args);
      const id = set.call(window, () => {}, 60_000);
      held.set(id, () => callback(...args));
      return id;
    };
    window.clearTimeout = function (id) { held.delete(id); clear.call(window, id); };
    window.releaseModalOpenTimers = () => {
      window.setTimeout = set;
      window.clearTimeout = clear;
      const callbacks = [...held];
      held.clear();
      delete window.releaseModalOpenTimers;
      for (const [id, callback] of callbacks) { clear.call(window, id); callback(); }
    };
    window.heldModalOpenTimers = () => held.size;
  });
}
async function releaseOpenTimers(page) {
  await page.evaluate(() => {
    window.releaseModalOpenTimers?.();
    delete window.heldModalOpenTimers;
  });
}

/** Dedicated fresh authenticated server/site/state/browser per required outcome.
 * Initial login + AI/delete/delayed reauthentication = four logins per server.
 * Owns request interception on this page; do not attach it to smoke.mjs's shared page.
 * The runner must enumerate ROOT_MODAL_OUTCOMES; missing outcomes are not a pass.
 */
export async function checkRootModals({ page, origin, password, screenshots, outcome }) {
  assert.ok(ROOT_MODAL_OUTCOMES.includes(outcome), 'A supported root-modal outcome is required');
  let aiWrites = 0, deleteWrites = 0;
  let expireAiConfig = false;
  await page.setRequestInterception(true);
  const intercept = request => {
    const url = new URL(request.url());
    if (url.origin !== origin && !request.url().startsWith('data:')) return request.abort();
    if (url.pathname === '/api/ai/config') {
      if (expireAiConfig) return request.continue();
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: true, image: false }) });
    }
    if (url.pathname === '/api/ai/text') {
      aiWrites++;
      return request.respond({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Session expired fixture' }) });
    }
    if (url.pathname === '/api/document' && request.method() === 'DELETE') deleteWrites++;
    return request.continue();
  };
  page.on('request', intercept);
  try {
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await clickText(page, '.sidebar nav button', '文章');
    await clickText(page, '.page-heading button', '新建文章');
    await page.waitForSelector(creation);
    assert.equal(await page.$eval(creation, node => node.matches(':modal') && !!document.getElementById(node.getAttribute('aria-labelledby'))), true);
    await page.waitForFunction(selector => document.activeElement?.matches(selector), {}, title);
    await fill(page, title, 'Unfinished modal title');
    await fill(page, slug, 'unfinished-modal-slug');
    await tabBoundary(page, creation, '.card-heading button', 'button.primary.wide');
    await disclosureTabStops(page, creation);
    await tabContained(page, creation);
    await page.focus(title);
    await pressTab(page);
    assert.equal(await page.$eval(slug, node => node === document.activeElement), true, 'Ordinary Tab still advances from title to slug');
    // Attempt background focus and an actual backdrop hit, not a synthetic click.
    await page.$eval('.content-library .search-box input', node => node.focus());
    await containsFocus(page, creation);
    await page.mouse.click(2, 2);
    assert.ok(await page.$(creation));
    assert.equal(await page.$eval(title, node => node.value), 'Unfinished modal title');
    const chooser = `${creation} [data-field="article-collection"] .choice-trigger`;
    await page.click(chooser);
    await page.waitForSelector('.selection-dialog[open]');
    await containsFocus(page, '.selection-dialog[open]');
    await tabBoundary(page, '.selection-dialog[open]', '.card-heading button', '.selection-footer button.primary');
    // Parent native modality must not make its own key handler steal nested focus.
    await page.$eval(creation, node => node.querySelector('input')?.focus());
    await containsFocus(page, '.selection-dialog[open]');
    await tabContained(page, '.selection-dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.selection-dialog', { hidden: true });
    await page.waitForFunction(selector => document.activeElement?.matches(selector), {}, chooser);
    assert.ok(await page.$(creation), 'Nested Escape must leave the creation dialog open');
    await page.click(chooser);
    await page.waitForSelector('.selection-dialog[open]');
    await page.click('.selection-dialog input[value="modal-collection-0"]');
    await clickText(page, '.selection-dialog button', '确认选择');
    await page.waitForSelector('.selection-dialog', { hidden: true });
    await page.$eval(creation, node => { window.closedCreationNode = node; });
    await page.keyboard.press('Escape');
    await page.waitForSelector(creation, { hidden: true });
    assert.equal(await page.evaluate(() => window.closedCreationNode.isConnected || window.closedCreationNode.open), false, 'Unmount must close the retained node even after its ref clears');
    await page.waitForFunction(() => document.activeElement?.matches('.page-heading .primary'));
    await pressTab(page);
    assert.equal(await page.evaluate(() => document.hasFocus() && document.activeElement !== document.body && !window.closedCreationNode.contains(document.activeElement)), true, 'Disposed owner cannot trap background keyboard focus');
    await clickText(page, '.page-heading button', '新建文章');
    await page.waitForSelector(creation);
    assert.equal(await page.$eval(title, node => node.value), 'Unfinished modal title');
    assert.equal(await page.$eval(slug, node => node.value), 'unfinished-modal-slug');
    assert.match(await page.$eval(chooser, node => node.textContent), /Modal collection 0/);
    // Explicit cancellation has exactly the same resume semantics as Escape.
    await clickText(page, `${creation} .card-heading button`, '取消');
    await page.waitForSelector(creation, { hidden: true });
    await clickText(page, '.page-heading button', '新建文章');
    await page.waitForSelector(creation);
    assert.equal(await page.$eval(title, node => node.value), 'Unfinished modal title');
    // Owner state can disappear while a portalled child is in the top layer.
    // Invoke the real owner's cancellation handler, not dialog.close/remove().
    await page.click(chooser);
    await page.waitForSelector('.selection-dialog[open]');
    await page.$eval('.selection-dialog[open]', node => { window.orphanedChoiceNode = node; });
    await page.$eval(creation, node => {
      window.closedCreationNode = node;
      node.querySelector('.card-heading button').click();
    });
    await page.waitForFunction(() => !window.closedCreationNode.isConnected && !window.orphanedChoiceNode.isConnected);
    assert.equal(await page.evaluate(() => window.closedCreationNode.open || window.orphanedChoiceNode.open), false, 'Parent unmount must close both retained native nodes');
    await page.waitForFunction(() => document.activeElement?.matches('.page-heading .primary'));
    await clickText(page, '.page-heading button', '新建文章');
    await page.waitForSelector(creation);
    assert.equal(await page.$eval(title, node => node.value), 'Unfinished modal title');
    await tabBoundary(page, creation, '.card-heading button', 'button.primary.wide');
    if (screenshots) await page.screenshot({ path: `${screenshots}/root-modal-creation.png` });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await containsFocus(page, creation);
    await tabBoundary(page, creation, '.card-heading button', 'button.primary.wide');
    await tabContained(page, creation);
    assert.equal(await page.$eval(creation, node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }), true, 'Creation modal fits narrow viewport');
    if (screenshots) await page.screenshot({ path: `${screenshots}/root-modal-creation-mobile.png` });
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.keyboard.press('Escape');
    await page.waitForSelector(creation, { hidden: true });

    await page.click('.content-row[data-path="content/articles/example/index.md"]');
    await page.waitForSelector('.editor-page .markdown-source');
    const draft = 'Unsaved editor body survives top-layer reauthentication.';
    await fill(page, '.editor-page .markdown-source', draft);
    await page.$eval('.editor-page .markdown-source', node => { window.modalEditorNode = node; });
    const initialAiDiagnostics = await initialAiClickDiagnostics({ page, screenshots, outcome });
    let initialAiFailed = true;
    try {
      await page.click('.ai-action');
      await initialAiDiagnostics.afterClick();
      await page.waitForSelector('.ai-assistant-dialog[open]');
      initialAiFailed = false;
    } finally {
      try { await initialAiDiagnostics.finish(initialAiFailed); }
      catch {
        // Diagnostics must never replace the original click/wait exception.
        console.error('Initial AI click diagnostics unavailable: finalization failed');
        if (!initialAiFailed) throw new Error('Initial AI click diagnostics unavailable');
      }
    }
    await expireSession(page);
    await clickText(page, '.ai-assistant-dialog button', '生成摘要');
    await assertBlockingReauth(page, '.ai-assistant-dialog[open]', screenshots, 'root-modal-reauth-ai');
    assert.equal(await page.$eval('.editor-page .markdown-source', (node, draft) => node === window.modalEditorNode && node.value === draft, draft), true);
    await loginAgain(page, password, `${outcome}/ai`);
    await containsFocus(page, '.ai-assistant-dialog[open]');
    await tabContained(page, '.ai-assistant-dialog[open]');
    assert.equal(aiWrites, 1, 'Login must not replay the failed AI mutation');
    assert.equal(await page.$eval('.editor-page .markdown-source', (node, draft) => node === window.modalEditorNode && node.value === draft, draft), true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ai-assistant-dialog', { hidden: true });

    await clickText(page, '.editor-page button', '删除当前语言版本');
    await page.waitForSelector('.delete-content-dialog[open] .delete-content-confirm:not(:disabled)');
    await expireSession(page);
    await page.click('.delete-content-confirm');
    await assertBlockingReauth(page, '.delete-content-dialog[open]', screenshots, 'root-modal-reauth-delete');
    await loginAgain(page, password, `${outcome}/delete`);
    await containsFocus(page, '.delete-content-dialog[open]');
    await tabContained(page, '.delete-content-dialog[open]');
    assert.equal(deleteWrites, 1, 'Login must not replay deletion');
    assert.equal(await page.$eval('.editor-page .markdown-source', (node, draft) => node === window.modalEditorNode && node.value === draft, draft), true);
    assert.equal(await page.evaluate(async () => (await fetch('/api/document?path=content%2Farticles%2Fexample%2Findex.md')).status), 200, '401 deletion must retain the stored article');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.delete-content-dialog', { hidden: true });
    // A real GET 401 overtakes an owner's already-scheduled native activation.
    // Release that exact callback only once the blocking login is in the top layer.
    expireAiConfig = true;
    await expireSession(page);
    await holdOpenTimers(page);
    await page.click('.ai-action');
    await page.waitForSelector('.ai-assistant-dialog', { visible: false });
    await page.waitForFunction(() => window.heldModalOpenTimers() > 0);
    await page.waitForSelector(reauth);
    await page.$eval('.ai-assistant-dialog', node => { window.delayedBusinessNode = node; });
    assert.equal(await page.$eval('.ai-assistant-dialog', node => node.open), false);
    if (outcome === 'cancel-before-release') {
      await page.$eval('.ai-assistant-dialog .card-heading button', node => node.click());
      await page.waitForSelector('.ai-assistant-dialog', { hidden: true });
    }
    await releaseOpenTimers(page);
    await containsFocus(page, reauth);
    assert.equal(await page.evaluate(() => window.delayedBusinessNode.open), false, 'Late callback must not activate above login');
    if (outcome === 'unmount-after-defer') {
      await page.$eval('.ai-assistant-dialog .card-heading button', node => node.click());
      await page.waitForFunction(() => !window.delayedBusinessNode.isConnected);
    }
    await tabContained(page, reauth);
    if (screenshots) await page.screenshot({ path: `${screenshots}/root-modal-reauth-delayed-open.png`, fullPage: true });
    // Physical login button click proves that the late business open did not
    // make reauthentication inert. Filling alone would not establish this.
    await loginAgain(page, password, `${outcome}/delayed`);
    if (outcome === 'resume') {
      await page.waitForSelector('.ai-assistant-dialog[open]');
      await containsFocus(page, '.ai-assistant-dialog[open]');
      assert.equal(await page.$eval('.ai-assistant-dialog', node => node === window.delayedBusinessNode), true, 'Resume must retain the mounted dialog');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ai-assistant-dialog', { hidden: true });
    } else {
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));
      assert.equal(await page.$('.ai-assistant-dialog[open]'), null, 'Cancelled/unmounted open cannot resume');
      assert.equal(await page.evaluate(() => window.delayedBusinessNode.isConnected || window.delayedBusinessNode.open), false);
    }
    assert.equal(await page.$eval('.editor-page .markdown-source', (node, draft) => node === window.modalEditorNode && node.value === draft, draft), true);
    assert.equal(aiWrites, 1, 'Deferred activation must not replay AI generation');
    assert.equal(deleteWrites, 1, 'Deferred activation must not replay deletion');
    console.log(`PASS [${outcome}]: visible keyboard focus and bidirectional boundary wrapping in native creation/reauth/nested dialogs; Escape/backdrop/resume and owner cleanup; blocking AI/delete 401 and delayed business-open race preserve mounted state and never replay mutations.`);
  } finally {
    await releaseOpenTimers(page);
    page.off('request', intercept);
    await page.setRequestInterception(false);
  }
}
