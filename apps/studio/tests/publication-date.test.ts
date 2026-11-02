import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationDateDraft, publicationDateValue } from '../src/publication-date.js';

test('publication editing preserves original precision and timezone until the corresponding field is changed', () => {
  const value = '2026-10-27T09:12:34.123456+08:00';
  const draft = publicationDateDraft(value);
  assert.equal(publicationDateValue(draft), value);
  assert.equal(publicationDateValue({ ...draft, date: '2026-10-28' }), '2026-10-28T09:12:34.123456+08:00');
  assert.equal(publicationDateValue({ ...draft, time: '10:20' }), '2026-10-27T10:20:00+08:00');
  assert.equal(publicationDateValue({ ...draft, date: '' }), null);
  assert.equal(publicationDateValue({ ...draft, date: '2026-10-29' }), '2026-10-29T09:12:34.123456+08:00');
});

test('publication editing rejects incomplete or invalid timestamps required by threads', () => {
  const draft = publicationDateDraft('2026-10-27T00:00:00Z');
  for (const change of [{ time: '' }, { date: '' }, { date: '2026-02-30' }, { time: '25:00' }, { zone: '' }, { zone: '+25:00' }]) {
    assert.equal(publicationDateValue({ ...draft, ...change }), null);
  }
});

test('legacy dates can be explicitly applied as complete UTC timestamps', () => {
  assert.equal(publicationDateValue(publicationDateDraft('2026-10-27')), '2026-10-27T00:00:00Z');
  assert.equal(publicationDateValue(publicationDateDraft('2026-10-27 10:30')), '2026-10-27T10:30:00Z');
  assert.equal(publicationDateValue(publicationDateDraft('invalid')), null);
});
