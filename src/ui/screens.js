// Everything the UI draws. Each function turns the app's current state into an array of
// lines. Nothing here changes state or reads the keyboard (that is app.js).
//
// The screen is: a header line, a body, a status line, and a footer listing the keys.
// The body is one of: the main screen (peers + transfers), the file picker, an incoming
// offer, or help.
import os from 'node:os';
import { isActive } from '../beam.js';
import { formatBytes, formatDuration, formatRate, shortFp } from '../util.js';
import { BRAND_WIDTH, LOGO_HEIGHT, TAGLINE, brandLines } from './art.js';
import { C, G, SPINNER, box, center, fit, padAnsi, padStart, paint, progressBar, strWidth } from './term.js';

const MIN_W = 56;
const MIN_H = 15;

/** Shorten the home folder to "~" so long paths fit. */
function tildify(p) {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + '/') || p.startsWith(home + '\\') ? '~' + p.slice(home.length) : p;
}

export function renderScreen(app, w, h) {
  if (w < MIN_W || h < MIN_H) {
    return [paint(`Terminal too small (${w}x${h}) - need at least ${MIN_W}x${MIN_H}`, { fg: C.warn })];
  }
  const bodyHeight = h - 3; // the other three rows: header, status line, footer
  let body;
  if (app.mode === 'picker') body = pickerScreen(app, w, bodyHeight);
  else if (app.mode === 'help') body = helpScreen(w, bodyHeight);
  else if (app.offers.length) body = offerScreen(app, w, bodyHeight);
  else body = mainScreen(app, w, bodyHeight);
  return [header(app), ...body, statusLine(app), footer(app, w)].map((line) => padAnsi(line, w));
}

// -------------------------------------------------------- header and footer

function header(app) {
  const info = app.beam.info();
  const address = info.addresses[0] ? `${info.addresses[0]}:${info.port}` : `port ${info.port}`;
  return (
    paint(' beam ', { bold: true, fg: 16, bg: C.accent }) +
    '  ' +
    paint(info.name, { bold: true }) +
    paint(`  ${address}  id ${shortFp(info.fingerprint ?? '')}  ${G.down} ${tildify(info.downloadDir)}`, { fg: C.muted })
  );
}

function statusLine(app) {
  if (app.mode !== 'main' && app.offers.length) {
    const n = app.offers.length;
    return paint(` ${n} incoming transfer${n > 1 ? 's' : ''} waiting - go back to the main screen (Esc) to respond`, { fg: 16, bg: C.warn });
  }
  if (app.status && app.now() < app.status.until) {
    const fg = { ok: C.ok, warn: C.warn, bad: C.bad }[app.status.kind] ?? C.accent;
    return ' ' + paint(app.status.text, { fg });
  }
  return '';
}

function footer(app, w) {
  let keys;
  if (app.mode === 'picker') {
    keys = app.picker.prompt
      ? [['enter', 'go'], ['esc', 'cancel']]
      : [['↑↓', 'move'], ['←→', 'up/open'], ['space', 'select'], ['s', 'send'], ['/', 'path'], ['.', 'hidden'], ['esc', 'back']];
  } else if (app.mode === 'help') {
    keys = [['any key', 'close']];
  } else if (app.offers.length) {
    keys = [['y', 'accept'], ['n', 'decline']];
  } else {
    keys = [['↑↓', 'select'], ['s', 'send'], ['tab', 'peers/transfers'], ['x', 'cancel'], ['o', 'open folder'], ['c', 'clear'], ['?', 'help'], ['q', 'quit']];
  }
  let out = '';
  let used = 1;
  for (const [key, label] of keys) {
    const cost = strWidth(key) + 1 + strWidth(label) + 2;
    if (used + cost > w) break; // drop the keys that don't fit
    out += paint(key, { bold: true, fg: C.accent }) + ' ' + paint(label, { fg: C.muted }) + '  ';
    used += cost;
  }
  return ' ' + out;
}

// -------------------------------------------------------------- main screen

function mainScreen(app, w, h) {
  const peers = app.peers();
  const peersHeight = Math.max(5, Math.min(9, peers.length + 2));
  return [...peersBox(app, w, peersHeight, peers), ...transfersBox(app, w, h - peersHeight, app.transfers())];
}

