// A keyboard-driven file browser for choosing what to send.
// Arrows move, Space selects (files or whole folders), Enter/→ opens a folder, ← goes up, s sends.
// `/` opens a path box: type or paste a path, or drag a file onto the terminal (which pastes its path).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatBytes } from '../util.js';
import { TextInput } from './input.js';
import { C, G, fit, fitEnd, padStart, paint } from './term.js';

/** Turn text typed or dropped into the path box into an absolute path. */
export function expandPath(input, base) {
  let s = String(input).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) s = s.slice(1, -1); // dropped paths with spaces are quoted
  if (process.platform !== 'win32') s = s.replace(/\\(.)/g, '$1'); // macOS/Linux terminals backslash-escape spaces instead
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(base, s);
}

/** On Windows the "parent of C:\" is the list of drives. */
function listDrives() {
  const drives = [];
  for (let letter = 'C'.charCodeAt(0); letter <= 'Z'.charCodeAt(0); letter++) {
    const root = `${String.fromCharCode(letter)}:\\`;
    if (fs.existsSync(root)) drives.push({ name: root, abs: root, isDir: true });
  }
  return drives;
}

export class FilePicker {
  /**
   * @param {object} o
   * @param {string} o.startDir                    folder to open first
   * @param {(paths: string[]) => void} o.onSend   called with the absolute paths to send
   * @param {() => void} o.onCancel
   */
  constructor({ startDir, onSend, onCancel }) {
    this.onSend = onSend;
    this.onCancel = onCancel;
    this.dir = null; //        the folder being shown (null = the list of drives)
    this.entries = []; //      {name, abs, isDir, parent?}
    this.cursor = 0;
    this.offset = 0; //        index of the first visible row
    this.selected = new Map(); // abs path -> {isDir}; survives moving between folders
    this.showHidden = false;
    this.message = '';
    this.prompt = null; //     the path box (a TextInput) while it is open
    this._sizes = new Map(); // file sizes, looked up lazily
    if (!this.load(startDir) && !this.load(os.homedir())) this.load(path.parse(process.cwd()).root);
  }

  get current() {
    return this.entries[this.cursor];
  }

