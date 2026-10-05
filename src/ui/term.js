// Minimal terminal toolkit: styling, display width, boxes, and a diffing screen.
// No dependencies, so `npx beam-share` starts quickly.
import readline from 'node:readline';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_SPLIT = /(\x1b\[[0-9;?]*[ -/]*[@-~])/;

export const stripAnsi = (s) => s.replace(ANSI_RE, '');

// ------------------------------------------------------------------ glyphs

export const G = {
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  bar: { full: '█', empty: '░' },
  up: '↑',
  down: '↓',
  pointer: '▸',
  ok: '✓',
  bad: '✗',
  bullet: '•',
};
export const SPINNER = '|/-\\';

// ------------------------------------------------------------------ colour

const colorOn = process.env.NO_COLOR === undefined;

/** 256-colour palette indices. */
export const C = { accent: 81, ok: 78, warn: 221, bad: 203, muted: 245, sel: 237, title: 255 };

/** Wrap `text` in one self-contained SGR run (never nest: each call resets). */
export function paint(text, { fg, bg, bold, dim, inverse, underline } = {}) {
  const codes = [];
  if (bold) codes.push(1);
  if (dim) codes.push(2);
  if (underline) codes.push(4);
  if (inverse) codes.push(7);
  if (colorOn) {
    if (fg != null) codes.push(`38;5;${fg}`);
    if (bg != null) codes.push(`48;5;${bg}`);
  }
  return codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;
}

// ------------------------------------------------------------------- width

export function charWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff
  ) {
    return 0;
  }
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

/** Display width of plain (unstyled) text. */
export function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Truncate plain text to exactly `w` columns (with …), padding with spaces. */
export function fit(s, w) {
  if (w <= 0) return '';
  const total = strWidth(s);
  if (total <= w) return s + ' '.repeat(w - total);
  let out = '';
  let cw = 0;
  for (const ch of s) {
    const k = charWidth(ch.codePointAt(0));
    if (cw + k > w - 1) break;
    out += ch;
    cw += k;
  }
  return out + '…' + ' '.repeat(w - cw - 1);
}

/** Like fit(), but when too long keeps the END of the text (good for paths). */
export function fitEnd(s, w) {
  if (w <= 0) return '';
  const total = strWidth(s);
  if (total <= w) return s + ' '.repeat(w - total);
  const chars = [...s];
  let out = '';
  let cw = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const k = charWidth(chars[i].codePointAt(0));
    if (cw + k > w - 1) break;
    out = chars[i] + out;
    cw += k;
  }
  return '…' + out + ' '.repeat(w - cw - 1);
}

/** Right-align plain text in `w` columns. */
export function padStart(s, w) {
  const k = strWidth(s);
  return k >= w ? fit(s, w) : ' '.repeat(w - k) + s;
}

/** Clip a styled string to `w` visible columns (keeps escapes balanced) and pad to exactly `w`. */
export function padAnsi(s, w) {
  const parts = s.split(ANSI_SPLIT);
  let out = '';
  let cw = 0;
  let cut = false;
  let styled = false;
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('\x1b[')) {
      if (!cut) out += part;
      styled = true;
      continue;
    }
    if (cut) continue;
    for (const ch of part) {
      const k = charWidth(ch.codePointAt(0));
      if (cw + k > w) {
        cut = true;
        break;
      }
      out += ch;
      cw += k;
    }
  }
  if (cut && styled) out += '\x1b[0m';
  return out + ' '.repeat(Math.max(0, w - cw));
}

// --------------------------------------------------------------------- box

/**
 * A bordered panel exactly `w` x `h`. `lines` are styled strings; content gets
 * one column of padding on each side, so usable width is w - 4 and height h - 2.
 */
export function box({ title = '', w, h, lines, focused = false }) {
  const g = G.box;
  const edge = (t) => paint(t, focused ? { fg: C.accent } : { fg: C.muted });
  const iw = w - 2;
  const label = title ? ` ${title} ` : '';
  const labelW = Math.min(strWidth(stripAnsi(label)), Math.max(0, iw - 2));
  const top =
    edge(g.tl + g.h) +
    paint(fit(stripAnsi(label), labelW).trimEnd().padEnd(labelW), { bold: true, fg: focused ? C.accent : C.title }) +
    edge(g.h.repeat(Math.max(0, iw - 1 - labelW)) + g.tr);
  const out = [top];
  for (let i = 0; i < h - 2; i++) {
    out.push(edge(g.v) + ' ' + padAnsi(lines[i] ?? '', iw - 2) + ' ' + edge(g.v));
  }
  out.push(edge(g.bl + g.h.repeat(iw) + g.br));
  return out;
}

/** Center `inner` (array of lines, each `innerW` wide) inside a w x h area. */
export function center(inner, innerW, w, h) {
  const left = Math.max(0, Math.floor((w - innerW) / 2));
  const top = Math.max(0, Math.floor((h - inner.length) / 2));
  const pad = ' '.repeat(left);
  const out = [];
  for (let i = 0; i < h; i++) {
    const j = i - top;
    out.push(j >= 0 && j < inner.length ? pad + inner[j] : '');
  }
  return out;
}

export function progressBar(frac, width, color) {
  const f = Math.max(0, Math.min(1, frac));
  const filled = Math.round(f * width);
  return paint(G.bar.full.repeat(filled), { fg: color }) + paint(G.bar.empty.repeat(width - filled), { fg: C.muted });
}

// ------------------------------------------------------------------ screen

/** Owns the terminal: alt screen, raw keys, resize, and flicker-free diff drawing. */
export class Screen {
  constructor(out = process.stdout, inp = process.stdin) {
    this.out = out;
    this.inp = inp;
    this.prev = [];
    this.active = false;
    this._onKey = null;
    this._onResize = null;
  }

  get w() {
    return this.out.columns || 80;
  }
  get h() {
    return this.out.rows || 24;
  }

  enter({ onKey, onResize }) {
    this.active = true;
    this._onKey = (str, key) => onKey(str ?? '', key ?? {});
    this._onResize = () => {
      this.prev = [];
      onResize();
    };
    readline.emitKeypressEvents(this.inp);
    this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.on('keypress', this._onKey);
    this.out.on('resize', this._onResize);
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[2J'); // alt screen, hide cursor, clear
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.inp.off('keypress', this._onKey);
    this.out.off('resize', this._onResize);
    try {
      this.inp.setRawMode(false);
    } catch {
      /* stdin already gone */
    }
    this.inp.pause();
    this.out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  /** Draw `lines` (already padded to full width), touching only rows that changed. */
  draw(lines) {
    if (!this.active) return;
    let buf = '';
    for (let i = 0; i < this.h; i++) {
      const line = lines[i] ?? '';
      if (line !== this.prev[i]) buf += `\x1b[${i + 1};1H${line}\x1b[0m`;
    }
    this.prev = lines.slice(0, this.h);
    if (buf) this.out.write(`\x1b[?2026h${buf}\x1b[?2026l`);
  }
}
