/* ============================================================
 * app.js — 게임 클라이언트 (프론트엔드 소유)
 *
 * 책임: 서버(WS) 연결 · 입력 송신 · 좌표/반지름/상태 수신 · 카메라/보간 ·
 *       HUD/리더보드/미니맵/부스트 갱신. '어떻게 그리는가'(세포 아트/색)는
 *       window.CellArt 가 소유 — 있으면 그걸로, 없으면 단순 원 폴백.
 *
 * ── 렌더 훅 계약 (window.CellArt, 게임 비주얼 디자이너 소유) ──
 *   app.js 가 카메라 변환(translate+scale)을 ctx 에 적용한 뒤, 각 엔티티를
 *   '월드 좌표 그대로' 넘겨 호출한다. CellArt 는 월드 공간에서 그리면 된다.
 *     CellArt.drawCell(ctx, cell, view)   // cell = 셀 스키마(아래)
 *     CellArt.drawFood(ctx, food, view)   // 선택
 *     CellArt.drawVirus(ctx, virus, view) // 선택
 *     CellArt.drawEject(ctx, e, view)     // 선택
 *     CellArt.drawShot(ctx, s, view)      // 선택
 *   view = { scale, camX, camY, time, world }
 *
 * ── 셀 스키마 (서버 권위, getSnapshot) ──
 *   cell  : { id, x, y, r, mass, color, type:'player'|'bot', owner, name, event }
 *   virus : { id, x, y, r, mass, color, type:'virus', owner:'', charge, event }
 *   food  : { id, x, y, r, color, type:'food' }
 *   eject : { id, x, y, r, color, type:'eject', owner }
 *   shot  : { id, x, y, r, color, type:'virusShot' }
 *   event : 'split'|'eat'|'pop'|'eject'|'merge'|'fire'|null  (이번 틱 1회성 VFX)
 * ============================================================ */
import { ART } from './tokens.js';

/* ---------- VFX 폴백 스텁 ----------
 * vfx.js(window.VFX)는 app.js 보다 먼저 로드된다(index.html). 다만 모듈이
 * 빠지거나 로드 실패해도 연동 3지점(emit/update/draw)을 가드 없이 호출할 수
 * 있도록 no-op 스텁을 깐다 → vfx.js 부재 시에도 콘솔에러 0 으로 동일 구동.
 * (모듈이 있으면 || 단락으로 실제 VFX 가 그대로 유지됨) */
window.VFX = window.VFX || { emit() {}, update() {}, draw() {}, stats() { return {}; } };
const VFX = window.VFX;
// 서버는 일회성 event 를 틱마다 비우므로(seq 미제공) 도착마다 고유 seq 를 부여 —
// 같은 셀이 연속(예: eat)으로 점화돼도 dedup 창에 묻히지 않게 한다.
let vfxSeq = 0;

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const canvas = $('#game');
const ctx = canvas.getContext('2d');
const mini = $('#minimap-canvas');
const mctx = mini.getContext('2d');

const el = {
  screenStart: $('#screen-start'), nick: $('#start-nick'), play: $('#start-play'), startErr: $('#start-error'),
  screenDead: $('#screen-dead'), deadMass: $('#dead-mass'), deadRank: $('#dead-rank'), deadTime: $('#dead-time'), respawn: $('#dead-respawn'),
  hudMass: $('#hud-mass'), hudRank: $('#hud-rank'), hudCells: $('#hud-cells'),
  skillBoost: $('#skill-boost'), skillCd: $('#skill-boost-cd'),
  lbList: $('#lb-list'), netStatus: $('#net-status'), hud: $('#hud'),
};

/* ---------- 상태 ---------- */
let ws = null, myId = null, joined = false, wasAlive = false;
let worldSize = { w: 6000, h: 6000 };
let camera = { x: 3000, y: 3000, view: 1000 };
let latest = null;          // 최신 스냅샷
let spawnTime = 0, bestRank = 99;
const mouse = { x: 0, y: 0 };   // 화면 좌표
let dpr = Math.min(window.devicePixelRatio || 1, 2);

// 보간용 렌더 엔티티 스토어 (id -> {x,y,r,...})
const store = { cells: new Map(), food: new Map(), eject: new Map(), virus: new Map(), shot: new Map() };

/* ---------- 캔버스 리사이즈 ---------- */
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  const ms = getComputedStyle(document.documentElement).getPropertyValue('--ui-minimap-size');
  const size = parseInt(ms) || 200;
  mini.width = Math.floor(size * dpr); mini.height = Math.floor(size * dpr);
  mini.style.width = size + 'px'; mini.style.height = size + 'px';
}
addEventListener('resize', resize); resize();

