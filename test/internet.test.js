import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { loadOrCreateIdentity } from '../src/identity.js';
import { startRelay } from '../src/relay.js';
import { writeFrame } from '../src/protocol.js';
import { generateCode } from '../src/room.js';
import {
  autoRespond, cleanupAll, hashFile, link, listTree, makeBeam, settled, tmpdir, waitFor, writeRandomFile,
} from './helpers.js';

after(cleanupAll);

const FAST = 1 << 10; // scrypt cost: real code uses 2^15, tests don't need to wait for it

async function relay(opts = {}) {
  const r = await startRelay({ port: 0, host: '127.0.0.1', ...opts });
  closers.push(() => r.close());
  return { ...r, url: `ws://127.0.0.1:${r.port}/` };
}
const closers = [];
after(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function device(name, r, extra = {}) {
  return makeBeam(name, { relay: r.url, kdfCost: FAST, ...extra });
}

const seesVia = (beam, name) => beam.peers().find((p) => p.name === name && p.via);

// ------------------------------------------------------------------ the happy path

test('two devices that enter the same code see each other, with no LAN contact at all', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  await alice.joinRoom(code);
  assert.equal(alice.roomInfo().state, 'online');
  await bob.joinRoom(code);

  await waitFor(() => seesVia(alice, 'bob') && seesVia(bob, 'alice'), 8000, 'mutual discovery through the relay');
  const bobAsSeenByAlice = seesVia(alice, 'bob');
  assert.equal(bobAsSeenByAlice.id, bob.fingerprint, 'identity is the certificate fingerprint');
  assert.equal(bobAsSeenByAlice.address, null, 'known only through the room');
  assert.equal(bobAsSeenByAlice.online, true);
  assert.equal(alice.roomInfo().members, 1);
  assert.equal(alice.roomInfo().strength, 'strong');
  assert.equal(alice.info().room.code, code);
});

test('a file travels through the relay byte for byte, in both directions', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  autoRespond(alice);
  autoRespond(bob);
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await waitFor(() => seesVia(alice, 'bob') && seesVia(bob, 'alice'), 8000, 'discovery');

  const src = path.join(tmpdir(), 'over-the-internet.bin');
  const sum = writeRandomFile(src, 5 * 1024 * 1024 + 321);
  const t = alice.send(seesVia(alice, 'bob').id, [src]);
  await waitFor(() => settled(t), 20_000, 'upload');
  assert.equal(t.status, 'done', t.error);
  assert.equal(hashFile(path.join(bob.downloadDir, 'over-the-internet.bin')), sum);

  // and the other way round: bob learned alice when she said hello, so he can reply
  const back = path.join(tmpdir(), 'reply.txt');
  fs.writeFileSync(back, 'got it, thanks');
  const t2 = bob.send(seesVia(bob, 'alice').id, [back]);
  await waitFor(() => settled(t2), 20_000, 'reply');
  assert.equal(t2.status, 'done', t2.error);
  assert.equal(fs.readFileSync(path.join(alice.downloadDir, 'reply.txt'), 'utf8'), 'got it, thanks');
  assert.deepEqual(listTree(bob.downloadDir), ['over-the-internet.bin']);
  await waitFor(() => r.stats().pipes === 0, 5000, 'relay to release the pipes');
});

test('the receiver is asked first, sees the relay route, and can decline', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await waitFor(() => seesVia(alice, 'bob'), 8000);
  let seen;
  bob.on('offer', (o) => {
    seen = o;
    bob.respond(o.id, false, 'not now');
  });
  const src = path.join(tmpdir(), 'x.txt');
  fs.writeFileSync(src, 'hello');
  const t = alice.send(seesVia(alice, 'bob').id, [src]);
  await waitFor(() => settled(t), 10_000);
  assert.equal(t.status, 'rejected');
  assert.equal(t.error, 'not now');
  assert.equal(seen.address, 'via relay');
  assert.equal(seen.fingerprint, alice.fingerprint);
  assert.equal(seen.known, true, 'a room member who said hello is a known peer');
  assert.deepEqual(listTree(bob.downloadDir), []);
});

