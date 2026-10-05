// The engine. One Beam object is one running device: it owns this device's identity,
// listens for incoming connections, remembers the peers found on the LAN, and keeps
// the list of transfers. The actual sending and receiving live in send.js / receive.js.
//
// The UI never touches sockets. It reads peers() / transfers() and listens for events:
//   'change'      something visible changed (batched, so the UI redraws at most ~25x/s)
//   'offer'       someone wants to send us files: show a prompt, then call respond()
//   'offer-gone'  that offer is no longer waiting for an answer
//   'warning'     something worth telling the user (e.g. discovery could not start)
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { Discovery, DEFAULT_DISCOVERY_PORT } from './discovery.js';
import { defaultConfigDir, loadOrCreateIdentity } from './identity.js';
import { receiveFiles } from './receive.js';
import { sendFiles } from './send.js';
import { BeamError, clean } from './util.js';

export const DEFAULT_PORT = 7878;
const PEER_TTL_MS = 8000; // a peer that stops announcing itself disappears after this long
const OFFER_TIMEOUT_MS = 120_000; // an unanswered "accept?" prompt gives up after this long
const MAX_PENDING_OFFERS = 20; // so a misbehaving device can't flood the user with prompts

export const isActive = (t) => t.status === 'preparing' || t.status === 'waiting' || t.status === 'active';

// Virtual adapters (VMs, containers, VPNs) are listed last, so the address shown first
// is the one another device on the LAN can actually reach.
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

