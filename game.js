/* game.js — UI, networking, rendering, animation and synthesised sound for Haunted Dorm Online */
(() => {
  'use strict';
  const S = window.Sim;
  const W = S.W, H = S.H, CY = S.CY;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const sstore = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
  };

  const st = {
    me: null, token: null, ws: null, wsOk: false, room: null, mode: null, game: null, myId: null,
    map: store.get('hd_map') || 'dorm', screen: 'auth', authMode: 'login', pendingInvite: null,
    selSlot: -1, paused: false, remember: store.get('hd_remember') !== '0',
  };

  /* =============================================================== audio */
  const Snd = {
    ctx: null, muted: store.get('hd_mute') === '1', master: null, last: {},
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.nbuf = buf; this.startAmbient();
    },
    setMute(m) { this.muted = m; store.set('hd_mute', m ? '1' : '0'); if (this.master) this.master.gain.value = m ? 0 : 0.8; },
    gate(k, ms) { const n = performance.now(); if (this.last[k] && n - this.last[k] < ms) return false; this.last[k] = n; return true; },
    tone(f, d, type = 'sine', vol = 0.2, to = null, delay = 0) {
      const c = this.ctx; if (!c) return;
      const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (to) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + d + 0.05);
    },
    noise(d, vol = 0.2, ftype = 'lowpass', f = 800, to = null, delay = 0) {
      const c = this.ctx; if (!c) return;
      const t = c.currentTime + delay, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.nbuf; fl.type = ftype; fl.frequency.setValueAtTime(f, t);
      if (to) fl.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + d);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      s.connect(fl); fl.connect(g); g.connect(this.master); s.start(t, Math.random()); s.stop(t + d + 0.05);
    },
    click() { this.tone(700, 0.05, 'square', 0.06); },
    coin() { if (!this.gate('coin', 120)) return; this.tone(1318, 0.09, 'sine', 0.1); this.tone(1760, 0.14, 'sine', 0.1, null, 0.07); },
    build() { this.tone(330, 0.1, 'triangle', 0.18); this.tone(494, 0.1, 'triangle', 0.18, null, 0.08); this.tone(740, 0.18, 'triangle', 0.18, null, 0.16); this.noise(0.08, 0.1, 'highpass', 2500); },
    repair() { this.tone(520, 0.08, 'square', 0.08); this.tone(780, 0.12, 'square', 0.08, null, 0.07); },
    deny() { this.tone(160, 0.2, 'sawtooth', 0.12, 100); },
    shoot(k) {
      if (!this.gate('sh' + k, 60)) return;
      if (k === 'cannon') { this.noise(0.22, 0.25, 'lowpass', 900, 120); this.tone(150, 0.25, 'sine', 0.25, 40); }
      else if (k === 'frost') { this.tone(1500, 0.18, 'sine', 0.09, 2400); this.tone(2200, 0.14, 'sine', 0.05, 1200, 0.03); }
      else { this.tone(1000, 0.09, 'square', 0.07, 320); }
    },
    hit() { if (this.gate('hit', 70)) this.noise(0.06, 0.12, 'highpass', 1800); },
    doorhit() { this.noise(0.16, 0.3, 'lowpass', 500, 120); this.tone(95, 0.14, 'sine', 0.3, 55); },
    doorbreak() { this.noise(0.7, 0.4, 'lowpass', 1500, 80); this.tone(220, 0.6, 'sawtooth', 0.2, 40); this.noise(0.3, 0.2, 'highpass', 3000, null, 0.1); },
    kill() { this.tone(660, 0.12, 'triangle', 0.16, 330); this.tone(440, 0.16, 'triangle', 0.14, 220, 0.09); this.noise(0.4, 0.12, 'bandpass', 1800, 300); },
    spawn() {
      if (!this.gate('spawn', 1800)) return; const c = this.ctx; if (!c) return;
      const t = c.currentTime, o = c.createOscillator(), g = c.createGain(), l = c.createOscillator(), lg = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(430, t); o.frequency.exponentialRampToValueAtTime(210, t + 1.1);
      l.frequency.value = 6; lg.gain.value = 18; l.connect(lg); lg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(g); g.connect(this.master); o.start(t); l.start(t); o.stop(t + 1.3); l.stop(t + 1.3);
    },
    scare() { this.noise(0.5, 0.45, 'highpass', 1200); this.tone(140, 0.7, 'sawtooth', 0.28, 60); this.tone(147, 0.7, 'sawtooth', 0.28, 63); this.tone(900, 0.5, 'square', 0.12, 200); },
    thunder() { this.noise(1.6, 0.5, 'lowpass', 700, 60); this.noise(0.12, 0.35, 'highpass', 3000); },
    claim() { this.tone(440, 0.1, 'sine', 0.15); this.tone(660, 0.14, 'sine', 0.15, null, 0.07); },
    start() { this.tone(110, 0.9, 'sawtooth', 0.12, 80); this.noise(0.8, 0.12, 'lowpass', 300, 900); },
    win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.45, 'triangle', 0.2, null, i * 0.16)); },
    lose() { [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.55, 'sawtooth', 0.14, f * 0.97, i * 0.22)); },
    startAmbient() {
      const c = this.ctx;
      [55, 55.8, 82.4].forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain(); o.type = i === 2 ? 'triangle' : 'sine'; o.frequency.value = f; g.gain.value = i === 2 ? 0.012 : 0.03;
        o.connect(g); g.connect(this.master); o.start();
      });
      const creak = () => {
        if (st.screen === 'game' && !st.paused) {
          if (Math.random() < 0.6) this.noise(0.7, 0.05, 'bandpass', 300 + Math.random() * 300, 120 + Math.random() * 200);
          else this.tone(60 + Math.random() * 40, 1.2, 'sine', 0.05, 40);
        }
        setTimeout(creak, 5000 + Math.random() * 9000);
      };
      setTimeout(creak, 4000);
    },
  };
  const unlock = () => Snd.init();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  /* =============================================================== helpers */
  function toast(text, bad) {
    const d = document.createElement('div'); d.className = 'toast' + (bad ? ' bad' : ''); d.textContent = text;
    $('#toasts').appendChild(d); setTimeout(() => d.remove(), 2800);
  }
  function show(id) {
    st.screen = id;
    $$('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + id));
    if (id === 'game') resize();
  }
  function avColor(uid) { let h = 0; for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) % 360; return 'hsl(' + h + ',55%,45%)'; }
  function copyText(t) {
    const done = () => toast('คัดลอกแล้ว');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(done, () => fallback());
    else fallback();
    function fallback() { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); done(); } catch (e) {} a.remove(); }
  }
  const mapDefs = Object.values(S.MAPS);

  /* =============================================================== network */
  function send(o) { if (st.ws && st.wsOk) st.ws.send(JSON.stringify(o)); }
  function connect() {
    if (location.protocol === 'file:') { $('#badge').textContent = 'ออฟไลน์'; $('#aNote').textContent = 'เปิดไฟล์ตรงๆ จึงเล่นออนไลน์ไม่ได้ — รัน server.js แล้วเข้าผ่าน http://localhost:3000'; return; }
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    st.ws = ws;
    ws.onopen = () => {
      st.wsOk = true; setBadge();
      const tok = st.token || (store.get('hd_token')) || sstore.get('hd_token');
      if (tok) send({ t: 'resume', token: tok });
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m); };
    ws.onclose = () => { st.wsOk = false; setBadge(); setTimeout(connect, 2000); };
    ws.onerror = () => {};
  }
  function setBadge() {
    const b = $('#badge'); b.textContent = st.wsOk ? (st.me ? '● ออนไลน์' : '● เชื่อมต่อแล้ว') : '○ กำลังเชื่อมต่อ…'; b.className = 'badge' + (st.wsOk ? ' ok' : '');
    b.style.display = st.screen === 'game' ? 'none' : 'block';
  }
  function saveToken(tok) {
    st.token = tok;
    if (st.remember) { store.set('hd_token', tok); sstore.del('hd_token'); } else { sstore.set('hd_token', tok); store.del('hd_token'); }
  }
  function onMsg(m) {
    switch (m.t) {
      case 'authOk':
        st.me = m.me; saveToken(m.token); st.myId = m.me.uid; $('#aErr').textContent = '';
        if (st.remember) store.set('hd_name', m.me.name);
        if (st.screen === 'auth') { show('home'); renderHome(); }
        setBadge();
        { const q = new URLSearchParams(location.search).get('room'); if (q) { history.replaceState(null, '', location.pathname); send({ t: 'roomJoin', code: q }); } }
        break;
      case 'resumeFail': st.token = null; store.del('hd_token'); sstore.del('hd_token'); if (!st.me) show('auth'); break;
      case 'err': toast(m.text, true); if (st.screen === 'auth') $('#aErr').textContent = m.text; break;
      case 'toast': toast(m.text); break;
      case 'me': st.me = m.me; renderHome(); renderRoom(); break;
      case 'invited': showInvite(m); break;
      case 'room':
        st.room = m.room;
        if (st.pendingInvite) { send({ t: 'invite', uid: st.pendingInvite }); st.pendingInvite = null; }
        if (m.room.state === 'play') { if (st.screen !== 'game' || st.mode !== 'online') enterGame('online'); }
        else if (st.screen !== 'game') { show('room'); renderRoom(); }
        else renderRoom();
        break;
      case 'roomLeft': st.room = null; if (st.screen !== 'game' || st.mode === 'online') { st.game = null; show('home'); renderHome(); } break;
      case 'snap':
        st.game = m.g; st.myId = st.me && st.me.uid;
        if (st.screen !== 'game' || st.mode !== 'online') enterGame('online');
        handleEvents(m.ev || []);
        if (m.g.phase !== 'over') $('#result').classList.remove('on');
        break;
    }
  }
  function showInvite(m) {
    $('#mIvT').textContent = 'คำเชิญเข้าห้อง';
    $('#mIvP').textContent = m.from + ' ชวนคุณเข้าห้อง ' + m.code;
    $('#mInvite').classList.add('on');
    $('#mIvY').onclick = () => { $('#mInvite').classList.remove('on'); if (st.screen === 'game' && st.mode === 'solo') exitGame(true); send({ t: 'roomJoin', code: m.code }); };
    $('#mIvN').onclick = () => $('#mInvite').classList.remove('on');
  }

  /* =============================================================== auth UI */
  function setAuthMode(m) {
    st.authMode = m;
    $$('#authForm .tab').forEach((t) => t.classList.toggle('on', t.dataset.m === m));
    $('#aGo').textContent = m === 'login' ? 'เข้าสู่ระบบ' : 'สมัครและเข้าเกม';
    $('#aPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#aErr').textContent = '';
  }
  $$('#authForm .tab').forEach((t) => t.onclick = () => setAuthMode(t.dataset.m));
  $('#aName').value = store.get('hd_name') || '';
  $('#aRemember').checked = st.remember;
  $('#authForm').onsubmit = (e) => {
    e.preventDefault(); Snd.init();
    if (!st.wsOk) { $('#aErr').textContent = 'ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้'; return; }
    st.remember = $('#aRemember').checked; store.set('hd_remember', st.remember ? '1' : '0');
    const name = $('#aName').value.trim(), pass = $('#aPass').value;
    if (!name || !pass) { $('#aErr').textContent = 'กรอกชื่อและรหัสผ่านก่อน'; return; }
    send({ t: st.authMode, name, pass });
  };
  $('#aGuest').onclick = () => { Snd.init(); st.me = null; st.myId = 'me'; show('home'); renderHome(); };

  /* =============================================================== home UI */
  function mapPicker(el, cur, onPick, disabled) {
    el.innerHTML = mapDefs.map((m) => '<div class="m' + (m.id === cur ? ' on' : '') + '" data-id="' + m.id + '"><b>' + esc(m.name) + '</b><small>' + esc(m.desc) + '</small></div>').join('');
    $$('.m', el).forEach((d) => d.onclick = () => { if (!disabled) { Snd.click(); onPick(d.dataset.id); } });
  }
  function renderHome() {
    if (st.screen !== 'home') return;
    const me = st.me, guest = !me;
    $('#hName').textContent = me ? me.name : 'ผู้เล่นแขก';
    $('#hUid').textContent = me ? me.uid : '--------';
    $('#hAv').textContent = me ? me.name[0].toUpperCase() : '?'; $('#hAv').style.background = me ? avColor(me.uid) : '#444';
    $('#hCopy').style.display = me ? '' : 'none';
    $('#hCreate').disabled = guest; $('#hJoin').disabled = guest;
    $('#hOut').textContent = guest ? 'กลับหน้าเข้าสู่ระบบ' : 'ออกจากระบบ';
    mapPicker($('#hMaps'), st.map, (id) => { st.map = id; store.set('hd_map', id); renderHome(); });
    const fl = $('#fList'), fr = $('#fReq');
    if (guest) { fr.innerHTML = ''; fl.innerHTML = '<div class="mut">สมัครสมาชิกเพื่อเพิ่มเพื่อนและเล่นออนไลน์</div>'; return; }
    fr.innerHTML = me.reqIn.length ? '<h2 style="margin-top:8px">คำขอเป็นเพื่อน</h2>' + me.reqIn.map((u) =>
      '<div class="it row" style="justify-content:space-between;padding:6px 0"><span>' + esc(u.name) + ' <span class="mut">' + u.uid + '</span></span><span><button class="btn sm" data-a="acc" data-u="' + u.uid + '">รับ</button><button class="btn sm sec" data-a="dec" data-u="' + u.uid + '">ปฏิเสธ</button></span></div>').join('') : '';
    const fs = [...me.friends].sort((a, b) => b.online - a.online);
    fl.innerHTML = fs.length ? fs.map((u) => '<div class="it"><span class="nm"><span class="dot' + (u.online ? ' on' : '') + '"></span>' + esc(u.name) + ' <span class="mut">' + u.uid + '</span></span><span>' +
      (u.online ? '<button class="btn sm" data-a="inv" data-u="' + u.uid + '">เชิญ</button>' : '') + '<button class="btn sm sec" data-a="rm" data-u="' + u.uid + '">ลบ</button></span></div>').join('')
      : '<div class="mut" style="padding:6px 0">ยังไม่มีเพื่อน — ให้เพื่อนบอก UID แล้วใส่ด้านบน</div>';
    if (me.reqOut.length) fl.innerHTML += '<div class="mut" style="padding-top:6px">รอตอบรับ: ' + me.reqOut.map((u) => esc(u.name)).join(', ') + '</div>';
  }
  function friendClick(e) {
    const b = e.target.closest('button[data-a]'); if (!b) return; Snd.click();
    const u = b.dataset.u, a = b.dataset.a;
    if (a === 'acc') send({ t: 'friendAccept', uid: u });
    else if (a === 'dec') send({ t: 'friendDecline', uid: u });
    else if (a === 'rm') { if (confirm('ลบเพื่อนคนนี้?')) send({ t: 'friendRemove', uid: u }); }
    else if (a === 'inv') {
      if (st.room) send({ t: 'invite', uid: u });
      else { st.pendingInvite = u; send({ t: 'roomCreate', map: st.map }); }
    }
  }
  $('#fList').onclick = friendClick; $('#fReq').onclick = friendClick; $('#rFriends').onclick = friendClick;
  $('#hCopy').onclick = () => st.me && copyText(st.me.uid);
  $('#fAdd').onclick = () => { const v = $('#fUid').value.trim(); if (!/^\d{8}$/.test(v)) return toast('UID ต้องเป็นตัวเลข 8 หลัก', true); send({ t: 'friendAdd', uid: v }); $('#fUid').value = ''; };
  $('#hSolo').onclick = () => { Snd.init(); Snd.click(); startSolo(); };
  $('#hCreate').onclick = () => { Snd.click(); send({ t: 'roomCreate', map: st.map }); };
  $('#hJoin').onclick = () => { const c = $('#hCode').value.trim().toUpperCase(); if (c.length !== 4) return toast('ใส่รหัสห้อง 4 ตัว', true); send({ t: 'roomJoin', code: c }); };
  $('#hOut').onclick = () => {
    if (st.me) send({ t: 'logout', token: st.token });
    st.me = null; st.token = null; store.del('hd_token'); sstore.del('hd_token'); st.room = null; show('auth'); setBadge();
  };
  $('#hHow').onclick = () => $('#mHow').classList.add('on');
  $('#mHowX').onclick = () => $('#mHow').classList.remove('on');

  /* =============================================================== room UI */
  function renderRoom() {
    if (st.screen !== 'room' || !st.room || !st.me) return;
    const r = st.room, host = r.host === st.me.uid;
    $('#rCode').textContent = r.code; $('#rCnt').textContent = r.players.length;
    $('#rPlayers').innerHTML = r.players.map((p) => '<span class="pl"><span class="av" style="width:24px;height:24px;font-size:12px;background:' + avColor(p.uid) + '">' + esc(p.name[0].toUpperCase()) + '</span>' + esc(p.name) + (p.uid === r.host ? ' 👑' : '') + '</span>').join('');
    mapPicker($('#rMaps'), r.map, (id) => send({ t: 'setMap', map: id }), !host);
    $('#rMapNote').textContent = host ? '' : 'เฉพาะหัวหน้าห้องเปลี่ยนแมพได้';
    $('#rStart').style.display = host ? '' : 'none';
    const fs = st.me.friends.filter((f) => f.online && !r.players.some((p) => p.uid === f.uid));
    $('#rFriends').innerHTML = fs.length ? fs.map((u) => '<div class="it"><span class="nm"><span class="dot on"></span>' + esc(u.name) + '</span><button class="btn sm" data-a="inv" data-u="' + u.uid + '">เชิญ</button></div>').join('') : '<div class="mut">ไม่มีเพื่อนออนไลน์ที่เชิญได้ — ส่งลิงก์ให้เพื่อนก็ได้</div>';
  }
  $('#rCopy').onclick = () => st.room && copyText(location.origin + location.pathname + '?room=' + st.room.code);
  $('#rStart').onclick = () => { Snd.click(); send({ t: 'start' }); };
  $('#rLeave').onclick = () => { Snd.click(); send({ t: 'roomLeave' }); };

  /* =============================================================== game flow */
  function startSolo() {
    st.mode = 'solo'; st.myId = 'me';
    st.game = S.createGame(st.map, [{ id: 'me', name: st.me ? st.me.name : 'ผู้เล่น' }]);
    enterGame('solo');
  }
  function enterGame(mode) {
    st.mode = mode; st.selSlot = -1; st.paused = false; fx.parts.length = 0; fx.beams.length = 0; gv.clear(); fx.shake = 0; fx.flash = 0;
    if (mode === 'online' && st.me) st.myId = st.me.uid;
    $('#result').classList.remove('on'); $('#gPause').style.display = mode === 'solo' ? '' : 'none'; $('#gPause').textContent = '⏸';
    lastCoin = 0; lastHtml = ''; show('game'); setBadge();
    if (!sawTip) { sawTip = true; if (innerHeight > innerWidth) toast('📱 หมุนจอเป็นแนวนอนจะเล่นง่ายกว่า'); }
  }
  let sawTip = false;
  function exitGame(silent) {
    if (st.mode === 'online') { if (!silent) { send({ t: 'roomLeave' }); } st.game = null; st.room = null; }
    st.game = null; show('home'); renderHome(); setBadge();
  }
  $('#gExit').onclick = () => { Snd.click(); if (st.game && st.game.phase !== 'over' && !confirm('ออกจากเกม?')) return; exitGame(); };
  $('#gPause').onclick = () => { st.paused = !st.paused; $('#gPause').textContent = st.paused ? '▶' : '⏸'; };
  $('#gMute').onclick = () => { Snd.init(); Snd.setMute(!Snd.muted); $('#gMute').textContent = Snd.muted ? '🔇' : '🔊'; };
  $('#gMute').textContent = Snd.muted ? '🔇' : '🔊';

  function act(a) { if (st.mode === 'solo') S.act(st.game, st.myId, a); else send({ t: 'act', a }); }

  /* =============================================================== effects */
  const fx = { parts: [], beams: [], shake: 0, flash: 0, red: 0, lightning: 0, nextLn: 10, ang: {}, t: 0 };
  const gv = new Map(); // ghost view positions
  let lastCoin = 0;
  function P(o) { fx.parts.push(Object.assign({ vx: 0, vy: 0, g: 0, life: 0.6, max: 0.6, size: 3, color: '#fff', type: 'dot' }, o, {})); }
  function burst(x, y, n, color, spd = 120, life = 0.5, size = 3, g = 200) {
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, s = Math.random() * spd; P({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g, life: life * (0.5 + Math.random() * 0.7), max: life, size: size * (0.5 + Math.random()), color }); }
  }
  function floatText(x, y, text, color, size = 14) { P({ x, y, vy: -38, life: 0.9, max: 0.9, type: 'text', text, color, size }); }
  function handleEvents(evs) {
    const g = st.game;
    for (const e of evs) {
      switch (e.e) {
        case 'spawn': Snd.spawn(); burst(e.x, e.y, 10, '#9aa0c8', 60, 0.8, 4, 0); break;
        case 'shoot': {
          const col = S.TURRETS[e.k].color;
          fx.beams.push({ x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, life: e.k === 'cannon' ? 0.16 : 0.09, max: e.k === 'cannon' ? 0.16 : 0.09, color: col, w: e.k === 'cannon' ? 5 : 2.4 });
          fx.ang[Math.round(e.x1) + '_' + Math.round(e.y1)] = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
          burst(e.x2, e.y2, e.k === 'cannon' ? 9 : 4, col, 90, 0.35, 2.5, 0);
          floatText(e.x2 + (Math.random() * 16 - 8), e.y2 - 18, String(e.dmg), '#fff', 11);
          Snd.shoot(e.k); Snd.hit(); if (e.k === 'cannon') fx.shake = Math.max(fx.shake, 2);
          break;
        }
        case 'doorhit': Snd.doorhit(); burst(e.x, e.y, 8, '#b98150', 110, 0.5, 3, 300); fx.shake = Math.max(fx.shake, 5);
          for (let i = 0; i < 3; i++) P({ x: e.x - 14 + i * 14, y: e.y, type: 'claw', life: 0.35, max: 0.35, color: '#ff4d5e', size: 1, vy: 0 }); break;
        case 'doorbreak': Snd.doorbreak(); burst(e.x, e.y, 28, '#a56f3f', 220, 0.9, 4, 380); fx.shake = 16; fx.red = 0.35; break;
        case 'kill': Snd.kill(); P({ x: e.x, y: e.y, type: 'ring', life: 0.6, max: 0.6, color: '#c9b8ff', size: 8 }); burst(e.x, e.y, 14, '#d8ccff', 130, 0.7, 3, -40);
          floatText(e.x, e.y - 24, '+' + e.reward + ' 🪙', '#ffcf5a', 15); break;
        case 'build': Snd.build(); P({ x: e.x, y: e.y, type: 'ring', life: 0.5, max: 0.5, color: '#ffcf5a', size: 6 }); burst(e.x, e.y, 10, '#ffe08a', 100, 0.6, 2.5, -30); break;
        case 'repair': Snd.repair(); burst(e.x, e.y, 10, '#8cffc4', 90, 0.6, 2.5, -30); break;
        case 'claim': Snd.claim(); P({ x: e.x, y: e.y, type: 'ring', life: 0.5, max: 0.5, color: '#7ee8ff', size: 10 }); break;
        case 'die': case 'jump': Snd.scare(); fx.red = 0.7; fx.shake = 22; if (e.e === 'die') floatText(e.x, e.y - 30, (e.name || '') + ' ถูกจับ!', '#ff8892', 15); break;
        case 'deny': if (e.id === st.myId) { Snd.deny(); fx.shake = Math.max(fx.shake, 2); } break;
        case 'start': Snd.start(); break;
        case 'win': Snd.win(); break;
        case 'lose': Snd.lose(); break;
      }
    }
  }
  function updateFx(dt) {
    fx.t += dt;
    for (let i = fx.parts.length - 1; i >= 0; i--) {
      const p = fx.parts[i]; p.life -= dt; if (p.life <= 0) { fx.parts.splice(i, 1); continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = fx.beams.length - 1; i >= 0; i--) { fx.beams[i].life -= dt; if (fx.beams[i].life <= 0) fx.beams.splice(i, 1); }
    fx.shake = Math.max(0, fx.shake - dt * 30); fx.red = Math.max(0, fx.red - dt); fx.lightning = Math.max(0, fx.lightning - dt * 2.2);
    fx.nextLn -= dt;
    if (fx.nextLn <= 0 && st.game && st.game.phase !== 'over') { fx.nextLn = 14 + Math.random() * 16; fx.lightning = 1; setTimeout(() => Snd.thunder(), 250 + Math.random() * 500); }
    // sleeping z's
    const g = st.game;
    if (g && g.phase === 'play' && Math.random() < dt * 3) {
      const r = g.rooms[(Math.random() * g.rooms.length) | 0];
      const o = g.players.find((p) => p.id === r.owner);
      if (o && o.alive) P({ x: r.bed.x + 18, y: r.bed.y + (r.side ? -4 : 4), vx: 9, vy: -16, life: 1.6, max: 1.6, type: 'text', text: 'z', color: '#bcd2ff', size: 12 });
    }
    // smooth ghost positions
    if (g) {
      const k = Math.min(1, dt * 14), seen = new Set();
      for (const gh of g.ghosts) {
        seen.add(gh.id); let v = gv.get(gh.id);
        if (!v) { v = { x: gh.x, y: gh.y }; gv.set(gh.id, v); }
        v.x += (gh.x - v.x) * k; v.y += (gh.y - v.y) * k;
      }
      for (const id of gv.keys()) if (!seen.has(id)) gv.delete(id);
    }
  }

  /* =============================================================== rendering */
  const cv = $('#cv'), ctx = cv.getContext('2d');
  const dark = document.createElement('canvas'), dctx = dark.getContext('2d');
  let view = { s: 1, ox: 0, oy: 0, dpr: 1, w: 0, h: 0 };
  function resize() {
    const r = $('#stage').getBoundingClientRect(); if (!r.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); dark.width = cv.width; dark.height = cv.height;
    const s = Math.min(r.width / W, r.height / H);
    view = { s, ox: (r.width - W * s) / 2, oy: (r.height - H * s) / 2, dpr, w: r.width, h: r.height };
  }
  window.addEventListener('resize', () => setTimeout(resize, 50));
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));
  new ResizeObserver(resize).observe($('#stage'));

  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function text(c, t, x, y, size, color, align = 'center', stroke = '#000a') {
    c.font = '700 ' + size + 'px "Mali","Sarabun",system-ui,sans-serif'; c.textAlign = align; c.textBaseline = 'middle';
    if (stroke) { c.lineWidth = 3; c.strokeStyle = stroke; c.strokeText(t, x, y); }
    c.fillStyle = color; c.fillText(t, x, y);
  }

  function drawRoom(c, g, r, th) {
    const owner = g.players.find((p) => p.id === r.owner);
    const mine = r.owner === st.myId;
    c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    for (let yy = 0; yy < r.h; yy += 30) for (let xx = 0; xx < r.w; xx += 30) { c.fillStyle = ((xx + yy) / 30) % 2 ? th.floor : th.floor2; c.fillRect(r.x + xx, r.y + yy, 30, 30); }
    // rug
    c.fillStyle = 'rgba(255,255,255,.035)'; roundRect(c, r.cx - 58, r.side ? r.y + 70 : r.y + 76, 116, 70, 10); c.fill();
    // lamp (wall-mounted)
    const ly = r.side ? r.y + r.h - 6 : r.y + 6;
    c.fillStyle = th.lamp; c.globalAlpha = 0.5 + 0.1 * Math.sin(fx.t * 3 + r.id); roundRect(c, r.cx - 22, ly - 3, 44, 6, 3); c.fill(); c.globalAlpha = 1;
    if (r.ruined) { c.fillStyle = 'rgba(120,10,20,.38)'; c.fillRect(r.x, r.y, r.w, r.h); }
    c.restore();
    c.lineWidth = 8; c.strokeStyle = th.wall; c.strokeRect(r.x, r.y, r.w, r.h);
    c.lineWidth = 1.5; c.strokeStyle = mine ? '#ffcf5a' : 'rgba(255,255,255,.12)'; c.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
    drawBed(c, r, owner, th);
    // name tag
    const ty = r.side ? r.y + r.h - 12 : r.y + 14;
    if (owner) text(c, (owner.alive ? '' : '💀 ') + owner.name, r.x + 12, ty, 12, mine ? '#ffcf5a' : '#dfe3ef', 'left');
    else if (g.phase === 'pick') {
      const a = 0.55 + 0.45 * Math.sin(fx.t * 5);
      c.save(); c.setLineDash([10, 8]); c.lineWidth = 3; c.strokeStyle = 'rgba(126,232,255,' + a + ')'; c.strokeRect(r.x + 10, r.y + 10, r.w - 20, r.h - 20); c.restore();
      text(c, 'ห้องว่าง', r.cx, r.y + r.h / 2 - 8, 18, '#7ee8ff'); text(c, 'แตะเพื่อเลือก', r.cx, r.y + r.h / 2 + 14, 13, '#bfefff');
    } else text(c, 'ห้องว่าง', r.x + 12, ty, 11, '#666', 'left');
    // turret pads & turrets
    for (let i = 0; i < r.slots.length; i++) {
      const s = r.slots[i];
      if (!s.k) {
        if (mine && g.phase === 'play') {
          c.beginPath(); c.arc(s.x, s.y, 13, 0, 6.283); c.fillStyle = 'rgba(255,255,255,.05)'; c.fill(); c.setLineDash([4, 4]); c.lineWidth = 1.5; c.strokeStyle = st.selSlot === i ? '#7ee8ff' : 'rgba(255,255,255,.35)'; c.stroke(); c.setLineDash([]);
          text(c, '+', s.x, s.y, 16, st.selSlot === i ? '#7ee8ff' : '#ffffff99', 'center', null);
        }
      } else drawTurret(c, s, mine && st.selSlot === i);
    }
    drawDoor(c, r, th);
  }
  function drawBed(c, r, owner, th) {
    const b = r.bed, up = r.side; // up: bottom rooms have back wall at bottom -> pillow at bottom
    c.save(); c.translate(b.x, b.y);
    if (r.ruined) c.rotate(0.05);
    c.fillStyle = 'rgba(0,0,0,.35)'; roundRect(c, -40, -22, 80, 52, 8); c.fill();
    c.fillStyle = '#5a4636'; roundRect(c, -38, -26, 76, 50, 7); c.fill();
    c.fillStyle = r.ruined ? '#5b2a30' : th.bed; roundRect(c, -35, -22, 70, 44, 6); c.fill();
    const py = up ? 12 : -14; // pillow center
    c.fillStyle = '#eef0f6'; roundRect(c, -22, py - 8, 44, 16, 6); c.fill();
    // blanket
    c.fillStyle = r.ruined ? '#722a33' : shade(th.bed, 18); roundRect(c, -35, up ? -22 : -2, 70, 24, 6); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1; for (let i = -20; i < 30; i += 14) { c.beginPath(); c.moveTo(i, up ? -20 : 0); c.lineTo(i, up ? 0 : 20); c.stroke(); }
    if (owner && owner.alive) {
      const br = Math.sin(fx.t * 2 + r.id) * 0.6;
      c.fillStyle = '#f2d2b8'; c.beginPath(); c.arc(0, py + br * 0.4, 10, 0, 6.283); c.fill();
      c.fillStyle = avColor(owner.id); c.beginPath(); c.arc(0, py + br * 0.4 + (up ? 3 : -3), 10, up ? 0.2 : Math.PI + 0.2, up ? Math.PI - 0.2 : 6.283 - 0.2); c.fill();
      c.strokeStyle = '#3a2a22'; c.lineWidth = 1.4; c.beginPath(); c.moveTo(-5, py - 1); c.lineTo(-2, py - 1); c.moveTo(2, py - 1); c.lineTo(5, py - 1); c.stroke();
      c.beginPath(); c.arc(0, py + 4, 2, 0.1, Math.PI - 0.1); c.stroke();
    }
    c.restore();
    if (r.owner !== null && !r.ruined) {
      for (let i = 0; i < r.bed.lv; i++) { c.fillStyle = '#ffcf5a'; c.fillRect(b.x - 35 + i * 7, b.y + (up ? -34 : 30), 5, 3); }
    }
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16); const f = (v) => Math.max(0, Math.min(255, v + amt));
    return 'rgb(' + f(n >> 16) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
  }
  function drawDoor(c, r, th) {
    const d = r.door, f = d.hp / d.max;
    c.save(); c.translate(d.x, d.y);
    if (d.hp <= 0) {
      c.fillStyle = '#0a0a0e'; c.fillRect(-30, -7, 60, 14);
      c.fillStyle = '#6b4526'; c.save(); c.rotate(-0.5); c.fillRect(-32, -6, 24, 6); c.restore(); c.save(); c.rotate(0.6); c.fillRect(10, -2, 22, 6); c.restore();
    } else {
      const shake = fx.shake > 8 ? (Math.random() - 0.5) * 1.5 : 0;
      c.translate(shake, 0);
      c.fillStyle = th.door; roundRect(c, -30, -8, 60, 16, 3); c.fill();
      c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; for (let i = -20; i <= 20; i += 10) { c.beginPath(); c.moveTo(i, -8); c.lineTo(i, 8); c.stroke(); }
      if (f < 0.66) { c.strokeStyle = 'rgba(0,0,0,.7)'; c.lineWidth = 1.4; c.beginPath(); c.moveTo(-12, -8); c.lineTo(-6, 0); c.lineTo(-14, 8); c.stroke(); }
      if (f < 0.33) { c.beginPath(); c.moveTo(14, -8); c.lineTo(8, -1); c.lineTo(16, 8); c.moveTo(0, -8); c.lineTo(4, 2); c.stroke(); c.fillStyle = 'rgba(180,20,30,.3)'; c.fillRect(-30, -8, 60, 16); }
      c.fillStyle = '#ffd36a'; c.beginPath(); c.arc(22, 0, 2.3, 0, 6.283); c.fill();
    }
    c.restore();
    if (r.owner !== null && !r.ruined) {
      const by = r.side ? d.y - 16 : d.y + 16; // hp bar drawn on corridor side
      const cy = r.side ? d.y - 16 : d.y + 16;
      c.fillStyle = '#000b'; c.fillRect(d.x - 28, cy - 3, 56, 6);
      c.fillStyle = f > 0.5 ? '#62e39a' : f > 0.25 ? '#ffcf5a' : '#ff4d5e'; c.fillRect(d.x - 27, cy - 2, 54 * Math.max(0, f), 4);
      text(c, 'Lv' + d.lv, d.x + 38, cy, 10, '#ffe9b0', 'left');
      void by;
    }
  }
  function drawTurret(c, s, sel) {
    const def = S.TURRETS[s.k], key = Math.round(s.x) + '_' + Math.round(s.y), ang = fx.ang[key] !== undefined ? fx.ang[key] : (s.y > CY ? -Math.PI / 2 : Math.PI / 2);
    c.save(); c.translate(s.x, s.y);
    if (sel) { c.beginPath(); c.arc(0, 0, 19, 0, 6.283); c.strokeStyle = '#7ee8ff'; c.lineWidth = 2; c.stroke(); }
    c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.ellipse(0, 5, 14, 7, 0, 0, 6.283); c.fill();
    if (s.k === 'frost') {
      const pulse = 0.5 + 0.5 * Math.sin(fx.t * 4 + s.x);
      c.fillStyle = 'rgba(167,200,255,' + (0.18 + pulse * 0.18) + ')'; c.beginPath(); c.arc(0, -2, 20 + pulse * 3, 0, 6.283); c.fill();
      c.fillStyle = '#3c4a73'; roundRect(c, -8, -4, 16, 14, 4); c.fill();
      c.fillStyle = '#cfe0ff'; c.beginPath(); c.moveTo(0, -18); c.lineTo(9, -3); c.lineTo(0, 4); c.lineTo(-9, -3); c.closePath(); c.fill();
      c.fillStyle = '#fff'; c.globalAlpha = 0.6 + 0.4 * pulse; c.beginPath(); c.arc(0, -6, 3, 0, 6.283); c.fill(); c.globalAlpha = 1;
      if (s.rec > 0) { c.strokeStyle = '#a7c8ff'; c.lineWidth = 2; c.beginPath(); c.arc(0, -4, 22 + (0.15 - s.rec) * 120, 0, 6.283); c.stroke(); }
    } else {
      const big = s.k === 'cannon';
      c.fillStyle = big ? '#4a3a2a' : '#2e3b4a'; c.beginPath(); c.arc(0, 0, big ? 14 : 11, 0, 6.283); c.fill();
      c.rotate(ang); const rc = s.rec > 0 ? -5 * (s.rec / 0.15) : 0;
      c.fillStyle = big ? '#ff9f3a' : '#5ee0ff'; roundRect(c, rc + 2, big ? -5 : -3, big ? 22 : 17, big ? 10 : 6, 2); c.fill();
      c.fillStyle = '#fff'; c.fillRect(rc + (big ? 20 : 15), -1.5, 3, 3);
      c.rotate(-ang);
      c.fillStyle = def.color; c.beginPath(); c.arc(0, 0, 4, 0, 6.283); c.fill();
    }
    for (let i = 0; i < s.lv; i++) { c.fillStyle = '#ffcf5a'; c.fillRect(-s.lv * 3.5 + i * 7, 14, 5, 3); }
    c.restore();
  }

  function drawGhost(c, gh, v) {
    const flash = gh.hf > 0, x = v.x, y = v.y, tt = fx.t * 4 + gh.id * 1.7;
    const bob = Math.sin(tt) * 3;
    c.save(); c.translate(x, y + bob);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.ellipse(0, 26 - bob, 15, 5, 0, 0, 6.283); c.fill();
    const f = gh.face || 1;
    c.scale(f, 1);
    if (gh.kind === 'wail') {
      const body = flash ? '#ffffff' : '#e7eaf3';
      c.fillStyle = body; c.beginPath(); c.moveTo(-11, -4); c.lineTo(11, -4); c.lineTo(17, 22);
      for (let i = 0; i < 5; i++) c.quadraticCurveTo(17 - i * 7 - 3.5, 22 + (i % 2 ? 4 : -2) + Math.sin(tt + i) * 2, 17 - (i + 1) * 6.8, 22);
      c.lineTo(-17, 22); c.closePath(); c.fill();
      c.strokeStyle = body; c.lineWidth = 5; c.lineCap = 'round';
      const sw = gh.state === 'attack' ? Math.sin(fx.t * 14) * 10 : Math.sin(tt) * 3;
      c.beginPath(); c.moveTo(-10, 0); c.lineTo(-20, 12 + sw); c.moveTo(10, 0); c.lineTo(20, 12 - sw); c.stroke();
      c.fillStyle = flash ? '#fff' : '#0b0b10'; c.beginPath(); c.ellipse(0, -14, 14, 16, 0, 0, 6.283); c.fill();
      c.beginPath(); c.moveTo(-14, -12); c.quadraticCurveTo(-18, 10, -12 + Math.sin(tt) * 2, 20); c.lineTo(-6, 4); c.lineTo(-8, -10); c.fill();
      c.beginPath(); c.moveTo(14, -12); c.quadraticCurveTo(18, 10, 12 + Math.sin(tt + 1) * 2, 20); c.lineTo(6, 4); c.lineTo(8, -10); c.fill();
      c.fillStyle = flash ? '#fff' : '#dfe1ea'; c.beginPath(); c.ellipse(0, -12, 6.5, 8, 0, 0, 6.283); c.fill();
      c.fillStyle = flash ? '#fff' : '#0b0b10'; c.beginPath(); c.ellipse(0, -20, 8, 5, 0, Math.PI, 6.283); c.fill();
      c.fillStyle = '#ff2b3d'; c.beginPath(); c.arc(-2.6, -12, 1.8, 0, 6.283); c.arc(2.6, -12, 1.8, 0, 6.283); c.fill();
    } else if (gh.kind === 'shade') {
      c.globalAlpha = 0.85;
      for (let i = 4; i >= 1; i--) { c.fillStyle = flash ? '#fff' : 'rgba(70,40,110,' + (0.6 - i * 0.1) + ')'; c.beginPath(); c.arc(-i * 9, 4 + Math.sin(tt - i) * 3, 12 - i * 1.8, 0, 6.283); c.fill(); }
      c.globalAlpha = 1; c.fillStyle = flash ? '#fff' : '#3a2466'; c.beginPath(); c.arc(0, 0, 15, 0, 6.283); c.fill();
      c.fillStyle = flash ? '#fff' : '#1b0f36'; c.beginPath(); c.arc(0, 0, 11, 0, 6.283); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.ellipse(-5, -3, 3.4, 5, 0, 0, 6.283); c.ellipse(5, -3, 3.4, 5, 0, 0, 6.283); c.fill();
      c.fillStyle = '#c0a0ff'; c.beginPath(); c.arc(-5, -2, 1.4, 0, 6.283); c.arc(5, -2, 1.4, 0, 6.283); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 1.3; c.beginPath(); c.moveTo(-6, 6); for (let i = 0; i < 6; i++) c.lineTo(-6 + i * 2.4 + 1.2, 6 + (i % 2 ? -3 : 2)); c.stroke();
    } else { // brute
      c.scale(1.25, 1.25);
      const body = flash ? '#fff' : '#566251', dk = flash ? '#fff' : '#3c463a';
      const sw = gh.state === 'attack' ? Math.sin(fx.t * 9) * 12 : Math.sin(tt * 0.6) * 4;
      c.strokeStyle = dk; c.lineWidth = 8; c.lineCap = 'round'; c.beginPath(); c.moveTo(-12, -2); c.lineTo(-20, 14 + sw); c.moveTo(12, -2); c.lineTo(20, 14 - sw); c.stroke();
      c.fillStyle = body; roundRect(c, -14, -8, 28, 32, 9); c.fill();
      c.fillStyle = dk; c.fillRect(-10, 8, 20, 3); c.fillRect(-8, 14, 16, 3);
      c.fillStyle = body; c.beginPath(); c.arc(0, -17, 13, 0, 6.283); c.fill();
      c.fillStyle = flash ? '#fff' : '#d9d2c0'; c.beginPath(); c.moveTo(-10, -26); c.lineTo(-7, -36); c.lineTo(-3, -27); c.closePath(); c.moveTo(10, -26); c.lineTo(7, -36); c.lineTo(3, -27); c.closePath(); c.fill();
      c.fillStyle = '#ffd23a'; c.beginPath(); c.moveTo(-8, -19); c.lineTo(-2, -17); c.lineTo(-8, -15); c.closePath(); c.moveTo(8, -19); c.lineTo(2, -17); c.lineTo(8, -15); c.closePath(); c.fill();
      c.strokeStyle = '#1b1f19'; c.lineWidth = 1.6; c.beginPath(); c.moveTo(-6, -9); for (let i = 0; i < 5; i++) c.lineTo(-6 + i * 3, -9 + (i % 2 ? -3 : 1)); c.stroke();
    }
    c.restore();
    // hp bar + level
    const w = gh.kind === 'brute' ? 40 : 30, fr = Math.max(0, gh.hp / gh.max);
    c.fillStyle = '#000c'; c.fillRect(x - w / 2, y - 40, w, 5);
    c.fillStyle = fr > 0.5 ? '#62e39a' : fr > 0.25 ? '#ffcf5a' : '#ff4d5e'; c.fillRect(x - w / 2 + 1, y - 39, (w - 2) * fr, 3);
    text(c, 'Lv' + gh.lv, x, y - 47, 9, '#ffd1d6');
    if (gh.slow > 0) { c.strokeStyle = '#a7c8ff'; c.lineWidth = 2; c.beginPath(); c.arc(x, y + 4, 22, 0, 6.283); c.stroke(); }
  }

  function render() {
    const g = st.game; if (!g || !view.w) return;
    const th = S.MAPS[g.map].theme, c = ctx, d = view.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
    const sx = fx.shake ? (Math.random() - 0.5) * fx.shake : 0, sy = fx.shake ? (Math.random() - 0.5) * fx.shake : 0;
    const T = [view.s * d, 0, 0, view.s * d, (view.ox + sx) * d, (view.oy + sy) * d];
    c.setTransform(...T);
    c.fillStyle = th.bg; c.fillRect(0, 0, W, H);
    // corridor
    c.save(); c.beginPath(); c.rect(0, 240, W, 160); c.clip();
    for (let yy = 240; yy < 400; yy += 40) for (let xx = 0; xx < W; xx += 40) { c.fillStyle = ((xx + yy) / 40) % 2 ? th.corr : th.corr2; c.fillRect(xx, yy, 40, 40); }
    c.fillStyle = 'rgba(255,255,255,.03)'; c.fillRect(0, 316, W, 8);
    c.restore();
    for (const r of g.rooms) drawRoom(c, g, r, th);
    // ghosts sorted by y
    const gs = [...g.ghosts].sort((a, b) => a.y - b.y);
    for (const gh of gs) drawGhost(c, gh, gv.get(gh.id) || gh);
    // beams
    for (const b of fx.beams) {
      const a = b.life / b.max; c.globalAlpha = a; c.strokeStyle = b.color; c.lineWidth = b.w; c.lineCap = 'round';
      c.beginPath(); c.moveTo(b.x1, b.y1); c.lineTo(b.x2, b.y2); c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = b.w * 0.4; c.beginPath(); c.moveTo(b.x1, b.y1); c.lineTo(b.x2, b.y2); c.stroke(); c.globalAlpha = 1;
    }
    // particles
    for (const p of fx.parts) {
      const a = Math.max(0, p.life / p.max);
      if (p.type === 'text') { c.globalAlpha = Math.min(1, a * 1.6); text(c, p.text, p.x, p.y, p.size, p.color); c.globalAlpha = 1; }
      else if (p.type === 'ring') { c.globalAlpha = a; c.strokeStyle = p.color; c.lineWidth = 3; c.beginPath(); c.arc(p.x, p.y, p.size + (1 - a) * 34, 0, 6.283); c.stroke(); c.globalAlpha = 1; }
      else if (p.type === 'claw') { c.globalAlpha = a; c.strokeStyle = p.color; c.lineWidth = 2.5; c.beginPath(); c.moveTo(p.x - 6, p.y - 22 + (1 - a) * 8); c.lineTo(p.x + 6, p.y + 14 + (1 - a) * 8); c.stroke(); c.globalAlpha = 1; }
      else { c.globalAlpha = a; c.fillStyle = p.color; c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size); c.globalAlpha = 1; }
    }
    // darkness with lights
    const dk = dctx; dk.setTransform(1, 0, 0, 1, 0, 0); dk.globalCompositeOperation = 'source-over'; dk.clearRect(0, 0, dark.width, dark.height);
    const lit = Math.max(0, 0.5 - fx.lightning * 0.5);
    dk.fillStyle = 'rgba(2,3,12,' + lit + ')'; dk.fillRect(0, 0, dark.width, dark.height);
    dk.setTransform(...T); dk.globalCompositeOperation = 'destination-out';
    const light = (x, y, r, a) => { const gr = dk.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(0,0,0,' + a + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)'); dk.fillStyle = gr; dk.fillRect(x - r, y - r, r * 2, r * 2); };
    for (const r of g.rooms) {
      const on = g.phase === 'pick' || (r.owner !== null && !r.ruined);
      light(r.cx, r.y + r.h / 2, (on ? 215 : 120) * (1 + 0.025 * Math.sin(fx.t * 5 + r.id)), on ? 0.95 : 0.6);
      for (const s of r.slots) if (s.k) light(s.x, s.y, s.k === 'frost' ? 95 : 70, 0.75);
    }
    light(W / 2, CY, 330, 0.45); light(W * 0.2, CY, 200, 0.35); light(W * 0.8, CY, 200, 0.35);
    for (const gh of g.ghosts) { const v = gv.get(gh.id) || gh; light(v.x, v.y, 62, 0.8); }
    for (const b of fx.beams) light(b.x2, b.y2, 70, 0.8 * (b.life / b.max));
    dk.globalCompositeOperation = 'source-over';
    c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(dark, 0, 0);
    // vignette + red flash + lightning
    c.setTransform(d, 0, 0, d, 0, 0);
    const vg = c.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.35, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)'); c.fillStyle = vg; c.fillRect(0, 0, view.w, view.h);
    if (fx.red > 0) { c.fillStyle = 'rgba(190,10,25,' + Math.min(0.55, fx.red * 0.8) + ')'; c.fillRect(0, 0, view.w, view.h); }
    if (fx.lightning > 0.55) { c.fillStyle = 'rgba(210,225,255,' + (fx.lightning - 0.55) * 0.5 + ')'; c.fillRect(0, 0, view.w, view.h); }
    // pick countdown
    if (g.phase === 'pick') {
      c.setTransform(d, 0, 0, d, 0, 0);
      text(c, 'เลือกห้องนอน · ' + Math.ceil(g.pickT) + ' วิ', view.w / 2, 18, 16, '#fff');
    }
  }

  /* =============================================================== input + panel */
  cv.addEventListener('pointerdown', (e) => {
    const g = st.game; if (!g || g.phase === 'over' || st.paused) return;
    const r = cv.getBoundingClientRect(), x = (e.clientX - r.left - view.ox) / view.s, y = (e.clientY - r.top - view.oy) / view.s;
    if (g.phase === 'pick') {
      const room = g.rooms.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
      if (room && room.owner === null) act({ a: 'claim', room: room.id }); else if (room) Snd.deny();
      return;
    }
    const me = g.players.find((p) => p.id === st.myId); if (!me || !me.alive || me.room < 0) return;
    const rm = g.rooms[me.room];
    for (let i = 0; i < rm.slots.length; i++) if (Math.hypot(rm.slots[i].x - x, rm.slots[i].y - y) < 28) { st.selSlot = st.selSlot === i ? -1 : i; Snd.click(); lastHtml = ''; return; }
  });
  let lastHtml = '', lastPanelT = 0;
  function panelHtml() {
    const g = st.game, me = g.players.find((p) => p.id === st.myId);
    if (g.phase === 'pick') return '<div class="hint">แตะ <b>ห้องว่าง</b> บนแมพเพื่อเลือกห้องนอน' + (me && me.room >= 0 ? ' ✅ เลือกแล้ว (เปลี่ยนได้)' : '') + '</div>';
    if (!me) return '<div class="hint">กำลังดูเกม</div>';
    if (!me.alive) return '<div class="hint">💀 คุณถูกผีจับแล้ว… ดูเพื่อนๆ สู้ต่อ</div>';
    const r = g.rooms[me.room], co = Math.floor(me.coins);
    const b = (a, label, sub, ok, extra = '') => '<button class="act' + (ok ? ' can' : '') + extra + '" data-a="' + a + '"' + (ok || extra.includes('sel') ? '' : ' disabled') + '><b>' + label + '</b><small>' + sub + '</small></button>';
    const dc = S.doorUpCost(r.door.lv), bc = S.bedUpCost(r.bed.lv), rep = Math.max(1, Math.ceil((r.door.max - r.door.hp) / 6));
    let h = '<div class="r">';
    h += r.door.lv >= S.MAX_DOOR_LV ? b('x', '🚪 ประตู Lv' + r.door.lv, 'MAX', false) : b('door', '🚪 ประตู Lv' + r.door.lv + ' ↑', dc + ' 🪙', co >= dc && r.door.hp > 0);
    h += r.bed.lv >= S.MAX_BED_LV ? b('x', '🛏️ เตียง Lv' + r.bed.lv, 'MAX', false) : b('bed', '🛏️ เตียง Lv' + r.bed.lv + ' ↑', bc + ' 🪙 · +' + S.bedIncome(r.bed.lv + 1).toFixed(1) + '/วิ', co >= bc);
    h += b('repair', '🔧 ซ่อมประตู', r.door.hp >= r.door.max ? 'เต็ม' : rep + ' 🪙', co >= rep && r.door.hp > 0 && r.door.hp < r.door.max) + '</div><div class="r">';
    r.slots.forEach((s, i) => {
      if (!s.k) h += b('slot:' + i, '➕ ช่อง ' + (i + 1), 'วางป้อม', true, st.selSlot === i ? ' sel' : '');
      else { const uc = S.turretUpCost(s); h += s.lv >= S.MAX_TURRET_LV ? b('x', S.TURRETS[s.k].name + ' Lv' + s.lv, 'MAX', false) : b('up:' + i, S.TURRETS[s.k].name + ' Lv' + s.lv + ' ↑', uc + ' 🪙', co >= uc); }
    });
    h += '</div>';
    if (st.selSlot >= 0 && !r.slots[st.selSlot].k) {
      h += '<div class="r">' + Object.keys(S.TURRETS).map((k) => { const t = S.TURRETS[k]; return b('build:' + st.selSlot + ':' + k, t.name, t.cost + ' 🪙 · ดาเมจ ' + t.dmg + (t.slow ? ' · ชะลอ' : ''), co >= t.cost); }).join('') + '</div>';
    }
    return h;
  }
  $('#panel').addEventListener('click', (e) => {
    const bt = e.target.closest('button[data-a]'); if (!bt || bt.disabled || !st.game) return;
    const a = bt.dataset.a.split(':'); Snd.click();
    if (a[0] === 'slot') { st.selSlot = st.selSlot === +a[1] ? -1 : +a[1]; lastHtml = ''; return; }
    if (a[0] === 'build') { act({ a: 'turret', slot: +a[1], kind: a[2] }); st.selSlot = -1; lastHtml = ''; return; }
    if (a[0] === 'up') { act({ a: 'upTurret', slot: +a[1] }); return; }
    if (a[0] === 'x') return;
    act({ a: a[0] });
  });
  function updateUi(now) {
    const g = st.game; if (!g) return;
    const me = g.players.find((p) => p.id === st.myId);
    const t = g.phase === 'pick' ? 0 : g.t;
    $('#dawn .bar i').style.width = Math.min(100, (t / g.dawn) * 100) + '%';
    const rem = Math.max(0, Math.ceil(g.dawn - t)); $('#dawnTxt').textContent = '🌙 ' + String(Math.floor(rem / 60)).padStart(2, '0') + ':' + String(rem % 60).padStart(2, '0') + ' ถึงรุ่งสาง · ผี Lv' + (1 + Math.floor(g.t / 45));
    if (me) {
      const co = Math.floor(me.coins), inc = me.room >= 0 && me.alive ? S.bedIncome(g.rooms[me.room].bed.lv) : 0;
      $('#coins').innerHTML = '🪙 ' + co + '<small>+' + inc.toFixed(1) + '/วิ</small>';
      if (g.phase === 'play' && me.alive && Math.floor(me.coins / 5) > lastCoin) Snd.coin();
      lastCoin = Math.floor(me.coins / 5);
    }
    if (now - lastPanelT > 120) {
      lastPanelT = now; const h = panelHtml();
      if (h !== lastHtml) { lastHtml = h; $('#panel').innerHTML = h; }
    }
    if (g.phase === 'over' && !$('#result').classList.contains('on')) showResult(g);
  }
  function showResult(g) {
    const win = g.over && g.over.win, my = g.players.find((p) => p.id === st.myId);
    const rows = g.players.map((p) => '<div class="it row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)"><span>' + (p.alive ? '😴' : '💀') + ' ' + esc(p.name) + '</span><span class="mut">ล่าผี ' + p.kills + '</span></div>').join('');
    $('#resCard').innerHTML = '<h2>' + (win ? '🌅 รุ่งสางแล้ว! รอดมาได้' : '☠️ ผีเข้ายึดหอพัก') + '</h2><p class="mut">' + (win ? 'ทุกคนที่รอดชนะคืนนี้' : 'อยู่รอดได้ ' + Math.floor(g.t) + ' วินาที') + '</p><div style="text-align:left;margin:8px 0 12px">' + rows + '</div>' +
      (st.mode === 'solo' ? '<button class="btn" id="resAgain">เล่นอีกครั้ง</button>' : (st.room && st.me && st.room.host === st.me.uid ? '<button class="btn" id="resAgain">เล่นอีกรอบ (เริ่มทันที)</button>' : '<div class="mut" style="margin-bottom:8px">รอหัวหน้าห้องเริ่มรอบใหม่ หรือกลับไปที่ห้อง</div>')) +
      (st.mode === 'online' ? '<button class="btn sec" id="resRoom">กลับไปที่ห้อง</button>' : '') + '<button class="btn sec" id="resHome">หน้าหลัก</button>';
    $('#result').classList.add('on'); void my;
    const again = $('#resAgain'); if (again) again.onclick = () => { if (st.mode === 'solo') { $('#result').classList.remove('on'); startSolo(); } else send({ t: 'start' }); };
    const rr = $('#resRoom'); if (rr) rr.onclick = () => { $('#result').classList.remove('on'); show('room'); renderRoom(); };
    $('#resHome').onclick = () => { $('#result').classList.remove('on'); exitGame(); };
  }

  /* =============================================================== main loop */
  let last = performance.now();
  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    if (st.screen !== 'game' || !st.game) return;
    if (st.mode === 'solo' && !st.paused) { S.step(st.game, dt); handleEvents(S.drain(st.game)); }
    if (!st.paused) updateFx(dt);
    render(); updateUi(ts);
  }
  requestAnimationFrame(frame);

  /* =============================================================== boot */
  if (!(store.get('hd_token') || sstore.get('hd_token'))) show('auth'); else $('#aNote').textContent = 'กำลังเข้าสู่ระบบอัตโนมัติ…';
  setAuthMode('login');
  connect();
  setTimeout(resize, 100);
})();