test('three devices in one room all see each other, and a late joiner can send to the first', async () => {
  const r = await relay();
  const code = generateCode();
  const [a, b, c] = [await device('a-dev', r), await device('b-dev', r), await device('c-dev', r)];
  for (const d of [a, b, c]) autoRespond(d);
  await a.joinRoom(code);
  await b.joinRoom(code);
  await waitFor(() => seesVia(a, 'b-dev') && seesVia(b, 'a-dev'), 8000);
  await c.joinRoom(code); // joins last
  await waitFor(() => [a, b, c].every((d) => d.peers().filter((p) => p.via).length === 2), 10_000, 'all three to see both others');
  const src = path.join(tmpdir(), 'from-c.txt');
  fs.writeFileSync(src, 'c says hi');
  const t = c.send(seesVia(c, 'a-dev').id, [src]);
  await waitFor(() => settled(t), 10_000);
  assert.equal(t.status, 'done', t.error);
  assert.equal(fs.readFileSync(path.join(a.downloadDir, 'from-c.txt'), 'utf8'), 'c says hi');
  assert.equal(r.stats().members, 3);
});

test('devices that use different codes never see each other', async () => {
  const r = await relay();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  await alice.joinRoom(generateCode());
  await bob.joinRoom(generateCode());
  await new Promise((res) => setTimeout(res, 800));
  assert.equal(alice.peers().length, 0);
  assert.equal(bob.peers().length, 0);
  assert.equal(r.stats().rooms, 2);
});

test('a big file through the relay keeps its integrity (throughput is informational)', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  autoRespond(bob);
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await waitFor(() => seesVia(alice, 'bob'), 8000);
  const src = path.join(tmpdir(), 'big.bin');
  const size = 96 * 1024 * 1024;
  const sum = writeRandomFile(src, size);
  const t0 = Date.now();
  const t = alice.send(seesVia(alice, 'bob').id, [src]);
  await waitFor(() => settled(t), 90_000, 'big transfer');
  const secs = (Date.now() - t0) / 1000;
  assert.equal(t.status, 'done', t.error);
  assert.equal(hashFile(path.join(bob.downloadDir, 'big.bin')), sum);
  console.log(`# 96 MiB through the relay in ${secs.toFixed(2)}s = ${(size / 1e6 / secs).toFixed(0)} MB/s`);
});

// ------------------------------------------------------------------- cancel, leave, reconnect

test('either side can cancel a transfer that goes through the relay, and nothing is left behind', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  autoRespond(bob);
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await waitFor(() => seesVia(alice, 'bob'), 8000);
  const src = path.join(tmpdir(), 'big.bin');
  writeRandomFile(src, 96 * 1024 * 1024);

  // receiver cancels
  let t = alice.send(seesVia(alice, 'bob').id, [src]);
  let rt = await waitFor(() => bob.transfers().find((x) => x.done > 1024 * 1024), 15_000, 'receiving to start');
  bob.cancel(rt.id);
  await waitFor(() => settled(t) && settled(rt), 15_000, 'both to settle');
  assert.equal(rt.status, 'cancelled');
  assert.equal(t.status, 'cancelled');
  assert.match(t.error, /cancelled by receiver/);
  assert.deepEqual(listTree(bob.downloadDir), []);

  // sender cancels
  t = alice.send(seesVia(alice, 'bob').id, [src]);
  await waitFor(() => t.done > 1024 * 1024, 15_000, 'sending to start');
  alice.cancel(t.id);
  rt = await waitFor(() => bob.transfers().find((x) => x.id !== rt.id));
  await waitFor(() => settled(t) && settled(rt), 15_000);
  assert.equal(t.status, 'cancelled');
  assert.equal(rt.status, 'failed');
  assert.deepEqual(listTree(bob.downloadDir), []);
  await waitFor(() => r.stats().pipes === 0, 5000, 'pipes released');
});

test('leaving a room removes the peers; the other side notices; rejoining a new room works', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await waitFor(() => seesVia(alice, 'bob') && seesVia(bob, 'alice'), 8000);

  bob.leaveRoom();
  assert.equal(bob.roomInfo(), null);
  assert.equal(bob.peers().length, 0);
  await waitFor(() => alice.peers().length === 0, 5000, 'alice to notice bob leaving');

  const code2 = generateCode();
  await alice.joinRoom(code2); // switching rooms leaves the old one
  await bob.joinRoom(code2);
  await waitFor(() => seesVia(alice, 'bob'), 8000);
  assert.equal(alice.roomInfo().code, code2);
});

