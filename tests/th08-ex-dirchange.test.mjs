import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// Machine-code-pinned TH08 et_ex dir-change mapping (an earlier pass had
// 0x40 inverted to SET):
//   bit 0x40 → FUN_00432460: `flds 0xd74; fadds 0x1014; fstps 0xd74`
//              = RELATIVE `angle += f0` (0x4322ef-0x4322fe).
//   bit 0x100 → FUN_004325a0: stores f0 straight into 0xd74 = ABSOLUTE.
// Both families also drive the speed sawtooth f1·(1−t/interval) between
// fires and clear their own flag bit at the maxTimes fire.
const mod = await loadEngine();
const idle = () => ({ held: new Set(), pressed: new Set() });
const replayInput = (word) => ({
  held: new Set([
    word & 0x1 ? 'shoot' : null, word & 0x2 ? 'bomb' : null,
    word & 0x4 ? 'focus' : null, word & 0x10 ? 'up' : null,
    word & 0x20 ? 'down' : null, word & 0x40 ? 'left' : null,
    word & 0x80 ? 'right' : null, word & 0x100 ? 'skip' : null
  ].filter(Boolean)),
  pressed: new Set()
});

function makeScene() {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), 3, 'reimuYukari', 1, null, 1
  );
  scene.mode = 'test';
  scene.playerObj.invulnFrames = 9999;
  return scene;
}

function fireBullet(scene, { flags, heading = 1.0 }) {
  const shooter = scene.runtime.spawnEclEnemy(scene, { subId: 0, x: 192, y: 64, life: 1000 });
  shooter.ecl.shootOffset = { x: 0, y: 0 };
  scene.runtime.spawnBullets(scene, shooter, {
    sprite: 2, offset: 2, count1: 1, count2: 1,
    speed1: 2, speed2: 2, angle1: heading, angle2: 0,
    flags, sfx: 0, aimMode: 3,
    exSlots: [{
      opcode: flags & 0x140, cond: 1, arg3: 10, arg4: 1,
      f0: Math.PI / 2, f1: 2.1
    }]
  });
  return scene.enemyBullets.at(-1);
}

test('et_ex 0x40 ADDs f0 to heading (relative) and clears its own flag', async () => {
  const scene = makeScene();
  const spawnHeading = 1.0;
  const bullet = fireBullet(scene, { flags: 0x40, heading: spawnHeading });
  assert.ok(bullet, 'spawned a test bullet');
  const id = bullet.id;
  for (let i = 0; i < 16; i++) scene.update(idle());
  const live = scene.enemyBullets.find((b) => b.id === id);
  assert.ok(live, 'test bullet still live');
  const expected = spawnHeading + Math.PI / 2;
  assert.ok(
    Math.abs(live.angle - expected) < 0.02,
    `0x40 must ADD π/2 (→ ${expected}), got ${live.angle}`
  );
  assert.equal(live.dirTimes, 1);
  assert.equal(live.exFlags & 0x40, 0, '0x40 must clear its own bit after maxTimes');
  assert.ok(Math.abs(live.speed - 2.1) < 0.01, `new speed ${live.speed}`);
});

test('et_ex 0x100 SETs heading to f0 (absolute)', async () => {
  const scene = makeScene();
  const spawnHeading = 1.0;
  const bullet = fireBullet(scene, { flags: 0x100, heading: spawnHeading });
  const id = bullet.id;
  for (let i = 0; i < 16; i++) scene.update(idle());
  const live = scene.enemyBullets.find((b) => b.id === id);
  assert.ok(live, 'test bullet still live');
  assert.ok(
    Math.abs(live.angle - Math.PI / 2) < 0.02,
    `0x100 must SET heading to π/2, got ${live.angle}`
  );
  assert.equal(live.exFlags & 0x100, 0, '0x100 clears its own bit after maxTimes');
});

