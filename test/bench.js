// Manual benchmark: node test/bench.js [MiB]   (not run by `npm test`)
import path from 'node:path';
import { autoRespond, cleanupAll, hashFile, link, makeBeam, settled, tmpdir, waitFor, writeRandomFile } from './helpers.js';

const mib = Number(process.argv[2] || 256);
const sender = await makeBeam('sender');
const receiver = await makeBeam('receiver');
const peer = await link(sender, receiver);
autoRespond(receiver);
const src = path.join(tmpdir(), 'bench.bin');
const sum = writeRandomFile(src, mib * 1024 * 1024);

const t0 = performance.now();
const t = sender.send(peer.id, [src]);
await waitFor(() => settled(t), 120_000);
const secs = (performance.now() - t0) / 1000;
console.log(`${t.status}: ${mib} MiB in ${secs.toFixed(2)}s = ${((mib * 1.048576) / secs).toFixed(0)} MB/s`);
console.log('integrity:', hashFile(path.join(receiver.downloadDir, 'bench.bin')) === sum ? 'ok' : 'MISMATCH');
await cleanupAll();
process.exit(0);