test('if the relay goes away the room reconnects by itself and peers come back', async () => {
  const first = await startRelay({ port: 0, host: '127.0.0.1' });
  const port = first.port;
  const url = `ws://127.0.0.1:${port}/`;
  const code = generateCode();
  const alice = await makeBeam('alice', { relay: url, kdfCost: FAST });
  const bob = await makeBeam('bob', { relay: url, kdfCost: FAST });
  autoRespond(bob);
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await waitFor(() => seesVia(alice, 'bob') && seesVia(bob, 'alice'), 8000);

  await first.close();
  await waitFor(() => alice.roomInfo().state === 'offline' && bob.roomInfo().state === 'offline', 8000, 'both to notice');
  assert.equal(alice.peers().length, 0, 'peers known only through the room disappear while offline');
  assert.ok(alice.roomInfo().retryAt > Date.now() - 1000, 'a retry is scheduled');

  const second = await startRelay({ port, host: '127.0.0.1' });
  closers.push(() => second.close());
  await waitFor(() => alice.roomInfo().state === 'online' && bob.roomInfo().state === 'online', 20_000, 'both to reconnect');
  await waitFor(() => seesVia(alice, 'bob') && seesVia(bob, 'alice'), 10_000, 'peers to reappear');

  const src = path.join(tmpdir(), 'after.txt');
  fs.writeFileSync(src, 'back online');
  const t = alice.send(seesVia(alice, 'bob').id, [src]);
  await waitFor(() => settled(t), 10_000);
  assert.equal(t.status, 'done', t.error);
});

test('a device on the LAN is reached directly, and the relay is the fallback if that fails', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  const offers = [];
  bob.on('offer', (o) => (offers.push(o), bob.respond(o.id, true)));
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await link(alice, bob); // alice also knows bob by LAN address
  await waitFor(() => seesVia(alice, 'bob'), 8000);
  const peer = alice.peers().find((p) => p.name === 'bob');
  assert.ok(peer.address && peer.via, 'reachable both ways');

  const src = path.join(tmpdir(), 'x.txt');
  fs.writeFileSync(src, 'x');
  let t = alice.send(peer.id, [src]);
  await waitFor(() => settled(t), 10_000);
  assert.equal(t.status, 'done', t.error);
  assert.notEqual(offers[0].address, 'via relay', 'LAN is preferred when available');

  alice._peers.get(peer.id).port = 1; // the LAN address stops working
  t = alice.send(peer.id, [src]);
  await waitFor(() => settled(t), 15_000);
  assert.equal(t.status, 'done', t.error);
  assert.equal(offers[1].address, 'via relay', 'fell back to the relay');
});

// ----------------------------------------------------------------- relay access & settings

test('a relay token is honoured: wrong or missing is refused with a clear message', async () => {
  const r = await relay({ token: 'hunter2' });
  const code = generateCode();
  const nope = await device('nope', r);
  await assert.rejects(nope.joinRoom(code), /wrong relay token/);
  assert.equal(nope.room, null, 'a failed join leaves no half-open room');
  const wrong = await device('wrong', r, { relayToken: 'nope' });
  await assert.rejects(wrong.joinRoom(code), /wrong relay token/);
  const alice = await device('alice', r, { relayToken: 'hunter2' });
  const bob = await device('bob', r, { relayToken: 'hunter2' });
  await alice.joinRoom(code);
  await bob.joinRoom(code);
  await waitFor(() => seesVia(alice, 'bob'), 8000);
});

test('joining fails clearly with no relay, a bad code, or an unreachable relay', async () => {
  const noRelay = await makeBeam('x', { kdfCost: FAST });
  await assert.rejects(noRelay.joinRoom(generateCode()), /no relay server set/);
  const r = await relay();
  const d = await device('d', r);
  await assert.rejects(d.joinRoom('short'), /at least 8 characters/);
  const dead = await makeBeam('dead', { relay: 'ws://127.0.0.1:1', kdfCost: FAST });
  await assert.rejects(dead.joinRoom(generateCode()), /refused the connection/);
  assert.equal(dead.room, null);
});

test('the chosen relay is remembered in the config folder across restarts', async () => {
  const configDir = tmpdir('beam-cfg-');
  const a = await makeBeam('a', { configDir, kdfCost: FAST });
  assert.equal(a.relayUrl, null);
  assert.equal(await a.setRelay('relay.example.com'), 'wss://relay.example.com/');
  await a.stop();
  const b = await makeBeam('b', { configDir, kdfCost: FAST });
  assert.equal(b.relayUrl, 'wss://relay.example.com/');
  const c = await makeBeam('c', { configDir, kdfCost: FAST, relay: 'ws://127.0.0.1:9999' });
  assert.equal(c.relayUrl, 'ws://127.0.0.1:9999/', 'an explicit --relay wins over the saved one');
  await assert.rejects(b.setRelay('   '), /enter the relay address/);
});

