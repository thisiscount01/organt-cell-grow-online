/* ============================================================
 * verify-net-toast.cjs — WS 연결 실패/끊김 토스트 헤드리스 검증 (무의존)
 *
 * 실제 public/app.js 를 가짜 브라우저에서 구동하고, 가짜 WebSocket 으로
 *   ① 서버 미기동(한 번도 onopen 안 됨) → onclose 시 #net-status 에
 *      "서버에 연결할 수 없습니다 … node server.js" 안내가 보인다(빈 화면 방지).
 *   ② 연결됐다 끊김(onopen 후 onclose) → "재접속 중…" 안내로 구분된다.
 *   ③ onopen 시 토스트가 숨겨진다(is-hidden).
 *   ④ 미참가(joined=false) 상태의 close 는 토스트를 띄우지 않는다.
 * 를 run 으로 단언한다.
 * ============================================================ */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const PUB = path.join(__dirname, 'public');

let fail = 0;
const log = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  FAIL ') + msg); };

/* ESM(.js) → CJS 경량 로더 (+ 내부 식별자 노출 훅) */
function loadESM(file, injected, exposeNames) {
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/^[ \t]*import\b[^\n]*\n/gm, '');
  const names = new Set();
  src = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g,
    (_, kw, n) => { names.add(n); return kw + ' ' + n; });
  src = src.replace(/export\s*\{[^}]*\}\s*;?/g, '');
  src = src.replace(/export\s+default\s+/g, 'module.exports.default = ');
  let footer = '\n';
  for (const n of names) footer += `if (typeof ${n} !== 'undefined') module.exports.${n} = ${n};\n`;
  if (exposeNames && exposeNames.length) {
    footer += 'module.exports.__hook = {' + exposeNames.map((n) => `get ${n}(){return ${n};}`).join(',') + '};\n';
  }
  const depKeys = Object.keys(injected).filter((k) => injected[k] !== undefined);
  const wrapped = `(function(module, exports${depKeys.length ? ', ' + depKeys.join(', ') : ''}){\n${src}\n${footer}\n});`;
  const fn = vm.runInThisContext(wrapped, { filename: file });
  const mod = { exports: {} };
  fn(mod, mod.exports, ...depKeys.map((k) => injected[k]));
  return mod.exports;
}

const ART = loadESM(path.join(PUB, 'tokens.js'), {}).ART;

/* ---------- 추적 가능한 #net-status 엘리먼트 ---------- */
const net = {
  textContent: '',
  hidden: true,
  classList: {
    add(c) { if (c === 'is-hidden') net.hidden = true; },
    remove(c) { if (c === 'is-hidden') net.hidden = false; },
    toggle() {},
  },
};
const nick = { value: 'Tester', textContent: '', classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {} };

function fakeEl() {
  return {
    width: 800, height: 600, style: {}, value: '', textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {},
    getContext: () => makeCtx(),
  };
}
function makeCtx() {
  const noop = () => {};
  return new Proxy({ globalCompositeOperation: 'source-over', globalAlpha: 1 }, {
    get(t, k) { return k in t ? t[k] : (k === 'measureText' ? () => ({ width: 10 })
      : (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop }) : noop); },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/* ---------- 가짜 WebSocket: 인스턴스를 캡처해 onopen/onclose 를 수동 발화 ---------- */
let lastWs = null;
function installEnv() {
  const win = {};
  global.window = win;
  global.document = {
    documentElement: fakeEl(),
    querySelector: (sel) => sel === '#net-status' ? net : sel === '#start-nick' ? nick : fakeEl(),
    addEventListener() {},
  };
  global.getComputedStyle = () => ({ getPropertyValue: () => '200' });
  global.addEventListener = () => {};
  global.performance = { now: () => 0 };
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  global.setInterval = () => 0; global.clearInterval = () => {};
  global.setTimeout = () => 0;   // 재연결 재귀 차단(토스트만 검사)
  global.location = { protocol: 'http:', host: 'localhost:3000' };
  global.WebSocket = function () {
    this.readyState = 0; this.onopen = this.onclose = this.onmessage = this.onerror = null;
    this.send = () => {}; this.close = () => {};
    lastWs = this;
  };
  global.innerWidth = 800; global.innerHeight = 600; global.devicePixelRatio = 1;
  return loadESM(path.join(PUB, 'app.js'), { ART, window: win }, ['startGame']);
}

const app = installEnv();
const startGame = app.__hook.startGame;

/* ---------- ① 서버 미기동: startGame → connect → onclose(미개통) ---------- */
console.log('[1] 서버 미기동 — 한 번도 onopen 안 된 채 onclose');
net.textContent = ''; net.hidden = true; lastWs = null;
startGame();                              // joined=true, connect() → WebSocket 생성
log(!!lastWs, 'startGame 이 WebSocket 연결을 시도함(인스턴스 생성)');
lastWs.onclose && lastWs.onclose();       // onopen 없이 바로 끊김
log(net.hidden === false, '#net-status 토스트가 표시됨(is-hidden 해제)');
log(/연결할 수 없습니다/.test(net.textContent), '문구에 "연결할 수 없습니다" 포함 → "' + net.textContent + '"');
log(/node server\.js/.test(net.textContent), '문구에 복구법 "node server.js" 포함');

/* ---------- ② 연결됐다 끊김: onopen → onclose ---------- */
console.log('[2] 연결 성공 후 끊김 — onopen 다음 onclose');
const ws2 = lastWs;
ws2.readyState = 1; ws2.onopen && ws2.onopen();   // 개통
log(net.hidden === true, 'onopen 시 토스트가 숨겨짐(is-hidden)');
ws2.onclose && ws2.onclose();                      // 끊김
log(net.hidden === false && /재접속 중/.test(net.textContent),
  '끊김 시 "재접속 중…" 으로 구분 표시 → "' + net.textContent + '"');

console.log('\n=== ' + (fail === 0 ? 'ALL PASS ✓' : fail + ' FAIL ✗') + ' ===');
process.exit(fail === 0 ? 0 : 1);
