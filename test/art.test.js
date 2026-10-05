import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP } from '../src/cli.js';
import { BRAND_WIDTH, LOGO, LOGO_HEIGHT, LOGO_WIDTH, TAGLINE, brandLines, farewell, plainBrand } from '../src/ui/art.js';
import { stripAnsi, strWidth } from '../src/ui/term.js';

test('the logo and cat are plain printable ASCII, so they look right in any terminal and font', () => {
  assert.equal(LOGO.length, LOGO_HEIGHT);
  for (const row of [...LOGO, ...plainBrand(), ...farewell('received 1 MB'), TAGLINE]) assert.match(row, /^[\x20-\x7e]*$/);
  assert.match(LOGO.join('\n'), /\|_\.__\/ \\___\|\\__,_\|_\| \|_\| \|_\|/, 'bottom row of "beam"');
});

test('plainBrand puts the cat on the logo\'s baseline, with no trailing spaces', () => {
  const rows = plainBrand();
  assert.equal(rows.length, LOGO_HEIGHT);
  for (const r of rows) assert.equal(r, r.trimEnd());
  assert.ok(rows[2].includes('/\\_/\\') && rows[3].includes('( o.o )') && rows[4].includes('> ^ <'));
  assert.ok(rows[4].includes(LOGO[4]));
});

test('brandLines centres the cat and logo and never exceeds the width it is given', () => {
  for (const width of [BRAND_WIDTH, BRAND_WIDTH + 1, 60, 100]) {
    const lines = brandLines(width);
    assert.equal(lines.length, LOGO_HEIGHT);
    for (const l of lines) assert.ok(strWidth(stripAnsi(l)) <= width);
    assert.ok(stripAnsi(lines[3]).includes('( o.o )') && stripAnsi(lines[3]).includes(LOGO[3]));
  }
  assert.equal(stripAnsi(brandLines(60)[4]).indexOf('> ^ <'), Math.floor((60 - BRAND_WIDTH) / 2) + 1);
  assert.ok(BRAND_WIDTH + 2 <= 52, 'fits the narrowest supported terminal');
  assert.ok(LOGO_WIDTH < BRAND_WIDTH);
});

test('--help opens with the cat and logo, and mentions only what the app does', () => {
  assert.ok(HELP.startsWith(plainBrand().join('\n')));
  assert.match(HELP, /Usage:/);
  assert.doesNotMatch(HELP, /relay|room|internet/i);
});

test('farewell waves goodbye, with an optional note', () => {
  assert.equal(farewell().length, 3);
  assert.match(farewell()[1], /\( \^\.\^ \)\s+bye!$/);
  assert.match(farewell('received 2 MB')[1], /bye! received 2 MB$/);
});
