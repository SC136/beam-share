// Wires the pieces together: options -> engine (Beam) -> UI (App) -> terminal (Screen).
import { Beam } from './beam.js';
import { HELP, parseArgs, version } from './cli.js';
import { App } from './ui/app.js';
import { farewell } from './ui/art.js';
import { Screen } from './ui/term.js';
import { formatBytes, sleep } from './util.js';

export async function main(argv) {
  const { opts, error } = parseArgs(argv);
  if (error) {
    console.error(`beam: ${error}\nTry: beam --help`);
    process.exit(2);
  }
  if (opts.help) return void process.stdout.write(HELP);
  if (opts.version) return void console.log(version());
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('beam needs an interactive terminal (it draws a full-screen interface).');
    process.exit(1);
  }

  // The engine: finds peers, sends and receives.
  const beam = new Beam({
    name: opts.name,
    downloadDir: opts.dir,
    port: opts.port,
    discoveryPort: opts.discoveryPort,
    configDir: opts.configDir,
  });
  try {
    await beam.start();
  } catch (e) {
    console.error(`beam: could not start: ${e.message}`);
    process.exit(1);
  }

  // The UI: state and keys. The screen: the real terminal, which it draws on.
  const app = new App(beam);
  const screen = new Screen();
  let drawQueued = false;
  const draw = () => {
    if (drawQueued) return; // many changes in one tick produce one redraw
    drawQueued = true;
    setImmediate(() => {
      drawQueued = false;
      screen.draw(app.render(screen.w, screen.h));
    });
  };
  app.onChange = draw;
  beam.on('warning', (message) => app.flash(message, 'warn', 8000));
  const spinnerTimer = setInterval(draw, 250); // keeps spinners, ETAs and expiring messages moving

  let quitting = false;
  async function quit() {
    if (quitting) return;
    quitting = true;
    clearInterval(spinnerTimer);
    screen.leave();
    app.detach();
    const received = beam.transfers().filter((t) => t.dir === 'recv' && t.status === 'done');
    await Promise.race([beam.stop().catch(() => {}), sleep(2000)]);
    const total = received.reduce((sum, t) => sum + t.total, 0);
    console.log(['', ...farewell(received.length ? `received ${formatBytes(total)} in ${received.length} transfer(s)` : '')].join('\n'));
    if (received.length) console.log(`  saved in ${beam.downloadDir}`);
    process.exit(0);
  }
  app.onQuit = quit;
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('exit', () => screen.leave()); // never leave the terminal in raw mode / alt screen
  process.on('uncaughtException', (e) => {
    screen.leave();
    console.error(e);
    process.exit(1);
  });

  screen.enter({ onKey: (str, key) => app.handleKey(str, key), onResize: draw });
  draw();
}
