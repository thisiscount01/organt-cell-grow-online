'use strict';
/* ============================================================
 * diag-e2e.js — 프로덕션 동일 경로 E2E 검증 (무의존, 자립)
 *
 * 서버를 같은 PORT 로 직접 spawn → HTTP 정적 자산 MIME 확인 →
 * WS join(한글 닉) → 첫 state 스냅샷에 브라우저가 '그릴' 엔티티
 * (내 세포 / 먹이 / 바이러스)가 base36 string id 로 담기는지 단언.
 * 이어서 가장 가까운 적(블립) 방향으로 이동 입력을 넣어, 적 세포가
 * 실제로 시야 스냅샷에 '들어오는지'까지 확인 → "적이 안 보임" 증상이
 * 데이터 경로에서 해소됨을 run 증거로 못 박는다.
 *
 * PORT 는 server.js 와 반드시 같아야 한다(기본 3060 으로 통일).
 * 외부 전역 PORT 의존 없이 자체 spawn 하므로 null/포트불일치가 안 난다.
 * ============================================================ */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3060;
const HOST = `localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${HOST}${p}`, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body }));
    });
    req.on('error', reject);
  });
}

let fails = 0;
function assert(cond, msg) {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) fails++;
}

(async () => {
  // 1) 서버 spawn (같은 PORT)
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore',
  });
  const cleanup = () => { try { srv.kill('SIGINT'); } catch (e) {} };
  process.on('exit', cleanup);

  await sleep(800); // 기동 대기

  // 2) 정적 자산 MIME (모듈 로딩 = 엔티티 렌더 모듈도 로드됨)
  console.log('[1] 정적 자산 서빙 / MIME / 무캐시');
  const root = await get('/');
  assert(root.status === 200 && /text\/html/.test(root.type), `/ → ${root.status} ${root.type}`);
  for (const f of ['/app.js', '/cell-art.js', '/tokens.js', '/vfx.js']) {
    const r = await get(f);
    assert(r.status === 200 && /text\/javascript/.test(r.type), `${f} → ${r.status} ${r.type}`);
  }
  const aj = await get('/app.js');
  assert(/no-store/.test(aj.cache || ''), `app.js Cache-Control 무캐시: "${aj.cache}"`);
  const hz = await get('/healthz');
  assert(hz.status === 200 && hz.body === 'ok', `/healthz → ${hz.status} ${hz.body}`);

  // 3) WS join → 첫 스냅샷 엔티티 단언
  console.log('[2] WS join(닉네임) → 첫 state 스냅샷');
  const ws = new WebSocket(`ws://${HOST}`);
  let id = null, last = null;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: '플레이어한글' }));
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === 'welcome') id = m.id; else if (m.t === 'state') last = m; };
  await sleep(900);

  assert(!!last, '첫 state 스냅샷 수신');
  const own = last.cells.filter(c => c.owner === id);
  const idTypes = [...last.cells, ...last.food, ...last.viruses].map(o => typeof o.id);
  const allStrId = idTypes.length > 0 && idTypes.every(t => t === 'string');
  assert(own.length >= 1, `내 세포 ≥1 (실제 ${own.length}) ${own[0] ? `id=${own[0].id} pos=(${own[0].x},${own[0].y}) name=${own[0].name}` : ''}`);
  assert(last.food.length > 0, `먹이 시야 >0 (실제 ${last.food.length})`);
  assert(last.viruses.length > 0, `바이러스 >0 (실제 ${last.viruses.length})`);
  assert(allStrId, `모든 엔티티 id 가 base36 string (예: "${last.cells[0] && last.cells[0].id}")`);
  assert(Array.isArray(last.eject) && Array.isArray(last.shots), 'eject/shots 배열 존재');
  // 적은 미니맵(blips)엔 전역으로 항상 보인다 → 적 데이터가 라이브에 존재함을 증명
  const enemyBlips = (last.blips || []).filter(b => b.owner !== id);
  assert(enemyBlips.length > 0, `적 세포(미니맵 blips, 전역) >0 (실제 ${enemyBlips.length})`);

  // 4) 적 쪽으로 이동 → 적 세포가 시야 스냅샷에 '들어오는지' (= 화면에 그려짐)
  console.log('[3] 적 방향 이동 → 적 세포가 시야(스냅샷)에 진입');
  let sawEnemyInView = last.cells.some(c => c.owner !== id);
  for (let step = 0; step < 60 && !sawEnemyInView; step++) {
    const me = last.cells.filter(c => c.owner === id)[0];
    if (me) {
      // 가장 가까운 적 블립 방향으로 이동 입력
      let tx = me.x, ty = me.y, bd = Infinity;
      for (const b of last.blips) {
        if (b.owner === id) continue;
        const d = Math.hypot(b.x - me.x, b.y - me.y);
        if (d < bd) { bd = d; tx = b.x; ty = b.y; }
      }
      ws.send(JSON.stringify({ t: 'input', dx: tx - me.x, dy: ty - me.y }));
    }
    await sleep(120);
    sawEnemyInView = last.cells.some(c => c.owner !== id);
  }
  const enemiesInView = last.cells.filter(c => c.owner !== id);
  assert(sawEnemyInView, `이동 후 적 세포가 시야 스냅샷에 진입 (실제 ${enemiesInView.length}) ${enemiesInView[0] ? `id=${enemiesInView[0].id} name=${enemiesInView[0].name}` : ''}`);

  // 5) 직렬화 무결성: JSON 라운드트립 시 예외/순환참조 없음
  console.log('[4] 스냅샷 JSON 직렬화 무결성');
  let serializeOK = true;
  try { JSON.parse(JSON.stringify(last)); } catch (e) { serializeOK = false; }
  assert(serializeOK, '스냅샷 JSON.stringify 라운드트립 무예외');

  ws.close();
  await sleep(150);
  cleanup();
  console.log(fails === 0
    ? '\nE2E PASS ✅ — 닉네임 입장 후 내세포+먹이+바이러스 즉시 + 적 세포 시야진입까지 라이브 데이터로 확인'
    : `\nE2E FAIL ❌ — ${fails}개 단언 실패`);
  await sleep(80);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('E2E 예외:', e); process.exit(2); });
