// A minimal RFC 6455 WebSocket (binary + text frames, ping/pong, close), just enough
// for the relay: it lets the relay run on any host that can serve HTTP and lets
// clients get through ordinary web ports. WsConn is a Duplex, so a pair of them can be
// piped together and TLS can run on top of one.
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { BeamError } from './util.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const WRITE_CHUNK = 64 * 1024;
const MAX_FRAME = 1024 * 1024;
const MAX_MESSAGE = 8 * 1024 * 1024;

export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

class WsProtocolError extends Error {
  constructor(message, code = 1002) {
    super(message);
    this.closeCode = code;
  }
}

function xorMask(data, mask) {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i & 3];
  return out;
}

/** Encode one frame. Client frames must be masked, server frames must not be. */
export function encodeFrame(opcode, payload, { mask = false, fin = true } = {}) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = (mask ? 0x80 : 0) | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = (mask ? 0x80 : 0) | 127;
    head.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  if (!mask) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  return Buffer.concat([head, key, xorMask(payload, key)]);
}

export class WsConn extends Duplex {
  /**
   * @param {import('node:stream').Duplex} socket  the raw connection, after the HTTP upgrade
   * @param {{client: boolean}} o
   * Binary frames become the stream's data; text frames are emitted as 'text' events.
   */
  constructor(socket, { client }) {
    super({ allowHalfOpen: false, highWaterMark: 256 * 1024 });
    this.socket = socket;
    this.client = client;
    this._buf = Buffer.alloc(0);
    this._frag = null;
    this._closeSent = false;
    this._lastRx = Date.now();
    this._keepalive = null;
    this._sawEnd = false;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => {
      // The peer hung up. Don't discard what it sent last: finish reading it, then end.
      this._sawEnd = true;
      this.push(null);
    });
    socket.on('error', (err) => this.destroy(err));
    socket.on('close', () => {
      // After a clean 'end' with unread data still buffered, let the reader drain it first
      // (the stream then finishes and destroys itself). Otherwise there is nothing to wait for.
      if (!this._sawEnd || this.readableLength === 0) this.destroy();
    });
    socket.setNoDelay?.(true);
  }

  // ---- incoming

  _onData(chunk) {
    this._lastRx = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      while (this._parseFrame()) {
        /* keep going while whole frames are buffered */
      }
    } catch (err) {
      this._fail(err);
    }
  }

  _parseFrame() {
    const b = this._buf;
    if (b.length < 2) return false;
    if (b[0] & 0x70) throw new WsProtocolError('reserved bits set');
    const fin = !!(b[0] & 0x80);
    const opcode = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) throw new WsProtocolError('frame too large', 1009);
      len = b.readUInt32BE(6);
      off = 10;
    }
    if (len > MAX_FRAME) throw new WsProtocolError('frame too large', 1009);
    if (masked === this.client) throw new WsProtocolError('bad masking'); // clients mask, servers don't
    if (opcode >= 8 && (!fin || len > 125)) throw new WsProtocolError('bad control frame');
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return false;
    let payload = b.subarray(off + maskLen, off + maskLen + len);
    if (masked) payload = xorMask(payload, b.subarray(off, off + 4));
    this._buf = b.subarray(off + maskLen + len);
    this._onFrame(fin, opcode, payload);
    return true;
  }

  _onFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP.PING:
        return void this._send(OP.PONG, payload);
      case OP.PONG:
        return;
      case OP.CLOSE:
        this._sendClose(1000);
        this.push(null);
        return void this.socket.end();
      case OP.TEXT:
      case OP.BINARY:
        if (this._frag) throw new WsProtocolError('new message inside a fragmented one');
        if (fin) return this._deliver(opcode, payload);
        this._frag = { opcode, chunks: [payload], size: payload.length };
        return;
      case OP.CONT: {
        if (!this._frag) throw new WsProtocolError('unexpected continuation');
        this._frag.chunks.push(payload);
        this._frag.size += payload.length;
        if (this._frag.size > MAX_MESSAGE) throw new WsProtocolError('message too large', 1009);
        if (fin) {
          const { opcode: op, chunks } = this._frag;
          this._frag = null;
          this._deliver(op, Buffer.concat(chunks));
        }
        return;
      }
      default:
        throw new WsProtocolError('unknown opcode');
    }
  }

  _deliver(opcode, data) {
    if (opcode === OP.TEXT) return void this.emit('text', data.toString('utf8'));
    if (!this.push(data)) this.socket.pause(); // backpressure: resumed in _read()
  }

  _fail(err) {
    this._sendClose(err.closeCode ?? 1002);
    this.destroy(err);
  }

  _read() {
    this.socket.resume();
  }

  // ---- outgoing

  _send(opcode, payload, cb) {
    if (this.socket.destroyed || !this.socket.writable) return void cb?.();
    this.socket.write(encodeFrame(opcode, payload, { mask: this.client }), cb);
  }

  _sendClose(code) {
    if (this._closeSent) return;
    this._closeSent = true;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code);
    this._send(OP.CLOSE, body);
  }

  sendText(str) {
    this._send(OP.TEXT, Buffer.from(str, 'utf8'));
  }

  sendPing() {
    this._send(OP.PING, Buffer.alloc(0));
  }

  _write(chunk, _enc, cb) {
    if (chunk.length <= WRITE_CHUNK) return void this._send(OP.BINARY, chunk, cb);
    let off = 0;
    const next = (err) => {
      if (err || off >= chunk.length) return cb(err);
      const part = chunk.subarray(off, (off += WRITE_CHUNK));
      this._send(OP.BINARY, part, next);
    };
    next();
  }

  _final(cb) {
    this._sendClose(1000);
    // Finished means flushed: wait for the queued frames and our FIN to leave before reporting done.
    this.socket.end(() => cb());
  }

  _destroy(err, cb) {
    clearInterval(this._keepalive);
    this.socket.destroy();
    cb(err);
  }

  /** Ping every `ms`; drop the connection if nothing at all arrives for 2.5 intervals. */
  startKeepalive(ms = 20_000) {
    this._keepalive = setInterval(() => {
      if (Date.now() - this._lastRx > ms * 2.5) return void this.destroy(new BeamError('keepalive timeout'));
      this.sendPing();
    }, ms);
    this._keepalive.unref();
  }
}

