/* server.js — zero-dependency Node server: static files + WebSocket + accounts, friends, rooms, game loop.
   Run:  node server.js   (PORT env var optional, default 3000) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Sim = require('./sim.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = __dirname;
const ALLOWED = new Set(['/index.html', '/game.js', '/sim.js', '/render3d.js']);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

/* ---------------------------------------------------------------- storage */
let DB = { users: {} };
try { DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* first run */ }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(DB), (err) => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 400);
}
const byName = (name) => Object.values(DB.users).find((u) => u.name.toLowerCase() === name.toLowerCase());
function newUid() {
  for (;;) {
    const uid = String(10000000 + crypto.randomInt(0, 90000000));
    if (!DB.users[uid]) return uid;
  }
}
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex'); }
function checkPass(u, pass) {
  const a = Buffer.from(hashPass(pass, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- minimal WebSocket */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class Sock {
  constructor(socket) {
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = null; this.open = true;
    this.uid = null; this.room = null; this.ip = socket.remoteAddress;
    this.onmessage = () => {}; this.onclose = () => {};
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
    socket.setNoDelay(true);
  }
  end() { if (!this.open) return; this.open = false; try { this.s.destroy(); } catch (e) {} this.onclose(); }
  feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 1 << 20) return this.end();
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return this.end();
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = b.subarray(off, off + 4); payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = b.subarray(need);
      if (op === 8) { try { this.s.write(frame(8, Buffer.alloc(0))); } catch (e) {} return this.end(); }
      if (op === 9) { this.s.write(frame(10, payload)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) this.frag = { op, parts: [payload] };
      else if (op === 0 && this.frag) this.frag.parts.push(payload);
      if (fin && this.frag) {
        const msg = Buffer.concat(this.frag.parts).toString('utf8'); this.frag = null;
        this.onmessage(msg);
      }
    }
  }
  send(obj) {
    if (!this.open) return;
    try { this.s.write(frame(1, Buffer.from(JSON.stringify(obj)))); } catch (e) { this.end(); }
  }
}
function frame(op, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

/* ---------------------------------------------------------------- HTTP static */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (!ALLOWED.has(p)) { res.writeHead(404); return res.end('Not found'); }
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  attach(new Sock(socket));
});

/* ---------------------------------------------------------------- presence */
const online = new Map(); // uid -> Set<Sock>
const rooms = new Map();  // code -> room
function sendUser(uid, obj) { const s = online.get(uid); if (s) for (const w of s) w.send(obj); }
function isOnline(uid) { return online.has(uid) && online.get(uid).size > 0; }
function pub(uid) { const u = DB.users[uid]; return u ? { uid: u.uid, name: u.name, online: isOnline(uid) } : null; }
function meOf(uid) {
  const u = DB.users[uid];
  return {
    uid: u.uid, name: u.name,
    friends: u.friends.map(pub).filter(Boolean),
    reqIn: u.reqIn.map(pub).filter(Boolean),
    reqOut: u.reqOut.map(pub).filter(Boolean),
  };
}
function pushMe(uid) { if (DB.users[uid]) sendUser(uid, { t: 'me', me: meOf(uid) }); }
function notifyFriends(uid) { const u = DB.users[uid]; if (u) for (const f of u.friends) pushMe(f); }

/* ---------------------------------------------------------------- rooms */
function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(0, A.length)];
    if (!rooms.has(c)) return c;
  }
}
function roomView(r) {
  return { code: r.code, host: r.host, map: r.map, state: r.state, players: r.players.map((id) => ({ uid: id, name: DB.users[id].name })) };
}
function broadcastRoom(r) { const v = roomView(r); for (const id of r.players) sendUser(id, { t: 'room', room: v }); }
function stopGame(r) { if (r.timer) { clearInterval(r.timer); r.timer = null; } r.game = null; r.state = 'lobby'; }
function leaveRoom(sock) {
  const uid = sock.uid; const code = sock.room; sock.room = null;
  const r = code && rooms.get(code); if (!r || !uid) return;
  // other tabs of the same user keep the room only if still connected; simplification: leaving removes the user
  r.players = r.players.filter((id) => id !== uid);
  if (online.get(uid)) for (const w of online.get(uid)) if (w.room === code) w.room = null;
  if (r.game) Sim.removePlayer(r.game, uid);
  if (!r.players.length) { stopGame(r); rooms.delete(code); return; }
  if (r.host === uid) r.host = r.players[0];
  broadcastRoom(r);
}
function startGame(r) {
  r.state = 'play';
  r.game = Sim.createGame(r.map, r.players.map((id) => ({ id, name: DB.users[id].name })));
  broadcastRoom(r);
  r.timer = setInterval(() => {
    const g = r.game; if (!g) return;
    Sim.step(g, 0.05);
    const ev = Sim.drain(g);
    const msg = { t: 'snap', g, ev };
    for (const id of r.players) sendUser(id, msg);
    if (g.phase === 'over') {
      clearInterval(r.timer); r.timer = null;
      r.state = 'lobby'; // game object stays so clients keep the result screen
      broadcastRoom(r);
    }
  }, 50);
}

