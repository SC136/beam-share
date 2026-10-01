import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { App, plain } from '../src/ui/app.js';
import { TextInput } from '../src/ui/input.js';
import { expandPath, FilePicker } from '../src/ui/picker.js';
import { box, charWidth, fit, fitEnd, padAnsi, paint, progressBar, stripAnsi, strWidth } from '../src/ui/term.js';
import { writeFrame } from '../src/protocol.js';
import { cleanupAll, link, makeBeam, rawClient, settled, tmpdir, waitFor } from './helpers.js';

after(cleanupAll);

const W = 100;
const H = 30;

/** Type a key the way readline reports it. */
function press(app, k) {
  const named = { enter: 'return', esc: 'escape', space: 'space', up: 'up', down: 'down', left: 'left', right: 'right', tab: 'tab', backspace: 'backspace', pageup: 'pageup', pagedown: 'pagedown', home: 'home', end: 'end' };
  if (k in named) app.handleKey(k === 'space' ? ' ' : '', { name: named[k] });
  else app.handleKey(k, { name: k.toLowerCase(), shift: k !== k.toLowerCase() });
}
const type = (app, text) => [...text].forEach((c) => press(app, c === ' ' ? 'space' : c));
const screen = (app, w = W, h = H) => plain(app.render(w, h)).join('\n');

function makeApp(beam, extra = {}) {
  const opened = [];
  const app = new App(beam, { startDir: extra.startDir ?? tmpdir(), opener: (d) => (opened.push(d), true), ...extra });
  app.opened = opened;
  return app;
}

function assertFrame(app, w, h, label) {
  const lines = app.render(w, h);
  assert.equal(lines.length, h, `${label}: height`);
  lines.forEach((l, i) => assert.equal(strWidth(stripAnsi(l)), w, `${label}: line ${i} is ${strWidth(stripAnsi(l))} wide, want ${w}: ${JSON.stringify(stripAnsi(l))}`));
}

// ------------------------------------------------------------ term helpers

test('display width: wide, combining and control characters', () => {
  assert.equal(strWidth('abc'), 3);
  assert.equal(strWidth('日本語'), 6);
  assert.equal(strWidth('e\u0301'), 1); // e + combining acute
  assert.equal(strWidth('a\u001bb'), 2);
  assert.equal(charWidth(0x1f600), 2);
});

test('fit / fitEnd / padAnsi produce exact widths and never split wide characters', () => {
  for (const s of ['short', 'a much longer string than fits', '日本語のファイル名.txt', '']) {
    for (const w of [1, 2, 5, 10, 25]) {
      assert.equal(strWidth(fit(s, w)), w, `fit(${s},${w})`);
      assert.equal(strWidth(fitEnd(s, w)), w, `fitEnd(${s},${w})`);
    }
  }
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fitEnd('C:\\a\\b\\c.txt', 8), '…b\\c.txt');
  const styled = paint('hello world', { fg: 81, bold: true }) + ' tail';
  const clipped = padAnsi(styled, 7);
  assert.equal(strWidth(stripAnsi(clipped)), 7);
  assert.ok(clipped.includes('\x1b[0m'), 'a clipped styled string is closed with a reset');
  assert.equal(stripAnsi(padAnsi('abc', 6)), 'abc   ');
});

test('box has exact dimensions, and progress bar fills proportionally', () => {
  const b = box({ title: 'Title', w: 30, h: 5, lines: ['one', 'two'] });
  assert.equal(b.length, 5);
  for (const l of b) assert.equal(strWidth(stripAnsi(l)), 30);
  assert.match(stripAnsi(b[0]), /^╭─ Title ─+╮$/);
  assert.equal(stripAnsi(progressBar(0.5, 10)), '█████░░░░░');
  assert.equal(stripAnsi(progressBar(2, 4)), '████');
  assert.equal(stripAnsi(progressBar(-1, 4)), '░░░░');
});

test('text input editing', () => {
  const t = new TextInput();
  for (const c of 'hello') t.handle(c, { name: c });
  assert.equal(t.value, 'hello');
  t.handle('', { name: 'left' });
  t.handle('', { name: 'backspace' });
  assert.equal(t.value, 'helo');
  t.handle('X', { name: 'x', shift: true });
  assert.equal(t.value, 'helXo');
  t.handle('', { name: 'home' });
  t.handle('', { name: 'delete' });
  assert.equal(t.value, 'elXo');
  t.handle('', { name: 'w', ctrl: true });
  assert.equal(t.value, 'elXo');
  t.handle('', { name: 'end' });
  t.handle('', { name: 'w', ctrl: true });
  assert.equal(t.value, '');
  t.insert('pasted\r\ntext\u001b[31m');
  assert.ok(!/[\u0000-\u001f]/.test(t.value), 'control characters never enter the field');
  assert.equal(t.handle('', { name: 'return' }), 'submit');
  assert.equal(t.handle('', { name: 'escape' }), 'cancel');
  assert.equal(strWidth(stripAnsi(t.render(20))), 20);
  const long = new TextInput('x'.repeat(200));
  assert.equal(strWidth(stripAnsi(long.render(20))), 20);
});