/* ---------- WebSocket ---------- */
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}
let netTries = 0;
function showNet(msg) { el.netStatus.textContent = msg; el.netStatus.classList.remove('is-hidden'); }
function hideNet() { el.netStatus.classList.add('is-hidden'); }
function connect() {
  let opened = false;
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    // 생성 자체가 throw(예: 잘못된 URL) → 빈 화면 대신 명확한 안내
    showNet('연결을 시작할 수 없습니다 — 새로고침 해주세요');
    return;
  }
  ws.onopen = () => {
    opened = true; netTries = 0;
    hideNet();
    if (joined) sendJoin(currentName);   // 재접속 시 자동 재참가
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'welcome') { myId = m.id; worldSize = m.world; }
    else if (m.t === 'state') onState(m);
    else if (m.t === 'pong') { /* RTT 측정 훅 */ }
  };
  ws.onclose = () => {
    if (!joined) return;
    netTries++;
    // 한 번도 못 열렸으면 '서버 미기동', 열렸다 끊겼으면 '재접속'으로 구분 안내
    showNet(opened
      ? '서버 연결이 끊겼습니다 — 재접속 중…'
      : '서버에 연결할 수 없습니다 — node server.js 실행 후 새로고침');
    setTimeout(connect, Math.min(4000, 600 * netTries)); // 지수형 백오프(상한 4s)
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function sendJoin(name) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'join', name }));
}
function sendInput() {
  if (!ws || ws.readyState !== 1 || !joined) return;
  const dx = mouse.x - innerWidth / 2;
  const dy = mouse.y - innerHeight / 2;
  ws.send(JSON.stringify({ t: 'input', dx, dy }));
}

/* ---------- 스냅샷 수신 ---------- */
function onState(m) {
  latest = m;
  camera.view = m.camera.view;
  // 카메라 타깃 갱신 (렌더 루프에서 부드럽게 추적)
  camTarget.x = m.camera.x; camTarget.y = m.camera.y;

  syncStore(store.cells, m.cells);
  syncStore(store.food, m.food);
  syncStore(store.eject, m.eject);
  syncStore(store.virus, m.viruses);
  syncStore(store.shot, m.shots);

  if (m.you) {
    if (m.you.alive && !wasAlive) { wasAlive = true; spawnTime = performance.now(); bestRank = 99; }
    if (m.you.rank) bestRank = Math.min(bestRank, m.you.rank);
    updateHud(m.you);
    // 사망 감지
    if (!m.you.alive && wasAlive) onDead(m.you);
  }
  updateLeaderboard(m.leaderboard);
}

function syncStore(map, arr) {
  const seen = new Set();
  for (const o of arr) {
    seen.add(o.id);
    const cur = map.get(o.id);
    if (cur) { cur.tx = o.x; cur.ty = o.y; cur.tr = o.r; cur.data = o; }
    else map.set(o.id, { x: o.x, y: o.y, r: o.r, tx: o.x, ty: o.y, tr: o.r, data: o });
    // 일회성 이벤트 점화: 도착한 그 순간 1회 emit(스칼라만 전달). 보간 전
    // 권위 좌표(o.x/y/r)에서 터뜨려 위치 어긋남을 막는다. VFX 가 (id|event|seq)
    // 로 dedup 하므로 중복 호출돼도 1회만 점화.
    if (o.event) VFX.emit({ id: o.id, x: o.x, y: o.y, r: o.r, color: o.color, event: o.event, seq: ++vfxSeq });
  }
  for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
}

