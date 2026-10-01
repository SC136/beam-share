import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { acceptKey, acceptUpgrade, encodeFrame, wsConnect, WsConn } from '../src/ws.js';

const servers = [];
const open = []; // every socket the tests create, so nothing keeps the process alive
const track = (s) => (open.push(s), s);
after(() => {
  open.forEach((s) => s.destroy());
  servers.forEach((s) => s.close());
});

/** An HTTP server that upgrades every request to a WsConn and hands it to `onConn`. */
async function wsServer(onConn) {
  const server = http.createServer((_req, res) => res.end('plain http'));
  server.on('upgrade', (req, socket, head) => {
    track(socket);
    socket.on('error', () => {});
    const conn = acceptUpgrade(req, socket, head);
    if (conn) {
      conn.on('error', () => {});
      onConn(conn);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { server, url: `ws://127.0.0.1:${server.address().port}/` };
}

const collect = (stream, n) =>
  new Promise((resolve) => {
    const parts = [];
    let got = 0;
    stream.on('data', (c) => {
      parts.push(c);
      got += c.length;
      if (got >= n) resolve(Buffer.concat(parts));
    });
  });

// ---------------------------------------------------------------- RFC 6455 vectors

test('Sec-WebSocket-Accept matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('frame encoding matches the RFC 6455 examples', () => {
  // unmasked text "Hello"
  assert.deepEqual([...encodeFrame(0x1, Buffer.from('Hello'))], [0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  // 256-byte binary uses the 16-bit length form, 65536 the 64-bit form
  const f256 = encodeFrame(0x2, Buffer.alloc(256));
  assert.deepEqual([...f256.subarray(0, 4)], [0x82, 0x7e, 0x01, 0x00]);
  assert.equal(f256.length, 4 + 256);
  const f64k = encodeFrame(0x2, Buffer.alloc(65536));
  assert.deepEqual([...f64k.subarray(0, 10)], [0x82, 0x7f, 0, 0, 0, 0, 0, 1, 0, 0]);
  // masked frames carry the mask bit and a key, and unmask back to the payload
  const m = encodeFrame(0x1, Buffer.from('Hello'), { mask: true });
  assert.equal(m[1] & 0x80, 0x80);
  const key = m.subarray(2, 6);
  assert.equal(Buffer.from(m.subarray(6).map((b, i) => b ^ key[i & 3])).toString(), 'Hello');
});

test('a masked "Hello" from the RFC is parsed by the server', async () => {
  const got = new Promise((resolve) => wsServer((c) => c.once('text', resolve)).then(({ url }) => {
    const u = new URL(url);
    const raw = track(net.connect(Number(u.port), '127.0.0.1'));
    raw.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    raw.once('data', (d) => {
      assert.match(d.toString(), /^HTTP\/1\.1 101 .*Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/is);
      raw.write(Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])); // RFC 5.7 example
    });
  }));
  assert.equal(await got, 'Hello');
});

// ------------------------------------------------------------------ our client + server

test('client and server exchange text and binary, including sizes that need 16- and 64-bit lengths', async () => {
  const echoed = [];
  const { url } = await wsServer((c) => {
    c.on('text', (t) => c.sendText(`echo:${t}`));
    c.on('data', (d) => c.write(d));
  });
  const c = track(await wsConnect(url));
  c.on('error', () => {});
  const texts = [];
  c.on('text', (t) => texts.push(t));
  c.sendText('hi');
  c.sendText('héllo ✓');
  for (const size of [1, 125, 126, 127, 65535, 65536, 300_000, 1_000_000]) {
    const payload = Buffer.alloc(size, size % 251);
    c.write(payload);
    const back = await collect(c, size);
    assert.equal(back.length, size, `size ${size}`);
    assert.ok(back.equals(payload), `echo of ${size} bytes is identical`);
    echoed.push(size);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(texts, ['echo:hi', 'echo:héllo ✓']);
  assert.equal(echoed.length, 8);
  c.destroy();
});

test('data sent in many small writes arrives in order', async () => {
  const { url } = await wsServer((c) => c.on('data', (d) => c.write(d)));
  const c = track(await wsConnect(url));
  c.on('error', () => {});
  const expected = [];
  for (let i = 0; i < 500; i++) {
    const b = Buffer.from(`chunk-${i};`);
    expected.push(b);
    c.write(b);
  }
  const all = Buffer.concat(expected);
  const back = await collect(c, all.length);
  assert.equal(back.toString(), all.toString());
  c.destroy();
});

test('closing one side ends the other cleanly', async () => {
  let serverSide;
  const { url } = await wsServer((c) => (serverSide = c));
  const c = track(await wsConnect(url));
  c.on('error', () => {});
  c.resume();
  await new Promise((r) => setTimeout(r, 30));
  const ended = new Promise((r) => serverSide.on('end', r));
  serverSide.resume();
  c.end();
  await ended;
  await new Promise((r) => c.once('close', r));
});

test('server-initiated pings are answered, and a silent peer is dropped by keepalive', async () => {
  let server;
  const { url } = await wsServer((c) => {
    server = c;
    c.startKeepalive(40);
  });
  const c = track(await wsConnect(url));
  c.on('error', () => {});
  c.resume();
  await new Promise((r) => setTimeout(r, 200)); // several keepalive rounds: our automatic pongs keep it alive
  assert.equal(server.destroyed, false, 'a responsive peer stays connected');
  // now a raw client that completes the upgrade but never answers anything
  const u = new URL(url);
  const raw = track(net.connect(Number(u.port), '127.0.0.1'));
  raw.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  raw.on('error', () => {});
  raw.resume(); // read the 101 so Node can report the close; we just never send a frame or a pong
  const closed = new Promise((r) => raw.once('close', r));
  await Promise.race([closed, new Promise((_, j) => setTimeout(() => j(new Error('silent peer was not dropped')), 3000))]);
  c.destroy();
});

// ------------------------------------------------------------------ hostile input

test('server rejects non-WebSocket requests and bad handshakes without crashing', async () => {
  const { url, server } = await wsServer(() => {});
  const port = new URL(url).port;
  const plain = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.equal(plain, 'plain http');
  const reply = await new Promise((resolve) => {
    const raw = net.connect(Number(port), '127.0.0.1');
    raw.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); // no key/version
    let d = '';
    raw.on('data', (c) => (d += c));
    raw.on('close', () => resolve(d));
    raw.on('error', () => resolve(d));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal(server.listening, true);
});

async function rawUpgraded(url) {
  const u = new URL(url);
  const raw = track(net.connect(Number(u.port), '127.0.0.1'));
  raw.on('error', () => {});
  raw.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise((r) => raw.once('data', r));
  raw.resume();
  return raw;
}

test('protocol violations close the connection: unmasked client frame, reserved bits, oversized frame, stray continuation', async () => {
  const errors = [];
  const { url } = await wsServer((c) => c.on('error', (e) => errors.push(e.message)));
  const cases = {
    'unmasked client frame': Buffer.from([0x81, 0x02, 0x68, 0x69]),
    'reserved bits set': Buffer.from([0xf1, 0x82, 0, 0, 0, 0, 1, 2]),
    'oversized frame': Buffer.concat([Buffer.from([0x82, 0xff]), Buffer.from([0, 0, 0, 0, 0x10, 0, 0, 0]), Buffer.alloc(4)]),
    'stray continuation': Buffer.from([0x80, 0x81, 0, 0, 0, 0, 1]),
    'fragmented control frame': Buffer.from([0x09, 0x80, 0, 0, 0, 0]),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const raw = await rawUpgraded(url);
    const closed = new Promise((r) => raw.once('close', r));
    raw.write(bytes);
    await Promise.race([closed, new Promise((_, j) => setTimeout(() => j(new Error(`not closed: ${name}`)), 2000))]);
  }
  assert.equal(errors.length, Object.keys(cases).length);
});

test('fragmented messages are reassembled', async () => {
  let text;
  const { url } = await wsServer((c) => c.once('text', (t) => (text = t)));
  const raw = await rawUpgraded(url);
  const mask = Buffer.from([1, 2, 3, 4]);
  const frag = (op, fin, s) => {
    const p = Buffer.from(s);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]), mask, p.map((b, i) => b ^ mask[i & 3])]);
  };
  raw.write(Buffer.concat([frag(0x1, false, 'Hel'), frag(0x0, false, 'lo, '), frag(0x0, true, 'world')]));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(text, 'Hello, world');
  raw.destroy();
});

