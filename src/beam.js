// The engine: TLS server, peer table, and the send/receive state machines.
// The UI never touches sockets; it reads snapshots (peers(), transfers()) and
// listens for 'change' / 'offer' / 'offer-gone' events.
import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { Discovery, DEFAULT_DISCOVERY_PORT } from './discovery.js';
import { loadOrCreateIdentity, defaultConfigDir } from './identity.js';
import { CHUNK, MAX_FILES, ProtocolError, Reader, VERSION, write, writeFrame } from './protocol.js';
import { numbered, resolveInside, sanitizeRelPath } from './safepath.js';
import { scanPaths } from './scan.js';
import { BeamError, CancelledError, clean, sha256hex, sleep } from './util.js';

export const DEFAULT_PORT = 7878;
const OFFER_TIMEOUT_MS = 120_000;
const MAX_PENDING_OFFERS = 20;
const PEER_TTL_MS = 8000;
const MANUAL_PEER_TTL_MS = 20_000;

// Virtual adapters (VMs, containers, VPNs) are listed last so the address we show
// first is the one another device on the LAN can actually reach.
const VIRTUAL_IFACE = /vmware|virtualbox|vbox|vmnet|hyper-v|vethernet|wsl|docker|veth|virbr|br-|tailscale|zerotier|utun|tun\d|tap|bluetooth|pseudo/i;

export function localAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        found.push({ address: a.address, virtual: VIRTUAL_IFACE.test(name) });
      }
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((a) => a.address);
}

function friendlyNetError(e) {
  switch (e?.code) {
    case 'ECONNREFUSED':
      return new BeamError('connection refused - is beam running there, and is the firewall allowing it?');
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new BeamError('host unreachable');
    case 'ETIMEDOUT':
      return new BeamError('connection timed out');
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new BeamError('could not resolve that host name');
    case 'ECONNRESET':
      return new BeamError('connection reset by peer');
    default:
      return e instanceof Error ? e : new BeamError(String(e));
  }
}

export function parseHostPort(input, defaultPort = DEFAULT_PORT) {
  let s = String(input ?? '').trim();
  if (!s) throw new BeamError('enter an address like 192.168.1.20 or 192.168.1.20:7878');
  s = s.replace(/^[a-z]+:\/\//i, '');
  let host = s;
  let port = defaultPort;
  const bracket = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else if ((s.match(/:/g) || []).length === 1) {
    const [h, p] = s.split(':');
    host = h;
    port = Number(p);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BeamError(`"${input}" is not a valid address`);
  }
  return { host, port };
}

const exists = (p) => fs.access(p).then(() => true, () => false);

/** FileHandle.write may write fewer bytes than asked (e.g. disk nearly full); loop until done. */
async function writeFully(fh, buf) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, null);
    off += bytesWritten;
  }
}

