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
const { StageRuntime, TH08_RAW_OPCODE_COVERAGE } = await import('../tests/.build/th08-ecl-vm/game/eclvm.mjs');
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

function makeHost(rngValues = [], rngFloat = 0.5) {
  let rngIndex = 0;
  const observations = { bullets: 0, spells: [], sfx: [] };
  return {
    observations,
    rng: {
      range: () => 0,
      f: () => rngFloat,
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

test('TH08 var math: raw compound assigns and the 3-operand a-b form', () => {
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

test('TH08 vars 10085-10087 expose the native additive position offset', () => {
  // Stage-1 Sub32 reads 10085/10086 to build its cubic boss-movement
  // control points. Falling through to the literal variable id launches the
  // boss roughly a million pixels away, so pin both storage and arithmetic.
  const runtime = makeRuntime([[
    instruction(0, 7, [varId(10085), f32(2.5)]),
    instruction(0, 7, [varId(10086), f32(-1.25)]),
    instruction(0, 27, [varId(10016), varId(10085), f32(100)], 0b111),
    instruction(0, 27, [varId(10017), varId(10086), f32(100)], 0b111),
    instruction(1, 1)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 40, y: 60 });
  runTicks(runtime, game, enemy, 2);
  assert.deepEqual(enemy.ecl.th08.movement.positionOffset, { x: 2.5, y: -1.25, z: 0 });
  assert.equal(enemy.ecl.vars[8], 250);
  assert.equal(enemy.ecl.vars[9], -125);
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
    assert.ok(runtime.createBulletClearRunner(type), `prototype ${type} resolved no clear script`);
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
  const trace = [];
  game.traceReplayEvent = (event) => trace.push(event);
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
  assert.ok(trace.some((event) => event.kind === 'timeline'));
  assert.ok(trace.some((event) => event.kind === 'enemy-spawn'));
  assert.ok(trace.some((event) => event.kind === 'ecl'));
});

test('TH08 Stage-1 opening mob waves retain the authored Lunatic spawn and FIRE signature', { skip: 'baseline captured on the parked movement rework (999b644); re-baseline against the restored engine before unskipping' }, () => {
  const runtime = new StageRuntime(TH08_DATA.stages[1], {
    etama, enemy: enemyAnm, effect: effectAnm
  });
  const game = makeHost();
  game.rank = 8;
  const trace = [];
  game.traceReplayEvent = (event) => {
    if (event.kind === 'enemy-spawn' || event.kind === 'fire') trace.push(event);
  };
  for (let frame = 0; frame < 920; frame++) {
    game.frame = frame;
    runtime.update(game);
    for (const enemy of game.enemies) runtime.updateEnemy(game, enemy);
  }

  const roots = trace.filter((event) =>
    event.kind === 'enemy-spawn' && event.data.parentId == null
  );
  const smallFairies = roots.filter((event) => event.sub === 0).map((event) => [
    event.frame, event.data.x
  ]);
  // ecldata1 Timeline0: two six-enemy left waves, then twelve enemies from
  // the right at 10-frame spacing. This is the visible opening formation in
  // the native user-demo captures.
  assert.deepEqual(smallFairies, [
    [400, 30], [420, 60], [440, 90], [460, 40], [480, 70], [500, 100],
    [600, 30], [620, 60], [640, 90], [660, 40], [680, 70], [700, 100],
    [800, 354], [810, 324], [820, 294], [830, 344], [840, 314], [850, 284],
    [860, 354], [870, 324], [880, 294], [890, 344], [900, 314], [910, 284]
  ]);
  assert.deepEqual(
    roots.filter((event) => event.sub === 1 || event.sub === 3).map((event) => ({
      frame: event.frame, sub: event.sub, x: event.data.x, y: event.data.y,
      mirrored: event.data.mirrored
    })),
    [
      { frame: 500, sub: 1, x: 320, y: -32, mirrored: true },
      { frame: 850, sub: 3, x: 192, y: -32, mirrored: false }
    ]
  );

  const primaryFire = trace.filter((event) =>
    event.kind === 'fire' && (event.sub === 1 || event.sub === 3)
  );
  const fireSignature = (event) => ({
    sub: event.sub, clock: event.clock,
    sprite: event.data.sprite, offset: event.data.offset,
    ways: event.data.count1, stacks: event.data.count2,
    speed1: event.data.speed1, speed2: event.data.speed2,
    angle2: event.data.angle2, aimMode: event.data.aimMode,
    flags: event.data.flags
  });
  assert.deepEqual(primaryFire.slice(0, 2).map(fireSignature), [
    {
      sub: 1, clock: 30, sprite: 2, offset: 2, ways: 32, stacks: 2,
      speed1: Math.fround(Math.fround(2.1) - 0.25), speed2: Math.fround(0.375),
      angle2: Math.fround(0.18479957), aimMode: 3, flags: 515
    },
    {
      sub: 1, clock: 34, sprite: 2, offset: 2, ways: 5, stacks: 3,
      speed1: Math.fround(2.95), speed2: Math.fround(0.875),
      angle2: Math.fround(0.08975979), aimMode: 0, flags: 515
    }
  ]);
  const firstSub3Ring = primaryFire.find((event) => event.sub === 3 && event.clock === 30);
  assert.ok(firstSub3Ring, 'central primary fairy never emitted its 32x2 ring');
  assert.deepEqual(fireSignature(firstSub3Ring), {
    sub: 3, clock: 30, sprite: 2, offset: 2, ways: 32, stacks: 2,
    speed1: Math.fround(Math.fround(2.1) - 0.25), speed2: Math.fround(0.375),
    angle2: Math.fround(0.18479957), aimMode: 3, flags: 515
  });

  const orbitChildren = trace.filter((event) =>
    event.kind === 'enemy-spawn' && event.data.parentId != null &&
    (event.sub === 2 || event.sub === 4)
  );
  assert.deepEqual(orbitChildren.map((event) => [event.frame, event.sub, event.data.x, event.data.y]), [
    [559, 2, 320, 100], [559, 2, 320, 100],
    [909, 4, 192, 100], [909, 4, 192, 100]
  ]);
});

test('every raw opcode in Stage 1 is covered by the TH08-native dispatcher', () => {
  const runtime = new StageRuntime(TH08_DATA.stages[1], {
    etama, enemy: enemyAnm, effect: effectAnm
  });
  const used = new Set();
  for (let sub = 0; sub < runtime.ecl.subCount; sub++) {
    for (const instr of runtime.ecl.sub(sub)) used.add(instr.id);
  }
  const missing = [...used].filter((opcode) => !TH08_RAW_OPCODE_COVERAGE.has(opcode));
  assert.deepEqual(missing, [], `unhandled Stage-1 raw opcodes: ${missing.join(', ')}`);
  assert.ok(used.size > 80, `unexpectedly small opcode census: ${used.size}`);
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
  const lunaticMobSubs = new Set([0, 1, 3, 5, 11, 13]);
  const spawnOps = new Set([0, 1, 2, 3, 4, 5, 11, 12, 15]);
  const mobCensus = {};
  for (const timeline of ecl.timelines) {
    for (const event of timeline) {
      if (!spawnOps.has(event.op) || ((event.rank ?? 0xff) & 0x08) === 0 ||
          !lunaticMobSubs.has(event.arg0)) continue;
      mobCensus[event.arg0] = (mobCensus[event.arg0] ?? 0) + 1;
    }
  }
  // All Stage-1 non-boss roots, including the Timeline1 waves released by
  // the midboss latch. Child orbiters are intentionally counted by their
  // own spawn/FIRE regression above rather than as authored timeline rows.
  assert.deepEqual(mobCensus, { 0: 107, 1: 3, 3: 5, 5: 5, 11: 3, 13: 50 });
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

test('TH08 timeline op8 calls the sub registered by raw op126', () => {
  // Stage-1 boss handoff in miniature: the boss registers slot 1 -> Sub1,
  // then timeline op8 writes pending index 1. The next enemy core tick must
  // enter Sub1 through the native dynamic-call table, preserving the caller.
  const ecl = makeEcl8Timelines(
    [
      [
        instruction(0, 127, [i32(0)]),
        instruction(0, 126, [i32(1), i32(1)]),
        instruction(100, 1)
      ],
      [
        instruction(0, 6, [i32(10000), i32(42)]),
        instruction(100, 1)
      ]
    ],
    [[tlSpawn(0, 0), tlEvent(1, 8, [i32(0), i32(1), i32(0)])]]
  );
  const runtime = new StageRuntime(
    { ...TH08_DATA.stages[1], ecl },
    { etama, enemy: enemyAnm, effect: effectAnm }
  );
  const game = makeHost();
  for (let frame = 0; frame < 3; frame++) {
    game.frame = frame;
    runtime.update(game);
    for (const enemy of [...game.enemies]) runtime.updateEnemy(game, enemy);
  }
  const boss = game.enemies[0];
  assert.ok(boss && !boss.dead, 'boss disappeared during the dynamic call');
  assert.equal(boss.ecl.ctx.subId, 1);
  assert.equal(Math.trunc(boss.ecl.vars[0]), 42);
  assert.equal(boss.ecl.stack.length, 1, 'caller context was not preserved');
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

test('TH08 raw conditional jump: ins_51 (float >=) guards a call', () => {
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

test('FUN_00422c40 mode 1 integrates polar angle, speed, and its stop timer', { skip: 'movement rework parked at 999b644: reverted for the f3301 release convergence; restore with the rework' }, () => {
  const runtime = makeRuntime([[
    instruction(1, 65, [f32(0), f32(1)]),
    instruction(1, 70, [f32(0.1)]),
    instruction(1, 71, [f32(0.5)]),
    instruction(20, 1)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100, life: 100 });
  runTicks(runtime, game, enemy, 1);
  assert.equal(enemy.ecl.th08.movement.mode, 1);
  assert.ok(Math.abs(enemy.ecl.th08.movement.angle - Math.fround(0.1)) < 1e-6);
  assert.equal(enemy.ecl.th08.movement.speed, 1.5);
  assert.ok(Math.abs(enemy.x - Math.fround(100 + Math.cos(Math.fround(0.1)) * 1.5)) < 1e-5);
});

test('ins_66 mode 2 follows the native duration/ease target and mirror double-flip', { skip: 'movement rework parked at 999b644: reverted for the f3301 release convergence; restore with the rework' }, () => {
  const runtime = makeRuntime([[
    instruction(1, 66, [i32(4), i32(0), f32(0), f32(2)]),
    instruction(20, 1)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, {
    subId: 0, x: 100, y: 100, life: 100, mirrored: true
  });
  runTicks(runtime, game, enemy, 1);
  assert.equal(enemy.ecl.th08.movement.mode, 2);
  assert.equal(enemy.ecl.th08.movement.timerCurrent, 3);
  assert.equal(enemy.ecl.th08.movement.displacement.x, -8);
  assert.equal(enemy.x, 98);
  runTicks(runtime, game, enemy, 3);
  assert.equal(enemy.ecl.th08.movement.mode, 0);
  assert.equal(enemy.x, 92);
  assert.deepEqual(enemy.ecl.axisSpeed, { x: 0, y: 0, z: 0 });
});

test('FUN_00422c40 mode 3 tracks a polar offset around its captured origin', { skip: 'movement rework parked at 999b644: reverted for the f3301 release convergence; restore with the rework' }, () => {
  const runtime = makeRuntime([[
    instruction(1, 73, [i32(4), f32(0), f32(Math.PI / 2), f32(1)]),
    instruction(20, 1)
  ]]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100, life: 100 });
  runTicks(runtime, game, enemy, 1);
  assert.equal(enemy.ecl.th08.movement.mode, 3);
  assert.ok(Math.abs(enemy.x - 100) < 1e-5);
  assert.ok(Math.abs(enemy.y - 101) < 1e-5);
  runTicks(runtime, game, enemy, 1);
  assert.ok(Math.abs(enemy.x - 98) < 1e-4);
  assert.ok(Math.abs(enemy.y - 100) < 1e-4);
});

test('ins_67 folds a random upward exit away from the armed top margin', { skip: 'movement rework parked at 999b644: reverted for the f3301 release convergence; restore with the rework' }, () => {
  const runtime = makeRuntime([[
    instruction(1, 75, [f32(0), f32(0), f32(384), f32(448)]),
    instruction(1, 67, [i32(4), i32(0), f32(1)]),
    instruction(20, 1)
  ]]);
  const game = makeHost([], 0);
  game.player.x = 192;
  // The fold reads enemy+0x2d34 through FUN_0040b460, not player Y. Keep
  // the player far below while putting the enemy itself inside the margin.
  game.player.y = 384;
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 10, life: 100 });
  runTicks(runtime, game, enemy, 1);
  assert.ok(enemy.x > 100, `expected rightward folded move, x=${enemy.x}`);
  assert.ok(enemy.y > 10, `top-margin fold must point down, y=${enemy.y}`);
});
