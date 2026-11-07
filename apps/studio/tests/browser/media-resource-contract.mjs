// This namespace is independent of both DOM layout IDs and controller trace IDs.
export const mediaResourceCaps = Object.freeze({ identities: 64, events: 128, batches: 2, samplesPerBatch: 24, faults: 8, bytes: 32768, numericMaximum: 2147483647 });
export const mediaResourceNamespace = 'studio-media-image-dom-v1';
export const mediaResourceFaultCodes = Object.freeze([
  'clock', 'numeric-saturation', 'identity-cap', 'event-cap', 'batch-cap', 'sample-cap',
  'event-read', 'sample-read', 'sample-scope', 'sample-inactive', 'listener-install',
  'listener-remove', 'projection-size', 'projection-export', 'invalid-export',
  'missing-hook', 'preview-rpc', 'missing-sample', 'missing-cleanup', 'invalid-final',
]);
const totalsKeys = ['observedEvents', 'retainedEvents', 'droppedEvents', 'assignedEvents', 'refusedEvents', 'identityRefusals', 'observedBatches', 'retainedBatches', 'droppedBatches', 'totalSamples', 'retainedSamples', 'droppedSamples'];
const projectionKeys = ['version', 'idNamespace', 'owner', 'status', 'active', 'startedAt', 'timestamp', 'endedAt', 'endReason', 'baseline', 'saturated', 'omitted', 'listeners', 'cleanup', 'totals', 'summaries', 'events', 'batches', 'faults', 'droppedFaults'];
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const max = mediaResourceCaps.numericMaximum;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= max;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const boolean = value => typeof value === 'boolean';
const identity = value => Number.isInteger(value) && value >= 1 && value <= mediaResourceCaps.identities;
const scope = value => ['library', 'picker'].includes(value);
const summaryKeys = ['imageId', 'loadCount', 'errorCount', 'firstAt', 'lastAt'];

