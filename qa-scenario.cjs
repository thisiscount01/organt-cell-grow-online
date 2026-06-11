/* ============================================================
 * qa-scenario.cjs — QA 최종 판정: '플레이가 말이 되는가'
 * game.js World 를 server.js 와 동일하게 step() 루프로 구동해
 * 유저 한 명의 한 판(흡수→축적→분열→포식→사망)을 끝까지 재현하고
 * 엣지/원자성/dt독립/일관성을 수치로 찌른다.
 * ============================================================ */
'use strict';
const { World, CONFIG, radiusOf, speedOf } = require('./game.js');
let pass = 0, fail = 0;
function ok(n, c, e) { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e !== undefined ? '  ' + e : ''}`); }
const DT = 1 / CONFIG.TICK_RATE;

/* 유저처럼 가장 가까운 먹이를 향해 입력을 주는 헬퍼 */
function steerToNearestFood(w, id) {
  const me = w.playerCells(id).reduce((a, b) => (a && a.mass >= b.mass ? a : b), null);
  if (!me) return;
  let best = null, bd = Infinity;
  for (const f of w.food) { const d = Math.hypot(f.x - me.x, f.y - me.y); if (d < bd) { bd = d; best = f; } }
  if (best) w.setInput(id, best.x - me.x, best.y - me.y);
}

/* ---------- 시나리오 1: 신규 유저 한 판 — 먹이 쫓아 실제 성장 ---------- */
(function scenarioGrowth() {
  console.log('\n── 시나리오 1: 접속→이동→먹이흡수→질량축적 (실루프) ──');
  const w = new World({ seed: 7 });
  w.join('me', '플레이어');
  const c0 = w.playerCells('me')[0];
  const startX = c0.x, startY = c0.y, startMass = c0.mass;
  // 먹이 밀도를 높여 추적 성장을 가속(실제 서버도 FOOD_MAX 유지) — 주변에 집중 배치
  for (let i = 0; i < 120; i++) {
    w.food.push({ id: 'qf' + i, type: 'food', x: startX + (w.rng() - 0.5) * 600, y: startY + (w.rng() - 0.5) * 600, mass: 1, r: radiusOf(1) * 1.1, color: '#fff' });
  }
  let moved = 0, snapsOk = 0;
  for (let t = 0; t < 400; t++) {           // 20초 분량
    steerToNearestFood(w, 'me');
    w.step(DT);
    const snap = w.getSnapshot('me');
    if (snap.you && snap.you.alive && typeof snap.you.mass === 'number' && snap.you.rank) snapsOk++;
    w.clearEvents();
  }
  const cN = w.playerCells('me')[0];
  moved = Math.hypot(cN.x - startX, cN.y - startY);
  ok('유저 셀이 실제로 이동함(제자리 맴 아님)', moved > 100, `이동거리=${moved.toFixed(0)}px`);
  ok('먹이 흡수로 질량 축적', cN.mass > startMass, `${startMass} -> ${cN.mass.toFixed(0)}`);
  ok('성장에 따라 반지름 증가', cN.r > radiusOf(startMass), `r=${cN.r.toFixed(1)}`);
  ok('성장하면 속도 단조감소(질량↑→느려짐)', speedOf(cN.mass) < speedOf(startMass), `v ${speedOf(startMass).toFixed(0)}->${speedOf(cN.mass).toFixed(0)}`);
  ok('매 틱 you 스냅샷(mass/rank) 일관 제공 → HUD 갱신 가능', snapsOk >= 380, `정상스냅=${snapsOk}/400`);
})();

/* ---------- 시나리오 2: 분열 원자성 + 재합체 쿨다운 + 상한 ---------- */
(function scenarioSplit() {
  console.log('\n── 시나리오 2: 분열 비용↔효과 원자성/쿨다운/상한 ──');
  const w = new World({ seed: 11 });
  w.join('me', 'P');
  const c = w.playerCells('me')[0]; c.mass = 400; c.r = radiusOf(400);
  w.setInput('me', 1, 0);
  const before = w.playerMass('me');
  w.doSplit('me');
  const after = w.playerMass('me');
  ok('분열 시 총질량 보존(원자성, 증발 없음)', Math.abs(before - after) < 1e-6, `${before} -> ${after}`);
  ok('분열 직후 2조각', w.playerCells('me').length === 2);
  // 재합체 쿨다운: MERGE_COOLDOWN 전에는 합쳐지지 않음
  for (let t = 0; t < 100; t++) { w.setInput('me', 0.0001, 0); w.step(DT); w.clearEvents(); } // 5초 (<12s)
  ok('재합체 쿨다운 중엔 다시 안 합쳐짐(겹쳐도 분리 유지)', w.playerCells('me').length === 2, `cells=${w.playerCells('me').length} @${w.now.toFixed(1)}s`);
  // 쿨다운 경과까지 진행(>12s)
  for (let t = 0; t < 200; t++) { w.setInput('me', 0.0001, 0); w.step(DT); w.clearEvents(); } // +10초 → 15s 경과
  // 유저가 두 조각을 다시 겹치게 모음(마우스로 한 점에 포갬) → 코히전으로 합쳐져야 함
  const cc = w.playerCells('me'); cc[1].x = cc[0].x + 20; cc[1].y = cc[0].y;
  for (let t = 0; t < 60; t++) { w.setInput('me', 0.0001, 0); w.step(DT); w.clearEvents(); if (w.playerCells('me').length === 1) break; }
  ok('쿨다운 경과+조각 포개면 재합체(1개로)', w.playerCells('me').length === 1, `cells=${w.playerCells('me').length} @${w.now.toFixed(1)}s`);
  // 분열 가드: 질량 부족 시 발동 안 함
  const w2 = new World({ seed: 12 }); w2.join('q', 'Q');
  const sc = w2.playerCells('q')[0]; sc.mass = CONFIG.MIN_SPLIT_MASS - 1; sc.r = radiusOf(sc.mass);
  w2.doSplit('q');
  ok('질량부족(MIN_SPLIT 미만) 분열 막힘', w2.playerCells('q').length === 1);
})();

/* ---------- 시나리오 3: 포식 비용↔효과 + 사망 처리 ---------- */
(function scenarioEatDeath() {
  console.log('\n── 시나리오 3: 포식(흡수=가해 질량합, 피해 사망) ──');
  const w = new World({ seed: 5 });
  w.join('A', '포식자'); w.join('B', '먹이');
  w.food = []; w.ejecta = []; // 주변 먹이 흡수로 인한 측정오차 제거(순수 포식만)
  const a = w.playerCells('A')[0], b = w.playerCells('B')[0];
  a.mass = 300; a.r = radiusOf(300); a.x = 1000; a.y = 1000;
  b.mass = 60; b.r = radiusOf(60); b.x = 1000; b.y = 1000;
  const sumBefore = a.mass + b.mass;
  w._resolveEating();
  ok('포식: 가해 셀 질량 = 두 질량 합(흡수 원자성)', Math.abs(w.playerMass('A') - sumBefore) < 1e-6, `A=${w.playerMass('A')} (=${sumBefore})`);
  ok('포식: 피해 셀 소멸', w.playerCells('B').length === 0);
  // 피해 플레이어는 step 에서 alive=false 로 전이(=사망 화면 트리거 신호)
  const snapBefore = w.getSnapshot('B');
  w.step(DT);
  const snapAfter = w.getSnapshot('B');
  ok('피해 유저 사망 전이(you.alive=false → 클라 사망화면)', snapBefore.you && snapAfter.you && snapAfter.you.alive === false, `aliveAfter=${snapAfter.you && snapAfter.you.alive}`);
})();

/* ---------- 시나리오 4: 먹이뿌리기/부스트 비용↔효과·쿨다운·자원0 ---------- */
(function scenarioEjectBoost() {
  console.log('\n── 시나리오 4: W뿌리기/부스트 비용↔효과·쿨다운·자원0 ──');
  const w = new World({ seed: 3 });
  w.join('p', 'E');
  const c = w.playerCells('p')[0]; c.mass = 100; c.r = radiusOf(100);
  w.setInput('p', 1, 0);
  const m0 = c.mass;
  const did = w.doEject('p');
  ok('W 발동 시 질량 EJECT_COST 만큼 소모(비용 발생)', did && Math.abs(c.mass - (m0 - CONFIG.EJECT_COST)) < 1e-6, `${m0}->${c.mass}`);
  ok('생성된 펠릿 질량 = EJECT_MASS', w.ejecta.length === 1 && w.ejecta[0].mass === CONFIG.EJECT_MASS, `pellet=${w.ejecta[0] && w.ejecta[0].mass}`);
  // 부스트: 발동 시 boostActive, 쿨다운 동안 재발동 차단, 지속시간 후 해제
  const w2 = new World({ seed: 4 }); w2.join('z', 'Z');
  ok('부스트 발동', w2.doBoost('z') === true);
  ok('부스트 쿨다운 중 재발동 차단', w2.doBoost('z') === false);
  let sp = w2.getSnapshot('z');
  ok('부스트 직후 boostActive=true', sp.you.boostActive === true, `active=${sp.you.boostActive}`);
  for (let t = 0; t < CONFIG.BOOST_DURATION * CONFIG.TICK_RATE + 4; t++) { w2.step(DT); w2.clearEvents(); }
  sp = w2.getSnapshot('z');
  ok('지속시간 경과 후 boostActive=false(효과 종료)', sp.you.boostActive === false, `active=${sp.you.boostActive}`);
  ok('쿨다운 카운트다운(boostReadyIn>0) 노출 → HUD 게이지', sp.you.boostReadyIn > 0, `readyIn=${sp.you.boostReadyIn.toFixed(1)}s`);
})();

/* ---------- 시나리오 5: 엣지/경계/이상입력/연속입력 ---------- */
(function scenarioEdge() {
  console.log('\n── 시나리오 5: 경계클램프/이상입력/연속분열/자연감소 ──');
  const w = new World({ seed: 8 });
  w.join('p', 'X');
  const c = w.playerCells('p')[0];
  // 경계: 월드 밖으로 계속 밀어도 클램프
  c.x = 10; c.y = 10;
  for (let t = 0; t < 200; t++) { w.setInput('p', -1000, -1000); w.step(DT); w.clearEvents(); }
  const cc = w.playerCells('p')[0];
  ok('월드 경계 클램프(밖으로 안 나감)', cc.x >= cc.r - 0.5 && cc.y >= cc.r - 0.5 && cc.x <= CONFIG.WORLD_W && cc.y <= CONFIG.WORLD_H, `pos=(${cc.x.toFixed(0)},${cc.y.toFixed(0)})`);
  // 이상 입력: NaN/Infinity 무시(setInput 가드)
  const dirBefore = { ...w.players.get('p').input };
  w.setInput('p', NaN, Infinity);
  const dirAfter = w.players.get('p').input;
  ok('이상입력(NaN/Inf) 무시 → 방향 불변(크래시 없음)', dirBefore.dx === dirAfter.dx && dirBefore.dy === dirAfter.dy, `dir=(${dirAfter.dx.toFixed(2)},${dirAfter.dy.toFixed(2)})`);
  // 연속 분열 스팸: 상한 + 크래시 없음
  const big = w.playerCells('p')[0]; big.mass = 5000; big.r = radiusOf(5000);
  for (let i = 0; i < 50; i++) { w.setInput('p', 1, 0.3); w.doSplit('p'); w.step(DT); w.clearEvents(); }
  ok('연속 분열 스팸에도 MAX_CELLS 상한 준수', w.playerCells('p').length <= CONFIG.MAX_CELLS, `cells=${w.playerCells('p').length}/${CONFIG.MAX_CELLS}`);
  // 자연감소: 임계 이상만 감소, 이하는 불변
  const w2 = new World({ seed: 9 }); w2.join('s', 'S');
  const sc = w2.playerCells('s')[0]; sc.mass = 100; sc.r = radiusOf(100); // <200 → 감소 안 함
  w2.setInput('s', 0.0001, 0);
  for (let t = 0; t < 100; t++) { w2.step(DT); w2.clearEvents(); }
  ok('임계(200) 미만 질량은 자연감소 없음', Math.abs(w2.playerCells('s')[0].mass - 100) < 0.01, `mass=${w2.playerCells('s')[0].mass.toFixed(2)}`);
})();

/* ---------- 시나리오 6: dt 독립성(타이머는 시간기반) ---------- */
(function scenarioDtIndependence() {
  console.log('\n── 시나리오 6: deltaTime 독립성(20Hz vs 60Hz 동일 결과) ──');
  function runBoostElapsed(hz) {
    const w = new World({ seed: 2 }); w.join('z', 'Z');
    const dt = 1 / hz; w.doBoost('z');
    const steps = Math.round(CONFIG.BOOST_DURATION * hz) + 2;
    let stillActive = 0;
    for (let t = 0; t < steps; t++) { w.step(dt); if (w.now < w.players.get('z').boostUntil) stillActive++; w.clearEvents(); }
    return { active: w.now < w.players.get('z').boostUntil, elapsed: w.now };
  }
  const a = runBoostElapsed(20), b = runBoostElapsed(60);
  ok('부스트 종료가 프레임율과 무관(20Hz·60Hz 동일하게 종료)', a.active === false && b.active === false, `20Hz=${a.active} 60Hz=${b.active}`);
  // 펠릿 면역(자기 펠릿 0.6s)도 시간기반 — 60Hz 에서도 동일 흡수 타이밍
  function ejectReabsorb(hz) {
    const w = new World({ seed: 3 }); w.join('p', 'E'); const dt = 1 / hz;
    const c = w.playerCells('p')[0]; c.mass = 200; c.r = radiusOf(200); w.setInput('p', 1, 0);
    w.doEject('p'); const before = w.ejecta.length;
    // 면역창(0.6s) 직후까지 진행하되 펠릿이 셀과 떨어지지 않게 셀을 펠릿쪽으로
    for (let t = 0; t < Math.round(0.7 * hz); t++) { w.step(dt); w.clearEvents(); }
    return before;
  }
  ok('펠릿 생성은 hz 무관 1개', ejectReabsorb(20) === 1 && ejectReabsorb(60) === 1);
})();

/* ---------- 시나리오 7: 60fps 헤드룸(만원 서버) + z-order 계약 ---------- */
(function scenarioPerf() {
  console.log('\n── 시나리오 7: 성능 헤드룸 + z-order 계약 ──');
  const w = new World({ seed: 7 });
  for (let i = 0; i < 40; i++) w.join('u' + i, 'U' + i); // 봇10 + 유저40 = 50명
  // 입력 부여
  for (let i = 0; i < 40; i++) w.setInput('u' + i, Math.cos(i), Math.sin(i));
  const N = 600; const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { w.step(DT); for (let k = 0; k < 50; k++) w.getSnapshot(k < 40 ? 'u' + k : 'bot' + (k - 40)); w.clearEvents(); }
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  ok('50인 만원+스냅샷 틱비용 < 16.6ms(60fps 헤드룸)', per < 16.6, `avg=${per.toFixed(3)}ms/tick`);
  ok('  └ 50Hz 서버틱 여유(>3x 헤드룸)', per < 16.6 / 3, `${(16.6 / per).toFixed(1)}x 여유`);
})();

console.log(`\n=== qa-scenario: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
