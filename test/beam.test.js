import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encodeFrame, write, writeFrame } from '../src/protocol.js';
import {
  autoRespond, cleanupAll, hashFile, link, listTree, makeBeam, rawClient, settled, tmpdir, waitFor, writeRandomFile,
} from './helpers.js';

after(cleanupAll);

async function pairUp(opts = {}) {
  const sender = await makeBeam('sender');
  const receiver = await makeBeam('receiver', opts);
  const peer = await link(sender, receiver);
  return { sender, receiver, peer };
}

test('addPeer learns name and identity over a real TLS connection', async () => {
  const { sender, receiver, peer } = await pairUp();
  assert.equal(peer.name, 'receiver');
  assert.equal(peer.id, receiver.fingerprint);
  assert.equal(sender.peers().length, 1);
  assert.throws(() => sender.send('nonexistent', ['x']), /no longer available/);
  await assert.rejects(sender.addPeer(`127.0.0.1:${sender.port}`), /this device/);
  await assert.rejects(sender.addPeer('127.0.0.1:1'), /refused|unreachable|timed out/);
});

test('sends a single file byte-for-byte, then both sides report done', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  const src = path.join(tmpdir(), 'hello.bin');
  const sum = writeRandomFile(src, 3 * 1024 * 1024 + 123);

  const t = sender.send(peer.id, [src]);
  await waitFor(() => settled(t), 10_000, 'sender to finish');
  assert.equal(t.status, 'done', t.error);
  assert.equal(t.done, t.total);

  const got = path.join(receiver.downloadDir, 'hello.bin');
  assert.equal(hashFile(got), sum);
  const rt = receiver.transfers()[0];
  await waitFor(() => settled(rt));
  assert.equal(rt.status, 'done');
  assert.equal(rt.dir, 'recv');
  assert.equal(rt.done, 3 * 1024 * 1024 + 123);
  assert.deepEqual(listTree(receiver.downloadDir), ['hello.bin'], 'no .part files left behind');
});

test('sends a folder tree with nested dirs, empty dirs, empty files and unicode names', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  const root = path.join(tmpdir(), 'project');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty-dir'));
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'データ ✓.txt'), 'unicode');
  fs.writeFileSync(path.join(root, 'zero.bin'), '');

  const t = sender.send(peer.id, [root]);
  await waitFor(() => settled(t));
  assert.equal(t.status, 'done', t.error);
  assert.equal(t.files, 4);
  assert.deepEqual(listTree(receiver.downloadDir), [
    'project/README.md',
    'project/empty-dir/',
    'project/src/deep/データ ✓.txt',
    'project/src/main.js',
    'project/zero.bin',
  ]);
  assert.equal(fs.readFileSync(path.join(receiver.downloadDir, 'project/src/main.js'), 'utf8'), 'console.log(1)\n');
});

test('never overwrites: an existing file makes the incoming one "name (1).ext"', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  fs.writeFileSync(path.join(receiver.downloadDir, 'notes.txt'), 'ORIGINAL');
  const src = path.join(tmpdir(), 'notes.txt');
  fs.writeFileSync(src, 'NEW');
  for (let i = 0; i < 2; i++) {
    const t = sender.send(peer.id, [src]);
    await waitFor(() => settled(t));
    assert.equal(t.status, 'done', t.error);
  }
  assert.equal(fs.readFileSync(path.join(receiver.downloadDir, 'notes.txt'), 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(path.join(receiver.downloadDir, 'notes (1).txt'), 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(path.join(receiver.downloadDir, 'notes (2).txt'), 'utf8'), 'NEW');
});

test('preserves modification time', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  const src = path.join(tmpdir(), 'old.txt');
  fs.writeFileSync(src, 'x');
  const when = new Date('2020-02-02T10:00:00Z');
  fs.utimesSync(src, when, when);
  const t = sender.send(peer.id, [src]);
  await waitFor(() => settled(t));
  assert.equal(t.status, 'done', t.error);
  const m = fs.statSync(path.join(receiver.downloadDir, 'old.txt')).mtime;
  assert.ok(Math.abs(m - when) < 2000, `mtime ${m.toISOString()}`);
});