  /** Show `dir` (null = drives). Returns false if it can't be opened. */
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
            continue; // a link to nowhere
          }
        } else if (!isDir && !d.isFile()) {
          continue; // sockets, devices...
        }
        entries.push({ name: d.name, abs, isDir });
      }
      // folders first, then files, each in natural order (file2 before file10)
      entries.sort(
        (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      );
      const parent = path.dirname(dir);
      if (parent !== dir) entries.unshift({ name: '..', abs: parent, isDir: true, parent: true });
      else if (process.platform === 'win32') entries.unshift({ name: '..', abs: null, isDir: true, parent: true });
    }
    this.dir = dir;
    this.entries = entries;
    this.cursor = entries[0]?.parent && entries.length > 1 ? 1 : 0; // start on the first real item, not ".."
    this.offset = 0;
    this.message = '';
    if (focusName) {
      const i = entries.findIndex((e) => e.name === focusName);
      if (i >= 0) this.cursor = i;
    }
    return true;
  }

  goUp() {
    if (this.dir === null) return;
    const from = path.basename(this.dir) || this.dir; // so we land back on the folder we came out of
    const parent = path.dirname(this.dir);
    if (parent !== this.dir) this.load(parent, from);
    else if (process.platform === 'win32') this.load(null, this.dir);
  }

  open(entry) {
    if (entry.parent) this.goUp();
    else if (entry.isDir) this.load(entry.abs);
  }

  toggle(entry) {
    if (!entry || entry.parent) return;
    if (this.selected.has(entry.abs)) this.selected.delete(entry.abs);
    else this.selected.set(entry.abs, { isDir: entry.isDir });
  }

  /** Send the selection, or the highlighted item if nothing is selected. */
  send() {
    let paths = [...this.selected.keys()];
    if (paths.length === 0) {
      const entry = this.current;
      if (!entry || entry.parent) {
        this.message = 'Nothing selected - press Space on a file or folder first';
        return;
      }
      paths = [entry.abs];
    }
    this.onSend(paths);
  }

  /** Enter pressed in the path box: open the folder, or select the file and show it. */
  submitPrompt() {
    const typed = this.prompt.value;
    this.prompt = null;
    if (!typed.trim()) return;
    const target = expandPath(typed, this.dir ?? process.cwd());
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      this.message = `Not found: ${target}`;
      return;
    }
    if (stat.isDirectory()) {
      this.load(target);
    } else {
      this.selected.set(target, { isDir: false });
      if (this.load(path.dirname(target), path.basename(target))) this.message = `Added ${path.basename(target)}`;
    }
  }

  handleKey(str, key) {
    if (this.prompt) {
      const result = this.prompt.handle(str, key);
      if (result === 'submit') this.submitPrompt();
      else if (result === 'cancel') this.prompt = null;
      return;
    }
    const n = this.entries.length;
    const move = (to) => (this.cursor = Math.max(0, Math.min(n - 1, to)));
    const page = Math.max(1, this._rows ?? 10);
    switch (key.name) {
      case 'up': return move(this.cursor - 1);
      case 'down': return move(this.cursor + 1);
      case 'pageup': return move(this.cursor - page);
      case 'pagedown': return move(this.cursor + page);
      case 'home': return move(0);
      case 'end': return move(n - 1);
      case 'left':
      case 'backspace': return this.goUp();
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
      case 'h': return this.goUp();
      case 'l': return this.current && this.open(this.current);
      case 's': return this.send();
      case '/':
        this.prompt = new TextInput('');
        return;
      case 'q': return this.onCancel();
      case '.': return this.toggleHidden();
      default:
    }
  }

  toggleHidden() {
    const keep = this.current?.name;
    this.showHidden = !this.showHidden;
    if (this.dir !== null) this.load(this.dir, keep);
    this.message = this.showHidden ? 'Showing hidden files' : 'Hiding hidden files';
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

  /** The picker's lines for a panel with a w x h usable area. */
  view(w, h) {
    const rows = Math.max(1, h - 3); // minus: path line, info line, summary line
    this._rows = rows;
    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + rows) this.offset = this.cursor - rows + 1;

    const lines = [];
    if (this.prompt) {
      const label = 'Go to folder / add file: ';
      lines.push(paint(label, { fg: C.accent, bold: true }) + this.prompt.render(Math.max(1, w - label.length)));
      lines.push(paint(fit('Enter to confirm, Esc to cancel. Paste a path, or drag a file onto the terminal.', w), { fg: C.muted }));
    } else {
      lines.push(paint(fitEnd(this.dir ?? 'This PC', w), { bold: true }));
      const info = this.message || `${this.entries.filter((e) => !e.parent).length} items`;
      lines.push(paint(fit(info, w), { fg: this.message ? C.warn : C.muted }));
    }

    const sizeW = 10;
    const nameW = Math.max(4, w - 2 - 4 - sizeW - 1);
    for (let i = this.offset; i < Math.min(this.entries.length, this.offset + rows); i++) {
      const e = this.entries[i];
      const onCursor = i === this.cursor;
      const bg = onCursor ? C.sel : undefined;
      const picked = this.selected.has(e.abs);
      const label = e.parent ? '..' : e.isDir ? `${e.name}${e.name.endsWith('\\') ? '' : '/'}` : e.name;
      let size = '';
      if (!e.parent) size = e.isDir ? 'folder' : (this._size(e.abs) == null ? '?' : formatBytes(this._size(e.abs)));
      lines.push(
        paint(onCursor ? `${G.pointer} ` : '  ', { fg: C.accent, bg }) +
          paint(e.parent ? '    ' : picked ? '[x] ' : '[ ] ', { fg: picked ? C.ok : C.muted, bold: picked, bg }) +
          paint(fit(label, nameW), { fg: e.parent ? C.muted : e.isDir ? C.accent : undefined, bold: onCursor, bg }) +
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
    let files = 0;
    let folders = 0;
    let bytes = 0;
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
