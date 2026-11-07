import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type EvaluateArgs = { caps?: object; label?: string; kind?: string };
type Diagnostics = {
  install(): Promise<void>;
  snapshot(label: string): Promise<void>;
  stop(outcome: string): Promise<void>;
  takeErrors(): unknown[];
  writeReport(): Promise<void>;
};
type Factory = (options: {
  page: { evaluate(callback: unknown, args: EvaluateArgs): Promise<unknown> };
  reportPath: string;
  withTimeout: <T>(action: () => Promise<T>) => Promise<T>;
}) => Diagnostics;
type Report = {
  active: boolean;
  outcome: string;
  installation: string;
  diagnosticFailures: { stage: string }[];
  diagnosticFailureCount: number;
  droppedFailures: number;
  cleanup: Record<string, string>;
  browser: { failures: { stage: string }[] };
};

// Variable URLs keep these test-only JavaScript imports out of declaration resolution.
const chooserURL = new URL('./browser/chooser-scroll-diagnostics.mjs', import.meta.url).href;
const folderURL = new URL('./browser/folder-clear-diagnostics.mjs', import.meta.url).href;
const { createChooserScrollDiagnostics } = await import(chooserURL) as { createChooserScrollDiagnostics: Factory };
const { createFolderClearDiagnostics } = await import(folderURL) as { createFolderClearDiagnostics: Factory };
const helpers = [
  { name: 'chooser', create: createChooserScrollDiagnostics, cleanup: ['listeners', 'hook'],
    overflowMessage: 'Chooser scroll diagnostic failure budget exceeded' },
  { name: 'folder', create: createFolderClearDiagnostics, cleanup: ['observer', 'listeners', 'hook'],
    overflowMessage: 'Folder clear diagnostic failure budget exceeded' },
];
const archivedStages = Array.from({ length: 16 }, (_, index) => ({ stage: `checkpoint-${index}` }));

