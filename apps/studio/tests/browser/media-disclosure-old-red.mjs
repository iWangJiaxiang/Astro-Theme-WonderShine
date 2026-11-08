import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { checkMediaDisclosureRace } from './media-disclosure-race.mjs';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const baselineSHA = 'd078ced2858bafeecfd7194baf2882bb3ab3cf1a';
const componentPath = 'apps/studio/src/components/MediaBrowser.tsx';
const git = args => execFileSync('git', args, {
  cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const currentHEAD = git(['rev-parse', '--verify', 'HEAD']).trim();
const componentSource = git(['show', `${baselineSHA}:${componentPath}`]);
const currentSource = readFileSync(new URL('../../src/components/MediaBrowser.tsx', import.meta.url), 'utf8');

// Fail closed across the complete component: allow only the exact DOM-sync fix
// and the separately specified bounded-thumbnail policy changes below.
const baselineContext = `    const narrowLayout = window.matchMedia("(max-width: 760px)");
    const browseExpanded = ref(!narrowLayout.matches);
    const browseDisclosure = ref<HTMLDetailsElement>();
    function layoutChanged(event: MediaQueryListEvent) {
      const disclosure = browseDisclosure.value;
      if (event.matches && disclosure?.contains(document.activeElement))
        disclosure.querySelector("summary")?.focus({ preventScroll: true });
      browseExpanded.value = !event.matches;
    }
    narrowLayout.addEventListener("change", layoutChanged);`;
const domSyncLine = '      if (disclosure) disclosure.open = !event.matches;\n';
const currentContext = baselineContext.replace(
  '      browseExpanded.value = !event.matches;',
  `${domSyncLine}      browseExpanded.value = !event.matches;`,
);
const occurrences = (source, text) => source.split(text).length - 1;
assert.equal(occurrences(componentSource, baselineContext), 1, 'Historical media-query context must match exactly once');
assert.equal(occurrences(currentSource, currentContext), 1, 'Current media-query context must match exactly once');
assert.equal(occurrences(componentSource, domSyncLine), 0, 'Historical source must not contain the DOM-sync line');
assert.equal(occurrences(currentSource, domSyncLine), 1, 'Current source must contain exactly one DOM-sync line');
const thumbnailChanges = [
  [
    'type Events = { select: [item: MediaItem, value: string] };\n',
    'type Events = { select: [item: MediaItem, value: string] };\nconst INITIAL_EAGER_THUMBNAILS = 4;\n',
  ],
  [
    `    watch([search, source, folder], () => {
      page.value = 1;
    });`,
    `    // A bounded initial batch avoids lazy deferral, not asynchronous image work.
    const eagerPaths = computed(
      () =>
        new Set(
          items.value
            .filter((item) => !item.unavailable && !failed.value.has(item.path))
            .slice(0, INITIAL_EAGER_THUMBNAILS)
            .map((item) => item.path),
        ),
    );
    watch([search, source, folder], () => {
      page.value = 1;
    });`,
  ],
  ['                              loading: "lazy",', '                              loading: eagerPaths.value.has(item.path) ? "eager" : "lazy",'],
  ['                                failed.value.add(item.path);', '                                failed.value = new Set([...failed.value, item.path]);'],
];
let expectedSource = componentSource.replace(baselineContext, currentContext);
for (const [before, after] of thumbnailChanges) {
  assert.equal(occurrences(expectedSource, before), 1, 'Known thumbnail change must have exactly one historical anchor');
  assert.equal(occurrences(currentSource, after), 1, 'Known thumbnail change must match current source exactly once');
  expectedSource = expectedSource.replace(before, after);
}
assert.equal(currentSource, expectedSource,
  'Complete MediaBrowser must equal the fixed historical source plus only the exact DOM-sync and enumerated thumbnail changes');

console.log(`Media disclosure counterfactual current git HEAD: ${currentHEAD}`);
console.log(`Media disclosure counterfactual baseline SHA: ${baselineSHA}`);
console.log(`Media disclosure counterfactual component path: ${componentPath}`);
console.log('Boundary: current dependencies and shared fixture/cases; historical MediaBrowser component only. Scheduling evidence, not trusted pointer or native WebView acceptance.');

const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to Chrome/Chromium.');
const browser = await puppeteer.launch({ headless: true, executablePath });
const failures = [];
try {
  await checkMediaDisclosureRace(browser, { componentSource, expectedRed: true });
} catch (error) {
  failures.push(error);
} finally {
  try { await browser.close(); }
  catch (error) { failures.push(error); }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, 'Media disclosure old-red regression and browser cleanup failures', { cause: failures[0] });
console.log('PASS: all six historical MediaBrowser cases produced only the exact expected race.after failure, with clean teardown.');
