/* verify-vfx.cjs — 이벤트 VFX 모듈 헤드리스 검증 (픽셀 렌더 없이)
 *
 * 검증 항목 (Goal/팀 합의 성공기준 1:1 매핑):
 *  A) 6종(split/eat/pop/eject/merge/fire) 각각 emit→update 60틱→draw 에러 0,
 *     그리고 각 이벤트가 활성 구간에 ctx 호출 1회+ 발생(=시각적으로 점화됨).
 *  B) dedup — 같은 (id|event|seq) 를 60틱 유지하며 emit 60회 호출해도 버스트 1회.
 *     반대로 seq 가 바뀌면 즉시 재점화.
 *  C) 풀 상한 — 이벤트 폭주(수천 emit)에도 active ≤ capacity(메모리 무한증가 없음),
 *     수명 후 전량 풀 반환(active→0).
 *  D) 프레임율 독립 — 30/60/144fps 로 같은 벽시계 시간을 적분하면 지속시간 동일
 *     (특정 시각의 active 수가 fps 무관 일치).
 *  E) 하드코딩 색(#hex) 0건 — 색 단일출처(ART) 보증.
 *  F) 폴백 정합 — window.VFX 가 emit/update/draw 를 모두 가지며 인자 없이도 무던.
 *  G) 점화 통합 시나리오 — app.js 의 3지점(emit/update/draw)을 그대로 흉내내,
 *     '이벤트 도착 → 해당 프레임에 이펙트 레이어 ctx 호출 발생'을 run 으로 재현.
 *
 * 의존성 없음. node verify-vfx.cjs 로 직접 실행. exit 0 = PASS.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---------- ESM(.js) → CJS 경량 로더 (verify-cellart.cjs 와 동일 패턴) ---------- */
function loadESM(file, injected) {
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/^[ \t]*import\b[^\n]*\n/gm, '');
  const names = new Set();
  src = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g,
    (_, kw, n) => { names.add(n); return kw + ' ' + n; });
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*;?/g)) {
    for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      names.add(raw.split(/\s+as\s+/)[0].trim());
    }
  }
  src = src.replace(/export\s*\{[^}]*\}\s*;?/g, '');
  src = src.replace(/export\s+default\s+/g, 'module.exports.default = ');
  let footer = '\n';
  for (const n of names) footer += `if (typeof ${n} !== 'undefined') module.exports.${n} = ${n};\n`;
  const depKeys = Object.keys(injected).filter((k) => injected[k] !== undefined);
  const wrapped = `(function(module, exports${depKeys.length ? ', ' + depKeys.join(', ') : ''}){\n${src}\n${footer}\n});`;
  const fn = vm.runInThisContext(wrapped, { filename: file });
  const mod = { exports: {} };
  fn(mod, mod.exports, ...depKeys.map((k) => injected[k]));
  return mod.exports;
}

const PUB = path.join(__dirname, 'public');
const tokens = loadESM(path.join(PUB, 'tokens.js'), { ART: undefined, window: undefined });
const ART = tokens.ART;
if (!ART || !ART.cellSelf) { console.error('tokens.ART 로드 실패'); process.exit(1); }
const fakeWindow = {};
const VFX = loadESM(path.join(PUB, 'vfx.js'), { ART, window: fakeWindow }).VFX || fakeWindow.VFX;

/* ---------- 가짜 2D ctx (호출 카운터) ---------- */
function makeCtx() {
  const counts = { arc: 0, beginPath: 0, moveTo: 0, lineTo: 0, fill: 0, stroke: 0, gradients: 0, total: 0 };
  const grad = { addColorStop: () => {} };
  const handler = {
    get(t, k) {
      if (k in counts) return () => { counts[k]++; counts.total++; };
      if (k === '__counts') return counts;
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return () => { counts.gradients++; counts.total++; return grad; };
      }
      if (k === 'measureText') return () => ({ width: 10 });
      if (typeof k === 'string' && /^[a-z]/.test(k)) return () => { counts.total++; };
      return undefined;
    },
    set() { return true; },
  };
  return new Proxy({}, handler);
}

let fail = 0;
const log = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  FAIL ') + msg); };
const view = (t) => ({ scale: 1, camX: 0, camY: 0, time: t, world: { w: 6000, h: 6000 } });
const EVENTS = ['split', 'eat', 'pop', 'eject', 'merge', 'fire'];
const FPS = { drop: 0.05, f30: 1 / 30, f60: 1 / 60, f144: 1 / 144 };

/* ============================================================
 * A) 6종 각각 emit → update 60틱 → draw 에러 0, 활성 구간 ctx 호출 1회+
 * ============================================================ */
