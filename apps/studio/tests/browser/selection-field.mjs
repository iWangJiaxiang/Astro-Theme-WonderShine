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
import ArticleReferences from './src/components/ArticleReferences';
import PublicationDateField from './src/components/PublicationDateField';
import SaveButton from './src/components/SaveButton';
import { ErrorDetails } from './src/components/ErrorNotice';
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
let setLocked, setShowModes, finishCreate;
function ChangingControls() {
  const [locked, lock] = useState(false), [modes, showModes] = useState(true);
  const [references, setReferences] = useState(Array.from({ length: 11 }, (_, i) => ({ kind: 'external', url: 'https://example.com/' + i, title: String(i) })));
  setLocked = lock; setShowModes = showModes;
  return <main>
    <PublicationDateField modelValue="2026-11-25" disabled={locked} onUpdateModelValue={() => updates.date = 1} />
    <ArticleReferences modelValue={references} items={[]} language="en" disabled={locked} onUpdateModelValue={value => { updates.reference = 1; setReferences(value); }} />
    <Field name="chips" label="Selected topics" initial={['a','b','c']} multiple options={tags} />
    <Field name="create" label="Topic" initial={[]} multiple options={[]} disabled={locked}
      createOption={title => new Promise(resolve => { finishCreate = () => resolve({ value: 'new', label: title }); })} />
    <SaveButton mode="local" showModes={modes} onModeChange={() => {}} onSave={() => {}} />
    <ErrorDetails message="Error" source="Fixture" />
  </main>;
}
let resizePlain;
function Fixture() {
  const [options, setOptions] = useState(many);
  resizePlain = size => setOptions(Array.from({ length: size }, (_, i) => ({ value: 'option-' + i, label: 'Option ' + (i + 1) })));
  return <main style={{ padding: 16, display: 'grid', gap: 14, maxWidth: 800, margin: '0 auto' }}>
    <Field name="plain" label="Plain chooser" initial="option-0" options={options} allowCustomValues={false} hint="Choose one option." />
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
let choiceReads = 0;
function manyTags() {
  const options = Array.from({ length: 1000 }, (_, i) => ({
    get value() { choiceReads++; return 'tag-' + i; }, label: 'Tag ' + i,
  }));
  const selected = [...Array.from({ length: 500 }, (_, i) => 'tag-' + (500 + i)), 'legacy'];
  root.render(<Field name="large-tags" label="Tags" initial={selected} options={options} multiple compact />);
}
const root = createRoot(document.getElementById('root'));
root.render(<Fixture />);
window.selectionFixture = {
  manyTags, choiceReads() { return choiceReads; },
  changing() { root.render(<ChangingControls />); },
  lock(value) { setLocked(value); }, showModes(value) { setShowModes(value); },
  finishCreate() { finishCreate(); },
  resizePlain(size) { resizePlain(size); },
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
          await page.locator(trigger(name)).click();
          await page.waitForSelector('.selection-dialog[open]');
        };
        const description = selector => page.$eval(selector, control =>
          document.getElementById(control.getAttribute('aria-describedby'))?.textContent);
        assert.equal(await description(trigger('plain')), 'Choose one option.');
        assert.equal(await page.$eval(trigger('folder'), button => button.hasAttribute('aria-describedby')), false);
        await open('folder');
        await page.click('.selection-dialog input[type="radio"][value="public"]');
        assert.equal(await valueIs('folder', 'All folders'), true, `${label}: pending single does not update parent`);
        assert.equal(await updates('folder'), 0);
        await page.type('.selection-dialog input[type=search]', 'no-matching-folder');
        await page.waitForSelector('.selection-dialog .primary:disabled');
        await page.keyboard.press('Enter');
        assert.equal(await updates('folder'), 0, 'a filtered-out single choice cannot be published');
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

        await page.evaluate(() => window.selectionFixture.resizePlain(1000));
        await open('plain');
        await page.waitForFunction(() => document.querySelectorAll('.selection-dialog input[type=radio]').length === 1000);
        const restoreName = await page.evaluateHandle(() => {
          const prototype = HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'name');
          let reads = 0;
          Object.defineProperty(prototype, 'name', { ...descriptor, get() { reads++; return descriptor.get.call(this); } });
          return () => { Object.defineProperty(prototype, 'name', descriptor); return reads; };
        });
        await page.keyboard.press('Tab');
        const reads = await restoreName.evaluate(restore => restore());
        await restoreName.dispose();
        assert.ok(reads >= 1000 && reads < 10000, 'one Tab groups 1,000 radios without repeated full-list scans');
        await page.click('.selection-dialog input[value="option-2"]');
        await page.evaluate(() => window.selectionFixture.resizePlain(5));
        await page.waitForSelector('[data-field="plain"] fieldset');
        await page.click('.selection-dialog .selection-footer .primary');
        await page.waitForSelector('[data-field="plain"] input[value="option-2"]:checked:focus');

        await page.evaluate(() => window.selectionFixture.resizePlain(6));
        await open('plain');
        await page.evaluate(() => window.selectionFixture.resizePlain(5));
        await page.waitForSelector('[data-field="plain"] fieldset');
        await page.keyboard.press('Escape');
        await page.waitForSelector('[data-field="plain"] input[value="option-2"]:checked:focus');

        await page.evaluate(() => window.selectionFixture.resizePlain(6));
        await page.waitForSelector(trigger('plain') + ':focus');
        await page.evaluate(() => window.selectionFixture.resizePlain(5));
        await page.waitForSelector('[data-field="plain"] input[value="option-2"]:checked:focus');

        const inlineFocused = '[data-field="plain"] input:focus';
        await page.focus('[data-field="plain"] input[value="option-4"]');
        await page.evaluate(() => window.selectionFixture.resizePlain(4));
        await page.waitForSelector(inlineFocused + '[value="option-2"]:checked');
        const beforeRemoval = await updates('plain');
        await page.evaluate(() => window.selectionFixture.resizePlain(2));
        await page.waitForSelector(inlineFocused + '[value="option-1"]:not(:checked)');
        assert.equal(await updates('plain'), beforeRemoval, 'moving focus leaves selection to the user');
        await page.evaluate(() => window.selectionFixture.resizePlain(0));
        await page.waitForSelector('[data-field="plain"] fieldset:focus');
        assert.equal(await description('[data-field="plain"] fieldset'), 'Choose one option.');

        await page.evaluate(() => window.selectionFixture.resizePlain(8));
        await open('plain');
        const dialogOption = '.selection-dialog input[type=radio]';
        await page.focus(dialogOption + '[value="option-6"]');
        await page.evaluate(() => window.selectionFixture.resizePlain(6));
        await page.waitForSelector(dialogOption + '[value="option-5"]:focus:not(:checked)');
        await page.keyboard.press('ArrowLeft');
        await page.waitForSelector(dialogOption + '[value="option-4"]:focus:checked');
        await page.evaluate(() => window.selectionFixture.resizePlain(0));
        await page.waitForSelector('.selection-dialog input[type=search]:focus');
        assert.equal(await updates('plain'), beforeRemoval, 'dialog focus recovery leaves the form value unchanged');
        await page.keyboard.press('Escape');

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

        await page.evaluate(() => window.selectionFixture.manyTags());
        await page.waitForSelector(trigger('large-tags'));
        const optionReads = await page.evaluate(() => window.selectionFixture.choiceReads());
        assert.ok(optionReads >= 1000 && optionReads < 20000, 'building 1,000 choices with 501 selected tags stays linear');
        await open('large-tags');
        await page.waitForSelector('.selection-dialog input[value=legacy]:checked');
        assert.equal(await page.$$eval('.selection-dialog input:checked', inputs => inputs.length), 501);
        assert.equal(await page.$$eval('.selection-dialog .choice-tile', tiles => tiles.length), 1001);
        await page.keyboard.press('Escape');

        await page.evaluate(() => window.selectionFixture.changing());
        for (const selector of ['.thread-date-trigger', '.reference-heading button']) {
          await page.locator(selector).click();
          await page.waitForSelector('dialog:modal');
          await page.evaluate(() => window.selectionFixture.lock(true));
          await page.waitForFunction(() => !document.querySelector('dialog'));
          assert.equal(await updates('date') + await updates('reference'), 0);
          await page.evaluate(() => window.selectionFixture.lock(false));
        }

        for (const expected of ['B', 'C']) {
          const chip = '[data-field="chips"] .selected-choices button:first-child';
          await page.focus(chip);
          await page.keyboard.press('Enter');
          await page.waitForFunction(expected => document.activeElement?.closest('.selected-choices')
            && document.activeElement.textContent.startsWith(expected), {}, expected);
        }
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-field="chips"] input:focus');

        await page.locator('.reference-heading button').click();
        await page.waitForSelector('dialog:modal');
        await page.locator('dialog [aria-pressed=false]').click();
        await page.type('dialog input[type=url]', 'https://example.com/last');
        await page.locator('dialog .selection-footer button').click();
        await page.waitForSelector('.reference-heading button:disabled');
        await page.waitForSelector('.reference-chips li:last-child button:focus');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.reference-chips li:last-child button:focus');
        assert.equal(await page.$$eval('.reference-chips li', items => items.length), 11);
        await open('create');
        const enterAllowed = await page.$eval('.selection-dialog input[type=search]', input =>
          [true, false].map(isComposing => input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', isComposing, bubbles: true, cancelable: true,
          }))));
        assert.deepEqual(enterAllowed, [true, false]);
        await page.type('.selection-dialog input[type=search]', 'New topic');
        await page.locator('.selection-create-action').click();
        await page.waitForSelector('.selection-dialog[aria-busy=true]');
        await page.evaluate(() => window.selectionFixture.lock(true));
        await page.waitForFunction(() => !document.querySelector('dialog'));
        await page.evaluate(() => { window.selectionFixture.lock(false); window.selectionFixture.finishCreate(); });
        await open('create');
        assert.equal(await page.$('.selection-dialog input[value=new]'), null);
        assert.equal(await updates('create'), 0);
        await page.type('.selection-dialog input[type=search]', 'Keyboard topic');
        await page.focus('.selection-create-action');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.selection-dialog[aria-busy=true]');
        await page.evaluate(() => window.selectionFixture.finishCreate());
        await page.waitForSelector('.selection-dialog input[value=new]:checked:focus');
        await page.keyboard.press('Tab');
        await page.waitForSelector('.selection-footer .primary:focus');
        await page.keyboard.press('Enter');
        await page.waitForSelector(trigger('create') + ':focus');
        assert.equal(await page.$('.selection-dialog[open]'), null);
        assert.equal(await updates('create'), 1);
        await open('create');
        await page.click('.selection-dialog input[value=new]');
        await page.locator('.selection-footer .primary').click();
        assert.equal(await updates('create'), 2, 'An existing topic selection can be cleared');
        await page.locator('.save-button-toggle').click();
        await page.waitForSelector('.save-mode-menu');
        await page.evaluate(() => window.selectionFixture.showModes(false));
        await page.waitForFunction(() => !document.querySelector('.save-mode-menu, .save-button-toggle'));
        await page.evaluate(() => window.selectionFixture.showModes(true));
        await page.waitForSelector('.save-button-toggle[aria-expanded=false]');

        await page.locator('.error-more').click();
        await page.waitForSelector('.error-dialog textarea:focus');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        await page.waitForSelector('.error-dialog .primary:focus');
        await page.keyboard.press('Tab');
        await page.waitForSelector('.error-dialog textarea:focus');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.error-more:focus');
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
