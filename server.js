/* ============================================================
 * server.js — 서버 권위 실시간 멀티플레이어 (무의존)
 *
 * - Node 내장 http 로 public/ 정적 서빙
 * - 의존성 없이 RFC6455 WebSocket 핸드셰이크/프레이밍 직접 구현
 * - 20Hz 권위 시뮬레이션(game.js) 후 클라별 시야 스냅샷 브로드캐스트
 * - process.env.PORT 바인딩(배포 대비), 무의존 기동
 *
 * 클라 → 서버 메시지(JSON):
 *   { t:'join', name }            게임 시작/리스폰
 *   { t:'input', dx, dy }         이동 방향(화면중심→마우스 벡터)
 *   { t:'split' } { t:'eject' } { t:'boost' }
 *   { t:'ping', s }               RTT 측정
 * 서버 → 클라:
 *   { t:'welcome', id, world, config }
 *   { t:'state', ... }            getSnapshot() 결과
 *   { t:'pong', s }
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { World, CONFIG } = require('./game.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------- 정적 서빙 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url.split('?')[0]) || '/');
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const filePath = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    // 무캐시: 라이브 배포에서 옛 빌드(app.js/cell-art.js 등)가 캐시돼
    // "고쳤는데 화면은 그대로(엔티티 안 보임)"가 반복되는 스테일 서빙을 차단.
    // 게임 클라는 매 배포마다 최신 JS가 닿아야 하므로 정적 자산을 캐시하지 않는다.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

/* ============================================================
 * 최소 WebSocket 서버 (RFC6455, 무의존)
 * ============================================================ */
const clients = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

function encodeClose(code) {
  const body = Buffer.alloc(2); body.writeUInt16BE(code || 1000, 0);
  return Buffer.concat([Buffer.from([0x88, body.length]), body]);
}
function encodePong(payload) {
  const p = payload || Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x8A, p.length]), p]);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  const client = { socket, id: 'p' + (++idc), buf: Buffer.alloc(0), joined: false, alive: true };
  clients.add(client);

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    parseFrames(client);
  });
  const cleanup = () => {
    if (!clients.has(client)) return;
    clients.delete(client);
    world.leave(client.id);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function parseFrames(client) {
  let buf = client.buf;
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) break; // 미완 프레임
    let payload = buf.slice(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.slice(off, off + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    buf = buf.slice(off + maskLen + len);

    if (opcode === 0x8) { // close
      try { client.socket.write(encodeClose(1000)); } catch (e) {}
      client.socket.end();
      clients.delete(client); world.leave(client.id);
      return;
    } else if (opcode === 0x9) { // ping → pong
      try { client.socket.write(encodePong(payload)); } catch (e) {}
    } else if (opcode === 0x1) { // text
      handleMessage(client, payload.toString('utf8'));
    }
    // 0xA(pong) 무시
  }
  client.buf = buf;
}

function send(client, obj) {
  try { client.socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {}
}

function handleMessage(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (!msg || typeof msg.t !== 'string') return;
  switch (msg.t) {
    case 'join': {
      const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : '익명세포';
      world.join(client.id, name);
      client.joined = true;
      send(client, { t: 'welcome', id: client.id, world: { w: CONFIG.WORLD_W, h: CONFIG.WORLD_H }, config: { tickRate: CONFIG.TICK_RATE } });
      break;
    }
    case 'input': {
      const dx = Number(msg.dx), dy = Number(msg.dy);
      if (Number.isFinite(dx) && Number.isFinite(dy)) world.setInput(client.id, dx, dy);
      break;
    }
    case 'split': world.doSplit(client.id); break;
    case 'eject': world.doEject(client.id); break;
    case 'boost': world.doBoost(client.id); break;
    case 'ping': send(client, { t: 'pong', s: msg.s }); break;
  }
}

/* ============================================================
 * 시뮬레이션 루프 (20Hz) + 브로드캐스트
 * ============================================================ */
let idc = 0;
const world = new World({ seed: 7 });
const dt = 1 / CONFIG.TICK_RATE;
let lastTick = process.hrtime.bigint();
let stepEma = 0;

const loop = setInterval(() => {
  const t0 = process.hrtime.bigint();
  world.step(dt);
  for (const c of clients) {
    if (!c.joined) continue;
    send(c, world.getSnapshot(c.id));
  }
  world.clearEvents();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  stepEma = stepEma * 0.95 + ms * 0.05;
  lastTick = t1;
}, dt * 1000);

server.listen(PORT, () => {
  console.log(`[cell-grow] listening on :${PORT} (tick=${CONFIG.TICK_RATE}Hz, world=${CONFIG.WORLD_W}x${CONFIG.WORLD_H}, bots=${CONFIG.BOT_COUNT})`);
});

// 상태 진단(헤드리스 검증용): 5초마다 틱 비용 출력
if (process.env.DIAG) {
  setInterval(() => {
    console.log(`[diag] clients=${clients.size} cells=${world.cells.length} food=${world.food.length} viruses=${world.viruses.length} stepEma=${stepEma.toFixed(3)}ms`);
  }, 5000);
}

process.on('SIGINT', () => { clearInterval(loop); server.close(() => process.exit(0)); });
module.exports = { server, world };
