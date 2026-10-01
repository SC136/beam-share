import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRelay } from '../src/relay.js';
import { App, plain } from '../src/ui/app.js';
import { stripAnsi, strWidth } from '../src/ui/term.js';
import { cleanupAll, makeBeam, settled, tmpdir, waitFor } from './helpers.js';

const closers = [];
after(async () => {
  await cleanupAll();
  for (const c of closers.splice(0)) await c();
});

const FAST = 1 << 10;

async function relay(opts = {}) {
  const r = await startRelay({ port: 0, host: '127.0.0.1', ...opts });
  closers.push(() => r.close());
  return { ...r, url: `ws://127.0.0.1:${r.port}/` };
}

const NAMED = { enter: 'return', esc: 'escape', space: 'space', up: 'up', down: 'down', left: 'left', right: 'right', tab: 'tab', backspace: 'backspace' };
function press(app, k) {
  if (k in NAMED) app.handleKey(k === 'space' ? ' ' : '', { name: NAMED[k] });
  else app.handleKey(k, { name: k.toLowerCase(), shift: k !== k.toLowerCase() });
}
const type = (app, text) => [...text].forEach((c) => press(app, c === ' ' ? 'space' : c));
const screen = (app, w = 100, h = 30) => plain(app.render(w, h)).join('\n');

function mkApp(beam, extra = {}) {
  return new App(beam, { startDir: extra.startDir ?? tmpdir(), opener: () => true, ...extra });
}

function assertFrame(app, w, h, label) {
  const lines = app.render(w, h);
  assert.equal(lines.length, h, `${label}: height`);
  lines.forEach((l, i) => assert.equal(strWidth(stripAnsi(l)), w, `${label}: line ${i} is ${strWidth(stripAnsi(l))} wide, want ${w}`));
}

const SIZES = [[56, 15], [80, 24], [120, 40]];

// ------------------------------------------------------------------- the dialog

test('r opens the internet-room dialog; without a relay it says so and offers the right keys', async () => {
  const app = mkApp(await makeBeam('alice', { kdfCost: FAST }));
  press(app, 'r');
  assert.equal(app.mode, 'room');
  const s = screen(app);
  assert.match(s, /Internet room/);
  assert.match(s, /Share files over the internet/);
  assert.match(s, /Relay:\s+not set yet - press s to set it/);
  assert.match(s, /c\s+create room\s+j\s+join room\s+s\s+relay\s+esc\s+back/);
  press(app, 'esc');
  assert.equal(app.mode, 'main');
});

test('every room screen fits exactly at every supported terminal size', async () => {
  const r = await relay();
  const beam = await makeBeam('alice', { kdfCost: FAST, relay: r.url });
  const app = mkApp(beam);
  for (const [w, h] of SIZES) {
    press(app, 'r');
    assertFrame(app, w, h, `${w}x${h} menu`);
    press(app, 's');
    assertFrame(app, w, h, `${w}x${h} relay prompt`);
    type(app, 'x'.repeat(300)); // very long input must not break the frame
    assertFrame(app, w, h, `${w}x${h} relay prompt, long input`);
    press(app, 'esc');
    press(app, 'j');
    type(app, 'y'.repeat(300));
    assertFrame(app, w, h, `${w}x${h} code prompt`);
    press(app, 'esc');
    press(app, 'esc');
    assert.equal(app.mode, 'main');
  }
  press(app, 'r');
  press(app, 'c');
  await waitFor(() => beam.roomInfo()?.state === 'online', 5000, 'room to come up');
  for (const [w, h] of SIZES) assertFrame(app, w, h, `${w}x${h} in room`);
  press(app, 'esc');
  for (const [w, h] of SIZES) assertFrame(app, w, h, `${w}x${h} main, in room`);
});

