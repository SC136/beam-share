import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sanitizeRelPath, resolveInside, numbered } from '../src/safepath.js';

const posix = { windows: false };
const win = { windows: true };

test('rejects traversal, absolute paths, empty and dot segments', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a//b', 'a/./b', '', '..', '.', 'a/..', 'a/', 42, null, 'x'.repeat(2000)]) {
    assert.equal(sanitizeRelPath(bad, posix), null, `posix should reject ${JSON.stringify(bad)}`);
    assert.equal(sanitizeRelPath(bad, win), null, `win should reject ${JSON.stringify(bad)}`);
  }
});

test('accepts normal nested paths unchanged', () => {
  assert.deepEqual(sanitizeRelPath('photos/2024/img 01.jpg', posix), ['photos', '2024', 'img 01.jpg']);
  assert.deepEqual(sanitizeRelPath('photos/2024/img 01.jpg', win), ['photos', '2024', 'img 01.jpg']);
  assert.deepEqual(sanitizeRelPath('日本語/ファイル.txt', win), ['日本語', 'ファイル.txt']);
});

test('windows: drive letters, backslashes, reserved names and trailing dots are neutralised', () => {
  assert.deepEqual(sanitizeRelPath('C:/Windows/x', win), ['C_', 'Windows', 'x']);
  // a backslash is just a character on the wire, never a path separator
  assert.deepEqual(sanitizeRelPath('a\\..\\b', win), ['a_.._b']);
  assert.deepEqual(sanitizeRelPath('..\\..\\evil', win), ['.._.._evil']);
  assert.deepEqual(sanitizeRelPath('a\\b', posix), ['a_b']);
  assert.deepEqual(sanitizeRelPath('CON', win), ['_CON']);
  assert.deepEqual(sanitizeRelPath('nul.txt', win), ['_nul.txt']);
  assert.deepEqual(sanitizeRelPath('report.', win), ['report']);
  assert.deepEqual(sanitizeRelPath('a?b*c.txt', win), ['a_b_c.txt']);
  assert.deepEqual(sanitizeRelPath('file:stream', win), ['file_stream']);
});

test('control characters and NUL are replaced everywhere', () => {
  assert.deepEqual(sanitizeRelPath('a\u0000b\u001b[31m.txt', posix), ['a_b_[31m.txt']);
});

test('over-long names are truncated but keep the extension', () => {
  const [seg] = sanitizeRelPath('a'.repeat(400) + '.mp4', posix);
  assert.ok(Buffer.byteLength(seg) <= 200);
  assert.ok(seg.endsWith('.mp4'));
});

test('resolveInside never escapes the base directory', () => {
  const base = path.resolve('some', 'downloads');
  assert.equal(resolveInside(base, ['a', 'b.txt']), path.join(base, 'a', 'b.txt'));
  assert.equal(resolveInside(base, ['..', 'x']), null);
  assert.equal(resolveInside(base, ['a', '..', '..', 'x']), null);
  assert.equal(resolveInside(base, []), null);
});

test('numbered', () => {
  assert.equal(numbered('a.txt', 0), 'a.txt');
  assert.equal(numbered('a.txt', 2), 'a (2).txt');
  assert.equal(numbered('archive.tar.gz', 1), 'archive.tar (1).gz');
  assert.equal(numbered('noext', 3), 'noext (3)');
});
