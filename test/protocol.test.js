import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { encodeFrame, Reader, ProtocolError, MAX_FRAME } from '../src/protocol.js';

async function pair() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = net.connect(server.address().port, '127.0.0.1');
  const [peer] = await Promise.all([
    new Promise((r) => server.once('connection', r)),
    new Promise((r) => client.once('connect', r)),
  ]);
  return { client, peer, close: () => (client.destroy(), peer.destroy(), server.close()) };
}

test('frames round-trip, split arbitrarily across writes', async () => {
  const { client, peer, close } = await pair();
  const reader = new Reader(peer);
  const buf = Buffer.concat([encodeFrame({ t: 'a', n: 1 }), encodeFrame({ t: 'b', s: 'héllo ✓' })]);
  for (let i = 0; i < buf.length; i += 3) client.write(buf.subarray(i, i + 3));
  assert.deepEqual(await reader.readFrame(), { t: 'a', n: 1 });
  assert.deepEqual(await reader.readFrame(), { t: 'b', s: 'héllo ✓' });
  close();
});

test('readSome never returns more than asked and keeps the rest', async () => {
  const { client, peer, close } = await pair();
  const reader = new Reader(peer);
  client.write(Buffer.from('0123456789'));
  const a = await reader.readSome(4);
  assert.equal(a.toString(), '0123');
  const b = await reader.readExact(6);
  assert.equal(b.toString(), '456789');
  close();
});

test('oversized and malformed frames are rejected', async () => {
  const { client, peer, close } = await pair();
  const reader = new Reader(peer);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(MAX_FRAME + 1);
  client.write(head);
  await assert.rejects(reader.readFrame(), ProtocolError);
  close();

  const p2 = await pair();
  const r2 = new Reader(p2.peer);
  const body = Buffer.from('not json');
  const h2 = Buffer.alloc(4);
  h2.writeUInt32BE(body.length);
  p2.client.write(Buffer.concat([h2, body]));
  await assert.rejects(r2.readFrame(), ProtocolError);
  p2.close();
});

test('reads fail cleanly when the peer disconnects mid-message, and abort() unblocks a waiting read', async () => {
  const { client, peer, close } = await pair();
  const reader = new Reader(peer);
  client.write(Buffer.from([0, 0, 0, 50, 1, 2])); // promises 50 bytes, delivers 2
  const pending = reader.readFrame();
  client.destroy();
  await assert.rejects(pending, /closed|reset/i);
  close();

  const p2 = await pair();
  const r2 = new Reader(p2.peer);
  const waiting = r2.readExact(10);
  setTimeout(() => r2.abort(new Error('stop')), 20);
  await assert.rejects(waiting, /stop/);
  p2.close();
});
