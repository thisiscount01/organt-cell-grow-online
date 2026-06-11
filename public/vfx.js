/* ============================================================
 * vfx.js — 이벤트 폭발 파티클 VFX 모듈 (VFX 전문가 소유)
 * cell-grow-online
 *
 * window.VFX 를 구현한다. 서버가 보낸 1회성 이벤트(split/eat/pop/eject/
 * merge/fire)가 엔티티에 붙어 도착하면, app.js 가 그 스냅샷을 넘겨 '점화'
 * (emit)하고, 매 프레임 update(fdt) 로 수명/물리를 틱하며, 카메라 변환을
 * 적용한 월드좌표계에서 draw(ctx, view) 로 '소비'(렌더)한다.
 *
 * ── app.js 연동 계약 (정확히 이 3지점) ───────────────────────────────
 *   ① 점화 (syncStore 안, o.event 가 처음 도착한 그 순간 1회):
 *        if (o.event && window.VFX) VFX.emit({
 *          id: o.id, x: o.x, y: o.y, r: o.r,
 *          color: o.color, event: o.event, seq: o.seq // seq 는 선택(있으면 정확)
 *        });
 *      ※ 스칼라만 복사하므로 객체 참조를 넘겨도 무방하나, 권장은 위 형태.
 *      ※ 같은 이벤트를 여러 틱 들고 있어도 emit 을 매 틱 호출해 됨 —
 *        VFX 가 (id|event|seq) 기준으로 dedup 해 버스트는 1회만 점화한다.
 *
 *   ② 틱 (렌더 루프 frame() 안, 카메라 보간과 같은 fdt 로):
 *        VFX.update(fdt);   // fdt = 초 단위, app 가 이미 Math.min(0.05,…) 클램프
 *
 *   ③ 소비 (render() 안, 세포 그린 직후·분열탄/HUD 앞):
 *        VFX.draw(ctx, view);   // view = { scale, camX, camY, time, world }
 *      → z-order: 배경 → 먹이 → 펠릿 → 바이러스 → 세포 → [VFX] → 분열탄 → DOM UI
 *        (이펙트는 세포 위, HUD(DOM) 아래)
 *
 * 폴백 정합: 이 모듈이 로드되면 window.VFX 는 항상 emit/update/draw 를 갖는다.
 *   모듈이 아예 없을 때를 대비해 app.js 는 `window.VFX && VFX.emit` 가드를
 *   쓰거나, 부팅 시 `window.VFX = window.VFX || { emit(){}, update(){}, draw(){} }`
 *   no-op 스텁을 깔면 된다 — 어느 쪽이든 콘솔에러 0 로 동일 구동.
 *
 * 색 규칙: 모든 색은 tokens.js 의 ART(단일 출처)에서만 온다. 파생색
 *   (밝게/어둡게/투명도)은 런타임 헬퍼로 계산 — 파일 내 하드코딩 #hex 0건.
 *
 * 성능 예산: 파티클 풀 사전할당(상한 POOL=1400) · GC 스파이크 0(재사용) ·
 *   목표 60fps. 폭주 시 풀 고갈분은 그냥 버려 활성 상한을 유지(메모리 무한증가
 *   없음). 품질/개별 토글로 저사양 자동 디그레이드 가능(VFX.setQuality 등).
 *
 * 프레임율 독립: update 는 클램프된 fdt(초)로만 적분하므로 30/60/144fps 에서
 *   이펙트 지속시간이 동일하다.
 * ============================================================ */
import { ART } from './tokens.js';

