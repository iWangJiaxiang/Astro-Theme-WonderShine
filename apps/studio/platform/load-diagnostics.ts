import type { ProgressCallback } from 'isomorphic-git';

const phases = ['Receiving objects', 'Resolving deltas', 'Updating workdir', 'Analyzing workdir', 'Counting objects', 'Compressing objects'] as const;
type Stage = 'git-open' | 'recovery' | 'content-request' | typeof phases[number];
const storageKey = 'wondershine.native.load-diagnostics.v1';

/** Latest connection only. Never record repository identity, paths, credentials or error text. */
export function createLoadDiagnostics(storage: Pick<Storage, 'setItem'>, now = () => performance.now()) {
  const timings: Partial<Record<Stage, { count: number; totalMs: number }>> = {};
  let active = true;
  const clock = () => { try { const value = now(); return Number.isFinite(value) ? value : NaN; } catch { return NaN; } };
  function record(stage: Stage, elapsed: number) {
    if (!active || !Number.isFinite(elapsed)) return;
    const previous = timings[stage] || { count: 0, totalMs: 0 };
    timings[stage] = { count: previous.count + 1, totalMs: previous.totalMs + Math.max(0, Math.round(elapsed)) };
    try { storage.setItem(storageKey, JSON.stringify({ version: 1, timings })); } catch { /* Diagnostics must never block opening or editing. */ }
  }
  // Replace the previous connection's report, including when this one fails before producing timings.
  try { storage.setItem(storageKey, JSON.stringify({ version: 1, timings })); } catch { /* Storage is optional. */ }
  return {
    async measure<T>(stage: 'git-open' | 'recovery' | 'content-request', operation: () => Promise<T>): Promise<T> {
      const start = clock();
      try { return await operation(); } finally { record(stage, clock() - start); }
    },
    progress(callback?: ProgressCallback) {
      let current: Stage | undefined, started = 0, lastSent = -Infinity;
      const finish = () => {
        if (current) record(current, clock() - started);
        current = undefined;
      };
      const onProgress: ProgressCallback = event => {
        const time = clock();
        const phase = phases.find(phase => phase === event.phase);
        const changed = phase !== current;
        if (changed) {
          if (current) record(current, time - started);
          current = phase; started = time;
        }
        // Phase duration is wall time between progress notifications, not exclusive CPU time.
        // Bound React updates while preserving phase transitions and completion events.
        if (changed || !Number.isFinite(time) || !Number.isFinite(lastSent) || time - lastSent >= 100 || (event.total != null && event.loaded >= event.total)) {
          lastSent = time;
          return callback?.(event);
        }
      };
      return { onProgress, finish };
    },
    dispose() { active = false; },
  };
}
