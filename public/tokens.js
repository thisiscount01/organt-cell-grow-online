/* ============================================================
 * tokens.js — 디자인 토큰 JS 미러 (단일 출처)
 * cell-grow-online
 *
 * 캔버스(2D ctx)는 CSS 변수를 읽지 못하므로, 비주얼 디자이너/VFX는
 * 여기서 색을 import 해서 ctx.fillStyle 등에 사용한다.
 * ⚠ tokens.css 와 키명·값을 1:1 동기화할 것 (수기 동기화).
 *
 * 사용 예:
 *   import { TOKENS, ART } from './tokens.js';
 *   ctx.fillStyle = ART.cellSelf;
 * ============================================================ */

export const BRAND = {
  primary:      '#2de2c0',
  primaryDim:   '#1f9e8a',
  accent:       '#ff5fa2',
  accentDim:    '#c2467b',
  danger:       '#ff4d4d',
  warning:      '#ffc24b',
  success:      '#5cff9d',
  ink:          '#07121a',
  ink2:         '#0d1f2b',
  paper:        '#eaf6ff',
};

/* 캔버스 아트 색 — 비주얼/VFX 가 사용 (--art-* 와 1:1) */
export const ART = {
  /* 배경/월드 */
  bgDeep:        '#07121a',
  bgGrid:        'rgba(120, 200, 220, 0.06)',
  bgGridMajor:   'rgba(120, 200, 220, 0.10)',
  worldBorder:   'rgba(255, 95, 162, 0.45)',

  /* 먹이 (다채) — 인덱스로 순환 사용 */
  food: ['#ff6b6b', '#ffd93d', '#6bff95', '#5cc8ff', '#c08bff'],
  food1: '#ff6b6b', food2: '#ffd93d', food3: '#6bff95', food4: '#5cc8ff', food5: '#c08bff',

  /* 플레이어 세포 */
  cellSelf:      '#2de2c0',
  cellSelfCore:  '#aef9ec',

  /* 봇 세포(소속별 hue) — bots[id % bots.length] 로 배정 */
  cellBots: ['#ff5fa2', '#ffa14b', '#7c6bff', '#4bd0ff', '#9bff5c', '#ff7bd5'],
  cellBot1: '#ff5fa2', cellBot2: '#ffa14b', cellBot3: '#7c6bff',
  cellBot4: '#4bd0ff', cellBot5: '#9bff5c', cellBot6: '#ff7bd5',

  /* 세포 디테일 — 멤브레인/핵/소기관 */
  cellMembrane:  'rgba(255, 255, 255, 0.55)',
  cellNucleus:   'rgba(7, 18, 26, 0.55)',
  cellOrganelle: 'rgba(255, 255, 255, 0.18)',

  /* 바이러스(지뢰) */
  virusFill:     '#4cff7a',
  virusSpike:    '#1f7a3c',
  virusGlow:     'rgba(76, 255, 122, 0.55)',
  virusShot:     '#aaff5c',

  /* 위험/이펙트 */
  danger:        '#ff4d4d',
  eject:         '#ffe08a',
};

/* 비색상/모션 토큰 — 캔버스 측이 참조할 수 있는 값 */
export const TOKENS = {
  minimapSize: 200,           // px (--ui-minimap-size 정수값)
  worldGridStep: 64,          // 아트 그리드 간격(참고값, 게임팀과 합의 시 갱신)
  easeOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
  durFast: 120,
  durMed: 220,
};

/* 편의: 봇 색을 id로 안정 배정 */
export function botColor(id) {
  const n = (typeof id === 'number' ? id : String(id).length);
  return ART.cellBots[Math.abs(n) % ART.cellBots.length];
}
/* 편의: 먹이 색 순환 */
export function foodColor(i) {
  return ART.food[Math.abs(i | 0) % ART.food.length];
}

export default { BRAND, ART, TOKENS, botColor, foodColor };
