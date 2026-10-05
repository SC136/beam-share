// The receiving side of a transfer, in the order things happen:
//   1. read the offer from the sender
//   2. check it: everything in an offer comes from the network, so treat it as hostile
//   3. ask the user to accept or decline
//   4. save each file as "name.part", verify its SHA-256, and only then give it its real name
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CHUNK, MAX_FILES, ProtocolError, Reader, VERSION, writeFrame } from './protocol.js';
import { numbered, resolveInside, sanitizeRelPath } from './safepath.js';
import { BeamError, CancelledError, clean, sha256hex } from './util.js';

/** Called for every incoming connection. Never throws; bad connections are simply dropped. */
export async function receiveFiles(beam, sock) {
  beam.track(sock);
  sock.on('error', () => {});
  const cert = sock.getPeerCertificate();
  if (!cert?.raw) return sock.destroy();
  const senderId = sha256hex(cert.raw); // who is on the other end: their certificate fingerprint

  const reader = new Reader(sock);
  const timer = setTimeout(() => reader.abort(new BeamError('timed out')), 10_000); // silent clients get dropped
  try {
    const offer = await reader.readFrame();
    clearTimeout(timer);
    reader.aborted = null;
    if (offer.t !== 'offer') return sock.destroy();
    await handleOffer(beam, sock, reader, senderId, offer);
  } catch {
    clearTimeout(timer);
    sock.destroy();
  }
}

async function handleOffer(beam, sock, reader, senderId, msg) {
  const refuse = async (reason) => {
    try {
      await writeFrame(sock, { t: 'reply', ok: false, reason });
      sock.end();
    } catch {
      sock.destroy();
    }
  };

  // 2. check
  let plan;
  try {
    plan = checkOffer(msg);
  } catch (e) {
    return refuse(e.message);
  }

  // 3. ask the user
  const known = [...beam.peers()].find((p) => p.id === senderId);
  const offer = {
    id: beam.nextId(),
    senderName: known?.name ?? (clean(msg.name, 64) || 'unknown device'),
    known: !!known, //                 false = we never saw this device announce itself on the LAN
    address: (sock.remoteAddress || '').replace(/^::ffff:/, ''),
    fingerprint: senderId,
    count: plan.fileCount,
    total: plan.total,
    items: plan.groups.slice(0, 6),
    more: Math.max(0, plan.groups.length - 6),
    downloadDir: beam.downloadDir,
  };
  const answer = await beam.ask(offer, reader);
  if (answer.withdrawn) return sock.destroy(); // the sender gave up while we were deciding
  if (!answer.ok) return refuse(answer.reason || 'declined');

  // 4. receive
  const t = beam.newTransfer({
    dir: 'recv',
    peerName: offer.senderName,
    status: 'active',
    label:
      plan.groups.length === 1
        ? plan.groups[0].name + (plan.fileCount > 1 ? ` (${plan.fileCount} files)` : '')
        : `${plan.groups.length} items (${plan.fileCount} files)`,
    files: plan.fileCount,
    total: plan.total,
    startedAt: Date.now(),
    savedTo: beam.downloadDir,
  });
  try {
    await writeFrame(sock, { t: 'reply', ok: true });
  } catch (e) {
    return beam.finish(t, 'failed', e.message);
  }
  await saveFiles(beam, sock, reader, t, plan);
}

/**
 * Validate an offer and turn it into a plan. Throws (and the offer is refused) if anything is off:
 * wrong version, too many files, impossible sizes, or a path that could escape the download folder.
 */