test('receiver can decline; sender is told, nothing is written', async () => {
  const { sender, receiver, peer } = await pairUp();
  receiver.on('offer', (o) => {
    assert.equal(o.peerName, 'sender');
    assert.equal(o.count, 1);
    assert.equal(o.total, 5);
    assert.equal(o.known, false, 'sender never announced itself to the receiver');
    assert.equal(o.fingerprint, sender.fingerprint);
    receiver.respond(o.id, false, 'not now');
  });
  const src = path.join(tmpdir(), 'a.txt');
  fs.writeFileSync(src, 'hello');
  const t = sender.send(peer.id, [src]);
  await waitFor(() => settled(t));
  assert.equal(t.status, 'rejected');
  assert.equal(t.error, 'not now');
  assert.deepEqual(listTree(receiver.downloadDir), []);
  assert.equal(receiver.transfers().length, 0);
});

test('autoAccept skips the prompt entirely', async () => {
  const { sender, receiver, peer } = await pairUp({ autoAccept: true });
  receiver.on('offer', () => assert.fail('should not prompt'));
  const src = path.join(tmpdir(), 'auto.txt');
  fs.writeFileSync(src, 'auto');
  const t = sender.send(peer.id, [src]);
  await waitFor(() => settled(t));
  assert.equal(t.status, 'done', t.error);
  assert.equal(fs.readFileSync(path.join(receiver.downloadDir, 'auto.txt'), 'utf8'), 'auto');
});

test('sender cancelling while the offer is pending withdraws the prompt', async () => {
  const { sender, receiver, peer } = await pairUp();
  let offered, gone;
  receiver.on('offer', (o) => (offered = o));
  receiver.on('offer-gone', (id) => (gone = id));
  const src = path.join(tmpdir(), 'x.txt');
  fs.writeFileSync(src, 'x');
  const t = sender.send(peer.id, [src]);
  await waitFor(() => offered, 5000, 'offer to arrive');
  assert.equal(receiver.pendingOffers().length, 1);
  sender.cancel(t.id);
  await waitFor(() => gone === offered.id, 5000, 'offer to be withdrawn');
  assert.equal(t.status, 'cancelled');
  assert.equal(receiver.pendingOffers().length, 0);
});

test('receiver cancelling mid-transfer stops the sender with a reason and removes partial files', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  const src = path.join(tmpdir(), 'big.bin');
  writeRandomFile(src, 96 * 1024 * 1024);
  const t = sender.send(peer.id, [src]);
  const rt = await waitFor(() => receiver.transfers().find((x) => x.done > 1024 * 1024), 10_000, 'receiving to start');
  receiver.cancel(rt.id);
  await waitFor(() => settled(t) && settled(rt), 10_000, 'both sides to settle');
  assert.equal(rt.status, 'cancelled');
  assert.equal(t.status, 'cancelled', 'a deliberate cancel by the receiver is not a failure');
  assert.match(t.error, /cancelled by receiver/);
  assert.ok(t.done < t.total, 'sender stopped early');
  assert.deepEqual(listTree(receiver.downloadDir), [], 'partial file removed');
});

test('sender cancelling mid-transfer stops the receiver and removes partial files', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  const src = path.join(tmpdir(), 'big.bin');
  writeRandomFile(src, 96 * 1024 * 1024);
  const t = sender.send(peer.id, [src]);
  await waitFor(() => t.done > 1024 * 1024, 10_000, 'sending to start');
  sender.cancel(t.id);
  const rt = await waitFor(() => receiver.transfers()[0]);
  await waitFor(() => settled(t) && settled(rt), 10_000, 'both sides to settle');
  assert.equal(t.status, 'cancelled');
  assert.equal(rt.status, 'failed');
  assert.match(rt.error, /sender cancelled|connection/);
  assert.deepEqual(listTree(receiver.downloadDir), []);
});

