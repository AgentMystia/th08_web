// TH08 pacing/convergence regressions — Th08.exe v1.00d semantics decoded in
// the 2026-08-19 pass:
//  - timeline hold ops 7/10/13 NET-FREEZE the clock (FUN_00418110 Subtract(1)
//    before goto LAB_0042ad52 Tick — net zero while parked; ops fire only on
//    exact clock match, so a parked-but-running clock would compact every op
//    between two holds);
//  - the dialogue-start sweep FUN_0042efb0(0,0): ordinary enemies die via the
//    hp=0 death path, flags2-bit6 controllers are spared, value cap 0;
//  - the spawn-transition creep: state 2 = vel/2 per tick for duration+2
//    manager ticks, then the frac+full fall-through move (0x431240 immediates
//    0x40000000; FUN_0045e430 constructs the VM with no synchronous t0 pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/th08-pacing';
mkdirSync(outDir, { recursive: true });
execSync(
  `npx esbuild src/game/eclvm.ts src/formats/anm.ts src/data/th08-data.ts --bundle --format=esm ` +
  `--outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
);
const { StageRuntime } = await import(`../${outDir}/game/eclvm.mjs`);
const { Anm } = await import(`../${outDir}/formats/anm.mjs`);
const { TH08_DATA } = await import(`../${outDir}/data/th08-data.mjs`);

// ---------------------------------------------------------------------------
// Helpers (mirroring tests/th08-familiar.test.mjs)

const etamaAnm = new Anm(TH08_DATA.anm.etama, 'etama');
const enemyAnm = new Anm(TH08_DATA.anm.enemy, 'enemy');

const f32 = (v) => ({ kind: 'f32', v });
const i32 = (v) => ({ kind: 'i32', v });
function instruction(time, opcode, args) {
  const size = 12 + args.length * 4;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, opcode, true);
  dv.setUint16(2, size, true);
  dv.setInt16(4, time, true);
  dv.setUint16(6, 0xffff, true); // full rank mask
  args.forEach((a, i) => {
    if (a.kind === 'f32') dv.setFloat32(8 + i * 4, a.v, true);
    else dv.setInt32(8 + i * 4, a.v, true);
  });
  return out;
}
function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// TH08 timeline v2 record: i32 time, u16 op, u8 size, u8 rank, args.
function tlSpawn(time, sub) {
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, time, true);
  dv.setUint16(4, 0, true); // spawn op
  dv.setUint8(6, 32);
  dv.setUint8(7, 0xff);
  dv.setInt32(8, sub, true);
  dv.setFloat32(12, 100, true);
  dv.setFloat32(16, 100, true);
  dv.setInt32(20, 10, true);
  dv.setInt32(24, 0, true);
  dv.setInt32(28, 0, true);
  return out;
}
function tlOp(time, op) {
  const out = new Uint8Array(12);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, time, true);
  dv.setUint16(4, op, true);
  dv.setUint8(6, 12);
  dv.setUint8(7, 0xff);
  return out;
}
const tlSentinel = (() => {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setInt32(0, -1, true);
  return out;
})();

function makeEcl8(subs, timelineEvents) {
  const headerSize = 4 + 4 + (16 + subs.length) * 4;
  const timeline = concat(timelineEvents);
  const sentinel = new Uint8Array(12);
  new DataView(sentinel.buffer).setUint32(0, 0xffffffff, true);
  const bodies = subs.map((sub) => concat([...sub, sentinel]));
  const total = headerSize + timeline.length + bodies.reduce((sum, b) => sum + b.length, 0);
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

function makeHost(extra = {}) {
  return {
    rng: { range: () => 0, f: () => 0.5, u16: () => 0, u16InRange: () => 0, u32: () => 0, u32InRange: () => 0 },
    difficulty: 3,
    rank: 8,
    frame: 0,
    id: 1,
    enemies: [],
    enemyBullets: [],
    items: [],
    playerBullets: [],
    playSfx: () => {},
    addEnemyBullet: () => true,
    player: { x: 192, y: 384 },
    consumeDialogueResume: () => false,
    isDialogueActive: () => false,
    ...extra
  };
}

// ---------------------------------------------------------------------------

test('timeline op7 parks with a NET-FROZEN clock; the next op fires on its authored time', () => {
  // Timeline: spawn at t=5, dialogue-hold at t=5, second spawn at t=15.
  const subBody = [instruction(0, 1, [])]; // die immediately (raw opcode 1)
  const runtime = new StageRuntime(
    { ...TH08_DATA.stages[1], ecl: makeEcl8([subBody], [tlSpawn(5, 0), tlOp(5, 7), tlSpawn(15, 0), tlSentinel]) },
    { etama: etamaAnm, enemy: enemyAnm, effect: etamaAnm }
  );
  let dialogue = false;
  const game = makeHost({ isDialogueActive: () => dialogue });
  runtime.reset?.();
  const countEnemies = () => runtime.spawnLog.length;
  const step = (n) => { for (let i = 0; i < n; i++) runtime.update(game); };

  // Five updates bring the clock to 5; the dialogue opens before the pass
  // that evaluates the t=5 ops, so the spawn fires and op7 parks in one go.
  step(5);
  dialogue = true;
  step(1);
  assert.equal(countEnemies(), 1, 't=5 spawn fired');
  // 40 ticks parked: the clock must NOT advance (net Subtract+Tick = 0), so
  // the second op (t=15) must not fire — under the retracted "advance"
  // reading it would have fired within 10 ticks.
  step(40);
  assert.equal(countEnemies(), 1, 'clock frozen while the hold parks');
  // Release: the clock resumes from 5, so the t=15 op fires 10 ticks later —
  // not on the release tick itself.
  dialogue = false;
  step(1);
  assert.equal(countEnemies(), 1, 'release tick: clock is only at 6');
  step(9);
  assert.equal(countEnemies(), 1, 'clock 15 only at the END of the 10th tick');
  step(1);
  assert.equal(countEnemies(), 2, 't=15 op fires exactly on clock 15');
});

test('the dialogue sweep (FUN_0042efb0(0,0)) kills via hp=0, spares controllers and bosses, caps values at 0', () => {
  const subBody = [instruction(0, 1, [])];
  const runtime = new StageRuntime(
    { ...TH08_DATA.stages[1], ecl: makeEcl8([subBody], [tlSentinel]) },
    { etama: etamaAnm, enemy: enemyAnm, effect: etamaAnm }
  );
  const game = makeHost();
  const plain = runtime.spawnEclEnemy(game, { subId: 0, x: 50, y: 50, life: 100 });
  const controller = runtime.spawnEclEnemy(game, { subId: 0, x: 60, y: 50, life: 100 });
  controller.ecl.th08.flags2 |= 0x40; // the exempt bit (ambient Sub14 family)
  const boss = runtime.spawnEclEnemy(game, { subId: 0, x: 70, y: 50, life: 100 });
  boss.ecl.isBoss = true;
  const drops = [];
  game.spawnItem = (type, x, y) => { drops.push({ type, x, y }); };

  const total = runtime.killNonBossEnemies(game, null, 0, 0);
  assert.equal(plain.hp, 0, 'ordinary enemy swept through the death path');
  assert.equal(controller.hp, 100, 'flags2-bit6 controller spared');
  assert.equal(boss.hp, 100, 'boss spared');
  assert.equal(total, 0, 'no drop-flag enemies: nothing banked');
  assert.equal(drops.length, 0, 'no sweep items without the drop flag');
});

test('state-2 transition creeps at vel/2 for duration+2 ticks, then the frac+full fall-through', async () => {
  const { loadEngine, makeStubAssetsTh08, makeStubAudio } = await import('../scripts/lib/replay-harness.mjs');
  const mod = await loadEngine();
  const scene = new mod.StageScene(makeStubAssetsTh08(mod), makeStubAudio(), 3, 'reimuYukari', 1, null, 1);
  scene.mode = 'test';
  const rt = scene.runtime;
  const shooter = rt.spawnEclEnemy(scene, { subId: 0, x: 100, y: 100, life: 1000 });
  shooter.ecl.shootOffset = { x: 0, y: 0 };
  // Absolute single shot, speed 1, flags 2 (state 2): the sprite-2 flash
  // script's op1@t10 gives duration 10; scale must be 1/2 (TH08 table).
  rt.spawnBullets(scene, shooter, {
    sprite: 2, offset: 2, count1: 1, count2: 1,
    speed1: 1, speed2: 1, angle1: 0, angle2: 0,
    flags: 2, sfx: 0, exSlots: [], aimMode: 3
  });
  const b = scene.enemyBullets[scene.enemyBullets.length - 1];
  assert.equal(b.spawnDuration, 10, 'flash script op1@t10 -> 10');
  assert.equal(b.spawnMoveScale, 0.5, 'state-2 creep = vel/2 (0x40000000)');
  assert.equal(Math.round(b.x * 1000) / 1000, 96, 'construction: origin - 4v backup');
  const empty = { held: new Set(), pressed: new Set() };
  const xAfter = (n) => {
    for (let i = 0; i < n; i++) scene.update(empty);
    return Math.round(b.x * 1000) / 1000;
  };
  assert.equal(xAfter(1), 96.5, 'tick 1: first half-step');
  assert.equal(xAfter(11), 102, 'ticks 2..12: half-steps (13 total)');
  assert.equal(xAfter(1), 103.5, 'tick 13 (age 12 = D+2): frac + full fall-through');
  assert.equal(xAfter(1), 104.5, 'tick 14: full velocity only');
});
