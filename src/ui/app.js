// The TUI: pure state + render(w,h) -> lines, and handleKey(str,key). Screen
// wiring lives in bin/beam.js, so everything here is testable without a terminal.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { isActive } from '../beam.js';
import { formatBytes, formatDuration, formatRate, shortFp } from '../util.js';
import { LOGO_HEIGHT, LOGO_WIDTH, TAGLINE, linkLine, logoLines } from './art.js';
import { TextInput } from './input.js';
import { FilePicker } from './picker.js';
import { C, G, SPINNER, box, center, fit, padAnsi, padStart, paint, progressBar, stripAnsi, strWidth } from './term.js';

const MIN_W = 56;
const MIN_H = 15;

const tildify = (p) => {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + '/') || p.startsWith(home + '\\') ? '~' + p.slice(home.length) : p;
};

export function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const key = (k, label) => ({ k, label });

export class App {
  /**
   * @param {import('../beam.js').Beam} beam
   * @param {object} [o]
   * @param {string} [o.startDir]   where the file picker opens
   * @param {string[]} [o.queued]   paths given on the command line, preselected in the picker
   */
  constructor(beam, { startDir = process.cwd(), queued = [], opener = openFolder, now = Date.now } = {}) {
    this.beam = beam;
    this.opener = opener;
    this.now = now;
    this.startedAt = now();
    this.lastDir = startDir;
    this.queued = queued;

    this.mode = 'main'; // main | picker | addpeer | help
    this.focus = 'peers'; // peers | transfers
    this.peerSel = null;
    this.transferSel = null;
    this._newestSeen = null;
    this.offers = beam.pendingOffers();
    this.picker = null;
    this.pickerPeer = null;
    this.input = null;
    this.status = null;
    this.quitArmedUntil = 0;

    this.onChange = () => {};
    this.onQuit = () => {};
    this._listeners = {
      change: () => this.onChange(),
      offer: (o) => {
        this.offers.push(o);
        this.onChange();
      },
      'offer-gone': (id) => {
        this.offers = this.offers.filter((o) => o.id !== id);
        this.onChange();
      },
    };
    for (const [ev, fn] of Object.entries(this._listeners)) beam.on(ev, fn);
  }

  detach() {
    for (const [ev, fn] of Object.entries(this._listeners)) this.beam.off(ev, fn);
  }

  flash(text, kind = 'info', ms = 4000) {
    this.status = { text, kind, until: this.now() + ms };
    this.onChange();
  }

  // ------------------------------------------------------------- selection

  _peers() {
    const peers = this.beam.peers();
    if (!peers.some((p) => p.id === this.peerSel)) this.peerSel = peers[0]?.id ?? null;
    return peers;
  }

  selectedPeer() {
    return this._peers().find((p) => p.id === this.peerSel) ?? null;
  }

  _transfers() {
    const list = this.beam.transfers();
    const newest = list[0]?.id ?? null;
    // A new transfer takes the highlight only if it was already on the newest one
    // (or nothing), so a transfer that starts while you're about to press x can
    // never silently change which one gets cancelled.
    if (newest !== this._newestSeen) {
      if (this.transferSel === this._newestSeen || this.transferSel === null) this.transferSel = newest;
      this._newestSeen = newest;
    }
    if (!list.some((t) => t.id === this.transferSel)) this.transferSel = newest;
    return list;
  }

  selectedTransfer() {
    return this._transfers().find((t) => t.id === this.transferSel) ?? null;
  }

