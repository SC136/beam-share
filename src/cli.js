import fs from 'node:fs';
import path from 'node:path';
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
  npx beam-share [options] [files or folders to send...]

Run it on two devices on the same network; they find each other automatically.
Pick a peer, choose files, and the other side accepts or declines.

Options:
  -n, --name <name>        name shown to other devices (default: this computer's name)
  -d, --dir <folder>       where received files are saved (default: ~/Downloads/beam)
  -p, --port <port>        TCP port to listen on (default: 7878; a free port if taken)
      --peer <host[:port]> connect to a device by address (repeatable)
      --auto-accept        accept all incoming transfers without asking
      --no-discovery       don't broadcast or listen for peers on the LAN
      --discovery-port <n> UDP port used for discovery (default: 45454)
      --config <folder>    where this device's identity is stored
      --ascii              use plain ASCII instead of box-drawing characters
  -h, --help               show this help
  -v, --version            show the version

Files or folders given on the command line are preselected when you choose a peer.
Press ? inside the app for the key bindings.
`;

const VALUE_FLAGS = {
  '-n': 'name', '--name': 'name',
  '-d': 'dir', '--dir': 'dir',
  '-p': 'port', '--port': 'port',
  '--peer': 'peer',
  '--discovery-port': 'discoveryPort',
  '--config': 'config',
};
const BOOL_FLAGS = {
  '--auto-accept': 'autoAccept',
  '--no-discovery': 'noDiscovery',
  '--ascii': 'ascii',
  '-h': 'help', '--help': 'help',
  '-v': 'version', '--version': 'version',
};

function port(name, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number (0-65535), got "${v}"`);
  return n;
}

/** @returns {{opts: object, queued: string[], peers: string[], help?: boolean, version?: boolean, error?: string}} */
export function parseArgs(argv) {
  const opts = {};
  const queued = [];
  const peers = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      let arg = argv[i];
      let inline;
      const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
      if (eq > 0) {
        inline = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
      if (arg === '--') {
        queued.push(...argv.slice(i + 1).map((p) => path.resolve(p)));
        break;
      }
      if (arg in VALUE_FLAGS) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`${arg} needs a value`);
        const key = VALUE_FLAGS[arg];
        if (key === 'peer') peers.push(v);
        else if (key === 'port') opts.port = port('--port', v);
        else if (key === 'discoveryPort') opts.discoveryPort = port('--discovery-port', v);
        else opts[key] = v;
      } else if (arg in BOOL_FLAGS) {
        opts[BOOL_FLAGS[arg]] = true;
      } else if (arg.startsWith('-') && arg.length > 1) {
        throw new Error(`unknown option ${arg}`);
      } else {
        queued.push(path.resolve(arg));
      }
    }
  } catch (e) {
    return { opts, queued, peers, error: e.message };
  }
  return { opts, queued, peers, help: opts.help, version: opts.version };
}
