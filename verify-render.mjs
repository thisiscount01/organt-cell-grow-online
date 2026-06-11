/* ============================================================
 * verify-render.mjs — 클라 렌더 경로 무결성 (헤드리스, 무의존)
 *
 * "맵은 보이는데 먹이/적/나의 모습이 안 보임"의 단골 원인은 렌더 루프가
 * 배경(그리드)까지 그린 뒤 엔티티 draw 에서 throw 로 중단되는 것이다.
 * 특히 서버가 발급한 base36 string id 를 클라가 숫자로 오용하면 NaN →
 * createRadialGradient/arc 가 throw → rAF 루프 정지 → 엔티티 증발.
 *
 * 이 검증기는 캔버스 없이도 그 함정을 잡는다:
 *  - 실제 game.js World 의 getSnapshot() 으로 진짜 엔티티(string id)를 만든다.
 *  - 캔버스 2D API 를 mock 하되, 좌표/반지름에 NaN/Inf 가 들어오면 실제
 *    브라우저 캔버스처럼 throw 하게 해 '조용한 NaN'까지 실패로 드러낸다.
 *  - cell-art.js 의 drawCell/Food/Virus/Eject/Shot 을 모든 엔티티에 대해 호출,
 *    한 번이라도 throw 하면 FAIL.
 * tokens.js/cell-art.js 는 브라우저 ESM(import/export, window 등록)이라 Node 가
 * 직접 require 못 하므로, 소스를 읽어 import/export 를 벗기고 ART 를 주입해 평가한다.
 * ============================================================ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { World } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(__dirname, 'public', f), 'utf8');

/* ART 추출: tokens.js 의 export 들을 벗겨 평가 */
const tokensSrc = read('tokens.js')
  .replace(/export\s+default[\s\S]*$/m, '')
  .replace(/export\s+/g, '');
const ART = Function(tokensSrc + '\nreturn ART;')();

/* cell-art.js: import 라인 제거, export/ window 등록 제거 후 함수 묶음 반환 */
let caSrc = read('cell-art.js')
  .replace(/^\s*import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/m, '')
  .replace(/if \(typeof window[\s\S]*?window\.CellArt = CellArt;\s*}/, '')
  .replace(/export\s+\{[^}]*\};?/g, '')
  .replace(/export\s+default[^;]*;?/g, '');
const CellArt = Function('ART', caSrc + '\nreturn CellArt;')(ART);

/* NaN/Inf 를 실제 캔버스처럼 거부하는 mock 2D ctx */
let drawCalls = 0;
function num(label, ...vals) {
  for (const v of vals) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${label}: 비유한 좌표/값 ${v} (NaN/Inf → 실제 캔버스 throw 재현)`);
    }
  }
}
const gradient = { addColorStop(stop, col) { num('addColorStop.stop', stop); if (typeof col !== 'string') throw new Error('addColorStop color 가 string 이 아님: ' + col); } };
const ctx = {
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', lineJoin: '', lineCap: '',
  save() {}, restore() {}, beginPath() {}, closePath() {}, fill() { drawCalls++; }, stroke() { drawCalls++; },
  moveTo(x, y) { num('moveTo', x, y); }, lineTo(x, y) { num('lineTo', x, y); },
  arc(x, y, r, a0, a1) { num('arc', x, y, r, a0, a1); if (r < 0) throw new Error('arc 반지름 음수: ' + r); },
  quadraticCurveTo(cx, cy, x, y) { num('quadraticCurveTo', cx, cy, x, y); },
  fillRect(x, y, w, h) { num('fillRect', x, y, w, h); },
  fillText(t, x, y) { num('fillText', x, y); }, strokeText(t, x, y) { num('strokeText', x, y); },
  createRadialGradient(x0, y0, r0, x1, y1, r1) { num('createRadialGradient', x0, y0, r0, x1, y1, r1); if (r0 < 0 || r1 < 0) throw new Error('gradient 반지름 음수'); return gradient; },
  setTransform() {}, translate() {}, scale() {},
};

/* 실제 서버 스냅샷으로 엔티티 확보 */
const world = new World({ seed: 7 });
world.join('p1', '플레이어한글');
for (let i = 0; i < 40; i++) world.step(1 / 20); // 봇/먹이/바이러스가 움직인 실제 상태
const snap = world.getSnapshot('p1');
const view = { scale: 0.5, camX: snap.camera.x, camY: snap.camera.y, time: 12.34, world: { w: 6000, h: 6000 } };

let fails = 0;
function tryDraw(label, fn, item) {
  try { fn(); }
  catch (e) { fails++; console.log(`  FAIL ${label} id=${item && item.id}: ${e.message}`); }
}

console.log('[렌더 경로] 실제 base36 id 엔티티에 대해 CellArt 전 함수 호출');
console.log(`  스냅샷: cells=${snap.cells.length} food=${snap.food.length} viruses=${snap.viruses.length} (id예: cell="${snap.cells[0] && snap.cells[0].id}", food="${snap.food[0] && snap.food[0].id}")`);

for (const c of snap.cells) tryDraw('drawCell', () => CellArt.drawCell(ctx, c, view), c);
for (const f of snap.food) tryDraw('drawFood', () => CellArt.drawFood(ctx, f, view), f);
for (const v of snap.viruses) tryDraw('drawVirus', () => CellArt.drawVirus(ctx, v, view), v);
// eject/shot 은 액션으로 생성해 확인
world.doEject('p1');
for (let i = 0; i < 3; i++) world.step(1 / 20);
const snap2 = world.getSnapshot('p1');
for (const e of snap2.eject) tryDraw('drawEject', () => CellArt.drawEject(ctx, e, view), e);
for (const s of snap2.shots) tryDraw('drawShot', () => CellArt.drawShot(ctx, s, view), s);

// 적대적 엣지: 숫자형 id, 빈 색, r=0/음수 등으로도 throw 안 하는지
console.log('[엣지] 비정상 입력 방어(숫자 id / 색 없음 / r=0)');
const edge = [
  { id: 12345, x: 100, y: 100, r: 0, mass: 10, color: '', type: 'player', name: 'X' },
  { id: null, x: 200, y: 200, r: -5, mass: 0, color: undefined, type: 'bot', name: '' },
  { id: 'zz', x: 300, y: 300, r: 50, mass: 9999, color: '#2de2c0', type: 'player', name: '큰세포' },
];
for (const c of edge) tryDraw('drawCell(edge)', () => CellArt.drawCell(ctx, c, view), c);

console.log(`\n총 draw 호출(fill/stroke): ${drawCalls}, 실패: ${fails}`);
console.log(fails === 0
  ? 'RENDER PASS ✅ — 모든 엔티티가 base36 id/엣지 입력에서도 throw 없이 그려짐(맵+엔티티 동시 렌더 보장)'
  : `RENDER FAIL ❌ — ${fails}개 draw 가 throw(엔티티 증발 원인)`);
process.exit(fails === 0 ? 0 : 1);