test('wsConnect gives clear errors for bad addresses, refused connections, and non-WebSocket servers', async () => {
  await assert.rejects(wsConnect('not a url'), /not a valid relay address/);
  await assert.rejects(wsConnect('http://127.0.0.1:1/'), /must start with ws/);
  await assert.rejects(wsConnect('ws://127.0.0.1:1/'), /refused the connection/);
  const plain = http.createServer((_q, r) => r.end('hello'));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  servers.push(plain);
  await assert.rejects(wsConnect(`ws://127.0.0.1:${plain.address().port}/`, { timeout: 1500 }), /not a beam relay|refused|timed out/);
});

test('WsConn really is a Duplex: pipe() works and carries backpressure end to end', async () => {
  let serverSide;
  const { url } = await wsServer((c) => (serverSide = c));
  const c = track(await wsConnect(url));
  c.on('error', () => {});
  await new Promise((r) => setTimeout(r, 30));
  const total = 20 * 1024 * 1024;
  let received = 0;
  serverSide.on('data', (d) => (received += d.length));
  const chunk = Buffer.alloc(1024 * 1024, 1);
  for (let i = 0; i < 20; i++) if (!c.write(chunk)) await new Promise((r) => c.once('drain', r));
  while (received < total) await new Promise((r) => setTimeout(r, 10));
  assert.equal(received, total);
  assert.ok(WsConn.prototype instanceof (await import('node:stream')).Duplex);
  c.destroy();
});

test('interop: our server works with Node\'s built-in WebSocket client (independent implementation)', { skip: typeof WebSocket === 'undefined' && 'no global WebSocket on this Node' }, async () => {
  const { url } = await wsServer((c) => {
    c.on('text', (t) => c.sendText(`got:${t}`));
    c.on('data', (d) => c.write(d));
  });
  const ws = new WebSocket(url.replace(/\/$/, ''));
  ws.binaryType = 'arraybuffer';
  const inbox = [];
  ws.onmessage = (e) => inbox.push(e.data);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('reference client could not connect'));
  });
  ws.send('héllo');
  const bin = Buffer.alloc(200_000, 9);
  ws.send(bin);
  // Large writes are sent as several binary messages (we treat the connection as a byte stream), so
  // compare the reassembled bytes rather than expecting one message.
  const bytesIn = () => inbox.slice(1).reduce((n, m) => n + m.byteLength, 0);
  for (let i = 0; i < 300 && bytesIn() < bin.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(inbox[0], 'got:héllo');
  assert.ok(Buffer.concat(inbox.slice(1).map((m) => Buffer.from(m))).equals(bin), 'binary payload arrives intact');
  ws.close();
});