  _step(delta) {
    const [list, sel, field] =
      this.focus === 'peers' ? [this._peers(), this.peerSel, 'peerSel'] : [this._transfers(), this.transferSel, 'transferSel'];
    if (!list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, list.findIndex((x) => x.id === sel) + delta));
    this[field] = list[i].id;
  }

  // ----------------------------------------------------------------- input

  handleKey(str, k = {}) {
    if (k.ctrl && k.name === 'c') return this.requestQuit();
    if (this.mode === 'picker') this.picker.handleKey(str, k);
    else if (this.mode === 'addpeer') this._addPeerKey(str, k);
    else if (this.mode === 'help') this.mode = 'main';
    else if (this.offers.length) this._offerKey(str, k);
    else this._mainKey(str, k);
    this.onChange();
  }

  requestQuit() {
    const running = this.beam.transfers().filter(isActive).length;
    if (running && this.now() > this.quitArmedUntil) {
      this.quitArmedUntil = this.now() + 3000;
      return this.flash(`${running} transfer${running > 1 ? 's' : ''} running - press q again to quit and cancel`, 'warn', 3000);
    }
    this.onQuit();
  }

  _offerKey(str, k) {
    const offer = this.offers[0];
    if (str === 'y' || str === 'Y' || k.name === 'return') this._answer(offer, true);
    else if (str === 'n' || str === 'N' || k.name === 'escape') this._answer(offer, false);
  }

  _answer(offer, accept) {
    this.offers = this.offers.filter((o) => o.id !== offer.id);
    this.beam.respond(offer.id, accept);
    if (accept) this.focus = 'transfers';
  }

  _mainKey(str, k) {
    switch (k.name) {
      case 'up': return this._step(-1);
      case 'down': return this._step(1);
      case 'tab':
        this.focus = this.focus === 'peers' ? 'transfers' : 'peers';
        return;
      case 'return':
      case 'enter':
        if (this.focus === 'peers') return this._openPicker();
        return;
      case 'escape': return;
      default:
    }
    switch (str) {
      case 'k': return this._step(-1);
      case 'j': return this._step(1);
      case 's': return this._openPicker();
      case 'a':
        this.input = new TextInput('');
        this.mode = 'addpeer';
        return;
      case 'x': return this._cancelSelected();
      case 'c':
        this.beam.clearFinished();
        return this.flash('Cleared finished transfers');
      case 'o':
        return this.flash(
          this.opener(this.beam.downloadDir) ? `Opened ${tildify(this.beam.downloadDir)}` : `Couldn't open a file manager - files are in ${this.beam.downloadDir}`,
        );
      case 'A':
        this.beam.autoAccept = !this.beam.autoAccept;
        return this.flash(
          this.beam.autoAccept ? 'Auto-accept ON - incoming files are saved without asking' : 'Auto-accept off',
          this.beam.autoAccept ? 'warn' : 'info',
        );
      case '?':
        this.mode = 'help';
        return;
      case 'q': return this.requestQuit();
      default:
    }
  }

  _cancelSelected() {
    if (this.focus !== 'transfers') {
      this.focus = 'transfers';
      return this.flash('Pick a transfer with the arrow keys, then press x to cancel it');
    }
    const t = this.selectedTransfer();
    if (!t) return;
    if (!isActive(t)) return this.flash('That transfer already finished (c clears finished ones)');
    this.beam.cancel(t.id);
    this.flash('Cancelling...');
  }

  _addPeerKey(str, k) {
    const r = this.input.handle(str, k);
    if (r === 'cancel') {
      this.mode = 'main';
      this.input = null;
    } else if (r === 'submit') {
      const addr = this.input.value;
      this.mode = 'main';
      this.input = null;
      if (!addr.trim()) return;
      this.flash(`Connecting to ${addr.trim()}...`);
      this.beam.addPeer(addr).then(
        (p) => {
          this.peerSel = p.id;
          this.focus = 'peers';
          this.flash(`Added ${p.name}`, 'ok');
        },
        (e) => this.flash(`Couldn't add ${addr.trim()}: ${e.message}`, 'bad', 6000),
      );
    }
  }

  _openPicker() {
    const peer = this.selectedPeer();
    if (!peer) return this.flash('No peer to send to yet - see the hint above, or press a to add one', 'warn');
    if (!peer.online) this.flash(`${peer.name} looks offline - trying anyway`, 'warn');
    this.pickerPeer = peer;
    this.picker = new FilePicker({
      startDir: this.lastDir,
      preselect: this.queued,
      onSend: (paths) => this._send(paths),
      onCancel: () => {
        this.lastDir = this.picker.dir ?? this.lastDir;
        this.mode = 'main';
        this.picker = null;
      },
    });
    this.mode = 'picker';
  }

  _send(paths) {
    try {
      const t = this.beam.send(this.pickerPeer.id, paths);
      this.lastDir = this.picker.dir ?? this.lastDir;
      this.queued = [];
      this.mode = 'main';
      this.picker = null;
      this.focus = 'transfers';
      this.transferSel = t.id;
      this.flash(`Sending ${t.label} to ${this.pickerPeer.name} - waiting for them to accept`, 'ok');
    } catch (e) {
      this.picker.message = e.message;
    }
  }

  // ---------------------------------------------------------------- render

  render(w, h) {
    if (w < MIN_W || h < MIN_H) {
      const msg = `Terminal too small (${w}x${h}) - need at least ${MIN_W}x${MIN_H}`;
      return [paint(msg, { fg: C.warn })];
    }
    const bodyH = h - 3;
    let body;
    if (this.mode === 'picker') body = this._pickerBody(w, bodyH);
    else if (this.mode === 'addpeer') body = this._addPeerBody(w, bodyH);
    else if (this.mode === 'help') body = this._helpBody(w, bodyH);
    else if (this.offers.length) body = this._offerBody(w, bodyH);
    else body = this._mainBody(w, bodyH);
    return [this._header(w), ...body, this._statusLine(w), this._footer(w)].map((l) => padAnsi(l, w));
  }

  _header(w) {
    const info = this.beam.info();
    const addr = info.addresses[0] ? `${info.addresses[0]}:${info.port}` : `port ${info.port}`;
    // Most important first: if the line is too long, it's the tail that gets clipped.
    // The auto-accept badge is a safety signal, so the name gives way to it.
    const badge = this.beam.autoAccept ? '  ' + paint(' AUTO-ACCEPT ', { bold: true, fg: 16, bg: C.warn }) : '';
    const nameRoom = Math.max(6, w - 8 - (badge ? 15 : 0));
    const name = fit(info.name, Math.min(strWidth(info.name), nameRoom));
    let s = paint(' beam ', { bold: true, fg: 16, bg: C.accent }) + '  ' + paint(name, { bold: true }) + badge;
    return s + paint(`  ${addr}  id ${shortFp(info.fingerprint ?? '')}  ${G.down} ${tildify(info.downloadDir)}`, { fg: C.muted });
  }

  _statusLine(w) {
    if (this.mode !== 'main' && this.offers.length) {
      const n = this.offers.length;
      return paint(` ${n} incoming transfer${n > 1 ? 's' : ''} waiting - go back to the main screen (Esc) to respond`, { fg: 16, bg: C.warn });
    }
    if (this.status && this.now() < this.status.until) {
      const fg = { ok: C.ok, warn: C.warn, bad: C.bad }[this.status.kind] ?? C.accent;
      return ' ' + paint(this.status.text, { fg });
    }
    return '';
  }

  _footer(w) {
    let keys;
    if (this.mode === 'picker') {
      keys = this.picker.prompt
        ? [key('enter', 'go'), key('esc', 'cancel')]
        : [key('↑↓', 'move'), key('←→', 'up/open'), key('space', 'select'), key('s', 'send'), key('/', 'path'), key('.', 'hidden'), key('a', 'all'), key('esc', 'back')];
    } else if (this.mode === 'addpeer') keys = [key('enter', 'connect'), key('esc', 'cancel')];
    else if (this.mode === 'help') keys = [key('any key', 'close')];
    else if (this.offers.length) keys = [key('y', 'accept'), key('n', 'decline')];
    else {
      keys = [
        key('↑↓', 'select'), key('s', 'send'), key('tab', 'peers/transfers'), key('x', 'cancel'), key('a', 'add by IP'),
        key('o', 'open folder'), key('c', 'clear'), key('?', 'help'), key('q', 'quit'),
      ];
    }
    let out = '';
    let width = 1;
    for (const { k, label } of keys) {
      const cost = strWidth(k) + 1 + strWidth(label) + 2;
      if (width + cost > w) break;
      out += paint(k, { bold: true, fg: C.accent }) + ' ' + paint(label, { fg: C.muted }) + '  ';
      width += cost;
    }
    return ' ' + out;
  }

  _mainBody(w, h) {
    const peers = this._peers();
    // Taller while empty, to make room for the searching animation.
    const peersH = peers.length === 0 ? 7 : Math.max(5, Math.min(9, peers.length + 2));
    return [
      ...this._peersBox(w, peersH, peers),
      ...this._transfersBox(w, h - peersH, this._transfers()),
    ];
  }

  _peersBox(w, h, peers) {
    const iw = w - 4;
    const rows = h - 2;
    const focused = this.focus === 'peers';
    const lines = [];
    if (peers.length === 0) {
      const spin = SPINNER[Math.floor(this.now() / 150) % SPINNER.length];
      lines.push(linkLine(Math.floor(this.now() / 120), iw));
      lines.push(paint(`${spin} Looking for devices on your network...`, { fg: C.accent }));
      lines.push(paint('Run `npx beam-share` on another device (same Wi-Fi).', { fg: C.muted }));
      const waited = this.now() - this.startedAt;
      if (this.beam.discoveryError) lines.push(paint(`Discovery problem: ${this.beam.discoveryError}`, { fg: C.warn }));
      else if (waited > 10_000) lines.push(paint('No luck? Allow Node in the firewall, or press a.', { fg: C.warn }));
      else lines.push(paint("Can't see it? Press a to connect by IP address.", { fg: C.muted }));
    } else {
      const showAddr = iw >= 44;
      const showFp = iw >= 64;
      const addrW = showAddr ? 22 : 0;
      const fpW = showFp ? 16 : 0;
      const tagW = 9;
      const nameW = Math.max(8, iw - 2 - addrW - fpW - tagW);
      const idx = Math.max(0, peers.findIndex((p) => p.id === this.peerSel));
      const start = Math.max(0, Math.min(idx - Math.floor(rows / 2), peers.length - rows));
      for (const p of peers.slice(start, start + rows)) {
        const sel = p.id === this.peerSel;
        const bg = sel && focused ? C.sel : undefined;
        lines.push(
          paint(sel ? `${G.pointer} ` : '  ', { fg: C.accent, bg }) +
            paint(fit(p.name, nameW), { bold: sel, bg }) +
            (showAddr ? paint(fit(`${p.address}:${p.port}`, addrW), { fg: C.muted, bg }) : '') +
            (showFp ? paint(fit(shortFp(p.id), fpW), { fg: C.muted, bg }) : '') +
            paint(fit(p.online ? `${G.on} online` : `${G.off} offline`, tagW), { fg: p.online ? C.ok : C.bad, bg }),
        );
      }
    }
    return box({ title: `Peers (${peers.length})`, w, h, lines, focused });
  }

  _transfersBox(w, h, transfers) {
    const iw = w - 4;
    const rows = Math.max(1, Math.floor((h - 2) / 2));
    const focused = this.focus === 'transfers';
    const lines = [];
    if (transfers.length === 0) {
      // The wordmark only appears when there's room for it plus the three hint lines.
      if (h - 2 >= LOGO_HEIGHT + 5 && iw >= LOGO_WIDTH + 2) {
        lines.push(...logoLines(iw));
        const pad = Math.max(0, Math.floor((iw - TAGLINE.length) / 2));
        lines.push(' '.repeat(pad) + paint(TAGLINE, { fg: C.muted }), '');
      }
      lines.push(paint('No transfers yet.', { fg: C.muted }));
      lines.push(paint('Pick a peer above, then press s to choose files.', { fg: C.muted }));
      lines.push(paint(`Incoming files are saved to ${tildify(this.beam.downloadDir)}`, { fg: C.muted }));
    } else {
      const idx = Math.max(0, transfers.findIndex((t) => t.id === this.transferSel));
      const start = Math.max(0, Math.min(idx - Math.floor(rows / 2), transfers.length - rows));
      for (const t of transfers.slice(start, start + rows)) {
        lines.push(...this._transferRow(t, iw, t.id === this.transferSel, focused));
      }
    }
    const active = transfers.filter(isActive).length;
    return box({ title: active ? `Transfers (${active} active)` : 'Transfers', w, h, lines, focused });
  }

  _transferRow(t, iw, selected, focused) {
    const bg = selected && focused ? C.sel : undefined;
    const send = t.dir === 'send';
    const dirColor = send ? C.accent : C.ok;
    const sizeText = t.total ? formatBytes(t.total) : '';
    const peerW = Math.min(16, Math.floor(iw / 4));
    const labelW = Math.max(6, iw - 2 - 2 - peerW - 1 - 10);

    const line1 =
      paint(selected ? `${G.pointer} ` : '  ', { fg: C.accent, bg }) +
      paint((send ? G.up : G.down) + ' ', { fg: dirColor, bold: true, bg }) +
      paint(fit(t.peerName, peerW), { bold: true, bg }) +
      paint(' ' + fit(t.label, labelW), { bg }) +
      paint(padStart(sizeText, 10), { fg: C.muted, bg });

    const P = (text, o = {}) => paint(text, { ...o, bg });
    let detail;
    const spin = SPINNER[Math.floor(this.now() / 150) % SPINNER.length];
    switch (t.status) {
      case 'preparing':
        detail = P(`${spin} scanning files...`, { fg: C.muted });
        break;
      case 'waiting':
        detail = P(`${spin} waiting for ${t.peerName} to accept...`, { fg: C.warn });
        break;
      case 'active': {
        const frac = t.total ? t.done / t.total : 0;
        const bw = Math.max(8, Math.min(30, iw - 56));
        const eta = t.speed > 0 ? formatDuration((t.total - t.done) / t.speed) : '--';
        detail =
          progressBar(frac, bw, dirColor) +
          P(` ${String(Math.floor(frac * 100)).padStart(3)}%`, { bold: true }) +
          P(`  ${t.speed ? formatRate(t.speed) : '...'}  ETA ${eta}`, { fg: C.muted }) +
          P(`  ${formatBytes(t.done)} / ${formatBytes(t.total)}`, { fg: C.muted }) +
          (t.files > 1 ? P(`  file ${Math.min(t.filesDone + 1, t.files)}/${t.files}`, { fg: C.muted }) : '');
        break;
      }
      case 'done': {
        const secs = Math.max(0.001, ((t.endedAt ?? this.now()) - (t.startedAt ?? t.endedAt ?? this.now())) / 1000);
        detail = P(
          `${G.ok} ${formatBytes(t.total)} in ${formatDuration(secs)} (${formatRate(t.total / secs)})` +
            (send ? '' : `  ${G.down} ${tildify(t.savedTo ?? '')}`),
          { fg: C.ok },
        );
        break;
      }
      case 'rejected':
        detail = P(`${G.bad} declined${t.error && t.error !== 'declined' ? `: ${t.error}` : ''}`, { fg: C.warn });
        break;
      case 'cancelled':
        detail = P(t.error || 'cancelled', { fg: C.warn }); // error is only set when the other side cancelled
        break;
      default:
        detail = P(`${G.bad} ${t.error ?? 'failed'}`, { fg: C.bad });
    }
    if (t.note && t.status !== 'active') detail += P(`  (${t.note})`, { fg: C.muted });
    return [line1, P('    ', {}) + detail];
  }

  _offerBody(w, h) {
    const o = this.offers[0];
    const bw = Math.min(w - 4, 74);
    const iw = bw - 4;
    const lines = [];
    lines.push(paint(o.peerName, { bold: true, fg: C.accent }) + paint(' wants to send you:', { bold: true }));
    lines.push(
      paint(`${o.address} - id ${shortFp(o.fingerprint)}`, { fg: C.muted }) +
        (o.known ? '' : paint('  (not in your peer list)', { fg: C.warn })),
    );
    lines.push('');
    for (const it of o.items) {
      const what = it.folder ? `${it.name}/  (${it.files} file${it.files === 1 ? '' : 's'})` : it.name;
      lines.push(paint(`${G.bullet} `, { fg: C.muted }) + fit(what, iw - 2 - 11) + paint(padStart(formatBytes(it.bytes), 11), { fg: C.muted }));
    }
    if (o.more) lines.push(paint(`  + ${o.more} more item${o.more > 1 ? 's' : ''}`, { fg: C.muted }));
    lines.push('');
    lines.push(paint(`Total: ${o.count} file${o.count === 1 ? '' : 's'}, ${formatBytes(o.total)}`, { bold: true }));
    lines.push(paint(`Save to: ${tildify(o.downloadDir)}`, { fg: C.muted }));
    lines.push('');
    const more = this.offers.length - 1;
    lines.push(
      paint(' y ', { bold: true, fg: 16, bg: C.ok }) + ' Accept    ' +
        paint(' n ', { bold: true, fg: 16, bg: C.bad }) + ' Decline' +
        (more ? paint(`        (${more} more waiting)`, { fg: C.muted }) : ''),
    );
    const boxLines = box({ title: 'Incoming transfer', w: bw, h: lines.length + 2, lines, focused: true });
    return center(boxLines, bw, w, h);
  }

  _addPeerBody(w, h) {
    const bw = Math.min(w - 4, 64);
    const iw = bw - 4;
    const lines = [
      paint('Connect to a device by address', { bold: true }),
      paint('Use this when automatic discovery is blocked (different subnet, guest Wi-Fi...).', { fg: C.muted }),
      '',
      paint('Address: ', { fg: C.accent, bold: true }) + this.input.render(iw - 9),
      '',
      paint('Examples: 192.168.1.20   192.168.1.20:7878   my-laptop.local', { fg: C.muted }),
    ];
    return center(box({ title: 'Add peer', w: bw, h: lines.length + 2, lines, focused: true }), bw, w, h);
  }

  _pickerBody(w, h) {
    return box({
      title: `Send to ${this.pickerPeer.name}`,
      w,
      h,
      lines: this.picker.view(w - 4, h - 2),
      focused: true,
    });
  }

  _helpBody(w, h) {
    const bw = Math.min(w - 4, 76);
    const rows = [
      ['Main screen', ''],
      ['↑ ↓ / j k', 'move in the focused list'],
      ['tab', 'switch between Peers and Transfers'],
      ['s / enter', 'choose files to send to the selected peer'],
      ['a', 'add a peer by IP address (if discovery is blocked)'],
      ['x', 'cancel the selected transfer (focus Transfers first)'],
      ['c', 'clear finished transfers'],
      ['o', 'open the download folder'],
      ['A', 'toggle auto-accept for incoming transfers'],
      ['q / ctrl+c', 'quit'],
      ['', ''],
      ['File picker', ''],
      ['space', 'select / unselect (files and whole folders)'],
      ['enter / →', 'open folder     ← / backspace: go up'],
      ['/', 'type or paste a path (drag a file onto the terminal)'],
      ['s', 'send selection (or the highlighted item)'],
      ['', ''],
      ['Everything is end-to-end encrypted (TLS 1.3). Check the id shown for a', ''],
      ['peer matches what they see in their header before trusting a sender.', ''],
    ];
    const lines = rows.map(([a, b]) =>
      b === '' && a && !a.includes(' ') ? paint(a, { bold: true, fg: C.accent }) : paint(fit(a, 12), { bold: true }) + paint(b, { fg: b ? undefined : C.muted }),
    );
    return center(box({ title: 'Help', w: bw, h: lines.length + 2, lines, focused: true }), bw, w, h);
  }
}

/** Plain-text version of a frame, for tests. */
export const plain = (lines) => lines.map((l) => stripAnsi(l).trimEnd());
