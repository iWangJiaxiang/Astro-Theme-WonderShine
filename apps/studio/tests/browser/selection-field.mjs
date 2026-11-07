import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

const sizes = [[320, 568], [390, 844], [844, 390], [768, 1024], [1024, 768], [1440, 1000]];
const longPath = 'public/uploads/synthetic-selection-fixture/very-long-directory-segment-without-spaces/another-long-directory-segment/full-original-folder-name';
const trigger = name => `[data-field="${name}"] > .choice-trigger`;

// Synthetic component coverage only, not whole-product or native WebView acceptance.
export async function checkSelectionField(browser) {
  const fixture = await build({
    plugins: [fixtureAssetPlugin()],
    stdin: {
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx',
      sourcefile: 'selection-field-fixture.tsx', contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SelectionField from './src/components/SelectionField';
import { locale } from './src/i18n';
import { installMobileShell } from './platform/mobile';
// Preserve App + main.ts cascade, including the real stylesheet imports.
import './platform/native.css';
import './platform/mobile.css';
import './src/style.css';
import './src/forms.css';
import './src/composer.css';
import './src/workspace.css';
import './src/creation-tools.css';
import './src/accessibility.css';
locale.value = 'en';
const disposeShell = installMobileShell(false);
const longPath = ${JSON.stringify(longPath)};
const folders = [{ value: '', label: 'All folders' }, { value: 'public', label: 'Public images (default)' }];
const many = Array.from({ length: 7 }, (_, index) => ({ value: 'option-' + index, label: 'Option ' + (index + 1) }));
const tags = ['a', 'b', 'c'].map(value => ({ value, label: value.toUpperCase() }));
const updates = {};
function Field({ name, initial, ...props }) {
  const [value, setValue] = useState(initial);
  return <SelectionField {...props} name={name} modelValue={value}
    onUpdateModelValue={next => { updates[name] = (updates[name] || 0) + 1; setValue(next); }} />;
}
function Fixture() {
  return <main style={{ padding: 16, display: 'grid', gap: 14, maxWidth: 800, margin: '0 auto' }}>
    <Field name="plain" label="Plain chooser" initial="option-0" options={many} />
    <Field name="folder" label="Folder" initial="" options={folders} compact />
    <Field name="destination" label="Upload destination" initial="public" options={folders} compact icon="folder" />
    <Field name="multi" label="Topics" initial={['', 'a', 'b']} options={tags} compact multiple />
    <Field name="empty-multi" label="Empty topics" initial={['']} options={tags} compact multiple />
    <div className="media-filter-control"><span>Folder context</span>
      <Field name="long-filter" label="Filter folder" initial={longPath} options={[{ value: longPath, label: longPath }]} compact />
    </div>
    <div className="upload-directory-control"><span>Upload context</span>
      <Field name="long-upload" label="Upload folder" initial={longPath} options={[{ value: longPath, label: longPath }]} compact icon="folder" />
    </div>
    <button id="before-disabled" type="button">Before disabled</button>
    <Field name="disabled" label="Disabled chooser" initial="public" options={folders} compact disabled />
    <button id="after-disabled" type="button">After disabled</button>
  </main>;
}
const root = createRoot(document.getElementById('root'));
root.render(<Fixture />);
window.selectionFixture = {
  updates(name) { return updates[name] || 0; },
  cleanup() { root.unmount(); disposeShell(); },
};
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    outdir: 'selection-field-fixture',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.eot': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.gif': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const js = fixture.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  const css = fixture.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  assert.ok(js && css, 'Fixture must include real component JS and the complete CSS cascade');
  const screenshots = process.env.STUDIO_TEST_SCREENSHOTS || fileURLToPath(new URL('../../test-results/selection-field/', import.meta.url));
  await mkdir(screenshots, { recursive: true });

  for (const [width, height] of sizes) {
    const label = `SelectionField ${width}x${height}`;
    const page = await browser.newPage();
    const errors = [], warnings = [], failures = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warn'].includes(message.type())) warnings.push(message.text()); });
    try {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: js });
      await page.waitForSelector(trigger('disabled'));

      const expected = [
        ['plain', 'Plain chooser', 'Option 1', null],
        ['folder', 'Folder', 'All folders', null],
        ['destination', 'Upload destination', 'Public images (default)', null],
        ['multi', 'Topics', 'A · B', '2'],
        ['empty-multi', 'Empty topics', 'Empty topics', null],
        ['long-filter', 'Filter folder', longPath, null],
        ['long-upload', 'Upload folder', longPath, null],
        ['disabled', 'Disabled chooser', 'Public images (default)', null],
      ];
      const ids = new Map();
      for (const [name, fieldLabel, value, count] of expected) {
        const state = await page.$eval(trigger(name), (button, value, count, fieldLabel, narrowLongPath) => {
          const values = button.querySelectorAll(':scope > span.choice-value');
          const text = values[0];
          const trail = button.querySelector(':scope > span.choice-trailing');
          const badge = trail?.querySelector(':scope > .choice-count');
          const svg = trail?.querySelector(':scope > svg');
          const labelledBy = button.getAttribute('aria-labelledby')?.split(/\s+/) || [];
          const expectedIds = [button.parentElement.querySelector(':scope > span').id];
          if (button.name !== 'empty-multi') expectedIds.push(text?.id);
          const box = button.getBoundingClientRect(), valueBox = text?.getBoundingClientRect(), trailBox = trail?.getBoundingClientRect();
          const style = getComputedStyle(button), valueStyle = text && getComputedStyle(text);
          const range = document.createRange();
          if (text) range.selectNodeContents(text);
          const fragments = [...range.getClientRects()];
          return {
            id: text?.id,
            structure: values.length === 1 && !!text?.id && text.textContent === value
              && trail?.getAttribute('aria-hidden') === 'true' && button.lastElementChild === trail
              && (count === null ? !badge : badge?.textContent === count)
              && button.querySelectorAll('.choice-count').length === (count === null ? 0 : 1)
              && trail?.children.length === (count === null ? 1 : 2)
              && svg?.getAttribute('aria-hidden') === 'true'
              && svg?.querySelector('path')?.getAttribute('d') === 'm6 9 6 6 6-6',
            labelled: JSON.stringify(labelledBy) === JSON.stringify(expectedIds)
              && document.getElementById(labelledBy[0])?.textContent === fieldLabel,
            aligned: style.textAlign === 'left' && valueBox?.left >= box.left
              && valueBox.left <= box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
                + (button.querySelector(':scope > svg') ? 16 + parseFloat(style.columnGap) : 0) + 1,
            separated: valueBox?.right <= trailBox?.left + 1 && trailBox?.width > 0
              && Math.abs(trailBox.right - (box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight))) <= 1
              && trailBox.right <= box.right - parseFloat(style.borderRightWidth) + 1
              && trailBox.top >= box.top && trailBox.bottom <= box.bottom,
            wraps: !narrowLongPath || (valueStyle?.whiteSpace === 'normal'
              && new Set(fragments.map(rect => Math.round(rect.top))).size > 1
              && fragments.every(rect => rect.left >= box.left - 1 && rect.right <= trailBox.left + 1)
              && text.scrollWidth <= text.clientWidth + 1 && text.scrollHeight <= text.clientHeight + 1),
          };
        }, value, count, fieldLabel, width <= 390 && name.startsWith('long-'));
        ids.set(name, state.id);
        assert.equal(state.structure, true, `${label}: ${name} value/trailing/SVG/count contract`);
        assert.equal(state.labelled, true, `${label}: ${name} stable label and full value references`);
        assert.equal(state.aligned, true, `${label}: ${name} value starts at the leading edge`);
        assert.equal(state.separated, true, `${label}: ${name} trailing remains contained without overlap`);
        assert.equal(state.wraps, true, `${label}: ${name} media path wraps without clipping`);
        const accessibleName = name === 'empty-multi' ? fieldLabel : `${fieldLabel} ${value}`;
        const accessible = await page.$(`::-p-aria([name=${JSON.stringify(accessibleName)}][role="button"])`);
        assert.ok(accessible, `${label}: ${name} exact accessible name excludes decorative count/SVG`);
        await accessible.dispose();
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal page overflow`);
      await page.screenshot({ path: join(screenshots, `selection-field-${width}x${height}.png`), fullPage: true });

      // Keep the input scenarios focused, rather than repeating a large mutation matrix.
      if (width === 390 || width === 1440) {
        const closed = async name => {
          await page.waitForFunction(() => !document.querySelector('.selection-dialog[open]'));
          assert.equal(await page.$eval(trigger(name), button => document.activeElement === button), true, `${label}: closing returns trigger focus`);
          assert.equal(await page.$eval(`${trigger(name)} > .choice-value`, node => node.id), ids.get(name), `${label}: value id survives chooser renders`);
        };
        const updates = name => page.evaluate(name => window.selectionFixture.updates(name), name);
        const valueIs = (name, value) => page.$eval(`${trigger(name)} > .choice-value`, (node, value) => node.textContent === value, value);
        const open = async name => {
          await page.click(trigger(name));
          await page.waitForSelector('.selection-dialog[open]');
        };
        await open('folder');
        await page.click('.selection-dialog input[type="radio"][value="public"]');
        assert.equal(await valueIs('folder', 'All folders'), true, `${label}: pending single does not update parent`);
        assert.equal(await updates('folder'), 0);
        await page.click('.selection-dialog .card-heading button');
        await closed('folder');
        assert.equal(await updates('folder'), 0, `${label}: pointer cancel publishes nothing`);

        // Focus was returned by production close(); no DOM click or forced focus.
        await page.keyboard.press('Enter');
        // showModal() starts at the first focusable control, before the search field.
        await page.waitForFunction(() => document.activeElement?.matches('.selection-dialog .card-heading button'));
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.matches('.selection-dialog input[type="search"]')), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.matches('.selection-dialog input[type="radio"][value=""]')), true);
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.$eval('.selection-dialog input[type="radio"][value="public"]', input => input.checked), true);
        assert.equal(await updates('folder'), 0, `${label}: keyboard pending publishes nothing`);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.matches('.selection-dialog .selection-footer .primary')), true);
        await page.keyboard.press('Enter');
        await closed('folder');
        assert.equal(await valueIs('folder', 'Public images (default)'), true);
        assert.equal(await updates('folder'), 1, `${label}: keyboard confirm publishes once`);
        assert.equal(await page.$(`${trigger('folder')} .choice-count`), null, `${label}: committed single never gains a count`);
        await open('folder');
        await page.click('.selection-dialog input[type="radio"][value=""]');
        await page.click('.selection-dialog .selection-footer .primary');
        await closed('folder');
        assert.equal(await valueIs('folder', 'All folders'), true, `${label}: empty-string option remains a valid single choice`);
        assert.equal(await updates('folder'), 2);
        assert.equal(await page.$(`${trigger('folder')} .choice-count`), null);

        await open('plain');
        await page.click('.selection-dialog input[type="radio"][value="option-5"]');
        assert.equal(await valueIs('plain', 'Option 1'), true, `${label}: noncompact pending stays local`);
        assert.equal(await updates('plain'), 0);
        await page.click('.selection-dialog .selection-footer .primary');
        await closed('plain');
        assert.equal(await valueIs('plain', 'Option 6'), true);
        assert.equal(await updates('plain'), 1, `${label}: pointer confirm publishes once`);

        await open('multi');
        await page.click('.selection-dialog input[type="checkbox"][value="c"]');
        assert.equal(await page.$eval(`${trigger('multi')} .choice-count`, node => node.textContent === '2'), true);
        assert.equal(await updates('multi'), 0, `${label}: pending multiple does not update count/parent`);
        await page.keyboard.press('Escape');
        await closed('multi');
        assert.equal(await updates('multi'), 0, `${label}: Escape discards pending selection`);
        await open('multi');
        assert.equal(await page.$eval('.selection-dialog input[type="checkbox"][value="c"]', input => input.checked), false, `${label}: cancelled choice is not retained`);
        await page.click('.selection-dialog input[type="checkbox"][value="c"]');
        await page.click('.selection-dialog .selection-footer .primary');
        await closed('multi');
        assert.equal(await updates('multi'), 1, `${label}: multiple confirmation publishes once`);
        assert.equal(await page.$eval(`${trigger('multi')} .choice-count`, node => node.textContent === '3'), true);

        await page.click(trigger('disabled'));
        assert.equal(await page.$('.selection-dialog[open]'), null, `${label}: disabled pointer input cannot open`);
        await page.click('#before-disabled');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.id === 'after-disabled'), true, `${label}: keyboard skips disabled trigger`);
        assert.equal(await updates('disabled'), 0);
        assert.equal(await valueIs('disabled', 'Public images (default)'), true, `${label}: disabled value untouched`);
      }
    } catch (error) { failures.push(error); }
    finally {
      try { await page.evaluate(() => window.selectionFixture?.cleanup()); }
      catch (error) { failures.push(error); }
      try { assert.deepEqual(errors, [], `${label}: page errors`); assert.deepEqual(warnings, [], `${label}: console warnings/errors`); }
      catch (error) { failures.push(error); }
      try { await page.close(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${label}: regression and cleanup failures`, { cause: failures[0] });
    console.log(`PASS: ${label} synthetic component presentation${width === 390 || width === 1440 ? ' and trusted pointer/keyboard selection' : ''}`);
  }
}