function checkOffer(msg) {
  if (msg.v !== VERSION) throw new ProtocolError(`incompatible version (peer ${msg.v}, us ${VERSION})`);
  if (!Array.isArray(msg.files) || msg.files.length === 0) throw new ProtocolError('empty offer');
  if (msg.files.length > MAX_FILES) throw new ProtocolError('too many files');

  const entries = []; //  what to save, in order
  const groups = new Map(); // top-level names, for the "what is being offered" summary
  let total = 0;
  let fileCount = 0;
  for (const f of msg.files) {
    if (!f || typeof f !== 'object') throw new ProtocolError('malformed offer');
    const segments = sanitizeRelPath(f.p);
    if (!segments) throw new ProtocolError('offer contains an unsafe path');
    const isDir = f.d === true;
    let size = 0;
    if (!isDir) {
      if (!Number.isSafeInteger(f.s) || f.s < 0) throw new ProtocolError('malformed file size');
      size = f.s;
      total += size;
      if (!Number.isSafeInteger(total)) throw new ProtocolError('malformed file size');
      fileCount++;
    }
    entries.push({ segments, isDir, size });

    const top = clean(segments[0], 120);
    const group = groups.get(top) ?? { name: top, folder: false, files: 0, bytes: 0 };
    group.folder ||= segments.length > 1 || isDir;
    if (!isDir) {
      group.files++;
      group.bytes += size;
    }
    groups.set(top, group);
  }
  return { entries, total, fileCount, groups: [...groups.values()] };
}

/** Pick a free final name ("a.txt", then "a (1).txt", ...) and open "<name>.part" next to it. */
async function reserve(downloadDir, segments) {
  const target = resolveInside(downloadDir, segments);
  if (!target) throw new ProtocolError('unsafe path');
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  for (let n = 0; n < 10_000; n++) {
    const finalPath = path.join(dir, numbered(path.basename(target), n));
    if (await fs.access(finalPath).then(() => true, () => false)) continue; // never overwrite
    try {
      const partPath = finalPath + '.part';
      return { finalPath, partPath, handle: await fs.open(partPath, 'wx') };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new BeamError('could not find a free file name');
}

/** A single write may be partial (e.g. disk nearly full), so loop until everything is written. */
async function writeAll(handle, buf) {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset, null);
    offset += bytesWritten;
  }
}

async function saveFiles(beam, sock, reader, t, plan) {
  const abort = new AbortController();
  t.abort = () => abort.abort();
  abort.signal.addEventListener('abort', () => reader.abort(new CancelledError()));
  let current = null; // the file being written, so a failure can clean it up
  try {
    for (const entry of plan.entries) {
      if (entry.isDir) {
        const dir = resolveInside(beam.downloadDir, entry.segments);
        if (!dir) throw new ProtocolError('unsafe path');
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      const name = entry.segments.join('/');
      current = await reserve(beam.downloadDir, entry.segments);
      const hash = createHash('sha256');
      let remaining = entry.size;
      while (remaining > 0) {
        const chunk = await reader.readSome(Math.min(CHUNK, remaining));
        hash.update(chunk);
        await writeAll(current.handle, chunk);
        remaining -= chunk.length;
        beam.progress(t, chunk.length);
      }
      const theirHash = await reader.readExact(32);
      if (!timingSafeEqual(theirHash, hash.digest())) {
        throw new BeamError(`checksum mismatch for "${clean(name, 80)}" - file discarded`);
      }
      await current.handle.close();
      await fs.rename(current.partPath, current.finalPath); // only now does the file get its real name
      current = null;
      t.filesDone++;
    }
    await writeFrame(sock, { t: 'result', ok: true });
    sock.end();
    beam.finish(t, 'done');
  } catch (err) {
    if (current) {
      await current.handle.close().catch(() => {});
      await fs.unlink(current.partPath).catch(() => {}); // never leave half-files behind
    }
    const cancelled = err instanceof CancelledError || abort.signal.aborted;
    const message = cancelled
      ? 'cancelled by receiver'
      : /closed by peer|ECONNRESET/.test(err.message)
        ? 'sender cancelled or the connection was lost'
        : err.message;
    beam.finish(t, cancelled ? 'cancelled' : 'failed', cancelled ? null : message);
    // Tell the sender why. Then keep reading (and ignoring) for a moment: closing a connection
    // that still has unread data can reset it and lose the message before the sender sees it.
    try {
      await writeFrame(sock, { t: 'result', ok: false, error: message });
    } catch {
      /* the sender is already gone */
    }
    reader.drain();
    sock.end();
    setTimeout(() => sock.destroy(), 1500).unref();
  }
}