/* ---------------------------------------------------------------- connection logic */
const attempts = new Map(); // ip -> {n, t}
function throttled(ip) {
  const now = Date.now(); const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 60000) { a.n = 0; a.t = now; }
  a.n++; attempts.set(ip, a);
  return a.n > 20;
}
const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const nameOk = (s) => s.length >= 3 && s.length <= 16 && !/[<>&"'\\]/.test(s);

function login(sock, u) {
  if (sock.uid) detach(sock);
  sock.uid = u.uid;
  if (!online.has(u.uid)) online.set(u.uid, new Set());
  online.get(u.uid).add(sock);
  const token = crypto.randomBytes(24).toString('hex');
  u.tokens.push(token); if (u.tokens.length > 8) u.tokens.shift();
  save();
  sock.send({ t: 'authOk', token, me: meOf(u.uid) });
  notifyFriends(u.uid);
  // rejoin running room
  for (const r of rooms.values()) if (r.players.includes(u.uid)) { sock.room = r.code; sock.send({ t: 'room', room: roomView(r) }); if (r.game) sock.send({ t: 'snap', g: r.game, ev: [] }); }
}
function detach(sock) {
  const uid = sock.uid; if (!uid) return;
  const set = online.get(uid);
  if (set) { set.delete(sock); if (!set.size) online.delete(uid); }
  sock.uid = null;
  if (!isOnline(uid)) {
    notifyFriends(uid);
    // 20s grace so a phone switching apps / reconnecting keeps its seat
    setTimeout(() => {
      if (isOnline(uid)) return;
      for (const r of [...rooms.values()]) if (r.players.includes(uid)) leaveRoom({ uid, room: r.code });
    }, 20000);
  }
}

function handle(sock, m) {
  const err = (text) => sock.send({ t: 'err', text });
  if (m.t === 'register') {
    if (throttled(sock.ip)) return err('ลองบ่อยเกินไป รอสักครู่');
    const name = cleanName(m.name), pass = String(m.pass || '');
    if (!nameOk(name)) return err('ชื่อต้องยาว 3-16 ตัวอักษร และห้ามมีอักขระพิเศษ');
    if (pass.length < 4 || pass.length > 64) return err('รหัสผ่านต้องยาวอย่างน้อย 4 ตัว');
    if (byName(name)) return err('ชื่อนี้ถูกใช้แล้ว');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { uid: newUid(), name, salt, hash: hashPass(pass, salt), friends: [], reqIn: [], reqOut: [], tokens: [], created: Date.now() };
    DB.users[u.uid] = u; save();
    return login(sock, u);
  }
  if (m.t === 'login') {
    if (throttled(sock.ip)) return err('ลองบ่อยเกินไป รอสักครู่');
    const u = byName(cleanName(m.name));
    if (!u || !checkPass(u, String(m.pass || ''))) return err('ชื่อหรือรหัสผ่านไม่ถูกต้อง');
    return login(sock, u);
  }
  if (m.t === 'resume') {
    const tok = String(m.token || '');
    const u = Object.values(DB.users).find((x) => x.tokens.includes(tok));
    if (!u) return sock.send({ t: 'resumeFail' });
    u.tokens = u.tokens.filter((x) => x !== tok);
    return login(sock, u);
  }
  if (m.t === 'logout') { if (m.token) { const u = DB.users[sock.uid]; if (u) { u.tokens = u.tokens.filter((x) => x !== m.token); save(); } } leaveRoom(sock); detach(sock); return; }

  const uid = sock.uid;
  if (!uid) return err('กรุณาเข้าสู่ระบบ');
  const me = DB.users[uid];

  /* friends */
  if (m.t === 'friendAdd') {
    const tid = String(m.uid || '').trim(); const t = DB.users[tid];
    if (!t) return err('ไม่พบผู้เล่น UID นี้');
    if (tid === uid) return err('เพิ่มตัวเองไม่ได้');
    if (me.friends.includes(tid)) return err('เป็นเพื่อนกันอยู่แล้ว');
    if (me.reqOut.includes(tid)) return err('ส่งคำขอไปแล้ว');
    if (me.reqIn.includes(tid)) { // they already asked us -> accept
      me.reqIn = me.reqIn.filter((x) => x !== tid); t.reqOut = t.reqOut.filter((x) => x !== uid);
      me.friends.push(tid); t.friends.push(uid);
    } else { me.reqOut.push(tid); t.reqIn.push(uid); }
    save(); pushMe(uid); pushMe(tid);
    sendUser(tid, { t: 'toast', text: me.name + ' ส่งคำขอเป็นเพื่อน' });
    return sock.send({ t: 'toast', text: 'ส่งคำขอเป็นเพื่อนแล้ว' });
  }
  if (m.t === 'friendAccept' || m.t === 'friendDecline') {
    const tid = String(m.uid); const t = DB.users[tid]; if (!t || !me.reqIn.includes(tid)) return;
    me.reqIn = me.reqIn.filter((x) => x !== tid); t.reqOut = t.reqOut.filter((x) => x !== uid);
    if (m.t === 'friendAccept') { me.friends.push(tid); t.friends.push(uid); sendUser(tid, { t: 'toast', text: me.name + ' ยอมรับเป็นเพื่อนแล้ว' }); }
    save(); pushMe(uid); pushMe(tid); return;
  }
  if (m.t === 'friendRemove') {
    const tid = String(m.uid); const t = DB.users[tid];
    me.friends = me.friends.filter((x) => x !== tid); me.reqOut = me.reqOut.filter((x) => x !== tid); me.reqIn = me.reqIn.filter((x) => x !== tid);
    if (t) { t.friends = t.friends.filter((x) => x !== uid); t.reqOut = t.reqOut.filter((x) => x !== uid); t.reqIn = t.reqIn.filter((x) => x !== uid); }
    save(); pushMe(uid); pushMe(tid); return;
  }

  /* rooms */
  if (m.t === 'roomCreate') {
    leaveRoom(sock);
    const code = roomCode();
    const r = { code, host: uid, map: Sim.MAPS[m.map] ? m.map : 'dorm', state: 'lobby', players: [uid], game: null, timer: null };
    rooms.set(code, r); sock.room = code; return broadcastRoom(r);
  }
  if (m.t === 'roomJoin') {
    const code = String(m.code || '').toUpperCase().trim(); const r = rooms.get(code);
    if (!r) return err('ไม่พบห้องรหัส ' + code);
    if (r.players.includes(uid)) { sock.room = code; return broadcastRoom(r); }
    if (r.state === 'play') return err('ห้องนี้กำลังเล่นอยู่');
    if (r.players.length >= 4) return err('ห้องเต็มแล้ว (สูงสุด 4 คน)');
    leaveRoom(sock);
    r.players.push(uid); sock.room = code; return broadcastRoom(r);
  }
  if (m.t === 'roomLeave') { leaveRoom(sock); return sock.send({ t: 'roomLeft' }); }
  const r = sock.room && rooms.get(sock.room);
  if (m.t === 'invite') {
    if (!r) return err('ยังไม่ได้อยู่ในห้อง');
    const tid = String(m.uid);
    if (!me.friends.includes(tid)) return err('ต้องเป็นเพื่อนกันก่อน');
    if (!isOnline(tid)) return err('เพื่อนไม่ได้ออนไลน์');
    sendUser(tid, { t: 'invited', from: me.name, code: r.code });
    return sock.send({ t: 'toast', text: 'ส่งคำเชิญแล้ว' });
  }
  if (m.t === 'setMap') {
    if (!r || r.host !== uid || r.state === 'play' || !Sim.MAPS[m.map]) return;
    r.map = m.map; return broadcastRoom(r);
  }
  if (m.t === 'start') {
    if (!r || r.host !== uid || r.state === 'play') return;
    if (r.timer) clearInterval(r.timer);
    return startGame(r);
  }
  if (m.t === 'act') {
    if (!r || !r.game) return;
    Sim.act(r.game, uid, m.a); return;
  }
}

function attach(sock) {
  sock.onmessage = (txt) => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(sock, m); } catch (e) { console.error('handler error', e); }
  };
  sock.onclose = () => { try { detach(sock); } catch (e) {} };
}

/* keep idle sockets alive through proxies */
setInterval(() => { for (const set of online.values()) for (const s of set) { try { s.s.write(frame(9, Buffer.alloc(0))); } catch (e) {} } }, 25000);

if (require.main === module) {
  server.listen(PORT, () => console.log('Haunted Dorm Online running on http://localhost:' + PORT));
}
module.exports = { server };
