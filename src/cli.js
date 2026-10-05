// Command-line handling: the help text and turning argv into options.
import fs from 'node:fs';
import { plainBrand } from './ui/art.js';

export function version() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export const HELP = `${plainBrand().join('\n')}

beam - send files to devices on your local network, from the terminal.

Usage:
  npx beam-share [options]

Run it on two devices on the same network; they find each other automatically.
Pick a peer, choose files, and the other side accepts or declines.

Options:
  -n, --name <name>        name shown to other devices (default: this computer's name)
  -d, --dir <folder>       where received files are saved (default: ~/Downloads/beam)
  -p, --port <port>        TCP port to listen on (default: 7878; a free port if taken)
      --discovery-port <n> UDP port used to find devices (default: 45454)
      --config <folder>    where this device's identity is stored
  -h, --help               show this help
  -v, --version            show the version

Press ? inside the app for the key bindings.
`;

// option -> [name in the result, takes a value?]
const OPTIONS = {
  '-n': ['name', true], '--name': ['name', true],
  '-d': ['dir', true], '--dir': ['dir', true],
  '-p': ['port', true], '--port': ['port', true],
  '--discovery-port': ['discoveryPort', true],
  '--config': ['configDir', true],
  '-h': ['help', false], '--help': ['help', false],
  '-v': ['version', false], '--version': ['version', false],
};

function toPort(option, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${option} must be a port number (0-65535), got "${value}"`);
  return n;
}

/** @returns {{opts: object, error?: string}}  opts has: name, dir, port, discoveryPort, configDir, help, version */
export function parseArgs(argv) {
  const opts = {};
  try {
    for (let i = 0; i < argv.length; i++) {
      let arg = argv[i];
      let value; // for the "--name=value" form
      if (arg.startsWith('--') && arg.includes('=')) [arg, value] = [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
      const option = OPTIONS[arg];
      if (!option) throw new Error(arg.startsWith('-') ? `unknown option ${arg}` : `unexpected argument "${arg}"`);
      const [name, takesValue] = option;
      if (!takesValue) {
        opts[name] = true;
        continue;
      }
      value ??= argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      opts[name] = name === 'port' || name === 'discoveryPort' ? toPort(arg, value) : value;
    }
  } catch (e) {
    return { opts, error: e.message };
  }
  return { opts };
}
