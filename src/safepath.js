// Paths in an offer come from the network, so treat them as hostile: they must
// never be able to escape the download directory or hit special Windows names.
import path from 'node:path';

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_SEGMENT_BYTES = 200; // leaves room for " (123).ext" and ".part" under the 255 limit

/**
 * Turn a '/'-separated relative path from the wire into safe path segments.
 * Returns null if the path is structurally unacceptable (absolute, "..", empty).
 */
export function sanitizeRelPath(p, { windows = process.platform === 'win32' } = {}) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return null;
  if (p.startsWith('/')) return null;
  const raw = p.split('/');
  const out = [];
  for (let seg of raw) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    // Applies everywhere: NUL and control characters.
    seg = seg.replace(/[\u0000-\u001f\u007f]/g, '_');
    if (windows) {
      seg = seg.replace(/[<>:"\\|?*]/g, '_');
      seg = seg.replace(/[. ]+$/, ''); // Windows silently strips trailing dots/spaces
      if (WIN_RESERVED.test(seg)) seg = '_' + seg;
    } else {
      seg = seg.replace(/\\/g, '_'); // keep names portable if the folder is later moved to Windows
    }
    if (seg === '' || seg === '.' || seg === '..') seg = '_';
    seg = truncateBytes(seg, MAX_SEGMENT_BYTES);
    out.push(seg);
  }
  return out;
}

function truncateBytes(s, max) {
  if (Buffer.byteLength(s) <= max) return s;
  const ext = path.extname(s);
  const keepExt = ext.length > 0 && ext.length <= 16 ? ext : '';
  let stem = keepExt ? s.slice(0, -keepExt.length) : s;
  while (Buffer.byteLength(stem + keepExt) > max) stem = stem.slice(0, -1);
  return stem + keepExt;
}

/** Join segments under `base`, guaranteeing the result stays inside it. */
export function resolveInside(base, segments) {
  const root = path.resolve(base);
  const full = path.resolve(root, ...segments);
  const rel = path.relative(root, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/** "name.ext" -> "name (2).ext" */
export function numbered(file, n) {
  if (n === 0) return file;
  const ext = path.extname(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  return `${stem} (${n})${ext}`;
}
