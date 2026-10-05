// The sending side of a transfer, in the order things happen:
//   1. scan   work out which files to send
//   2. connect  open a TLS connection and check it really is the device we meant to reach
//   3. offer  list the files and wait for the receiver to accept
//   4. stream   send each file's bytes followed by its SHA-256, then wait for the receiver's verdict
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import tls from 'node:tls';
import { CHUNK, ProtocolError, Reader, VERSION, write, writeFrame } from './protocol.js';
import { scanPaths } from './scan.js';
import { BeamError, CancelledError, clean, friendlyNetError, sha256hex, sleep } from './util.js';

/** Runs one whole send. Never throws: the outcome is recorded on the transfer record `t`. */
export async function sendFiles(beam, t, peer, paths) {
  const abort = new AbortController();
  t.abort = () => abort.abort();
  let sock;
  try {
    // 1. scan
    const scan = await scanPaths(paths, abort.signal);
    if (scan.entries.length === 0) throw new BeamError('nothing readable to send');
    t.files = scan.fileCount;
    t.total = scan.total;
    if (scan.skipped) t.note = `${scan.skipped} item(s) skipped (unreadable or links)`;
    if (paths.length === 1 && scan.fileCount > 1) t.label += ` (${scan.fileCount} files)`;

    // 2. connect
    t.status = 'waiting';
    beam.changed();
    sock = await connect(beam, peer, abort.signal);
    beam.track(sock);
    const reader = new Reader(sock);
    abort.signal.addEventListener('abort', () => {
      reader.abort(new CancelledError());
      sock.destroy();
    });

    // 3. offer
    const files = scan.entries.map((e) => (e.d ? { p: e.p, d: true } : { p: e.p, s: e.s }));
    await writeFrame(sock, { t: 'offer', v: VERSION, name: beam.name, files });
    const reply = await reader.readFrame();
    if (reply.t !== 'reply') throw new ProtocolError('unexpected reply from peer');
    if (!reply.ok) return beam.finish(t, 'rejected', clean(reply.reason) || 'declined');

    // 4. stream. Meanwhile we listen for the receiver's verdict, because it can arrive early
    //    (the receiver cancelled, or a file failed its checksum) and then we should stop.
    t.status = 'active';
    t.startedAt = Date.now();
    beam.changed();
    const stopStreaming = new AbortController();
    const verdict = reader.readFrame().catch((e) => e);
    verdict.then(() => stopStreaming.abort());
    try {
      await stream(beam, sock, t, scan.entries, stopStreaming.signal);
    } catch (err) {
      if (abort.signal.aborted) throw new CancelledError();
      const early = await Promise.race([verdict, sleep(1500)]); // did the receiver tell us why?
      if (early?.t === 'result' && early.ok === false) {
        const why = clean(early.error) || 'aborted';
        throw why === 'cancelled by receiver' ? new CancelledError(why) : new BeamError(`receiver: ${why}`);
      }
      throw err;
    }
    const final = await Promise.race([verdict, sleep(60_000).then(() => new BeamError('receiver did not confirm the transfer'))]);
    if (final instanceof Error) throw final;
    if (final.t !== 'result' || !final.ok) throw new BeamError(`receiver: ${clean(final.error) || 'failed'}`);
    beam.finish(t, 'done');
  } catch (err) {
    if (err instanceof CancelledError || abort.signal.aborted) {
      beam.finish(t, 'cancelled', abort.signal.aborted ? null : err.message); // message only if the receiver cancelled
    } else {
      beam.finish(t, 'failed', friendlyNetError(err).message);
    }
  } finally {
    sock?.destroy();
  }
}

/** Open a TLS connection to the peer and make sure its certificate is the one it announced. */
function connect(beam, peer, signal) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: peer.address,
      port: peer.port,
      key: beam.identity.key,
      cert: beam.identity.cert,
      rejectUnauthorized: false, // identity is checked below, by fingerprint
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
    if (signal.aborted) return fail(new CancelledError());
    signal.addEventListener('abort', () => fail(new CancelledError()), { once: true });
    sock.once('secureConnect', () => {
      if (settled) return;
      const cert = sock.getPeerCertificate();
      const fingerprint = cert?.raw ? sha256hex(cert.raw) : null;
      if (fingerprint !== peer.id) {
        return fail(new BeamError('identity mismatch - that is not the device that announced itself (possible impersonation)'));
      }
      settled = true;
      clearTimeout(timer);
      sock.off('error', fail);
      sock.on('error', () => {}); // from now on, errors surface through the Reader
      resolve(sock);
    });
  });
}

/** Send every file: its bytes, then its SHA-256 so the receiver can verify it. */
async function stream(beam, sock, t, entries, signal) {
  for (const entry of entries) {
    if (entry.d) continue; // empty directories carry no bytes
    const file = await fs.open(entry.abs, 'r');
    try {
      const hash = createHash('sha256');
      let remaining = entry.s;
      while (remaining > 0) {
        if (signal.aborted) throw new BeamError('connection closed');
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, remaining));
        const { bytesRead } = await file.read(buf, 0, buf.length, null);
        if (bytesRead === 0) throw new BeamError(`file changed while sending: ${entry.p}`);
        const chunk = bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
        hash.update(chunk);
        await write(sock, chunk); // waits for the network, so we never read faster than it can send
        remaining -= bytesRead;
        beam.progress(t, bytesRead);
      }
      await write(sock, hash.digest());
      t.filesDone++;
    } finally {
      await file.close();
    }
  }
}
