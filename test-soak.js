/* e2e 소크: 한 클라가 네트워크 너머로 먹이를 먹어 실제 성장하는지 + 부하 안정성 */
'use strict';
const PORT = process.env.PORT || 3020;
const URL = `ws://localhost:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let errors = 0;

(async () => {
  const ws = new WebSocket(URL);
  let id = null, last = null, snaps = 0, m0 = null, mMax = 0;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: '먹보' }));
  ws.onerror = () => errors++;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') id = m.id;
    else if (m.t === 'state') {
      snaps++; last = m;
      if (m.you) { if (m0 == null) m0 = m.you.mass; mMax = Math.max(mMax, m.you.mass); }
    }
  };
  await sleep(500);

  // 8초간: 내 셀을 가장 가까운 먹이 쪽으로 계속 몰기 + 가끔 부스트
  const t0 = Date.now();
  let ticks = 0;
  while (Date.now() - t0 < 8000) {
    if (last && last.you && last.cells.length) {
      const me = last.cells.find(c => c.owner === id);
      if (me && last.food.length) {
        let best = last.food[0], bd = 1e9;
        for (const f of last.food) { const d = Math.hypot(f.x - me.x, f.y - me.y); if (d < bd) { bd = d; best = f; } }
        ws.send(JSON.stringify({ t: 'input', dx: best.x - me.x, dy: best.y - me.y }));
      }
    }
    if ((ticks % 60) === 30) ws.send(JSON.stringify({ t: 'boost' }));
    ticks++;
    await sleep(50);
  }

  console.log(`초기질량=${m0}  최대질량=${mMax}  스냅샷=${snaps}  errors=${errors}`);
  const grew = mMax > m0;
  const steady = snaps > 130; // ~8.5s * 20Hz 근사
  console.log(`${grew ? 'PASS' : 'FAIL'}  네트워크 너머 먹이 섭취로 실제 성장 (${m0} -> ${mMax})`);
  console.log(`${steady ? 'PASS' : 'FAIL'}  스냅샷 지속 수신(끊김 없음) snaps=${snaps}`);
  console.log(`${errors === 0 ? 'PASS' : 'FAIL'}  에러 0`);
  ws.close();
  await sleep(150);
  process.exit((grew && steady && errors === 0) ? 0 : 1);
})();
