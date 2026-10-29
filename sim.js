/* sim.js — game simulation shared by the server (online) and the browser (solo).
   Pure data in / data out so a full state can be JSON-serialised as a snapshot. */
(function (root) {
  'use strict';

  const W = 1060, H = 640, CY = 320;
  const DAWN = { dorm: 480, hospital: 540, school: 480 };

  const MAPS = {
    dorm: {
      id: 'dorm', name: 'หอพักร้าง', perSide: 3, desc: '3 ห้องบน 3 ห้องล่าง · ผีมาเร็ว',
      theme: { bg: '#0c0d12', floor: '#2b2833', floor2: '#25222d', corr: '#1a1c24', corr2: '#16181f', wall: '#07070a', door: '#7a4a2b', accent: '#7ee8ff', bed: '#3b5b8c', lamp: '#ffd9a0' },
    },
    hospital: {
      id: 'hospital', name: 'โรงพยาบาลเก่า', perSide: 4, desc: '4 ห้องบน 4 ห้องล่าง · ห้องแคบ',
      theme: { bg: '#07100f', floor: '#233333', floor2: '#1f2d2d', corr: '#16201f', corr2: '#121b1a', wall: '#040808', door: '#5d6f6a', accent: '#8cffc4', bed: '#8fb0a6', lamp: '#b6ffe6' },
    },
    school: {
      id: 'school', name: 'โรงเรียนร้าง', perSide: 3, desc: '3 ห้องบน 3 ห้องล่าง · ผีแข็งแกร่ง',
      theme: { bg: '#100b0b', floor: '#3a2d28', floor2: '#322722', corr: '#221a18', corr2: '#1c1513', wall: '#080505', door: '#8a5a32', accent: '#ffb07e', bed: '#8c4a3b', lamp: '#ffc27a' },
    },
  };

  const TURRETS = {
    bolt:   { name: 'ปืนผนึก',   cost: 30, dmg: 6,  cd: 0.8, range: 235, color: '#7ee8ff' },
    cannon: { name: 'ปืนใหญ่',   cost: 80, dmg: 24, cd: 1.9, range: 270, color: '#ffb347' },
    frost:  { name: 'ตะเกียงเย็น', cost: 60, dmg: 3,  cd: 1.0, range: 205, color: '#a7c8ff', slow: 0.5 },
  };

  const GHOSTS = {
    wail:  { name: 'ผีผมยาว', hp: 40,  speed: 55, dmg: 7,  reward: 6,  from: 0 },
    shade: { name: 'เงาดำ',   hp: 30,  speed: 92, dmg: 5,  reward: 7,  from: 30 },
    brute: { name: 'ผียักษ์',  hp: 130, speed: 34, dmg: 13, reward: 16, from: 70 },
  };

  const MAX_TURRET_LV = 6, MAX_DOOR_LV = 8, MAX_BED_LV = 6;
  const doorMax = (lv) => 120 + 110 * (lv - 1);
  const doorUpCost = (lv) => 40 * lv;
  const bedUpCost = (lv) => 50 * lv;
  const bedIncome = (lv) => 2 + 1.5 * lv;
  const turretUpCost = (t) => Math.round(TURRETS[t.k].cost * 0.7 * t.lv);
  const turretDmg = (t) => TURRETS[t.k].dmg * (1 + 0.55 * (t.lv - 1));

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function buildRooms(map) {
    const n = map.perSide, gap = 10, rw = (W - 40 - (n - 1) * gap) / n, rh = 220;
    const rooms = [];
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < n; i++) {
        const x = 20 + i * (rw + gap), y = side ? 400 : 20, cx = x + rw / 2;
        const doorY = side ? 400 : 240;
        const dir = side ? 1 : -1; // direction from door into the room (top rooms go up = -1)
        const slotY = doorY + dir * 40;
        rooms.push({
          id: side * n + i, side, x, y, w: rw, h: rh, cx,
          owner: null, ruined: false,
          door: { x: cx, y: doorY, lv: 1, hp: doorMax(1), max: doorMax(1) },
          bed: { x: cx, y: side ? y + rh - 48 : y + 48, lv: 1 },
          standY: side ? 378 : 262,
          slots: [
            { x: cx - Math.min(85, rw * 0.32), y: slotY, k: null, lv: 0, cd: 0, rec: 0 },
            { x: cx + Math.min(85, rw * 0.32), y: slotY, k: null, lv: 0, cd: 0, rec: 0 },
            { x: cx, y: doorY + dir * 95, k: null, lv: 0, cd: 0, rec: 0 },
          ],
        });
      }
    }
    return rooms;
  }

  function createGame(mapId, players) {
    const map = MAPS[mapId] || MAPS.dorm;
    return {
      map: map.id, phase: 'pick', t: 0, pickT: 14, spawnT: 3, nextId: 1,
      dawn: DAWN[map.id] || 480,
      rooms: buildRooms(map),
      players: players.map((p) => ({ id: p.id, name: p.name, room: -1, alive: true, coins: 40, kills: 0, left: false })),
      ghosts: [], ev: [], over: null,
    };
  }

  function ghostLevel(g) { return 1 + Math.floor(g.t / 45); }

  function pickTarget(g) {
    const live = g.rooms.filter((r) => r.owner !== null && !r.ruined);
    if (!live.length) return null;
    return live[Math.floor(Math.random() * live.length)];
  }

  function spawnGhost(g) {
    const target = pickTarget(g);
    if (!target) return;
    const lv = ghostLevel(g);
    const pool = Object.keys(GHOSTS).filter((k) => g.t >= GHOSTS[k].from);
    const kind = pool[Math.floor(Math.random() * pool.length)];
    const d = GHOSTS[kind];
    const left = Math.random() < 0.5;
    const hp = d.hp * (1 + 0.28 * (lv - 1)) * (g.map === 'school' ? 1.2 : 1);
    const ox = rnd(-22, 22);
    g.ghosts.push({
      id: g.nextId++, kind, lv, hp, max: hp,
      x: left ? -20 : W + 20, y: CY + rnd(-18, 18),
      speed: d.speed * (g.map === 'dorm' ? 1.1 : 1),
      dmg: d.dmg * (1 + 0.19 * (lv - 1)),
      target: target.id, state: 'walk', atk: 0, hf: 0, slow: 0, ox,
      face: left ? 1 : -1,
    });
    g.ev.push({ e: 'spawn', x: left ? 0 : W, y: CY, kind });
  }

  function ghostPath(g, gh) {
    const r = g.rooms[gh.target];
    return { tx: r.door.x + gh.ox, ty: r.standY };
  }

  function moveToward(gh, tx, ty, dt) {
    const dx = tx - gh.x, dy = ty - gh.y, d = Math.hypot(dx, dy);
    const sp = gh.speed * (gh.slow > 0 ? 0.5 : 1) * dt;
    if (d <= sp) { gh.x = tx; gh.y = ty; return true; }
    gh.x += (dx / d) * sp; gh.y += (dy / d) * sp;
    if (Math.abs(dx) > 2) gh.face = dx > 0 ? 1 : -1;
    return false;
  }

  function killPlayer(g, room) {
    const p = g.players.find((q) => q.id === room.owner);
    if (p && p.alive) {
      p.alive = false;
      g.ev.push({ e: 'die', x: room.bed.x, y: room.bed.y, name: p.name, id: p.id });
    }
    room.ruined = true;
  }

  function step(g, dt) {
    if (g.phase === 'over') return;
    const ev = g.ev;

    if (g.phase === 'pick') {
      g.pickT -= dt;
      if (g.pickT <= 0) {
        for (const p of g.players) {
          if (p.room < 0) {
            const free = g.rooms.filter((r) => r.owner === null);
            if (free.length) claim(g, p.id, free[Math.floor(Math.random() * free.length)].id);
          }
        }
        g.phase = 'play';
        ev.push({ e: 'start' });
      }
      return;
    }

    g.t += dt;

    // income from sleeping players
    for (const p of g.players) {
      if (!p.alive || p.room < 0) continue;
      const r = g.rooms[p.room];
      p.coins += bedIncome(r.bed.lv) * dt;
    }

    // spawn
    g.spawnT -= dt;
    if (g.spawnT <= 0) {
      const alive = g.players.filter((p) => p.alive).length || 1;
      const base = Math.max(2.2, 8 - g.t * 0.012);
      g.spawnT = base / (1 + 0.45 * (alive - 1));
      spawnGhost(g);
    }

    // ghosts
    for (const gh of g.ghosts) {
      if (gh.state === 'dead') continue;
      gh.hf = Math.max(0, gh.hf - dt);
      gh.slow = Math.max(0, gh.slow - dt);
      let room = g.rooms[gh.target];
      if (room.ruined || room.owner === null) {
        const nt = pickTarget(g);
        if (!nt) { gh.state = 'dead'; continue; }
        gh.target = nt.id; gh.state = 'walk'; room = nt;
      }
      if (gh.state === 'walk') {
        const { tx, ty } = ghostPath(g, gh);
        // go along the corridor first, then step up to the door
        let arrived = false;
        if (Math.abs(gh.x - tx) > 4) moveToward(gh, tx, gh.y, dt);
        else arrived = moveToward(gh, tx, ty, dt);
        if (arrived) {
          gh.state = room.door.hp > 0 ? 'attack' : 'enter';
          gh.atk = 0.4;
        }
      } else if (gh.state === 'attack') {
        if (room.door.hp <= 0) { gh.state = 'enter'; continue; }
        gh.atk -= dt;
        if (gh.atk <= 0) {
          gh.atk = 1;
          room.door.hp = Math.max(0, room.door.hp - gh.dmg);
          ev.push({ e: 'doorhit', x: room.door.x, y: room.door.y, room: room.id });
          if (room.door.hp <= 0) {
            ev.push({ e: 'doorbreak', x: room.door.x, y: room.door.y, room: room.id });
            gh.state = 'enter';
          }
        }
      } else if (gh.state === 'enter') {
        const done = moveToward(gh, room.bed.x, room.bed.y + (room.side ? -26 : 26), dt);
        if (done) {
          killPlayer(g, room);
          gh.state = 'dead';
          ev.push({ e: 'jump', x: room.bed.x, y: room.bed.y });
        }
      }
    }

    // turrets
    for (const r of g.rooms) {
      if (r.owner === null) continue;
      for (const s of r.slots) {
        if (!s.k) continue;
        s.cd -= dt; s.rec = Math.max(0, s.rec - dt);
        if (s.cd > 0) continue;
        const def = TURRETS[s.k];
        let best = null, bd = 1e9;
        for (const gh of g.ghosts) {
          if (gh.state === 'dead') continue;
          const d = Math.hypot(gh.x - s.x, gh.y - s.y);
          if (d <= def.range && d < bd) { bd = d; best = gh; }
        }
        if (!best) continue;
        s.cd = def.cd; s.rec = 0.15;
        best.hp -= turretDmg(s);
        best.hf = 0.12;
        if (def.slow) best.slow = 1.5;
        ev.push({ e: 'shoot', x1: s.x, y1: s.y, x2: best.x, y2: best.y, k: s.k, dmg: Math.round(turretDmg(s)) });
        if (best.hp <= 0) {
          best.state = 'dead';
          const owner = g.players.find((q) => q.id === r.owner);
          const reward = Math.round(GHOSTS[best.kind].reward * (1 + 0.15 * (best.lv - 1)));
          if (owner) { owner.coins += reward; owner.kills++; }
          ev.push({ e: 'kill', x: best.x, y: best.y, kind: best.kind, reward, room: r.id });
        }
      }
    }
    g.ghosts = g.ghosts.filter((gh) => gh.state !== 'dead');

    // end conditions
    const alive = g.players.filter((p) => p.alive);
    if (!alive.length) {
      g.phase = 'over'; g.over = { win: false, t: g.t };
      ev.push({ e: 'lose' });
    } else if (g.t >= g.dawn) {
      g.phase = 'over'; g.over = { win: true, t: g.t };
      ev.push({ e: 'win' });
    }
  }

  function claim(g, pid, roomId) {
    const p = g.players.find((q) => q.id === pid);
    const r = g.rooms[roomId];
    if (!p || !r || r.owner !== null) return false;
    if (p.room >= 0) { g.rooms[p.room].owner = null; }
    p.room = roomId; r.owner = pid;
    g.ev.push({ e: 'claim', x: r.cx, y: r.bed.y });
    return true;
  }

  function act(g, pid, a) {
    if (!a || g.phase === 'over') return false;
    const p = g.players.find((q) => q.id === pid);
    if (!p) return false;
    if (a.a === 'claim') {
      if (g.phase !== 'pick') return false;
      return claim(g, pid, a.room | 0);
    }
    if (g.phase !== 'play' || !p.alive || p.room < 0) return false;
    const r = g.rooms[p.room];
    const fail = () => { g.ev.push({ e: 'deny', id: pid }); return false; };
    if (a.a === 'door') {
      if (r.door.hp <= 0 || r.door.lv >= MAX_DOOR_LV) return fail();
      const c = doorUpCost(r.door.lv);
      if (p.coins < c) return fail();
      p.coins -= c; r.door.lv++;
      const add = doorMax(r.door.lv) - r.door.max;
      r.door.max = doorMax(r.door.lv); r.door.hp = Math.min(r.door.max, r.door.hp + add);
      g.ev.push({ e: 'build', x: r.door.x, y: r.door.y, id: pid });
      return true;
    }
    if (a.a === 'bed') {
      if (r.bed.lv >= MAX_BED_LV) return fail();
      const c = bedUpCost(r.bed.lv);
      if (p.coins < c) return fail();
      p.coins -= c; r.bed.lv++;
      g.ev.push({ e: 'build', x: r.bed.x, y: r.bed.y, id: pid });
      return true;
    }
    if (a.a === 'repair') {
      if (r.door.hp <= 0 || r.door.hp >= r.door.max) return fail();
      const c = Math.max(1, Math.ceil((r.door.max - r.door.hp) / 6));
      if (p.coins < c) return fail();
      p.coins -= c; r.door.hp = r.door.max;
      g.ev.push({ e: 'repair', x: r.door.x, y: r.door.y, id: pid });
      return true;
    }
    if (a.a === 'turret') {
      const s = r.slots[a.slot | 0];
      const def = TURRETS[a.kind];
      if (!s || !def || s.k) return fail();
      if (p.coins < def.cost) return fail();
      p.coins -= def.cost; s.k = a.kind; s.lv = 1; s.cd = 0.5;
      g.ev.push({ e: 'build', x: s.x, y: s.y, id: pid });
      return true;
    }
    if (a.a === 'upTurret') {
      const s = r.slots[a.slot | 0];
      if (!s || !s.k || s.lv >= MAX_TURRET_LV) return fail();
      const c = turretUpCost(s);
      if (p.coins < c) return fail();
      p.coins -= c; s.lv++;
      g.ev.push({ e: 'build', x: s.x, y: s.y, id: pid });
      return true;
    }
    return false;
  }

  function removePlayer(g, pid) {
    const p = g.players.find((q) => q.id === pid);
    if (!p) return;
    p.left = true;
    if (p.alive) {
      p.alive = false;
      if (p.room >= 0) g.rooms[p.room].ruined = true;
    }
  }

  function drain(g) { const e = g.ev; g.ev = []; return e; }

  const api = {
    W, H, CY, MAPS, TURRETS, GHOSTS, MAX_TURRET_LV, MAX_DOOR_LV, MAX_BED_LV,
    doorUpCost, bedUpCost, bedIncome, turretUpCost, turretDmg,
    createGame, step, act, claim, removePlayer, drain,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
