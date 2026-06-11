/* ============================================================
 * verify-boot.cjs — 무의존 기동 자립 검증 (외부 의존 0, 외부 PORT 의존 0)
 *
 * 직접 `node server.js`를 동일 PORT로 spawn하고:
 *   ① 정적 GET index/app.js/vfx.js/cell-art.js → 200
 *   ② WS welcome 수신 (서버 권위 핸드셰이크; 내장 net+crypto로 RFC6455 클라 직접 구현)
 *   ③ state 스냅샷 지속 수신 (≈20Hz)
 * 를 단언한다. welcome 미수신/스냅샷 정지 시 fail-fast.
 * ============================================================ */
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3099;
const HOST = '127.0.0.1';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- 내장 WS 클라이언트 (무의존) ---- */
function maskFrame(str) {
  const payload = Buffer.from(str, 'utf8'), len = payload.length, mask = crypto.randomBytes(4);
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81;
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, out]);
}
function parseFrames(buf) {
  const frames = [];
  while (buf.length >= 2) {
    const b1 = buf[1], opcode = buf[0] & 0x0f;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = (b1 & 0x80) !== 0, maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) break;
    let payload = buf.slice(off + maskLen, off + maskLen + len);
    if (masked) { const m = buf.slice(off, off + 4), o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ m[i & 3]; payload = o; }
    frames.push({ opcode, payload });
    buf = buf.slice(off + maskLen + len);
  }
  return { frames, rest: buf };
}

function httpGet(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: p }, (res) => {
      let n = 0; res.on('data', (d) => n += d.length); res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
  });
}

function waitListening(child) {
  return new Promise((resolve) => {
    let done = false;
    const onData = (d) => { if (!done && /listening on/.test(d.toString())) { done = true; resolve(true); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => process.stderr.write('[srv:err] ' + d));
    setTimeout(() => { if (!done) { done = true; resolve(false); } }, 5000);
  });
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(PORT) },
  });
  const up = await waitListening(child);
  ok('① server.js가 PORT=' + PORT + ' 바인딩 후 기동 (process.env.PORT)', up);
  if (!up) { child.kill('SIGKILL'); console.log(`\n=== ${pass} passed, ${fail} failed ===`); process.exit(1); }

  // ① 정적 GET 200
  for (const f of ['/', '/app.js', '/vfx.js', '/cell-art.js']) {
    const r = await httpGet(f);
    ok(`정적 GET ${f === '/' ? '/(index.html)' : f} → 200`, r.status === 200 && r.bytes > 0, `status=${r.status} bytes=${r.bytes}`);
  }
  const hz = await httpGet('/healthz');
  ok('헬스체크 GET /healthz → 200', hz.status === 200, `status=${hz.status}`);

  // ②③ WS welcome + state 스냅샷
  let welcome = null, snaps = 0, rest = Buffer.alloc(0), wsErr = null;
  const sock = net.connect(PORT, HOST);
  const key = crypto.randomBytes(16).toString('base64');
  let handshakeDone = false;
  sock.on('error', (e) => { wsErr = e.message; });
  sock.on('connect', () => {
    sock.write(
      `GET / HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });
  sock.on('data', (chunk) => {
    rest = Buffer.concat([rest, chunk]);
    if (!handshakeDone) {
      const idx = rest.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = rest.slice(0, idx).toString();
      if (!/101 Switching Protocols/.test(head)) { wsErr = 'no 101: ' + head.split('\r\n')[0]; return; }
      handshakeDone = true;
      rest = rest.slice(idx + 4);
      sock.write(maskFrame(JSON.stringify({ t: 'join', name: 'Verifier' })));
    }
    const out = parseFrames(rest); rest = out.rest;
    for (const fr of out.frames) {
      if (fr.opcode !== 0x1) continue;
      let m; try { m = JSON.parse(fr.payload.toString('utf8')); } catch (e) { continue; }
      if (m.t === 'welcome') welcome = m;
      else if (m.t === 'state') snaps++;
    }
  });

  await sleep(1800);
  const snapsAt1 = snaps;
  ok('② WS welcome 수신 (서버 권위 핸드셰이크)', !!welcome,
     welcome ? `id=${welcome.id} world=${welcome.world.w}x${welcome.world.h} tick=${welcome.config.tickRate}Hz` : (wsErr || 'no welcome'));
  ok('③ state 스냅샷 지속 수신', snaps > 10, `snaps=${snaps} (~${(snaps / 1.8).toFixed(0)}/s)`);

  // 스냅샷이 '계속' 들어오는지(정지 아님) 재확인
  await sleep(1000);
  ok('③ 스냅샷이 멈추지 않고 누적', snaps > snapsAt1, `+${snaps - snapsAt1} in 1s`);

  sock.end();
  child.kill('SIGINT');
  await sleep(300);
  if (child.exitCode === null) child.kill('SIGKILL');
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
