import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { loadOrCreateIdentity } from '../src/identity.js';
import {
  bindMac, codeStrength, deriveRoomKeys, generateCode, macEquals, normalizeCode, normalizeRelayUrl, randomMemberId,
} from '../src/room.js';
import { WORDS } from '../src/words.js';

test('word list: enough unique, short, lowercase words for ~40 bits in five words', () => {
  assert.ok(WORDS.length >= 256);
  assert.equal(new Set(WORDS).size, WORDS.length, 'no duplicates');
  for (const w of WORDS) assert.match(w, /^[a-z]{2,8}$/);
  assert.ok(5 * Math.log2(WORDS.length) >= 40);
});

test('generated codes are five words, differ every time, and rate as strong', () => {
  const codes = new Set();
  for (let i = 0; i < 200; i++) {
    const c = generateCode();
    assert.match(c, /^[a-z]+(-[a-z]+){4}$/);
    assert.equal(normalizeCode(c), c, 'already normalised');
    assert.equal(codeStrength(c), 'strong');
    codes.add(c);
  }
  assert.ok(codes.size > 195, 'effectively never repeats');
  assert.equal(generateCode(3).split('-').length, 3);
});

test('normalizeCode is forgiving about case and separators, strict about length', () => {
  assert.equal(normalizeCode('  Maple Tiger_Coral  river-PEARL '), 'maple-tiger-coral-river-pearl');
  assert.equal(normalizeCode('aa--bb---cc dd'), 'aa-bb-cc-dd');
  assert.throws(() => normalizeCode('short'), /at least 8/);
  assert.throws(() => normalizeCode(''), /at least 8/);
  assert.throws(() => normalizeCode(null), /at least 8/);
  assert.throws(() => normalizeCode('x'.repeat(201)), /too long/);
});

test('codeStrength: generated-style is strong, long phrases are ok, short guessable ones are weak', () => {
  assert.equal(codeStrength('maple-tiger-coral-river-pearl'), 'strong');
  assert.equal(codeStrength('maple-tiger-coral-river'), 'ok', 'only four words: long enough to be ok, not strong');
  assert.equal(codeStrength('maple-tiger-coral-river-cloudy'), 'ok', 'a word outside the list is not counted as a random word');
  assert.equal(codeStrength('correct-horse-battery-staple-x'), 'ok');
  assert.equal(codeStrength('password123'), 'weak');
  assert.equal(codeStrength('letmein-now'), 'weak');
});

test('relay addresses are normalised sensibly', () => {
  const cases = {
    'relay.example.com': 'wss://relay.example.com/',
    'relay.example.com:8443': 'ws://relay.example.com:8443/',
    '203.0.113.5': 'ws://203.0.113.5:7979/',
    '203.0.113.5:9000': 'ws://203.0.113.5:9000/',
    localhost: 'ws://localhost:7979/',
    'localhost:1234': 'ws://localhost:1234/',
    'ws://x.test:5/': 'ws://x.test:5/',
    'wss://x.test/path': 'wss://x.test/path',
    'https://relay.example.com': 'wss://relay.example.com/',
    'http://10.0.0.2:80': 'ws://10.0.0.2/',
    '  relay.example.com  ': 'wss://relay.example.com/',
    '[::1]:7979': 'ws://[::1]:7979/',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeRelayUrl(input), want, input);
  assert.equal(normalizeRelayUrl(''), null);
  assert.equal(normalizeRelayUrl(undefined), null);
  assert.throws(() => normalizeRelayUrl('ws://'), /not a valid relay address/);
});