/* ---------- HUD / 리더보드 ---------- */
function updateHud(you) {
  el.hudMass.textContent = you.mass;
  el.hudRank.textContent = (you.rank || '–') + ' / ' + (latest ? latest.leaderboard.length : '–');
  el.hudCells.textContent = you.cells;
  // 부스트 쿨다운 표시
  const ratio = you.boostCooldown ? you.boostReadyIn / you.boostCooldown : 0;
  el.skillCd.style.width = (ratio * 100).toFixed(0) + '%';
  el.skillBoost.classList.toggle('is-locked', you.boostReadyIn > 0.05);
  el.skillBoost.classList.toggle('is-warning', !!you.boostActive);
}
function updateLeaderboard(rows) {
  if (!rows) return;
  const html = rows.map(r =>
    `<li class="ui-lb__row${r.id === myId ? ' is-self' : ''}" data-rank="${r.rank}">` +
    `<span class="ui-lb__rank">${r.rank}</span>` +
    `<span class="ui-lb__name">${escapeHtml(r.name)}</span>` +
    `<span class="ui-lb__mass">${r.mass}</span></li>`
  ).join('');
  el.lbList.innerHTML = html;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- 사망 / 시작 ---------- */
function onDead(you) {
  wasAlive = false; joined = false;
  el.deadMass.textContent = you.mass;
  el.deadRank.textContent = bestRank < 99 ? '#' + bestRank : '–';
  el.deadTime.textContent = Math.round((performance.now() - spawnTime) / 1000) + 's';
  el.screenDead.classList.remove('is-hidden');
}
let currentName = '';
function startGame() {
  const name = (el.nick.value || '').trim();
  if (!name) { el.startErr.textContent = '닉네임을 입력하세요'; el.nick.classList.add('is-error'); el.nick.setAttribute('aria-invalid', 'true'); return; }
  el.startErr.textContent = ''; el.nick.classList.remove('is-error'); el.nick.removeAttribute('aria-invalid');
  currentName = name;
  joined = true; wasAlive = false;
  el.screenStart.classList.add('is-hidden');
  el.screenDead.classList.add('is-hidden');
  if (!ws || ws.readyState > 1) connect();
  sendJoin(name);
}
el.play.addEventListener('click', startGame);
el.nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });
el.respawn.addEventListener('click', () => { el.screenDead.classList.add('is-hidden'); el.screenStart.classList.remove('is-hidden'); el.nick.focus(); });

/* ---------- 입력 ---------- */
addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
addEventListener('touchmove', (e) => { if (e.touches[0]) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; } }, { passive: true });
addEventListener('keydown', (e) => {
  if (!joined) return;
  if (e.code === 'Space') { e.preventDefault(); send({ t: 'split' }); }
  else if (e.key === 'w' || e.key === 'W' || e.code === 'KeyW') { send({ t: 'eject' }); }
  else if (e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') { send({ t: 'boost' }); }
});
el.skillBoost.addEventListener('click', () => { if (joined) send({ t: 'boost' }); });
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
// 입력 송신 20Hz
setInterval(sendInput, 50);

/* ---------- 카메라/렌더 루프 (60fps, 보간) ---------- */
const camTarget = { x: 3000, y: 3000 };
let lastFrame = performance.now();

let drawErrCount = 0;          // 누적 draw 예외(진단용)
function frame(ts) {
  // 어떤 단계가 throw 해도 렌더 루프가 죽지 않게 전체를 보호하고, finally 에서
  // 반드시 다음 프레임을 예약한다(맵만 남고 정지하는 사태 방지 — goal ③).
  try {
    const fdt = Math.min(0.05, (ts - lastFrame) / 1000); lastFrame = ts;
    // 부드러운 추적/보간 (지수 감쇠)
    const ease = 1 - Math.exp(-12 * fdt);
    camera.x += (camTarget.x - camera.x) * ease;
    camera.y += (camTarget.y - camera.y) * ease;
    for (const map of [store.cells, store.food, store.eject, store.virus, store.shot]) {
      for (const o of map.values()) {
        o.x += (o.tx - o.x) * ease; o.y += (o.ty - o.y) * ease; o.r += (o.tr - o.r) * ease;
      }
    }
    // VFX 파티클 틱: 카메라/엔티티 보간과 같은 클램프된 fdt 로 적분 → 프레임율 독립.
    VFX.update(fdt);
    render(ts / 1000);
    renderMinimap();
  } catch (e) {
    if (drawErrCount++ < 3) console.error('[frame] render error (loop continues):', e);
  } finally {
    requestAnimationFrame(frame);
  }
}

// 단일 엔티티의 draw 가 throw 해도 같은 프레임의 나머지 엔티티/레이어는 계속
// 그린다 — 한 마리의 NaN/예외가 화면 전체를 비우지 못하게 한다(goal ②③).
function safeDraw(fn) {
  try { fn(); }
  catch (e) { if (drawErrCount++ < 3) console.error('[draw] entity skipped:', e); }
}

function render(time) {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 배경
  ctx.fillStyle = ART.bgDeep;
  ctx.fillRect(0, 0, W, H);

  const scale = (Math.min(W, H) / 2) / camera.view;
  const camX = camera.x, camY = camera.y;
  // 월드→스크린 변환 적용 (이후 모든 그리기는 월드 좌표)
  ctx.setTransform(scale * 1, 0, 0, scale, W / 2 - camX * scale, H / 2 - camY * scale);

  drawGrid(camX, camY, scale, W, H);
  drawWorldBorder();

  const view = { scale, camX, camY, time, world: worldSize };
  const CA = window.CellArt;

  // z-order: 배경(위) → 먹이 → 펠릿 → 바이러스 → 세포 → [VFX] → 분열탄 → (UI는 DOM)
  // 각 엔티티는 safeDraw 로 격리 — CellArt 가 한 마리에서 throw 해도 나머지는 계속 그린다.
  for (const o of store.food.values()) {
    safeDraw(() => { if (CA && CA.drawFood) CA.drawFood(ctx, o.data, view); else fallbackDot(o, o.data.color); });
  }
  for (const o of store.eject.values()) {
    safeDraw(() => { if (CA && CA.drawEject) CA.drawEject(ctx, o.data, view); else fallbackDot(o, o.data.color); });
  }
  for (const o of store.virus.values()) {
    safeDraw(() => { if (CA && CA.drawVirus) CA.drawVirus(ctx, withPos(o), view); else fallbackVirus(o); });
  }
  // 세포: 작은 것부터(큰 것이 위로)
  const cells = [...store.cells.values()].sort((a, b) => a.r - b.r);
  for (const o of cells) {
    const c = withPos(o);
    safeDraw(() => { if (CA && CA.drawCell) CA.drawCell(ctx, c, view); else fallbackCell(o, c); });
  }
  // 이펙트 레이어: 세포 위·분열탄/HUD 아래. 카메라 변환이 적용된 월드 좌표계에서
  // 그린다(emit 시 월드 좌표를 넘겼으므로 view 변환과 정합).
  safeDraw(() => VFX.draw(ctx, view));
  for (const o of store.shot.values()) {
    safeDraw(() => { if (CA && CA.drawShot) CA.drawShot(ctx, o.data, view); else fallbackDot(o, o.data.color || '#aaff5c'); });
  }
}

// 보간된 위치를 데이터에 병합해 CellArt에 넘김
function withPos(o) { return Object.assign({}, o.data, { x: o.x, y: o.y, r: o.r }); }

function drawGrid(camX, camY, scale, W, H) {
  const step = 64;
  const hw = (W / 2) / scale, hh = (H / 2) / scale;
  const x0 = Math.floor((camX - hw) / step) * step, x1 = camX + hw;
  const y0 = Math.floor((camY - hh) / step) * step, y1 = camY + hh;
  ctx.lineWidth = 1 / scale;
  for (let x = x0; x < x1; x += step) {
    ctx.strokeStyle = (x % (step * 4) === 0) ? ART.bgGridMajor : ART.bgGrid;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  }
  for (let y = y0; y < y1; y += step) {
    ctx.strokeStyle = (y % (step * 4) === 0) ? ART.bgGridMajor : ART.bgGrid;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }
}
function drawWorldBorder() {
  ctx.strokeStyle = ART.worldBorder; ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, worldSize.w, worldSize.h);
}

