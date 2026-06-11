/* verify-live.mjs — 라이브 wss 서버 실접속 E2E (무의존)
 * 배포된 호스트에 닉네임으로 join → 첫 state 스냅샷에 내세포/먹이/바이러스가
 * base36 string id 로 담겨 오는지, 적이 시야에 진입하는지 라이브로 단언. */
const HOST = process.env.LIVE_HOST || 'organt-cell-grow-online.onrender.com';
const URL = `wss://${HOST}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const assert = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

(async () => {
  console.log('[라이브 WS] ' + URL);
  const ws = new WebSocket(URL);
  let id = null, last = null, opened = false, err = null;
  ws.onopen = () => { opened = true; ws.send(JSON.stringify({ t: 'join', name: '라이브검증' })); };
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === 'welcome') id = m.id; else if (m.t === 'state') last = m; };
  ws.onerror = e => { err = e && (e.message || e.error || 'ws error'); };
  await sleep(2500); // 라이브 RTT + 콜드스타트 여유

  assert(opened, `wss 핸드셰이크 성공${err ? ' (err=' + err + ')' : ''}`);
  assert(!!id, `welcome 수신 id=${id}`);
  assert(!!last, '첫 state 스냅샷 수신');
  if (last) {
    const own = last.cells.filter(c => c.owner === id);
    const idTypes = [...last.cells, ...last.food, ...last.viruses].map(o => typeof o.id);
    const allStr = idTypes.length > 0 && idTypes.every(t => t === 'string');
    assert(own.length >= 1, `내 세포 ≥1 (실제 ${own.length}) ${own[0] ? `id=${own[0].id} pos=(${own[0].x},${own[0].y}) name=${own[0].name}` : ''}`);
    assert(last.food.length > 0, `먹이 시야 >0 (실제 ${last.food.length})`);
    assert(last.viruses.length > 0, `바이러스 >0 (실제 ${last.viruses.length})`);
    assert(allStr, `모든 엔티티 id base36 string (예 "${last.cells[0] && last.cells[0].id}")`);
    const enemyBlips = (last.blips || []).filter(b => b.owner !== id);
    assert(enemyBlips.length > 0, `적(미니맵 blips 전역) >0 (실제 ${enemyBlips.length})`);

    // 적 쪽 이동 → 시야 진입
    let sawEnemy = last.cells.some(c => c.owner !== id);
    for (let s = 0; s < 50 && !sawEnemy; s++) {
      const me = last.cells.filter(c => c.owner === id)[0];
      if (me) {
        let tx = me.x, ty = me.y, bd = Infinity;
        for (const b of last.blips) { if (b.owner === id) continue; const d = Math.hypot(b.x - me.x, b.y - me.y); if (d < bd) { bd = d; tx = b.x; ty = b.y; } }
        ws.send(JSON.stringify({ t: 'input', dx: tx - me.x, dy: ty - me.y }));
      }
      await sleep(140);
      sawEnemy = last.cells.some(c => c.owner !== id);
    }
    const ev = last.cells.filter(c => c.owner !== id);
    assert(sawEnemy, `이동 후 적 세포 시야 진입 (실제 ${ev.length}) ${ev[0] ? `id=${ev[0].id} name=${ev[0].name}` : ''}`);
  }
  try { ws.close(); } catch (e) {}
  await sleep(150);
  console.log(fails === 0 ? '\nLIVE E2E PASS ✅ — 라이브에서 닉네임 입장 후 먹이/나/적/바이러스 데이터 정상 도착' : `\nLIVE E2E FAIL ❌ — ${fails} 실패`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('라이브 검증 예외:', e); process.exit(2); });
