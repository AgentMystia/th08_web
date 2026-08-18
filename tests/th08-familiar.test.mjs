// TH08 enemy-familiar (使魔) system regressions — Th08.exe v1.00d semantics
// decoded in this session:
//  - player form byte player+5 (FUN_0044aec0): focus follows with a
//    stability gate (flip on the 8th frame counting the toggle), the
//    transition tint only after >= 5 held frames, aura in/out requests;
//  - familiar marking on child spawns (ops 90-93, all.c:12020-12117):
//    flags bit 8 + side bit 11 + manager list + contact cleared + sfx 36;
//  - FIRE(16) re-arms shootability/contact through the semantic flags;
//  - the ECL form-rank gate (all.c:10801): a familiar's instructions must
//    additionally carry the current form bit (0x20 human / 0x40 youkai);
//  - the 46-channel sfx id table (.data 0x4c8040 over the 36-file bank
//    table 0x4c81b0): enep00 kill slots 2/3, miss 4, familiar family
//    36/39/40.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/th08-familiar';
mkdirSync(outDir, { recursive: true });
execSync(
  `npx esbuild src/game/player.ts src/game/eclvm.ts src/game/stage-scene.ts src/formats/anm.ts src/data/th08-data.ts --bundle --format=esm ` +
  `--outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
);
const { Player } = await import(`../${outDir}/game/player.mjs`);
const { StageRuntime } = await import(`../${outDir}/game/eclvm.mjs`);
const { TH08_SFX_SLOTS } = await import(`../${outDir}/game/stage-scene.mjs`);
const { Anm } = await import(`../${outDir}/formats/anm.mjs`);
const { TH08_DATA } = await import(`../${outDir}/data/th08-data.mjs`);

// ---------------------------------------------------------------------------
// Player form byte

const anms = { player00: new Anm(TH08_DATA.anm.player00, 'player00') };

function inputOf(held) {
  return { held: new Set(held), pressed: new Set() };
}

test('form byte flips 7 frames after the focus edge (stability gate > 6)', () => {
  const p = new Player('reimuYukari', anms);
  assert.equal(p.th08Form, 0, 'unfocused start = human');
  // Focus from frame 1 on. th08FocusFrames counts the toggle frame as 1;
  // the native counter (player+8, 0 on the toggle) passes 6 on the 8th
  // frame counting the toggle — our >7 gate.
  for (let i = 0; i < 7; i++) {
    p.update(inputOf(['focus']), 1);
    assert.equal(p.th08Form, 0, `frame ${i + 1}: still human`);
  }
  p.update(inputOf(['focus']), 1); // 8th frame counting the toggle
  assert.equal(p.th08Form, 1, 'youkai on the 8th frame');
  // Release: flips back the same way.
  for (let i = 0; i < 7; i++) {
    p.update(inputOf([]), 1);
    assert.equal(p.th08Form, 1, `release frame ${i + 1}: still youkai`);
  }
  p.update(inputOf([]), 1);
  assert.equal(p.th08Form, 0);
});

test('a short focus blip never flips the form and plays no transition tint', () => {
  const p = new Player('reimuYukari', anms);
  for (let i = 0; i < 4; i++) p.update(inputOf(['focus']), 1);
  assert.equal(p.th08Form, 0);
  assert.equal(p.pendingTh08FormEffect, 0, 'held < 5 frames: no tint request');
  p.update(inputOf([]), 1);
  assert.equal(p.th08Form, 0);
  assert.equal(p.pendingTh08FormEffect, 0, 'release after a blip: still no tint');
});

test('a settled toggle requests tint 29 + aura-in; release requests tint 28 + aura-out', () => {
  const p = new Player('reimuYukari', anms);
  for (let i = 0; i < 10; i++) p.update(inputOf([]), 1);
  p.update(inputOf(['focus']), 1);
  assert.equal(p.pendingTh08FormEffect, 29, 'to-youkai red tint (effect 0x1d)');
  assert.equal(p.pendingTh08Aura, 'in');
  p.pendingTh08FormEffect = 0;
  for (let i = 0; i < 10; i++) p.update(inputOf(['focus']), 1);
  p.update(inputOf([]), 1);
  assert.equal(p.pendingTh08FormEffect, 28, 'to-human blue tint (effect 0x1c)');
  assert.equal(p.pendingTh08Aura, 'out');
});

test('bomb side reads the FORM byte, not the raw focus key', () => {
  const p = new Player('reimuYukari', anms);
  p.bombs = 3;
  // Focused for 3 frames: the key is held but the form is still human, so
  // the bomb runs table[0] (unfocused 夢想妙珠).
  for (let i = 0; i < 3; i++) p.update(inputOf(['focus']), 1);
  assert.equal(p.th08Form, 0);
  assert.ok(p.tryBomb());
  assert.equal(p.th08BombType, 0, 'cast inside the stability window uses the OLD side');
});

// ---------------------------------------------------------------------------
// ECL familiar marking + FIRE bridge + form-rank gate

const i32 = (value) => ({ type: 'i32', value });
const f32 = (value) => ({ type: 'f32', value });
const varId = (value) => ({ type: 'f32', value });

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

function makeHost(form) {
  return {
    rng: { range: () => 0, f: () => 0.5, u16: () => 0, u16InRange: () => 0, u32: () => 0, u32InRange: () => 0 },
    difficulty: 3,
    rank: 16,
    frame: 0,
    id: 1,
    stageNumber: 1,
    slowRate: 1,
    player: { x: 192, y: 384 },
    enemies: [],
    enemyBullets: [],
    enemyLasers: [],
    items: [],
    power: 0,
    score: 0,
    timeStopped: false,
    th08PlayerForm: () => form,
    th08SetSideMirror() {},
    addScore() {},
    spawnItem() {},
    spawnEffectParticles() {},
    spawnEnemyDeathEffect() {},
    playSfx(id) { this.sfxLog.push(id); },
    cancelBulletsToItems() {},
    cancelLasers() {},
    sweepBulletsToItems: () => 0,
    setBossPresent() {},
    unpauseStd() {},
    sfxLog: []
  };
}

const etamaAnm = new Anm(TH08_DATA.anm.etama, 'etama');
const enemyAnm = new Anm(TH08_DATA.anm.stg1enm, 'stg1enm');

function makeRuntime(subs) {
  const stage = { ...TH08_DATA.stages[1], ecl: makeEcl8(subs) };
  return new StageRuntime(stage, { etama: etamaAnm, enemy: enemyAnm, effect: etamaAnm });
}

function runTicks(runtime, game, _enemy, frames) {
  for (let i = 0; i < frames; i++) {
    game.frame = i;
    for (const e of [...game.enemies]) {
      if (e.dead) continue;
      runtime.tickEnemyCore(game, e);
      runtime.integrateEnemyPosition(e, 1);
    }
  }
}

test('op 92 marks the child a familiar: bit 8, side, list, contact off, sfx 36', () => {
  // Sub0 spawns Sub1 (the familiar); Sub1 writes a marker var so we can
  // see it ran.
  const runtime = makeRuntime([
    [instruction(0, 92, [i32(1), f32(0), f32(0), i32(100), i32(-1), i32(100)])],
    [instruction(0, 7, [varId(10016.0), f32(55.0)])]
  ]);
  const game = makeHost(0); // player human
  const parent = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  runTicks(runtime, game, parent, 3);
  const child = game.enemies.find((e) => e !== parent);
  assert.ok(child, 'child spawned');
  const t8 = child.ecl.th08;
  assert.ok(t8?.familiar, 'flags bit 8');
  assert.equal(t8.sideBit, 0, 'side = player form at spawn');
  assert.equal(t8.managerList, 2, 'player-human list');
  assert.equal((t8.flags & 0x100) !== 0, true, 'raw bit 8 mirrored');
  assert.equal((t8.flags & 0x200) !== 0, true, 'op-92 pos-inherit bit 9');
  assert.equal((t8.flags & 4) === 0, true, 'contact bit cleared at spawn');
  assert.equal(child.ecl.collisionEnabled, false, 'semantic contact bridged off');
  assert.ok(game.sfxLog.includes(36), 'se_option spawn chirp (sfx id 36)');
  assert.equal(child.ecl.vars[8], 55, 'the familiar sub itself ran (var 10016 = frame float vars[8])');
});

test('FIRE(16) re-arms shot collision and body contact through the semantic flags', () => {
  const runtime = makeRuntime([
    [instruction(0, 92, [i32(1), f32(0), f32(0), i32(100), i32(-1), i32(100)])],
    [
      instruction(0, 79, [i32(16)]),
      // op 104 (shotCollision off) is TH07 numbering; use var writes to
      // observe that the sub ran past FIRE.
      instruction(1, 7, [varId(10017.0), f32(66.0)])
    ]
  ]);
  const game = makeHost(0);
  const parent = runtime.spawnEclEnemy(game, { subId: 0, x: 100, y: 100 });
  runTicks(runtime, game, parent, 4);
  const child = game.enemies.find((e) => e !== parent);
  const t8 = child.ecl.th08;
  assert.equal((t8.flags & 0x40) !== 0, true, 'bit 6 shootable set by FIRE');
  assert.equal((t8.flags & 4) !== 0, true, 'bit 2 contact re-armed');
  assert.equal(child.ecl.shotCollision, true, 'semantic shot collision on');
  assert.equal(child.ecl.collisionEnabled, true, 'semantic body contact on');
  assert.equal(child.ecl.vars[9], 66);
});

test('form-rank gate: a 0xd8 row runs for youkai familiars, skips human familiars', () => {
  // Mask 0xd8 = L-only (0x08) + high bits {0x10, 0x40, 0x80} — no 0x20.
  // On Lunatic a NORMAL enemy passes; a HUMAN-side familiar fails (needs
  // 0x20); a YOUKAI-side familiar passes (0x40 present).
  const body = (rank) => [
    instruction(0, 92, [i32(1), f32(0), f32(0), i32(100), i32(-1), i32(100)], 0, rank),
    instruction(0, 7, [varId(10016.0), f32(77.0)], 0, rank),
    instruction(1, 1, []) // end
  ];
  const run = (form) => {
    const runtime = makeRuntime([body(0xff), [instruction(0, 7, [varId(10016.0), f32(77.0)], 0, 0xd8)]]);
    // sub0 spawns sub1 (the familiar, mask 0xff); sub1's var write is 0xd8.
    const game = makeHost(form);
    const parent = runtime.spawnEclEnemy(game, { subId: 0, x: 0, y: 0 });
    runTicks(runtime, game, parent, 3);
    const child = game.enemies.find((e) => e !== parent);
    return child.ecl.vars[8];
  };
  // The child (a familiar) skips the 0xd8 row while human-side…
  assert.equal(run(0), 0, 'human familiar: 0xd8 row skipped (no 0x20 bit)');
  // …and runs it while youkai-side.
  assert.equal(run(1), 77, 'youkai familiar: 0xd8 row runs (0x40 bit present)');
});

// ---------------------------------------------------------------------------
// The 46-channel sfx id table

test('TH08 sfx ids resolve to the exe bank table (0x4c8040 over 0x4c81b0)', () => {
  assert.equal(TH08_SFX_SLOTS.length, 46, '46 channel ids');
  assert.deepEqual(TH08_SFX_SLOTS[2][0], 'se_enep00', 'kill slot A');
  assert.deepEqual(TH08_SFX_SLOTS[3][0], 'se_enep00', 'kill slot B (volume variant)');
  assert.deepEqual(TH08_SFX_SLOTS[4][0], 'se_pldead00', 'player miss');
  assert.deepEqual(TH08_SFX_SLOTS[13][0], 'se_gun00', 'bomb cast');
  assert.deepEqual(TH08_SFX_SLOTS[20][0], 'se_damage00', 'enemy damage');
  assert.deepEqual(TH08_SFX_SLOTS[30][0], 'se_graze', 'graze');
  assert.deepEqual(TH08_SFX_SLOTS[36][0], 'se_option', 'familiar spawn');
  assert.deepEqual(TH08_SFX_SLOTS[39][0], 'se_opshow', 'familiar materialize');
  assert.deepEqual(TH08_SFX_SLOTS[40][0], 'se_ophide', 'familiar etherealize');
});
