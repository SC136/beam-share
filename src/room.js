// Internet "rooms": friends enter the same code and meet through a relay.
//
//   code ──scrypt──▶ roomId (what the relay sees; it can't reverse it to the code)
//                  └▶ authKey (never leaves the device)
//
// Peers talk through the relay with ordinary mutual TLS 1.3, so the relay only ever
// sees ciphertext. To stop a malicious relay from sitting in the middle (terminating
// TLS separately towards each side), both ends prove they know the code by exchanging
// a MAC over the TLS *exporter secret*, which is different for every TLS session.
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WORDS } from './words.js';
import { BeamError, clean } from './util.js';
import { wsConnect } from './ws.js';

export const DEFAULT_RELAY_PORT = 7979;
export const KDF_COST = 1 << 15; // ~100-200 ms: negligible for us, painful per guess for an attacker
const WORD_SET = new Set(WORDS);

// ------------------------------------------------------------------- codes

export function generateCode(words = 5) {
  return Array.from({ length: words }, () => WORDS[randomInt(WORDS.length)]).join('-');
}

/** Lower-case, dash-separated. Throws if it is too short to be a sensible secret. */
export function normalizeCode(input) {
  const code = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (code.length < 8) throw new BeamError('a room code needs at least 8 characters');
  if (code.length > 200) throw new BeamError('that room code is too long');
  return code;
}

/** 'strong' for generated-style codes, 'ok' for long phrases, 'weak' otherwise (guessable). */
export function codeStrength(code) {
  const parts = code.split('-');
  if (parts.length >= 5 && parts.every((p) => WORD_SET.has(p))) return 'strong';
  return code.length >= 20 ? 'ok' : 'weak';
}

export function deriveRoomKeys(code, cost = KDF_COST) {
  return new Promise((resolve, reject) => {
    scrypt(code, 'beam-room-v1', 64, { N: cost, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (err, key) => {
      if (err) return reject(err);
      resolve({ roomId: key.subarray(0, 16).toString('hex'), authKey: key.subarray(32, 64) });
    });
  });
}

export const randomMemberId = () => randomBytes(8).toString('hex');

// ------------------------------------------------------------- relay address

/**
 * Accepts "host", "host:port", "ws(s)://host[:port]" or http(s):// and returns a ws(s):// URL.
 * A bare domain means wss on 443 (what hosting platforms provide); an IP or host:port means plain ws.
 */
export function normalizeRelayUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  s = s.replace(/^http(s?):\/\//i, 'ws$1://');
  if (!/^wss?:\/\//i.test(s)) {
    const hasPort = /:\d+(\/.*)?$/.test(s);
    const local = /^(\d{1,3}\.){3}\d{1,3}(:|\/|$)/.test(s) || /^localhost(:|\/|$)/i.test(s) || s.startsWith('[');
    s = hasPort || local ? `ws://${s}` : `wss://${s}`;
    if (!hasPort && local) s = s.replace(/^(ws:\/\/[^/]+)/, `$1:${DEFAULT_RELAY_PORT}`);
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new BeamError(`"${input}" is not a valid relay address`);
  }
  if (!u.hostname) throw new BeamError(`"${input}" is not a valid relay address`);
  return u.toString();
}

// ----------------------------------------------------------- channel binding

const EXPORTER_LABEL = 'EXPORTER-beam-room-bind';

/** MAC over this TLS session's exporter secret. `role` is 'dial' or 'accept' so the two sides can't reflect each other's. */
export function bindMac(tlsSocket, authKey, role) {
  const exporter = tlsSocket.exportKeyingMaterial(32, EXPORTER_LABEL);
  return createHmac('sha256', authKey).update(role).update(exporter).digest('hex');
}

export function macEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ------------------------------------------------------------- relay client

/** Wait for the next text message on `ws` (rejects if it closes first or on timeout). */
function nextMessage(ws, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new BeamError('relay did not answer in time')), ms);
    const onText = (t) => {
      try {
        done(null, JSON.parse(t));
      } catch {
        done(new BeamError('relay sent something unreadable'));
      }
    };
    const onClose = () => done(new BeamError('relay closed the connection'));
    const done = (err, msg) => {
      clearTimeout(timer);
      ws.off('text', onText);
      ws.off('close', onClose);
      err ? reject(err) : resolve(msg);
    };
    ws.on('text', onText);
    ws.on('close', onClose);
  });
}

/**
 * One member's presence in a room (the "control" connection), plus helpers to open
 * the pipes through which devices actually talk.
 * Events: 'peer-joined'(mid) 'peer-left'(mid) 'incoming'({pipe, from}) 'close'(err?)
 */
export class RoomClient extends EventEmitter {
  constructor({ url, roomId, mid, token }) {
    super();
    this.url = url;
    this.roomId = roomId;
    this.mid = mid;
    this.token = token ?? undefined;
    this.ws = null;
    this.closed = false;
  }

  /** Join the room. Resolves with the member ids already present (not including ours). */
  async connect() {
    const ws = await wsConnect(this.url);
    this.ws = ws;
    ws.on('error', () => {});
    ws.startKeepalive(20_000);
    ws.resume();
    const reply = nextMessage(ws, 10_000);
    ws.sendText(JSON.stringify({ t: 'join', v: 1, room: this.roomId, mid: this.mid, token: this.token }));
    let msg;
    try {
      msg = await reply;
    } catch (e) {
      ws.destroy();
      throw e;
    }
    if (msg.t === 'error') {
      ws.destroy();
      throw new BeamError(`relay: ${clean(msg.reason) || 'refused'}`);
    }
    if (msg.t !== 'joined' || !Array.isArray(msg.members)) {
      ws.destroy();
      throw new BeamError('that is not a beam relay (unexpected reply)');
    }
    ws.on('text', (t) => this._onText(t));
    ws.once('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close');
      }
    });
    return msg.members.filter((m) => typeof m === 'string' && m !== this.mid);
  }

  _onText(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === 'peer-joined' && typeof m.mid === 'string') this.emit('peer-joined', m.mid);
    else if (m.t === 'peer-left' && typeof m.mid === 'string') this.emit('peer-left', m.mid);
    else if (m.t === 'incoming' && typeof m.pipe === 'string' && typeof m.from === 'string') {
      this.emit('incoming', { pipe: m.pipe, from: m.from });
    }
  }

  async _pipe(first, ms, signal) {
    const ws = await wsConnect(this.url, { signal });
    ws.on('error', () => {});
    ws.startKeepalive(20_000);
    const onAbort = () => ws.destroy();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const reply = nextMessage(ws, ms);
      ws.sendText(JSON.stringify({ v: 1, room: this.roomId, token: this.token, ...first }));
      const msg = await reply;
      if (msg.t === 'error') throw new BeamError(`relay: ${clean(msg.reason) || 'refused'}`);
      if (msg.t !== 'paired') throw new BeamError('unexpected reply from relay');
      return ws;
    } catch (e) {
      ws.destroy();
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Ask the relay to connect us to member `to`; resolves with a byte pipe once they accept. */
  dial(to, signal) {
    return this._pipe({ t: 'dial', from: this.mid, to }, 20_000, signal);
  }

  /** Accept the pipe the relay announced with 'incoming'. */
  accept(pipe) {
    return this._pipe({ t: 'accept', pipe, mid: this.mid }, 10_000);
  }

  close() {
    this.closed = true;
    this.ws?.destroy();
  }
}
