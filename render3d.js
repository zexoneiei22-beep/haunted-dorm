/* render3d.js — Three.js 3D renderer for Haunted Dorm. Reads the same game state as the 2D renderer.
   If THREE failed to load, R3D.ok stays false and game.js keeps using the 2D canvas. */
(function () {
  'use strict';
  const T = window.THREE, R3D = { ok: false };
  window.R3D = R3D;
  if (!T || /[?&]2d\b/.test(location.search)) return; // ?2d forces the old 2D view
  const K = 0.1, EL = 62 * Math.PI / 180, FOV = 38;
  let rd, sc, cam, stage, cv3, ov, W, H, S, built = '', root, amb, moon, lamps = [], rooms = [], pts, dim = '';
  const ghosts = new Map(), free = {}, beams = [], rings = [], texts = [], lab = new Map(), ccache = new Map(), ray = new T.Raycaster();
  const PN = 500, PP = new Float32Array(PN * 3), PC = new Float32Array(PN * 3), tc = new T.Color();

  /* ---- shared geometry / helpers */
  const UB = new T.BoxGeometry(1, 1, 1), US = new T.SphereGeometry(1, 16, 12), UC = new T.CylinderGeometry(1, 1, 1, 16), UK = new T.ConeGeometry(1, 1, 10),
    UO = new T.OctahedronGeometry(1), UD = new T.CircleGeometry(1, 20), UR = new T.RingGeometry(0.82, 1, 36), UT = new T.CylinderGeometry(1, 1, 1, 8, 1, true);
  const lam = (c, o) => new T.MeshLambertMaterial(Object.assign({ color: c }, o || {}));
  const bas = (c, o) => new T.MeshBasicMaterial(Object.assign({ color: c }, o || {}));
  const add = { transparent: true, blending: T.AdditiveBlending, depthWrite: false };
  function M(g, mat, sx, sy, sz, x, y, z) { const m = new T.Mesh(g, mat); m.scale.set(sx, sy, sz); m.position.set(x || 0, y || 0, z || 0); return m; }
  const wx = (x) => (x - W / 2) * K, wz = (y) => (y - H / 2) * K;
  function rgb(c) { let v = ccache.get(c); if (!v) { tc.set(c); v = [tc.r, tc.g, tc.b]; ccache.set(c, v); } return v; }
  function glowTex() {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new T.CanvasTexture(c);
  }
  let GT;
  function label(text, color, px) {
    const k = text + '|' + color + '|' + px; let e = lab.get(k);
    if (!e) {
      const c = document.createElement('canvas'), x = c.getContext('2d'), f = '700 ' + px * 2 + 'px "Mali","Sarabun",system-ui,sans-serif';
      x.font = f; const w = Math.ceil(x.measureText(text).width) + 20, h = px * 2 + 16; c.width = w; c.height = h;
      x.font = f; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,.8)'; x.lineJoin = 'round'; x.strokeText(text, w / 2, h / 2); x.fillStyle = color; x.fillText(text, w / 2, h / 2);
      const tex = new T.CanvasTexture(c); tex.minFilter = T.LinearFilter; e = { tex, asp: w / h }; lab.set(k, e);
    }
    return e;
  }
  function sprite(o) { const s = new T.Sprite(new T.SpriteMaterial(Object.assign({ transparent: true, depthWrite: false }, o || {}))); s.renderOrder = 10; return s; }
  function setLabel(s, text, color, px, h) {
    const e = label(text, color, px);
    if (s.material.map !== e.tex) { s.material.map = e.tex; s.material.needsUpdate = true; }
    s.scale.set(h * e.asp, h, 1);
  }
  function bar(w) { // billboard hp bar: background + left-anchored fill
    const g = new T.Group(), bg = sprite({ color: 0x000000, opacity: 0.75, depthTest: false }), fl = sprite({ color: 0x62e39a, depthTest: false });
    fl.center.set(0, 0.5); fl.renderOrder = 12; bg.renderOrder = 11; bg.scale.set(w, 0.55, 1); g.add(bg, fl); g.userData = { w, fl, bg };
    return g;
  }
  function setBar(b, f) {
    const w = b.userData.w, fl = b.userData.fl; f = Math.max(0, Math.min(1, f));
    fl.position.x = -w / 2 + 0.1; fl.scale.set((w - 0.2) * f, 0.33, 1); fl.material.color.set(f > 0.5 ? 0x62e39a : f > 0.25 ? 0xffcf5a : 0xff4d5e);
  }
  function blob(r) { const m = M(UD, bas(0x000000, { transparent: true, opacity: 0.38, depthWrite: false }), r, r, r, 0, 0.04, 0); m.rotation.x = -Math.PI / 2; return m; }

  /* ---- init */
  function init() {
    stage = document.getElementById('stage'); const old = document.getElementById('cv'); if (!stage || !old) return false;
    try {
      cv3 = document.createElement('canvas'); cv3.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none';
      stage.insertBefore(cv3, old.nextSibling);
      rd = new T.WebGLRenderer({ canvas: cv3, antialias: true, powerPreference: 'high-performance' });
      rd.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      sc = new T.Scene(); cam = new T.PerspectiveCamera(FOV, 1, 0.5, 400);
      amb = new T.AmbientLight(0x8890c8, 0.5); moon = new T.DirectionalLight(0x9fb4ff, 0.3); moon.position.set(-30, 60, 25); sc.add(amb, moon);
      GT = glowTex();
      const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(PP, 3).setUsage(T.DynamicDrawUsage)); pg.setAttribute('color', new T.BufferAttribute(PC, 3).setUsage(T.DynamicDrawUsage));
      pts = new T.Points(pg, new T.PointsMaterial({ size: 0.7, map: GT, vertexColors: true, sizeAttenuation: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      pts.frustumCulled = false; sc.add(pts);
      for (let i = 0; i < 28; i++) { const b = M(UT, bas(0xffffff, add), 1, 1, 1); b.visible = false; sc.add(b); beams.push(b); }
      for (let i = 0; i < 12; i++) { const r = M(UR, bas(0xffffff, Object.assign({ side: T.DoubleSide }, add)), 1, 1, 1); r.rotation.x = -Math.PI / 2; r.visible = false; sc.add(r); rings.push(r); }
      for (let i = 0; i < 18; i++) { const s = sprite(); s.visible = false; sc.add(s); texts.push(s); }
      ov = document.createElement('div'); ov.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
      ov.innerHTML = '<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 48%,rgba(0,0,0,.62) 100%)"></div>' +
        '<div class="r3" style="position:absolute;inset:0;background:#be0a19;opacity:0"></div><div class="l3" style="position:absolute;inset:0;background:#d2e1ff;opacity:0"></div>' +
        '<div class="p3" style="position:absolute;top:8px;left:0;right:0;text-align:center;font-weight:700;font-size:16px;color:#fff;text-shadow:0 1px 5px #000"></div>';
      stage.appendChild(ov); const rot = stage.querySelector('.rot'); if (rot) stage.appendChild(rot);
      R3D.r3 = ov.querySelector('.r3'); R3D.l3 = ov.querySelector('.l3'); R3D.p3 = ov.querySelector('.p3');
      return true;
    } catch (e) { console.warn('3D init failed, using 2D', e); return false; }
  }

  /* ---- static scene per map */
  function floorMat(th, w, h, tile) {
    const c = document.createElement('canvas'); c.width = c.height = 2; const x = c.getContext('2d');
    x.fillStyle = th.floor; x.fillRect(0, 0, 1, 1); x.fillRect(1, 1, 1, 1); x.fillStyle = th.floor2; x.fillRect(1, 0, 1, 1); x.fillRect(0, 1, 1, 1);
    const t = new T.CanvasTexture(c); t.magFilter = t.minFilter = T.NearestFilter; t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(w / (tile * 2), h / (tile * 2));
    const m = lam(0xffffff, { map: t }); m.color.setScalar(1.55); return m;
  }
  function plane(w, h, mat, x, y, z, seg) {
    const m = new T.Mesh(new T.PlaneGeometry(w, h, Math.max(1, Math.ceil(w / seg)), Math.max(1, Math.ceil(h / seg))), mat); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); return m;
  }
  function glow(color, size, x, z) { const m = M(UD, bas(color, Object.assign({ map: GT, opacity: 0.5 }, add)), size, size, size, x, 0.06, z); m.rotation.x = -Math.PI / 2; return m; }
  function wall(x1, y1, x2, y2, mat) {
    const t = 7, hz = y1 === y2, w = hz ? Math.abs(x2 - x1) + t : t, d = hz ? t : Math.abs(y2 - y1);
    return M(UB, mat, w * K, 2.4, d * K, wx((x1 + x2) / 2), 1.2, wz((y1 + y2) / 2));
  }
  function build(g, th) {
    if (root) sc.remove(root);
    root = new T.Group(); sc.add(root); rooms = []; lamps = [];
    sc.background = new T.Color(th.bg); sc.fog = new T.Fog(th.bg, 110, 280);
    root.add(plane(W * K + 20, H * K + 20, lam(th.bg), 0, -0.05, 0, 40));
    root.add(plane(W * K, 16, floorMat(th, W, 160, 40), 0, 0.01, wz(CYv()), 1.3));
    const carpet = plane(W * K, 0.8, lam(0x8a2f3a, { transparent: true, opacity: 0.35 }), 0, 0.03, wz(CYv()), 4); root.add(carpet);
    for (const fx of [0.25, 0.75]) { const l = new T.PointLight(col(th.lamp), 0.9, 30, 1.5); l.position.set(wx(W * fx), 4.5, wz(CYv())); root.add(l); lamps.push({ l, base: 0.9, corr: true }); root.add(glow(col(th.lamp), 14, wx(W * fx), wz(CYv()))); }
    const wallMat = lam(new T.Color(th.floor).multiplyScalar(1.9));
    for (const r of g.rooms) rooms.push(buildRoom(r, th, wallMat));
  }
  const col = (c) => new T.Color(c);
  function CYv() { return S.CY; }
  function buildRoom(r, th, wallMat) {
    const o = { r }, grp = new T.Group(); root.add(grp); o.grp = grp;
    const cx = wx(r.x + r.w / 2), cz = wz(r.y + r.h / 2), d = r.door, top = Math.abs(d.y - r.y) < Math.abs(d.y - (r.y + r.h)); o.top = top; o.sgn = top ? -1 : 1;
    o.fm = floorMat(th, r.w, r.h, 30); grp.add(plane(r.w * K, r.h * K, o.fm, cx, 0.02, cz, 1.2));
    const rug = plane(11.6, 7, lam(col(th.accent).multiplyScalar(0.35), { transparent: true, opacity: 0.4 }), wx(r.cx), 0.05, wz(top ? r.y + r.h - 76 : r.y + 76), 6); grp.add(rug);
    const ey = top ? r.y + r.h : r.y, dy = top ? r.y : r.y + r.h; // back edge / door edge
    grp.add(wall(r.x, ey, r.x + r.w, ey, wallMat), wall(r.x, r.y, r.x, r.y + r.h, wallMat), wall(r.x + r.w, r.y, r.x + r.w, r.y + r.h, wallMat));
    grp.add(wall(r.x, dy, d.x - 32, dy, wallMat), wall(d.x + 32, dy, r.x + r.w, dy, wallMat));
    // lamp + light
    const lampM = bas(col(th.lamp)); const lz = wz(top ? r.y + r.h - 6 : r.y + 6); grp.add(M(UB, lampM, 4.4, 0.3, 0.3, wx(r.cx), 2.0, lz));
    o.pl = new T.PointLight(col(th.lamp), 1.2, 26, 1.5); o.pl.position.set(wx(r.cx), 4.2, cz); grp.add(o.pl);
    o.gl = glow(col(th.lamp), 15, wx(r.cx), cz); grp.add(o.gl);
    // gold trim for own room
    o.trim = new T.Group(); const tm = bas(0xffcf5a, { transparent: true, opacity: 0.9 });
    o.trim.add(M(UB, tm, r.w * K - 1.4, 0.06, 0.18, cx, 0.08, wz(r.y + 6)), M(UB, tm, r.w * K - 1.4, 0.06, 0.18, cx, 0.08, wz(r.y + r.h - 6)), M(UB, tm, 0.18, 0.06, r.h * K - 1.2, wx(r.x + 6), 0.08, cz), M(UB, tm, 0.18, 0.06, r.h * K - 1.2, wx(r.x + r.w - 6), 0.08, cz));
    o.trim.visible = false; grp.add(o.trim);
    // pick-phase highlight
    o.pick = plane(r.w * K - 2, r.h * K - 2, bas(0x7ee8ff, { transparent: true, opacity: 0.2, depthWrite: false }), cx, 0.09, cz, 100); o.pick.visible = false; grp.add(o.pick);
    // bed
    const b = r.bed, s = top ? -1 : 1, bg = new T.Group(); bg.position.set(wx(b.x), 0, wz(b.y)); o.bed = bg; o.bs = s;
    o.mat = lam(col(th.bed)); o.blk = lam(col(th.bed).multiplyScalar(1.3)); o.skin = lam(0xf2d2b8); o.body = lam(0x4466aa);
    bg.add(M(UB, lam(0x5a4636), 7.6, 0.5, 5.2, 0, 0.25, 0), M(UB, o.mat, 7, 0.5, 4.6, 0, 0.62, 0), M(UB, lam(0xeef0f6), 4.4, 0.35, 1.7, 0, 1.0, s * 1.4), M(UB, o.blk, 7, 0.62, 2.7, 0, 0.9, -s * 0.9), M(UB, lam(0x4a3a2e), 7.8, 1.7, 0.4, 0, 0.85, s * 2.7));
    o.hump = M(UB, o.body, 3.6, 0.5, 2.2, 0, 1.2, -s * 0.2); o.head = M(US, o.skin, 0.85, 0.85, 0.85, 0, 1.5, s * 1.4); bg.add(o.hump, o.head);
    o.pips = []; for (let i = 0; i < 8; i++) { const p = M(UB, bas(0xffcf5a), 0.5, 0.3, 0.3, -3.4 + i * 0.7, 0.9, -s * 2.8); p.visible = false; bg.add(p); o.pips.push(p); } grp.add(bg);
    // door
    const dg = new T.Group(); dg.position.set(wx(d.x), 0, wz(d.y)); o.door = dg; o.dm = lam(col(th.door)); o.dbase = col(th.door);
    o.panel = M(UB, o.dm, 6, 2.3, 1, 0, 1.15, 0); o.knob = M(US, bas(0xffd36a), 0.2, 0.2, 0.2, 2.2, 1.1, 0.55 * 1.0); o.pl1 = M(UB, lam(0x6b4526), 2.6, 0.5, 0.5, -1.4, 0.3, 0); o.pl2 = M(UB, lam(0x6b4526), 2.4, 0.5, 0.5, 1.2, 0.3, 0.3);
    o.pl1.rotation.y = 0.6; o.pl2.rotation.y = -0.5; o.pl1.visible = o.pl2.visible = false; dg.add(o.panel, o.knob, o.pl1, o.pl2);
    o.dbar = bar(5.6); o.dbar.position.set(0, 3.3, o.sgn * 1.6); o.dlv = sprite(); o.dlv.position.set(3.9, 3.3, o.sgn * 1.6); dg.add(o.dbar, o.dlv); grp.add(dg);
    // name tag + state label
    o.tag = sprite(); o.tag.position.set(cx, 3.2, wz(ey + (top ? -22 : 22))); grp.add(o.tag);
    o.mid = sprite(); o.mid.position.set(cx, 1.2, cz); grp.add(o.mid);
    // turret slots
    o.slots = r.slots.map((sl) => {
      const q = { grp: new T.Group(), k: null }; q.grp.position.set(wx(sl.x), 0, wz(sl.y));
      q.pad = M(UR, bas(0xffffff, { transparent: true, opacity: 0.5, side: T.DoubleSide }), 1.3, 1.3, 1.3, 0, 0.1, 0); q.pad.rotation.x = -Math.PI / 2;
      q.plus = sprite(); setLabel(q.plus, '+', '#ffffffcc', 20, 1.4); q.plus.position.y = 0.9;
      q.blob = blob(1.5); q.pips = []; for (let i = 0; i < 6; i++) { const p = M(UB, bas(0xffcf5a), 0.5, 0.3, 0.3, 0, 0.3, 2.3); p.visible = false; q.grp.add(p); q.pips.push(p); }
      q.grp.add(q.pad, q.plus, q.blob); grp.add(q.grp); return q;
    });
    return o;
  }
  function mkTurret(k, def) {
    const g = new T.Group(), big = k === 'cannon', c = col(def.color), t = { g };
    if (k === 'frost') {
      g.add(M(UB, lam(0x3c4a73), 1.7, 1.4, 1.7, 0, 0.7, 0)); t.cr = M(UO, lam(0xcfe0ff, { emissive: 0x6f9bff }), 1.0, 1.6, 1.0, 0, 2.4, 0); g.add(t.cr);
      t.gl = M(UD, bas(0xa7c8ff, Object.assign({ map: GT, opacity: 0.5 }, add)), 5, 5, 5, 0, 0.12, 0); t.gl.rotation.x = -Math.PI / 2; g.add(t.gl);
      t.ring = M(UR, bas(0xa7c8ff, Object.assign({ side: T.DoubleSide }, add)), 1, 1, 1, 0, 0.14, 0); t.ring.rotation.x = -Math.PI / 2; t.ring.visible = false; g.add(t.ring);
    } else {
      const r = big ? 1.5 : 1.15; g.add(M(UC, lam(big ? 0x4a3a2a : 0x2e3b4a), r, 1.0, r, 0, 0.5, 0));
      t.bar = new T.Group(); t.bar.position.y = 1.4; const bm = lam(big ? 0xff9f3a : 0x5ee0ff, { emissive: big ? 0x7a4a10 : 0x1a6a80 });
      t.b0 = M(UB, bm, big ? 2.4 : 1.8, big ? 1.0 : 0.6, big ? 1.0 : 0.6, 1.3, 0, 0); t.bar.add(t.b0, M(UB, bas(0xffffff), 0.3, 0.3, 0.3, big ? 2.6 : 2.1, 0, 0)); g.add(t.bar);
      g.add(M(US, lam(c, { emissive: c.clone().multiplyScalar(0.5) }), 0.5, 0.5, 0.5, 0, 1.45, 0));
    }
    return t;
  }

  /* ---- ghosts */
  function mkGhost(kind) {
    const root = new T.Group(), body = new T.Group(), mats = [], t = { root, body, mats, kind };
    const L = (c, e) => { const m = lam(c, { emissive: e || 0x000000 }); m.userData.e = e || 0; mats.push(m); return m; };
    if (kind === 'wail') {
      body.add(M(new T.CylinderGeometry(0.8, 1.7, 1, 14), L(0xe7eaf3, 0x4a4f5c), 0.95, 3.0, 0.85, 0, 1.5, 0));
      body.add(M(US, L(0x0b0b10), 1.55, 1.8, 1.3, 0, 3.4, -0.2), M(US, L(0xdfe1ea, 0x303540), 0.95, 1.05, 0.9, 0, 3.3, 0.6));
      body.add(M(US, bas(0xff2b3d), 0.17, 0.17, 0.17, -0.38, 3.4, 1.45), M(US, bas(0xff2b3d), 0.17, 0.17, 0.17, 0.38, 3.4, 1.45));
      t.aL = new T.Group(); t.aR = new T.Group(); t.aL.position.set(-1.05, 2.4, 0); t.aR.position.set(1.05, 2.4, 0);
      t.aL.add(M(UB, L(0xe7eaf3, 0x4a4f5c), 0.5, 2, 0.5, 0, -1, 0)); t.aR.add(M(UB, L(0xe7eaf3, 0x4a4f5c), 0.5, 2, 0.5, 0, -1, 0)); body.add(t.aL, t.aR); t.fy = 1;
    } else if (kind === 'shade') {
      body.add(M(US, L(0x3a2466, 0x2a1850), 1.7, 1.7, 1.7, 0, 0, 0), M(US, L(0x1b0f36, 0x120a24), 1.3, 1.3, 1.3, 0, 0, 0.4));
      body.add(M(US, bas(0xffffff), 0.35, 0.6, 0.25, -0.55, 0.3, 1.45), M(US, bas(0xffffff), 0.35, 0.6, 0.25, 0.55, 0.3, 1.45));
      t.tr = []; for (let i = 1; i <= 4; i++) { const m = M(US, lam(0x46286e, { transparent: true, opacity: 0.6 - i * 0.1, emissive: 0x20103a }), 1.5 - i * 0.22, 1.5 - i * 0.22, 1.5 - i * 0.22, -i * 1.0, 0, -0.3); body.add(m); t.tr.push(m); }
      t.fy = 2.3;
    } else {
      const g = L(0x566251, 0x10140e), dk = L(0x3c463a);
      body.add(M(UB, g, 2.8, 3.2, 1.8, 0, 2.7, 0), M(UB, dk, 2.2, 0.3, 1.9, 0, 2.5, 0), M(US, g, 1.3, 1.3, 1.2, 0, 5.0, 0), M(UB, dk, 0.9, 1.6, 0.9, -0.8, 0.8, 0), M(UB, dk, 0.9, 1.6, 0.9, 0.8, 0.8, 0));
      body.add(M(UK, L(0xd9d2c0), 0.35, 1.2, 0.35, -0.95, 6.1, 0), M(UK, L(0xd9d2c0), 0.35, 1.2, 0.35, 0.95, 6.1, 0), M(UB, bas(0xffd23a), 0.5, 0.22, 0.2, -0.5, 5.15, 1.15), M(UB, bas(0xffd23a), 0.5, 0.22, 0.2, 0.5, 5.15, 1.15));
      t.aL = new T.Group(); t.aR = new T.Group(); t.aL.position.set(-1.9, 4.0, 0); t.aR.position.set(1.9, 4.0, 0);
      t.aL.add(M(UB, dk, 0.9, 2.6, 0.9, 0, -1.2, 0)); t.aR.add(M(UB, dk, 0.9, 2.6, 0.9, 0, -1.2, 0)); body.add(t.aL, t.aR); t.fy = 0; body.scale.setScalar(1.15);
    }
    t.bs = body.scale.x; root.add(body, blob(kind === 'brute' ? 2.2 : 1.6));
    t.hp = bar(kind === 'brute' ? 4.4 : 3.4); t.hp.position.y = kind === 'brute' ? 8.1 : 5.6; t.lv = sprite(); t.lv.position.y = t.hp.position.y + 0.9;
    t.slow = M(UR, bas(0xa7c8ff, { side: T.DoubleSide }), 2.2, 2.2, 2.2, 0, 0.12, 0); t.slow.rotation.x = -Math.PI / 2; t.slow.visible = false;
    root.add(t.hp, t.lv, t.slow); return t;
  }
  function ghostObj(gh) {
    let o = ghosts.get(gh.id);
    if (o && o.kind !== gh.kind) { sc.remove(o.root); (free[o.kind] = free[o.kind] || []).push(o); ghosts.delete(gh.id); o = null; } // id reused by a new game
    if (!o) { const f = free[gh.kind]; o = f && f.length ? f.pop() : mkGhost(gh.kind); o.root.visible = true; sc.add(o.root); ghosts.set(gh.id, o); }
    return o;
  }

  /* ---- camera fit */
  function fit() {
    const w = stage.clientWidth || 1, h = stage.clientHeight || 1, k = w + 'x' + h; if (k === dim) return; dim = k;
    rd.setSize(w, h, false); cam.aspect = w / h;
    const th = Math.tan(FOV * Math.PI / 360), dw = (W * K * 1.07) / (2 * th * cam.aspect), dh = (H * K * Math.sin(EL) + 4 * Math.cos(EL)) * 1.08 / (2 * th), D = Math.max(dw, dh);
    cam.userData = { D }; cam.updateProjectionMatrix();
  }

  /* ---- per-frame */
  R3D.render = function (g, c) {
    const st = c.st, fx = c.fx, gv = c.gv; S = c.S; W = S.W; H = S.H;
    if (R3D.failed) return false;
    if (!rd && !(R3D.ok = init())) { R3D.failed = true; return false; }
    const th = S.MAPS[g.map].theme, bk = g.map + ':' + g.rooms.length;
    if (bk !== built) { built = bk; build(g, th); }
    fit(); const D = cam.userData.D, sh = fx.shake ? fx.shake * 0.012 : 0;
    cam.position.set((Math.random() - 0.5) * sh, D * Math.sin(EL) + (Math.random() - 0.5) * sh, D * Math.cos(EL) + 0.4); cam.lookAt(0, 0.2, 0.3);
    const ln = fx.lightning || 0; amb.intensity = 0.55 + ln * 1.3; moon.intensity = 0.3 + ln * 1.6;
    for (const l of lamps) l.l.intensity = l.base * (0.9 + 0.1 * Math.sin(fx.t * 3 + l.l.position.x));
    const mine = (r) => r.owner === st.myId;
    for (let i = 0; i < g.rooms.length; i++) {
      const r = g.rooms[i], o = rooms[i]; if (!o) continue;
      const owner = g.players.find((p) => p.id === r.owner), my = mine(r), on = g.phase === 'pick' || (r.owner !== null && !r.ruined), fl = 0.9 + 0.1 * Math.sin(fx.t * 5 + r.id);
      o.pl.intensity = (on ? 1.35 : 0.32) * fl; o.gl.material.opacity = (on ? 0.5 : 0.12) * fl;
      o.fm.color.setScalar(r.ruined ? 1.0 : 1.55); if (r.ruined) o.fm.color.setRGB(1.6, 0.8, 0.8);
      o.trim.visible = my; o.pick.visible = g.phase === 'pick' && !owner; if (o.pick.visible) o.pick.material.opacity = 0.12 + 0.12 * Math.sin(fx.t * 5);
      o.mat.color.set(r.ruined ? 0x5b2a30 : th.bed); o.blk.color.set(r.ruined ? 0x722a33 : th.bed).multiplyScalar(r.ruined ? 1 : 1.3); o.bed.rotation.z = r.ruined ? 0.05 : 0;
      const alive = !!(owner && owner.alive); o.head.visible = o.hump.visible = alive;
      if (alive) { o.body.color.set(c.avColor(owner.id)); const br = 1 + Math.sin(fx.t * 2 + r.id) * 0.04; o.hump.scale.y = 0.5 * br; o.head.position.y = 1.5 + (br - 1) * 3; }
      for (let j = 0; j < 8; j++) o.pips[j].visible = r.owner !== null && !r.ruined && j < r.bed.lv;
      // door
      const d = r.door, f = d.hp / d.max, brk = d.hp <= 0;
      o.panel.visible = o.knob.visible = !brk; o.pl1.visible = o.pl2.visible = brk;
      o.dm.color.copy(o.dbase).lerp(tc.set(0xaa1822), Math.max(0, 1 - f) * 0.55); o.panel.position.x = fx.shake > 8 ? (Math.random() - 0.5) * 0.15 : 0;
      const showBar = r.owner !== null && !r.ruined; o.dbar.visible = showBar; o.dlv.visible = showBar; if (showBar) { setBar(o.dbar, f); setLabel(o.dlv, 'Lv' + d.lv, '#ffe9b0', 13, 0.9); }
      // tag / middle label
      const pk = g.phase === 'pick' && !owner; o.tag.visible = !pk; o.mid.visible = pk;
      if (owner) setLabel(o.tag, (owner.alive ? '' : '💀 ') + owner.name, my ? '#ffcf5a' : '#dfe3ef', 15, 1.4);
      else if (pk) setLabel(o.mid, 'ห้องว่าง · แตะเพื่อเลือก', '#7ee8ff', 20, 1.6 + 0.12 * Math.sin(fx.t * 5));
      else setLabel(o.tag, 'ห้องว่าง', '#8a8a96', 12, 1.1);
      // turrets
      for (let j = 0; j < r.slots.length; j++) {
        const s = r.slots[j], q = o.slots[j], sel = my && st.selSlot === j;
        if (q.k !== (s.k || null)) { if (q.t) q.grp.remove(q.t.g); q.k = s.k || null; q.t = s.k ? mkTurret(s.k, S.TURRETS[s.k]) : null; if (q.t) q.grp.add(q.t.g); }
        const empty = !s.k, showPad = (empty && my && g.phase === 'play') || sel; q.pad.visible = showPad; q.plus.visible = empty && my && g.phase === 'play';
        q.pad.material.color.set(sel ? 0x7ee8ff : 0xffffff); q.blob.visible = !empty;
        for (let p = 0; p < 6; p++) q.pips[p].visible = !empty && p < s.lv, q.pips[p].position.x = (p - (s.lv - 1) / 2) * 0.7;
        if (q.t) {
          const t = q.t;
          if (t.bar) { const key = Math.round(s.x) + '_' + Math.round(s.y), a = fx.ang[key] !== undefined ? fx.ang[key] : (s.y > S.CY ? -Math.PI / 2 : Math.PI / 2); t.bar.rotation.y = -a; t.b0.position.x = (t.b0.scale.x / 2 + 0.4) + (s.rec > 0 ? -0.5 * (s.rec / 0.15) : 0); }
          else { const pu = 0.5 + 0.5 * Math.sin(fx.t * 4 + s.x); t.cr.rotation.y = fx.t * 1.2; t.cr.position.y = 2.4 + Math.sin(fx.t * 2 + s.x) * 0.15; t.gl.material.opacity = 0.3 + pu * 0.3; t.ring.visible = s.rec > 0; if (s.rec > 0) { const z = (22 + (0.15 - s.rec) * 120) * K; t.ring.scale.set(z, z, z); } }
        }
      }
    }
    // ghosts
    const seen = new Set();
    for (const gh of g.ghosts) {
      seen.add(gh.id); const o = ghostObj(gh), v = gv.get(gh.id) || gh, tt = fx.t * 4 + gh.id * 1.7, flash = gh.hf > 0;
      o.root.position.set(wx(v.x), 0, wz(v.y));
      o.body.position.y = (gh.kind === 'brute' ? 0 : o.fy + 0.3 + Math.sin(tt) * 0.35); o.body.scale.x = (gh.face || 1) * o.bs; o.body.rotation.y = 0.35 * (gh.face || 1);
      for (const m of o.mats) m.emissive.setHex(flash ? 0xffffff : m.userData.e);
      if (o.aL) { const sw = gh.state === 'attack' ? Math.sin(fx.t * (gh.kind === 'brute' ? 9 : 14)) * 0.9 : Math.sin(tt * 0.8) * 0.25; o.aL.rotation.z = -0.35 + sw * 0.6; o.aR.rotation.z = 0.35 - sw * 0.6; o.aL.rotation.x = sw * 0.5; o.aR.rotation.x = -sw * 0.5; }
      if (o.tr) o.tr.forEach((m, i) => { m.position.y = Math.sin(tt - i) * 0.35; });
      setBar(o.hp, gh.hp / gh.max); setLabel(o.lv, 'Lv' + gh.lv, '#ffd1d6', 12, 0.85); o.slow.visible = gh.slow > 0;
    }
    for (const [id, o] of ghosts) if (!seen.has(id)) { sc.remove(o.root); (free[o.kind] = free[o.kind] || []).push(o); ghosts.delete(id); }
    // beams (+ claw slashes)
    let bi = 0;
    const beam = (x1, y1, x2, y2, h, color, w, a) => {
      if (bi >= beams.length) return; const m = beams[bi++], A = new T.Vector3(wx(x1), h, wz(y1)), B = new T.Vector3(wx(x2), h, wz(y2)), dv = B.clone().sub(A), len = dv.length() || 0.01;
      m.visible = true; m.position.copy(A).add(B).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dv.normalize()); m.scale.set(w, len, w); m.material.color.set(color); m.material.opacity = a;
    };
    for (const b of fx.beams) beam(b.x1, b.y1, b.x2, b.y2, 2.0, b.color, b.w * 0.06, b.life / b.max);
    // particles
    let n = 0, ri = 0, ti = 0;
    for (const p of fx.parts) {
      const a = Math.max(0, p.life / p.max);
      if (p.type === 'text') { if (ti < texts.length) { const s = texts[ti++]; s.visible = true; s.position.set(wx(p.x), 3.6 + (1 - a) * 2, wz(p.y)); setLabel(s, String(p.text), p.color, 16, 1.2 * (p.size / 14)); s.material.opacity = Math.min(1, a * 1.6); } }
      else if (p.type === 'ring') { if (ri < rings.length) { const m = rings[ri++], z = (p.size + (1 - a) * 34) * K; m.visible = true; m.position.set(wx(p.x), 0.2, wz(p.y)); m.scale.set(z, z, z); m.material.color.set(p.color); m.material.opacity = a; } }
      else if (p.type === 'claw') beam(p.x - 6, p.y - 22 + (1 - a) * 8, p.x + 6, p.y + 14 + (1 - a) * 8, 2.2, p.color, 0.07, a);
      else if (n < PN) { const cc = rgb(p.color); PP[n * 3] = wx(p.x); PP[n * 3 + 1] = 1.2 + (1 - a) * 1.2; PP[n * 3 + 2] = wz(p.y); PC[n * 3] = cc[0] * a; PC[n * 3 + 1] = cc[1] * a; PC[n * 3 + 2] = cc[2] * a; n++; }
    }
    for (; bi < beams.length; bi++) beams[bi].visible = false;
    for (; ri < rings.length; ri++) rings[ri].visible = false;
    for (; ti < texts.length; ti++) texts[ti].visible = false;
    pts.geometry.setDrawRange(0, n); pts.geometry.attributes.position.needsUpdate = true; pts.geometry.attributes.color.needsUpdate = true;
    R3D.r3.style.opacity = fx.red > 0 ? Math.min(0.55, fx.red * 0.8) : 0; R3D.l3.style.opacity = fx.lightning > 0.55 ? (fx.lightning - 0.55) * 0.5 : 0;
    R3D.p3.textContent = g.phase === 'pick' ? 'เลือกห้องนอน · ' + Math.ceil(g.pickT) + ' วิ' : '';
    rd.render(sc, cam); return true;
  };

  /* screen -> sim coordinates (ray vs. plane at turret height) */
  R3D.pick = function (cx, cy) {
    if (!rd) return null; const r = cv3.getBoundingClientRect();
    ray.setFromCamera(new T.Vector2((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), cam);
    const o = ray.ray.origin, d = ray.ray.direction, t = (1.2 - o.y) / d.y; if (!(t > 0)) return null;
    return { x: (o.x + d.x * t) / K + W / 2, y: (o.z + d.z * t) / K + H / 2 };
  };
})();
