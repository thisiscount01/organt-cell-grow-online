/* verify-app-vfx.cjs — app.js ↔ vfx.js 통합 점화 검증 (실제 app.js 구동)
 *
 * verify-vfx.cjs 가 VFX 모듈 자체를 검증한다면, 이 파일은 '실제 public/app.js'
 * 를 가짜 브라우저 환경에서 로드해 서버 스냅샷을 흘려보내며 다음을 run 으로 증명한다:
 *   ① syncStore: 6종 이벤트가 도착하면 app.js 가 VFX.emit 으로 정확히 점화(버스트 6).
 *   ② frame:     VFX.update(fdt) 가 호출돼 파티클이 수명대로 소멸(active→0).
 *   ③ render:    VFX.draw 가 '세포 뒤·분열탄 앞'에서 호출돼 이펙트 레이어가 그려진다
 *                (가산혼합 lighter 윈도우로 VFX 레이어 호출만 분리 카운트).
 *   ④ z-order:   한 프레임 안에서 [세포 draw] → [VFX lighter 윈도우] → [분열탄 draw] 순서.
 *   ⑤ 폴백:      vfx.js 부재 시에도 app.js 의 no-op 스텁으로 throw 0(콘솔에러 0).
 *
 * 의존성 없음. node verify-app-vfx.cjs 로 직접 실행. exit 0 = PASS.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const PUB = path.join(__dirname, 'public');

let fail = 0;
const log = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  FAIL ') + msg); };

/* ---------- ESM(.js) → CJS 경량 로더 (+ 내부 식별자 export 훅) ---------- */
function loadESM(file, injected, exposeNames) {
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/^[ \t]*import\b[^\n]*\n/gm, '');
  const names = new Set();
  src = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g,
    (_, kw, n) => { names.add(n); return kw + ' ' + n; });
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*;?/g)) {
    for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) names.add(raw.split(/\s+as\s+/)[0].trim());
  }
  src = src.replace(/export\s*\{[^}]*\}\s*;?/g, '');
  src = src.replace(/export\s+default\s+/g, 'module.exports.default = ');
  let footer = '\n';
  for (const n of names) footer += `if (typeof ${n} !== 'undefined') module.exports.${n} = ${n};\n`;
  // 실제 app.js 의 내부 함수/상태를 테스트로 끌어내는 훅(같은 스코프라 참조 가능)
  if (exposeNames && exposeNames.length) {
    footer += 'module.exports.__hook = {' + exposeNames.map((n) => `get ${n}(){return ${n};}`).join(',') + '};\n';
  }
  const depKeys = Object.keys(injected).filter((k) => injected[k] !== undefined);
  const wrapped = `(function(module, exports${depKeys.length ? ', ' + depKeys.join(', ') : ''}){\n${src}\n${footer}\n});`;
  const fn = vm.runInThisContext(wrapped, { filename: file });
  const mod = { exports: {} };
  fn(mod, mod.exports, ...depKeys.map((k) => injected[k]));
  return mod.exports;
}

const ART = loadESM(path.join(PUB, 'tokens.js'), {}).ART;

/* ---------- 가짜 2D ctx — 레이어 분리 카운터 (lighter 윈도우 = VFX 레이어) ---------- */
function makeCtx() {
  const ctx = {
    globalCompositeOperation: 'source-over', globalAlpha: 1,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: '', textBaseline: '',
    _vfxDraws: 0, _baseDraws: 0, _order: [],
  };
  const isVFX = () => ctx.globalCompositeOperation === 'lighter';
  const draw = () => { if (isVFX()) ctx._vfxDraws++; else ctx._baseDraws++; };
  const noop = () => {};
  const stk = [];
  Object.assign(ctx, {
    setTransform: noop, translate: noop, scale: noop,
    // 실제 canvas 처럼 restore 가 합성모드/알파를 복원해야 VFX lighter 윈도우가 닫힌다
    save: () => { stk.push([ctx.globalCompositeOperation, ctx.globalAlpha, ctx.lineCap, ctx.lineJoin]); },
    restore: () => { const s = stk.pop(); if (s) { ctx.globalCompositeOperation = s[0]; ctx.globalAlpha = s[1]; ctx.lineCap = s[2]; ctx.lineJoin = s[3]; } },
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, rect: noop,
    fillText: noop, measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    clearRect: noop,
    fillRect: () => { ctx._order.push('bg'); },
    strokeRect: () => { ctx._order.push('border'); },
    arc: () => { draw(); ctx._order.push(isVFX() ? 'vfx' : 'cell'); },
    fill: draw, stroke: () => { draw(); if (isVFX()) ctx._order.push('vfx'); },
  });
  return ctx;
}