/* ---------- 폴백 렌더(CellArt 없을 때 단순 원) ---------- */
function fallbackDot(o, color) {
  ctx.fillStyle = color || '#888';
  ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill();
}
function fallbackCell(o, c) {
  ctx.fillStyle = c.color || ART.cellSelf;
  ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = ART.cellMembrane; ctx.lineWidth = Math.max(1, o.r * 0.06);
  ctx.stroke();
  if (c.name && o.r > 14) {
    ctx.fillStyle = '#fff'; ctx.font = `${Math.max(11, o.r * 0.35)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.name, o.x, o.y);
  }
}
function fallbackVirus(o) {
  ctx.fillStyle = ART.virusFill; ctx.strokeStyle = ART.virusSpike; ctx.lineWidth = 3;
  const spikes = 16, R = o.r;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (Math.PI * i) / spikes;
    const rr = i % 2 ? R : R * 0.82;
    const px = o.x + Math.cos(ang) * rr, py = o.y + Math.sin(ang) * rr;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

/* ---------- 미니맵 ---------- */
function renderMinimap() {
  const S = mini.width;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, S, S);
  mctx.fillStyle = 'rgba(7,18,26,0.6)'; mctx.fillRect(0, 0, S, S);
  if (!latest || !latest.blips) return;
  const sx = S / worldSize.w, sy = S / worldSize.h;
  for (const b of latest.blips) {
    const mine = b.owner === myId;
    mctx.fillStyle = mine ? ART.cellSelf : 'rgba(180,200,220,0.5)';
    const r = Math.max(1.5, b.r * sx * 1.5);
    mctx.beginPath(); mctx.arc(b.x * sx, b.y * sy, r, 0, Math.PI * 2); mctx.fill();
  }
  // 뷰포트 박스
  mctx.strokeStyle = 'rgba(45,226,192,0.7)'; mctx.lineWidth = 1.5;
  const vw = camera.view * 2 * sx;
  mctx.strokeRect(camera.x * sx - vw / 2, camera.y * sy - vw / 2, vw, vw);
}

requestAnimationFrame(frame);
el.nick && el.nick.focus();
