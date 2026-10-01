// Keyboard-driven file browser used to choose what to send.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatBytes } from '../util.js';
import { TextInput } from './input.js';
import { C, G, fit, fitEnd, paint, padStart } from './term.js';

/** Resolve text typed or pasted/dropped into the path prompt. */
export function expandPath(input, base) {
  let s = String(input).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) s = s.slice(1, -1);
  if (process.platform !== 'win32') s = s.replace(/\\(.)/g, '$1'); // terminals escape spaces when you drop a file
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(base, s);
}

function listDrives() {
  const out = [];
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(root)) out.push({ name: root, abs: root, isDir: true });
  }
  return out;
}

export class FilePicker {
  /**
   * @param {object} o
   * @param {string} o.startDir
   * @param {string[]} [o.preselect]   absolute paths to start selected
   * @param {(paths:string[])=>void} o.onSend
   * @param {()=>void} o.onCancel
   */
  constructor({ startDir, preselect = [], onSend, onCancel }) {
    this.onSend = onSend;
    this.onCancel = onCancel;
    this.dir = null;
    this.entries = [];
    this.cursor = 0;
    this.offset = 0;
    this.selected = new Map(); // abs -> {isDir}
    this.showHidden = false;
    this.prompt = null;
    this.message = '';
    this._sizes = new Map();
    for (const p of preselect) {
      try {
        this.selected.set(p, { isDir: fs.statSync(p).isDirectory() });
      } catch {
        /* vanished since it was queued */
      }
    }
    const first = preselect[0];
    if (!this.load(startDir) && !this.load(os.homedir())) this.load(path.parse(process.cwd()).root);
    if (first && path.dirname(first) === this.dir) this.focus(path.basename(first));
  }

  get current() {
    return this.entries[this.cursor];
  }

  focus(name) {
    const i = this.entries.findIndex((e) => e.name === name);
    if (i >= 0) this.cursor = i;
  }