test('refuses to send to a device whose certificate does not match the announced identity', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  // Forge the peer table: same address/port, but pretend it announced a different identity.
  const fake = crypto.randomBytes(32).toString('hex');
  sender._peers.set(fake, { ...peer, id: fake });
  const src = path.join(tmpdir(), 'secret.txt');
  fs.writeFileSync(src, 'secret');
  const t = sender.send(fake, [src]);
  await waitFor(() => settled(t));
  assert.equal(t.status, 'failed');
  assert.match(t.error, /identity mismatch/);
  assert.deepEqual(listTree(receiver.downloadDir), [], 'no data was sent');
});

test('reports a clear error when the peer has gone away', async () => {
  const { sender, receiver, peer } = await pairUp();
  await receiver.stop();
  const src = path.join(tmpdir(), 'x.txt');
  fs.writeFileSync(src, 'x');
  const t = sender.send(peer.id, [src]);
  await waitFor(() => settled(t));
  assert.equal(t.status, 'failed');
  assert.match(t.error, /refused|unreachable|timed out|closed|reset/i);
});

test('transfers several files concurrently to the same receiver', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  const dir = tmpdir();
  const sums = {};
  for (let i = 0; i < 4; i++) sums[`f${i}.bin`] = writeRandomFile(path.join(dir, `f${i}.bin`), 5 * 1024 * 1024 + i);
  const ts = Object.keys(sums).map((n) => sender.send(peer.id, [path.join(dir, n)]));
  await waitFor(() => ts.every(settled), 20_000, 'all transfers');
  for (const t of ts) assert.equal(t.status, 'done', t.error);
  for (const [n, sum] of Object.entries(sums)) assert.equal(hashFile(path.join(receiver.downloadDir, n)), sum);
});

test('throughput on loopback (informational) and large-file integrity', async () => {
  const { sender, receiver, peer } = await pairUp();
  autoRespond(receiver);
  const src = path.join(tmpdir(), 'large.bin');
  const size = 256 * 1024 * 1024;
  const sum = writeRandomFile(src, size);
  const t0 = Date.now();
  const t = sender.send(peer.id, [src]);
  await waitFor(() => settled(t), 60_000, 'large transfer');
  const secs = (Date.now() - t0) / 1000;
  assert.equal(t.status, 'done', t.error);
  assert.equal(hashFile(path.join(receiver.downloadDir, 'large.bin')), sum);
  console.log(`# 256 MiB over loopback TLS in ${secs.toFixed(2)}s = ${(size / 1e6 / secs).toFixed(0)} MB/s`);
});

// ---------------------------------------------------------------- hostile peers

async function offerRaw(receiver, files, opts = {}) {
  const c = await rawClient(receiver);
  await writeFrame(c.sock, { t: 'offer', v: 1, name: 'mallory', files });
  const reply = await c.reader.readFrame();
  if (reply.ok && opts.keepOpen) return { ...c, reply };
  c.sock.destroy();
  return { ...c, reply };
}

test('a malicious offer cannot write outside the download folder', async () => {
  const receiver = await makeBeam('victim', { autoAccept: true });
  const outside = path.join(path.dirname(receiver.downloadDir), 'pwned.txt');
  for (const p of ['../pwned.txt', '../../pwned.txt', 'a/../../pwned.txt', '/abs/pwned.txt', '..', 'x//y', '']) {
    const { reply } = await offerRaw(receiver, [{ p, s: 1 }]);
    assert.equal(reply.ok, false, `offer with path ${JSON.stringify(p)} must be rejected`);
    assert.match(reply.reason, /unsafe path/);
  }
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(listTree(receiver.downloadDir), []);
});

test('a malicious offer with Windows-special or control-character names is neutralised, not rejected', async () => {
  const receiver = await makeBeam('victim', { autoAccept: true });
  const c = await rawClient(receiver);
  const name = 'we\u001b[2Jird.txt';
  await writeFrame(c.sock, { t: 'offer', v: 1, name: 'm', files: [{ p: name, s: 2 }] });
  assert.equal((await c.reader.readFrame()).ok, true);
  await write(c.sock, Buffer.from('hi'));
  await write(c.sock, crypto.createHash('sha256').update('hi').digest());
  assert.equal((await c.reader.readFrame()).ok, true);
  c.sock.destroy();
  const tree = listTree(receiver.downloadDir);
  assert.equal(tree.length, 1);
  assert.ok(!/[\u0000-\u001f]/.test(tree[0]), `no control characters in ${JSON.stringify(tree[0])}`);
});

