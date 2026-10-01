```
            _
           | |__   ___  __ _ _ __ ___
 /\_/\     | '_ \ / _ \/ _` | '_ ` _ \
( o.o )    | |_) |  __/ (_| | | | | | |
 > ^ <-    |_.__/ \___|\__,_|_| |_| |_|
```

# beam

Send files and folders to other devices straight from the terminal - on your local network, or anywhere over the internet. No accounts, no cloud storage, everything encrypted end to end.

```
npx beam-share
```

Not on npm yet? Run it straight from GitHub (needs Node.js 18+ and git):

```
npx github:SC136/beam-share
```

Run that on two devices on the same Wi-Fi / LAN. They find each other automatically; pick a peer, choose files, and the other side presses **y** to accept. For devices on different networks, see [Over the internet](#over-the-internet).

```
 beam   alice  192.168.1.23:7878  id 8f6d-2a50-ed8d  ↓ ~\Downloads\beam
╭─ Peers (1) ──────────────────────────────────────────────────────────╮
│ ▸ bob            192.168.1.40:7878   3fa5-ac0d-33be   ● online       │
╰──────────────────────────────────────────────────────────────────────╯
╭─ Transfers (1 active) ───────────────────────────────────────────────╮
│ ▸ ↑ bob          holiday-photos (214 files)                 1.8 GB   │
│     ████████████████░░░░░░░░░░░░░░  52%  98.2 MB/s  ETA 9s           │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ select  s send  r internet  tab peers/transfers  x cancel  ? help
```

Requires Node.js 18 or newer. Works on Windows, macOS and Linux (developed and tested on Windows).

## Using it

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | move in the focused list |
| `s` / `Enter` | choose files to send to the selected peer |
| `r` | **internet room**: create or join one (see below) |
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

    --relay <address>     relay server for internet rooms
    --relay-token <t>     the relay's token, if it has one (or set BEAM_RELAY_TOKEN)
    --room <code|new>     join a room at startup, or "new" to create one
```

## Over the internet

Two devices on different networks can't reach each other directly: both sit behind routers that don't accept incoming connections. So beam uses a small **relay server** that introduces devices and carries their traffic, and **rooms** to keep it private:

1. Someone runs a relay once, for everyone (see [Running a relay](#running-a-relay)).
2. One person presses `r`, then `c`, to **create a room**. They get a code like `jelly-grape-drum-jar-brush`.
3. Their friends press `r`, then `j`, and type the code.
4. Everyone in the room appears in the Peers list marked `via relay`. Send files exactly as you would on a LAN - the receiver still has to accept.

From the command line: `npx beam-share --relay relay.example.com --room new` creates a room and shows its code; `--room <code>` joins one. The relay you choose in the app is remembered in the config folder (the room code and token never are).

If a device is reachable both on the LAN and through a room, beam uses the direct LAN connection and falls back to the relay if that fails.

### Running a relay

```
npx beam-share relay                   # listens on port 7979 (or $PORT)
npx beam-share relay --token s3cret    # require a token - do this on the open internet
```

It has to be reachable from everyone's networks. Ways to do that:

- **A small VPS** (any provider): open the port and run the command, ideally under a process manager so it restarts.
- **A home server or Raspberry Pi** with a port forward on your router.
- **A hosting platform** that runs Node and exposes an HTTP/WebSocket port. The relay speaks plain HTTP + WebSocket, so it works behind a platform's TLS proxy: set the start command to `npx beam-share relay --trust-proxy` (the platform's `PORT` variable is picked up automatically) and have everyone use `--relay your-app.example.com`. Free tiers often sleep when idle, so the first connection after a quiet spell may need a retry.
- **A tunnel** that forwards HTTP/WebSocket traffic to your own PC is handy for a quick test (I have not tried any specific service).

How clients write the address: `relay.example.com` means `wss://` on port 443 (what hosting platforms give you); `203.0.113.5:7979` or an IP means plain `ws://`; a full `ws://` or `wss://` URL is used as is. A relay with `--token` rejects clients that don't pass the same `--relay-token`.

The relay does a few other things to protect itself: it caps room sizes (16 devices), concurrent pipes, connections per IP and join attempts per minute, and drops connections that don't speak up within 10 seconds.

### How rooms stay private

- **The relay never sees your files or names.** Devices run ordinary mutual TLS 1.3 *through* it, so it only forwards ciphertext. It does see IP addresses, timing and how much data moves.
- **The relay never learns the room code.** The code is stretched with scrypt into a room id (all the relay sees) and a secret key that never leaves your device.
- **A relay can't sit in the middle.** After the TLS handshake both ends exchange a MAC over that session's TLS exporter secret, keyed by the room code. A relay that terminates TLS separately toward each side produces two different sessions, so the MACs don't match and the connection is refused before anything is sent. (There's a test that does exactly this attack.)
- **The code is the password for the room.** Anyone who has it can join and show up in your Peers list, though you still approve every transfer. Share it privately, and leave the room (`r`, `l`) to retire it. Generated codes are five random words (about 40 bits); beam warns if you type a short code of your own, because short codes can be guessed.

