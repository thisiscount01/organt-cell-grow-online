/* ============================================================
 * verify-fileguard.cjs — file:// 가드 헤드리스 검증 (무의존)
 *
 * index.html 의 '클래식' 인라인 가드 스크립트를 그대로 추출해, 가짜 DOM 에서
 *   ① location.protocol === 'file:'  → 안내 오버레이(#file-warning) 가 body 에 주입되고
 *      "http://localhost:3000" / "node server.js" 안내 문구가 포함된다(빈 화면 방지).
 *   ② location.protocol === 'http:'  → 오버레이를 만들지 않는다(정상 부트 비간섭).
 * 를 단언한다. 이 가드는 type="module" 밖에 있어야 file:// CORS 차단과 무관하게
 * 실행된다 — 그 사실 자체(인라인 클래식 <script>)도 함께 검사한다.
 * ============================================================ */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let fail = 0;
const log = (ok, msg) => { if (!ok) fail++; console.log((ok ? '  OK   ' : '  FAIL ') + msg); };

const htmlSrc = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// 1) 가드는 반드시 'src 없는 클래식 인라인 <script>' 여야 한다(module 이면 file:// 에서 차단됨)
const inlineScripts = [...htmlSrc.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type=["']module)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]);
const guard = inlineScripts.find((s) => /location\.protocol/.test(s) && /file:/.test(s));
log(!!guard, 'index.html 에 file:// 를 검사하는 클래식 인라인 <script> 존재(module 밖 → CORS 차단과 무관)');
if (!guard) { console.log('\n=== 1 FAIL ✗ ==='); process.exit(1); }

/* ---------- 가짜 DOM ---------- */
function makeElement() {
  return {
    id: '', innerHTML: '', tagName: 'DIV',
    style: { cssText: '', background: '' },
    setAttribute(k, v) { this['_attr_' + k] = v; },
    appendChild(c) { (this.children = this.children || []).push(c); },
  };
}
function makeEnv(protocol) {
  const created = [];
  const body = { children: [], appendChild(el) { this.children.push(el); created.push(el); } };
  const documentElement = makeElement();
  const listeners = {};
  const doc = {
    readyState: 'complete',  // 즉시 build() 경로
    title: '',
    documentElement,
    body,
    createElement() { const e = makeElement(); created.push(e); return e; },
    getElementById(id) { return body.children.find((c) => c.id === id) || null; },
    addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
  };
  const sandbox = { location: { protocol }, document: doc, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(guard, sandbox, { filename: 'index.html#guard' });
  return { doc, body };
}

/* ---------- ① file:// → 안내 오버레이 주입 ---------- */
console.log('[1] location.protocol = "file:" → 안내 오버레이 주입');
{
  const { doc, body } = makeEnv('file:');
  const overlay = doc.getElementById('file-warning');
  log(!!overlay, '#file-warning 오버레이가 body 에 주입됨(빈 화면 대신 안내 표시)');
  const html = overlay ? overlay.innerHTML : '';
  log(/http:\/\/localhost:3000/.test(html), '안내에 접속 주소 "http://localhost:3000" 포함');
  log(/node server\.js/.test(html), '안내에 기동 명령 "node server.js" 포함');
  log(/HTTP/i.test(html), '안내에 "HTTP 로 여세요" 취지 문구 포함');
  log(/document\.title|제목/.test(guard) ? doc.title.length > 0 : true,
    '문서 제목도 안내용으로 갱신(title="' + doc.title + '")');
  log(body.children.length >= 1, 'body 에 오버레이 노드가 실제로 append 됨(' + body.children.length + '개)');
}

/* ---------- ② http:// → 비간섭 ---------- */
console.log('[2] location.protocol = "http:" → 오버레이 미생성(정상 부트 비간섭)');
{
  const { doc, body } = makeEnv('http:');
  log(!doc.getElementById('file-warning'), 'http: 에선 #file-warning 을 만들지 않음');
  log(body.children.length === 0, 'http: 에선 body 에 가드 노드 0개(부트 비간섭)');
}

console.log('\n=== ' + (fail === 0 ? 'ALL PASS ✓' : fail + ' FAIL ✗') + ' ===');
process.exit(fail === 0 ? 0 : 1);