  /** Read `dir` (null = list of drives on Windows). Returns false if it can't be opened. */
  load(dir, focusName) {
    let entries;
    if (dir === null) {
      entries = listDrives();
    } else {
      let dirents;
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        this.message = `Can't open ${dir}: ${e.code ?? e.message}`;
        return false;
      }
      entries = [];
      for (const d of dirents) {
        if (!this.showHidden && d.name.startsWith('.')) continue;
        const abs = path.join(dir, d.name);
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
          try {
            isDir = fs.statSync(abs).isDirectory();
          } catch {
            continue; // dangling link
          }
        } else if (!isDir && !d.isFile()) {
          continue; // sockets, devices...
        }
        entries.push({ name: d.name, abs, isDir });
      }
      entries.sort(
        (a, b) =>
          Number(b.isDir) - Number(a.isDir) ||
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      );
      const parent = path.dirname(dir);
      if (parent !== dir) entries.unshift({ name: '..', abs: parent, isDir: true, parent: true });
      else if (process.platform === 'win32') entries.unshift({ name: '..', abs: null, isDir: true, parent: true });
    }
    this.dir = dir;
    this.entries = entries;
    this.cursor = 0;
    this.offset = 0;
    this.message = '';
    if (focusName) this.focus(focusName);
    else if (entries[0]?.parent && entries.length > 1) this.cursor = 1; // start on the first real item
    return true;
  }

  up() {
    if (this.dir === null) return;
    const from = path.basename(this.dir) || this.dir;
    const parent = path.dirname(this.dir);
    if (parent === this.dir) {
      if (process.platform === 'win32') this.load(null, this.dir);
    } else {
      this.load(parent, from);
    }
  }

  open(entry) {
    if (entry.parent) return this.up();
    if (entry.isDir) this.load(entry.abs);
  }

  toggle(entry) {
    if (!entry || entry.parent) return;
    if (this.selected.has(entry.abs)) this.selected.delete(entry.abs);
    else this.selected.set(entry.abs, { isDir: entry.isDir });
  }

  send() {
    let paths = [...this.selected.keys()];
    if (paths.length === 0) {
      const e = this.current;
      if (!e || e.parent) {
        this.message = 'Nothing selected - press Space on a file or folder first';
        return;
      }
      paths = [e.abs];
    }
    this.onSend(paths);
  }

  submitPrompt() {
    const typed = this.prompt.value;
    this.prompt = null;
    if (!typed.trim()) return;
    const target = expandPath(typed, this.dir ?? process.cwd());
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      this.message = `Not found: ${target}`;
      return;
    }
    if (st.isDirectory()) {
      this.load(target);
    } else {
      this.selected.set(target, { isDir: false });
      if (this.load(path.dirname(target), path.basename(target))) this.message = `Added ${path.basename(target)}`;
    }
  }

  handleKey(str, key) {
    if (this.prompt) {
      const r = this.prompt.handle(str, key);
      if (r === 'submit') this.submitPrompt();
      else if (r === 'cancel') this.prompt = null;
      return;
    }
    const rows = Math.max(1, this._rows ?? 10);
    const n = this.entries.length;
    const move = (to) => (this.cursor = Math.max(0, Math.min(n - 1, to)));
    switch (key.name) {
      case 'up': return move(this.cursor - 1);
      case 'down': return move(this.cursor + 1);
      case 'pageup': return move(this.cursor - rows);
      case 'pagedown': return move(this.cursor + rows);
      case 'home': return move(0);
      case 'end': return move(n - 1);
      case 'left':
      case 'backspace': return this.up();
      case 'right': return this.current && this.open(this.current);
      case 'return':
      case 'enter':
        if (!this.current) return;
        return this.current.isDir ? this.open(this.current) : this.toggle(this.current);
      case 'space':
        this.toggle(this.current);
        return move(this.cursor + 1);
      case 'escape': return this.onCancel();
      default:
    }
    switch (str) {
      case 'k': return move(this.cursor - 1);
      case 'j': return move(this.cursor + 1);
      case 'h': return this.up();
      case 'l': return this.current && this.open(this.current);
      case ' ':
        this.toggle(this.current);
        return move(this.cursor + 1);
      case 's': return this.send();
      case '/':
        this.prompt = new TextInput('');
        return;
      case '~': return void this.load(os.homedir());
      case '.': {
        this.showHidden = !this.showHidden;
        const keep = this.current?.name;
        if (this.dir !== null) this.load(this.dir, keep);
        this.message = this.showHidden ? 'Showing hidden files' : 'Hiding hidden files';
        return;
      }
      case 'a': {
        const real = this.entries.filter((e) => !e.parent);
        const all = real.length > 0 && real.every((e) => this.selected.has(e.abs));
        for (const e of real) {
          if (all) this.selected.delete(e.abs);
          else this.selected.set(e.abs, { isDir: e.isDir });
        }
        return;
      }
      case 'q': return this.onCancel();
      default:
    }
  }

  _size(abs) {
    if (!this._sizes.has(abs)) {
      try {
        this._sizes.set(abs, fs.statSync(abs).size);
      } catch {
        this._sizes.set(abs, null);
      }
    }
    return this._sizes.get(abs);
  }

  /** Lines for a panel with usable area w x h. */
  view(w, h) {
    const rows = Math.max(1, h - 3);
    this._rows = rows;
    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + rows) this.offset = this.cursor - rows + 1;

    const lines = [];
    if (this.prompt) {
      const label = 'Go to folder / add file: ';
      lines.push(paint(label, { fg: C.accent, bold: true }) + this.prompt.render(Math.max(1, w - label.length)));
      lines.push(paint(fit('Enter to confirm · Esc to cancel · paste or drop a path here', w), { fg: C.muted }));
    } else {
      lines.push(paint(fitEnd(this.dir ?? 'This PC', w), { bold: true }));
      const where = this.message ? paint(fit(this.message, w), { fg: C.warn }) : paint(fit(`${this.entries.filter((e) => !e.parent).length} items`, w), { fg: C.muted });
      lines.push(where);
    }

    const sizeW = 10;
    const nameW = Math.max(4, w - 2 - 4 - sizeW - 1);
    for (let i = this.offset; i < Math.min(this.entries.length, this.offset + rows); i++) {
      const e = this.entries[i];
      const isCursor = i === this.cursor;
      const bg = isCursor ? C.sel : undefined;
      const picked = this.selected.has(e.abs);
      const label = e.parent ? '..' : e.isDir ? `${e.name}${e.name.endsWith('\\') ? '' : '/'}` : e.name;
      const size = e.parent ? '' : e.isDir ? 'folder' : (() => {
        const s = this._size(e.abs);
        return s == null ? '?' : formatBytes(s);
      })();
      lines.push(
        paint(isCursor ? `${G.pointer} ` : '  ', { fg: C.accent, bg }) +
          paint(e.parent ? '    ' : picked ? '[x] ' : '[ ] ', { fg: picked ? C.ok : C.muted, bg, bold: picked }) +
          paint(fit(label, nameW), { fg: e.parent ? C.muted : e.isDir ? C.accent : undefined, bold: isCursor, bg }) +
          paint(' ' + padStart(size, sizeW), { fg: C.muted, bg }),
      );
    }
    if (this.entries.length === 0) lines.push(paint('  (empty folder)', { fg: C.muted }));

    while (lines.length < h - 1) lines.push('');
    lines.length = h - 1;
    lines.push(paint(fit(this.summary(), w), { fg: this.selected.size ? C.ok : C.muted }));
    return lines;
  }

  summary() {
    if (this.selected.size === 0) return 'Nothing selected yet - Space selects, s sends the highlighted item';
    let bytes = 0;
    let folders = 0;
    let files = 0;
    for (const [abs, { isDir }] of this.selected) {
      if (isDir) folders++;
      else {
        files++;
        bytes += this._size(abs) ?? 0;
      }
    }
    const parts = [];
    if (files) parts.push(`${files} file${files > 1 ? 's' : ''} (${formatBytes(bytes)})`);
    if (folders) parts.push(`${folders} folder${folders > 1 ? 's' : ''}`);
    return `Selected: ${parts.join(' + ')} - press s to send`;
  }
}
