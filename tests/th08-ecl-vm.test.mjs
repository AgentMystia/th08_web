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
