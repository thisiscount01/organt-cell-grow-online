/* ============================================================
 * game.js — 서버 권위 세포 게임 시뮬레이션 (순수 로직 / 무의존)
 *
 * 네트워크와 분리된 결정적 시뮬레이션. server.js 가 require 하고,
 * 헤드리스 테스트도 직접 require 해서 물리/분열/포식/바이러스/봇을
 * 수치로 검증한다. 시간은 world.now(초)로 누적 — Date.now() 미사용(결정적).
 *
 * 좌표계: 월드 px. 셀 스키마는 getSnapshot() 참조.
 * ============================================================ */
'use strict';

/* ---------- 설정 ---------- */
const CONFIG = {
  WORLD_W: 6000,
  WORLD_H: 6000,
  TICK_RATE: 20,                 // 서버 시뮬 Hz
  START_MASS: 10,
  MAX_MASS: 22000,
  FOOD_MAX: 700,
  FOOD_MASS: 1,
  EAT_RATIO: 1.25,               // 포식: eater.mass >= prey.mass * 1.25
  EAT_OVERLAP: 0.6,              // 먹이의 60% 이상 덮으면 섭취
  // 이동 속도: v = SPEED_BASE * mass^SPEED_EXP  (질량↑ → 속도↓, 단조감소)
  SPEED_BASE: 700,
  SPEED_EXP: -0.32,
  SPEED_MIN: 24,
  // 분열
  MIN_SPLIT_MASS: 35,
  MAX_CELLS: 16,
  SPLIT_IMPULSE: 760,            // px/s 초기 사출 속도
  IMPULSE_DECAY: 4.0,            // 사출 속도 감쇠율(/s)
  MERGE_COOLDOWN: 12,            // 분열 조각 재합체까지(초)
  // 먹이 뿌리기(W)
  EJECT_MIN_MASS: 35,
  EJECT_COST: 16,                // 사출 시 잃는 질량
  EJECT_MASS: 13,               // 펠릿 질량
  EJECT_SPEED: 820,
  EJECT_COOLDOWN: 0.12,
  // 바이러스(지뢰)
  VIRUS_COUNT: 14,
  VIRUS_BASE_MASS: 100,
  VIRUS_FIRE_MASS: 180,          // 임계질량 → 분열탄 발사
  VIRUS_SHOT_SPEED: 900,
  VIRUS_SHOT_LIFE: 2.2,
  VIRUS_EAT_MASS: 130,           // 이 이상 세포가 바이러스 먹으면 폭발분열
  // 부스트(Shift)
  BOOST_MULT: 1.7,
  BOOST_DURATION: 2.5,
  BOOST_COOLDOWN: 10,
  // 봇
  BOT_COUNT: 10,
  // 질량 자연 감소(밸런스)
  DECAY_MASS_MIN: 200,
  DECAY_RATE: 0.002,
};

const BOT_COLORS = ['#ff5fa2', '#ffa14b', '#7c6bff', '#4bd0ff', '#9bff5c', '#ff7bd5'];
const FOOD_COLORS = ['#ff6b6b', '#ffd93d', '#6bff95', '#5cc8ff', '#c08bff'];
const PLAYER_COLOR = '#2de2c0';
const BOT_NAMES = ['Nox', 'Vex', 'Zby', 'Qua', 'Rho', 'Lyx', 'Tök', 'Mir', 'Pyx', 'Onyx', 'Kai', 'Dro'];

