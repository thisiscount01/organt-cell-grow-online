/* 헤드리스 코어 검증 — game.js 시뮬레이션을 직접 돌려 성공기준을 수치로 확인 */
'use strict';
const { World, speedOf, radiusOf, CONFIG } = require('./game.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); }

// 1) 속도 단조감소 + 반지름 단조증가
const s10 = speedOf(10), s100 = speedOf(100), s1000 = speedOf(1000);
ok('속도 단조감소 (질량 10>100>1000)', s10 > s100 && s100 > s1000, `v=${s10.toFixed(1)}/${s100.toFixed(1)}/${s1000.toFixed(1)} px/s`);
ok('반지름 단조증가', radiusOf(10) < radiusOf(100) && radiusOf(100) < radiusOf(1000), `r=${radiusOf(10).toFixed(1)}/${radiusOf(100).toFixed(1)}/${radiusOf(1000).toFixed(1)}`);

// 2) 봇 수 8~12 + FSM 상태
const w = new World({ seed: 7 });
const bots = [...w.players.values()].filter(p => p.isBot);
ok('봇 8~12마리', bots.length >= 8 && bots.length <= 12, `count=${bots.length}`);

// 3) 먹이 섭취 → 질량/반지름 증가
const me = w.join('me', '테스터');
const myCell = w.playerCells('me')[0];
const m0 = myCell.mass, r0 = myCell.r;
// 셀 중심에 먹이 강제 배치 후 섭취 판정
for (let i = 0; i < 30; i++) w.food.push({ id: 'f' + i, type: 'food', x: myCell.x, y: myCell.y, mass: 1, r: 2, color: '#fff' });
w._resolveEating();
const myCell2 = w.playerCells('me')[0];
ok('먹이 섭취로 질량 증가', myCell2.mass > m0, `${m0} -> ${myCell2.mass}`);
ok('먹이 섭취로 반지름 증가', myCell2.r > r0, `r ${r0.toFixed(1)} -> ${myCell2.r.toFixed(1)}`);

// 4) 분열: 조각 절반 + 상한
w.cells = w.cells.filter(c => c.owner !== 'me');
const big = w._spawnPlayerCell(me); big.mass = 200; big.r = radiusOf(200);
w.setInput('me', 1, 0);
const before = w.playerCells('me').length;
w.doSplit('me');
const after = w.playerCells('me');
ok('Space 분열로 조각 증가', after.length === before + 1, `${before} -> ${after.length}`);
ok('분열 조각 질량 약 절반', Math.abs(after[0].mass - 100) < 1 && Math.abs(after[1].mass - 100) < 1, `${after.map(c => c.mass)}`);
ok('전방 사출 속도(vx>0)', after.some(c => c.vx > 100), `vx=${after.map(c => Math.round(c.vx))}`);
// 동시 상한
for (let i = 0; i < 40; i++) { w.playerCells('me').forEach(c => { c.mass = 80; c.r = radiusOf(80); }); w.doSplit('me'); }
ok('동시 셀 상한 MAX_CELLS 준수', w.playerCells('me').length <= CONFIG.MAX_CELLS, `cells=${w.playerCells('me').length}/${CONFIG.MAX_CELLS}`);

// 5) W 먹이뿌리기 + 자원0/쿨다운 가드
const w2 = new World({ seed: 3 });
const p2 = w2.join('p2', 'ej');
const c2 = w2.playerCells('p2')[0]; c2.mass = 100; c2.r = radiusOf(100);
w2.setInput('p2', 1, 0);
const ej0 = w2.ejecta.length;
const did = w2.doEject('p2');
ok('W 먹이뿌리기 발동(펠릿 생성)', did && w2.ejecta.length === ej0 + 1, `ejecta=${w2.ejecta.length}`);
// 쿨다운 중 재시도 → 막힘
const did2 = w2.doEject('p2');
ok('쿨다운 중 W 막힘', !did2, `did2=${did2}`);
// 자원 0(작은 셀) → 막힘
w2.now += 1; const small = w2.playerCells('p2')[0]; small.mass = 10; small.r = radiusOf(10);
const did3 = w2.doEject('p2');
ok('자원부족(작은셀) W 막힘', !did3, `did3=${did3}`);

// 6) 포식: 큰 셀이 작은 셀(1.25배) 먹음 (거리+질량)
const w3 = new World({ seed: 5 });
const A = w3.join('A', '큰'); const B = w3.join('B', '작은');
const ca = w3.playerCells('A')[0], cb = w3.playerCells('B')[0];
ca.mass = 200; ca.r = radiusOf(200); ca.x = 1000; ca.y = 1000;
cb.mass = 50; cb.r = radiusOf(50); cb.x = 1000; cb.y = 1000; // 겹침
w3._resolveEating();
ok('포식: 큰 셀이 작은 셀 흡수', w3.playerCells('A').length === 1 && w3.playerCells('B').length === 0, `Amass=${w3.playerMass('A')}`);
// 1.25배 미만이면 포식 불가
const w3b = new World({ seed: 6 });
const A2 = w3b.join('A2', 'x'); const B2 = w3b.join('B2', 'y');
const ca2 = w3b.playerCells('A2')[0], cb2 = w3b.playerCells('B2')[0];
ca2.mass = 100; ca2.r = radiusOf(100); ca2.x = 500; ca2.y = 500;
cb2.mass = 90; cb2.r = radiusOf(90); cb2.x = 500; cb2.y = 500;
w3b._resolveEating();
ok('포식 가드: 질량비 1.25배 미만이면 못 먹음', w3b.playerCells('B2').length === 1);

// 7) 바이러스: 임계질량 도달 시 분열탄 발사 + 명중 세포 강제 폭발분열
const w4 = new World({ seed: 9 });
const v = w4.viruses[0];
v.mass = CONFIG.VIRUS_FIRE_MASS + 5; v.aimx = 1; v.aimy = 0;
const shots0 = w4.shots.length;
w4._virusFire();
ok('바이러스 임계질량 → 분열탄 발사', w4.shots.length === shots0 + 1, `shots=${w4.shots.length}`);
ok('발사 후 바이러스 질량 리셋', v.mass === CONFIG.VIRUS_BASE_MASS);
// 분열탄 명중 → 강제 폭발분열
const tgt = w4.join('T', '표적');
const ct = w4.playerCells('T')[0]; ct.mass = 200; ct.r = radiusOf(200); ct.x = 2000; ct.y = 2000;
const shot = w4.shots[0]; shot.x = 2000; shot.y = 2000; // 명중 위치
const cellsBefore = w4.playerCells('T').length;
w4._resolveEating();
ok('분열탄 명중 → 강제 폭발분열(조각 증가)', w4.playerCells('T').length > cellsBefore, `${cellsBefore} -> ${w4.playerCells('T').length}`);

// 8) 부스트: 쿨다운 가드
const w5 = new World({ seed: 2 });
w5.join('z', 'z');
const b1 = w5.doBoost('z'); const b2 = w5.doBoost('z');
ok('부스트 발동 후 쿨다운 가드', b1 === true && b2 === false);

// 9) 봇 FSM 동작 + 리더보드
const w6 = new World({ seed: 7 });
for (let i = 0; i < 100; i++) w6.step(1 / 20);
const states = new Set([...w6.players.values()].filter(p => p.isBot).map(p => p.botState));
ok('봇 FSM 상태 활성(seek/hunt/flee 중)', states.size >= 1 && [...states].every(s => ['seek', 'hunt', 'flee'].includes(s)), `states=${[...states].join(',')}`);
const lb = w6.leaderboard();
ok('리더보드 top10 산출', lb.length > 0 && lb.length <= 10 && lb[0].mass >= lb[lb.length - 1].mass, `top=${lb[0].name}:${lb[0].mass}`);

// 10) 스냅샷 스키마 + 성능(60fps 헤드룸)
const snap = w6.getSnapshot('bot0');
const c = snap.cells[0] || {};
ok('스냅샷 셀 스키마 필드', ['id', 'x', 'y', 'r', 'mass', 'color', 'type', 'owner'].every(k => k in c), `keys=${Object.keys(c).join(',')}`);
ok('스냅샷 구성요소', !!(snap.world && snap.camera && snap.leaderboard && snap.blips), '');

const w7 = new World({ seed: 7 });
for (let i = 0; i < 30; i++) w7.join('u' + i, 'user' + i); // 부하: 봇10+유저30
const N = 1000; const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { w7.step(1 / 20); w7.clearEvents(); }
const t1 = process.hrtime.bigint();
const perTick = Number(t1 - t0) / 1e6 / N;
ok('틱 비용 < 16.6ms (60fps 헤드룸)', perTick < 16.6, `avg=${perTick.toFixed(3)}ms/tick (40 플레이어)`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
