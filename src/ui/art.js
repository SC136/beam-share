// The logo and the cat, in plain 7-bit ASCII so they look the same in any terminal and font.
import { center, paint } from './term.js';

export const LOGO = [
  ' _',
  '| |__   ___  __ _ _ __ ___',
  "| '_ \\ / _ \\/ _` | '_ ` _ \\",
  '| |_) |  __/ (_| | | | | | |',
  '|_.__/ \\___|\\__,_|_| |_| |_|',
];
export const LOGO_WIDTH = Math.max(...LOGO.map((l) => l.length));
export const LOGO_HEIGHT = LOGO.length;
export const TAGLINE = 'send files to devices on your network';

const CAT = [' /\\_/\\ ', '( o.o )', ' > ^ < '];
const CAT_WIDTH = CAT[0].length;
const GAP = 2;
export const BRAND_WIDTH = CAT_WIDTH + GAP + LOGO_WIDTH;

const LOGO_COLORS = [51, 45, 39, 33, 27]; // cyan fading to blue, top to bottom
const CAT_COLOR = 216; // warm peach

/** The cat standing beside the logo (cat bottom-aligned with it), plain text, one string per row. */
export function plainBrand() {
  const catTop = LOGO_HEIGHT - CAT.length;
  return LOGO.map((line, i) => ((i >= catTop ? CAT[i - catTop] : ' '.repeat(CAT_WIDTH)) + ' '.repeat(GAP) + line).trimEnd());
}

/** The same, coloured, centred in `width` columns. Only call this when width >= BRAND_WIDTH. */
export function brandLines(width) {
  const catTop = LOGO_HEIGHT - CAT.length;
  const rows = LOGO.map(
    (line, i) =>
      paint(i >= catTop ? CAT[i - catTop] : ' '.repeat(CAT_WIDTH), { fg: CAT_COLOR, bold: true }) +
      ' '.repeat(GAP) +
      paint(line.padEnd(LOGO_WIDTH), { fg: LOGO_COLORS[i], bold: true }),
  );
  return center(rows, BRAND_WIDTH, width, LOGO_HEIGHT);
}

/** Printed after the app exits. */
export function farewell(extra = '') {
  return [CAT[0].trimEnd(), `( ^.^ )  bye!${extra ? ` ${extra}` : ''}`, CAT[2].trimEnd()];
}
