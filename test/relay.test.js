import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { RoomClient, randomMemberId } from '../src/room.js';
import { startRelay } from '../src/relay.js';
import { wsConnect } from '../src/ws.js';

const closers = [];
after(async () => {
  while (closers.length) await closers.pop()();
});

async function relay(opts = {}) {
  const r = await startRelay({ port: 0, host: '127.0.0.1', ...opts });
  closers.push(() => r.close());
  return { ...r, url: `ws://127.0.0.1:${r.port}/` };
}

const ROOM = (n = 1) => crypto.createHash('sha256').update(`room-${n}`).digest('hex').slice(0, 32);

async function member(r, room = ROOM(), extra = {}) {
  const c = new RoomClient({ url: r.url, roomId: room, mid: randomMemberId(), ...extra });
  const events = [];
  c.on('peer-joined', (m) => events.push(['joined', m]));
  c.on('peer-left', (m) => events.push(['left', m]));
  c.on('incoming', (m) => events.push(['incoming', m]));
  c.events = events;
  c.members = await c.connect();
  closers.push(() => c.close());
  return c;
}

const until = async (fn, ms = 3000, what = 'condition') => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const readBytes = (stream, n) =>
  new Promise((resolve) => {
    const parts = [];
    let got = 0;
    stream.on('data', (c) => {
      parts.push(c);
      got += c.length;
      if (got >= n) resolve(Buffer.concat(parts));
    });
  });

/** Open a pipe a -> b through the relay and return both ends. */
async function connectPipe(a, b) {
  const dialing = a.dial(b.mid);
  await until(() => b.events.some((e) => e[0] === 'incoming'), 3000, 'incoming notice');
  const { pipe, from } = b.events.find((e) => e[0] === 'incoming')[1];
  assert.equal(from, a.mid);
  const accepted = await b.accept(pipe);
  const dialed = await dialing;
  b.events.length = 0;
  return { dialed, accepted };
}

// ---------------------------------------------------------------- presence

test('http GET answers for health checks; plain upgrade-less clients are not a problem', async () => {
  const r = await relay();
  const body = await new Promise((resolve) => http.get(`http://127.0.0.1:${r.port}/`, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => resolve(d));
  }));
  assert.equal(body, 'beam relay ok\n');
});

test('members see each other join and leave', async () => {
  const r = await relay();
  const a = await member(r);
  assert.deepEqual(a.members, []);
  const b = await member(r);
  assert.deepEqual(b.members, [a.mid]);
  await until(() => a.events.some((e) => e[0] === 'joined' && e[1] === b.mid), 2000, 'a to see b join');
  assert.equal(r.stats().members, 2);
  b.close();
  await until(() => a.events.some((e) => e[0] === 'left' && e[1] === b.mid), 2000, 'a to see b leave');
  assert.equal(r.stats().members, 1);
  a.close();
  await until(() => r.stats().rooms === 0, 2000, 'empty room to be removed');
});

test('rooms are isolated: other rooms are invisible and cannot be dialled', async () => {
  const r = await relay();
  const a = await member(r, ROOM(1));
  const c = await member(r, ROOM(2));
  assert.deepEqual(c.members, [], 'c does not see a');
  await assert.rejects(c.dial(a.mid), /not in the room/);
  // a member of room 2 cannot dial a room-1 member even if it claims to be one
  const ws = await wsConnect(r.url);
  ws.on('error', () => {});
  const reply = new Promise((res) => ws.once('text', (t) => res(JSON.parse(t))));
  ws.sendText(JSON.stringify({ t: 'dial', v: 1, room: ROOM(2), from: a.mid, to: a.mid }));
  assert.equal((await reply).t, 'error');
  ws.destroy();
});

// ----------------------------------------------------------------- pipes

test('a dialled pipe carries bytes both ways intact, then closing one end closes the other', async () => {
  const r = await relay();
  const a = await member(r);
  const b = await member(r);
  const { dialed, accepted } = await connectPipe(a, b);
  assert.equal(r.stats().pipes, 1);

  const up = crypto.randomBytes(3 * 1024 * 1024);
  const down = crypto.randomBytes(1024 * 1024 + 17);
  const gotUp = readBytes(accepted, up.length);
  const gotDown = readBytes(dialed, down.length);
  dialed.write(up);
  accepted.write(down);
  assert.ok((await gotUp).equals(up), 'dialer -> acceptor intact');
  assert.ok((await gotDown).equals(down), 'acceptor -> dialer intact');

  const closed = new Promise((res) => accepted.once('close', res));
  dialed.destroy();
  await closed;
  await until(() => r.stats().pipes === 0, 2000, 'pipe to be released');
  assert.equal(r.stats().pending, 0);
});

