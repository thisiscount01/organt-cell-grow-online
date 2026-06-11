/* verify-tokens.js — 디자인 토큰 정합성 자동 검증 (픽셀 렌더 없이)
 * 1) tokens.css(brand/art 변수) ↔ tokens.js(BRAND/ART) 키·값 1:1 미러 동일성
 * 2) style.css 하드코딩 색 grep (var() 밖의 hex/rgb)
 * 3) z-order 변수 정의 순서 검증
 * exit code 0 = 전부 통과
 */
const fs = require('fs');
const P = (f) => fs.readFileSync(__dirname + '/public/' + f, 'utf8');
const css = P('tokens.css'), js = P('tokens.js'), style = P('style.css');

const norm = (v) => v.trim().toLowerCase().replace(/\s+/g, '');
const kebabToCamel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

// --- CSS 변수 파싱 ---
const cssVars = {};
for (const m of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) cssVars[m[1]] = m[2].trim();

// --- JS 객체 파싱 (BRAND/ART) ---
function jsObj(name) {
  const re = new RegExp('export const ' + name + '\\s*=\\s*\\{([\\s\\S]*?)\\n\\};', 'm');
  const body = js.match(re)[1];
  const out = {};
  // 단순 'key: '...'' 항목
  for (const m of body.matchAll(/([a-zA-Z0-9]+)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2];
  // 배열 항목 food: [...], cellBots: [...]
  for (const m of body.matchAll(/([a-zA-Z0-9]+)\s*:\s*\[([^\]]*)\]/g)) {
    out['#' + m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]);
  }
  return out;
}
const BRAND = jsObj('BRAND'), ART = jsObj('ART');

let fail = 0;
const log = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  FAIL ') + msg); };

// === 2-a) BRAND 미러 ===
console.log('[2-a] --brand-* ↔ BRAND 미러');
let brandChecked = 0;
for (const [k, v] of Object.entries(cssVars)) {
  if (!k.startsWith('brand-')) continue;
  if (v.startsWith('var(')) continue;
  const jk = kebabToCamel(k.slice('brand-'.length));
  brandChecked++;
  log(BRAND[jk] !== undefined && norm(BRAND[jk]) === norm(v),
      `--${k}=${v}  ↔  BRAND.${jk}=${BRAND[jk]}`);
}
console.log(`  (brand 키 ${brandChecked}개 대조)`);

// === 2-b) ART 미러 ===
console.log('[2-b] --art-* ↔ ART 미러');
let artChecked = 0;
for (const [k, v] of Object.entries(cssVars)) {
  if (!k.startsWith('art-')) continue;
  if (v.startsWith('var(')) continue;
  const rest = k.slice('art-'.length);
  // food-1..5 / cell-bot-1..6 는 배열 인덱스로도 미러됨
  const camel = kebabToCamel(rest);
  let jsVal = ART[camel];
  // 배열 멤버 교차검증
  if (/^food-[1-5]$/.test(rest)) {
    const idx = +rest.split('-')[1] - 1;
    log(ART['#food'] && norm(ART['#food'][idx]) === norm(v),
        `--${k}=${v}  ↔  ART.food[${idx}]=${ART['#food'] && ART['#food'][idx]}`);
  }
  if (/^cell-bot-[1-6]$/.test(rest)) {
    const idx = +rest.split('-')[2] - 1;
    log(ART['#cellBots'] && norm(ART['#cellBots'][idx]) === norm(v),
        `--${k}=${v}  ↔  ART.cellBots[${idx}]=${ART['#cellBots'] && ART['#cellBots'][idx]}`);
  }
  artChecked++;
  log(jsVal !== undefined && norm(jsVal) === norm(v),
      `--${k}=${v}  ↔  ART.${camel}=${jsVal}`);
}
console.log(`  (art 키 ${artChecked}개 대조)`);

// 역방향: JS에만 있고 CSS에 없는 art 키 탐지 (별칭 제외)
console.log('[2-c] ART → --art-* 역방향 누락');
const cssArtCamel = new Set(Object.keys(cssVars).filter(k => k.startsWith('art-')).map(k => kebabToCamel(k.slice(4))));
for (const k of Object.keys(ART)) {
  if (k.startsWith('#')) continue;
  log(cssArtCamel.has(k), `ART.${k} 가 --art-${k.replace(/[A-Z0-9]/g, m => '-' + m.toLowerCase())} 로 존재`);
}

// === 1) style.css 하드코딩 색 grep ===
console.log('[1] style.css 하드코딩 색 (var() 밖 hex/rgb)');
const offenders = [];
style.split('\n').forEach((line, i) => {
  // 주석 제거
  const code = line.replace(/\/\*.*?\*\//g, '');
  // var(...) 내부 색은 무시: var() 토큰을 마스킹
  const masked = code.replace(/var\([^)]*\)/g, 'VAR');
  if (/#[0-9a-fA-F]{3,8}\b/.test(masked) || /\b(rgb|rgba|hsl|hsla)\(/.test(masked)) {
    offenders.push(`L${i + 1}: ${line.trim()}`);
  }
});
log(offenders.length === 0, `하드코딩 색 ${offenders.length}건`);
offenders.forEach(o => console.log('       ' + o));

// === 3) z-order 순서 ===
console.log('[3] z-order 정의 순서');
const zOrder = ['z-canvas', 'z-overlay', 'z-hud', 'z-screen', 'z-net'];
const zVals = zOrder.map(z => +cssVars[z]);
let zOk = true;
for (let i = 1; i < zVals.length; i++) if (!(zVals[i] > zVals[i - 1])) zOk = false;
log(zOk && zVals.every(v => !isNaN(v)),
    `${zOrder.map((z, i) => `${z}=${zVals[i]}`).join(' < ')}`);

console.log('\n=== ' + (fail === 0 ? 'ALL PASS ✓' : fail + ' FAIL ✗') + ' ===');
process.exit(fail === 0 ? 0 : 1);