// ------------------------------------------------------------------ screens

test('main screen: header, empty-state hint, and exact frame size at many terminal sizes', async () => {
  const beam = await makeBeam('my-laptop');
  const app = makeApp(beam);
  const s = screen(app);
  assert.match(s, /beam\s+=\S{3}=\s+my-laptop/, 'badge, cat face, then the device name');
  assert.match(s, /Looking for devices on your network/);
  assert.match(s, /npx beam-share/);
  assert.match(s, /No transfers yet/);
  for (const [w, h] of [[56, 15], [60, 20], [80, 24], [100, 30], [140, 50], [200, 12 + 20]]) {
    assertFrame(app, w, h, `${w}x${h} main`);
  }
  const tiny = plain(app.render(40, 10)).join('\n');
  assert.match(tiny, /Terminal too small/);
});

test('every screen renders at exact size, including with long and wide-character names', async () => {
  const sender = await makeBeam('名前'.repeat(20)); // very long, double-width
  const receiver = await makeBeam('r'.repeat(80));
  const peer = await link(sender, receiver);
  const app = makeApp(sender);
  for (const [w, h] of [[56, 15], [80, 24], [120, 40]]) {
    assertFrame(app, w, h, 'main');
    press(app, '?');
    assertFrame(app, w, h, 'help');
    press(app, 'x'); // any key closes
    press(app, 'a');
    type(app, 'x'.repeat(300));
    assertFrame(app, w, h, 'addpeer');
    press(app, 'esc');
    assert.equal(app.selectedPeer().id, peer.id);
    press(app, 's');
    assert.equal(app.mode, 'picker');
    assertFrame(app, w, h, 'picker');
    press(app, 'esc');
    assert.equal(app.mode, 'main');
  }
});

