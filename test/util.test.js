import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, formatBytes, formatDuration, formatRate, shortFp } from '../src/util.js';

test('formatBytes uses decimal units with sensible precision', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1.50 KB');
  assert.equal(formatBytes(41_943_040), '41.9 MB');
  assert.equal(formatBytes(123_456_789_000), '123 GB');
  assert.equal(formatBytes(-1), '?');
  assert.equal(formatBytes(NaN), '?');
  assert.equal(formatRate(2_500_000), '2.50 MB/s');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0.4), '<1s');
  assert.equal(formatDuration(5), '5s');
  assert.equal(formatDuration(65), '1m 05s');
  assert.equal(formatDuration(3725), '1h 02m');
  assert.equal(formatDuration(Infinity), '--');
  assert.equal(formatDuration(-3), '--');
});

test('clean strips control characters, bidi overrides and collapses whitespace', () => {
  assert.equal(clean('a\u001b[31mb'), 'a [31mb');
  assert.equal(clean('  many   spaces\t\nhere '), 'many spaces here');
  assert.equal(clean('evil‮txt.exe'), 'evil txt.exe');
  assert.equal(clean('x'.repeat(300), 10), 'xxxxxxxxx…');
  assert.equal(clean(undefined), '');
});

test('shortFp groups the first 12 hex digits', () => {
  assert.equal(shortFp('a1b2c3d4e5f60718293a'), 'a1b2-c3d4-e5f6');
});