test('create without a relay asks for one first, then creates the room and shows the code', async () => {
  const r = await relay();
  const beam = await makeBeam('alice', { kdfCost: FAST });
  const app = mkApp(beam);
  press(app, 'r');
  press(app, 'c');
  assert.equal(app.roomUi.step, 'relay', 'asked for the relay before creating');
  assert.match(screen(app), /Relay server/);
  assert.match(screen(app), /Address:/);

  press(app, 'enter'); // empty: refused with a message, stays on the prompt
  await waitFor(() => /enter the relay address/.test(screen(app)), 3000, 'validation message');
  assert.equal(app.roomUi.step, 'relay');

  type(app, `127.0.0.1:${r.port}`);
  press(app, 'enter');
  await waitFor(() => beam.roomInfo()?.state === 'online', 8000, 'room to be created');
  const s = screen(app);
  assert.match(s, /online\s+0 other devices here/);
  assert.match(s, /Code:\s+[a-z]+(-[a-z]+){4}\b/);
  assert.match(s, new RegExp(`Relay:\\s+${r.url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(s, /Anyone with this code can join/);
  assert.match(s, /You still approve every transfer/);
  assert.match(s, /l\s+leave room/);
  assert.doesNotMatch(s, /guessable/, 'a generated code is strong');
  assert.equal(beam.relayUrl, r.url);
});

test('the header and peers panel show the room state', async () => {
  const r = await relay();
  const beam = await makeBeam('alice', { kdfCost: FAST, relay: r.url });
  const app = mkApp(beam);
  assert.doesNotMatch(screen(app), /ROOM/);
  assert.match(screen(app), /Other network\? Press r for an internet room\./);
  press(app, 'r');
  press(app, 'c');
  await waitFor(() => beam.roomInfo()?.state === 'online', 5000);
  press(app, 'esc');
  const s = screen(app);
  assert.match(s, /beam\s+=\S{3}=\s+alice\s+ROOM/, 'badge sits right after the name');
  assert.match(s, /Peers \(0\) - room online/);
  assert.match(s, /Room open - waiting for friends \(press r for the code\)\./);
  assert.doesNotMatch(s, /Other network\?/, 'no need to advertise it once you are in a room');
});

test('join with a code: bad input shows an error, a good code connects', async () => {
  const r = await relay();
  const beam = await makeBeam('bob', { kdfCost: FAST, relay: r.url });
  const app = mkApp(beam);
  press(app, 'r');
  press(app, 'j');
  assert.match(screen(app), /Join a room/);
  type(app, 'tiny');
  press(app, 'enter');
  await waitFor(() => /at least 8 characters/.test(screen(app)), 3000, 'error for a too-short code');
  assert.equal(beam.roomInfo(), null);

  press(app, 'j');
  type(app, 'maple tiger coral river pearl'); // spaces are fine: normalised to dashes
  press(app, 'enter');
  await waitFor(() => beam.roomInfo()?.state === 'online', 5000);
  assert.match(screen(app), /Code:\s+maple-tiger-coral-river-pearl/);
});

test('a weak code is accepted but flagged; leaving works and clears everything', async () => {
  const r = await relay();
  const beam = await makeBeam('alice', { kdfCost: FAST, relay: r.url });
  const app = mkApp(beam);
  press(app, 'r');
  press(app, 'j');
  type(app, 'password123');
  press(app, 'enter');
  await waitFor(() => beam.roomInfo()?.state === 'online', 5000);
  assert.match(screen(app), /guessable/);
  press(app, 'l');
  assert.equal(beam.roomInfo(), null);
  assert.match(screen(app), /Share files over the internet/, 'back to the start of the dialog');
  press(app, 'esc');
  assert.doesNotMatch(screen(app), /ROOM/);
  assert.match(screen(app), /Left the room/);
});

test('while in a room, c/j/s do nothing (leave first)', async () => {
  const r = await relay();
  const beam = await makeBeam('alice', { kdfCost: FAST, relay: r.url });
  const app = mkApp(beam);
  press(app, 'r');
  press(app, 'c');
  await waitFor(() => beam.roomInfo()?.state === 'online', 5000);
  const code = beam.roomInfo().code;
  for (const k of ['c', 'j', 's']) press(app, k);
  assert.equal(app.roomUi.step, 'menu');
  assert.equal(beam.roomInfo().code, code, 'still in the same room');
});

test('an unreachable relay shows a clear error in the dialog', async () => {
  const beam = await makeBeam('alice', { kdfCost: FAST, relay: 'ws://127.0.0.1:1' });
  const app = mkApp(beam);
  press(app, 'r');
  press(app, 'c');
  await waitFor(() => /refused the connection/.test(screen(app)), 8000, 'connection error');
  assert.equal(beam.roomInfo(), null);
  assert.match(screen(app), /Couldn't join the room/);
});

test('if the relay goes away the dialog says offline and retrying', async () => {
  const r = await startRelay({ port: 0, host: '127.0.0.1' });
  const beam = await makeBeam('alice', { kdfCost: FAST, relay: `ws://127.0.0.1:${r.port}/` });
  const app = mkApp(beam);
  press(app, 'r');
  press(app, 'c');
  await waitFor(() => beam.roomInfo()?.state === 'online', 5000);
  await r.close();
  await waitFor(() => beam.roomInfo()?.state === 'offline', 8000, 'offline state');
  assert.match(screen(app), /offline - retrying in \d+s/);
  assert.match(screen(app, 100, 30).split('\n')[0], /room\.\.\./, 'header badge is in its warning form');
  assertFrame(app, 56, 15, 'offline dialog');
});

test('help documents the room key and the security note is no longer clipped', async () => {
  const app = mkApp(await makeBeam('alice', { kdfCost: FAST }));
  press(app, '?');
  const s = screen(app, 80, 24);
  assert.match(s, /r\s+internet room: share with friends on other networks/);
  assert.match(s, /Everything is end-to-end encrypted \(TLS 1\.3\)\. Compare the id in an\s/);
  assert.match(s, /incoming prompt with the one in the sender's header before accepting\./);
  assert.match(s, /q \/ ctrl\+c\s+quit/, 'the bottom of the key list is still visible at 24 rows');
  assertFrame(app, 80, 24, 'help');
});

// ---------------------------------------------------- two people, two UIs, one room

test('two UIs: one creates a room, the other types the code, they see each other and send a file', async () => {
  const r = await relay();
  const alice = await makeBeam('alice', { kdfCost: FAST, relay: r.url });
  const bob = await makeBeam('bob', { kdfCost: FAST, relay: r.url });
  const a = mkApp(alice, { startDir: tmpdir() });
  const b = mkApp(bob);

  press(a, 'r');
  press(a, 'c');
  await waitFor(() => alice.roomInfo()?.state === 'online', 5000);
  const code = alice.roomInfo().code;
  press(a, 'esc');

  press(b, 'r');
  press(b, 'j');
  type(b, code);
  press(b, 'enter');
  await waitFor(() => bob.roomInfo()?.state === 'online', 5000);
  press(b, 'esc');

  await waitFor(() => alice.peers().some((p) => p.via) && bob.peers().some((p) => p.via), 8000, 'mutual discovery');
  assert.match(screen(a), /bob\s+via relay\s+[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\s+● online/);
  assert.match(screen(b), /alice\s+via relay/);
  assert.match(screen(a), /Peers \(1\) - room online/);

  // alice sends a file to bob, who accepts: exactly as on a LAN
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'postcard.txt'), 'greetings from far away');
  a.lastDir = dir;
  press(a, 's');
  assert.equal(a.mode, 'picker');
  press(a, 'space');
  press(a, 's');
  await waitFor(() => b.offers.length === 1, 8000, 'offer to reach bob');
  const modal = screen(b);
  assert.match(modal, /alice wants to send you:/);
  assert.match(modal, /via relay - id [0-9a-f]{4}-/);
  assert.doesNotMatch(modal, /not in your peer list/, 'room members are known peers');
  press(b, 'y');
  await waitFor(() => alice.transfers().every(settled) && bob.transfers().length && bob.transfers().every(settled), 10_000, 'transfer');
  assert.equal(fs.readFileSync(path.join(bob.downloadDir, 'postcard.txt'), 'utf8'), 'greetings from far away');
  await waitFor(() => /meow! postcard\.txt delivered to bob/.test(screen(a)), 3000, 'the cat to announce the delivery');

  // and when alice leaves, bob's list empties
  press(a, 'r');
  press(a, 'l');
  await waitFor(() => bob.peers().length === 0, 5000, 'bob to see alice leave');
  assert.match(screen(b), /Looking for devices/);
});
