import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { HELP } from '../src/cli.js';
import { App, plain } from '../src/ui/app.js';
import { EventEmitter } from 'node:events';
import {
  BRAND_WIDTH, CAT_HEIGHT, CAT_WIDTH, LOGO, LOGO_HEIGHT, LOGO_WIDTH, MOODS, brandLines, catEyes, catFace, catRows,
  farewell, linkLine, logoLines, plainBrand,
} from '../src/ui/art.js';
import { writeFrame } from '../src/protocol.js';
import { stripAnsi, strWidth } from '../src/ui/term.js';
import { cleanupAll, link, makeBeam, rawClient, waitFor } from './helpers.js';

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

test('--help opens with the cat and the wordmark', () => {
  assert.ok(HELP.startsWith(plainBrand().join('\n')));
  assert.ok(HELP.includes('( o.o )'), 'the cat is there');
  assert.ok(HELP.includes(LOGO[4]), 'and so is the wordmark');
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

// ------------------------------------------------------------------- the cat

test('cat: every mood at every moment is exactly CAT_WIDTH x CAT_HEIGHT of pure ASCII, with a 5-column face', () => {
  assert.deepEqual(MOODS, ['idle', 'search', 'busy', 'happy', 'sad', 'alert', 'sleep']);
  for (const mood of MOODS) {
    for (const now of [0, 100, 250, 400, 600, 800, 1200, 4000, 123_456_789]) {
      const rows = catRows(mood, now);
      assert.equal(rows.length, CAT_HEIGHT);
      for (const r of rows) {
        assert.equal(r.length, CAT_WIDTH, `${mood}@${now}: ${JSON.stringify(r)}`);
        assert.match(r, /^[\x20-\x7e]*$/);
      }
      assert.match(catFace(mood, now), /^=[\x21-\x7e]{3}=$/);
    }
  }
});

test('cat: moods look different from each other', () => {
  const looks = MOODS.map((m) => catRows(m, 1000).join('|'));
  assert.equal(new Set(looks).size, MOODS.length);
  const faces = MOODS.map((m) => catFace(m, 1000));
  assert.equal(new Set(faces).size, MOODS.length);
  assert.equal(catFace('happy', 0), '=^.^=');
  assert.equal(catFace('sad', 0), '=;.;=');
  assert.equal(catFace('alert', 0), '=O.O=');
  assert.equal(catFace('busy', 0), '=^w^=');
});

test('cat: it blinks, looks around, wags its tail and snores as time passes', () => {
  assert.equal(catEyes('idle', 0), '-.-', 'blink');
  assert.equal(catEyes('idle', 750), 'o.o');
  assert.equal(catEyes('idle', 4000), '-.-', 'blinks again about every four seconds');
  assert.equal(catEyes('search', 0), '<.<');
  assert.equal(catEyes('search', 600), '>.>');
  assert.equal(catEyes('search', 1200), '<.<');
  assert.notEqual(catRows('idle', 0)[2], catRows('idle', 400)[2], 'tail wags');
  assert.equal(catRows('sleep', 0)[2], catRows('sleep', 400)[2], 'a sleeping cat keeps still');
  assert.notEqual(catRows('sleep', 0)[0], catRows('sleep', 800)[0], 'z / Z');
  assert.match(catRows('sleep', 0)[0], /z/);
  assert.match(catRows('sleep', 800)[0], /Z/);
});

test('cat: brand block puts the cat beside the wordmark, and degrades gracefully when narrow', () => {
  const wide = brandLines(80, 'idle', 750).map(stripAnsi);
  assert.equal(wide.length, LOGO_HEIGHT);
  assert.ok(wide[3].includes('( o.o )') && wide[3].includes(LOGO[3]), 'cat and wordmark share a row');
  assert.ok(wide[4].includes(' > ^ <') && wide[4].includes(LOGO[4]));
  assert.ok(!wide[0].includes('/\\_/\\'), 'cat stands on the baseline, ears below the top row');
  assert.ok(BRAND_WIDTH <= 40);
  const narrow = brandLines(BRAND_WIDTH - 1, 'idle', 750).map(stripAnsi).join('\n');
  assert.ok(!narrow.includes('( o.o )'), 'no cat when it will not fit');
  assert.ok(narrow.includes(LOGO[4]), 'wordmark alone still fits');
});

test('cat: plainBrand (used by --help and the README) is trimmed ASCII with the cat on the baseline', () => {
  const rows = plainBrand();
  assert.equal(rows.length, LOGO_HEIGHT);
  for (const r of rows) {
    assert.match(r, /^[\x20-\x7e]*$/);
    assert.equal(r, r.trimEnd());
  }
  assert.ok(rows[1].includes('/\\_/\\') === false && rows[2].includes('/\\_/\\'));
  assert.ok(rows[3].includes('( o.o )'));
  assert.ok(rows[4].includes('> ^ <'));
});

test('cat: farewell waves goodbye and mentions what was received', () => {
  const plain3 = farewell();
  assert.equal(plain3.length, 3);
  assert.match(plain3[1], /\( \^\.\^ \)\s+bye! see you next time$/);
  assert.match(farewell('received 2.00 MB in 1 transfer')[1], /bye! see you next time - received 2\.00 MB in 1 transfer$/);
});

// ---- the app wires the cat to what is happening (fake engine + fake clock => deterministic)

class FakeBeam extends EventEmitter {
  constructor() {
    super();
    this.list = [];
    this.peerList = [];
    this.autoAccept = false;
    this.downloadDir = '/dl';
    this.discoveryError = null;
  }
  pendingOffers() { return []; }
  transfers() { return this.list; }
  peers() { return this.peerList; }
  info() { return { name: 'fake', fingerprint: 'a'.repeat(64), port: 1, addresses: ['10.0.0.2'], downloadDir: '/dl', discovery: true }; }
}
const xfer = (over) => ({ id: 1, dir: 'send', peerName: 'bob', label: 'a.txt', status: 'active', endedAt: null, error: null, ...over });

test('cat: its mood follows what is happening, and it falls asleep when ignored', () => {
  const beam = new FakeBeam();
  let t = 1_000_000;
  const app = new App(beam, { now: () => t });
  assert.equal(app._mood(), 'search', 'looking for peers');
  beam.peerList = [{ id: 'p1', name: 'bob', address: '10.0.0.3', port: 7878, online: true }];
  assert.equal(app._mood(), 'idle');
  beam.list = [xfer({ status: 'active' })];
  assert.equal(app._mood(), 'busy');
  assert.match(stripAnsi(app._header(100)), /=\^w\^=/, 'purring in the header while transferring');
  beam.list = [xfer({ status: 'done', endedAt: t })];
  assert.equal(app._mood(), 'happy');
  t += 9000;
  assert.equal(app._mood(), 'idle', 'the afterglow fades');
  beam.list = [xfer({ id: 2, status: 'failed', error: 'boom', endedAt: t })];
  assert.equal(app._mood(), 'sad');
  assert.match(stripAnsi(app._header(100)), /=;\.;=/);
  t += 9000;
  beam.list = [];
  assert.equal(app._mood(), 'idle');
  t += 121_000;
  assert.equal(app._mood(), 'sleep', 'nobody has touched the keyboard for two minutes');
  app.handleKey('', { name: 'down' });
  assert.equal(app._mood(), 'idle', 'any key wakes it');
  app.offers = [{}];
  assert.equal(app._mood(), 'alert', 'an incoming offer startles it');
});

test('cat: it announces a finished transfer exactly once, and a failure as bad news', () => {
  const beam = new FakeBeam();
  const app = new App(beam, { now: () => 1_000_000 });
  beam.list = [xfer({ status: 'active' })];
  beam.emit('change');
  assert.equal(app.status, null, 'nothing to say while it is still running');

  beam.list[0].status = 'done';
  beam.emit('change');
  assert.match(app.status.text, /^meow! a\.txt delivered to bob$/);
  assert.equal(app.status.kind, 'ok');
  app.status = null;
  beam.emit('change');
  assert.equal(app.status, null, 'announced only once');

  beam.list = [xfer({ id: 2, dir: 'recv', peerName: 'alice', label: 'pics (3 files)', status: 'done' }), ...beam.list];
  beam.emit('change');
  assert.match(app.status.text, /^meow! pics \(3 files\) received from alice$/);

  beam.list = [xfer({ id: 3, status: 'failed', error: 'connection reset' }), ...beam.list];
  beam.emit('change');
  assert.match(app.status.text, /^oh no - a\.txt: connection reset$/);
  assert.equal(app.status.kind, 'bad');
});

test('cat: transfers that finished before the UI started are not announced', () => {
  const beam = new FakeBeam();
  beam.list = [xfer({ status: 'done', endedAt: 1 })];
  const app = new App(beam, { now: () => 1_000_000 });
  beam.emit('change');
  assert.equal(app.status, null);
});

test('cat: the incoming-transfer prompt has a startled cat on it (when wide enough), at exact frame size', async () => {
  const bob = await makeBeam('bob');
  const app = new App(bob);
  const c = await rawClient(bob);
  await writeFrame(c.sock, { t: 'offer', v: 1, name: 'alice', files: [{ p: 'a.txt', s: 1 }] });
  await waitFor(() => app.offers.length === 1);
  const wide = screen(app, 100, 30);
  assert.match(wide, /alice wants to send you:\s+\/\\_\/\\\s+!/, 'ears and an exclamation mark');
  assert.match(wide, /\( O\.O \)/);
  assert.match(wide, /y\s+Accept\s+n\s+Decline/, 'the prompt itself is intact');
  for (const [w, h] of [[56, 15], [80, 24], [100, 30], [160, 40]]) {
    for (const l of app.render(w, h)) assert.equal(strWidth(stripAnsi(l)), w, `${w}x${h}`);
  }
  assert.doesNotMatch(screen(app, 56, 15), /\( O\.O \)/, 'no room for the cat on the narrowest terminal');
  assert.match(screen(app, 56, 15), /wants to send you/);
  c.sock.destroy();
});

test('cat: the empty transfers panel shows the cat beside the wordmark', async () => {
  const beam = await makeBeam('cat-test');
  const app = new App(beam, { now: () => 750 });
  const s = screen(app, 100, 30);
  // No peers yet, so the cat is in "searching" mode, eyes darting (>.> at this moment).
  assert.match(s, /\( >\.> \)\s+\| \|_\) \|/, 'face on the same row as the wordmark\'s third line');
  assert.match(s, /beam\s+=>\.>=\s+cat-test/);
  const asleep = new App(beam, { now: () => 750 });
  asleep.lastInputAt = -1_000_000;
  assert.match(screen(asleep, 100, 30), /=-\.-=/);
  assert.match(screen(asleep, 100, 30), /\( -\.- \)\s+\| \|_\) \|/);
});
