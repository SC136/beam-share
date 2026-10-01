import { paint, strWidth } from './term.js';

const isPrintable = (s) => typeof s === 'string' && s.length > 0 && !/[\u0000-\u001f\u007f]/.test(s);

/** A single-line text field. handle() returns 'submit' | 'cancel' | true (consumed) | false (ignored). */
export class TextInput {
  constructor(value = '') {
    this.value = value;
    this.cursor = [...value].length;
  }

  get chars() {
    return [...this.value];
  }

  _set(chars, cursor) {
    this.value = chars.join('');
    this.cursor = cursor;
  }

  insert(text) {
    const add = [...text.replace(/[\r\n\t]+/g, ' ')].filter((c) => isPrintable(c));
    const chars = this.chars;
    chars.splice(this.cursor, 0, ...add);
    this._set(chars, this.cursor + add.length);
  }

  handle(str, key = {}) {
    const chars = this.chars;
    if (key.name === 'return' || key.name === 'enter') return 'submit';
    if (key.name === 'escape') return 'cancel';
    if (key.ctrl) {
      switch (key.name) {
        case 'u':
          this._set(chars.slice(this.cursor), 0);
          return true;
        case 'k':
          this._set(chars.slice(0, this.cursor), this.cursor);
          return true;
        case 'a':
          this.cursor = 0;
          return true;
        case 'e':
          this.cursor = chars.length;
          return true;
        case 'w': {
          let i = this.cursor;
          while (i > 0 && chars[i - 1] === ' ') i--;
          while (i > 0 && chars[i - 1] !== ' ') i--;
          chars.splice(i, this.cursor - i);
          this._set(chars, i);
          return true;
        }
        case 'c':
          return 'cancel';
        default:
          return false;
      }
    }
    switch (key.name) {
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case 'right':
        this.cursor = Math.min(chars.length, this.cursor + 1);
        return true;
      case 'home':
        this.cursor = 0;
        return true;
      case 'end':
        this.cursor = chars.length;
        return true;
      case 'backspace':
        if (this.cursor > 0) {
          chars.splice(this.cursor - 1, 1);
          this._set(chars, this.cursor - 1);
        }
        return true;
      case 'delete':
        chars.splice(this.cursor, 1);
        this._set(chars, this.cursor);
        return true;
      default:
    }
    if (!key.meta && isPrintable(str)) {
      this.insert(str);
      return true;
    }
    return false;
  }

  /** Render `width` columns with a block cursor; scrolls horizontally when the text is long. */
  render(width) {
    const chars = this.chars;
    const room = Math.max(1, width - 1);
    let start = 0;
    while (strWidth(chars.slice(start, this.cursor).join('')) > room - 1) start++;
    let shown = '';
    let used = 0;
    for (let i = start; i <= chars.length && used < width; i++) {
      const ch = i < chars.length ? chars[i] : ' ';
      const w = Math.max(1, strWidth(ch));
      if (used + w > width) break;
      shown += i === this.cursor ? paint(ch, { inverse: true }) : ch;
      used += w;
    }
    return shown + ' '.repeat(Math.max(0, width - used));
  }
}
