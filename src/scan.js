import fs from 'node:fs/promises';
import path from 'node:path';
import { BeamError, CancelledError } from './util.js';
import { MAX_FILES } from './protocol.js';

/**
 * Expand the files/folders the user picked into a flat list of entries:
 *   {abs, p, s, m}   regular file (p = '/'-separated path relative to the receiver's folder)
 *   {abs, p, d:true} empty directory
 * Symlinks and special files inside folders are skipped (and counted) so a
 * link can't leak files from elsewhere or send the scanner in circles.
 */
export async function scanPaths(inputs, signal) {
  const entries = [];
  let total = 0;
  let skipped = 0;

  const check = () => {
    if (signal?.aborted) throw new CancelledError();
    if (entries.length > MAX_FILES) {
      throw new BeamError(`too many files (limit ${MAX_FILES.toLocaleString()}) - send an archive instead`);
    }
  };

  async function walk(dirAbs, rel) {
    check();
    let items;
    try {
      items = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }
    if (items.length === 0) {
      entries.push({ abs: dirAbs, p: rel, d: true });
      return;
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files = [];
    for (const it of items) {
      const abs = path.join(dirAbs, it.name);
      const relChild = `${rel}/${it.name}`;
      if (it.isDirectory()) await walk(abs, relChild);
      else if (it.isFile()) files.push({ abs, p: relChild });
      else skipped++;
    }
    for (let i = 0; i < files.length; i += 64) {
      const batch = files.slice(i, i + 64);
      const stats = await Promise.all(batch.map((f) => fs.stat(f.abs).catch(() => null)));
      batch.forEach((f, j) => {
        const st = stats[j];
        if (!st || !st.isFile()) return void skipped++;
        entries.push({ abs: f.abs, p: f.p, s: st.size, m: Math.round(st.mtimeMs) });
        total += st.size;
      });
      check();
    }
  }

  for (const input of inputs) {
    const abs = path.resolve(input);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      skipped++;
      continue;
    }
    const base = path.basename(abs) || abs.replace(/[^A-Za-z0-9]/g, '') || 'root';
    if (st.isFile()) {
      entries.push({ abs, p: base, s: st.size, m: Math.round(st.mtimeMs) });
      total += st.size;
    } else if (st.isDirectory()) {
      await walk(abs, base);
    } else {
      skipped++;
    }
    check();
  }
  return { entries, total, skipped, fileCount: entries.filter((e) => !e.d).length };
}