// Closed validation precedes serialization or retention, including for malformed RPC data.
export function validateMediaResource(value, owner, final = false) {
  const require = condition => { if (!condition) throw new Error('Invalid media image DOM projection'); };
  const summary = item => {
    require(keys(item, summaryKeys) && identity(item.imageId) && count(item.loadCount) && count(item.errorCount));
    require(item.loadCount + item.errorCount <= max);
    require(item.loadCount + item.errorCount === 0 ? item.firstAt === null && item.lastAt === null : time(item.firstAt) && time(item.lastAt) && item.firstAt >= value.startedAt && item.lastAt >= item.firstAt && item.lastAt <= (value.endedAt ?? value.timestamp));
  };
  require(keys(value, projectionKeys));
  require(value.version === 1 && value.idNamespace === mediaResourceNamespace && value.owner === owner && count(owner) && owner > 0);
  require(['available', 'partial', 'unavailable'].includes(value.status) && boolean(value.active) && boolean(value.saturated) && boolean(value.omitted));
  require(value.baseline === 'unknown' && time(value.startedAt) && time(value.timestamp) && value.timestamp >= value.startedAt);
  require(['open', 'second-preview-finally', 'early-cleanup'].includes(value.endReason));
  require(value.active ? value.endedAt === null && value.endReason === 'open' : time(value.endedAt) && value.endedAt >= value.startedAt && value.endedAt <= value.timestamp && value.endReason !== 'open');
  require(keys(value.listeners, ['load', 'error']) && Object.values(value.listeners).every(boolean));
  require(keys(value.cleanup, ['windowEnd', 'terminal']) && ['pending', 'completed', 'failed'].includes(value.cleanup.windowEnd) && ['pending', 'completed', 'failed'].includes(value.cleanup.terminal));
  require(value.active ? value.cleanup.windowEnd === 'pending' : value.cleanup.windowEnd !== 'pending');
  if (!value.active && value.cleanup.windowEnd === 'completed') require(!value.listeners.load && !value.listeners.error);
  if (value.cleanup.terminal === 'completed') require(!value.active && !value.listeners.load && !value.listeners.error);
  if (final) require(!value.active && !value.listeners.load && !value.listeners.error && value.cleanup.terminal === 'completed');
  require(keys(value.totals, totalsKeys) && Object.values(value.totals).every(count));
  const t = value.totals;
  require(t.observedEvents === t.retainedEvents + t.droppedEvents && t.observedEvents === t.assignedEvents + t.refusedEvents);
  require(t.refusedEvents <= t.identityRefusals && t.observedBatches === t.retainedBatches + t.droppedBatches);
  require(t.totalSamples === t.retainedSamples + t.droppedSamples);
  require(t.retainedEvents === Math.min(t.observedEvents, mediaResourceCaps.events));
  require(t.retainedBatches === Math.min(t.observedBatches, mediaResourceCaps.batches));
  require(t.retainedSamples <= mediaResourceCaps.batches * mediaResourceCaps.samplesPerBatch);
  if (value.endReason === 'second-preview-finally') require(t.observedBatches >= mediaResourceCaps.batches || value.status !== 'available');
  require(Array.isArray(value.faults) && value.faults.length <= mediaResourceCaps.faults && value.faults.every(code => mediaResourceFaultCodes.includes(code)) && count(value.droppedFaults));
  require(!value.droppedFaults || value.faults.length === mediaResourceCaps.faults);
  require(Array.isArray(value.summaries) && value.summaries.length <= mediaResourceCaps.identities);
  require(Array.isArray(value.events) && value.events.length <= mediaResourceCaps.events);
  require(Array.isArray(value.batches) && value.batches.length <= mediaResourceCaps.batches);
  if (value.omitted) {
    require(value.status === 'unavailable' && value.summaries.length === 0 && value.events.length === 0 && value.batches.length === 0);
  } else {
    require(value.status !== 'unavailable');
    require(value.events.length === t.retainedEvents && value.batches.length === t.retainedBatches);
    let assigned = 0, retainedSamples = 0, totalSamples = 0;
    for (const [index, item] of value.summaries.entries()) {
      summary(item); require(item.imageId === index + 1); assigned += item.loadCount + item.errorCount;
    }
    require(assigned === t.assignedEvents);
    let previousTime = value.startedAt, retainedAssigned = 0, retainedRefused = 0;
    const retainedCounts = value.summaries.map(() => ({ load: 0, error: 0 }));
    for (const [index, item] of value.events.entries()) {
      require(keys(item, ['seq', 'kind', 'scope', 'imageId', 'trusted', 'connected', 'timestamp']));
      require(item.seq === index + 1 && ['load', 'error'].includes(item.kind) && scope(item.scope));
      require(item.imageId === null || identity(item.imageId) && item.imageId <= value.summaries.length);
      require(boolean(item.trusted) && boolean(item.connected) && time(item.timestamp) && item.timestamp >= previousTime && item.timestamp <= (value.endedAt ?? value.timestamp));
      previousTime = item.timestamp;
      if (item.imageId === null) retainedRefused++;
      else { retainedAssigned++; retainedCounts[item.imageId - 1][item.kind]++; }
    }
    require(retainedAssigned <= t.assignedEvents && retainedRefused <= t.refusedEvents);
    for (const [index, item] of value.summaries.entries()) {
      require(retainedCounts[index].load <= item.loadCount && retainedCounts[index].error <= item.errorCount);
      if (!t.droppedEvents) require(retainedCounts[index].load === item.loadCount && retainedCounts[index].error === item.errorCount);
    }
    for (const [index, batch] of value.batches.entries()) {
      require(keys(batch, ['attempt', 'scope', 'timestamp', 'total', 'retained', 'dropped', 'samples', 'status']));
      require(batch.attempt === index + 1 && batch.scope === (index === 0 ? 'library' : 'picker') && time(batch.timestamp) && batch.timestamp >= value.startedAt && batch.timestamp <= (value.endedAt ?? value.timestamp));
      require(['available', 'partial'].includes(batch.status));
      require(count(batch.total) && count(batch.retained) && count(batch.dropped) && batch.total === batch.retained + batch.dropped && batch.retained === Math.min(batch.total, mediaResourceCaps.samplesPerBatch));
      require(Array.isArray(batch.samples) && batch.samples.length === batch.retained);
      totalSamples += batch.total; retainedSamples += batch.retained;
      for (const [ordinal, item] of batch.samples.entries()) {
        require(keys(item, ['ordinal', ...summaryKeys, 'complete', 'naturalWidthPositive', 'loading', 'decoding', 'connected']));
        require(item.ordinal === ordinal && count(item.ordinal));
        if (item.imageId === null) require(item.loadCount === null && item.errorCount === null && item.firstAt === null && item.lastAt === null);
        else {
          summary(Object.fromEntries(summaryKeys.map(key => [key, item[key]]))); require(item.imageId <= value.summaries.length);
          const latest = value.summaries[item.imageId - 1];
          require(item.loadCount <= latest.loadCount && item.errorCount <= latest.errorCount);
          require(item.lastAt === null || item.lastAt <= batch.timestamp);
        }
        require([item.complete, item.naturalWidthPositive, item.connected].every(item => item === null || boolean(item)));
        require(['eager', 'lazy', 'unknown', null].includes(item.loading) && ['sync', 'async', 'auto', 'unknown', null].includes(item.decoding));
        if (item.imageId === null || item.complete === null || item.naturalWidthPositive === null || item.loading === null || item.decoding === null || item.connected === null) require(batch.status === 'partial');
      }
      if (batch.dropped) require(batch.status === 'partial');
    }
    require(totalSamples <= t.totalSamples && retainedSamples === t.retainedSamples);
    if (!t.droppedBatches) require(totalSamples === t.totalSamples);
  }
  const problem = value.saturated || value.omitted || value.faults.length || value.droppedFaults || t.droppedEvents || t.identityRefusals || t.droppedBatches || t.droppedSamples || value.cleanup.windowEnd === 'failed' || value.cleanup.terminal === 'failed' || value.batches.some(batch => batch.status === 'partial');
  require(!problem || value.status !== 'available');
  // Even reaching a numeric boundary is failure, not a successful clamped observation.
  const atMaximum = object => Object.values(object).some(item => typeof item === 'number' ? item >= max : item && typeof item === 'object' ? atMaximum(item) : false);
  require(!atMaximum(value) || value.saturated && value.status !== 'available');
  require(Buffer.byteLength(JSON.stringify(value), 'utf8') <= mediaResourceCaps.bytes);
  return value;
}

export function unavailableMediaResource(owner) {
  return {
    version: 1, idNamespace: mediaResourceNamespace, owner, status: 'unavailable', active: false,
    startedAt: 0, timestamp: 0, endedAt: 0, endReason: 'early-cleanup', baseline: 'unknown', saturated: false, omitted: true,
    listeners: { load: false, error: false }, cleanup: { windowEnd: 'failed', terminal: 'pending' },
    totals: Object.fromEntries(totalsKeys.map(key => [key, 0])), summaries: [], events: [], batches: [], faults: [], droppedFaults: 0,
  };
}
