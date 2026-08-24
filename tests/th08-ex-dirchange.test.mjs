import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 et_ex 0x40 is SET heading (TH07 0x40 was ADD). Wriggle midboss Sub16
// arms a 20-way FIRE0 fan then et_ex 0x40 with f0=π/2 so every spoke falls
// as rain; the inherited relative mapping rotated the fan into the fixture
// player at f3192.
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

test('et_ex 0x40 SETs heading to f0 and clears its own flag', async () => {
  const scene = makeScene();
  const shooter = scene.runtime.spawnEclEnemy(scene, { subId: 0, x: 192, y: 64, life: 1000 });
  shooter.ecl.shootOffset = { x: 0, y: 0 };
  const spawnHeading = 1.0;
  scene.runtime.spawnBullets(scene, shooter, {
    sprite: 2, offset: 2, count1: 1, count2: 1,
    speed1: 2, speed2: 2, angle1: spawnHeading, angle2: 0,
    flags: 0x40, sfx: 0, aimMode: 3,
    exSlots: [{
      opcode: 0x40, cond: 1, arg3: 10, arg4: 1,
      f0: Math.PI / 2, f1: 2.1
    }]
  });
  const bullet = scene.enemyBullets.at(-1);
  assert.ok(bullet, 'spawned a test bullet');
  const id = bullet.id;
  for (let i = 0; i < 16; i++) scene.update(idle());
  const live = scene.enemyBullets.find((b) => b.id === id);
  assert.ok(live, 'test bullet still live');
  assert.ok(
    Math.abs(live.angle - Math.PI / 2) < 0.02,
    `0x40 must SET heading to π/2, got ${live.angle} (relative would be ${spawnHeading + Math.PI / 2})`
  );
  assert.equal(live.dirTimes, 1);
  assert.equal(live.exFlags & 0x40, 0, '0x40 must clear its own bit after maxTimes');
  assert.ok(Math.abs(live.speed - 2.1) < 0.01, `new speed ${live.speed}`);
});

test('state-2 spawn ending tick does not increment et_ex 0x40 wait', async () => {
  const fire = (flags) => {
    const scene = makeScene();
    const shooter = scene.runtime.spawnEclEnemy(scene, { subId: 0, x: 192, y: 64, life: 1000 });
    shooter.ecl.shootOffset = { x: 0, y: 0 };
    scene.runtime.spawnBullets(scene, shooter, {
      sprite: 2, offset: 2, count1: 1, count2: 1,
      speed1: 2, speed2: 2, angle1: 0, angle2: 0,
      flags, sfx: 0, aimMode: 3,
      exSlots: [{
        opcode: 0x40, cond: 1, arg3: 10, arg4: 1,
        f0: Math.PI / 2, f1: 2.1
      }]
    });
    return { scene, bullet: scene.enemyBullets.at(-1) };
  };

  const spawned = fire(0x42);
  assert.equal(spawned.bullet.spawnDuration, 10, 'sprite-2 flash is 10 ticks');
  assert.equal(spawned.bullet.exFlags & 0x40, 0x40, 'FIRE flags 0x40 must arm et_ex 0x40');
  for (let i = 0; i < 10; i++) spawned.scene.update(idle());
  assert.equal(spawned.bullet.exDirElapsed, 0, 'ending fallthrough must not tick 0x40');
  assert.equal(spawned.bullet.dirTimes, 0);
  spawned.scene.update(idle());
  assert.equal(spawned.bullet.exDirElapsed, 1, 'first exclusive tick is the first wait increment');
  assert.equal(spawned.bullet.dirTimes, 0);

  const immediate = fire(0x40);
  assert.equal(immediate.bullet.spawnDuration, 0);
  for (let i = 0; i < 10; i++) immediate.scene.update(idle());
  assert.equal(immediate.bullet.exDirElapsed, 10);
});

test('Wriggle Sub16 interval-40 layer falls as vertical rain, not a rotated fan', async () => {
  const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));
  const stage = rpy.stages.find((entry) => entry.stage === 1);
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    1, null, stage.rngSeed
  );
  scene.mode = 'test';
  scene.playerObj.invulnFrames = 9999;
  for (let f = 0; f <= 3054; f++) scene.update(replayInput(stage.inputs[f]));
  const rain = scene.enemyBullets.filter((b) =>
    !b.dead && b.spawnFrame === 2995 && b.sprite === 2 && b.dirTimes >= 1
  );
  assert.ok(rain.length >= 15, `expected turned Sub16 layer, got ${rain.length}`);
  for (const b of rain) {
    assert.ok(
      Math.abs(b.angle - Math.PI / 2) < 0.05,
      `spawn ${b.spawnFrame} id ${b.id} heading ${b.angle} should be π/2 rain, not spawn+π/2`
    );
  }
  assert.equal(scene.hitLog.length, 0, 'vertical rain must not contact the fixture player by f3054');
});

test('Wriggle Sub16 rain does not contact the fixture player at f3206', async () => {
  const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));
  const stage = rpy.stages.find((entry) => entry.stage === 1);
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    1, null, stage.rngSeed
  );
  scene.mode = 'test';
  scene.rank = stage.rank;
  scene.graze = stage.graze;
  scene.playerObj.lives = stage.lives;
  scene.playerObj.bombs = stage.bombs;
  scene.playerObj.power = stage.power;
  for (let f = 0; f <= 3206; f++) scene.update(replayInput(stage.inputs[f]));
  assert.equal(
    scene.hitLog.length, 0,
    `spawn-end must not tick et_ex: ${JSON.stringify(scene.hitLog)}`
  );
});
