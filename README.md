```
          _
         | |__   ___  __ _ _ __ ___
 /\_/\   | '_ \ / _ \/ _` | '_ ` _ \
( o.o )  | |_) |  __/ (_| | | | | | |
 > ^ <   |_.__/ \___|\__,_|_| |_| |_|
```

# beam

Send files and folders to other devices on the same network, straight from the terminal. No server, no account, no cloud. Everything is encrypted.

```
npx beam-share
```

Not on npm yet? `npx github:SC136/beam-share` (needs Node.js 18+ and git).

Run it on two devices on the same Wi-Fi / LAN. They find each other automatically: pick a peer, press `s`, choose files, and the other side presses `y` to accept.

> Sharing over the internet (a relay server and "rooms") lives on the [`beta`](https://github.com/SC136/beam-share/tree/beta) branch. This branch is the small, local-only version.

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | move in the focused list |
| `s` / `Enter` | choose files to send to the selected peer |
| `Tab` | switch between **Peers** and **Transfers** |
| `x` | cancel the selected transfer (sending or receiving) |
| `c` | clear finished transfers |
| `o` | open the download folder |
| `?` | help |
| `q` / `Ctrl+C` | quit (asks first if a transfer is running) |

In the file picker: `Space` selects files **and whole folders**, `Enter`/`→` opens a folder, `←` goes up, `/` opens a path box (type or paste a path, or **drag a file onto the terminal**), `.` shows hidden files, `s` sends, `Esc` goes back.

Received files go to `~/Downloads/beam` (`--dir` to change). Nothing is ever overwritten: an existing `notes.txt` makes the new one `notes (1).txt`.

## Options

```
-n, --name <name>         name shown to other devices (default: computer name)
-d, --dir <folder>        where received files are saved
-p, --port <port>         TCP port to listen on (default 7878, or any free port)
    --discovery-port <n>  UDP port used to find devices (default 45454)
    --config <folder>     where this device's identity is stored
```

Two copies on one computer need separate `--config` and `--dir` folders.

## How it works

1. **Finding devices** (`discovery.js`): every copy broadcasts a tiny UDP message (name, port, identity) every 2 seconds and listens for the same. A device that goes quiet disappears after 8 seconds.
2. **Identity** (`identity.js`): each install makes a self-signed certificate. Its SHA-256 fingerprint *is* the device's identity (shown as `id xxxx-xxxx-xxxx`).
3. **Connecting** (`send.js`): the sender opens a TLS 1.3 connection and checks the certificate matches the fingerprint the device announced.
4. **Offer and accept** (`send.js`, `receive.js`): the sender lists the files; the receiver checks the list, asks the user, and answers.
5. **Transfer** (`protocol.js`): each file is sent as raw bytes followed by its SHA-256. The receiver writes `name.part`, verifies the hash, and only then renames it. Failures and cancels delete the partial file.

### Where things are

```
bin/beam.js          entry point
src/main.js          wires options -> engine -> UI -> terminal
src/cli.js           options and --help
src/beam.js          the engine: peers, transfers, prompts
src/send.js          the sending side
src/receive.js       the receiving side (validates, asks, saves)
src/protocol.js      message framing and the Reader used by both sides
src/discovery.js     UDP broadcast
src/identity.js      certificate and fingerprint
src/safepath.js      makes file names from the network safe
src/scan.js          expands folders into file lists
src/ui/app.js        UI state and keys
src/ui/screens.js    everything the UI draws
src/ui/picker.js     the file browser (and the path box)
src/ui/input.js      a one-line text field
src/ui/term.js       terminal basics: colours, widths, boxes, redraw
src/ui/art.js        logo and cat
test/                70 tests (real TLS and UDP; no mocks of the network)
```

No runtime dependencies.

## Security notes

- Everything on the wire is encrypted and tamper-evident.
- The receiver always sees who is sending (name, address, id) and what, and must accept.
- Names and paths from the network are treated as hostile: `..`, absolute paths, drive letters, Windows reserved names and control characters are rejected or neutralised, and names are stripped of terminal escape sequences before display.
- There is no pairing: anyone on your network can call themselves "alice". The **id** is what's authoritative, so compare the id in the accept prompt with the one in the sender's header when it matters.

## Troubleshooting

If no devices appear: both must be on the same network (guest and campus Wi-Fi often isolate devices). On Windows, allow Node.js on **Private networks** when the firewall asks. Ports used: UDP 45454 and TCP 7878.

## Development

```
npm test              # 70 tests, about 10 seconds
node bin/beam.js      # run from source
```