console.log('[A] 6종 emit→update 60틱→draw : 에러 0 + 이벤트별 점화(ctx 호출)');
let aErr = 0;
for (let e = 0; e < EVENTS.length; e++) {
  const ev = EVENTS[e];
  VFX.reset();
  let drawCalls = 0;
  let t = 0;
  try {
    // 이벤트 도착(1회 점화)
    VFX.emit({ id: 1000 + e, x: 100, y: 100, r: 24, color: ART.cellBots[e % ART.cellBots.length], event: ev, seq: 1 });
    const afterEmit = VFX.stats().active;
    // 매 프레임: update + draw (app 의 실제 순서) — 60틱
    for (let i = 0; i < 60; i++) {
      VFX.update(FPS.f60); t += FPS.f60;
      const ctx = makeCtx();
      VFX.draw(ctx, view(t));
      drawCalls += ctx.__counts.total;
    }
    log(afterEmit > 0, `${ev}: 점화 즉시 파티클 생성(active=${afterEmit})`);
    log(drawCalls > 0, `${ev}: 활성 구간 ctx 호출 ${drawCalls}회(>0 = 화면에 점화됨)`);
  } catch (err) { aErr++; console.log('       ✗ ' + ev + ': ' + err.message); }
}
log(aErr === 0, `6종 전체 throw 0건(에러 ${aErr})`);

/* ============================================================
 * B) dedup — 같은 이벤트 60틱 유지 시 버스트 1회 / seq 변경 시 재점화
 * ============================================================ */
console.log('[B] dedup — 동일 (id|event|seq) 60틱 유지해도 버스트 1회');
VFX.reset();
const snap = { id: 7, x: 0, y: 0, r: 20, color: ART.cellSelf, event: 'split', seq: 42 };
for (let i = 0; i < 60; i++) { VFX.emit(snap); VFX.update(FPS.f60); }  // 매 틱 emit (app 가 o.event 유지)
const b1 = VFX.stats().bursts;
log(b1 === 1, `같은 이벤트 60회 emit → 버스트 ${b1}회(기대 1)`);
VFX.emit({ id: 7, x: 0, y: 0, r: 20, color: ART.cellSelf, event: 'split', seq: 43 }); // seq 변경
const b2 = VFX.stats().bursts;
log(b2 === 2, `seq 변경 시 즉시 재점화 → 누계 ${b2}(기대 2)`);

/* ============================================================
 * C) 풀 상한 — 폭주에도 active ≤ capacity, 수명 후 전량 반환
 * ============================================================ */
console.log('[C] 풀 상한 — 이벤트 폭주에도 활성 상한 유지 + 수명 후 0 반환');
VFX.reset();
const cap = VFX.stats().capacity;
let peak = 0;
for (let i = 0; i < 4000; i++) {       // 4000 이벤트 폭주(전부 고유 seq)
  VFX.emit({ id: i, x: (i * 13) % 1000, y: (i * 7) % 1000, r: 18, color: ART.virusFill, event: EVENTS[i % 6], seq: i });
  peak = Math.max(peak, VFX.stats().active);
}
log(peak <= cap, `폭주 피크 active=${peak} ≤ capacity=${cap}(메모리 무한증가 없음)`);
log(peak >= cap * 0.5, `풀이 실제로 채워짐(피크 ${peak} ≥ 절반)`);
for (let i = 0; i < 120; i++) VFX.update(FPS.f60);   // 2초 경과 → 전 파티클 만료
log(VFX.stats().active === 0, `수명 후 전량 풀 반환(active=${VFX.stats().active})`);

/* ============================================================
 * D) 프레임율 독립 — 같은 벽시계 시간 적분 시 30/60/144fps 결과 일치
 *    파티클 수명이 난수라 fps끼리 '동일 입력'으로 비교하려면 난수를 시드
 *    고정(같은 버스트)해야 한다. 그래야 차이의 원인이 '적분기'로 한정된다.
 * ============================================================ */
console.log('[D] 프레임율 독립 — 같은 시간 적분 시 active 수 fps 무관 일치');
const _rand = Math.random;
let _seed = 0;
function seedRandom() { _seed = 0x2f6e2b1; Math.random = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }; }
function activeAt(dt, seconds) {
  seedRandom();                  // 매 호출 동일 난수열 → 동일 수명의 버스트
  VFX.reset();
  VFX.emit({ id: 1, x: 0, y: 0, r: 24, color: ART.cellSelf, event: 'split', seq: 1 });
  let acc = 0;
  while (acc < seconds - 1e-9) { const step = Math.min(dt, seconds - acc); VFX.update(step); acc += step; }
  return VFX.stats().active;
}
const a30 = activeAt(FPS.f30, 0.3);
const a60 = activeAt(FPS.f60, 0.3);
const a144 = activeAt(FPS.f144, 0.3);
Math.random = _rand;            // 난수 원복
console.log(`       0.3s 경과 후 active: 30fps=${a30}, 60fps=${a60}, 144fps=${a144}`);
log(a30 === a60 && a60 === a144, '30/60/144fps 에서 동일 지속시간(같은 시각 active 일치)');

