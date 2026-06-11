/* ============================================================
 * cell-art.js — 캔버스 세포 아트 모듈 (게임 비주얼 디자이너 소유)
 * cell-grow-online
 *
 * window.CellArt 를 구현한다. app.js 가 카메라 변환(translate+scale)을
 * ctx 에 적용한 뒤, 각 엔티티를 '월드 좌표 그대로' 넘겨 호출한다.
 *   CellArt.drawCell(ctx, cell, view)
 *   CellArt.drawFood(ctx, food, view)
 *   CellArt.drawVirus(ctx, virus, view)
 *   CellArt.drawEject(ctx, eject, view)
 *   CellArt.drawShot(ctx, shot, view)
 *   view = { scale, camX, camY, time(sec), world }
 *
 * 책임 경계:
 *   - 이 모듈은 '정적 유기체 아트'만 소유한다(세포·먹이·바이러스·먹이펠릿·분열탄).
 *   - 일회성 폭발 파티클(이벤트 VFX)은 VFX 소유 — 여기서 건드리지 않는다.
 *
 * 색 규칙: 모든 색은 tokens.js 의 ART(단일 출처)에서만 온다.
 *   파생색(밝게/어둡게/투명도)은 런타임 헬퍼로 계산한다 — 하드코딩 색 금지.
 *
 * 성장의 가독성: 질량 단계(tier 0~4)가 올라갈수록
 *   멤브레인 엽(lobe) 수 · 소기관 수 · 핵 디테일(링/핵소체)이 늘어
 *   '색'뿐 아니라 '형태'로 성장이 한눈에 읽힌다.
 *
 * 살아있음: 멤브레인 떨림 · 글로우 맥동 · 이동 시 편모(진행 반대 꼬리).
 *   멈춰 있으면 편모는 보이지 않는다(일관성).
 * ============================================================ */
import { ART } from './tokens.js';

/* ---------- id 헬퍼 ----------
 * 서버 _id() 는 base36 문자열('a','1f' 등)을 준다. 이를 산술/위상에 직접
 * 쓰면 NaN 이 되어 createRadialGradient/arc 가 throw → rAF 루프가 멈춘다.
 * 어떤 형태의 id 든 안정적인 정수 시드로 바꿔 '개체별 위상차'만 만든다. */
function idSeed(id) {
  if (id == null) return 0;
  if (typeof id === 'number') return Number.isFinite(id) ? (id | 0) : 0;
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h < 0 ? -h : h;
}

/* ---------- 색 헬퍼 (모든 색은 ART/obj.color 에서 파생) ---------- */
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
  // f>0: 흰색 쪽으로 / f<0: 검정 쪽으로 보간
  const c = parseRGB(color);
  if (!c) return color;
  const t = f >= 0 ? 255 : 0;
  const k = Math.abs(f);
  const r = Math.round(c[0] + (t - c[0]) * k);
  const g = Math.round(c[1] + (t - c[1]) * k);
  const b = Math.round(c[2] + (t - c[2]) * k);
  return `rgb(${r},${g},${b})`;
}

/* ---------- 질량 → 성장 단계(tier) ---------- */
const TIER_BOUNDS = [22, 70, 220, 650]; // 4개 경계 → 5단계(0~4)
function tierOf(mass) {
  const m = mass || 0;
  for (let i = 0; i < TIER_BOUNDS.length; i++) if (m < TIER_BOUNDS[i]) return i;
  return TIER_BOUNDS.length; // 4
}
// 단계별 형태 파라미터 — 위로 갈수록 단조 증가(형태로 성장이 읽힘)
const LOBES_BY_TIER = [3, 5, 7, 9, 11];      // 멤브레인 엽 수
const ORGANELLES_BY_TIER = [0, 1, 2, 3, 4];  // 소기관(미토콘드리아 등) 수
const NUCLEUS_DETAIL_BY_TIER = [1, 2, 3, 4, 5]; // 핵 구성 원 수(본체+링+핵소체…)
const MEMBRANE_SEG_BY_TIER = [28, 36, 44, 52, 60]; // 멤브레인 외곽 분할 수

