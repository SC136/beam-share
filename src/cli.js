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

beam - send files to devices on your local network, or over the internet, from the terminal.

Usage:
  npx beam-share [options] [files or folders to send...]
  npx beam-share relay [options]        run a relay server for internet rooms

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

Over the internet (needs a relay server somewhere - see "beam relay --help"):
      --relay <address>    relay to use, e.g. relay.example.com or 203.0.113.5:7979
      --relay-token <t>    token the relay asks for, if it has one (or set BEAM_RELAY_TOKEN)
      --room <code|new>    join the room with this code at startup, or "new" to create one
                           (you can also press r inside the app)

Files or folders given on the command line are preselected when you choose a peer.
Press ? inside the app for the key bindings.
`;

export const RELAY_HELP = `beam relay - the server that lets devices on different networks find each other.

Usage:
  npx beam-share relay [options]

It only forwards encrypted bytes: it can't read file names or contents, and it never
learns the room codes. Run it on any machine that can be reached from the internet
(a small VPS, a Raspberry Pi with a port forward, or any host that runs Node and exposes
an HTTP/WebSocket port). Everyone then uses it with: beam --relay <this address>

Options:
  -p, --port <port>     port to listen on (default: $PORT, or 7979)
      --host <address>  address to listen on (default: 0.0.0.0)
      --token <secret>  require this token from clients (default: $BEAM_RELAY_TOKEN, or none)
      --trust-proxy     take client IPs from X-Forwarded-For (use behind a hosting platform's proxy)
  -h, --help            show this help

Without --token anyone who finds the relay can use its bandwidth. Set one for a public relay.
`;

const VALUE_FLAGS = {
  '-n': 'name', '--name': 'name',
  '-d': 'dir', '--dir': 'dir',
  '-p': 'port', '--port': 'port',
  '--peer': 'peer',
  '--discovery-port': 'discoveryPort',
  '--config': 'config',
  '--relay': 'relay',
  '--relay-token': 'relayToken',
  '--room': 'room',
};
const BOOL_FLAGS = {
  '--auto-accept': 'autoAccept',
  '--no-discovery': 'noDiscovery',
  '--ascii': 'ascii',
  '-h': 'help', '--help': 'help',
  '-v': 'version', '--version': 'version',
};

const RELAY_VALUE_FLAGS = { '-p': 'port', '--port': 'port', '--host': 'host', '--token': 'token' };
const RELAY_BOOL_FLAGS = { '--trust-proxy': 'trustProxy', '-h': 'help', '--help': 'help' };

function port(name, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number (0-65535), got "${v}"`);
  return n;
}

/** Split "--flag=value" into [flag, value]. */
function splitInline(arg) {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
}

function parseRelayArgs(argv) {
  const opts = { port: process.env.PORT ? Number(process.env.PORT) : 7979, host: '0.0.0.0', token: process.env.BEAM_RELAY_TOKEN || null };
  try {
    for (let i = 0; i < argv.length; i++) {
      const [arg, inline] = splitInline(argv[i]);
      if (arg in RELAY_VALUE_FLAGS) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`${arg} needs a value`);
        const key = RELAY_VALUE_FLAGS[arg];
        opts[key] = key === 'port' ? port('--port', v) : v;
      } else if (arg in RELAY_BOOL_FLAGS) {
        opts[RELAY_BOOL_FLAGS[arg]] = true;
      } else {
        throw new Error(`unknown relay option ${arg}`);
      }
    }
  } catch (e) {
    return { command: 'relay', opts, error: e.message };
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    return { command: 'relay', opts, error: `PORT must be a port number (0-65535), got "${process.env.PORT}"` };
  }
  return { command: 'relay', opts, help: opts.help };
}

/**
 * @returns {{command: 'app'|'relay', opts: object, queued?: string[], peers?: string[], help?: boolean, version?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  if (argv[0] === 'relay') return parseRelayArgs(argv.slice(1));
  const opts = {};
  const queued = [];
  const peers = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      const [arg, inline] = splitInline(argv[i]);
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
    return { command: 'app', opts, queued, peers, error: e.message };
  }
  return { command: 'app', opts, queued, peers, help: opts.help, version: opts.version };
}