export class Beam extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name]          name shown to other devices (default: the computer's name)
   * @param {string} [opts.downloadDir]   where received files go
   * @param {number} [opts.port]          TCP port to listen on (default 7878, or any free port if taken)
   * @param {number} [opts.discoveryPort] UDP port used to find other devices
   * @param {string} [opts.configDir]     where this device's identity is stored
   * @param {boolean} [opts.discovery]    false = don't broadcast or listen (tests add peers by hand)
   */
  constructor(opts = {}) {
    super();
    this.name = clean(opts.name || os.hostname(), 64) || 'beam';
    this.downloadDir = path.resolve(opts.downloadDir || path.join(os.homedir(), 'Downloads', 'beam'));
    this.preferredPort = opts.port ?? DEFAULT_PORT;
    this.discoveryPort = opts.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    this.configDir = opts.configDir || defaultConfigDir();
    this.useDiscovery = opts.discovery !== false;

    this.identity = null; // {cert, key, fingerprint}
    this.port = 0;
    this.discoveryError = null;

    this._peers = new Map(); //     fingerprint -> {id, name, address, port, lastSeen}
    this._transfers = new Map(); // id -> transfer record (see newTransfer)
    this._pending = new Map(); //   offer id -> {offer, decide}: prompts waiting for the user
    this._sockets = new Set(); //   every open connection, so stop() can close them
    this._lastId = 0;
    this._changeTimer = null;
    this._expiryTimer = null;
    this._server = null;
    this._discovery = null;
    this._stopped = false;
  }

  get fingerprint() {
    return this.identity?.fingerprint;
  }

  // ------------------------------------------------------------ start / stop

  async start() {
    this.identity = loadOrCreateIdentity(this.configDir);
    await fs.mkdir(this.downloadDir, { recursive: true });

    // Mutual TLS 1.3: both sides present a certificate, and a device's identity is the
    // fingerprint of its certificate (not a CA chain), so no certificate authority is involved.
    this._server = tls.createServer(
      {
        key: this.identity.key,
        cert: this.identity.cert,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        handshakeTimeout: 10_000,
      },
      (sock) => receiveFiles(this, sock),
    );
    this._server.maxConnections = 100;
    this._server.on('tlsClientError', () => {}); // a failed handshake is just a dropped connection
    this._server.on('error', (e) => this.emit('warning', `server: ${e.message}`));
    await this._listen(this.preferredPort).catch((e) => {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      return this._listen(0); // port taken (e.g. a second copy on this computer): pick any free one
    });
    this.port = this._server.address().port;

    if (this.useDiscovery) await this._startDiscovery();
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(port, '0.0.0.0', () => {
        this._server.off('error', reject);
        resolve();
      });
    });
  }

  async _startDiscovery() {
    this._discovery = new Discovery({
      id: this.identity.fingerprint,
      name: this.name,
      port: this.port,
      discoveryPort: this.discoveryPort,
    });
    this._discovery.on('peer', (p) => this.foundPeer(p));
    this._discovery.on('bye', (id) => {
      if (this._peers.delete(id)) this.changed();
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
      this.emit('warning', `discovery unavailable (${e.message})`);
      return;
    }
    // Peers are refreshed by every announcement, so one that goes quiet is gone.
    this._expiryTimer = setInterval(() => {
      const now = Date.now();
      let removed = false;
      for (const [id, p] of this._peers) {
        if (now - p.lastSeen > PEER_TTL_MS) removed = this._peers.delete(id);
      }
      if (removed) this.changed();
    }, 1000);
    this._expiryTimer.unref();
  }

  async stop() {
    this._stopped = true;
    clearInterval(this._expiryTimer);
    clearTimeout(this._changeTimer);
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
    };
  }

  // ------------------------------------------------------------------ peers

  peers() {
    return [...this._peers.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }

  /** A device announced itself (discovery calls this; tests call it directly). */
  foundPeer({ id, name, address, port }) {
    if (id === this.fingerprint) return null; // our own broadcast
    const peer = { id, name, address, port, lastSeen: Date.now() };
    this._peers.set(id, peer);
    this.changed();
    return peer;
  }

  // -------------------------------------------------------------- transfers

  transfers() {
    return [...this._transfers.values()].sort((a, b) => b.id - a.id);
  }

  /** Start sending files/folders to a peer. Returns the transfer record straight away. */
  send(peerId, paths) {
    const peer = this._peers.get(peerId);
    if (!peer) throw new BeamError('that peer is no longer available');
    if (!paths?.length) throw new BeamError('nothing selected');
    const t = this.newTransfer({
      dir: 'send',
      peerName: peer.name,
      label: paths.length === 1 ? path.basename(paths[0]) || paths[0] : `${paths.length} items`,
    });
    sendFiles(this, t, { ...peer }, paths).catch((err) => this.finish(t, 'failed', err.message));
    return t;
  }

  cancel(id) {
    this._transfers.get(id)?.abort?.();
  }

  clearFinished() {
    for (const [id, t] of this._transfers) if (!isActive(t)) this._transfers.delete(id);
    this.changed();
  }

  // The three methods below are used by send.js and receive.js to keep a transfer's record up to date.

  newTransfer(fields) {
    const t = {
      id: this.nextId(),
      dir: 'send', //        'send' or 'recv'
      peerName: '',
      status: 'preparing', // preparing -> waiting -> active -> done | failed | rejected | cancelled
      error: null,
      label: '',
      files: 0, //           number of files, and how many are finished
      filesDone: 0,
      total: 0, //           bytes to move, and how many have moved
      done: 0,
      speed: 0, //           bytes/second, smoothed
      startedAt: null,
      endedAt: null,
      note: '',
      savedTo: null,
      abort: null, //        call to cancel while it is running
      _sampleAt: 0,
      _sampleBytes: 0,
      ...fields,
    };
    this._transfers.set(t.id, t);
    this.changed();
    return t;
  }

  finish(t, status, error = null) {
    Object.assign(t, { status, error, endedAt: Date.now(), speed: 0, abort: null });
    this.changed();
  }

  progress(t, bytes) {
    t.done += bytes;
    const now = performance.now();
    if (!t._sampleAt) {
      t._sampleAt = now;
      t._sampleBytes = t.done - bytes;
    }
    if (now - t._sampleAt >= 250) {
      const current = ((t.done - t._sampleBytes) * 1000) / (now - t._sampleAt);
      t.speed = t.speed ? t.speed * 0.6 + current * 0.4 : current;
      t._sampleAt = now;
      t._sampleBytes = t.done;
    }
    this.changed();
  }

  // ----------------------------------------------------------------- offers

  /**
   * Show an incoming offer to the user and wait for the answer: {ok: true} or {ok: false, reason}.
   * `reader` is the connection's Reader: if the sender hangs up first, the prompt is withdrawn.
   */
  ask(offer, reader) {
    if (this._pending.size >= MAX_PENDING_OFFERS) return Promise.resolve({ ok: false, reason: 'receiver is busy' });
    return new Promise((resolve) => {
      const decide = (answer) => {
        clearTimeout(timer);
        this._pending.delete(offer.id);
        this.emit('offer-gone', offer.id);
        resolve(answer);
      };
      const timer = setTimeout(() => decide({ ok: false, reason: 'no response from the receiver' }), OFFER_TIMEOUT_MS);
      this._pending.set(offer.id, { offer, decide });
      reader.onEnd(() => decide({ ok: false, withdrawn: true }));
      this.emit('offer', offer);
    });
  }

  pendingOffers() {
    return [...this._pending.values()].map((p) => p.offer);
  }

  respond(offerId, accept, reason) {
    this._pending.get(offerId)?.decide(accept ? { ok: true } : { ok: false, reason: reason || 'declined' });
  }

  // ---------------------------------------------------------------- helpers

  nextId() {
    return ++this._lastId;
  }

  /** Remember a connection so stop() can close it. */
  track(sock) {
    this._sockets.add(sock);
    sock.on('close', () => this._sockets.delete(sock));
  }

  /** Tell the UI something changed. Batched: many calls within 40 ms produce one 'change' event. */
  changed() {
    if (this._changeTimer || this._stopped) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.emit('change');
    }, 40);
    this._changeTimer.unref();
  }
}
