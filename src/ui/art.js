// ASCII art. Everything here is plain 7-bit ASCII so it renders in any terminal and font.
import { C, center, paint } from './term.js';

/** The "beam" wordmark, one string per row. */
export const LOGO = [
  ' _',
  '| |__   ___  __ _ _ __ ___',
  "| '_ \\ / _ \\/ _` | '_ ` _ \\",
  '| |_) |  __/ (_| | | | | | |',
  '|_.__/ \\___|\\__,_|_| |_| |_|',
];
export const LOGO_WIDTH = Math.max(...LOGO.map((l) => l.length));
export const LOGO_HEIGHT = LOGO.length;
export const TAGLINE = 'send files across your LAN - no cloud, no accounts';

// Cyan fading to blue, top to bottom.
const LOGO_COLORS = [51, 45, 39, 33, 27];

/** The wordmark as styled lines centered in `width` columns. */
export function logoLines(width) {
  return center(
    LOGO.map((l, i) => paint(l.padEnd(LOGO_WIDTH), { fg: LOGO_COLORS[i], bold: true })),
    LOGO_WIDTH,
    width,
    LOGO_HEIGHT,
  );
}

/**
 * One frame of the "searching" animation: a packet travelling from this device
 * toward an unknown one. `width` is the total columns available.
 */
export function linkLine(frame, width) {
  const left = '[ you ]';
  const right = '[ ??? ]';
  const track = Math.max(6, Math.min(28, width - left.length - right.length - 2));
  const pos = frame % (track + 4); // the comet slides in, crosses, and slides out
  let mid = '';
  for (let i = 0; i < track; i++) {
    if (i === pos) mid += '>';
    else if (i === pos - 1) mid += '=';
    else if (i === pos - 2) mid += '-';
    else mid += '.';
  }
  const head = Math.min(pos, track - 1);
  const painted =
    paint(mid.slice(0, Math.max(0, pos - 2)), { fg: C.muted }) +
    paint(mid.slice(Math.max(0, pos - 2), head + 1), { fg: C.accent, bold: true }) +
    paint(mid.slice(head + 1), { fg: C.muted });
  return paint(left, { fg: C.ok, bold: true }) + ' ' + painted + ' ' + paint(right, { fg: C.muted });
}