/* ---------- 가짜 브라우저 환경 ---------- */
let rafCb = null;
function fakeEl() {
  const e = {
    width: 800, height: 600, style: {}, value: '', textContent: '', innerHTML: '',
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {}, focus: () => {},
    getContext: () => makeCtx(),
  };
  return e;
}
let _now = 0;
function installEnv(withVFX) {
  const win = {};
  global.window = win;
  global.document = {
    documentElement: { ...fakeEl() },
    querySelector: () => fakeEl(),
    addEventListener: () => {},
  };
  global.getComputedStyle = () => ({ getPropertyValue: () => '200' });
  global.addEventListener = () => {};
  global.performance = { now: () => _now };
  global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  global.cancelAnimationFrame = () => {};
  global.setInterval = () => 0; global.clearInterval = () => {};
  global.setTimeout = () => 0;
  global.location = { protocol: 'http:', host: 'localhost:3000' };
  global.WebSocket = function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; };
  global.innerWidth = 800; global.innerHeight = 600; global.devicePixelRatio = 1;
  global.navigator = { userAgent: 'node' };
  // vfx.js 를 app.js 보다 먼저 로드 → window.VFX 등록 (index.html 의 로드 순서 재현)
  if (withVFX) loadESM(path.join(PUB, 'vfx.js'), { ART, window: win });
  // 실제 app.js 로드 (내부 onState/frame/store 훅 노출)
  const app = loadESM(path.join(PUB, 'app.js'), { ART, window: win }, ['onState', 'frame', 'store']);
  return { win, app };
}

/* ---------- 서버 스냅샷 빌더 (game.js getSnapshot 형태) ---------- */
const EVENTS = ['split', 'eat', 'pop', 'eject', 'merge', 'fire'];
function stateMsg(events) {
  const cells = EVENTS.map((ev, i) => ({
    id: 100 + i, x: 3000 + i * 30, y: 3000, r: 24 + i, mass: 50, color: ART.cellBots[i % ART.cellBots.length],
    type: i === 0 ? 'player' : 'bot', owner: i === 0 ? 'me' : 'b' + i, name: 'C' + i,
    event: events ? ev : null,
  }));
  return {
    t: 'state', camera: { x: 3000, y: 3000, view: 1000 },
    cells,
    viruses: [{ id: 900, x: 3100, y: 3050, r: 40, mass: 100, color: ART.virusFill, type: 'virus', owner: '', charge: 0, event: null }],
    food: [{ id: 1, x: 3010, y: 3010, r: 6, color: ART.food1, type: 'food' }],
    eject: [],
    shots: [{ id: 700, x: 3080, y: 3000, r: 8, color: ART.virusShot, type: 'virusShot' }],
    you: { alive: true, mass: 50, rank: 1, cells: 1, boostCooldown: 1, boostReadyIn: 0, boostActive: false },
    leaderboard: [{ rank: 1, name: 'C0', mass: 50, id: 'me' }],
    blips: [{ x: 3000, y: 3000, r: 24, owner: 'me' }],
  };
}
// 프레임 구동: 벽시계(_now)를 실제로 진행시켜야 app.js 의 fdt 가 0 이 아니다
function tick(frame, dtMs) { _now += dtMs; frame(_now); }

/* ============================================================
 * 시나리오 1 — vfx.js 존재: 실제 app.js 가 6종을 점화하고 z-order 로 그린다
 * ============================================================ */
console.log('[1] 실제 app.js + vfx.js — 이벤트 도착→점화→소멸 (run)');
// 캔버스 ctx 를 고정 인스턴스로 묶기 위해 document.querySelector('#game').getContext 를 고정
const fixedCtx = makeCtx();
function envWithFixedCanvas(withVFX) {
  const win = {};
  global.window = win;
  const gameCanvas = { ...fakeEl(), getContext: () => fixedCtx };
  const miniCanvas = { ...fakeEl(), getContext: () => makeCtx() };
  global.document = {
    documentElement: { ...fakeEl() },
    querySelector: (sel) => (sel === '#game' ? gameCanvas : sel === '#minimap-canvas' ? miniCanvas : fakeEl()),
    addEventListener: () => {},
  };
  global.getComputedStyle = () => ({ getPropertyValue: () => '200' });
  global.addEventListener = () => {};
  global.performance = { now: () => _now };
  global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  global.cancelAnimationFrame = () => {};
  global.setInterval = () => 0; global.clearInterval = () => {}; global.setTimeout = () => 0;
  global.location = { protocol: 'http:', host: 'localhost:3000' };
  global.WebSocket = function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; };
  global.innerWidth = 800; global.innerHeight = 600; global.devicePixelRatio = 1;
  global.navigator = { userAgent: 'node' };
  if (withVFX) loadESM(path.join(PUB, 'vfx.js'), { ART, window: win });
  const app = loadESM(path.join(PUB, 'app.js'), { ART, window: win }, ['onState', 'frame', 'store']);
  return { win, app };
}

