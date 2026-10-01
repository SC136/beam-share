// The relay: introduces devices that share a room, and pipes bytes between them.
// It never sees plaintext (peers run TLS end to end through it) and never learns the
// room code (only a one-way hash of it). Run it with `npx beam-share relay`.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { acceptUpgrade } from './ws.js';

export const DEFAULT_LIMITS = {
  maxRooms: 2000,
  maxRoomMembers: 16,
  maxPipes: 500,
  maxPending: 500,
  maxConnsPerIp: 64,
  joinsPerMinutePerIp: 60,
  firstMessageBytes: 4096,
  maxBacklogBytes: 256 * 1024,
  firstMessageMs: 10_000,
  pairMs: 20_000,
  drainMs: 60_000,
  keepaliveMs: 20_000,
};

const ROOM_ID = /^[0-9a-f]{32}$/;
const MEMBER_ID = /^[0-9a-f]{16,32}$/;
const PIPE_ID = /^[0-9a-f]{32}$/;
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();

/**
 * @param {object} o
 * @param {number} [o.port=7979]  0 picks a free port
 * @param {string} [o.host='0.0.0.0']
 * @param {string} [o.token]      if set, clients must present it
 * @param {boolean} [o.trustProxy] take the client IP from X-Forwarded-For (needed behind a hosting platform's proxy)
 * @param {(line: string) => void} [o.log]
 * @param {(a: object, b: object, roomId: string) => boolean} [o.intercept]  testing hook: take over a freshly paired
 *   connection pair instead of piping bytes between them (return true when handled)
 */
