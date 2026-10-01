// Horde Duel relay: pairs players by a 5-digit room code and passes their messages along. The game itself runs on the
// players' devices (lockstep: only inputs travel), so this server never simulates anything; it only forwards small
// JSON messages within a room. Works on any network, since it's a plain secure WebSocket on port 443.
//
// Protocol (JSON text frames). Messages with a "relay" field are for the server; everything else is forwarded as is
// to the other players in the room.
//   -> {relay: 'host'}                  <- {relay: 'room', code}       a new room, you're its host
//   -> {relay: 'join', code}            <- {relay: 'joined'}           and the others get {relay: 'peer'}
//                                       <- {relay: 'error', why}       'no-room' | 'full' | 'busy'
//   when someone leaves, the others get {relay: 'left'}
const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const ROOM_SIZE = 2;            // 1v1 for now; raise for 2v2
const MAX_ROOMS = 500;
const MAX_MESSAGE = 2048;       // bytes: an input is ~40
const MAX_RATE = 400;           // messages per second per player (the game sends ~65)
const IDLE_MS = 10 * 60 * 1000; // a room nobody has written to for 10 minutes is closed

const rooms = new Map(); // code -> { members: Set<ws>, last: ms }
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

function newCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
    if (!rooms.has(code)) return code;
  }
  return null;
}

function leave(ws) {
  const room = ws.room && rooms.get(ws.room);
  if (!room) return;
  room.members.delete(ws);
  for (const other of room.members) send(other, { relay: 'left' });
  if (!room.members.size) rooms.delete(ws.room);
  ws.room = null;
}

const server = http.createServer((req, res) => {
  // a plain page for Render's health check and for the game to wake a sleeping free instance
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(`horde duel relay ok · ${rooms.size} rooms\n`);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE });
wss.on('connection', (ws) => {
  ws.room = null;
  ws.alive = true;
  ws.count = 0;
  ws.windowStart = Date.now();
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - ws.windowStart >= 1000) { ws.windowStart = now; ws.count = 0; }
    if (++ws.count > MAX_RATE) { ws.close(1008, 'too many messages'); return; }
    if (isBinary) return;
    const text = data.toString();
    let m = null;
    if (text.includes('"relay"')) { try { m = JSON.parse(text); } catch (e) { return; } }
    if (m && typeof m === 'object' && !Array.isArray(m) && m.relay) {
      if (m.relay === 'host' && !ws.room) {
        if (rooms.size >= MAX_ROOMS) { send(ws, { relay: 'error', why: 'busy' }); return; }
        const code = newCode();
        if (!code) { send(ws, { relay: 'error', why: 'busy' }); return; }
        rooms.set(code, { members: new Set([ws]), last: now });
        ws.room = code;
        send(ws, { relay: 'room', code });
      } else if (m.relay === 'join' && !ws.room) {
        const code = String(m.code || '').replace(/\D/g, '');
        const room = rooms.get(code);
        if (!room) { send(ws, { relay: 'error', why: 'no-room' }); return; }
        if (room.members.size >= ROOM_SIZE) { send(ws, { relay: 'error', why: 'full' }); return; }
        for (const other of room.members) send(other, { relay: 'peer' });
        room.members.add(ws);
        room.last = now;
        ws.room = code;
        send(ws, { relay: 'joined' });
      }
      return;
    }
    // game traffic: straight to everyone else in the room
    const room = ws.room && rooms.get(ws.room);
    if (!room) return;
    room.last = now;
    for (const other of room.members) if (other !== ws && other.readyState === 1) other.send(text);
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// drop players whose connection died without closing, and rooms left idle
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.last > IDLE_MS) { for (const ws of room.members) ws.close(1000, 'idle'); rooms.delete(code); }
}, 30000).unref();

server.listen(PORT, () => console.log(`horde duel relay listening on ${PORT}`));