/* ---------- 이동 추적(편모용) — 모듈 자체 상태 ---------- */
const _track = new Map(); // id -> { x, y, t, sp, ang }
function updateMotion(obj, time) {
  const id = obj.id;
  const prev = _track.get(id);
  let sp = 0, ang = 0;
  if (prev) {
    const dt = time - prev.t;
    if (dt > 0.0001) {
      const vx = (obj.x - prev.x) / dt;
      const vy = (obj.y - prev.y) / dt;
      const inst = Math.hypot(vx, vy);
      // 지수 평활(튐 방지)
      sp = prev.sp + (inst - prev.sp) * 0.35;
      ang = (inst > 1) ? Math.atan2(vy, vx) : prev.ang;
    } else { sp = prev.sp; ang = prev.ang; }
  }
  _track.set(id, { x: obj.x, y: obj.y, t: time, sp, ang });
  // 너무 커지지 않게 가볍게 정리
  if (_track.size > 4096) _track.clear();
  return { sp, ang };
}

/* ---------- 멤브레인 외곽 경로 ---------- */
function membranePath(ctx, x, y, r, lobes, seg, time, wobbleAmp) {
  ctx.beginPath();
  for (let i = 0; i <= seg; i++) {
    const a = (Math.PI * 2 * i) / seg;
    // 떨림 = 저주파 엽 + 고주파 미세 진동(시간에 따라 흐름)
    const lobe = Math.sin(a * lobes + time * 1.6) * wobbleAmp;
    const micro = Math.sin(a * (lobes * 2 + 3) - time * 2.3) * wobbleAmp * 0.35;
    const rr = r * (1 + lobe + micro);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/* ---------- 편모(이동 트레일) ---------- */
function drawFlagella(ctx, x, y, r, baseColor, tier, sp, ang, time) {
  // 멈춰 있으면(속도≈0) 편모를 그리지 않는다.
  const SPEED_MIN = 14;
  if (sp < SPEED_MIN) return;
  const strength = Math.min(1, (sp - SPEED_MIN) / 220);
  const count = 2 + tier;                 // 단계가 클수록 꼬리 가닥↑
  const len = r * (0.6 + strength * 1.4); // 빠를수록 길게
  const tailAng = ang + Math.PI;          // 진행 '반대' 방향
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const spread = (i - (count - 1) / 2) * 0.28;
    const a = tailAng + spread;
    const sx = x + Math.cos(a) * r * 0.92;
    const sy = y + Math.sin(a) * r * 0.92;
    // 흩날리는 곡선 — 시간에 따라 출렁
    const sway = Math.sin(time * 6 + i * 1.7) * len * 0.22;
    const perp = a + Math.PI / 2;
    const mx = sx + Math.cos(a) * len * 0.55 + Math.cos(perp) * sway;
    const my = sy + Math.sin(a) * len * 0.55 + Math.sin(perp) * sway;
    const ex = sx + Math.cos(a) * len + Math.cos(perp) * sway * 1.6;
    const ey = sy + Math.sin(a) * len + Math.sin(perp) * sway * 1.6;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.strokeStyle = rgba(baseColor, 0.32 * strength + 0.1);
    ctx.lineWidth = Math.max(1, r * 0.12 * (1 - i / (count + 1)));
    ctx.stroke();
  }
  ctx.restore();
}

/* ============================================================
 * drawCell — 핵심: 살아있는 유기체 세포
 * ============================================================ */
function drawCell(ctx, cell, view) {
  const x = cell.x, y = cell.y, r = Math.max(1, cell.r || 1);
  const time = (view && view.time) || 0;
  const base = cell.color || ART.cellSelf;
  const tier = tierOf(cell.mass);
  const lobes = LOBES_BY_TIER[tier];
  const seg = MEMBRANE_SEG_BY_TIER[tier];
  const organelles = ORGANELLES_BY_TIER[tier];
  const nucDetail = NUCLEUS_DETAIL_BY_TIER[tier];

  const { sp, ang } = updateMotion(cell, time);
  // id 는 base36 문자열일 수 있으므로 반드시 정수 시드로만 위상에 쓴다(직접 산술 금지 → NaN→throw).
  const seed = idSeed(cell.id);

  ctx.save();

  /* 0) 편모(세포 아래) — 이동 중일 때만 */
  drawFlagella(ctx, x, y, r, base, tier, sp, ang, time);

  /* 1) 글로우(맥동) — 살아있는 빛 */
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.2 + (seed % 10));
  const glowR = r * (1.35 + 0.12 * pulse);
  const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, glowR);
  grad.addColorStop(0, rgba(base, 0.0));
  grad.addColorStop(0.7, rgba(base, 0.18 + 0.12 * pulse));
  grad.addColorStop(1, rgba(base, 0.0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, glowR, 0, Math.PI * 2);
  ctx.fill();

  /* 2) 세포질 본체 — 떨리는 멤브레인 외곽 + 방사형 음영 */
  const wobble = 0.018 + tier * 0.006; // 단계가 클수록 엽이 더 또렷
  membranePath(ctx, x, y, r, lobes, seg, time, wobble);
  const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r * 1.05);
  body.addColorStop(0, shade(base, 0.35));
  body.addColorStop(0.6, base);
  body.addColorStop(1, shade(base, -0.28));
  ctx.fillStyle = body;
  ctx.fill();

  /* 3) 멤브레인 림(두 겹) — 막의 질감 */
  ctx.lineJoin = 'round';
  // 막 색은 단일출처(ART.cellMembrane, 이미 rgba)를 그대로 사용
  ctx.strokeStyle = ART.cellMembrane;
  ctx.lineWidth = Math.max(1, r * 0.07);
  membranePath(ctx, x, y, r * 0.985, lobes, seg, time, wobble);
  ctx.stroke();
  ctx.strokeStyle = rgba(base, 0.5);
  ctx.lineWidth = Math.max(1, r * 0.04);
  ctx.stroke();

  /* 4) 소기관(미토콘드리아류) — 단계별 개수, 천천히 떠다님 */
  if (organelles > 0) {
    ctx.fillStyle = ART.cellOrganelle;
    for (let i = 0; i < organelles; i++) {
      const oa = (Math.PI * 2 * i) / organelles + time * 0.25 + (seed % 360) * 0.3;
      const orad = r * (0.32 + 0.12 * Math.sin(time * 0.8 + i));
      const ox = x + Math.cos(oa) * r * 0.5;
      const oy = y + Math.sin(oa) * r * 0.5;
      ctx.beginPath();
      ctx.arc(ox, oy, Math.max(1, orad * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* 5) 핵(nucleus) — 단계별 디테일: 본체 → 링 → 핵소체… */
  const nx = x, ny = y;
  const nr = r * 0.42;
  // 5-a) 핵 본체 (항상)
  ctx.fillStyle = ART.cellNucleus;
  ctx.beginPath();
  ctx.arc(nx, ny, nr, 0, Math.PI * 2);
  ctx.fill();
  // 5-b) 핵막 링 (tier>=1)
  if (nucDetail >= 2) {
    ctx.strokeStyle = rgba(base, 0.7);
    ctx.lineWidth = Math.max(1, r * 0.03);
    ctx.beginPath();
    ctx.arc(nx, ny, nr * 0.92, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 5-c) 핵소체(nucleolus) (tier>=2)
  if (nucDetail >= 3) {
    ctx.fillStyle = shade(base, 0.45);
    ctx.beginPath();
    ctx.arc(nx + nr * 0.18, ny - nr * 0.12, nr * 0.34, 0, Math.PI * 2);
    ctx.fill();
  }
  // 5-d) 2차 핵소체 (tier>=3)
  if (nucDetail >= 4) {
    ctx.fillStyle = shade(base, 0.25);
    ctx.beginPath();
    ctx.arc(nx - nr * 0.32, ny + nr * 0.22, nr * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
  // 5-e) 내핵 광택 링 (tier>=4)
  if (nucDetail >= 5) {
    ctx.strokeStyle = rgba(shade(base, 0.6), 0.6);
    ctx.lineWidth = Math.max(1, r * 0.02);
    ctx.beginPath();
    ctx.arc(nx, ny, nr * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* 6) 이름표 — 가독 보조(아트 영역의 텍스트, VFX 아님) */
  if (cell.name && r > 14) {
    ctx.fillStyle = shade(base, 0.85);
    ctx.font = `${Math.max(11, r * 0.34)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = rgba(ART.bgDeep, 0.55);
    ctx.lineWidth = Math.max(1, r * 0.04);
    if (ctx.strokeText) ctx.strokeText(cell.name, x, y + r * 0.66);
    ctx.fillText(cell.name, x, y + r * 0.66);
  }

  ctx.restore();
}

/* ============================================================
 * drawFood — 작은 영양 알갱이(은은한 맥동 + 코어 하이라이트)
 * ============================================================ */
function drawFood(ctx, food, view) {
  const x = food.x, y = food.y, r = Math.max(0.5, food.r || 2);
  const time = (view && view.time) || 0;
  const base = food.color || ART.food1;
  const pulse = 0.5 + 0.5 * Math.sin(time * 3 + (idSeed(food.id) % 100));
  ctx.save();
  // 글로우
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * (2.2 + 0.4 * pulse));
  g.addColorStop(0, rgba(base, 0.5));
  g.addColorStop(1, rgba(base, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * (2.2 + 0.4 * pulse), 0, Math.PI * 2);
  ctx.fill();
  // 본체
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // 코어 하이라이트
  ctx.fillStyle = rgba(shade(base, 0.6), 0.8);
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ============================================================
 * drawEject — W로 뿜은 먹이 펠릿(살짝 흔들리는 방울)
 * ============================================================ */
function drawEject(ctx, e, view) {
  const x = e.x, y = e.y, r = Math.max(1, e.r || 4);
  const time = (view && view.time) || 0;
  const base = e.color || ART.eject;
  ctx.save();
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8);
  g.addColorStop(0, rgba(base, 0.45));
  g.addColorStop(1, rgba(base, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(x, y, r * (1 + 0.05 * Math.sin(time * 5 + (idSeed(e.id) % 100))), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ART.cellMembrane;
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
  ctx.restore();
}

/* ============================================================
 * drawVirus — 지뢰: 가시 유기체(맥동 글로우 + 충전 게이지)
 *   charge(0~1 추정)가 높을수록 발사 임박 → 글로우/가시 펄스 강화
 * ============================================================ */
function drawVirus(ctx, virus, view) {
  const x = virus.x, y = virus.y, r = Math.max(2, virus.r || 30);
  const time = (view && view.time) || 0;
  const charge = Math.max(0, Math.min(1, virus.charge != null ? virus.charge : 0));
  const fill = ART.virusFill;
  const spikeCol = ART.virusSpike;
  const spikes = 16;
  ctx.save();

  /* 충전 글로우(맥동) — 충전될수록 강해짐 */
  const pulse = 0.5 + 0.5 * Math.sin(time * (3 + charge * 6));
  const glowR = r * (1.35 + 0.2 * pulse + 0.25 * charge);
  const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, glowR);
  g.addColorStop(0, rgba(fill, 0));
  g.addColorStop(0.65, rgba(fill, (0.2 + 0.4 * charge) * (0.6 + 0.4 * pulse)));
  g.addColorStop(1, rgba(fill, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, glowR, 0, Math.PI * 2);
  ctx.fill();

  /* 가시 본체 — 충전 시 가시가 들썩 */
  const spikeOut = r * (1 + 0.06 * pulse * (0.5 + charge));
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = (Math.PI * i) / spikes + time * 0.15;
    const rr = i % 2 ? spikeOut : r * 0.82;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  body.addColorStop(0, shade(fill, 0.3));
  body.addColorStop(1, shade(fill, -0.15));
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = spikeCol;
  ctx.lineWidth = Math.max(2, r * 0.08);
  ctx.lineJoin = 'round';
  ctx.stroke();

  /* 내부 코어 + 충전 게이지 링 */
  ctx.fillStyle = rgba(ART.bgDeep, 0.4);
  ctx.beginPath();
  ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  if (charge > 0.01) {
    ctx.strokeStyle = ART.virusGlow;
    ctx.lineWidth = Math.max(2, r * 0.1);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge);
    ctx.stroke();
  }
  ctx.restore();
}

/* ============================================================
 * drawShot — 바이러스 분열탄: 빠른 발사체(코어 + 잔광)
 * ============================================================ */
function drawShot(ctx, s, view) {
  const x = s.x, y = s.y, r = Math.max(2, s.r || 8);
  const time = (view && view.time) || 0;
  const base = s.color || ART.virusShot;
  ctx.save();
  const pulse = 0.5 + 0.5 * Math.sin(time * 12 + (idSeed(s.id) % 100));
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * (2.4 + 0.6 * pulse));
  g.addColorStop(0, rgba(base, 0.85));
  g.addColorStop(0.5, rgba(base, 0.35));
  g.addColorStop(1, rgba(base, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * (2.4 + 0.6 * pulse), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade(base, 0.4);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ---------- export & 전역 등록 ---------- */
const CellArt = { drawCell, drawFood, drawVirus, drawEject, drawShot, tierOf, _track };
if (typeof window !== 'undefined') window.CellArt = CellArt;
export { CellArt };
export default CellArt;