test('et_ex 0x20000 wait returns without fade-killing at construction', async () => {
  // FUN_0042ffc0 (all.c:23057-23064): opcode 0x20000 ORs into +0xdac and
  // returns; 0x40000 writes state 5. A `continue` after wait walked into
  // fade-kill on the construction pass and leaked dead fixed-pool slots.
  const scene = makeScene();
  const shooter = scene.runtime.spawnEclEnemy(scene, { subId: 0, x: 192, y: 64, life: 1000 });
  shooter.ecl.shootOffset = { x: 0, y: 0 };
  scene.runtime.spawnBullets(scene, shooter, {
    sprite: 3, offset: 7, count1: 1, count2: 1,
    speed1: 0, speed2: 0.5, angle1: Math.PI / 2, angle2: 0,
    flags: 0x60000, sfx: 0, aimMode: 3,
    exSlots: [
      { opcode: 0x20000, cond: 1, arg3: 5, arg4: 0, f0: 0, f1: 0 },
      { opcode: 0x40000, cond: 0, arg3: 0, arg4: 0, f0: 0, f1: 0 }
    ]
  });
  const bullet = scene.enemyBullets.at(-1);
  assert.ok(bullet, 'spawned a wait+fade-kill bullet');
  const id = bullet.id;
  assert.ok(!bullet.dead, 'construction must not mark the bullet dead');
  assert.equal(bullet.clearFadeFrames, undefined, 'construction must not enter state 5');
  assert.equal(bullet.exFlags & 0x20000, 0x20000);
  assert.equal(bullet.exWaitFrames, 5);
  for (let i = 0; i < 6; i++) scene.update(idle());
  let live = scene.enemyBullets.find((b) => b.id === id);
  assert.ok(live, 'bullet survives the wait');
  // arg=5: passes 1-5 decrement 5->0 with the bit still armed; pass 6's walk
  // stalls on it and only the handler clears it — FUN_0040e390 checks
  // remaining <= 0 BEFORE FUN_00418110 decrements, so the clear pass burns
  // no decrement and the walk passes the slot on pass 7, not pass 6.
  assert.equal(live.exFlags & 0x20000, 0, 'handler cleared the bit during pass 6');
  assert.equal(live.clearFadeFrames, undefined, 'the clear pass itself runs no walk past the slot');
  scene.update(idle());
  live = scene.enemyBullets.find((b) => b.id === id);
  assert.ok(live, 'state 5 still occupies the fixed slot');
  assert.ok(live.clearFadeFrames != null, 'fade-kill writes state 5');
  assert.ok(!live.dead, 'state 5 is not a construction-time dead leak');
});

test('state-2 spawn ending tick falls through into the et_ex dispatch', async () => {
  const spawned = makeScene();
  const bullet = fireBullet(spawned, { flags: 0x42, heading: 0 });
  assert.equal(bullet.spawnDuration, 10, 'sprite-2 flash is 10 ticks');
  assert.equal(bullet.exFlags & 0x40, 0x40, 'FIRE flags 0x40 must arm et_ex 0x40');
  const find = () => spawned.enemyBullets.find((b) => b.id === bullet.id);
  let firstNormal = -1;
  for (let i = 0; i < 16; i++) {
    spawned.update(idle());
    const cur = find();
    if (cur && firstNormal < 0 && (cur.spawnAge ?? cur.spawnDuration) >= cur.spawnDuration) {
      firstNormal = i + 1;
    }
  }
  assert.ok(firstNormal > 0, 'bullet reached normal state');
  const cur = find();
  assert.ok(
    cur.exDirElapsed >= 1,
    `the 0x431106 fallthrough must tick the 0x40 clock on the ending tick itself ` +
    `(elapsed ${cur.exDirElapsed} after ${firstNormal} updates)`
  );
  assert.ok(cur.dirTimes >= 0);

  const immediate = makeScene();
  const straight = fireBullet(immediate, { flags: 0x40, heading: 0 });
  assert.equal(straight.spawnDuration, 0);
  for (let i = 0; i < 10; i++) immediate.update(idle());
  const live = immediate.enemyBullets.find((b) => b.id === straight.id);
  assert.equal(live.exDirElapsed, 10);
});

test('Wriggle Sub16 rain layer rotates by +f0 per fire (relative 0x40)', async () => {
  const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));
  const stage = rpy.stages.find((entry) => entry.stage === 1);
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    1, null, stage.rngSeed
  );
  scene.mode = 'test';
  scene.playerObj.invulnFrames = 9999;
  const heading0 = new Map();
  const f0Of = new Map();
  for (let f = 0; f <= 3054; f++) {
    scene.update(replayInput(stage.inputs[f]));
    for (const b of scene.enemyBullets) {
      if (b.spawnFrame === 2995 && !heading0.has(b.id) && b.dirTimes === 0) {
        heading0.set(b.id, b.angle);
        f0Of.set(b.id, b.exDir?.angle ?? 0);
      }
    }
  }
  const rain = scene.enemyBullets.filter((b) =>
    !b.dead && b.spawnFrame === 2995 && b.sprite === 2 && b.dirTimes >= 1
  );
  assert.ok(rain.length >= 15, `expected turned Sub16 layer, got ${rain.length}`);
  for (const b of rain) {
    const h0 = heading0.get(b.id);
    const f0 = f0Of.get(b.id);
    assert.ok(h0 !== undefined && f0 !== undefined, `captured spawn heading for ${b.id}`);
    const expected = h0 + b.dirTimes * f0;
    assert.ok(
      Math.abs(b.angle - expected) < 0.05,
      `spawn ${b.spawnFrame} id ${b.id} heading ${b.angle} should stay relative: ` +
      `${h0} + ${b.dirTimes}×${f0} = ${expected}`
    );
  }
});
