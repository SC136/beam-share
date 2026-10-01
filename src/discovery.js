// LAN discovery: every instance periodically broadcasts a tiny JSON datagram
// {id, name, port} to each interface's broadcast address and listens for the
// same from others. The `id` is the TLS certificate fingerprint, which the
// sender re-verifies in the TLS handshake before sending anything.
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { clean, sleep } from './util.js';

export const DEFAULT_DISCOVERY_PORT = 45454;
const MAGIC = 'beam/1';
const ANNOUNCE_MS = 2000;

/** Directed broadcast address of every IPv4 interface that is up. */
export function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      targets.add(ip.map((o, i) => (o | (~mask[i] & 0xff)) & 0xff).join('.'));
    }
  }
  return [...targets];
}

export class Discovery extends EventEmitter {
  /**
   * @param {{id:string, name:string, port:number, discoveryPort?:number}} self
   * Emits 'peer' ({id,name,address,port}) for every announcement received and
   * 'bye' (id) when a peer announces it is leaving.
   */
  constructor(self) {
    super();
    this.self = self;
    this.discoveryPort = self.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    this.sock = null;
    this.timer = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.on('error', (err) => this.emit('error', err));
      sock.once('error', reject);
      sock.bind(this.discoveryPort, () => {
        sock.off('error', reject);
        try {
          sock.setBroadcast(true);
        } catch (e) {
          this.emit('error', e);
        }
        this._announce();
        this.timer = setInterval(() => this._announce(), ANNOUNCE_MS);
        this.timer.unref();
        resolve();
      });
    });
  }

  _packet(bye = false) {
    const { id, name, port } = this.self;
    return Buffer.from(JSON.stringify({ m: MAGIC, id, name, port, ...(bye ? { bye: true } : {}) }));
  }

  _send(pkt) {
    if (!this.sock) return;
    for (const target of broadcastTargets()) {
      try {
        this.sock.send(pkt, this.discoveryPort, target, () => {});
      } catch {
        /* interface went away mid-flight: ignore */
      }
    }
  }

  _announce() {
    this._send(this._packet());
  }

  _onMessage(msg, rinfo) {
    if (msg.length > 1024) return;
    let m;
    try {
      m = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (!m || m.m !== MAGIC || typeof m.id !== 'string' || !/^[0-9a-f]{64}$/.test(m.id)) return;
    if (m.id === this.self.id) return; // our own broadcast
    if (m.bye) return void this.emit('bye', m.id);
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;
    this.emit('peer', {
      id: m.id,
      name: clean(m.name, 64) || 'unnamed',
      address: rinfo.address,
      port: m.port,
    });
  }

  async stop() {
    clearInterval(this.timer);
    const sock = this.sock;
    if (!sock) return;
    this.sock = null;
    const bye = this._packet(true);
    const sends = broadcastTargets().map(
      (t) =>
        new Promise((resolve) => {
          try {
            sock.send(bye, this.discoveryPort, t, () => resolve());
          } catch {
            resolve();
          }
        }),
    );
    await Promise.race([Promise.all(sends), sleep(300)]);
    await new Promise((resolve) => {
      try {
        sock.close(resolve);
      } catch {
        resolve();
      }
    });
  }
}
