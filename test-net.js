/* 헤드리스 네트워크 검증 — 실제 서버에 2클라 접속, 권위 동기화 확인
 * 자립: 외부에 서버가 떠 있다고 가정하지 않고 같은 PORT 로 직접 spawn 한다
 * (검증 도구가 외부 전역 PORT/기동 상태에 의존하면 null→크래시로 위양성 FAIL). */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.PORT || 3010;
const URL = `ws://localhost:${PORT}`;
let pass = 0, fail = 0, errors = 0;
function ok(n, c, e) { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); }

const _srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore',
});
process.on('exit', () => { try { _srv.kill('SIGINT'); } catch (e) {} });

function mkClient(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const c = { ws, name, id: null, snaps: 0, last: null, welcome: false };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') { c.id = m.id; c.welcome = true; }
      else if (m.t === 'state') { c.snaps++; c.last = m; }
    };
    ws.onerror = () => { errors++; };
    setTimeout(() => resolve(c), 400);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(800); // 자체 spawn 한 서버 기동 대기
  const A = await mkClient('Alice');
  const B = await mkClient('Bob');
  ok('두 클라 welcome 수신(접속+핸드셰이크)', A.welcome && B.welcome, `A=${A.id} B=${B.id}`);

  await sleep(600);
  ok('두 클라 state 스냅샷 수신', A.snaps > 3 && B.snaps > 3, `A=${A.snaps} B=${B.snaps}`);

  // 스냅샷 미수신이면 이후 단언은 의미 없음 → fail-fast(널 역참조 크래시 방지)
  if (!A.last || !B.last) {
    ok('스냅샷 수신 후속 검증 가능', false, '첫 스냅샷 미수신 — 서버 기동/접속 실패');
    console.log(`\n=== ${pass} passed, ${fail} failed, errors=${errors} ===`);
    process.exit(1);
  }

  // 같은 월드 권위 공유: A·B의 blips(전역 좌표)가 같은 셀 집합을 가리킴.
  // (cells 배열은 각 클라 시야로 컬링되므로 전역 검증은 blips로 한다 — agar 식 정상 동작)
  const aBlipCount = A.last.blips.length, bBlipCount = B.last.blips.length;
  ok('A·B가 같은 월드 관측(전역 셀 수 일치, 서버 권위 공유)', aBlipCount === bBlipCount && aBlipCount >= 12,
     `A.blips=${aBlipCount} B.blips=${bBlipCount}`);
  // A는 자기 셀을 자기 시야에서 항상 본다(카메라 추적)
  const aOwnCell = A.last.cells.find(c => c.owner === A.id);
  ok('A는 자기 셀을 관측(카메라 추적)', !!aOwnCell, aOwnCell ? `pos=(${aOwnCell.x},${aOwnCell.y})` : 'none');

  // A 이동 → B가 보는 전역(blips) 상에서 A의 위치가 변하는가 (실시간 반영)
  // A의 blip을 자기 셀 위치로 식별(가장 가까운 blip 추적)
  const findABlip = (snap, ref) => snap.blips.filter(bl => bl.owner === A.id)
    .sort((p, q) => Math.hypot(p.x - ref.x, p.y - ref.y) - Math.hypot(q.x - ref.x, q.y - ref.y))[0];
  const aAlive = () => A.last && A.last.you && A.last.you.alive;
  // 이동 동기화 1회 측정. A가 이동 중 다른 셀에 먹히면(정상 게임플레이) 무효 →
  // 재참가 후 재시도. 측정 자체가 '죽음' 때문에 흔들리지 않게 한다(검증 도구 자립).
  async function measureMove() {
    let cell = A.last.cells.find(c => c.owner === A.id);
    if (!cell) { A.ws.send(JSON.stringify({ t: 'join', name: 'Alice' })); await sleep(400); cell = A.last.cells.find(c => c.owner === A.id); }
    const ref0 = { x: cell.x, y: cell.y };
    const before = findABlip(B.last, ref0);
    const push = setInterval(() => A.ws.send(JSON.stringify({ t: 'input', dx: 1000, dy: 600 })), 50);
    await sleep(1300);
    clearInterval(push);
    const after = findABlip(B.last, before || ref0);
    return { before, after, survived: aAlive() };
  }
  let mv = await measureMove();
  if (!mv.before || !mv.after) mv = await measureMove();   // 죽음으로 무효면 1회 재시도
  const beforeB = mv.before, afterB = mv.after;
  const moved = beforeB && afterB && Math.hypot(afterB.x - beforeB.x, afterB.y - beforeB.y) > 30;
  ok('A의 이동이 B의 전역 관측에 즉시 반영', !!moved,
     beforeB && afterB ? `(${beforeB.x},${beforeB.y})->(${afterB.x},${afterB.y})` : 'no blip');

  // 액션 송신 시 서버 에러 없이 동작 (split/eject/boost)
  A.ws.send(JSON.stringify({ t: 'split' }));
  A.ws.send(JSON.stringify({ t: 'eject' }));
  A.ws.send(JSON.stringify({ t: 'boost' }));
  A.ws.send(JSON.stringify({ t: 'garbage', x: undefined }));   // 변조/이상 입력
  A.ws.send('not json at all');                                // 깨진 메시지
  await sleep(400);
  ok('이상/변조 메시지에도 서버 생존(에러 0)', errors === 0, `errors=${errors}`);

  // 봇이 온라인으로 함께 보이는가(전역 blips) + 리더보드
  const botBlips = B.last.blips.filter(c => /^bot\d+$/.test(c.owner));
  ok('봇 8~12마리 같은 월드에 온라인(전역)', botBlips.length >= 8 && botBlips.length <= 12, `botBlips=${botBlips.length}`);
  ok('리더보드 top10 전송', Array.isArray(B.last.leaderboard) && B.last.leaderboard.length > 0, `lb=${B.last.leaderboard.length}`);
  ok('미니맵 blips 전송', Array.isArray(B.last.blips) && B.last.blips.length > 0, `blips=${B.last.blips.length}`);

  // 스냅샷 레이트 ≈ 20Hz
  const start = A.snaps; await sleep(1000); const rate = A.snaps - start;
  ok('스냅샷 레이트 ≈ 20Hz', rate >= 15 && rate <= 25, `rate=${rate}/s`);

  // 접속 종료 → 정리
  A.ws.close(); B.ws.close();
  await sleep(200);
  console.log(`\n=== ${pass} passed, ${fail} failed, errors=${errors} ===`);
  process.exit(fail || errors ? 1 : 0);
})();