/* ---------- 유틸 ---------- */
function radiusOf(mass) { return Math.sqrt(mass) * 4; }
function speedOf(mass) {
  return Math.max(CONFIG.SPEED_MIN, CONFIG.SPEED_BASE * Math.pow(mass, CONFIG.SPEED_EXP));
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
// 결정적 RNG (mulberry32)
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
 * World
 * ============================================================ */
class World {
  constructor(opts = {}) {
    this.cfg = Object.assign({}, CONFIG, opts.config || {});
    this.rng = makeRng(opts.seed != null ? opts.seed : 1337);
    this.now = 0;
    this._idc = 1;
    this.players = new Map();   // id -> player
    this.cells = [];            // 모든 세포(플레이어/봇)
    this.food = [];
    this.viruses = [];
    this.ejecta = [];           // W로 뿌린 펠릿
    this.shots = [];            // 바이러스 분열탄
    this.events = [];           // 이번 틱 VFX 이벤트 (스냅샷 후 비움)

    for (let i = 0; i < this.cfg.FOOD_MAX; i++) this._spawnFood();
    for (let i = 0; i < this.cfg.VIRUS_COUNT; i++) this._spawnVirus();
    for (let i = 0; i < this.cfg.BOT_COUNT; i++) this._addBot(i);
  }

  _id() { return (this._idc++).toString(36); }

  _spawnFood() {
    this.food.push({
      id: this._id(), type: 'food',
      x: this.rng() * this.cfg.WORLD_W, y: this.rng() * this.cfg.WORLD_H,
      mass: this.cfg.FOOD_MASS, r: radiusOf(this.cfg.FOOD_MASS) * 1.1,
      color: FOOD_COLORS[(this.rng() * FOOD_COLORS.length) | 0],
    });
  }

  _spawnVirus() {
    const m = this.cfg.VIRUS_BASE_MASS;
    this.viruses.push({
      id: this._id(), type: 'virus', owner: '',
      x: this.rng() * this.cfg.WORLD_W, y: this.rng() * this.cfg.WORLD_H,
      mass: m, r: radiusOf(m), color: '#4cff7a',
      aimx: 0, aimy: -1,
    });
  }

  _addBot(i) {
    const id = 'bot' + i;
    const name = BOT_NAMES[i % BOT_NAMES.length];
    const p = this._makePlayer(id, name, true);
    p.color = BOT_COLORS[i % BOT_COLORS.length];
    this._spawnPlayerCell(p);
    return p;
  }

  _makePlayer(id, name, isBot) {
    const p = {
      id, name: (name || 'cell').slice(0, 16), isBot: !!isBot,
      color: isBot ? BOT_COLORS[0] : PLAYER_COLOR,
      input: { dx: 0, dy: -1 },     // 정규화 방향
      boostUntil: -1, boostReadyAt: 0,
      lastEjectAt: -1,
      alive: false, spawnedAt: 0, bestRank: 99,
      botState: 'seek',
    };
    this.players.set(id, p);
    return p;
  }

  // 안전 스폰 좌표: 새 세포(START_MASS)를 즉시 먹을 수 있는 '포식자'에서 멀리.
  // 후보를 여러 개 뽑아, 가장 가까운 위협까지의 거리가 최대인 곳을 고른다.
  // (완전 랜덤 스폰이 큰 봇/플레이어 위에 떨어져 0.5초 만에 먹히는 즉사 방지)
  _safeSpawnPos() {
    const cfg = this.cfg;
    const newMass = cfg.START_MASS;
    const SAFE_DIST = 360;            // 이 안에 포식자 없으면 '안전'으로 즉시 채택
    let best = null, bestScore = -1;
    for (let tries = 0; tries < 18; tries++) {
      const x = 200 + this.rng() * (cfg.WORLD_W - 400);
      const y = 200 + this.rng() * (cfg.WORLD_H - 400);
      let nearest = Infinity;
      for (const o of this.cells) {
        // 나를 먹을 수 있을 만큼 큰 세포만 위협으로 본다
        if (o.mass < newMass * cfg.EAT_RATIO) continue;
        const d = Math.hypot(o.x - x, o.y - y);
        if (d < nearest) nearest = d;
      }
      for (const v of this.viruses) {
        const d = Math.hypot(v.x - x, v.y - y);
        if (d < nearest) nearest = d;     // 바이러스 위도 피한다
      }
      if (nearest > bestScore) { bestScore = nearest; best = { x, y }; }
      if (nearest >= SAFE_DIST) return best;   // 충분히 안전 → 조기 채택
    }
    return best || { x: cfg.WORLD_W / 2, y: cfg.WORLD_H / 2 };
  }

  _spawnPlayerCell(p) {
    const m = this.cfg.START_MASS;
    const pos = this._safeSpawnPos();
    const c = {
      id: this._id(), type: p.isBot ? 'bot' : 'player', owner: p.id,
      name: p.name, color: p.color,
      x: pos.x, y: pos.y,
      mass: m, r: radiusOf(m),
      vx: 0, vy: 0, mergeAt: 0, event: null,
    };
    this.cells.push(c);
    p.alive = true;
    p.spawnedAt = this.now;
    return c;
  }

  /* ---------- public: 플레이어 관리 ---------- */
  join(id, name) {
    let p = this.players.get(id);
    if (!p) p = this._makePlayer(id, name, false);
    else p.name = (name || p.name).slice(0, 16);
    p.color = PLAYER_COLOR;
    if (!this.playerCells(id).length) this._spawnPlayerCell(p);
    p.bestRank = 99;
    return p;
  }
  leave(id) {
    this.cells = this.cells.filter(c => c.owner !== id);
    this.players.delete(id);
  }
  setInput(id, dx, dy) {
    const p = this.players.get(id); if (!p) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return; // NaN/Inf 무시(좌표 오염 방지)
    const len = Math.hypot(dx, dy);
    if (len > 1e-4) { p.input.dx = dx / len; p.input.dy = dy / len; }
  }
  playerCells(id) { return this.cells.filter(c => c.owner === id); }
  playerMass(id) { return this.playerCells(id).reduce((s, c) => s + c.mass, 0); }

  /* ---------- 액션 ---------- */
  doSplit(id) {
    const p = this.players.get(id); if (!p) return;
    const mine = this.playerCells(id);
    if (!mine.length) return;
    let slots = this.cfg.MAX_CELLS - mine.length;
    if (slots <= 0) return;
    // 큰 셀부터 분열
    const sorted = mine.slice().sort((a, b) => b.mass - a.mass);
    for (const c of sorted) {
      if (slots <= 0) break;
      if (c.mass < this.cfg.MIN_SPLIT_MASS) continue;
      const half = c.mass / 2;
      c.mass = half; c.r = radiusOf(half); c.event = 'split';
      const nc = {
        id: this._id(), type: c.type, owner: id, name: p.name, color: p.color,
        x: c.x, y: c.y, mass: half, r: radiusOf(half),
        vx: p.input.dx * this.cfg.SPLIT_IMPULSE, vy: p.input.dy * this.cfg.SPLIT_IMPULSE,
        mergeAt: this.now + this.cfg.MERGE_COOLDOWN, event: 'split',
      };
      c.mergeAt = this.now + this.cfg.MERGE_COOLDOWN;
      this.cells.push(nc);
      slots--;
    }
  }

  doEject(id) {
    const p = this.players.get(id); if (!p) return;
    if (this.now - p.lastEjectAt < this.cfg.EJECT_COOLDOWN) return; // 쿨다운
    const mine = this.playerCells(id);
    let did = false;
    for (const c of mine) {
      if (c.mass < this.cfg.EJECT_MIN_MASS) continue;       // 자원 부족 → 발동 안 함
      c.mass -= this.cfg.EJECT_COST; c.r = radiusOf(c.mass);
      const dx = p.input.dx, dy = p.input.dy;
      this.ejecta.push({
        id: this._id(), type: 'eject', owner: id,
        x: c.x + dx * (c.r + 4), y: c.y + dy * (c.r + 4),
        mass: this.cfg.EJECT_MASS, r: radiusOf(this.cfg.EJECT_MASS),
        vx: dx * this.cfg.EJECT_SPEED, vy: dy * this.cfg.EJECT_SPEED,
        color: '#ffe08a', born: this.now,
      });
      c.event = 'eject';
      did = true;
    }
    if (did) p.lastEjectAt = this.now;
    return did;
  }

  doBoost(id) {
    const p = this.players.get(id); if (!p) return false;
    if (this.now < p.boostReadyAt) return false;            // 쿨다운 중 → 발동 안 함
    p.boostUntil = this.now + this.cfg.BOOST_DURATION;
    p.boostReadyAt = this.now + this.cfg.BOOST_COOLDOWN;
    return true;
  }

  /* ---------- 시뮬레이션 1틱 ---------- */
  step(dt) {
    this.now += dt;
    const cfg = this.cfg;

    // 1) 봇 AI
    this._botThink(dt);

    // 2) 이동
    for (const c of this.cells) {
      const p = this.players.get(c.owner);
      if (!p) continue;
      let sp = speedOf(c.mass);
      if (this.now < p.boostUntil) sp *= cfg.BOOST_MULT;
      const mvx = p.input.dx * sp, mvy = p.input.dy * sp;
      // 사출 임펄스 감쇠
      const k = Math.exp(-cfg.IMPULSE_DECAY * dt);
      c.vx *= k; c.vy *= k;
      c.x += (mvx + c.vx) * dt;
      c.y += (mvy + c.vy) * dt;
      c.x = clamp(c.x, c.r, cfg.WORLD_W - c.r);
      c.y = clamp(c.y, c.r, cfg.WORLD_H - c.r);
      // 질량 자연감소
      if (c.mass > cfg.DECAY_MASS_MIN) {
        c.mass *= (1 - cfg.DECAY_RATE * dt);
        c.r = radiusOf(c.mass);
      }
    }

    // 3) 펠릿/분열탄 이동
    for (const e of this.ejecta) {
      const k = Math.exp(-3 * dt);
      e.vx *= k; e.vy *= k;
      e.x = clamp(e.x + e.vx * dt, 0, cfg.WORLD_W);
      e.y = clamp(e.y + e.vy * dt, 0, cfg.WORLD_H);
    }
    for (const s of this.shots) {
      s.x += s.vx * dt; s.y += s.vy * dt;
    }
    this.shots = this.shots.filter(s => this.now - s.born < cfg.VIRUS_SHOT_LIFE
      && s.x > 0 && s.x < cfg.WORLD_W && s.y > 0 && s.y < cfg.WORLD_H);

    // 4) 같은 주인 셀: 재합체 / 분리
    this._sameOwnerInteract();

    // 5) 섭취 (먹이 / 펠릿 / 다른셀 / 바이러스 / 분열탄)
    this._resolveEating();

    // 6) 바이러스 발사
    this._virusFire();

    // 7) 죽은 플레이어 처리 + 봇 리스폰
    for (const p of this.players.values()) {
      const has = this.playerCells(p.id).length > 0;
      if (!has && p.alive) {
        p.alive = false;
        if (p.isBot) this._spawnPlayerCell(p); // 봇은 즉시 부활(온라인 유지)
      }
    }

    // 8) 먹이 보충
    while (this.food.length < cfg.FOOD_MAX) this._spawnFood();
    while (this.viruses.length < cfg.VIRUS_COUNT) this._spawnVirus();

    // 9) 순위 기록(최고 순위)
    const lb = this.leaderboard();
    lb.forEach((row, i) => {
      const p = this.players.get(row.id);
      if (p) p.bestRank = Math.min(p.bestRank, i + 1);
    });
  }

  _sameOwnerInteract() {
    const byOwner = new Map();
    for (const c of this.cells) {
      if (!byOwner.has(c.owner)) byOwner.set(c.owner, []);
      byOwner.get(c.owner).push(c);
    }
    for (const group of byOwner.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          if (a._gone || b._gone) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-3;
          const mergeReady = this.now > a.mergeAt && this.now > b.mergeAt;
          if (mergeReady) {
            // 재합체 대기/성사: 쿨다운이 지난 조각끼리는 밀어내지 않고(분리력 OFF)
            // 겹치면 살짝 끌어당겨(코히전) 자연스럽게 하나로 모은다 → 충분히 겹치면 합체.
            // (분리력을 그대로 두면 두 조각이 '닿는 거리'에서 멈춰 영영 합쳐지지 않는다.)
            if (d < Math.max(a.r, b.r) * 0.85) {
              const big = a.mass >= b.mass ? a : b, small = big === a ? b : a;
              big.mass += small.mass; big.r = radiusOf(big.mass); big.event = 'merge';
              small._gone = true;
            } else if (d < a.r + b.r) {
              const pull = (a.r + b.r - d) * 0.5;
              const nx = dx / d, ny = dy / d;
              a.x += nx * pull * 0.5; a.y += ny * pull * 0.5;
              b.x -= nx * pull * 0.5; b.y -= ny * pull * 0.5;
            }
          } else if (d < a.r + b.r) {
            // 재합체 전(쿨다운 중): 겹침 분리(밀어내기)
            const overlap = (a.r + b.r - d);
            const nx = dx / d, ny = dy / d;
            const push = overlap * 0.5;
            a.x -= nx * push * 0.5; a.y -= ny * push * 0.5;
            b.x += nx * push * 0.5; b.y += ny * push * 0.5;
          }
        }
      }
    }
    this.cells = this.cells.filter(c => !c._gone);
  }

  _canEat(eater, prey) {
    if (eater.mass < prey.mass * this.cfg.EAT_RATIO) return false;
    const d = Math.hypot(eater.x - prey.x, eater.y - prey.y);
    return (eater.r - d) > prey.r * this.cfg.EAT_OVERLAP;
  }

  _resolveEating() {
    const cfg = this.cfg;
    // 셀 vs 먹이
    for (const c of this.cells) {
      for (const f of this.food) {
        if (f._gone) continue;
        const d = Math.hypot(c.x - f.x, c.y - f.y);
        if (d < c.r) { c.mass += f.mass; c.r = radiusOf(c.mass); f._gone = true; c.event = c.event || 'eat'; }
      }
    }
    this.food = this.food.filter(f => !f._gone);

    // 셀 vs 펠릿(W 먹이): 자기 펠릿은 잠시 면역
    for (const c of this.cells) {
      for (const e of this.ejecta) {
        if (e._gone) continue;
        if (e.owner === c.owner && this.now - e.born < 0.6) continue;
        const d = Math.hypot(c.x - e.x, c.y - e.y);
        if (d < c.r) { c.mass += e.mass; c.r = radiusOf(c.mass); e._gone = true; c.event = c.event || 'eat'; }
      }
    }

    // 바이러스 vs 펠릿(성장 + 조준방향 갱신)
    for (const v of this.viruses) {
      for (const e of this.ejecta) {
        if (e._gone) continue;
        const d = Math.hypot(v.x - e.x, v.y - e.y);
        if (d < v.r) {
          v.mass += e.mass; v.r = radiusOf(v.mass);
          const sp = Math.hypot(e.vx, e.vy) || 1;
          v.aimx = e.vx / sp; v.aimy = e.vy / sp;   // 마지막 먹인 방향으로 조준
          e._gone = true;
        }
      }
    }
    this.ejecta = this.ejecta.filter(e => !e._gone);

    // 셀 vs 셀 (다른 주인 포식)
    for (let i = 0; i < this.cells.length; i++) {
      const a = this.cells[i];
      if (a._gone) continue;
      for (let j = 0; j < this.cells.length; j++) {
        if (i === j) continue;
        const b = this.cells[j];
        if (b._gone || a.owner === b.owner) continue;
        if (this._canEat(a, b)) {
          a.mass += b.mass; a.r = radiusOf(a.mass); a.event = 'eat';
          b._gone = true;
        }
      }
    }
    this.cells = this.cells.filter(c => !c._gone);

    // 셀 vs 바이러스 (충분히 크면 먹고 폭발분열)
    for (const v of this.viruses) {
      for (const c of this.cells) {
        if (c._gone || v._gone) continue;
        if (c.mass >= cfg.VIRUS_EAT_MASS) {
          const d = Math.hypot(c.x - v.x, c.y - v.y);
          if (d < c.r - v.r * 0.4) {
            c.mass += v.mass * 0.5;
            this._forceExplode(c);
            v._gone = true;
          }
        }
      }
    }
    this.viruses = this.viruses.filter(v => !v._gone);

    // 분열탄 vs 셀 (명중 → 강제 폭발분열)
    for (const s of this.shots) {
      if (s._gone) continue;
      for (const c of this.cells) {
        if (c._gone) continue;
        const d = Math.hypot(c.x - s.x, c.y - s.y);
        if (d < c.r) {
          this._forceExplode(c);
          s._gone = true;
          break;
        }
      }
    }
    this.shots = this.shots.filter(s => !s._gone);
  }

  // 강제 폭발분열: 한 셀을 여러 조각으로 터뜨림
  _forceExplode(c) {
    const cfg = this.cfg;
    const p = this.players.get(c.owner);
    const mine = this.playerCells(c.owner).length;
    let pieces = Math.min(8, cfg.MAX_CELLS - mine + 1);
    if (pieces < 2 || c.mass < 36) { c.event = 'pop'; return; }
    const each = c.mass / pieces;
    c.mass = each; c.r = radiusOf(each); c.event = 'pop';
    for (let k = 1; k < pieces; k++) {
      const ang = (Math.PI * 2 * k) / pieces + this.rng() * 0.6;
      this.cells.push({
        id: this._id(), type: c.type, owner: c.owner,
        name: c.name, color: c.color,
        x: c.x, y: c.y, mass: each, r: radiusOf(each),
        vx: Math.cos(ang) * cfg.SPLIT_IMPULSE * 0.8,
        vy: Math.sin(ang) * cfg.SPLIT_IMPULSE * 0.8,
        mergeAt: this.now + cfg.MERGE_COOLDOWN, event: 'pop',
      });
    }
  }

  _virusFire() {
    const cfg = this.cfg;
    for (const v of this.viruses) {
      if (v.mass >= cfg.VIRUS_FIRE_MASS) {
        const ax = v.aimx || 0, ay = v.aimy || -1;
        this.shots.push({
          id: this._id(), type: 'virusShot', owner: 'virus',
          x: v.x + ax * (v.r + 6), y: v.y + ay * (v.r + 6),
          mass: 40, r: radiusOf(40), color: '#aaff5c',
          vx: ax * cfg.VIRUS_SHOT_SPEED, vy: ay * cfg.VIRUS_SHOT_SPEED,
          born: this.now,
        });
        v.mass = cfg.VIRUS_BASE_MASS; v.r = radiusOf(v.mass);
        v.event = 'fire';
      }
    }
  }

  /* ---------- 봇 FSM ---------- */
  _botThink(dt) {
    const cfg = this.cfg;
    for (const p of this.players.values()) {
      if (!p.isBot) continue;
      const mine = this.playerCells(p.id);
      if (!mine.length) continue;
      // 봇 대표 셀(가장 큰 것) 기준
      const me = mine.reduce((a, b) => (a.mass >= b.mass ? a : b));
      const myMass = this.playerMass(p.id);

      // 위협: 나를 먹을 수 있는 다른 셀
      let threat = null, threatD = Infinity;
      let prey = null, preyD = Infinity;
      for (const c of this.cells) {
        if (c.owner === p.id) continue;
        const d = Math.hypot(c.x - me.x, c.y - me.y);
        if (c.mass > me.mass * cfg.EAT_RATIO && d < 520 && d < threatD) { threat = c; threatD = d; }
        if (me.mass > c.mass * cfg.EAT_RATIO && d < 700 && d < preyD) { prey = c; preyD = d; }
      }

      let tx, ty, state;
      if (threat) {
        state = 'flee';
        tx = me.x - (threat.x - me.x);
        ty = me.y - (threat.y - me.y);
      } else if (prey) {
        state = 'hunt';
        tx = prey.x; ty = prey.y;
        // 사정권 + 충분히 크면 분열로 덮치기(가끔)
        if (preyD < me.r * 2.2 && me.mass > cfg.MIN_SPLIT_MASS * 2 && this.rng() < 0.04) {
          this.setInput(p.id, prey.x - me.x, prey.y - me.y);
          this.doSplit(p.id);
        }
      } else {
        // 가까운 먹이 추적
        state = 'seek';
        let best = null, bd = Infinity;
        for (const f of this.food) {
          const d = Math.hypot(f.x - me.x, f.y - me.y);
          if (d < bd) { bd = d; best = f; }
        }
        if (best) { tx = best.x; ty = best.y; }
        else { tx = me.x + (this.rng() - 0.5) * 400; ty = me.y + (this.rng() - 0.5) * 400; }
      }
      p.botState = state;
      this.setInput(p.id, tx - me.x, ty - me.y);
      // 큰 봇은 가끔 부스트로 추격/도주
      if ((state === 'hunt' || state === 'flee') && this.rng() < 0.01) this.doBoost(p.id);
    }
  }

  /* ---------- 리더보드 ---------- */
  leaderboard() {
    const rows = [];
    for (const p of this.players.values()) {
      const m = this.playerMass(p.id);
      if (m <= 0) continue;
      rows.push({ id: p.id, name: p.name, mass: Math.round(m), isBot: p.isBot });
    }
    rows.sort((a, b) => b.mass - a.mass);
    return rows.slice(0, 10);
  }

  /* ---------- 스냅샷 (플레이어 시야 컬링) ----------
   * 셀 스키마: { id, x, y, r, mass, color, type, owner, name, event }
   *   type: 'player' | 'bot' | 'virus' | 'food' | 'eject' | 'virusShot'
   *   owner: 소속 플레이어/봇 id ('' = 무소속)
   *   event: 이번 틱 VFX 태그 'split'|'eat'|'pop'|'eject'|'merge'|'fire'|null
   */
  getSnapshot(playerId) {
    const cfg = this.cfg;
    const mine = playerId ? this.playerCells(playerId) : [];
    // 카메라 중심 + 시야 반경(질량 클수록 넓게)
    let cx = cfg.WORLD_W / 2, cy = cfg.WORLD_H / 2, totalMass = 0;
    if (mine.length) {
      let sx = 0, sy = 0, sm = 0;
      for (const c of mine) { sx += c.x * c.mass; sy += c.y * c.mass; sm += c.mass; }
      cx = sx / sm; cy = sy / sm; totalMass = sm;
    }
    const view = 900 + Math.sqrt(totalMass) * 26; // half-extent
    const halfW = view + 200, halfH = view + 200;
    const inView = (o, pad) => Math.abs(o.x - cx) < halfW + (pad || 0) && Math.abs(o.y - cy) < halfH + (pad || 0);

    const packCell = c => ({
      id: c.id, x: Math.round(c.x), y: Math.round(c.y), r: Math.round(c.r * 10) / 10,
      mass: Math.round(c.mass), color: c.color, type: c.type, owner: c.owner,
      name: c.name, event: c.event || null,
    });

    const cells = this.cells.filter(c => inView(c, c.r)).map(packCell);
    const viruses = this.viruses.map(v => ({
      id: v.id, x: Math.round(v.x), y: Math.round(v.y), r: Math.round(v.r),
      mass: Math.round(v.mass), color: v.color, type: 'virus', owner: '',
      charge: Math.min(1, (v.mass - cfg.VIRUS_BASE_MASS) / (cfg.VIRUS_FIRE_MASS - cfg.VIRUS_BASE_MASS)),
      event: v.event || null,
    }));
    const food = this.food.filter(f => inView(f, 60)).map(f => ({
      id: f.id, x: Math.round(f.x), y: Math.round(f.y), r: Math.round(f.r * 10) / 10,
      color: f.color, type: 'food',
    }));
    const eject = this.ejecta.filter(e => inView(e, 60)).map(e => ({
      id: e.id, x: Math.round(e.x), y: Math.round(e.y), r: Math.round(e.r * 10) / 10,
      color: e.color, type: 'eject', owner: e.owner,
    }));
    const shots = this.shots.map(s => ({
      id: s.id, x: Math.round(s.x), y: Math.round(s.y), r: Math.round(s.r),
      color: s.color, type: 'virusShot',
    }));

    const p = this.players.get(playerId);
    const lb = this.leaderboard();
    const rank = lb.findIndex(r => r.id === playerId);

    return {
      t: 'state', now: Math.round(this.now * 1000) / 1000,
      world: { w: cfg.WORLD_W, h: cfg.WORLD_H },
      camera: { x: Math.round(cx), y: Math.round(cy), view },
      you: p ? {
        id: p.id, alive: !!mine.length, mass: Math.round(totalMass),
        cells: mine.length, rank: rank >= 0 ? rank + 1 : null,
        boostReadyIn: Math.max(0, p.boostReadyAt - this.now),
        boostActive: this.now < p.boostUntil,
        boostCooldown: cfg.BOOST_COOLDOWN,
      } : null,
      cells, viruses, food, eject, shots,
      leaderboard: lb.map((r, i) => ({ rank: i + 1, name: r.name, mass: r.mass, id: r.id })),
      // 미니맵용 전체 셀 위치(가벼운 좌표만)
      blips: this.cells.map(c => ({ x: Math.round(c.x), y: Math.round(c.y), r: Math.round(c.r), owner: c.owner })),
    };
  }

  // 스냅샷 후 호출: 일회성 event 비우기
  clearEvents() {
    for (const c of this.cells) c.event = null;
    for (const v of this.viruses) v.event = null;
  }
}

module.exports = { World, CONFIG, radiusOf, speedOf, makeRng };
