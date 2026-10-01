// Wire format. After the TLS handshake every connection carries:
//   frame   = uint32 big-endian length + UTF-8 JSON
//   client -> server:  {t:'hello'}  or  {t:'offer', files:[...]}
//   server -> client:  {t:'hello', name}  or  {t:'reply', ok, reason?}
// After an accepted offer the sender streams, for each file in order, exactly
// `s` raw bytes followed by their 32-byte SHA-256. The receiver ends with
// {t:'result', ok, error?}, which it may also send early to abort the transfer.
import { BeamError, CancelledError } from './util.js';

export const VERSION = 1;
export const MAX_FRAME = 32 * 1024 * 1024; // an offer listing 100k files is a few MB
export const MAX_FILES = 100_000;
export const CHUNK = 256 * 1024;
const BUFFER_HIGH_WATER = 2 * 1024 * 1024;

export class ProtocolError extends BeamError {}

export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_FRAME) throw new ProtocolError('message too large');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Write with backpressure; rejects if the connection dies meanwhile. */
export function write(sock, buf) {
  return new Promise((resolve, reject) => {
    if (sock.destroyed) return reject(new BeamError('connection closed'));
    const onClose = () => reject(new BeamError('connection closed'));
    sock.once('close', onClose);
    sock.write(buf, (err) => {
      sock.off('close', onClose);
      err ? reject(err) : resolve();
    });
  });
}

export function writeFrame(sock, obj) {
  return write(sock, encodeFrame(obj));
}

/**
 * Pull-based reader over a socket: lets us mix length-prefixed frames and raw
 * file bytes on one connection, with TCP backpressure when the consumer is slow.
 */
export class Reader {
  constructor(sock) {
    this.sock = sock;
    this.chunks = [];
    this.len = 0;
    this.ended = false;
    this.error = null;
    this.discard = false;
    this._waiter = null;
    this._endListeners = [];

    sock.on('data', (c) => {
      if (this.discard) return;
      this.chunks.push(c);
      this.len += c.length;
      if (this.len > BUFFER_HIGH_WATER) sock.pause();
      this._wake();
    });
    const finish = (err) => {
      if (err && !this.error) this.error = err;
      if (!this.ended) {
        this.ended = true;
        for (const fn of this._endListeners) fn();
      }
      this._wake();
    };
    sock.on('end', () => finish());
    sock.on('close', () => finish());
    sock.on('error', (e) => finish(e));
  }

  /** Call `fn` once the peer closes the connection. */
  onEnd(fn) {
    if (this.ended) queueMicrotask(fn);
    else this._endListeners.push(fn);
  }

  /** Make every pending and future read fail with `err`. */
  abort(err = new CancelledError()) {
    this.aborted = err;
    this._wake();
  }

  /** Throw away anything further received (used while draining after a cancel). */
  drain() {
    this.discard = true;
    this.chunks = [];
    this.len = 0;
    this.sock.resume();
  }

  _wake() {
    const w = this._waiter;
    this._waiter = null;
    if (w) w();
  }

  async _waitFor(enough) {
    while (!enough()) {
      if (this.aborted) throw this.aborted;
      if (this.ended) {
        throw this.error && this.error.code !== 'ECONNRESET'
          ? this.error
          : new BeamError('connection closed by peer');
      }
      if (this.sock.isPaused() && this.len <= BUFFER_HIGH_WATER) this.sock.resume();
      await new Promise((r) => (this._waiter = r));
    }
    if (this.aborted) throw this.aborted;
  }

  _take(n) {
    const first = this.chunks[0];
    let out;
    if (first.length === n) {
      out = this.chunks.shift();
    } else if (first.length > n) {
      out = first.subarray(0, n);
      this.chunks[0] = first.subarray(n);
    } else {
      const parts = [];
      let need = n;
      while (need > 0) {
        const c = this.chunks[0];
        if (c.length <= need) {
          parts.push(this.chunks.shift());
          need -= c.length;
        } else {
          parts.push(c.subarray(0, need));
          this.chunks[0] = c.subarray(need);
          need = 0;
        }
      }
      out = Buffer.concat(parts, n);
    }
    this.len -= n;
    if (this.sock.isPaused() && this.len <= BUFFER_HIGH_WATER / 2) this.sock.resume();
    return out;
  }

  /** Exactly `n` bytes. */
  async readExact(n) {
    if (n === 0) return Buffer.alloc(0);
    await this._waitFor(() => this.len >= n);
    return this._take(n);
  }

  /**
   * Between 1 and `max` bytes: whatever is buffered right now, coalesced so the
   * caller does few large disk writes instead of one per ~16 KB TLS record.
   */
  async readSome(max) {
    await this._waitFor(() => this.len > 0);
    return this._take(Math.min(max, this.len));
  }

  async readFrame() {
    const head = await this.readExact(4);
    const n = head.readUInt32BE();
    if (n > MAX_FRAME) throw new ProtocolError('message too large');
    const body = await this.readExact(n);
    try {
      const msg = JSON.parse(body.toString('utf8'));
      if (msg === null || typeof msg !== 'object') throw new Error('not an object');
      return msg;
    } catch {
      throw new ProtocolError('malformed message');
    }
  }
}