test('many pipes can be open at once without crossing wires', async () => {
  const r = await relay();
  const a = await member(r);
  const b = await member(r);
  const pairs = [];
  for (let i = 0; i < 5; i++) pairs.push(await connectPipe(a, b));
  const payloads = pairs.map(() => crypto.randomBytes(200_000));
  const reads = pairs.map((p, i) => readBytes(p.accepted, payloads[i].length));
  pairs.forEach((p, i) => p.dialed.write(payloads[i]));
  const got = await Promise.all(reads);
  got.forEach((g, i) => assert.ok(g.equals(payloads[i]), `pipe ${i} got its own data`));
  assert.equal(r.stats().pipes, 5);
  for (const p of pairs) p.dialed.destroy();
  await until(() => r.stats().pipes === 0);
});

test('a peer that writes a lot and hangs up straight away still delivers every byte to a slow reader', async () => {
  const r = await relay();
  const a = await member(r);
  const b = await member(r);
  const { dialed, accepted } = await connectPipe(a, b);
  const payload = crypto.randomBytes(6 * 1024 * 1024);
  const parts = [];
  let ended = false;
  accepted.on('end', () => (ended = true));
  accepted.pause();
  dialed.end(payload); // write everything, then close - the reader has not read a byte yet
  await new Promise((res) => setTimeout(res, 300));
  // drain slowly, in small bites with pauses, long after the sender has gone
  accepted.on('data', (c) => {
    parts.push(c);
    accepted.pause();
    setTimeout(() => accepted.resume(), 1);
  });
  accepted.resume();
  await until(() => ended, 30_000, 'reader to see the end of the stream');
  assert.equal(Buffer.concat(parts).length, payload.length, 'no bytes were lost to the early hang-up');
  assert.ok(Buffer.concat(parts).equals(payload));
  await until(() => r.stats().pipes === 0, 5000, 'pipe to be released');
});

test('only bytes cross a pipe: text frames sent through it are dropped, not delivered', async () => {
  const r = await relay();
  const a = await member(r);
  const b = await member(r);
  const { dialed, accepted } = await connectPipe(a, b);
  const seenText = [];
  accepted.on('text', (t) => seenText.push(t));
  const got = readBytes(accepted, 5);
  dialed.sendText('{"t":"paired"}'); // an attempt to inject a control message into the other side
  dialed.sendText('{"t":"incoming","pipe":"x","from":"y"}');
  dialed.write(Buffer.from('bytes'));
  assert.equal((await got).toString(), 'bytes');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.deepEqual(seenText, []);
  dialed.destroy();
});

test('dialling a device that never answers times out cleanly', async () => {
  const r = await relay({ limits: { pairMs: 250 } });
  const a = await member(r);
  const b = await member(r);
  void b;
  await assert.rejects(a.dial(b.mid), /did not answer/);
  assert.equal(r.stats().pending, 0);
});

test('a dialler that gives up frees the pending slot; accepting afterwards fails', async () => {
  const r = await relay();
  const a = await member(r);
  const b = await member(r);
  const ac = new AbortController();
  const dialing = a.dial(b.mid, ac.signal);
  await until(() => b.events.some((e) => e[0] === 'incoming'));
  const { pipe } = b.events.find((e) => e[0] === 'incoming')[1];
  ac.abort();
  await assert.rejects(dialing);
  await until(() => r.stats().pending === 0, 2000, 'pending to clear');
  await assert.rejects(b.accept(pipe), /no such pending/);
});

test('accepting with a wrong member id, wrong room or invented pipe id is refused', async () => {
  const r = await relay();
  const a = await member(r);
  const b = await member(r);
  const intruder = await member(r);
  const dialing = a.dial(b.mid).catch(() => {});
  await until(() => b.events.some((e) => e[0] === 'incoming'));
  const { pipe } = b.events.find((e) => e[0] === 'incoming')[1];
  // the intruder is in the room but is not the device the pipe was announced to
  const evil = await wsConnect(r.url);
  evil.on('error', () => {});
  const reply = new Promise((res) => evil.once('text', (t) => res(JSON.parse(t))));
  evil.sendText(JSON.stringify({ t: 'accept', v: 1, room: ROOM(), pipe, mid: intruder.mid }));
  assert.match((await reply).reason, /no such pending/);
  await assert.rejects(b.accept('0'.repeat(32)), /no such pending/);
  evil.destroy();
  // the genuine target can still accept
  const ok = await b.accept(pipe);
  (await dialing)?.destroy?.();
  ok.destroy();
});

// ------------------------------------------------------------------ abuse

test('a relay token is enforced on join, dial and accept', async () => {
  const r = await relay({ token: 's3cret' });
  await assert.rejects(member(r), /wrong relay token/);
  await assert.rejects(member(r, ROOM(), { token: 'nope' }), /wrong relay token/);
  const a = await member(r, ROOM(), { token: 's3cret' });
  const b = await member(r, ROOM(), { token: 's3cret' });
  const { dialed } = await connectPipe(a, b);
  dialed.destroy();
  // a dial without the token is refused even for a real member id
  const noToken = new RoomClient({ url: r.url, roomId: ROOM(), mid: a.mid });
  await assert.rejects(noToken.dial(b.mid), /wrong relay token/);
});