test('malformed sizes, counts and message types are rejected without crashing the receiver', async () => {
  const receiver = await makeBeam('victim', { autoAccept: true });
  const bad = [
    [{ p: 'a', s: -1 }],
    [{ p: 'a', s: 1.5 }],
    [{ p: 'a', s: '10' }],
    [{ p: 'a', s: Number.MAX_SAFE_INTEGER }, { p: 'b', s: Number.MAX_SAFE_INTEGER }],
    [{ p: 'a' }],
    [null],
    ['a'],
    [],
  ];
  for (const files of bad) {
    const { reply } = await offerRaw(receiver, files);
    assert.equal(reply.ok, false, JSON.stringify(files));
  }
  // wrong protocol version
  const c = await rawClient(receiver);
  await writeFrame(c.sock, { t: 'offer', v: 99, name: 'm', files: [{ p: 'a', s: 1 }] });
  const r = await c.reader.readFrame();
  assert.equal(r.ok, false);
  assert.match(r.reason, /version/);
  c.sock.destroy();
  // garbage, unknown type, oversized length prefix
  for (const raw of [Buffer.from('GET / HTTP/1.1\r\n\r\n'), encodeFrame({ t: 'bogus' }), Buffer.from([0xff, 0xff, 0xff, 0xff])]) {
    const g = await rawClient(receiver);
    g.sock.write(raw);
    await waitFor(() => g.sock.destroyed || g.reader.ended, 3000, 'receiver to drop the connection');
    g.sock.destroy();
  }
  // still alive and well afterwards
  const { reply } = await offerRaw(receiver, [{ p: 'fine.txt', s: 0 }]);
  assert.equal(reply.ok, true);
});

test('a corrupted file is detected via checksum and discarded', async () => {
  const receiver = await makeBeam('victim', { autoAccept: true });
  const c = await rawClient(receiver);
  await writeFrame(c.sock, { t: 'offer', v: 1, name: 'm', files: [{ p: 'good.txt', s: 5 }, { p: 'tampered.txt', s: 5 }] });
  assert.equal((await c.reader.readFrame()).ok, true);
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  await write(c.sock, Buffer.from('12345'));
  await write(c.sock, h('12345'));
  await write(c.sock, Buffer.from('abcde'));
  await write(c.sock, h('abcdX')); // trailer for different content
  const result = await c.reader.readFrame();
  assert.equal(result.ok, false);
  assert.match(result.error, /checksum mismatch/);
  c.sock.destroy();
  await waitFor(() => receiver.transfers()[0] && settled(receiver.transfers()[0]));
  assert.deepEqual(listTree(receiver.downloadDir), ['good.txt'], 'tampered file and its .part are gone, earlier file kept');
});

test('a client that connects and stays silent is dropped, and pending offers are capped', async () => {
  const receiver = await makeBeam('victim'); // no auto-accept: offers stay pending
  const held = [];
  let rejected = 0;
  for (let i = 0; i < 24; i++) {
    const c = await rawClient(receiver);
    await writeFrame(c.sock, { t: 'offer', v: 1, name: `m${i}`, files: [{ p: 'f', s: 1 }] });
    held.push(c);
  }
  await waitFor(() => held.filter((c) => c.reader.ended).length >= 4, 5000, 'excess offers to be turned away');
  for (const c of held) if (c.reader.ended) rejected++;
  assert.ok(rejected >= 4, `expected the 4+ excess offers to be rejected, got ${rejected}`);
  assert.equal(receiver.pendingOffers().length, 20);
  for (const c of held) c.sock.destroy();
  await waitFor(() => receiver.pendingOffers().length === 0, 5000, 'withdrawn offers to clear');
});