export async function startRelay({ port = 7979, host = '0.0.0.0', token = null, trustProxy = false, log = () => {}, limits = {}, intercept = null } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const rooms = new Map(); // roomId -> Map(mid -> control connection)
  const pending = new Map(); // pipeId -> {room, to, dialer, timer}
  const connsPerIp = new Map();
  const joinTimes = new Map();
  const all = new Set();
  let pipes = 0;

  const tokenOk = (m) => !token || timingSafeEqual(digest(m.token), digest(token));
  const tag = (roomId) => roomId.slice(0, 6);
  const send = (conn, obj) => {
    // A member that stops reading must not make us buffer without limit.
    if (conn.socket.writableLength > L.maxBacklogBytes) return conn.destroy();
    conn.sendText(JSON.stringify(obj));
  };
  const refuse = (conn, reason) => {
    send(conn, { t: 'error', reason });
    setTimeout(() => conn.destroy(), 50).unref();
  };

  function clientIp(req) {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function joinAllowed(ip) {
    const now = Date.now();
    if (joinTimes.size > 10_000) {
      for (const [addr, times] of joinTimes) if (now - times[times.length - 1] > 60_000) joinTimes.delete(addr);
    }
    const recent = (joinTimes.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    joinTimes.set(ip, recent);
    return recent.length <= L.joinsPerMinutePerIp;
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('beam relay ok\n');
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const ip = clientIp(req);
    const open = connsPerIp.get(ip) ?? 0;
    if (open >= L.maxConnsPerIp) return socket.destroy();
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    connsPerIp.set(ip, open + 1);
    all.add(conn);
    conn.on('error', () => {});
    conn.once('close', () => {
      all.delete(conn);
      const n = (connsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) connsPerIp.delete(ip);
      else connsPerIp.set(ip, n);
    });
    conn.startKeepalive(L.keepaliveMs);
    handle(conn, ip);
  });

  function handle(conn, ip) {
    // Always be reading, so a peer that hangs up before it is paired is noticed straight away.
    // (Honest clients send nothing but their first message until the relay says "paired".)
    conn.resume();
    const timer = setTimeout(() => conn.destroy(), L.firstMessageMs);
    conn.once('text', (text) => {
      clearTimeout(timer);
      if (text.length > L.firstMessageBytes) return conn.destroy();
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return conn.destroy();
      }
      if (!m || typeof m !== 'object' || m.v !== 1) return refuse(conn, 'unsupported protocol version');
      if (!tokenOk(m)) return refuse(conn, 'wrong relay token');
      if (typeof m.room !== 'string' || !ROOM_ID.test(m.room)) return refuse(conn, 'bad room id');
      if (m.t === 'join') return join(conn, ip, m);
      if (m.t === 'dial') return dial(conn, m);
      if (m.t === 'accept') return accept(conn, m);
      return refuse(conn, 'unknown request');
    });
  }

  function join(conn, ip, m) {
    if (typeof m.mid !== 'string' || !MEMBER_ID.test(m.mid)) return refuse(conn, 'bad member id');
    if (!joinAllowed(ip)) return refuse(conn, 'too many join attempts, slow down');
    let room = rooms.get(m.room);
    if (!room) {
      if (rooms.size >= L.maxRooms) return refuse(conn, 'relay is full');
      room = new Map();
      rooms.set(m.room, room);
    }
    if (room.has(m.mid)) return refuse(conn, 'duplicate member id');
    if (room.size >= L.maxRoomMembers) return refuse(conn, 'room is full');

    const others = [...room.keys()];
    room.set(m.mid, conn);
    send(conn, { t: 'joined', members: others });
    for (const other of room.values()) if (other !== conn) send(other, { t: 'peer-joined', mid: m.mid });
    log(`join   room ${tag(m.room)}  members ${room.size}`);

    conn.on('text', () => {}); // the control connection has nothing more to say
    conn.resume();
    conn.once('close', () => {
      if (room.get(m.mid) === conn) room.delete(m.mid);
      for (const other of room.values()) send(other, { t: 'peer-left', mid: m.mid });
      if (room.size === 0 && rooms.get(m.room) === room) rooms.delete(m.room);
      log(`leave  room ${tag(m.room)}  members ${room.size}`);
    });
  }

  function dial(conn, m) {
    if (typeof m.from !== 'string' || typeof m.to !== 'string' || !MEMBER_ID.test(m.from) || !MEMBER_ID.test(m.to)) {
      return refuse(conn, 'bad member id');
    }
    const room = rooms.get(m.room);
    const target = room?.get(m.to);
    if (!target || !room.has(m.from)) return refuse(conn, 'that device is not in the room');
    if (pending.size >= L.maxPending || pipes >= L.maxPipes) return refuse(conn, 'relay is busy');

    const pipe = randomBytes(16).toString('hex');
    const timer = setTimeout(() => {
      pending.delete(pipe);
      refuse(conn, 'the other device did not answer');
    }, L.pairMs);
    pending.set(pipe, { room: m.room, to: m.to, dialer: conn, timer });
    conn.once('close', () => {
      if (pending.get(pipe)?.dialer === conn) {
        clearTimeout(timer);
        pending.delete(pipe);
      }
    });
    conn.on('text', () => {});
    send(target, { t: 'incoming', pipe, from: m.from });
  }

  function accept(conn, m) {
    const p = typeof m.pipe === 'string' && PIPE_ID.test(m.pipe) ? pending.get(m.pipe) : null;
    if (!p || p.room !== m.room || p.to !== m.mid) return refuse(conn, 'no such pending connection');
    clearTimeout(p.timer);
    pending.delete(m.pipe);
    pair(p.dialer, conn, m.room);
  }

  function pair(a, b, roomId) {
    if (a.destroyed) return b.destroy();
    pipes++;
    send(a, { t: 'paired' });
    send(b, { t: 'paired' });
    a.removeAllListeners('text');
    b.removeAllListeners('text');
    a.on('text', () => {}); // text after pairing is dropped: only opaque bytes cross the pipe
    b.on('text', () => {});
    if (intercept?.(a, b, roomId)) return;
    a.pipe(b);
    b.pipe(a);
    log(`pipe   room ${tag(roomId)}  open ${pipes}`);
    // When one side hangs up cleanly, pipe() ends the other side, which first flushes whatever is
    // still queued for it (a slow reader may be far behind). Once that is done there is nothing
    // left to do: whatever the other side's peer sends from now on has nowhere to go, so we close it
    // right away instead of waiting for a reader that no longer exists. An abnormal break tears the
    // other side down at once; a timer stops a stuck flush from holding the pipe forever.
    let open = 2;
    const watch = (x, y) => {
      x.once('close', () => {
        if (--open === 0) pipes--;
        if (!x.readableEnded) return y.destroy();
        if (y.writableFinished || y.destroyed) return y.destroy();
        const t = setTimeout(() => y.destroy(), L.drainMs);
        t.unref();
        y.once('finish', () => y.destroy());
        y.once('close', () => clearTimeout(t));
      });
    };
    watch(a, b);
    watch(b, a);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const boundPort = server.address().port;
  log(`beam relay listening on ${host}:${boundPort}${token ? ' (token required)' : ' (open - anyone can use it)'}`);

  return {
    port: boundPort,
    stats: () => ({
      rooms: rooms.size,
      members: [...rooms.values()].reduce((n, r) => n + r.size, 0),
      pipes,
      pending: pending.size,
      connections: all.size,
    }),
    /** Diagnostics: the stream state of every open connection. */
    dump: () =>
      [...all].map((c) => ({
        destroyed: c.destroyed,
        readableEnded: c.readableEnded,
        writableFinished: c.writableFinished,
        readableLength: c.readableLength,
        flowing: c.readableFlowing,
        socketDestroyed: c.socket.destroyed,
        sawEnd: c._sawEnd,
      })),
    close: () =>
      new Promise((resolve) => {
        for (const c of all) c.destroy();
        for (const p of pending.values()) clearTimeout(p.timer);
        server.close(() => resolve());
      }),
  };
}