async function fixture(t: TestContext, create: Factory, invalidReportPath = false) {
  const root = await mkdtemp(join(tmpdir(), 'studio-diagnostic-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report.json');
  if (invalidReportPath) await mkdir(reportPath);
  const calls: string[] = [];
  const snapshotFailures = new Map<string, Error>();
  const cleanupFailures = new Set<string>();
  const browserFailures: { stage: string }[] = [];
  let browserDroppedFailures = 0;
  const diagnostics = create({
    reportPath,
    withTimeout: action => action(),
    page: {
      // Never execute the supplied callback: no DOM, browser or project boot is involved.
      async evaluate(_callback, args) {
        calls.push(args.kind ?? args.label ?? 'install');
        if (args.kind) {
          if (cleanupFailures.has(args.kind)) throw new Error(`private-cleanup-${args.kind}`);
          return 'completed';
        }
        if (args.label && snapshotFailures.has(args.label)) throw snapshotFailures.get(args.label);
        return {
          installed: true,
          failures: args.label === 'stopping' ? [...browserFailures] : [],
          failureCount: args.label === 'stopping' ? browserFailures.length + browserDroppedFailures : 0,
          droppedFailures: args.label === 'stopping' ? browserDroppedFailures : 0,
        };
      },
    },
  });
  await diagnostics.install();
  assert.deepEqual(diagnostics.takeErrors(), []);
  async function failSnapshot(label: string) {
    const error = Object.assign(new Error(`private-message-${label}`), { privatePayload: 'private-payload' });
    snapshotFailures.set(label, error);
    await diagnostics.snapshot(label);
    return error;
  }
  async function fillAndDrain() {
    const originals: Error[] = [];
    for (const { stage } of archivedStages) originals.push(await failSnapshot(stage));
    const drained = diagnostics.takeErrors();
    assert.equal(drained.length, 16);
    drained.forEach((error, index) => assert.strictEqual(error, originals[index]));
    assert.deepEqual(diagnostics.takeErrors(), []);
    return originals;
  }
  async function readReport(dropped: number) {
    await diagnostics.writeReport();
    const json = await readFile(reportPath, 'utf8');
    assert.doesNotMatch(json, /private-|"(?:stack|message|errors|privatePayload)"/);
    assert.ok(!json.includes(reportPath));
    const report = JSON.parse(json) as Report;
    assert.deepEqual(report.diagnosticFailures, archivedStages);
    assert.equal(report.diagnosticFailures.length, 16);
    assert.equal(report.droppedFailures, dropped);
    assert.equal(report.diagnosticFailureCount, 16 + dropped);
    return report;
  }
  return {
    diagnostics, reportPath, calls, snapshotFailures, cleanupFailures, browserFailures,
    setBrowserDroppedFailures(count: number) { browserDroppedFailures = count; },
    failSnapshot, fillAndDrain, readReport,
  };
}

function genericSignal(errors: unknown[]) {
  assert.equal(errors.length, 1, 'Pending overflows must coalesce into one failure signal');
  const error = errors[0];
  assert.ok(error instanceof Error);
  assert.ok(error.message.trim().length > 0);
  assert.doesNotMatch(error.message, /private-|EISDIR|checkpoint-|late-|report\.json/);
  return error;
}

for (const helper of helpers) {
  test(`${helper.name}: full archive preserves originals and overflow signals rearm after every drain`, async t => {
    const f = await fixture(t, helper.create);
    const originals = await f.fillAndDrain();
    await f.readReport(0);
    await f.failSnapshot('late-first');
    await f.failSnapshot('late-second');
    await f.failSnapshot('late-third');
    const firstSignal = genericSignal(f.diagnostics.takeErrors());
    assert.equal(firstSignal.message, helper.overflowMessage);
    assert.ok(!originals.includes(firstSignal));
    assert.deepEqual(f.diagnostics.takeErrors(), []);
    await f.readReport(3);

    await f.failSnapshot('late-rearmed');
    const nextSignal = genericSignal(f.diagnostics.takeErrors());
    assert.equal(nextSignal.message, firstSignal.message, 'Overflow messages must be fixed, not raw errors');
    assert.notStrictEqual(nextSignal, firstSignal);
    assert.deepEqual(f.diagnostics.takeErrors(), []);
    await f.readReport(4);
  });

  test(`${helper.name}: failed stopping snapshot cannot skip independent cleanup after a full, drained archive`, async t => {
    const f = await fixture(t, helper.create);
    await f.fillAndDrain();
    f.calls.length = 0;
    f.cleanupFailures.add(helper.cleanup[0]);
    f.snapshotFailures.set('stopping', new Error('private-stopping-snapshot'));
    await f.diagnostics.stop('failed');
    genericSignal(f.diagnostics.takeErrors());
    assert.deepEqual(f.diagnostics.takeErrors(), []);
    assert.deepEqual(f.calls, ['stopping', ...helper.cleanup]);
    const report = await f.readReport(2);
    assert.equal(report.active, false);
    assert.equal(report.outcome, 'failed');
    assert.deepEqual(report.cleanup, Object.fromEntries(helper.cleanup.map((kind, index) =>
      [kind, index === 0 ? 'failed' : 'completed'])));
  });

  test(`${helper.name}: terminal browser faults still signal failure after a full, drained archive`, async t => {
    const f = await fixture(t, helper.create);
    await f.fillAndDrain();
    f.browserFailures.push({ stage: 'event' });
    f.setBrowserDroppedFailures(1);
    f.calls.length = 0;
    await f.diagnostics.stop('passed');
    genericSignal(f.diagnostics.takeErrors());
    assert.deepEqual(f.diagnostics.takeErrors(), []);
    assert.deepEqual(f.calls, ['stopping', ...helper.cleanup]);
    const report = await f.readReport(2);
    assert.equal(report.installation, 'installed');
    assert.equal(report.active, false);
    assert.deepEqual(report.browser.failures, [{ stage: 'event' }]);
    assert.deepEqual(report.cleanup, Object.fromEntries(helper.cleanup.map(kind => [kind, 'completed'])));
  });
}

test('folder: late report-write failures are nonthrowing and rearm after a full, drained archive', async t => {
  const f = await fixture(t, createFolderClearDiagnostics, true);
  await f.fillAndDrain();
  await assert.doesNotReject(() => f.diagnostics.writeReport());
  const firstSignal = genericSignal(f.diagnostics.takeErrors());
  assert.deepEqual(f.diagnostics.takeErrors(), []);
  await assert.doesNotReject(() => f.diagnostics.writeReport());
  const nextSignal = genericSignal(f.diagnostics.takeErrors());
  assert.equal(nextSignal.message, firstSignal.message);
  assert.notStrictEqual(nextSignal, firstSignal);
  assert.deepEqual(f.diagnostics.takeErrors(), []);
  // Make the same path writable so the failed writes' exact counters can be inspected.
  await rm(f.reportPath, { recursive: true });
  await f.readReport(2);
});

test('chooser: caller can catch report-write rejection and finally drain an already pending overflow', async t => {
  const f = await fixture(t, createChooserScrollDiagnostics, true);
  await f.fillAndDrain();
  await f.failSnapshot('late-before-write');
  const operationError = new Error('private-original-operation');
  const callerErrors: unknown[] = [operationError];
  try {
    await f.diagnostics.writeReport();
    assert.fail('Writing a report to a directory must reject');
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
    callerErrors.push(error);
  } finally {
    callerErrors.push(...f.diagnostics.takeErrors());
  }
  assert.strictEqual(callerErrors[0], operationError);
  assert.equal(callerErrors.length, 3);
  genericSignal(callerErrors.slice(2));
  assert.deepEqual(f.diagnostics.takeErrors(), []);
  await rm(f.reportPath, { recursive: true });
  await f.readReport(1);
});
