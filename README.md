```
 _
| |__   ___  __ _ _ __ ___
| '_ \ / _ \/ _` | '_ ` _ \
| |_) |  __/ (_| | | | | | |
|_.__/ \___|\__,_|_| |_| |_|
```

# beam

Send files and folders between devices on the same network, straight from the terminal. No server, no account, no cloud.

```
npx beam-share
```

Not on npm yet? Run it straight from GitHub (needs Node.js 18+ and git):

```
npx github:SC136/beam-share
```

Run that on two devices on the same Wi-Fi / LAN. They find each other automatically; pick a peer, choose files, and the other side presses **y** to accept.

```
 beam   alice  192.168.1.23:7878  id 8f6d-2a50-ed8d  ↓ ~\Downloads\beam
╭─ Peers (1) ──────────────────────────────────────────────────────────╮
│ ▸ bob            192.168.1.40:7878   3fa5-ac0d-33be   ● online       │
╰──────────────────────────────────────────────────────────────────────╯
╭─ Transfers (1 active) ───────────────────────────────────────────────╮
│ ▸ ↑ bob          holiday-photos (214 files)                 1.8 GB   │
│     ████████████████░░░░░░░░░░░░░░  52%  98.2 MB/s  ETA 9s           │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ select  s send  tab peers/transfers  x cancel  a add by IP  ? help
```

Requires Node.js 18 or newer. Works on Windows, macOS and Linux (developed and tested on Windows).

## Using it

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | move in the focused list |
| `s` / `Enter` | choose files to send to the selected peer |
| `Tab` | switch between **Peers** and **Transfers** |
| `x` | cancel the selected transfer (works for sending and receiving) |
| `a` | add a peer by IP address (when discovery is blocked) |
| `c` | clear finished transfers |
| `o` | open the download folder |
| `A` | toggle auto-accept |
| `?` | help |
| `q` / `Ctrl+C` | quit (asks first if a transfer is running) |

In the file picker: `Space` selects files **and whole folders**, `Enter`/`→` opens a folder, `←`/`Backspace` goes up, `a` selects everything, `.` toggles hidden files, `/` lets you type or paste a path (you can drag a file onto the terminal window to paste its path), `s` sends, `Esc` goes back.

Files you name on the command line start out selected:

```
npx beam-share report.pdf ./photos
```

Received files go to `~/Downloads/beam` (change with `--dir`). Nothing is ever overwritten: an existing `notes.txt` makes the incoming file `notes (1).txt`.

### Options

```
-n, --name <name>         name shown to other devices (default: computer name)
-d, --dir <folder>        where received files are saved
-p, --port <port>         TCP port to listen on (default 7878, falls back to a free one)
    --peer <host[:port]>  connect to a device by address (repeatable)
    --auto-accept         accept all incoming transfers without asking
    --no-discovery        don't broadcast or listen on the LAN
    --discovery-port <n>  UDP port for discovery (default 45454)
    --config <folder>     where this device's identity is stored
    --ascii               plain ASCII instead of box-drawing characters
```

## How it works

- **Discovery** - every instance broadcasts a tiny UDP datagram (name, TCP port, identity fingerprint) every 2 s to each network interface's broadcast address, and listens for the same. Peers that go quiet disappear after 8 s, or immediately when they quit.
- **Transport** - a direct TCP connection between the two devices, wrapped in **TLS 1.3 with mutual authentication**. Each install creates a long-lived self-signed certificate (stored in `%APPDATA%\beam` or `~/.config/beam`); its SHA-256 fingerprint is the device's identity, shown as `id xxxx-xxxx-xxxx`.
- **Protocol** - the sender offers a list of files; the receiver must accept; then each file streams as raw bytes followed by its SHA-256, which the receiver verifies before the file appears under its final name. Partial files are `*.part` and are deleted on failure or cancel.

## Security notes

What you get:

- Everything on the wire is encrypted and tamper-evident.
- Before sending, the sender checks that the certificate presented in the TLS handshake matches the fingerprint the peer announced. A device that merely *claims* another's name/address can't receive the files.
- The receiver always sees who is sending (name, address, id) and what, and must accept - unless you turn on auto-accept, which is shown as a prominent badge in the header.
- Offered paths are treated as hostile: absolute paths, `..`, drive letters, Windows reserved names and control characters are rejected or neutralised, so a sender can't write outside the download folder. Names shown on screen are stripped of terminal escape sequences.
- Limits on message size, file count and pending offers stop a misbehaving device from exhausting memory.

What you don't get (by design - this is a convenience tool for networks you mostly trust):

- **There is no trust store or pairing.** Anyone on your network can announce themselves as "alice". The `id` is what's authoritative: if it matters, compare the id in the accept prompt with the one in the sender's header.
- Identities are not persisted per contact, so there is no warning when a familiar name shows up with a new id.
- IPv4 only for discovery. Transfers can't be resumed after an interruption.

## Troubleshooting

**"Looking for devices..." never finds the other machine**

1. Both must be on the same network and subnet. Guest Wi-Fi and some corporate/campus networks isolate clients; broadcast won't cross between them.
2. **Windows Firewall**: the first run asks whether Node.js may access the network - allow **Private networks**. If you dismissed it, allow `node.exe` in *Windows Security -> Firewall -> Allow an app*. The network must be set to *Private*, not *Public*.
3. macOS/Linux: allow incoming connections for `node` if a firewall asks; UDP 45454 and TCP 7878 are used.
4. Still nothing? Press `a` and type the other device's address (shown in its header), or start with `--peer 192.168.1.40`.

**Two instances on one computer** need separate identities and download folders: give the second one `--config <folder> --dir <folder>`.

## Development

```
npm test                      # unit + end-to-end tests (real TLS, real UDP, in-process)
node bin/beam.js              # run from source
node test/bench.js 512        # loopback throughput benchmark
```

No runtime dependencies. The terminal UI is a small hand-written ANSI renderer (`src/ui/term.js`) so `npx` starts instantly.

To publish: check the name is free (`npm view beam-share`), then `npm publish`.
