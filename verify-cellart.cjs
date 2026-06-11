/* verify-cellart.cjs — 세포 아트 모듈 헤드리스 검증 (픽셀 렌더 없이)
 *
 * 목적:
 *  A) 가짜 2D ctx 로 drawCell/drawFood/drawVirus/drawEject/drawShot 를
 *     단계별 질량 · 여러 time 프레임에 대해 호출 → 에러 0.
 *  B) 단계(tier)가 올라갈수록 그리기 복잡도(arc/path)가 실제로 증가 →
 *     '형태로 성장이 읽힘'을 객관 증명.
 *  C) cell-art.js 에 하드코딩 색(#hex) 0건 → 색 단일출처(ART) 보증.
 *  D) 멈춤=편모 없음 / 이동=편모 있음(일관성).
 *
 * 의존성 없음. node verify-cellart.cjs 로 직접 실행. exit 0 = PASS.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---------- ESM(.js) 파일을 CJS 컨텍스트에서 평가하는 경량 로더 ---------- */
function loadESM(file, injected) {
  let src = fs.readFileSync(file, 'utf8');
  // import 라인 제거(의존성은 globalThis 로 주입)
  src = src.replace(/^[ \t]*import\b[^\n]*\n/gm, '');
  const names = new Set();
  // export const/let/var/function/class NAME → 선언만 남기고 이름 수집
  src = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g,
    (_, kw, n) => { names.add(n); return kw + ' ' + n; });
  // export { A, B as C }; 수집 후 제거
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*;?/g)) {
    for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      names.add(raw.split(/\s+as\s+/)[0].trim());
    }
  }
  src = src.replace(/export\s*\{[^}]*\}\s*;?/g, '');
  // export default X → module.exports.default = X
  src = src.replace(/export\s+default\s+/g, 'module.exports.default = ');
  let footer = '\n';
  for (const n of names) footer += `if (typeof ${n} !== 'undefined') module.exports.${n} = ${n};\n`;
  // 주입할 의존성만 함수 파라미터로 — 모듈이 직접 선언하는 식별자와 충돌 회피
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
const CA = loadESM(path.join(PUB, 'cell-art.js'), { ART, window: fakeWindow }).CellArt
  || fakeWindow.CellArt;

/* ---------- 가짜 2D ctx (호출 카운터) ---------- */
function makeCtx() {
  const counts = { arc: 0, beginPath: 0, moveTo: 0, lineTo: 0, quadraticCurveTo: 0, fill: 0, stroke: 0, gradients: 0, total: 0 };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const handler = {
    get(t, k) {
      if (k in counts) return (...a) => { counts[k]++; counts.total++; };
      if (k === '__counts') return counts;
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return () => { counts.gradients++; counts.total++; return grad; };
      }
      if (k === 'measureText') return () => ({ width: 10 });
      // save/restore/closePath/fillText/strokeText/translate/scale 등 기타 메서드
      if (typeof k === 'string' && /^[a-z]/.test(k)) return (...a) => { counts.total++; };
      return undefined;
    },
    set() { return true; }, // fillStyle/strokeStyle/lineWidth 등 무시
  };
  return new Proxy({}, handler);
}

let fail = 0;
const log = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  FAIL ') + msg); };

/* ============================================================
 * A) 에러 0 — 모든 그리기 함수 × 단계별 질량 × 여러 프레임
 * ============================================================ */
console.log('[A] 호출 에러 0 (단계별 질량 × 다중 time 프레임)');
const MASSES = [10, 30, 100, 350, 1200];     // tier 0~4 대표값
const TIMES = [0, 0.13, 0.5, 1.0, 2.7, 9.9];  // 애니메이션 프레임
let calls = 0, errors = 0;
const view = (t) => ({ scale: 1, camX: 0, camY: 0, time: t, world: { w: 6000, h: 6000 } });
for (const t of TIMES) {
  for (let i = 0; i < MASSES.length; i++) {
    const m = MASSES[i];
    const r = Math.sqrt(m) * 4;
    const cell = { id: 100 + i, x: 50, y: 50, r, mass: m, color: ART.cellBots[i % ART.cellBots.length], type: 'bot', owner: '', name: 'Org' + i, event: null };
    const tries = [
      () => CA.drawCell(makeCtx(), cell, view(t)),
      () => CA.drawFood(makeCtx(), { id: i, x: 0, y: 0, r: 4, color: ART.food[i % ART.food.length], type: 'food' }, view(t)),
      () => CA.drawVirus(makeCtx(), { id: i, x: 0, y: 0, r: 40, mass: 120, color: ART.virusFill, type: 'virus', owner: '', charge: (i / 4), event: null }, view(t)),
      () => CA.drawEject(makeCtx(), { id: i, x: 0, y: 0, r: 6, color: ART.eject, type: 'eject', owner: 'p' }, view(t)),
      () => CA.drawShot(makeCtx(), { id: i, x: 0, y: 0, r: 8, color: ART.virusShot, type: 'virusShot' }, view(t)),
    ];
    for (const fn of tries) { calls++; try { fn(); } catch (e) { errors++; console.log('       ✗ ' + e.message); } }
  }
}
log(errors === 0, `${calls}회 호출, 에러 ${errors}건`);

