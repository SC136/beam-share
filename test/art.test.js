import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { HELP } from '../src/cli.js';
import { App, plain } from '../src/ui/app.js';
import { LOGO, LOGO_HEIGHT, LOGO_WIDTH, linkLine, logoLines } from '../src/ui/art.js';
import { stripAnsi, strWidth } from '../src/ui/term.js';
import { cleanupAll, link, makeBeam } from './helpers.js';

after(cleanupAll);

const screen = (app, w, h) => plain(app.render(w, h)).join('\n');

test('logo is pure printable ASCII, so it renders in any terminal and font', () => {
  assert.equal(LOGO.length, LOGO_HEIGHT);
  for (const row of LOGO) assert.match(row, /^[\x20-\x7e]*$/);
  assert.ok(LOGO_WIDTH <= 30, 'small enough for narrow terminals');
  assert.match(LOGO.join('\n'), /\|_\.__\/ \\___\|\\__,_\|_\| \|_\| \|_\|/, 'bottom row of "beam"');
});

test('logoLines centers the wordmark in the requested width', () => {
  const lines = logoLines(60);
  assert.equal(lines.length, LOGO_HEIGHT);
  for (const l of lines) assert.ok(strWidth(stripAnsi(l)) <= 60);
  assert.equal(stripAnsi(lines[4]).trimStart(), LOGO[4]);
  const indent = stripAnsi(lines[4]).length - stripAnsi(lines[4]).trimStart().length;
  assert.equal(indent, Math.floor((60 - LOGO_WIDTH) / 2));
});

test('search animation: constant width, packet moves left to right and loops', () => {
  for (const width of [40, 52, 96]) {
    const frames = Array.from({ length: 40 }, (_, f) => stripAnsi(linkLine(f, width)));
    for (const f of frames) {
      assert.equal(strWidth(f), strWidth(frames[0]), 'width never changes between frames');
      assert.ok(strWidth(f) <= width);
      assert.match(f, /^\[ you \] [.\-=>]+ \[ \?\?\? \]$/);
      assert.match(f, /^[\x20-\x7e]+$/, 'pure ASCII');
    }
    const head = (f) => f.indexOf('>');
    assert.ok(head(frames[3]) > head(frames[1]), 'packet advances');
    assert.equal(new Set(frames).size > 8, true, 'many distinct frames');
  }
});

test('--help starts with the wordmark', () => {
  assert.ok(HELP.startsWith(LOGO.join('\n')));
  assert.match(HELP, /Usage:/);
});

test('empty main screen shows the wordmark when there is room, and hides it when there is not', async () => {
  const beam = await makeBeam('art-test');
  let t = 1_000_000;
  const app = new App(beam, { now: () => t });
  const roomy = screen(app, 100, 30);
  for (const row of LOGO) assert.ok(roomy.includes(row), `logo row present: ${row}`);
  assert.match(roomy, /send files across your LAN/);
  assert.match(roomy, /\[ you \] .* \[ \?\?\? \]/);
  assert.match(roomy, /Looking for devices on your network/);
  assert.match(roomy, /No transfers yet/);

  const cramped = screen(app, 56, 15);
  assert.ok(!cramped.includes(LOGO[4]), 'no logo on the smallest terminal');
  assert.match(cramped, /No transfers yet/, 'hint text still fits');
  assert.match(cramped, /Looking for devices/);
  for (const hint of ['Run `npx beam-share` on another device (same Wi-Fi).', "Can't see it? Press a to connect by IP address.", 'Pick a peer above, then press s to choose files.']) {
    assert.ok(cramped.includes(hint), `hint fits unclipped on the smallest terminal: ${hint}`);
  }
  for (const l of app.render(56, 15)) assert.equal(strWidth(stripAnsi(l)), 56);

  // the packet animates as time passes
  const a = screen(app, 100, 30).split('\n').find((l) => l.includes('[ you ]'));
  t += 480;
  const b = screen(app, 100, 30).split('\n').find((l) => l.includes('[ you ]'));
  assert.notEqual(a, b, 'animation frame advances with time');
});

test('the wordmark and animation go away once there is something real to show', async () => {
  const a = await makeBeam('alice');
  const b = await makeBeam('bob');
  const app = new App(a);
  await link(a, b);
  const s = screen(app, 100, 30);
  assert.doesNotMatch(s, /\[ you \]/, 'animation stops once a peer is found');
  assert.match(s, /Peers \(1\)/);
  assert.match(s, /bob/);
  assert.ok(s.includes(LOGO[4]), 'wordmark still decorates the empty transfers panel');
});
