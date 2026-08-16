// TH08 ECL interpreter regressions (Th08.exe v1.00d semantics decoded in
// reference/re-specs/th08-ecl-ops-*.md). Pins the raw-opcode dispatch, the
// TH08 variable system, call-frame semantics, and the FIRE prototype chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/th08-ecl-vm';
mkdirSync(outDir, { recursive: true });
execSync(
  `npx esbuild src/game/eclvm.ts src/formats/anm.ts src/data/th08-data.ts --bundle --format=esm ` +
  `--outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
);
const { StageRuntime } = await import('../tests/.build/th08-ecl-vm/game/eclvm.mjs');
const { Anm } = await import('../tests/.build/th08-ecl-vm/formats/anm.mjs');
const { TH08_DATA } = await import('../tests/.build/th08-ecl-vm/data/th08-data.mjs');

const i32 = (value) => ({ type: 'i32', value });
const f32 = (value) => ({ type: 'f32', value });
const varId = (value) => ({ type: 'f32', value }); // float-var ids are f32-encoded
const i16pair = (lo, hi) => ({ type: 'i32', value: (lo & 0xffff) | ((hi & 0xffff) << 16) });

function instruction(time, id, args = [], paramMask = 0, rank = 0xff) {
  const bytes = new Uint8Array(12 + args.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, time, true);
  view.setUint16(4, id, true);
  view.setUint16(6, bytes.length, true);
  view.setUint16(8, rank << 8, true);
  view.setUint16(10, paramMask, true);
  args.forEach((arg, index) => {
    if (arg.type === 'f32') view.setFloat32(12 + index * 4, arg.value, true);
    else view.setInt32(12 + index * 4, arg.value, true);
  });
  return bytes;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// TH08 container: u32 magic 0x800, then the TH07-style header at +4.
function makeEcl8(subs) {
  const headerSize = 4 + 4 + (16 + subs.length) * 4;
  const timeline = new Uint8Array(8);
  new DataView(timeline.buffer).setInt16(0, -1, true);
  const sentinel = new Uint8Array(12);
  new DataView(sentinel.buffer).setUint32(0, 0xffffffff, true);
  const bodies = subs.map((sub) => concat([...sub, sentinel]));
  const total = headerSize + timeline.length + bodies.reduce((sum, body) => sum + body.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x0800, true);
  view.setUint16(4, subs.length, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, headerSize, true);
  let offset = headerSize + timeline.length;
  bodies.forEach((body, index) => {
    view.setUint32(4 + 4 + (16 + index) * 4, offset, true);
    out.set(body, offset);
    offset += body.length;
  });
  out.set(timeline, headerSize);
  return out;
}

function makeHost(rngValues = []) {
  let rngIndex = 0;
  const observations = { bullets: 0, spells: [], sfx: [] };
  return {
    observations,
    rng: {
      range: () => 0,
      f: () => 0.5,
      u16: () => rngValues[rngIndex++] ?? 0,
      u16InRange: () => 0,
      u32: () => rngValues[rngIndex++] ?? 0,
      u32InRange: () => 0
    },
    difficulty: 3,
    rank: 16,
    frame: 0,
    id: 1,
    stageNumber: 1,
    slowRate: 1,
    player: { x: 192, y: 384 },
    enemies: [],
    enemyBullets: [],
    items: [],
    power: 0,
    score: 0,
    timeStopped: false,
    addScore(value) { observations.scores = (observations.scores ?? 0) + value; },
    spawnItem() {},
    spawnEffectParticles() {},
    spawnEnemyDeathEffect() {},
    playSfx(id) { observations.sfx.push(id); },
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    setBossPresent() {},
    unpauseStd() {}
  };
}

const etama = new Anm(TH08_DATA.anm.etama, 'etama');
const enemyAnm = new Anm(TH08_DATA.anm.stg1enm, 'stg1enm');
const effectAnm = new Anm(TH08_DATA.anm.eff01, 'eff01');

function makeRuntime(subs) {
  const stage = { ...TH08_DATA.stages[1], ecl: makeEcl8(subs) };
  return new StageRuntime(stage, { etama, enemy: enemyAnm, effect: effectAnm });
}

function runTicks(runtime, game, enemy, frames) {
  for (let i = 0; i < frames; i++) {
    game.frame = i;
    runtime.tickEnemyCore(game, enemy);
    runtime.integrateEnemyPosition(enemy, 1);
    if (enemy.dead) return;
  }
}

test('TH08 var math: remapped assign ops and the 3-operand a-b form', () => {
  // Sub0: t0 ins_7(10016 = 100.0); t1 ins_26(10017 = 10045 - 10042)
  const runtime = makeRuntime([[
    instruction(0, 7, [varId(10016.0), f32(100.0)]),
    instruction(1, 26, [varId(10017.0), varId(10045.0), varId(10042.0)], 0b111)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 40, y: 60 });
  runTicks(runtime, game, enemy, 3);
  // var 10017 = playerX(192) - enemyX(40) = 152; both are frame-scope float
  // slots (10016 -> idx 8, 10017 -> idx 9 of the TH08 layout).
  assert.equal(enemy.ecl.vars[8 + 1], 152);
  assert.equal(enemy.ecl.vars[8], 100);
});

test('TH08 enemy-scope locals survive a CALL that redefines frame locals', () => {
  // Sub0: set enemy int 10010 = 7; set frame int 10000 = 1; CALL Sub1;
  //       after return, Sub0 reads 10010 back into frame int 10001.
  // Sub1: overwrite 10010 = 9 (enemy scope), set frame int 10000 = 2, RETURN.
  const runtime = makeRuntime([
    [
      instruction(0, 6, [i32(10010), i32(7)]),
      instruction(1, 6, [i32(10000), i32(1)]),
      instruction(2, 52, [i32(1)]),
      instruction(3, 6, [i32(10001), i32(10010)], 0b10),
      instruction(4, 1)
    ],
    [
      instruction(0, 6, [i32(10010), i32(9)]),
      instruction(1, 6, [i32(10000), i32(2)]),
      instruction(2, 53)
    ]
  ]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  runTicks(runtime, game, enemy, 8);
  // The RETURN restores the caller's FRAME vars: 10000 is 1 again, and the
  // callee's enemy-scope write to 10010 stays visible (no rollback outside
  // the frame block).
  assert.equal(enemy.ecl.vars[0], 1);
  assert.equal(Math.trunc(enemy.ecl.vars[1]), 9);
});

test('TH08 FIRE spawns ways x stacks bullets with prototype art and hitbox', () => {
  // ins_96(type 0, offset 6, ways 3, stacks 2, speed 2, speed2 1, angle 0,
  // spread 0, tag 0): 6 bullets of the 8x8 pellet prototype. Rank 16 with
  // default +-0.5 bounds keeps speed above the 0.3 floor.
  const runtime = makeRuntime([[
    instruction(0, 77, [f32(24), f32(24)]),
    instruction(1, 96, [
      i16pair(0, 6), i32(3), i32(2), f32(2), f32(1), f32(0), f32(0), i32(0)
    ]),
    instruction(2, 1)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 100, life: 100 });
  runTicks(runtime, game, enemy, 4);
  assert.equal(game.enemyBullets.length, 6);
  const bullet = game.enemyBullets[0];
  // Prototype 0's main script is etama global script 0 (on-disk -150): the
  // 8x8 pellet row — sprite 6 sits at x 48, y 240 in etama.png.
  assert.equal(bullet.rect.w, 8);
  assert.equal(bullet.rect.h, 8);
  assert.equal(bullet.rect.y, 240);
  assert.equal(bullet.grazeW, 4); // h <= 8 -> 4.0 half-extent
  // Stacks lerp speed 2 -> 1 across the two rows.
  const speeds = game.enemyBullets.map((b) => b.speed);
  assert.ok(speeds.slice(0, 3).every((s) => Math.abs(s - 2) < 0.35));
  assert.ok(speeds.slice(3).every((s) => Math.abs(s - 1.5) < 0.35));
});

test('TH08 FIRE capture mode stores the raw instruction instead of firing', () => {
  const runtime = makeRuntime([[
    instruction(0, 77, [f32(24), f32(24)]),
    instruction(1, 107),
    instruction(2, 96, [
      i16pair(0, 0), i32(5), i32(1), f32(2), f32(2), f32(0), f32(0), i32(0)
    ]),
    instruction(3, 1)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 100, life: 100 });
  runTicks(runtime, game, enemy, 5);
  assert.equal(game.enemyBullets.length, 0);
  assert.ok(enemy.ecl.th08.capturedFire);
  assert.equal(enemy.ecl.th08.capturedFire[1] & 0xffff, 96);
});

test('all 21 TH08 bullet prototypes resolve their main script in etama.anm', () => {
  const runtime = makeRuntime([[]]);
  for (let type = 0; type <= 20; type++) {
    const rect = runtime.bulletRect(type, 0);
    assert.ok(rect.w > 0 && rect.h > 0, `prototype ${type} resolved no sprite`);
    assert.ok(rect.imageKey.startsWith('etama'), `prototype ${type} image ${rect.imageKey}`);
  }
  // Hitbox derivation: type 0 is the 8x8 pellet (4.0), type 10 the 64px
  // bubble (24.0), type 7 the 32px orb family (10.0 default branch).
  assert.equal(runtime.th08BulletHitbox(0), 4);
  assert.equal(runtime.th08BulletHitbox(10), 24);
  assert.equal(runtime.th08BulletHitbox(7), 10);
});

test('TH08 stage 1 boots and spawns waves through the real timeline', () => {
  const runtime = new StageRuntime(TH08_DATA.stages[1], {
    etama, enemy: enemyAnm, effect: effectAnm
  });
  const game = makeHost();
  for (let frame = 0; frame < 420; frame++) {
    game.frame = frame;
    runtime.update(game);
    for (const enemy of game.enemies) {
      runtime.updateEnemy(game, enemy);
    }
  }
  // Frame 1 invokes Sub14 (the opening direction controller); waves begin
  // around frame 400 (reference/re-specs/th08-stage1.md).
  assert.ok(game.enemies.length >= 1, `expected spawned enemies, got ${game.enemies.length}`);
  assert.ok(game.enemies.every((enemy) => Number.isFinite(enemy.x) && Number.isFinite(enemy.y)));
});

// ---- timeline v2 (FUN_0042a8a0) --------------------------------------------

// TH08 v2 timeline record: i32 time, u16 op, u8 size, u8 rank, args at +8.
function tlEvent(time, op, args = [], rank = 0xff) {
  const SPAWN32 = new Set([0, 1, 15]);
  const size = SPAWN32.has(op) ? 32 : 8 + args.length * 4;
  const bytes = new Uint8Array(Math.max(size, 8));
  const view = new DataView(bytes.buffer);
  view.setInt32(0, time, true);
  view.setUint16(4, op, true);
  view.setUint8(6, bytes.length, true);
  view.setUint8(7, rank, true);
  args.forEach((arg, index) => {
    if (arg.type === 'f32') view.setFloat32(8 + index * 4, arg.value, true);
    else view.setInt32(8 + index * 4, arg.value, true);
  });
  return bytes;
}

function makeEcl8Timelines(subs, timelines) {
  const headerSize = 4 + 4 + (16 + subs.length) * 4;
  const sentinel = new Uint8Array(12);
  new DataView(sentinel.buffer).setUint32(0, 0xffffffff, true);
  const tlEnd = new Uint8Array(8);
  new DataView(tlEnd.buffer).setInt32(0, -1, true);
  const tlBodies = timelines.map((tl) => concat([...tl, tlEnd]));
  const bodies = subs.map((sub) => concat([...sub, sentinel]));
  const tlSize = tlBodies.reduce((sum, b) => sum + b.length, 0);
  const total = headerSize + tlSize + bodies.reduce((sum, body) => sum + body.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x0800, true);
  view.setUint16(4, subs.length, true);
  view.setUint16(6, timelines.length, true);
  let offset = headerSize;
  tlBodies.forEach((body, index) => {
    view.setUint32(8 + index * 4, offset, true);
    out.set(body, offset);
    offset += body.length;
  });
  bodies.forEach((body, index) => {
    view.setUint32(4 + 4 + (16 + index) * 4, offset, true);
    out.set(body, offset);
    offset += body.length;
  });
  return out;
}

const tlSpawn = (time, sub, rank = 0xff, op = 0) =>
  tlEvent(time, op, [i32(sub), f32(120), f32(-16), i32(50), i32(-2), i32(500)], rank);

test('TH08 stage-1 real timelines parse with the v2 per-op layouts', () => {
  const ecl = new StageRuntime(TH08_DATA.stages[1], {
    etama, enemy: enemyAnm, effect: effectAnm
  }).ecl;
  assert.equal(ecl.timelines.length, 2);
  const hist = (events) => {
    const m = {};
    for (const e of events) m[e.op] = (m[e.op] ?? 0) + 1;
    return m;
  };
  // Binary ground truth walked from the embedded ecldata1.ecl.
  assert.deepEqual(hist(ecl.timelines[0]), { 0: 103, 1: 29, 6: 2, 7: 3, 8: 1, 10: 3, 14: 1 });
  assert.deepEqual(hist(ecl.timelines[1]), { 0: 47, 13: 1 });
  const mirror = ecl.timelines[0].find((e) => e.op === 1);
  assert.ok(mirror && mirror.life === 150 && typeof mirror.x === 'number');
});

test('TH08 timeline: op1 mirror spawn, rank filter, and the 13/14 latch', () => {
  // TL0: rank-gated spawns at t=1/2, mirror spawn t=3, latch release t=5.
  // TL1: parks on ins_13(1) at t=0, spawn at t=1 must wait for the release.
  const ecl = makeEcl8Timelines(
    [[instruction(0, 1)], [instruction(0, 1)], [instruction(0, 1)], [instruction(0, 1)]],
    [
      [
        tlSpawn(1, 0, 0x01),          // Easy-only: never fires on Lunatic
        tlSpawn(2, 1, 0x08),          // Lunatic: fires
        tlSpawn(3, 2, 0xff, 1),       // mirror spawn
        tlEvent(5, 14, [i32(1)])      // release timeline 1
      ],
      [
        tlEvent(0, 13, [i32(1)]),     // park until released
        tlSpawn(1, 3)                 // fires only after the release
      ]
    ]
  );
  const runtime = new StageRuntime(
    { ...TH08_DATA.stages[1], ecl },
    { etama, enemy: enemyAnm, effect: effectAnm }
  );
  const game = makeHost();
  const logAt = [];
  for (let frame = 0; frame < 10; frame++) {
    game.frame = frame;
    runtime.update(game);
    logAt.push(runtime.spawnLog.length);
  }
  const subs = runtime.spawnLog.map((s) => s.sub);
  assert.ok(!subs.includes(0), 'Easy-only event fired on Lunatic');
  assert.ok(subs.includes(1), 'Lunatic event missing');
  assert.ok(subs.includes(2), 'mirror spawn missing');
  assert.equal(runtime.spawnLog.find((s) => s.sub === 2)?.time, 3);
  // The parked timeline releases at frame 5 and its time-1 spawn lands at 6.
  const t1Index = subs.indexOf(3);
  assert.ok(t1Index >= 0, 'latched timeline never fired');
  assert.ok(logAt[4] === t1Index, `latched spawn fired before release: ${logAt}`);
  assert.ok(logAt[6] === t1Index + 1, `latched spawn late: ${logAt}`);
});

test('TH08 timeline: spawn ops drop while a boss is registered, op15 bypasses', () => {
  const ecl = makeEcl8Timelines(
    [
      [instruction(0, 1)],
      [instruction(0, 127, [i32(0)]), instruction(30, 1)], // registers boss slot 0
      [instruction(0, 1)],
      [instruction(0, 1)]
    ],
    [[tlSpawn(1, 2), tlSpawn(2, 3, 0xff, 15)]]
  );
  const runtime = new StageRuntime(
    { ...TH08_DATA.stages[1], ecl },
    { etama, enemy: enemyAnm, effect: effectAnm }
  );
  const game = makeHost();
  // Arm the timeline cursors first (production constructs + resets before any
  // enemy exists; the first update() would otherwise reset boss state).
  runtime.update(game);
  // Register a boss before the timeline spawns.
  const boss = runtime.spawnEclEnemy(game, { subId: 1, x: 192, y: 100, life: 1000 });
  runTicks(runtime, game, boss, 3);
  assert.ok(boss.ecl.isBoss, 'ins_127 did not register the boss slot');
  for (let frame = 1; frame < 6; frame++) {
    game.frame = frame;
    runtime.update(game);
  }
  const subs = runtime.spawnLog.map((s) => s.sub);
  assert.ok(!subs.includes(2), 'op0 spawn escaped the boss gate');
  assert.ok(subs.includes(3), 'op15 spawn was gated');
});

test('TH08 enemy anm file follows flags2 bit2: plain ops common, alt ops stage', () => {
  const commonAnm = new Anm(TH08_DATA.anm.enemy, 'enemy');
  const ecl = makeEcl8([
    [instruction(0, 55, [i32(0)]), instruction(10, 1)],  // plain dirAnmRun
    [instruction(0, 59, [i32(0)]), instruction(10, 1)]   // alt dirAnmRun
  ]);
  const runtime = new StageRuntime(
    { ...TH08_DATA.stages[1], ecl },
    { etama, enemy: commonAnm, effect: effectAnm, enemyStage: enemyAnm }
  );
  const game = makeHost();
  const fairy = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100, life: 100 });
  const boss = runtime.spawnEclEnemy(game, { subId: 1, x: 200, y: 100, life: 100 });
  runTicks(runtime, game, fairy, 2);
  runTicks(runtime, game, boss, 2);
  assert.equal(fairy.ecl.anmRunner?.anm, commonAnm, 'plain op did not use enemy.anm');
  assert.equal(boss.ecl.anmRunner?.anm, enemyAnm, 'alt op did not use stg1enm.anm');
});

test('TH08 conditional jump remap: ins_51 (float >=) guards a call', () => {
  // If 10045 (playerX) >= 192, set 10000 = 1, else 10000 = 2.
  const runtime = makeRuntime([[
    instruction(0, 51, [varId(10045.0), f32(192.0), i32(0), i32(20)], 0b01),
    instruction(1, 6, [i32(10000), i32(1)]),
    instruction(2, 1),
    instruction(0, 6, [i32(10000), i32(2)]),
    instruction(1, 1)
  ]]);
  const game = makeHost();
  game.player.x = 100; // below 192 -> the jump must NOT fire... wait: NOT >= -> fall through
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
  runTicks(runtime, game, enemy, 4);
  // playerX 100 < 192 -> no jump -> 10000 = 1 via fall-through, then ret.
  assert.equal(Math.trunc(enemy.ecl.vars[0]), 1);
});
