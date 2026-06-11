'use strict';
// 헤드리스: 신규 플레이어 스폰 직후 N틱 내 즉사율 측정 (서버 로직 직접 require)
const { World, CONFIG, radiusOf } = require('./game.js');
let deaths = 0, trials = 200;
for (let t = 0; t < trials; t++) {
  const w = new World({ seed: 1000 + t });
  const p = w.join('p' + t, 'Tester');
  // 2초(40틱) 가만히 있을 때 즉사하는가 (입력 없음 = 제자리)
  let died = false;
  for (let i = 0; i < 40; i++) {
    w.step(1 / CONFIG.TICK_RATE);
    if (!w.playerCells('p' + t).length) { died = true; break; }
  }
  if (died) deaths++;
}
console.log(`즉사(2초내) ${deaths}/${trials} = ${(deaths / trials * 100).toFixed(1)}%`);