/* ============================================================
 * B) 단계가 올라갈수록 drawCell 그리기 복잡도 단조 증가
 *    (정적 비교: time/위치 고정 → 편모·맥동 변수 제거)
 * ============================================================ */
console.log('[B] tier↑ → drawCell 복잡도(arc/total) 단조 증가');
const FIXED_T = 0.4;
const profiles = MASSES.map((m, i) => {
  const ctx = makeCtx();
  const r = 60; // 반지름 고정 → 복잡도 차이는 '형태(단계)'에서만 나옴
  // x,y 고정 + 추적맵 초기화로 편모(이동) 제거
  CA._track && CA._track.clear && CA._track.clear();
  CA.drawCell(ctx, { id: 7, x: 0, y: 0, r, mass: m, color: ART.cellSelf, type: 'bot', owner: '', name: '', event: null }, view(FIXED_T));
  const c = ctx.__counts;
  return { mass: m, tier: CA.tierOf(m), arc: c.arc, total: c.total };
});
profiles.forEach((p) => console.log(`       tier ${p.tier} (mass ${p.mass}): arc=${p.arc}, ops=${p.total}`));
let monoArc = true, monoTotal = true;
for (let i = 1; i < profiles.length; i++) {
  if (!(profiles[i].arc > profiles[i - 1].arc)) monoArc = false;
  if (!(profiles[i].total > profiles[i - 1].total)) monoTotal = false;
}
log(monoArc, 'arc 호출 수가 단계마다 엄격히 증가(형태 구분 증명)');
log(monoTotal, '총 path 연산 수가 단계마다 엄격히 증가');
log(profiles[0].tier === 0 && profiles[profiles.length - 1].tier === 4, `단계 범위 0..4 (실측 ${profiles[0].tier}..${profiles[profiles.length - 1].tier})`);

/* ============================================================
 * C) 하드코딩 색(#hex) 0건 — 색 단일출처(ART) 보증
 * ============================================================ */
console.log('[C] cell-art.js 하드코딩 색(#hex) 검사');
let caSrc = fs.readFileSync(path.join(PUB, 'cell-art.js'), 'utf8');
caSrc = caSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // 주석 제거
const hexHits = [...caSrc.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
log(hexHits.length === 0, `하드코딩 #hex ${hexHits.length}건` + (hexHits.length ? ' → ' + hexHits.join(', ') : ''));

/* ============================================================
 * D) 멈춤=편모 없음 / 이동=편모 있음 (일관성)
 *    편모는 quadraticCurveTo 로만 그려진다 → 그 카운트로 판별.
 * ============================================================ */
console.log('[D] 멈춤=편모 없음 / 이동=편모 있음');
function quadCountFor(positions) {
  CA._track && CA._track.clear && CA._track.clear();
  let last = 0;
  for (let i = 0; i < positions.length; i++) {
    const ctx = makeCtx();
    const p = positions[i];
    CA.drawCell(ctx, { id: 999, x: p.x, y: p.y, r: 60, mass: 1200, color: ART.cellSelf, type: 'player', owner: '', name: '', event: null }, view(p.t));
    last = ctx.__counts.quadraticCurveTo;
  }
  return last;
}
// 정지: 같은 위치를 여러 프레임
const still = quadCountFor([{ x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 0.1 }, { x: 0, y: 0, t: 0.2 }, { x: 0, y: 0, t: 0.3 }]);
// 이동: 매 프레임 크게 전진
const moving = quadCountFor([{ x: 0, y: 0, t: 0 }, { x: 40, y: 0, t: 0.1 }, { x: 80, y: 0, t: 0.2 }, { x: 120, y: 0, t: 0.3 }]);
console.log(`       정지 편모 quad=${still}, 이동 편모 quad=${moving}`);
log(still === 0, '정지 시 편모 미표시(quad=0)');
log(moving > 0, '이동 시 편모 표시(quad>0)');

/* ---------- 결과 ---------- */
console.log('\n=== ' + (fail === 0 ? 'ALL PASS ✓' : fail + ' FAIL ✗') + ' ===');
process.exit(fail === 0 ? 0 : 1);
