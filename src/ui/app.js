// The UI's state and what each key does. What it all looks like is in screens.js.
// Nothing here touches the terminal directly, so it can be driven and tested without one:
// feed it keys with handleKey(), get the picture with render(width, height).
import { spawn } from 'node:child_process';
import { isActive } from '../beam.js';
import { FilePicker } from './picker.js';
import { renderScreen } from './screens.js';
import { stripAnsi } from './term.js';

/** Open a folder in the system file manager. */
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

export class App {
  /**
   * @param {import('../beam.js').Beam} beam
   * @param {object} [o]
   * @param {string} [o.startDir]  folder the file picker opens first
   * @param {Function} [o.opener]  opens a folder in the file manager (replaced in tests)
   * @param {() => number} [o.now] the clock (replaced in tests)
   */
  constructor(beam, { startDir = process.cwd(), opener = openFolder, now = Date.now } = {}) {
    this.beam = beam;
    this.opener = opener;
    this.now = now;
    this.startedAt = now();
    this.lastDir = startDir; // the picker reopens where you left it

    this.mode = 'main'; //     'main' | 'picker' | 'help'
    this.focus = 'peers'; //   which list the arrow keys move in: 'peers' | 'transfers'
    this.peerSel = null; //    id of the highlighted peer / transfer
    this.transferSel = null;
    this._newestTransfer = null;
    this.offers = beam.pendingOffers(); // incoming offers waiting for y/n, oldest first
    this.picker = null;
    this.pickerPeer = null;
    this.status = null; //     {text, kind, until}: the one-line message above the footer
    this.quitArmedUntil = 0;

    this.onChange = () => {}; // set by main.js: "redraw please"
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
    for (const [event, fn] of Object.entries(this._listeners)) beam.on(event, fn);
  }

  detach() {
    for (const [event, fn] of Object.entries(this._listeners)) this.beam.off(event, fn);
  }

  render(width, height) {
    return renderScreen(this, width, height);
  }

  flash(text, kind = 'info', ms = 4000) {
    this.status = { text, kind, until: this.now() + ms };
    this.onChange();
  }

  // ------------------------------------------------------------- selection

  peers() {
    const peers = this.beam.peers();
    if (!peers.some((p) => p.id === this.peerSel)) this.peerSel = peers[0]?.id ?? null;
    return peers;
  }

  selectedPeer() {
    return this.peers().find((p) => p.id === this.peerSel) ?? null;
  }

  transfers() {
    const list = this.beam.transfers(); // newest first
    const newest = list[0]?.id ?? null;
    // A new transfer takes the highlight only if the newest one already had it. That way a
    // transfer that starts just as you press x can never change which one gets cancelled.
    if (newest !== this._newestTransfer) {
      if (this.transferSel === this._newestTransfer || this.transferSel === null) this.transferSel = newest;
      this._newestTransfer = newest;
    }
    if (!list.some((t) => t.id === this.transferSel)) this.transferSel = newest;
    return list;
  }

  selectedTransfer() {
    return this.transfers().find((t) => t.id === this.transferSel) ?? null;
  }

  _step(delta) {
    const peersFocused = this.focus === 'peers';
    const list = peersFocused ? this.peers() : this.transfers();
    if (!list.length) return;
    const selected = peersFocused ? this.peerSel : this.transferSel;
    const i = Math.max(0, Math.min(list.length - 1, list.findIndex((x) => x.id === selected) + delta));
    if (peersFocused) this.peerSel = list[i].id;
    else this.transferSel = list[i].id;
  }

  // ------------------------------------------------------------------ keys

  handleKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') return this.requestQuit();
    if (this.mode === 'picker') this.picker.handleKey(str, key);
    else if (this.mode === 'help') this.mode = 'main'; // any key closes help
    else if (this.offers.length) this._offerKey(str, key); // an incoming offer takes over the main screen
    else this._mainKey(str, key);
    this.onChange();
  }

  requestQuit() {
    const running = this.beam.transfers().filter(isActive).length;
    if (running && this.now() > this.quitArmedUntil) {
      this.quitArmedUntil = this.now() + 3000; // ask once; a second press within 3 s really quits
      return this.flash(`${running} transfer${running > 1 ? 's' : ''} running - press q again to quit and cancel`, 'warn', 3000);
    }
    this.onQuit();
  }

  _offerKey(str, key) {
    const offer = this.offers[0];
    const yes = str === 'y' || str === 'Y' || key.name === 'return';
    const no = str === 'n' || str === 'N' || key.name === 'escape';
    if (!yes && !no) return;
    this.offers = this.offers.filter((o) => o.id !== offer.id);
    this.beam.respond(offer.id, yes);
    if (yes) this.focus = 'transfers';
  }

  _mainKey(str, key) {
    switch (key.name) {
      case 'up': return this._step(-1);
      case 'down': return this._step(1);
      case 'tab':
        this.focus = this.focus === 'peers' ? 'transfers' : 'peers';
        return;
      case 'return':
      case 'enter':
        if (this.focus === 'peers') this._openPicker();
        return;
      default:
    }
    switch (str) {
      case 'k': return this._step(-1);
      case 'j': return this._step(1);
      case 's': return this._openPicker();
      case 'x': return this._cancelSelected();
      case 'c':
        this.beam.clearFinished();
        return this.flash('Cleared finished transfers');
      case 'o':
        return this.flash(
          this.opener(this.beam.downloadDir) ? 'Opened the download folder' : `Couldn't open a file manager - files are in ${this.beam.downloadDir}`,
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

  _openPicker() {
    const peer = this.selectedPeer();
    if (!peer) return this.flash('No peer to send to yet - run beam on another device on this network', 'warn');
    this.pickerPeer = peer;
    this.picker = new FilePicker({
      startDir: this.lastDir,
      onSend: (paths) => this._send(paths),
      onCancel: () => this._closePicker(),
    });
    this.mode = 'picker';
  }

  _closePicker() {
    this.lastDir = this.picker.dir ?? this.lastDir;
    this.picker = null;
    this.mode = 'main';
  }

  _send(paths) {
    try {
      const t = this.beam.send(this.pickerPeer.id, paths);
      const peerName = this.pickerPeer.name;
      this._closePicker();
      this.focus = 'transfers';
      this.transferSel = t.id;
      this.flash(`Sending ${t.label} to ${peerName} - waiting for them to accept`, 'ok');
    } catch (e) {
      this.picker.message = e.message; // e.g. the peer disappeared; stay in the picker
    }
  }
}

/** A frame as plain text (no colours), for tests. */
export const plain = (lines) => lines.map((l) => stripAnsi(l).trimEnd());