test('room keys: deterministic per code, independent between codes, and the room id reveals nothing usable', async () => {
  const a1 = await deriveRoomKeys('maple-tiger-coral-river-pearl', 1 << 10);
  const a2 = await deriveRoomKeys('maple-tiger-coral-river-pearl', 1 << 10);
  const b = await deriveRoomKeys('maple-tiger-coral-river-pearm', 1 << 10);
  assert.equal(a1.roomId, a2.roomId);
  assert.ok(a1.authKey.equals(a2.authKey));
  assert.notEqual(a1.roomId, b.roomId, 'a one-letter change gives an unrelated room');
  assert.ok(!a1.authKey.equals(b.authKey));
  assert.match(a1.roomId, /^[0-9a-f]{32}$/);
  assert.equal(a1.authKey.length, 32);
  assert.ok(!Buffer.from(a1.roomId, 'hex').equals(a1.authKey.subarray(0, 16)), 'the key is not derivable from the id');
  const slow = await deriveRoomKeys('maple-tiger-coral-river-pearl', 1 << 10);
  const other = await deriveRoomKeys('maple-tiger-coral-river-pearl', 1 << 11);
  assert.notEqual(slow.roomId, other.roomId, 'cost parameter is part of the derivation');
});

test('default key derivation cost is deliberately slow (tens of ms or more) so guessing is expensive', async () => {
  const t0 = performance.now();
  await deriveRoomKeys('some-code-to-time');
  const ms = performance.now() - t0;
  assert.ok(ms > 20, `took only ${ms.toFixed(1)} ms`);
});

test('member ids are 16 hex chars and unique', () => {
  const ids = new Set(Array.from({ length: 100 }, randomMemberId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
});

test('macEquals handles mismatches, wrong types and lengths without throwing', () => {
  assert.equal(macEquals('abcd', 'abcd'), true);
  assert.equal(macEquals('abcd', 'abce'), false);
  assert.equal(macEquals('abcd', 'abc'), false);
  assert.equal(macEquals(undefined, 'abc'), false);
  assert.equal(macEquals('abc', 42), false);
  assert.equal(macEquals(null, null), false);
});

// ------------------------------------------------------- channel binding on real TLS

function duplexPair() {
  let a, b;
  const mk = (peer) =>
    new Duplex({
      read() {},
      write(chunk, _e, cb) {
        setImmediate(() => {
          peer().push(chunk);
          cb();
        });
      },
      final(cb) {
        setImmediate(() => peer().push(null));
        cb();
      },
    });
  a = mk(() => b);
  b = mk(() => a);
  return [a, b];
}

async function tlsSession(clientId, serverId) {
  const [c, s] = duplexPair();
  const srv = tls.createServer({ key: serverId.key, cert: serverId.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' });
  const serverSock = new Promise((r) => srv.on('secureConnection', r));
  srv.emit('connection', s);
  const clientSock = tls.connect({ socket: c, key: clientId.key, cert: clientId.cert, rejectUnauthorized: false, minVersion: 'TLSv1.3', checkServerIdentity: () => undefined });
  await new Promise((r, j) => (clientSock.once('secureConnect', r), clientSock.once('error', j)));
  return { clientSock, serverSock: await serverSock };
}

test('binding MAC: equal within one TLS session, different across sessions, role-separated, key-dependent', async () => {
  const mkId = () => loadOrCreateIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'beam-room-')));
  const a = mkId();
  const b = mkId();
  const key = Buffer.alloc(32, 7);
  const otherKey = Buffer.alloc(32, 8);
  const s1 = await tlsSession(a, b);
  const s2 = await tlsSession(a, b); // same two identities, a different TLS session

  assert.equal(bindMac(s1.clientSock, key, 'dial'), bindMac(s1.serverSock, key, 'dial'), 'both ends of one session agree');
  assert.notEqual(bindMac(s1.clientSock, key, 'dial'), bindMac(s2.serverSock, key, 'dial'), 'a MAC from another session is useless (this is what stops a MITM relay)');
  assert.notEqual(bindMac(s1.clientSock, key, 'dial'), bindMac(s1.clientSock, key, 'accept'), 'roles differ, so a MAC cannot be reflected back');
  assert.notEqual(bindMac(s1.clientSock, key, 'dial'), bindMac(s1.serverSock, otherKey, 'dial'), 'the wrong code gives a different MAC');
  assert.match(bindMac(s1.clientSock, key, 'dial'), /^[0-9a-f]{64}$/);
  for (const s of [s1, s2]) (s.clientSock.destroy(), s.serverSock.destroy());
});