test('weak codes are flagged so the UI can warn', async () => {
  const r = await relay();
  const d = await device('d', r);
  await d.joinRoom('password123');
  assert.equal(d.roomInfo().strength, 'weak');
});

// ----------------------------------------------------------------------------- attacks

test('someone who knows the room id but not the code cannot get a connection accepted', async () => {
  const r = await relay();
  const code = generateCode();
  const alice = await device('alice', r);
  await alice.joinRoom(code);
  const warnings = [];
  alice.on('warning', (w) => warnings.push(w));

  // Mallory has learned the room id (e.g. from relay logs) and joins it, but derived her key from a guess.
  const mallory = await device('mallory', r);
  await mallory.joinRoom(code);
  mallory.room.authKey = Buffer.alloc(32, 9); // she cannot produce the real key
  await waitFor(() => r.stats().members === 2, 5000, 'both to be in the room');
  const aliceMid = alice.room.mid;

  // Mallory dials Alice: Alice must refuse before any application data is exchanged.
  const attempt = mallory._connectVia(mallory.room, aliceMid).then((conn) => mallory._helloOn(conn));
  await assert.rejects(attempt); // the exact low-level error depends on timing; what matters is that it fails
  await waitFor(() => warnings.some((w) => /failed the room-code check/.test(w)), 5000, 'alice to warn');
  assert.equal(alice.peers().some((p) => p.name === 'mallory'), false, 'a device that fails the check is never listed');
  const offers = [];
  alice.on('offer', (o) => offers.push(o));

  // Alice dials Mallory. A real attacker would not verify anything and would just answer with a made-up MAC;
  // Alice must refuse that reply and say why.
  mallory._bindAsAcceptor = async (sock, reader) => {
    await reader.readFrame();
    await writeFrame(sock, { t: 'bind', mac: 'f'.repeat(64) });
  };
  const reverse = alice._connectVia(alice.room, mallory.room.mid).then((conn) => alice._helloOn(conn));
  await assert.rejects(reverse, /could not verify the room code/);
  assert.deepEqual(offers, []);
});

test('a relay that tries to sit in the middle (terminating TLS separately on each side) is detected and gets nothing', async () => {
  const mitmA = loadOrCreateIdentity(tmpdir()); // the certificate the attacker shows to the dialer
  const mitmB = loadOrCreateIdentity(tmpdir()); // the certificate the attacker shows to the acceptor
  const decrypted = [];
  const intercept = (dialerPipe, acceptorPipe) => {
    const toDialer = tls.createServer(
      { key: mitmA.key, cert: mitmA.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' },
      (sockA) => {
        const sockB = tls.connect({
          socket: acceptorPipe, key: mitmB.key, cert: mitmB.cert, rejectUnauthorized: false, minVersion: 'TLSv1.3',
          checkServerIdentity: () => undefined,
        });
        for (const s of [sockA, sockB]) s.on('error', () => {});
        sockA.on('data', (d) => decrypted.push(d)); // everything the dialer says, in the clear
        sockA.pipe(sockB);
        sockB.pipe(sockA);
        sockA.on('close', () => sockB.destroy());
        sockB.on('close', () => sockA.destroy());
      },
    );
    toDialer.emit('connection', dialerPipe);
    return true;
  };
  const r = await relay({ intercept });
  const code = generateCode();
  const alice = await device('alice', r);
  const bob = await device('bob', r);
  const aliceWarnings = [];
  alice.on('warning', (w) => aliceWarnings.push(w));
  const bobOffers = [];
  bob.on('offer', (o) => bobOffers.push(o));
  await alice.joinRoom(code);
  await bob.joinRoom(code); // bob is the newcomer, so bob dials alice through the malicious relay

  await waitFor(() => r.stats().members === 2);
  await waitFor(() => decrypted.length > 0, 8000, 'the attacker to intercept the first message');
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(seesVia(alice, 'bob'), undefined, 'alice refused the man in the middle');
  assert.equal(seesVia(bob, 'alice'), undefined, 'and bob never got a verified peer either');
  assert.ok(
    decrypted.every((d) => !/offer|hello|files/.test(d.toString('latin1'))),
    'the attacker saw only the failed binding message, never a hello or an offer',
  );
  assert.ok(decrypted.some((d) => /bind/.test(d.toString('latin1'))), 'it did intercept the binding attempt');
  assert.deepEqual(bobOffers, []);
  assert.ok(
    aliceWarnings.some((w) => /failed the room-code check/.test(w)),
    'alice was told that a connection failed the room-code check',
  );
});