/* ---------- 색 헬퍼 (모든 색은 ART/snap.color 에서 파생 — 하드코딩 금지) ---------- */
function parseRGB(color) {
  if (!color) return null;
  if (color[0] === '#') {
    let h = color.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [p[0] | 0, p[1] | 0, p[2] | 0];
  }
  return null;
}
function rgba(color, alpha) {
  const c = parseRGB(color);
  if (!c) return color;
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
function shade(color, f) {
  // f>0: 흰색 쪽 / f<0: 검정 쪽으로 보간 → rgb() 문자열 반환
  const c = parseRGB(color);
  if (!c) return color || rgba(ART.cellSelf, 1);
  const t = f >= 0 ? 255 : 0;
  const k = Math.abs(f);
  const r = Math.round(c[0] + (t - c[0]) * k);
  const g = Math.round(c[1] + (t - c[1]) * k);
  const b = Math.round(c[2] + (t - c[2]) * k);
  return `rgb(${r},${g},${b})`;
}

const TAU = Math.PI * 2;
const MAX_DT = 0.05;        // 내부 클램프(≥20fps 등가) — app 클램프와 이중 안전
const DEDUP_TTL = 2.0;      // 같은 (id|event|seq) 재점화 억제 창(초). 60틱(1s) > 충분히 덮음

/* ============================================================
 * 이벤트별 시각 스타일 — '색'은 ART 토큰 단일출처에서만 (하드코딩 0)
 *   tint() 가 null 이면 엔티티 자기 색(snap.color)을 쓴다.
 * ============================================================ */
const EVENT_STYLE = {
  // split : 방사 분열링 — 바깥으로 터지는 링 + 사방 스파크 (자기 색)
  split: { tint: null },
  // eat   : 흡입 수렴 — 바깥 링에서 중심으로 빨려드는 스파크 (자기 색)
  eat:   { tint: null },
  // pop   : 가시 파편 폭발 — 회전하는 날카로운 파편 + 충격링 (바이러스 색)
  pop:   { tint: () => ART.virusShot },
  // eject : 작은 분사 — 짧고 좁은 스프레이 (펠릿 색)
  eject: { tint: () => ART.eject },
  // merge : 수렴 글로우 — 느리고 부드러운 글로우가 안으로 모임 (코어 빛)
  merge: { tint: () => ART.cellSelfCore },
  // fire  : 발사 섬광 — 순간 플래시 + 전방 스트릭 (분열탄 색)
  fire:  { tint: () => ART.virusShot },
};
const EVENT_KEYS = Object.keys(EVENT_STYLE);

/* ============================================================
 * 파티클 풀 (사전할당 · 재사용) — 활성 상한 = POOL
 * ============================================================ */
const POOL = 1400;
const pool = new Array(POOL);
const freeStack = new Array(POOL);
let freeTop = POOL;
let active = 0;
let bursts = 0;            // 점화된 버스트 누계(검증용)
function blankParticle(i) {
  return {
    _i: i, active: false, mode: 'spark',
    x: 0, y: 0, vx: 0, vy: 0, life: 0, ttl: 0,
    size0: 0, size1: 0, col: '', alpha: 1,
    drag: 0, conv: 0, cx: 0, cy: 0, rot: 0, vrot: 0, width: 0,
  };
}
for (let i = 0; i < POOL; i++) { pool[i] = blankParticle(i); freeStack[i] = POOL - 1 - i; }

function alloc() {
  if (freeTop <= 0) return null;          // 풀 고갈 → 상한 유지(버림)
  const idx = freeStack[--freeTop];
  const p = pool[idx];
  p.active = true; active++;
  return p;
}
function freeP(p) {
  if (!p.active) return;
  p.active = false; active--;
  freeStack[freeTop++] = p._i;
}

/* ---------- dedup: (id|event|seq) → 만료 sim 시각 ---------- */
const _dedup = new Map();
let _sim = 0;             // 누적 시뮬레이션 시간(초) — Date 비의존(재현 가능)

/* ---------- 설정/토글 (QA·디자이너·저사양 디그레이드용) ---------- */
const cfg = {
  enabled: true,
  quality: 1,            // 0..1 — 스폰 수 스케일(저사양 디그레이드)
  events: { split: true, eat: true, pop: true, eject: true, merge: true, fire: true },
};

/* ---------- 스폰 유틸 ---------- */
const rnd = (a) => (Math.random() * 2 - 1) * a;
function spawn(o) {
  const p = alloc();
  if (!p) return null;
  p.mode = o.mode;
  p.x = o.x; p.y = o.y;
  p.vx = o.vx || 0; p.vy = o.vy || 0;
  p.life = o.life; p.ttl = o.life;
  p.size0 = o.size0; p.size1 = (o.size1 != null ? o.size1 : o.size0);
  p.col = o.col; p.alpha = (o.alpha != null ? o.alpha : 1);
  p.drag = o.drag || 0;
  p.conv = o.conv || 0; p.cx = (o.cx != null ? o.cx : o.x); p.cy = (o.cy != null ? o.cy : o.y);
  p.rot = o.rot || 0; p.vrot = o.vrot || 0;
  p.width = o.width || 0;
  return p;
}

/* ============================================================
 * 버스트 — 이벤트별 시각적으로 명확히 구별되는 점화
 * ============================================================ */
function spawnBurst(ev, x, y, r, color) {
  const q = cfg.quality;
  const n = (base) => Math.max(1, Math.round(base * q));
  const style = EVENT_STYLE[ev];
  const base = style.tint ? style.tint() : (color || ART.cellSelf);

  switch (ev) {
    case 'split': {                                  // 방사 분열링 + 사방 스파크
      spawn({ mode: 'ring', x, y, life: 0.45, size0: r * 0.9, size1: r * 2.6,
        col: shade(base, 0.25), alpha: 0.9, width: r * 0.18 });
      const c = n(16);
      for (let i = 0; i < c; i++) {
        const a = (TAU * i) / c + rnd(0.2);
        const sp = r * (3 + Math.random() * 3);
        spawn({ mode: 'spark', x: x + Math.cos(a) * r * 0.6, y: y + Math.sin(a) * r * 0.6,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 4.5,
          life: 0.4 + Math.random() * 0.2, size0: r * 0.16, size1: 0,
          col: shade(base, 0.5), alpha: 0.95 });
      }
      break;
    }
    case 'eat': {                                    // 흡입 수렴 — 안으로 빨려듦
      const c = n(14);
      for (let i = 0; i < c; i++) {
        const a = (TAU * i) / c + rnd(0.3);
        const rad = r * (1.6 + Math.random() * 0.8);
        spawn({ mode: 'spark', x: x + Math.cos(a) * rad, y: y + Math.sin(a) * rad,
          vx: 0, vy: 0, conv: 18, cx: x, cy: y, drag: 1.4,
          life: 0.32 + Math.random() * 0.16, size0: r * 0.13, size1: 0,
          col: shade(base, 0.45), alpha: 0.9 });
      }
      spawn({ mode: 'glow', x, y, life: 0.3, size0: r * 0.4, size1: r * 1.3,
        col: base, alpha: 0.5 });
      break;
    }
    case 'pop': {                                    // 가시 파편 폭발 + 충격링
      const c = n(22);
      for (let i = 0; i < c; i++) {
        const a = (TAU * i) / c + rnd(0.15);
        const sp = r * (4 + Math.random() * 4);
        spawn({ mode: 'shard', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 3,
          life: 0.45 + Math.random() * 0.25, size0: r * 0.5, size1: 0,
          col: shade(base, 0.4), alpha: 1, rot: a, vrot: rnd(8), width: r * 0.12 });
      }
      spawn({ mode: 'ring', x, y, life: 0.3, size0: r * 0.8, size1: r * 2.2,
        col: shade(base, 0.3), alpha: 0.8, width: r * 0.12 });
      break;
    }
    case 'eject': {                                  // 작은 분사 — 짧고 좁은 스프레이
      const dir = Math.random() * TAU;
      const c = n(6);
      for (let i = 0; i < c; i++) {
        const a = dir + rnd(0.5);
        const sp = r * (3 + Math.random() * 2);
        spawn({ mode: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 5,
          life: 0.28 + Math.random() * 0.15, size0: r * 0.3, size1: 0,
          col: shade(base, 0.4), alpha: 0.95 });
      }
      break;
    }
    case 'merge': {                                  // 수렴 글로우 — 부드럽게 안으로
      const c = n(12);
      for (let i = 0; i < c; i++) {
        const a = (TAU * i) / c + rnd(0.2);
        const rad = r * (1.4 + Math.random() * 0.6);
        spawn({ mode: 'glow', x: x + Math.cos(a) * rad, y: y + Math.sin(a) * rad,
          conv: 9, cx: x, cy: y, drag: 1.2,
          life: 0.5 + Math.random() * 0.2, size0: r * 0.3, size1: r * 0.1,
          col: shade(base, 0.55), alpha: 0.45 });
      }
      spawn({ mode: 'glow', x, y, life: 0.55, size0: r * 0.3, size1: r * 1.6,
        col: base, alpha: 0.4 });
      break;
    }
    case 'fire': {                                   // 발사 섬광 — 플래시 + 전방 스트릭
      spawn({ mode: 'glow', x, y, life: 0.18, size0: r * 2.0, size1: r * 0.5,
        col: shade(base, 0.6), alpha: 0.85 });
      const dir = Math.random() * TAU;
      const c = n(10);
      for (let i = 0; i < c; i++) {
        const a = dir + rnd(0.35);
        const sp = r * (6 + Math.random() * 5);
        spawn({ mode: 'streak', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 3.5,
          life: 0.28 + Math.random() * 0.15, size0: r * 0.18, size1: 0,
          col: shade(base, 0.5), alpha: 1, width: r * 0.1 });
      }
      break;
    }
  }
}

/* ============================================================
 * 공개 API
 * ============================================================ */
function emit(snap) {
  if (!snap || !cfg.enabled) return;
  const ev = snap.event;
  if (!ev || !EVENT_STYLE[ev] || cfg.events[ev] === false) return;
  // ── 스칼라만 복사(참조 보관 금지) ──
  const id = (snap.id != null ? snap.id : '?');
  const x = +snap.x || 0;
  const y = +snap.y || 0;
  const r = Math.max(2, +snap.r || 10);
  const color = (typeof snap.color === 'string') ? snap.color : null;
  const seq = (snap.seq != null) ? snap.seq : (snap.eventSeq != null ? snap.eventSeq : '');
  // ── dedup: 같은 (id|event|seq) 는 창(DEDUP_TTL) 안에서 1회만 점화 ──
  const key = id + '|' + ev + '|' + seq;
  const exp = _dedup.get(key);
  if (exp != null && exp > _sim) return;
  _dedup.set(key, _sim + DEDUP_TTL);
  bursts++;
  spawnBurst(ev, x, y, r, color);
}

function update(dt) {
  const fdt = Math.min(MAX_DT, Math.max(0, dt || 0));
  _sim += fdt;
  // dedup 만료 청소(메모리 무한증가 방지)
  if (_dedup.size) { for (const [k, e] of _dedup) if (e <= _sim) _dedup.delete(k); }
  for (let i = 0; i < POOL; i++) {
    const p = pool[i];
    if (!p.active) continue;
    p.life -= fdt;
    if (p.life <= 0) { freeP(p); continue; }
    if (p.conv) { p.vx += (p.cx - p.x) * p.conv * fdt; p.vy += (p.cy - p.y) * p.conv * fdt; }
    if (p.drag) { const d = Math.exp(-p.drag * fdt); p.vx *= d; p.vy *= d; }
    p.x += p.vx * fdt; p.y += p.vy * fdt;
    if (p.vrot) p.rot += p.vrot * fdt;
  }
}

function draw(ctx, view) {
  if (!cfg.enabled || !ctx) return;
  ctx.save();
  // 가산혼합 1회만 토글(상태토글 최소화) → 발광 파티클 배칭
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < POOL; i++) {
    const p = pool[i];
    if (!p.active) continue;
    const f = p.life / p.ttl;            // 1 → 0
    if (f <= 0) continue;
    const rad = p.size0 + (p.size1 - p.size0) * (1 - f);
    // 등장(빠르게 차고) → 소멸(부드럽게 페이드) 곡선
    let env = 1;
    if (f > 0.85) env = 0.7 + 0.3 * (1 - (f - 0.85) / 0.15);
    else if (f < 0.3) env = f / 0.3;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha * env));
    switch (p.mode) {
      case 'spark':
        ctx.fillStyle = p.col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.3, rad), 0, TAU);
        ctx.fill();
        break;
      case 'ring':
        ctx.strokeStyle = p.col;
        ctx.lineWidth = Math.max(0.5, p.width);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.3, rad), 0, TAU);
        ctx.stroke();
        break;
      case 'shard': {
        const L = Math.max(0.5, rad);
        const cx = Math.cos(p.rot) * L, cy = Math.sin(p.rot) * L;
        ctx.strokeStyle = p.col;
        ctx.lineWidth = Math.max(0.5, p.width);
        ctx.beginPath();
        ctx.moveTo(p.x - cx, p.y - cy);
        ctx.lineTo(p.x + cx, p.y + cy);
        ctx.stroke();
        break;
      }
      case 'streak':
        ctx.strokeStyle = p.col;
        ctx.lineWidth = Math.max(0.5, p.width);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        ctx.stroke();
        break;
      case 'glow': {
        const R = Math.max(0.5, rad);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
        g.addColorStop(0, rgba(p.col, 0.9));
        g.addColorStop(1, rgba(p.col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, R, 0, TAU);
        ctx.fill();
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ---------- 토글/디그레이드/검증 보조 ---------- */
function setEnabled(v) { cfg.enabled = !!v; }
function setQuality(q) { cfg.quality = Math.max(0, Math.min(1, +q || 0)); }
function toggleEvent(ev, v) { if (ev in cfg.events) cfg.events[ev] = !!v; }
function reset() {
  for (let i = 0; i < POOL; i++) { pool[i].active = false; freeStack[i] = POOL - 1 - i; }
  freeTop = POOL; active = 0; bursts = 0; _sim = 0; _dedup.clear();
}
function stats() {
  return { active, capacity: POOL, bursts, dedup: _dedup.size, sim: _sim,
    enabled: cfg.enabled, quality: cfg.quality, events: EVENT_KEYS.slice() };
}

/* ---------- export & 전역 등록 ---------- */
const VFX = { emit, update, draw, setEnabled, setQuality, toggleEvent, reset, stats, config: cfg };
if (typeof window !== 'undefined') window.VFX = VFX;
export { VFX };
export default VFX;
