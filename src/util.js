import { createHash } from 'node:crypto';

export function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** a1b2c3d4e5f6... -> "a1b2-c3d4-e5f6" */
export function shortFp(fp) {
  return String(fp).slice(0, 12).replace(/(.{4})(?=.)/g, '$1-');
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  const digits = i === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${units[i]}`;
}

export function formatRate(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 1) return '<1s';
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Strip control characters (incl. ESC, so a peer can't inject terminal escape
 * sequences through a name or file name) and bidi overrides, collapse whitespace.
 */
export function clean(s, max = 200) {
  let out = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > max) out = out.slice(0, max - 1) + '…';
  return out;
}

export class BeamError extends Error {}
export class CancelledError extends BeamError {
  constructor(msg = 'cancelled') {
    super(msg);
  }
}

/** Turn a low-level socket error into a sentence a person can act on. */
export function friendlyNetError(e) {
  switch (e?.code) {
    case 'ECONNREFUSED':
      return new BeamError('connection refused - is beam running there, and is the firewall allowing it?');
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new BeamError('host unreachable');
    case 'ETIMEDOUT':
      return new BeamError('connection timed out');
    case 'ECONNRESET':
      return new BeamError('connection reset by peer');
    default:
      return e instanceof Error ? e : new BeamError(String(e));
  }
}

/** Resolve after `ms`. The timer is unref'd: it is only ever used to bound a wait, and must not keep the process alive. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms).unref());
}