function peersBox(app, w, h, peers) {
  const innerW = w - 4;
  const rows = h - 2;
  const focused = app.focus === 'peers';
  const lines = [];
  if (peers.length === 0) {
    const spinner = SPINNER[Math.floor(app.now() / 150) % SPINNER.length];
    lines.push(paint(`${spinner} Looking for devices on your network...`, { fg: C.accent }));
    lines.push(paint('Run `npx beam-share` on another device (same Wi-Fi).', { fg: C.muted }));
    const waitedMs = app.now() - app.startedAt;
    if (app.beam.discoveryError) lines.push(paint(`Discovery problem: ${app.beam.discoveryError}`, { fg: C.warn }));
    else if (waitedMs > 10_000) lines.push(paint('No luck? Allow Node through the firewall (private networks).', { fg: C.warn }));
  } else {
    const showAddress = innerW >= 44; // narrow terminals drop the columns they have no room for
    const showId = innerW >= 64;
    const addressW = showAddress ? 22 : 0;
    const idW = showId ? 16 : 0;
    const nameW = Math.max(8, innerW - 2 - addressW - idW);
    const selectedIndex = Math.max(0, peers.findIndex((p) => p.id === app.peerSel));
    const first = Math.max(0, Math.min(selectedIndex - Math.floor(rows / 2), peers.length - rows)); // scroll to keep it visible
    for (const p of peers.slice(first, first + rows)) {
      const selected = p.id === app.peerSel;
      const bg = selected && focused ? C.sel : undefined;
      lines.push(
        paint(selected ? `${G.pointer} ` : '  ', { fg: C.accent, bg }) +
          paint(fit(p.name, nameW), { bold: selected, bg }) +
          (showAddress ? paint(fit(`${p.address}:${p.port}`, addressW), { fg: C.muted, bg }) : '') +
          (showId ? paint(fit(shortFp(p.id), idW), { fg: C.muted, bg }) : ''),
      );
    }
  }
  return box({ title: `Peers (${peers.length})`, w, h, lines, focused });
}

function transfersBox(app, w, h, transfers) {
  const innerW = w - 4;
  const rows = Math.max(1, Math.floor((h - 2) / 2)); // each transfer takes two lines
  const focused = app.focus === 'transfers';
  const lines = [];
  if (transfers.length === 0) {
    if (h - 2 >= LOGO_HEIGHT + 5 && innerW >= BRAND_WIDTH + 2) {
      lines.push(...brandLines(innerW));
      lines.push(' '.repeat(Math.max(0, Math.floor((innerW - TAGLINE.length) / 2))) + paint(TAGLINE, { fg: C.muted }), '');
    }
    lines.push(paint('No transfers yet.', { fg: C.muted }));
    lines.push(paint('Pick a peer above, then press s to choose files.', { fg: C.muted }));
    lines.push(paint(`Incoming files are saved to ${tildify(app.beam.downloadDir)}`, { fg: C.muted }));
  } else {
    const selectedIndex = Math.max(0, transfers.findIndex((t) => t.id === app.transferSel));
    const first = Math.max(0, Math.min(selectedIndex - Math.floor(rows / 2), transfers.length - rows));
    for (const t of transfers.slice(first, first + rows)) {
      lines.push(...transferRows(app, t, innerW, t.id === app.transferSel, focused));
    }
  }
  const active = transfers.filter(isActive).length;
  return box({ title: active ? `Transfers (${active} active)` : 'Transfers', w, h, lines, focused });
}

/** One transfer = two lines: who/what/how big, then its progress or outcome. */
function transferRows(app, t, innerW, selected, focused) {
  const bg = selected && focused ? C.sel : undefined;
  const sending = t.dir === 'send';
  const color = sending ? C.accent : C.ok;
  const P = (text, style = {}) => paint(text, { ...style, bg });

  const peerW = Math.min(16, Math.floor(innerW / 4));
  const labelW = Math.max(6, innerW - 2 - 2 - peerW - 1 - 10);
  const first =
    P(selected ? `${G.pointer} ` : '  ', { fg: C.accent }) +
    P((sending ? G.up : G.down) + ' ', { fg: color, bold: true }) +
    P(fit(t.peerName, peerW), { bold: true }) +
    P(' ' + fit(t.label, labelW)) +
    P(padStart(t.total ? formatBytes(t.total) : '', 10), { fg: C.muted });

  const spinner = SPINNER[Math.floor(app.now() / 150) % SPINNER.length];
  let detail;
  switch (t.status) {
    case 'preparing':
      detail = P(`${spinner} scanning files...`, { fg: C.muted });
      break;
    case 'waiting':
      detail = P(`${spinner} waiting for ${t.peerName} to accept...`, { fg: C.warn });
      break;
    case 'active': {
      const fraction = t.total ? t.done / t.total : 0;
      const eta = t.speed > 0 ? formatDuration((t.total - t.done) / t.speed) : '--';
      detail =
        progressBar(fraction, Math.max(8, Math.min(30, innerW - 56)), color) +
        P(` ${String(Math.floor(fraction * 100)).padStart(3)}%`, { bold: true }) +
        P(`  ${t.speed ? formatRate(t.speed) : '...'}  ETA ${eta}`, { fg: C.muted }) +
        P(`  ${formatBytes(t.done)} / ${formatBytes(t.total)}`, { fg: C.muted }) +
        (t.files > 1 ? P(`  file ${Math.min(t.filesDone + 1, t.files)}/${t.files}`, { fg: C.muted }) : '');
      break;
    }
    case 'done': {
      const seconds = Math.max(0.001, ((t.endedAt ?? app.now()) - (t.startedAt ?? t.endedAt ?? app.now())) / 1000);
      detail = P(
        `${G.ok} ${formatBytes(t.total)} in ${formatDuration(seconds)} (${formatRate(t.total / seconds)})` +
          (sending ? '' : `  ${G.down} ${tildify(t.savedTo ?? '')}`),
        { fg: C.ok },
      );
      break;
    }
    case 'rejected':
      detail = P(`${G.bad} declined${t.error && t.error !== 'declined' ? `: ${t.error}` : ''}`, { fg: C.warn });
      break;
    case 'cancelled':
      detail = P(t.error || 'cancelled', { fg: C.warn }); // t.error is only set when the other side cancelled
      break;
    default:
      detail = P(`${G.bad} ${t.error ?? 'failed'}`, { fg: C.bad });
  }
  if (t.note && t.status !== 'active') detail += P(`  (${t.note})`, { fg: C.muted });
  return [first, P('    ') + detail];
}

