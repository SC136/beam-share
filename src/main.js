import fs from 'node:fs';
import { Beam } from './beam.js';
import { HELP, parseArgs, version } from './cli.js';
import { App } from './ui/app.js';
import { Screen, setAscii } from './ui/term.js';
import { formatBytes, sleep } from './util.js';

export async function main(argv) {
  const { opts, queued, peers, help, error, version: wantVersion } = parseArgs(argv);
  if (error) {
    console.error(`beam: ${error}\nTry: beam --help`);
    process.exit(2);
  }
  if (help) return void process.stdout.write(HELP);
  if (wantVersion) return void console.log(version());
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('beam needs an interactive terminal (it draws a full-screen interface).');
    process.exit(1);
  }
  const missing = queued.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error(`beam: no such file or folder: ${missing[0]}`);
    process.exit(2);
  }
  if (opts.ascii) setAscii(true);

  const beam = new Beam({
    name: opts.name,
    downloadDir: opts.dir,
    port: opts.port,
    discoveryPort: opts.discoveryPort,
    configDir: opts.config,
    autoAccept: opts.autoAccept,
    discovery: !opts.noDiscovery,
  });
  try {
    await beam.start();
  } catch (e) {
    console.error(`beam: could not start: ${e.message}`);
    process.exit(1);
  }

  const app = new App(beam, { startDir: process.cwd(), queued });
  const screen = new Screen();
  let scheduled = false;
  const draw = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      screen.draw(app.render(screen.w, screen.h));
    });
  };
  app.onChange = draw;

  let quitting = false;
  const quit = async (code = 0) => {
    if (quitting) return;
    quitting = true;
    clearInterval(ticker);
    screen.leave();
    app.detach();
    const received = beam.transfers().filter((t) => t.dir === 'recv' && t.status === 'done');
    await Promise.race([beam.stop().catch(() => {}), sleep(2000)]);
    if (received.length) {
      const total = received.reduce((n, t) => n + t.total, 0);
      console.log(`Received ${received.length} transfer${received.length > 1 ? 's' : ''} (${formatBytes(total)}) in ${beam.downloadDir}`);
    }
    process.exit(code);
  };
  app.onQuit = () => quit(0);
  beam.on('warning', (m) => app.flash(m, 'warn', 8000));

  // Redraw regularly for spinners, ETAs and expiring messages.
  const ticker = setInterval(draw, 250);
  process.on('exit', () => screen.leave()); // never leave the terminal in raw mode / alt screen
  process.on('uncaughtException', (e) => {
    screen.leave();
    console.error(e);
    process.exit(1);
  });
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));

  screen.enter({ onKey: (s, k) => app.handleKey(s, k), onResize: draw });
  for (const p of peers) {
    beam.addPeer(p).catch((e) => app.flash(`Couldn't add ${p}: ${e.message}`, 'bad', 6000));
  }
  draw();
}
