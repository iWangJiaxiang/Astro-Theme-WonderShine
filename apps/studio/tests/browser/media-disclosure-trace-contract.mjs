// Fixed semantic boundaries, never capacity-driven. The final stage ends at stop.
export const mediaTraceStages = Object.freeze([
  'library-initial',
  'library-mobile',
  'public-picker-initial',
  'held-upload-responsive',
  'nested-choosers',
  'reopened-picker',
  'document-insert',
  'media-source-final',
]);
export const mediaTraceCaps = Object.freeze({
  segments: 8, recordsPerSegment: 256, faultsPerSegment: 16,
  totalRecords: 2048, totalFaults: 128, numericMaximum: 2147483647,
});