// ------------------------------------------------------------ other screens

function offerScreen(app, w, h) {
  const o = app.offers[0];
  const boxW = Math.min(w - 4, 74);
  const innerW = boxW - 4;
  const lines = [
    paint(o.senderName, { bold: true, fg: C.accent }) + paint(' wants to send you:', { bold: true }),
    paint(`${o.address} - id ${shortFp(o.fingerprint)}`, { fg: C.muted }) +
      (o.known ? '' : paint('  (not seen on your network)', { fg: C.warn })),
    '',
  ];
  for (const item of o.items) {
    const what = item.folder ? `${item.name}/  (${item.files} file${item.files === 1 ? '' : 's'})` : item.name;
    lines.push(paint(`${G.bullet} `, { fg: C.muted }) + fit(what, innerW - 2 - 11) + paint(padStart(formatBytes(item.bytes), 11), { fg: C.muted }));
  }
  if (o.more) lines.push(paint(`  + ${o.more} more item${o.more > 1 ? 's' : ''}`, { fg: C.muted }));
  lines.push(
    '',
    paint(`Total: ${o.count} file${o.count === 1 ? '' : 's'}, ${formatBytes(o.total)}`, { bold: true }),
    paint(`Save to: ${tildify(o.downloadDir)}`, { fg: C.muted }),
    '',
  );
  const waiting = app.offers.length - 1;
  lines.push(
    paint(' y ', { bold: true, fg: 16, bg: C.ok }) + ' Accept    ' +
      paint(' n ', { bold: true, fg: 16, bg: C.bad }) + ' Decline' +
      (waiting ? paint(`        (${waiting} more waiting)`, { fg: C.muted }) : ''),
  );
  return center(box({ title: 'Incoming transfer', w: boxW, h: lines.length + 2, lines, focused: true }), boxW, w, h);
}

function pickerScreen(app, w, h) {
  return box({ title: `Send to ${app.pickerPeer.name}`, w, h, lines: app.picker.view(w - 4, h - 2), focused: true });
}

function helpScreen(w, h) {
  const boxW = Math.min(w - 4, 76);
  // [keys, what they do] | {heading} | {note}
  const rows = [
    { heading: 'Main screen' },
    ['↑ ↓ / j k', 'move in the focused list'],
    ['tab', 'switch between Peers and Transfers'],
    ['s / enter', 'choose files to send to the selected peer'],
    ['x', 'cancel the selected transfer (focus Transfers first)'],
    ['c', 'clear finished transfers'],
    ['o', 'open the download folder'],
    ['q / ctrl+c', 'quit'],
    { heading: 'File picker' },
    ['space', 'select / unselect (files and whole folders)'],
    ['enter / →', 'open folder     ← / backspace: go up'],
    ['/', 'type or paste a path (drag a file onto the terminal)'],
    ['.', 'show / hide hidden files'],
    ['s', 'send the selection (or the highlighted item)'],
    ['esc', 'back'],
    { note: '' },
    { note: 'Everything is end-to-end encrypted (TLS 1.3). Compare the id in an' },
    { note: "incoming prompt with the one in the sender's header before accepting." },
  ];
  const lines = rows.map((row) =>
    Array.isArray(row)
      ? paint(fit(row[0], 12), { bold: true }) + row[1]
      : 'heading' in row
        ? paint(row.heading, { bold: true, fg: C.accent })
        : paint(row.note, { fg: C.muted }),
  );
  lines.length = Math.min(lines.length, h - 2);
  return center(box({ title: 'Help', w: boxW, h: lines.length + 2, lines, focused: true }), boxW, w, h);
}