## The cat

A small cat lives in the header and reacts to what's going on:

| Face | Meaning |
| --- | --- |
| `=<.<=` `=>.>=` | looking around - no peers found yet |
| `=o.o=` | content (blinks now and then, tail wags in the big picture) |
| `=O.O=` | startled - an incoming transfer is waiting for you |
| `=^w^=` | purring - a transfer is running |
| `=^.^=` | happy - one just finished (and it says "meow!") |
| `=;.;=` | sad - one just failed |
| `=-.-=` | asleep - nobody has touched the keyboard for two minutes |

The big cat sits next to the logo when the Transfers panel is empty, and waves goodbye when you quit.

## How it works

- **Discovery (LAN)** - every instance broadcasts a tiny UDP datagram (name, TCP port, identity fingerprint) every 2 s to each network interface's broadcast address, and listens for the same. Peers that go quiet disappear after 8 s, or immediately when they quit.
- **Rooms (internet)** - devices keep a WebSocket connection to the relay under their room id. When a device wants to talk to another, the relay announces it, both open a fresh connection, and the relay pipes the two together.
- **Transport** - a TLS 1.3 connection with mutual authentication, either direct over TCP or through a relay pipe. Each install creates a long-lived self-signed certificate (stored in `%APPDATA%\beam` or `~/.config/beam`); its SHA-256 fingerprint is the device's identity, shown as `id xxxx-xxxx-xxxx`.
- **Protocol** - the sender offers a list of files; the receiver must accept; then each file streams as raw bytes followed by its SHA-256, which the receiver verifies before the file appears under its final name. Partial files are `*.part` and are deleted on failure or cancel.

## Security notes

What you get:

- Everything on the wire is encrypted and tamper-evident, on the LAN and through a relay.
- Before sending, the sender checks that the certificate presented in the TLS handshake matches the fingerprint the peer announced. A device that merely *claims* another's name/address can't receive the files.
- The receiver always sees who is sending (name, address or "via relay", id) and what, and must accept - unless you turn on auto-accept, which is shown as a prominent badge in the header.
- Offered paths are treated as hostile: absolute paths, `..`, drive letters, Windows reserved names and control characters are rejected or neutralised, so a sender can't write outside the download folder. Names shown on screen are stripped of terminal escape sequences.
- Limits on message size, file count and pending offers stop a misbehaving device from exhausting memory.

What you don't get (by design - this is a convenience tool, not a vault):

- **There is no trust store or pairing on the LAN.** Anyone on your network can announce themselves as "alice". The `id` is what's authoritative: if it matters, compare the id in the accept prompt with the one in the sender's header.
- Identities are not persisted per contact, so there is no warning when a familiar name shows up with a new id.
- IPv4 only for LAN discovery. Transfers can't be resumed after an interruption.
- Internet transfers are limited by the relay's bandwidth, and the relay operator can see who connects and how much data moves (never the content).

## Troubleshooting

**"Looking for devices..." never finds the other machine on the LAN**

1. Both must be on the same network and subnet. Guest Wi-Fi and some corporate/campus networks isolate clients; broadcast won't cross between them (use a room instead).
2. **Windows Firewall**: the first run asks whether Node.js may access the network - allow **Private networks**. If you dismissed it, allow `node.exe` in *Windows Security -> Firewall -> Allow an app*. The network must be set to *Private*, not *Public*.
3. macOS/Linux: allow incoming connections for `node` if a firewall asks; UDP 45454 and TCP 7878 are used.
4. Still nothing? Press `a` and type the other device's address (shown in its header), or start with `--peer 192.168.1.40`.

**Internet rooms**

- *"relay refused the connection" / "could not resolve"*: the relay address is wrong or the relay isn't running. Check it with a browser or `curl` - a working relay answers `beam relay ok`.
- *"wrong relay token"*: pass the relay's token with `--relay-token` (or `BEAM_RELAY_TOKEN`).
- *Joined, but nobody shows up*: everyone must use exactly the same code (case and spaces don't matter) and the same relay.
- *"failed the room-code check"*: a device reached you through the room without knowing the code, or something between you is tampering. It was refused.

**Two instances on one computer** need separate identities and download folders: give the second one `--config <folder> --dir <folder>`.

## Development

```
npm test                      # unit + end-to-end tests (real TLS, real UDP, a real in-process relay)
node bin/beam.js              # run from source
node bin/beam.js relay        # run a relay from source
node test/bench.js 512        # loopback throughput benchmark
```

No runtime dependencies. The terminal UI is a small hand-written ANSI renderer (`src/ui/term.js`), and the relay uses a small hand-written WebSocket (`src/ws.js`), so `npx` starts instantly.

To publish: check the name is free (`npm view beam-share`), then `npm publish`.