// ----------------------------------------------------------------- handshakes

/** Server side of the upgrade: call from an http.Server 'upgrade' handler. Returns a WsConn or null. */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const ok =
    String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    typeof key === 'string' &&
    req.headers['sec-websocket-version'] === '13';
  if (!ok) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const conn = new WsConn(socket, { client: false });
  // Frames that arrived with the upgrade are handled after the caller has attached its listeners.
  if (head?.length) setImmediate(() => conn._onData(head));
  return conn;
}

/** Client side: connect to ws:// or wss://, perform the upgrade, resolve with a WsConn. */
export function wsConnect(url, { timeout = 8000, signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new BeamError(`"${url}" is not a valid relay address`));
    }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return reject(new BeamError('relay address must start with ws:// or wss://'));
    const secure = u.protocol === 'wss:';
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port) || (secure ? 443 : 80);
    const sock = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });

    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err instanceof Error ? err : new BeamError(String(err)));
    };
    const timer = setTimeout(() => fail(new BeamError('relay connection timed out')), timeout);
    sock.once('error', (e) => fail(relayNetError(e)));
    if (signal?.aborted) return fail(new BeamError('cancelled'));
    signal?.addEventListener('abort', () => fail(new BeamError('cancelled')), { once: true });

    const key = randomBytes(16).toString('base64');
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.write(
        `GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          Object.entries(headers)
            .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, '')}\r\n`)
            .join('') +
          '\r\n',
      );
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 16 * 1024) fail(new BeamError('relay sent an oversized response'));
        return;
      }
      sock.off('data', onData);
      const head = buf.subarray(0, end).toString('latin1');
      const status = head.split('\r\n')[0];
      const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim();
      if (!/^HTTP\/1\.1 101/.test(status) || accept !== acceptKey(key)) {
        return fail(new BeamError(/^HTTP\/1\.1 (\d+)/.test(status) ? `relay refused the connection (${status.slice(9)})` : 'that address is not a beam relay'));
      }
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners('error');
      const conn = new WsConn(sock, { client: true });
      const rest = buf.subarray(end + 4);
      if (rest.length) setImmediate(() => conn._onData(rest));
      resolve(conn);
    };
    sock.on('data', onData);
  });
}

function relayNetError(e) {
  switch (e?.code) {
    case 'ECONNREFUSED': return new BeamError('relay refused the connection - is it running, and is the address/port right?');
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return new BeamError('could not resolve the relay host name');
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return new BeamError('could not reach the relay');
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID': return new BeamError(`relay certificate problem (${e.code})`);
    default: return e instanceof Error ? e : new BeamError(String(e));
  }
}