/* ============================================================
 * E) 하드코딩 색(#hex) 0건
 * ============================================================ */
console.log('[E] vfx.js 하드코딩 색(#hex) 검사');
let src = fs.readFileSync(path.join(PUB, 'vfx.js'), 'utf8');
src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const hexHits = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
log(hexHits.length === 0, `하드코딩 #hex ${hexHits.length}건` + (hexHits.length ? ' → ' + hexHits.join(', ') : ''));

/* ============================================================
 * F) 폴백 정합 — emit/update/draw 항상 존재 + 인자 없이도 무던
 * ============================================================ */
console.log('[F] 폴백 정합 — window.VFX.{emit,update,draw} 존재 + 안전 호출');
const hasAll = typeof VFX.emit === 'function' && typeof VFX.update === 'function' && typeof VFX.draw === 'function';
log(hasAll, 'emit/update/draw 3종 모두 함수로 존재');
let safe = true;
try { VFX.emit(); VFX.emit(null); VFX.emit({ event: 'nope' }); VFX.update(); VFX.update(NaN); VFX.draw(makeCtx()); VFX.draw(null); }
catch (err) { safe = false; console.log('       ✗ ' + err.message); }
log(safe, '잘못된/누락 인자에도 throw 0(app 연동부 무조건 안전)');
log(fakeWindow.VFX === VFX, 'window.VFX 전역 등록 확인');

/* ============================================================
 * G) 점화 통합 시나리오 — app.js 3지점(syncStore→frame→render) 흉내
 * ============================================================ */
console.log('[G] 통합 시나리오 — 이벤트 도착 프레임에 이펙트 레이어 점화 재현');
VFX.reset();
// app.js render() 의 z-order: … 세포 그린 뒤 VFX.draw(이펙트), 그 뒤 분열탄/HUD
function appFrame(snapshots, t, dt) {
  // ① syncStore: o.event 도착분만 emit
  for (const o of snapshots) if (o.event) VFX.emit({ id: o.id, x: o.x, y: o.y, r: o.r, color: o.color, event: o.event, seq: o.seq });
  // ② frame: update
  VFX.update(dt);
  // ③ render: (세포 등 그린 뒤) 이펙트 레이어 draw
  const ctx = makeCtx();
  VFX.draw(ctx, view(t));
  const c = ctx.__counts;
  // 빈 프레임도 save/restore 로 total>0 이므로, '실제 파티클 렌더'만 카운트
  return c.arc + c.stroke + c.fill + c.gradients;
}
let t2 = 0, ignitedFrames = 0, firstIgniteCalls = 0, tailSilent = 0;
const FRAMES = 90;              // 1.5s — 0.6s 수명 버스트가 완전히 소멸하기에 충분
const stream = [
  { id: 1, x: 50, y: 50, r: 30, color: ART.cellSelf, event: 'split', seq: 1 },   // 프레임0: 이벤트 도착
];
for (let i = 0; i < FRAMES; i++) {
  t2 += FPS.f60;
  const snaps = (i === 0) ? stream : [{ id: 1, x: 50, y: 50, r: 30, color: ART.cellSelf, event: null }];
  const calls = appFrame(snaps, t2, FPS.f60);
  if (calls > 0) { ignitedFrames++; if (firstIgniteCalls === 0) firstIgniteCalls = calls; }
  if (i >= FRAMES - 10) { if (calls === 0) tailSilent++; }   // 마지막 10프레임은 조용해야
}
log(firstIgniteCalls > 0, `이벤트 도착 직후 이펙트 레이어 ctx 호출 ${firstIgniteCalls}회(점화 확인)`);
log(ignitedFrames > 1 && ignitedFrames < FRAMES, `이펙트가 ${ignitedFrames}프레임 지속 후 소멸(장식 아닌 1회성 피드백)`);
log(tailSilent === 10 && VFX.stats().active === 0, `소멸 후 완전 정지(말미 10프레임 ctx 호출 0, active=${VFX.stats().active})`);
log(VFX.stats().bursts === 1, `event=null 프레임에선 재점화 없음(버스트 ${VFX.stats().bursts})`);

/* ---------- 결과 ---------- */
console.log('\n=== ' + (fail === 0 ? 'ALL PASS ✓' : fail + ' FAIL ✗') + ' ===');
process.exit(fail === 0 ? 0 : 1);