test('room capacity, duplicate ids and bad ids are refused', async () => {
  const r = await relay({ limits: { maxRoomMembers: 2 } });
  await member(r);
  const second = await member(r);
  await assert.rejects(member(r), /room is full/);
  const dup = new RoomClient({ url: r.url, roomId: ROOM(), mid: second.mid });
  await assert.rejects(dup.connect(), /room is full|duplicate/);
  const send = async (obj) => {
    const ws = await wsConnect(r.url);
    ws.on('error', () => {});
    const reply = new Promise((res) => ws.once('text', (t) => res(JSON.parse(t))));
    const closed = new Promise((res) => ws.once('close', res));
    ws.sendText(typeof obj === 'string' ? obj : JSON.stringify(obj));
    const out = await Promise.race([reply, closed.then(() => ({ closed: true }))]);
    ws.destroy();
    return out;
  };
  assert.match((await send({ t: 'join', v: 1, room: 'xyz', mid: 'a'.repeat(16) })).reason, /bad room id/);
  assert.match((await send({ t: 'join', v: 1, room: ROOM(9), mid: '../../etc' })).reason, /bad member id/);
  assert.match((await send({ t: 'join', v: 2, room: ROOM(9), mid: 'a'.repeat(16) })).reason, /version/);
  assert.match((await send({ t: 'explode', v: 1, room: ROOM(9) })).reason, /unknown request/);
  assert.equal((await send('not json at all')).closed, true);
  assert.match((await send('null')).reason, /version/);
  assert.equal(r.stats().rooms, 1, 'abuse did not create rooms');
});

test('a connection that never says anything is dropped', async () => {
  const r = await relay({ limits: { firstMessageMs: 150 } });
  const ws = await wsConnect(r.url);
  ws.on('error', () => {});
  ws.resume();
  const closed = new Promise((res) => ws.once('close', res));
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('idle connection kept open')), 2000))]);
});

test('join attempts are rate limited per IP', async () => {
  const r = await relay({ limits: { joinsPerMinutePerIp: 3 } });
  for (let i = 0; i < 3; i++) await member(r, ROOM(i + 100));
  await assert.rejects(member(r, ROOM(200)), /too many join attempts/);
});

test('connections per IP are capped', async () => {
  const r = await relay({ limits: { maxConnsPerIp: 3 } });
  const held = [];
  for (let i = 0; i < 3; i++) {
    const ws = await wsConnect(r.url);
    ws.on('error', () => {});
    ws.resume();
    held.push(ws);
  }
  await assert.rejects(wsConnect(r.url, { timeout: 1500 }), /closed|reset|refused|timed out|not a beam relay/i);
  held.forEach((w) => w.destroy());
});

test('relay shuts down cleanly with members and pipes open', async () => {
  const r = await startRelay({ port: 0, host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${r.port}/`;
  const a = new RoomClient({ url, roomId: ROOM(), mid: randomMemberId() });
  a.on('close', () => {});
  await a.connect();
  const closed = new Promise((res) => a.once('close', res));
  await r.close();
  await closed;
  assert.equal(r.stats().connections, 0);
});

// ------------------------------------------------------------------ hardening

test('an oversized first message is dropped without being parsed', async () => {
  const r = await relay();
  const ws = await wsConnect(r.url);
  ws.on('error', () => {});
  ws.resume();
  const closed = new Promise((res) => ws.once('close', res));
  ws.sendText(JSON.stringify({ t: 'join', v: 1, room: ROOM(), mid: 'a'.repeat(16), padding: 'x'.repeat(10_000) }));
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('oversized message was kept')), 2000))]);
  assert.equal(r.stats().rooms, 0);
});

test('behind a proxy (trustProxy) limits follow X-Forwarded-For; otherwise that header is ignored', async () => {
  const join = async (r, ip, n) => {
    const ws = await wsConnect(r.url, { headers: ip ? { 'X-Forwarded-For': ip } : {} });
    ws.on('error', () => {});
    const reply = new Promise((res) => ws.once('text', (t) => res(JSON.parse(t))));
    ws.sendText(JSON.stringify({ t: 'join', v: 1, room: ROOM(300 + n), mid: crypto.randomBytes(8).toString('hex') }));
    const m = await reply;
    closers.push(async () => ws.destroy());
    return m.t;
  };
  // trusted proxy: each client IP has its own budget
  const proxied = await relay({ trustProxy: true, limits: { joinsPerMinutePerIp: 2 } });
  assert.equal(await join(proxied, '198.51.100.1', 1), 'joined');
  assert.equal(await join(proxied, '198.51.100.1', 2), 'joined');
  assert.equal(await join(proxied, '198.51.100.1', 3), 'error', 'third join from the same client IP is refused');
  assert.equal(await join(proxied, '198.51.100.2', 4), 'joined', 'a different client IP behind the same proxy is not affected');
  // not trusted: a client cannot dodge the limit by inventing the header
  const open = await relay({ limits: { joinsPerMinutePerIp: 2 } });
  assert.equal(await join(open, '203.0.113.1', 11), 'joined');
  assert.equal(await join(open, '203.0.113.2', 12), 'joined');
  assert.equal(await join(open, '203.0.113.3', 13), 'error', 'forged X-Forwarded-For values do not reset the limit');
});