test('peers panel lists discovered devices with address and id; empty-state disappears', async () => {
  const a = await makeBeam('alice');
  const b = await makeBeam('bob');
  const app = makeApp(a);
  await link(a, b);
  const s = screen(app);
  assert.match(s, /Peers \(1\)/);
  assert.match(s, /bob\s+127\.0\.0\.1:\d+\s+[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\s+● online/);
  assert.doesNotMatch(s, /Looking for devices/);
});

test('pressing s with no peers explains what to do instead of opening the picker', async () => {
  const app = makeApp(await makeBeam('lonely'));
  press(app, 's');
  assert.equal(app.mode, 'main');
  assert.match(screen(app), /No peer to send to yet/);
});

// ------------------------------------------------------------------- picker

function sampleTree() {
  const root = tmpdir('beam-pick-');
  fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden-dir'));
  fs.writeFileSync(path.join(root, 'alpha.txt'), 'aaaa');
  fs.writeFileSync(path.join(root, 'beta file.txt'), 'b'.repeat(2048));
  fs.writeFileSync(path.join(root, '.secret'), 's');
  fs.writeFileSync(path.join(root, 'docs', 'readme.md'), '# readme');
  fs.writeFileSync(path.join(root, 'docs', 'sub', 'deep.txt'), 'deep');
  return root;
}

function pickerFor(root, preselect = []) {
  const sent = [];
  let cancelled = false;
  const p = new FilePicker({ startDir: root, preselect, onSend: (x) => sent.push(x), onCancel: () => (cancelled = true) });
  return { p, sent, get cancelled() { return cancelled; } };
}
const names = (p) => p.entries.map((e) => e.name);
const k = (p, key) => p.handleKey(key === 'space' ? ' ' : key.length === 1 ? key : '', { name: key === 'space' ? 'space' : key });

test('picker lists folders first, hides dotfiles, and toggles hidden with "."', () => {
  const { p } = pickerFor(sampleTree());
  assert.deepEqual(names(p), ['..', 'docs', 'alpha.txt', 'beta file.txt']);
  assert.equal(p.current.name, 'docs', 'cursor starts on the first real item');
  k(p, '.');
  assert.deepEqual(names(p), ['..', '.hidden-dir', 'docs', '.secret', 'alpha.txt', 'beta file.txt']);
  k(p, '.');
  assert.deepEqual(names(p), ['..', 'docs', 'alpha.txt', 'beta file.txt']);
});

test('picker navigation: open folder, go up and land on the folder we left', () => {
  const root = sampleTree();
  const { p } = pickerFor(root);
  k(p, 'return'); // open docs
  assert.equal(p.dir, path.join(root, 'docs'));
  assert.deepEqual(names(p), ['..', 'sub', 'readme.md']);
  k(p, 'right'); // open sub (cursor starts on first item)
  assert.equal(p.dir, path.join(root, 'docs', 'sub'));
  k(p, 'left');
  assert.equal(p.dir, path.join(root, 'docs'));
  assert.equal(p.current.name, 'sub');
  k(p, 'backspace');
  assert.equal(p.dir, root);
  assert.equal(p.current.name, 'docs');
});

test('picker selection: space toggles and advances, enter on a file toggles, send gives absolute paths in order', () => {
  const root = sampleTree();
  const { p, sent } = pickerFor(root);
  k(p, 'space'); // docs
  k(p, 'space'); // alpha.txt
  assert.equal(p.cursor, 3);
  k(p, 'return'); // beta toggled on via enter (file)
  k(p, 'up');
  k(p, 'space'); // alpha off again; cursor moves on to beta
  assert.match(p.summary(), /1 file.*1 folder/);
  k(p, 's');
  assert.deepEqual(sent, [[path.join(root, 'docs'), path.join(root, 'beta file.txt')]]);
});

test('picker: with nothing selected, s sends the highlighted item; on ".." it refuses', () => {
  const root = sampleTree();
  const { p, sent } = pickerFor(root);
  k(p, 'up'); // ..
  k(p, 's');
  assert.equal(sent.length, 0);
  assert.match(p.message, /Nothing selected/);
  k(p, 'down');
  k(p, 'down'); // alpha.txt
  k(p, 's');
  assert.deepEqual(sent, [[path.join(root, 'alpha.txt')]]);
});

test('picker: "a" selects everything in the folder and again clears it', () => {
  const { p } = pickerFor(sampleTree());
  k(p, 'a');
  assert.equal(p.selected.size, 3);
  k(p, 'a');
  assert.equal(p.selected.size, 0);
});

test('picker path prompt: dropped quoted paths, folders and missing paths', () => {
  const root = sampleTree();
  const { p } = pickerFor(root);
  const submit = (text) => {
    k(p, '/');
    assert.ok(p.prompt);
    for (const c of text) p.handleKey(c, { name: c.toLowerCase() });
    p.handleKey('', { name: 'return' });
  };
  submit(`"${path.join(root, 'beta file.txt')}"`); // what a terminal pastes when you drop a file with spaces
  assert.ok(p.selected.has(path.join(root, 'beta file.txt')));
  assert.equal(p.current.name, 'beta file.txt');
  submit(path.join(root, 'docs'));
  assert.equal(p.dir, path.join(root, 'docs'));
  submit('sub');
  assert.equal(p.dir, path.join(root, 'docs', 'sub'));
  submit(path.join(root, 'nope'));
  assert.match(p.message, /Not found/);
  k(p, '/');
  p.handleKey('', { name: 'escape' });
  assert.equal(p.prompt, null);
  assert.equal(expandPath('~', root), os.homedir());
  assert.equal(expandPath('~/x', root), path.join(os.homedir(), 'x'));
});

test('picker preselect (files named on the command line) starts selected and focused', () => {
  const root = sampleTree();
  const { p } = pickerFor(root, [path.join(root, 'beta file.txt'), path.join(root, 'ghost.txt')]);
  assert.equal(p.selected.size, 1, 'vanished files are dropped');
  assert.equal(p.current.name, 'beta file.txt');
});

test('picker escape and q cancel; unreadable start dir falls back instead of crashing', () => {
  const root = sampleTree();
  const a = pickerFor(root);
  k(a.p, 'escape');
  assert.equal(a.cancelled, true);
  const b = pickerFor(root);
  b.p.handleKey('q', { name: 'q' });
  assert.equal(b.cancelled, true);
  const c = pickerFor(path.join(root, 'does-not-exist'));
  assert.ok(c.p.dir, 'fell back to a readable folder');
});

// -------------------------------------------------- full two-sided UI flows

async function twoApps(optsB = {}) {
  const alice = await makeBeam('alice');
  const bob = await makeBeam('bob', optsB);
  await link(alice, bob);
  await link(bob, alice);
  const dir = sampleTree();
  const a = makeApp(alice, { startDir: dir });
  const b = makeApp(bob);
  return { alice, bob, a, b, dir };
}

test('end to end through both UIs: pick a peer, choose a file, receiver accepts, file arrives', async () => {
  const { alice, bob, a, b, dir } = await twoApps();

  press(a, 's'); // open picker for bob
  assert.equal(a.mode, 'picker');
  assert.match(screen(a), /Send to bob/);
  assert.match(screen(a), /alpha\.txt/);
  press(a, 'down'); // cursor starts on "docs"; move to alpha.txt
  press(a, 'space');
  press(a, 's');
  assert.equal(a.mode, 'main');
  assert.equal(a.focus, 'transfers');
  assert.match(screen(a), /Sending alpha\.txt to bob/);

  await waitFor(() => b.offers.length === 1, 5000, 'offer to reach bob');
  const modal = screen(b);
  assert.match(modal, /Incoming transfer/);
  assert.match(modal, /alice wants to send you/);
  assert.match(modal, /alpha\.txt/);
  assert.match(modal, /Total: 1 file, 4 B/);
  assert.match(modal, /y\s+Accept\s+n\s+Decline/);
  assertFrame(b, 80, 24, 'offer modal');

  press(b, 'y');
  assert.equal(b.offers.length, 0);
  await waitFor(() => alice.transfers().every(settled) && bob.transfers().length && bob.transfers().every(settled), 8000, 'transfer to finish');
  assert.equal(fs.readFileSync(path.join(bob.downloadDir, 'alpha.txt'), 'utf8'), 'aaaa');
  assert.match(screen(a), /↑\s+bob\s+alpha\.txt/);
  assert.match(screen(a), /✓ 4 B in/);
  assert.match(screen(b), /↓\s+alice\s+alpha\.txt/);
  assert.match(screen(b), /✓ 4 B in .*↓/);
  assert.deepEqual(a.opened, []);
  press(b, 'o');
  assert.deepEqual(b.opened, [bob.downloadDir]);
});

test('declining from the UI tells the sender and writes nothing', async () => {
  const { alice, bob, a, b } = await twoApps();
  press(a, 's');
  press(a, 'down');
  press(a, 's'); // nothing selected: sends the highlighted alpha.txt
  await waitFor(() => b.offers.length === 1);
  press(b, 'n');
  await waitFor(() => alice.transfers().every(settled));
  assert.equal(alice.transfers()[0].status, 'rejected');
  assert.match(screen(a), /declined/);
  assert.equal(fs.readdirSync(bob.downloadDir).length, 0);
});

test('offers while typing elsewhere are not answered by stray keystrokes; a banner points to them', async () => {
  const { a, b, bob } = await twoApps();
  press(a, 's');
  press(a, 'down');
  press(a, 'space');
  press(a, 's');
  press(b, 'a'); // bob is typing an address when the offer lands
  await waitFor(() => b.offers.length === 1);
  type(b, 'yes-nnn');
  assert.equal(b.offers.length, 1, 'typing y/n into the address box must not accept or decline');
  assert.equal(b.input.value, 'yes-nnn');
  assert.match(screen(b), /1 incoming transfer waiting/);
  press(b, 'esc');
  assert.match(screen(b), /Incoming transfer/);
  press(b, 'n');
  await waitFor(() => bob.pendingOffers().length === 0);
});

test('queued offers are answered one at a time', async () => {
  const { alice, b, a } = await twoApps();
  const files = ['alpha.txt', 'beta file.txt'].map((n) => path.join(a.lastDir, n));
  for (const f of files) alice.send(alice.peers()[0].id, [f]);
  await waitFor(() => b.offers.length === 2);
  assert.match(screen(b), /\(1 more waiting\)/);
  press(b, 'y');
  assert.equal(b.offers.length, 1);
  press(b, 'n');
  assert.equal(b.offers.length, 0);
});

test('hostile file and device names cannot inject terminal escape sequences into the UI', async () => {
  const bob = await makeBeam('bob');
  const app = makeApp(bob);
  const c = await rawClient(bob);
  await writeFrame(c.sock, {
    t: 'offer', v: 1, name: '\u001b[2J\u001b]0;pwned\u0007evil',
    files: [{ p: '\u001b[31mred\u001b[0m.txt', s: 1 }, { p: 'dir\u202etxt.exe/\u001b[H.bin', s: 2 }],
  });
  await waitFor(() => app.offers.length === 1);
  const raw = app.render(100, 30).join('\n');
  // Our own styling uses ESC[...m; nothing else may appear, and no OSC / cursor movement / clear.
  const withoutSgr = raw.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/.test(withoutSgr), `unexpected control chars: ${JSON.stringify(withoutSgr.match(/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/))}`);
  c.sock.destroy();
});