export class Beam extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.name]          name shown to other peers (default: host name)
   * @param {string} [opts.downloadDir]   where received files go
   * @param {number} [opts.port]          TCP port to listen on (default 7878, falls back to a free one)
   * @param {number} [opts.discoveryPort] UDP discovery port
   * @param {string} [opts.configDir]     where the identity is stored
   * @param {boolean} [opts.autoAccept]   accept every incoming offer without asking
   * @param {boolean} [opts.discovery]    set false to rely on manual peers only
   */
  constructor(opts = {}) {
    super();
    this.name = clean(opts.name || os.hostname(), 64) || 'beam';
    this.downloadDir = path.resolve(opts.downloadDir || path.join(os.homedir(), 'Downloads', 'beam'));
    this.preferredPort = opts.port ?? DEFAULT_PORT;
    this.discoveryPort = opts.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    this.configDir = opts.configDir || defaultConfigDir();
    this.autoAccept = !!opts.autoAccept;
    this.useDiscovery = opts.discovery !== false;

    this.identity = null;
    this.port = 0;
    this.discoveryError = null;
    this._peers = new Map();
    this._transfers = new Map();
    this._pending = new Map(); // offer id -> {offer, decide}
    this._sockets = new Set();
    this._nextId = 1;
    this._touchTimer = null;
    this._server = null;
    this._discovery = null;
    this._ticker = null;
    this._stopped = false;
  }

  get fingerprint() {
    return this.identity?.fingerprint;
  }

  async start() {
    this.identity = loadOrCreateIdentity(this.configDir);
    await fs.mkdir(this.downloadDir, { recursive: true });

    this._server = tls.createServer(
      {
        key: this.identity.key,
        cert: this.identity.cert,
        requestCert: true, // mutual TLS: we want the client's certificate fingerprint too
        rejectUnauthorized: false, // identity = fingerprint, not a CA chain
        minVersion: 'TLSv1.3',
        handshakeTimeout: 10_000,
      },
      (sock) => this._onConnection(sock),
    );
    this._server.maxConnections = 100;
    this._server.on('tlsClientError', () => {});
    this._server.on('error', (e) => this.emit('warning', `server: ${e.message}`));
    await this._listen(this.preferredPort).catch((e) => {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      return this._listen(0);
    });
    this.port = this._server.address().port;

    if (this.useDiscovery) {
      this._discovery = new Discovery({
        id: this.identity.fingerprint,
        name: this.name,
        port: this.port,
        discoveryPort: this.discoveryPort,
      });
      this._discovery.on('peer', (p) => this._seen(p));
      this._discovery.on('bye', (id) => {
        const p = this._peers.get(id);
        if (p && !p.manual) {
          this._peers.delete(id);
          this._touch();
        }
      });
      this._discovery.on('error', (e) => {
        this.discoveryError = e.message;
        this.emit('warning', `discovery: ${e.message}`);
      });
      try {
        await this._discovery.start();
      } catch (e) {
        this.discoveryError = e.message;
        this._discovery = null;
        this.emit('warning', `discovery unavailable (${e.message}); add peers by address instead`);
      }
    }

    let tick = 0;
    this._ticker = setInterval(() => {
      this._expirePeers();
      if (++tick % 5 === 0) this._refreshManualPeers();
    }, 1000);
    this._ticker.unref();
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      this._server.once('error', onError);
      this._server.listen(port, '0.0.0.0', () => {
        this._server.off('error', onError);
        resolve();
      });
    });
  }

  async stop() {
    this._stopped = true;
    clearInterval(this._ticker);
    clearTimeout(this._touchTimer);
    for (const t of this._transfers.values()) t.abort?.();
    for (const { decide } of this._pending.values()) decide({ ok: false, reason: 'shutting down' });
    await this._discovery?.stop();
    await new Promise((resolve) => {
      for (const s of this._sockets) s.destroy();
      if (!this._server?.listening) return resolve();
      this._server.close(() => resolve());
    });
  }

  info() {
    return {
      name: this.name,
      fingerprint: this.fingerprint,
      port: this.port,
      addresses: localAddresses(),
      downloadDir: this.downloadDir,
      discovery: !!this._discovery,
    };
  }

  // ---------------------------------------------------------------- peers

  peers() {
    return [...this._peers.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1),
    );
  }

  peer(id) {
    return this._peers.get(id);
  }

  _seen({ id, name, address, port }, manual = false) {
    if (id === this.fingerprint) return;
    let p = this._peers.get(id);
    if (!p) {
      p = { id, name, address, port, lastSeen: 0, manual: false, online: true };
      this._peers.set(id, p);
    }
    Object.assign(p, { name, address, port, lastSeen: Date.now(), online: true });
    if (manual) p.manual = true;
    this._touch();
  }

  _expirePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this._peers) {
      if (p.manual) {
        const online = now - p.lastSeen < MANUAL_PEER_TTL_MS;
        if (online !== p.online) {
          p.online = online;
          changed = true;
        }
      } else if (now - p.lastSeen > PEER_TTL_MS) {
        this._peers.delete(id);
        changed = true;
      }
    }
    if (changed) this._touch();
  }

  _refreshManualPeers() {
    for (const p of this._peers.values()) {
      if (p.manual) this._hello(p.address, p.port, p.id).then((r) => r && this._seen({ ...p, name: r.name }, true), () => {});
    }
  }

  /** Add a peer by address (for networks where broadcast discovery is blocked). */
  async addPeer(input) {
    const { host, port } = parseHostPort(input);
    const r = await this._hello(host, port);
    if (r.fingerprint === this.fingerprint) throw new BeamError('that is this device');
    this._seen({ id: r.fingerprint, name: r.name, address: host, port }, true);
    return this._peers.get(r.fingerprint);
  }

  async _hello(host, port, expectFp) {
    const ctl = new AbortController();
    const { sock, fp } = await this._connect(host, port, expectFp, ctl.signal);
    try {
      const reader = new Reader(sock);
      const timer = setTimeout(() => reader.abort(new BeamError('timed out')), 5000);
      try {
        await writeFrame(sock, { t: 'hello', v: VERSION, name: this.name });
        const reply = await reader.readFrame();
        if (reply.t !== 'hello') throw new ProtocolError('unexpected reply');
        return { name: clean(reply.name, 64) || 'unnamed', fingerprint: fp };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      sock.destroy();
    }
  }

  // ------------------------------------------------------------ transfers

  transfers() {
    return [...this._transfers.values()].sort((a, b) => b.id - a.id);
  }

  clearFinished() {
    for (const [id, t] of this._transfers) if (!isActive(t)) this._transfers.delete(id);
    this._touch();
  }

  cancel(id) {
    this._transfers.get(id)?.abort?.();
  }

  _newTransfer(fields) {
    const t = {
      id: this._nextId++,
      dir: 'send',
      peerId: '',
      peerName: '',
      status: 'preparing',
      error: null,
      label: '',
      files: 0,
      filesDone: 0,
      total: 0,
      done: 0,
      speed: 0,
      startedAt: null,
      endedAt: null,
      current: '',
      note: '',
      savedTo: null,
      abort: null,
      _sampleAt: 0,
      _sampleBytes: 0,
      ...fields,
    };
    this._transfers.set(t.id, t);
    this._touch();
    return t;
  }

  _finish(t, status, error = null) {
    t.status = status;
    t.error = error;
    t.endedAt = Date.now();
    t.speed = 0;
    t.abort = null;
    this._touch();
  }

  _progress(t, n) {
    t.done += n;
    const now = performance.now();
    if (!t._sampleAt) {
      t._sampleAt = now;
      t._sampleBytes = t.done - n;
    }
    const dt = now - t._sampleAt;
    if (dt >= 250) {
      const inst = ((t.done - t._sampleBytes) * 1000) / dt;
      t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst;
      t._sampleAt = now;
      t._sampleBytes = t.done;
    }
    this._touch();
  }

  _touch() {
    if (this._touchTimer || this._stopped) return;
    this._touchTimer = setTimeout(() => {
      this._touchTimer = null;
      this.emit('change');
    }, 40);
    this._touchTimer.unref?.();
  }

  // --------------------------------------------------------------- sending

  /** Start sending files/folders to a peer. Returns the transfer record immediately. */
  send(peerId, paths) {
    const peer = this._peers.get(peerId);
    if (!peer) throw new BeamError('that peer is no longer available');
    if (!paths?.length) throw new BeamError('nothing selected');
    const t = this._newTransfer({
      dir: 'send',
      peerId: peer.id,
      peerName: peer.name,
      label: paths.length === 1 ? path.basename(paths[0]) || paths[0] : `${paths.length} items`,
    });
    this._runSend(t, { ...peer }, paths).catch((err) => this._finish(t, 'failed', err.message));
    return t;
  }

  async _runSend(t, peer, paths) {
    const ac = new AbortController();
    t.abort = () => ac.abort();
    let sock;
    try {
      const scan = await scanPaths(paths, ac.signal);
      if (scan.entries.length === 0) throw new BeamError('nothing readable to send');
      t.files = scan.fileCount;
      t.total = scan.total;
      if (scan.skipped) t.note = `${scan.skipped} item(s) skipped (unreadable or links)`;
      if (paths.length === 1 && scan.fileCount > 1) t.label = `${t.label} (${scan.fileCount} files)`;

      t.status = 'waiting';
      this._touch();
      ({ sock } = await this._connect(peer.address, peer.port, peer.id, ac.signal));
      this._sockets.add(sock);
      sock.on('close', () => this._sockets.delete(sock));
      const reader = new Reader(sock);
      ac.signal.addEventListener('abort', () => {
        reader.abort(new CancelledError());
        sock.destroy();
      });

      await writeFrame(sock, {
        t: 'offer',
        v: VERSION,
        name: this.name,
        files: scan.entries.map((e) => (e.d ? { p: e.p, d: true } : { p: e.p, s: e.s, m: e.m })),
      });
      const reply = await reader.readFrame();
      if (reply.t !== 'reply') throw new ProtocolError('unexpected reply from peer');
      if (!reply.ok) return this._finish(t, 'rejected', clean(reply.reason) || 'declined');

      t.status = 'active';
      t.startedAt = Date.now();
      this._touch();

      // The receiver may abort early by sending a result frame; watch for it while we stream.
      const stop = new AbortController();
      const resultP = reader.readFrame().catch((e) => e);
      resultP.then(() => stop.abort());
      try {
        await this._stream(sock, t, scan.entries, stop.signal);
      } catch (err) {
        if (ac.signal.aborted) throw new CancelledError();
        const r = await Promise.race([resultP, sleep(1500)]);
        if (r && r.t === 'result' && r.ok === false) {
          const why = clean(r.error) || 'aborted';
          // The receiver cancelling on purpose is a cancellation, not a failure.
          throw why === 'cancelled by receiver' ? new CancelledError(why) : new BeamError(`receiver: ${why}`);
        }
        throw err;
      }
      const final = await Promise.race([
        resultP,
        sleep(60_000).then(() => new BeamError('receiver did not confirm the transfer')),
      ]);
      if (final instanceof Error) throw final;
      if (final.t !== 'result' || !final.ok) throw new BeamError(`receiver: ${clean(final.error) || 'failed'}`);
      this._finish(t, 'done');
    } catch (err) {
      if (err instanceof CancelledError || ac.signal.aborted) {
        this._finish(t, 'cancelled', ac.signal.aborted ? null : err.message);
      }
      else this._finish(t, 'failed', friendlyNetError(err).message);
    } finally {
      sock?.destroy();
    }
  }

  async _stream(sock, t, entries, signal) {
    for (const e of entries) {
      if (e.d) continue;
      t.current = e.p;
      const fh = await fs.open(e.abs, 'r');
      try {
        const hash = createHash('sha256');
        let remaining = e.s;
        while (remaining > 0) {
          if (signal.aborted) throw new BeamError('connection closed');
          const buf = Buffer.allocUnsafe(Math.min(CHUNK, remaining));
          const { bytesRead } = await fh.read(buf, 0, buf.length, null);
          if (bytesRead === 0) throw new BeamError(`file changed while sending: ${e.p}`);
          const out = bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
          hash.update(out);
          await write(sock, out);
          remaining -= bytesRead;
          this._progress(t, bytesRead);
        }
        await write(sock, hash.digest());
        t.filesDone++;
      } finally {
        await fh.close();
      }
    }
  }

  _connect(host, port, expectFp, signal) {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({
        host,
        port,
        key: this.identity.key,
        cert: this.identity.cert,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined,
      });
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(friendlyNetError(e));
      };
      const timer = setTimeout(() => fail(new BeamError('connection timed out')), 6000);
      sock.once('error', fail);
      if (signal?.aborted) return fail(new CancelledError());
      signal?.addEventListener('abort', () => fail(new CancelledError()), { once: true });
      sock.once('secureConnect', () => {
        if (settled) return;
        const cert = sock.getPeerCertificate();
        const fp = cert?.raw ? sha256hex(cert.raw) : null;
        if (!fp) return fail(new BeamError('peer presented no certificate'));
        if (expectFp && fp !== expectFp) {
          return fail(new BeamError('identity mismatch - that is not the device that announced itself (possible impersonation)'));
        }
        settled = true;
        clearTimeout(timer);
        sock.off('error', fail);
        sock.on('error', () => {}); // later errors surface through the Reader
        resolve({ sock, fp });
      });
    });
  }

  // ------------------------------------------------------------- receiving

  async _onConnection(sock) {
    this._sockets.add(sock);
    sock.on('close', () => this._sockets.delete(sock));
    sock.on('error', () => {});
    const cert = sock.getPeerCertificate();
    if (!cert?.raw) return sock.destroy();
    const fp = sha256hex(cert.raw);
    const reader = new Reader(sock);
    const timer = setTimeout(() => reader.abort(new BeamError('timed out')), 10_000);
    try {
      const first = await reader.readFrame();
      clearTimeout(timer);
      reader.aborted = null;
      if (first.t === 'hello') {
        await writeFrame(sock, { t: 'hello', v: VERSION, name: this.name });
        sock.end();
      } else if (first.t === 'offer') {
        await this._handleOffer(sock, reader, fp, first);
      } else {
        sock.destroy();
      }
    } catch {
      clearTimeout(timer);
      sock.destroy();
    }
  }

  _planOffer(msg) {
    if (msg.v !== VERSION) throw new ProtocolError(`incompatible version (peer ${msg.v}, us ${VERSION})`);
    if (!Array.isArray(msg.files) || msg.files.length === 0) throw new ProtocolError('empty offer');
    if (msg.files.length > MAX_FILES) throw new ProtocolError('too many files');
    const entries = [];
    const groups = new Map();
    let total = 0;
    let fileCount = 0;
    for (const f of msg.files) {
      if (!f || typeof f !== 'object') throw new ProtocolError('malformed offer');
      const segs = sanitizeRelPath(f.p);
      if (!segs) throw new ProtocolError('offer contains an unsafe path');
      const isDir = f.d === true;
      let size = 0;
      if (!isDir) {
        if (!Number.isSafeInteger(f.s) || f.s < 0) throw new ProtocolError('malformed file size');
        size = f.s;
        total += size;
        if (!Number.isSafeInteger(total)) throw new ProtocolError('malformed file size');
        fileCount++;
      }
      const mtime = Number.isFinite(f.m) && f.m > 0 && f.m < 4e12 ? f.m : null;
      entries.push({ segs, dir: isDir, size, mtime });
      const top = clean(segs[0], 120);
      const g = groups.get(top) ?? { name: top, folder: false, files: 0, bytes: 0 };
      g.folder ||= segs.length > 1 || isDir;
      if (!isDir) {
        g.files++;
        g.bytes += size;
      }
      groups.set(top, g);
    }
    return { entries, total, fileCount, groups: [...groups.values()] };
  }

  async _handleOffer(sock, reader, fp, msg) {
    const reject = async (reason) => {
      try {
        await writeFrame(sock, { t: 'reply', ok: false, reason });
        sock.end();
      } catch {
        sock.destroy();
      }
    };
    let plan;
    try {
      plan = this._planOffer(msg);
    } catch (e) {
      return reject(e.message);
    }
    if (this._pending.size >= MAX_PENDING_OFFERS) return reject('receiver is busy');

    const known = this._peers.get(fp);
    const remoteAddr = (sock.remoteAddress || '').replace(/^::ffff:/, '');
    const offer = {
      id: this._nextId++,
      peerId: fp,
      peerName: known?.name ?? (clean(msg.name, 64) || 'unknown device'),
      known: !!known,
      address: remoteAddr,
      fingerprint: fp,
      count: plan.fileCount,
      total: plan.total,
      items: plan.groups.slice(0, 6),
      more: Math.max(0, plan.groups.length - 6),
      downloadDir: this.downloadDir,
    };

    const decision = await new Promise((resolve) => {
      let timer;
      const decide = (d) => {
        clearTimeout(timer);
        this._pending.delete(offer.id);
        resolve(d);
      };
      this._pending.set(offer.id, { offer, decide });
      timer = setTimeout(() => decide({ ok: false, reason: 'no response from the receiver' }), OFFER_TIMEOUT_MS);
      reader.onEnd(() => decide({ ok: false, withdrawn: true }));
      if (this.autoAccept) queueMicrotask(() => decide({ ok: true }));
      else this.emit('offer', offer);
    });
    this.emit('offer-gone', offer.id);

    if (decision.withdrawn) return sock.destroy();
    if (!decision.ok) return reject(decision.reason || 'declined');

    const t = this._newTransfer({
      dir: 'recv',
      peerId: fp,
      peerName: offer.peerName,
      status: 'active',
      label:
        plan.groups.length === 1
          ? plan.groups[0].name + (plan.fileCount > 1 ? ` (${plan.fileCount} files)` : '')
          : `${plan.groups.length} items (${plan.fileCount} files)`,
      files: plan.fileCount,
      total: plan.total,
      startedAt: Date.now(),
      savedTo: this.downloadDir,
    });
    try {
      await writeFrame(sock, { t: 'reply', ok: true });
    } catch (e) {
      return this._finish(t, 'failed', friendlyNetError(e).message);
    }
    await this._receive(sock, reader, t, plan);
  }

  /** Pick a free final name and open "<name>.part" exclusively next to it. */
  async _reserve(segs) {
    const base = resolveInside(this.downloadDir, segs);
    if (!base) throw new ProtocolError('unsafe path');
    const dir = path.dirname(base);
    await fs.mkdir(dir, { recursive: true });
    const file = path.basename(base);
    for (let n = 0; n < 10_000; n++) {
      const final = path.join(dir, numbered(file, n));
      if (await exists(final)) continue;
      try {
        const part = final + '.part';
        return { final, part, fh: await fs.open(part, 'wx') };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new BeamError('could not find a free file name');
  }

  async _receive(sock, reader, t, plan) {
    const ac = new AbortController();
    t.abort = () => ac.abort();
    ac.signal.addEventListener('abort', () => reader.abort(new CancelledError()));
    let current = null;
    try {
      for (const e of plan.entries) {
        if (e.dir) {
          const dir = resolveInside(this.downloadDir, e.segs);
          if (!dir) throw new ProtocolError('unsafe path');
          await fs.mkdir(dir, { recursive: true });
          continue;
        }
        t.current = e.segs.join('/');
        current = await this._reserve(e.segs);
        const hash = createHash('sha256');
        let remaining = e.size;
        while (remaining > 0) {
          const chunk = await reader.readSome(Math.min(CHUNK, remaining));
          hash.update(chunk);
          await writeFully(current.fh, chunk);
          remaining -= chunk.length;
          this._progress(t, chunk.length);
        }
        const trailer = await reader.readExact(32);
        const digest = hash.digest();
        if (!timingSafeEqual(trailer, digest)) {
          throw new BeamError(`checksum mismatch for "${clean(t.current, 80)}" - file discarded`);
        }
        await current.fh.close();
        await fs.rename(current.part, current.final);
        if (e.mtime) await fs.utimes(current.final, new Date(), new Date(e.mtime)).catch(() => {});
        current = null;
        t.filesDone++;
        t.savedTo = this.downloadDir;
      }
      await writeFrame(sock, { t: 'result', ok: true });
      sock.end();
      this._finish(t, 'done');
    } catch (err) {
      if (current) {
        await current.fh.close().catch(() => {});
        await fs.unlink(current.part).catch(() => {});
      }
      const cancelled = err instanceof CancelledError || ac.signal.aborted;
      const message = cancelled
        ? 'cancelled by receiver'
        : /closed by peer|ECONNRESET/.test(err.message)
          ? 'sender cancelled or the connection was lost'
          : err.message;
      this._finish(t, cancelled ? 'cancelled' : 'failed', cancelled ? null : message);
      // Tell the sender why, then keep reading for a moment so the message
      // isn't lost to a TCP reset caused by closing with unread data.
      try {
        await writeFrame(sock, { t: 'result', ok: false, error: message });
      } catch {
        /* peer already gone */
      }
      reader.drain();
      sock.end();
      setTimeout(() => sock.destroy(), 1500).unref();
    }
  }

  // ---------------------------------------------------------------- offers

  pendingOffers() {
    return [...this._pending.values()].map((p) => p.offer);
  }

  respond(offerId, accept, reason) {
    this._pending.get(offerId)?.decide(accept ? { ok: true } : { ok: false, reason: reason || 'declined' });
  }
}

export function isActive(t) {
  return t.status === 'preparing' || t.status === 'waiting' || t.status === 'active';
}