_now = 0;
const { win, app } = envWithFixedCanvas(true);
const VFX = win.VFX;
const H = app.__hook;
log(typeof VFX.emit === 'function' && typeof VFX.draw === 'function', 'window.VFX 실제 모듈 등록(emit/draw 함수)');

// ① 이벤트 6종 도착 → syncStore 가 emit
VFX.reset && VFX.reset();
H.onState(stateMsg(true));
const bursts1 = VFX.stats().bursts;
log(bursts1 === 6, `6종 이벤트 도착 → app.js 가 정확히 ${bursts1} 버스트 점화(기대 6)`);
const activeAfter = VFX.stats().active;
log(activeAfter > 0, `점화 직후 활성 파티클 ${activeAfter}개(>0)`);

// ② 한 프레임 렌더 → VFX 레이어가 세포 뒤·분열탄 앞에서 그려진다
fixedCtx._vfxDraws = 0; fixedCtx._baseDraws = 0; fixedCtx._order = [];
tick(H.frame, 16);
log(fixedCtx._vfxDraws > 0, `render 프레임에서 VFX 레이어 ctx 호출 ${fixedCtx._vfxDraws}회(>0 = 점화가 화면에 그려짐)`);
// z-order: 세포(cell) → vfx → 분열탄(shot). shot 은 fallbackDot=arc(비-lighter)라 vfx 뒤 'cell' 태그.
const order = fixedCtx._order;
const firstVfx = order.indexOf('vfx');
const firstCell = order.indexOf('cell');
const lastVfx = order.lastIndexOf('vfx');
const cellsAfterVfx = order.slice(lastVfx + 1).filter((x) => x === 'cell').length; // = 분열탄(shot)
log(order[0] === 'bg', 'z-order: 배경(fillRect)이 가장 먼저');
log(firstCell >= 0 && firstCell < firstVfx, `z-order: 세포가 VFX 보다 먼저(cell@${firstCell} < vfx@${firstVfx})`);
log(cellsAfterVfx > 0, `z-order: 분열탄(shot)이 VFX 뒤에 그려짐(VFX 이후 원 ${cellsAfterVfx}개)`);

// ③ 후속 프레임: event=null 유지 + 시간 경과 → 재점화 0, 파티클 전량 소멸
let extraBursts = 0;
for (let i = 0; i < 70; i++) {           // ~1.16s @60fps
  H.onState(stateMsg(false));            // event 없는 스냅샷 계속 도착
  tick(H.frame, 16);
}
extraBursts = VFX.stats().bursts - bursts1;
log(extraBursts === 0, `event=null 프레임에선 재점화 0(누계 그대로 ${VFX.stats().bursts})`);
log(VFX.stats().active === 0, `수명 후 파티클 전량 풀 반환(active=${VFX.stats().active}) — 메모리 무한증가 없음`);

// ④ 같은 셀에 같은 이벤트가 연속 도착해도(서버 seq 미제공) 매번 점화 — eat 연타 가시성
VFX.reset && VFX.reset();
for (let k = 0; k < 5; k++) {
  H.onState(stateMsg(false));            // reset 상태에서 eat 단발 5회
  const m = stateMsg(false);
  m.cells[1].event = 'eat';              // 같은 id(101) 에 eat 반복
  H.onState(m);
  tick(H.frame, 16);
}
log(VFX.stats().bursts === 5, `같은 셀 eat 5연타 → 5회 모두 점화(클라 seq 부여로 dedup 묻힘 없음, 버스트=${VFX.stats().bursts})`);

/* ============================================================
 * 시나리오 2 — vfx.js 부재: app.js no-op 스텁으로 콘솔에러 0
 * ============================================================ */
console.log('[2] vfx.js 부재 — app.js no-op 스텁 폴백(throw 0)');
_now = 0; rafCb = null;
let booted = true, threw = '';
try {
  const env2 = envWithFixedCanvas(false);   // vfx.js 로드 안 함
  const VFX2 = env2.win.VFX;
  log(VFX2 && typeof VFX2.emit === 'function', 'app.js 가 no-op 스텁 VFX 설치(emit 함수 존재)');
  const H2 = env2.app.__hook;
  H2.onState(stateMsg(true));              // 이벤트 도착(스텁 emit no-op)
  tick(H2.frame, 16);                      // update/draw no-op
  H2.onState(stateMsg(false));
  tick(H2.frame, 16);
} catch (err) { booted = false; threw = err.message; }
log(booted, 'vfx.js 없이도 이벤트 처리·렌더 throw 0' + (threw ? ' → ' + threw : ''));

console.log('\n=== ' + (fail === 0 ? 'ALL PASS ✓' : fail + ' FAIL ✗') + ' ===');
process.exit(fail === 0 ? 0 : 1);