test('quit asks for confirmation while transfers are running', async () => {
  const { alice, bob, a, b } = await twoApps({ autoAccept: true });
  let quit = 0;
  a.onQuit = () => quit++;
  press(a, 'q');
  assert.equal(quit, 1, 'nothing running: quits immediately');

  const big = path.join(tmpdir(), 'big.bin');
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 48; i++) fs.writeSync(fd, crypto.randomBytes(1 << 20));
  fs.closeSync(fd);
  const t = alice.send(alice.peers()[0].id, [big]);
  await waitFor(() => t.status === 'active' && t.done > 0, 5000, 'transfer to start');
  press(a, 'q');
  assert.equal(quit, 1, 'first q with a running transfer only warns');
  assert.match(screen(a), /1 transfer running - press q again/);
  press(a, 'q');
  assert.equal(quit, 2);

  // cancel from the UI: focus transfers, x
  a.focus = 'transfers';
  press(a, 'x');
  await waitFor(() => settled(t), 5000, 'cancel to take effect');
  assert.equal(t.status, 'cancelled');
  press(a, 'c');
  assert.equal(alice.transfers().length, 0, 'c clears finished transfers');
});

test('add peer by address from the UI, including errors', async () => {
  const alice = await makeBeam('alice');
  const bob = await makeBeam('bob');
  const a = makeApp(alice);
  press(a, 'a');
  assert.equal(a.mode, 'addpeer');
  assert.match(screen(a), /Connect to a device by address/);
  type(a, `127.0.0.1:${bob.port}`);
  press(a, 'enter');
  assert.equal(a.mode, 'main');
  await waitFor(() => alice.peers().length === 1, 5000, 'peer added');
  assert.match(screen(a), /bob/);
  await waitFor(() => /Added bob/.test(screen(a)));

  press(a, 'a');
  type(a, '127.0.0.1:1');
  press(a, 'enter');
  await waitFor(() => /Couldn't add 127\.0\.0\.1:1/.test(screen(a)), 8000, 'error message');
});

test('auto-accept toggle is visible in the header, even when the header is crowded', async () => {
  const app = makeApp(await makeBeam('x'.repeat(40), { downloadDir: path.join(tmpdir(), 'a-very-long-folder-name'.repeat(4)) }));
  assert.doesNotMatch(screen(app), /AUTO-ACCEPT/);
  press(app, 'A');
  assert.match(screen(app, 56, 20), /AUTO-ACCEPT/, 'badge must survive on the narrowest supported terminal');
  assert.match(screen(app), /AUTO-ACCEPT/);
  assert.match(screen(app), /Auto-accept ON/);
  press(app, 'A');
  assert.doesNotMatch(screen(app), /AUTO-ACCEPT/);
});

test('local addresses list real adapters before virtual ones', async () => {
  const os = await import('node:os');
  const { mock } = await import('node:test');
  const { localAddresses } = await import('../src/beam.js');
  const fake = (address) => [{ address, family: 'IPv4', internal: false, netmask: '255.255.255.0' }];
  const m = mock.method(os.default, 'networkInterfaces', () => ({
    'VMware Network Adapter VMnet1': fake('192.168.160.1'),
    'vEthernet (WSL)': fake('172.20.0.1'),
    'Wi-Fi': fake('10.90.70.231'),
    docker0: fake('172.17.0.1'),
    eth0: fake('192.168.1.5'),
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0' }],
  }));
  try {
    assert.deepEqual(localAddresses(), ['10.90.70.231', '192.168.1.5', '192.168.160.1', '172.20.0.1', '172.17.0.1']);
  } finally {
    m.mock.restore();
  }
});

test('a new transfer takes the highlight only if the newest was highlighted (so x never hits the wrong one)', async () => {
  const { alice, a } = await twoApps({ autoAccept: true });
  const peerId = alice.peers()[0].id;
  const file = path.join(a.lastDir, 'alpha.txt');
  const send = async () => {
    const t = alice.send(peerId, [file]);
    await waitFor(() => settled(t));
    screen(a); // a render happens between events in real use
    return t;
  };
  const t1 = await send();
  assert.equal(a.selectedTransfer().id, t1.id, 'first transfer is highlighted');
  const t2 = await send();
  assert.equal(a.selectedTransfer().id, t2.id, 'highlight follows the newest while you are on it');
  a.focus = 'transfers';
  press(a, 'down'); // move off the newest, onto t1
  assert.equal(a.selectedTransfer().id, t1.id);
  const t3 = await send();
  assert.equal(a.selectedTransfer().id, t1.id, `highlight stays put when t${t3.id} appears`);
});
