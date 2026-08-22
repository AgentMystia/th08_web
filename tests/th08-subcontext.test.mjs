import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// TH08 ins_135 sub-ECL contexts carry a PRIVATE call stack (the native
// sub-context is a full ECL context). Regression: sharing the enemy's main
// stack let a returned sub-context (Sub61's trailing ins_53) steal the main
// caller's frame — stage-2 Mystia's Sub32→Sub58 call frame got popped, the
// sub-context re-entered Sub32 and re-called Sub58 every frame (boss hp
// refilled each ~410 frames, then the spell re-declared every frame).
//
// Also locks ins_136 (builtin dispatch) and the ins_142/ins_168 scatter
// showers (exe cases 0x87/0x8d/0xa7).

const outDir = 'tests/.build/th08-subcontext';
mkdirSync(outDir, { recursive: true });
execSync(
  `npx esbuild src/game/eclvm.ts src/formats/anm.ts src/data/th08-data.ts --bundle --format=esm ` +
  `--outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
);
const { StageRuntime } = await import(`../${outDir}/game/eclvm.mjs`);
const { Anm } = await import(`../${outDir}/formats/anm.mjs`);
const { TH08_DATA } = await import(`../${outDir}/data/th08-data.mjs`);

const i32 = (value) => ({ type: 'i32', value });
const f32 = (value) => ({ type: 'f32', value });

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
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
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
function makeHost() {
  return {
    rng: { range: () => 0, f: () => 0.5, u16: () => 0, u16InRange: () => 0, u32: () => 0, u32InRange: () => 0 },
    difficulty: 3, rank: 16, frame: 0, id: 1, stageNumber: 2, slowRate: 1,
    player: { x: 192, y: 384 },
    enemies: [], enemyBullets: [], enemyLasers: [], items: [],
    power: 0, score: 0, timeStopped: false,
    th08PlayerForm: () => 0,
    th08SetSideMirror() {},
    addScore() {},
    spawnItem(type, x, y) { this.itemLog.push({ type, x, y }); },
    spawnEffectParticles() {},
    spawnEnemyDeathEffect() {},
    playSfx() {},
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    setBossPresent() {},
    unpauseStd() {},
    startScreenShake(duration, from, to) { this.shakeLog.push({ duration, from, to }); },
    itemLog: [],
    shakeLog: []
  };
}
const etamaAnm = new Anm(TH08_DATA.anm.etama, 'etama');
const enemyAnm = new Anm(TH08_DATA.anm.stg2enm, 'stg2enm');
function makeRuntime(subs) {
  const stage = { ...TH08_DATA.stages[1], ecl: makeEcl8(subs) };
  return new StageRuntime(stage, { etama: etamaAnm, enemy: enemyAnm, effect: etamaAnm, enemyStage: enemyAnm });
}
function runTicks(runtime, game, frames) {
  for (let i = 0; i < frames; i++) {
    game.frame = i;
    for (const e of [...game.enemies]) {
      if (e.dead) continue;
      runtime.tickEnemyCore(game, e);
      runtime.integrateEnemyPosition(e, 1);
    }
  }
}

test('a returned sub-context never steals the main call frame', () => {
  // Sub0 (main) CALLs Sub1; Sub1 arms slot 0 = Sub2 and waits forever;
  // Sub2 returns at once (ins_53, Mystia Sub61's shape). Native: the return
  // pops Sub2's OWN (empty) stack and the context parks. Broken port: the
  // return popped the SHARED stack, stealing Sub0→Sub1's frame, and the
  // sub-context became a second Sub0 re-calling Sub1 every frame.
  const runtime = makeRuntime([
    [instruction(0, 52, [i32(1)])], // Sub0: call Sub1
    [ // Sub1: arm slot 0 = Sub2, then wait forever
      instruction(0, 135, [i32(0), i32(2)]),
      instruction(1, 2, [i32(60000)])
    ],
    [instruction(0, 53, [])] // Sub2: return immediately
  ]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 96 });
  runTicks(runtime, game, 20);
  assert.equal(enemy.ecl.ctx.subId, 1, 'main context still inside the called Sub1');
  assert.equal(enemy.ecl.stack.length, 1, 'the Sub0->Sub1 call frame intact (no growth, no theft)');
  assert.ok(!enemy.dead, 'the enemy survives its sub-context returning');
});

test('ins_168 scatters n point items (2 rand01 draws each, +-64 per axis)', () => {
  const runtime = makeRuntime([[instruction(0, 168, [i32(3)])]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 120 });
  runTicks(runtime, game, 2);
  // rng.f() = 0.5 -> offset 0.5*128-64 = 0: all three at the enemy pos.
  assert.deepEqual(game.itemLog, [
    { type: 'point', x: 100, y: 120 },
    { type: 'point', x: 100, y: 120 },
    { type: 'point', x: 100, y: 120 }
  ]);
});

test('ins_142 tiers by player power: powerBig first, powerSmall rest, all point at max', () => {
  const runtime = makeRuntime([[instruction(0, 142, [i32(3)])]]);
  const low = makeHost();
  runtime.spawnEclEnemy(low, { subId: 0, x: 100, y: 120 });
  runTicks(runtime, low, 2);
  assert.deepEqual(low.itemLog.map((i) => i.type), ['powerBig', 'powerSmall', 'powerSmall']);
  const full = makeHost();
  full.power = 128;
  runtime.spawnEclEnemy(full, { subId: 0, x: 100, y: 120 });
  runTicks(runtime, full, 2);
  assert.deepEqual(full.itemLog.map((i) => i.type), ['point', 'point', 'point']);
});

test('ins_136(1) arms the 21-frame screen shake (builtin table slot 1)', () => {
  const runtime = makeRuntime([[instruction(0, 136, [i32(1), i32(0)])]]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 120 });
  runTicks(runtime, game, 2);
  assert.deepEqual(game.shakeLog, [{ duration: 0x15, from: 0, to: 0 }]);
});

// TH08 phase transitions free the ins_135 sub-contexts (FUN_0042b490 /
// FUN_0042b930, all.c:20639/20800, re-specs th08-ecl-ops-0x5f-0x8f.md §2).
// Regression: without the free, the H/L midboss carried Sub16's Sub17
// nonspell volley loop into the 螢符 spell phase.
test('a life-threshold phase jump frees all ins_135 sub-contexts', () => {
  const runtime = makeRuntime([
    [ // Sub0: pool 100, threshold 50 -> Sub2, arm sub-context slot 0 = Sub1
      instruction(0, 131, [i32(100)]),
      instruction(0, 133, [i32(0), i32(50), i32(2)]),
      instruction(0, 135, [i32(0), i32(1)]),
      instruction(1, 2, [i32(60000)])
    ],
    [instruction(0, 2, [i32(60000)])], // Sub1: parked sub-context body
    [instruction(0, 2, [i32(60000)])] // Sub2: the phase target
  ]);
  const game = makeHost();
  const enemy = runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 96 });
  game.frame = 0;
  runtime.processEnemyCallbacks(game, enemy);
  assert.equal(enemy.ecl.th08.subContexts.length, 1, 'sub-context armed before the jump');
  enemy.hp = 40; // pool drops below the 50 threshold
  game.frame = 1;
  runtime.tickEnemyCore(game, enemy);
  runtime.processEnemyCallbacks(game, enemy);
  assert.equal(enemy.ecl.ctx.subId, 2, 'main context jumped to the threshold sub');
  assert.equal(
    enemy.ecl.th08.subContexts.length, 0,
    'FUN_0042b490 frees all four sub contexts on the phase jump'
  );
});

// FUN_00422720's emission loop is `for (i < count1)` — count1 0 fires
// NOTHING. Sub48's ins_30 decay of [10039] to 0 is the authored shutdown of
// the Last Spell fans; the old Math.max(1, ...) clamp kept firing one-bullet
// volleys forever.
test('FIRE with count1=0 emits no bullets', () => {
  const runtime = makeRuntime([
    [instruction(0, 96, [i32(2), i32(1), i32(1), f32(1.8), f32(0.5), f32(0), f32(0.18479957), i32(515)])]
  ]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 96 });
  runTicks(runtime, game, 3);
  assert.equal(game.enemyBullets.length, 0);
});

// Th08.exe bullet pool is 0x600 = 1536 slots (manager @ 0xf54e90, native
// slot trace). The inherited TH07 cap 0x400 saturated during Wriggle's
// final card and the census veto silently dropped the familiars' volleys
// (the 終符使魔不发弹 report): the boss (earlier slot) kept firing while
// the later familiars' fires were rejected whole.
test('the bullet pool accepts TH08-native densities past TH07\'s 0x400', () => {
  const runtime = makeRuntime([
    // sprite 2 (low u16), count1 = 1500 (high u16) — one 1500-bullet fan
    [instruction(0, 96, [i32((1500 << 16) | 2), i32(1), i32(1), f32(1.0), f32(1.0), f32(0), f32(0), i32(515)])]
  ]);
  const game = makeHost();
  runtime.spawnEclEnemy(game, { subId: 0, x: 192, y: 96 });
  runTicks(runtime, game, 3);
  assert.equal(
    game.enemyBullets.length, 1500,
    'a 1500-bullet volley must fully allocate (TH07-era 1024 cap dropped 476)'
  );
});
