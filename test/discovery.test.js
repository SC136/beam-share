import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { broadcastTargets } from '../src/discovery.js';
import { autoRespond, cleanupAll, makeBeam, settled, tmpdir, waitFor } from './helpers.js';

after(cleanupAll);

// A UDP port nobody else uses, so tests don't talk to a real beam running on 45454.
const PORT = 45000 + Math.floor(Math.random() * 3000);

test('broadcastTargets includes the limited broadcast and per-interface directed broadcasts', () => {
  const t = broadcastTargets();
  assert.ok(t.includes('255.255.255.255'));
  for (const a of t) assert.match(a, /^\d+\.\d+\.\d+\.\d+$/);
});

test('two instances discover each other over UDP broadcast, and can then transfer', async () => {
  const a = await makeBeam('alice', { discovery: true, discoveryPort: PORT });
  const b = await makeBeam('bob', { discovery: true, discoveryPort: PORT });
  assert.equal(a.discoveryError, null);

  await waitFor(() => a.peers().length === 1 && b.peers().length === 1, 8000, 'mutual discovery');
  const [seenByA] = a.peers();
  const [seenByB] = b.peers();
  assert.equal(seenByA.name, 'bob');
  assert.equal(seenByA.id, b.fingerprint);
  assert.equal(seenByA.port, b.port);
  assert.equal(seenByA.manual, false);
  assert.equal(seenByB.name, 'alice');
  assert.equal(seenByB.id, a.fingerprint);

  // The announced identity is what the TLS handshake is checked against.
  autoRespond(b);
  const src = path.join(tmpdir(), 'via-discovery.txt');
  fs.writeFileSync(src, 'found you');
  const t = a.send(seenByA.id, [src]);
  await waitFor(() => settled(t));
  assert.equal(t.status, 'done', t.error);
  assert.equal(fs.readFileSync(path.join(b.downloadDir, 'via-discovery.txt'), 'utf8'), 'found you');
});

test('a peer that shuts down cleanly disappears immediately (goodbye packet)', async () => {
  const a = await makeBeam('carol', { discovery: true, discoveryPort: PORT + 1 });
  const b = await makeBeam('dave', { discovery: true, discoveryPort: PORT + 1 });
  await waitFor(() => a.peers().length === 1, 8000, 'discovery');
  await b.stop();
  await waitFor(() => a.peers().length === 0, 3000, 'goodbye to remove the peer');
});

test('junk datagrams on the discovery port are ignored', async () => {
  const a = await makeBeam('erin', { discovery: true, discoveryPort: PORT + 2 });
  const sock = dgram.createSocket('udp4');
  const junk = [
    'hello', '{"m":"beam/1"}', '{"m":"beam/1","id":"nothex","name":"x","port":1}',
    JSON.stringify({ m: 'beam/1', id: 'a'.repeat(64), name: 'x', port: 70000 }),
    JSON.stringify({ m: 'other/9', id: 'a'.repeat(64), name: 'x', port: 5 }),
    JSON.stringify({ m: 'beam/1', id: 'a'.repeat(64), name: 'x'.repeat(5000), port: 5 }),
  ];
  for (const j of junk) await new Promise((r) => sock.send(j, PORT + 2, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.peers().length, 0);
  // A well-formed one is accepted, with the name stripped of control characters.
  await new Promise((r) =>
    sock.send(JSON.stringify({ m: 'beam/1', id: 'b'.repeat(64), name: 'ev\u001b[31mil', port: 5 }), PORT + 2, '127.0.0.1', r),
  );
  await waitFor(() => a.peers().length === 1, 2000, 'valid announcement');
  assert.ok(!/\u001b/.test(a.peers()[0].name));
  sock.close();
});
