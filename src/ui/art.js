// ASCII art. Everything here is plain 7-bit ASCII so it renders in any terminal and font.
// The cat mascot is a pure function of (mood, time), so it animates without any state.
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
export const TAGLINE = 'send files over your LAN or the internet - no cloud';

// Cyan fading to blue, top to bottom.
const LOGO_COLORS = [51, 45, 39, 33, 27];

// ------------------------------------------------------------------ the cat

/**
 * Moods: idle | search | busy | happy | sad | alert | sleep
 * (the app decides which one fits what is going on).
 */
export const MOODS = ['idle', 'search', 'busy', 'happy', 'sad', 'alert', 'sleep'];

export const CAT_WIDTH = 9;
export const CAT_HEIGHT = 3;
const FUR = 216; // warm peach
const TAIL = ['~', '-', '_', '-'];

/** The three characters between the cat's cheeks: eyes and nose/mouth, e.g. "o.o". */
export function catEyes(mood, now) {
  switch (mood) {
    case 'alert': return 'O.O';
    case 'happy': return '^.^';
    case 'busy': return '^w^'; // purring
    case 'sad': return ';.;';
    case 'sleep': return '-.-';
    case 'search': return Math.floor(now / 600) % 2 ? '>.>' : '<.<'; // looking around
    default: return Math.floor(now / 250) % 16 === 0 ? '-.-' : 'o.o'; // idle: blinks every ~4s
  }
}

export function catColor(mood) {
  return mood === 'alert' ? C.warn : mood === 'sad' ? 110 : FUR;
}

/** The compact face used in the header, e.g. "=^.^=" (always 5 columns). */
export function catFace(mood, now) {
  return `=${catEyes(mood, now)}=`;
}

/** The full cat as three plain rows, each CAT_WIDTH columns. */
export function catRows(mood, now) {
  const tail = TAIL[Math.floor(now / (mood === 'busy' ? 200 : 400)) % TAIL.length];
  let top = '  ';
  if (mood === 'sleep') top = Math.floor(now / 800) % 2 ? ' Z' : ' z';
  else if (mood === 'alert') top = ' !';
  else if (mood === 'happy') top = ' *';
  const wag = mood === 'idle' || mood === 'busy' ? tail : ' '; // only a contented cat wags
  return [` /\\_/\\ ${top}`, `( ${catEyes(mood, now)} )  `, ` > ^ <${wag}  `];
}

/** The cat as styled rows. */
export function catLines(mood, now) {
  return catRows(mood, now).map((r) => paint(r, { fg: catColor(mood), bold: true }));
}

// ----------------------------------------------------------------- the logo

/** The wordmark as styled lines centered in `width` columns. */
export function logoLines(width) {
  return center(
    LOGO.map((l, i) => paint(l.padEnd(LOGO_WIDTH), { fg: LOGO_COLORS[i], bold: true })),
    LOGO_WIDTH,
    width,
    LOGO_HEIGHT,
  );
}

export const BRAND_WIDTH = CAT_WIDTH + 2 + LOGO_WIDTH;

/** Cat standing beside the wordmark, centered in `width` columns (just the wordmark if too narrow). */
export function brandLines(width, mood, now) {
  if (width < BRAND_WIDTH) return logoLines(width);
  const cat = catLines(mood, now);
  const rows = LOGO.map(
    (l, i) =>
      (i >= LOGO_HEIGHT - CAT_HEIGHT ? cat[i - (LOGO_HEIGHT - CAT_HEIGHT)] : ' '.repeat(CAT_WIDTH)) +
      '  ' +
      paint(l.padEnd(LOGO_WIDTH), { fg: LOGO_COLORS[i], bold: true }),
  );
  return center(rows, BRAND_WIDTH, width, LOGO_HEIGHT);
}

/** Unstyled cat + wordmark, for --help and the README. */
export function plainBrand(mood = 'idle', now = 750) {
  const cat = catRows(mood, now);
  return LOGO.map((l, i) =>
    ((i >= LOGO_HEIGHT - CAT_HEIGHT ? cat[i - (LOGO_HEIGHT - CAT_HEIGHT)] : ' '.repeat(CAT_WIDTH)) + '  ' + l).trimEnd(),
  );
}

/** Printed after the app exits. */
export function farewell(extra = '') {
  const cat = catRows('happy', 750);
  return [cat[0].trimEnd(), `${cat[1].trimEnd()}  bye! see you next time${extra ? ` - ${extra}` : ''}`, cat[2].trimEnd()];
}

// ------------------------------------------------------- searching animation

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
