import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { Beam } from '../src/beam.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { Reader } from '../src/protocol.js';

const cleanups = [];

export function tmpdir(prefix = 'beam-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return d;
}

/** Start an isolated Beam instance (own identity, own download dir, ephemeral port). */
export async function makeBeam(name, opts = {}) {
  const beam = new Beam({
    name,
    port: 0,
    configDir: tmpdir('beam-cfg-'),
    downloadDir: tmpdir('beam-dl-'),
    discovery: false,
    ...opts,
  });
  await beam.start();
  cleanups.push(() => beam.stop());
  return beam;
}

export async function cleanupAll() {
  while (cleanups.length) await cleanups.pop()();
}

/** a learns about b by address, like the "add peer" feature. */
export async function link(a, b) {
  return a.addPeer(`127.0.0.1:${b.port}`);
}

/** Accept every incoming offer on `beam`. */
export function autoRespond(beam, accept = true) {
  beam.on('offer', (o) => beam.respond(o.id, accept));
}

export async function waitFor(cond, ms = 10_000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const settled = (t) => !['preparing', 'waiting', 'active'].includes(t.status);

export function writeRandomFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const hash = crypto.createHash('sha256');
  let left = bytes;
  while (left > 0) {
    const chunk = crypto.randomBytes(Math.min(left, 1 << 20));
    fs.writeSync(fd, chunk);
    hash.update(chunk);
    left -= chunk.length;
  }
  fs.closeSync(fd);
  return hash.digest('hex');
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** List every file below dir as sorted relative '/' paths. */
export function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const before = out.length;
        walk(path.join(d, e.name), r);
        if (out.length === before) out.push(r + '/');
      } else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** A bare TLS client with its own identity: lets tests speak (or abuse) the protocol directly. */
export async function rawClient(beam) {
  const id = loadOrCreateIdentity(tmpdir('beam-raw-'));
  const sock = tls.connect({
    host: '127.0.0.1',
    port: beam.port,
    key: id.key,
    cert: id.cert,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });
  sock.on('error', () => {});
  await new Promise((resolve, reject) => {
    sock.once('secureConnect', resolve);
    sock.once('error', reject);
  });
  return { sock, reader: new Reader(sock), id };
}
