import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// FUN_00430aa0's scored field sweep (asm 0x430b14-0x430bb7). This is a
// different law from the state-1 quad collision arm: the sweep allocates one
// raw conversion item per bullet, then puts the bullet into state 5.
const mod = await loadEngine();

function makeScene() {
  return new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), 3, 'reimuYukari', 1, null, 0x28ac
  );
}

function injectBullet(scene, slot, x, y) {
  const bullet = {
    poolSlot: slot,
    id: 10_000 + slot,
    x,
    y,
    z: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    angle: 0,
    age: 32,
    flags: 0x1000,
    sprite: -1,
    dead: false
  };
  assert.equal(scene.addEnemyBullet(bullet), true);
  return bullet;
}

test('scored sweep pays one zone conversion item and enters bullet state 5', () => {
  const scene = makeScene();
  scene.armTh08DeathClearZone(192, 224, 32, 0, 2, 9);
  const inside = injectBullet(scene, 0, 192, 224);
  const outside = injectBullet(scene, 1, 320, 224);

  const total = scene.sweepBulletsToItems();

  assert.equal(total, 4020, 'both bullets advance the 2000/+20 popup ramp');
  assert.deepEqual(
    scene.items.map((item) => [item.type, item.state]),
    [['unknown9', 1], ['pointStar', 1]],
    'zone contact passes raw type 9 once; a miss uses the manager table id 6 once'
  );
  assert.equal(inside.dead, false);
  assert.equal(outside.dead, false);
  assert.equal(inside.clearFadeFrames, 12, 'FUN_00430aa0 writes state 5');
  assert.equal(outside.clearFadeFrames, 12);
  assert.equal(scene.enemyBullets.length, 2, 'state-5 fixed slots remain occupied');
});

test('an active spell suppresses the shared death wipe until spell end', () => {
  const scene = makeScene();
  scene.runtime.spellActive = true;
  const bullet = injectBullet(scene, 0, 192, 224);
  const dyingBoss = {
    dead: false,
    x: 192,
    y: 224,
    z: 0,
    ecl: { th08: { flags: 2, flags2: 0 } }
  };

  scene.th08DeathWipeBonus(dyingBoss);

  assert.equal(scene.items.length, 0);
  assert.equal(bullet.dead, false);
  assert.equal(scene.enemyBullets.length, 1);

  scene.runtime.spellActive = false;
  scene.th08DeathWipeBonus(dyingBoss);
  assert.deepEqual(
    scene.items.map((item) => [item.type, item.state]),
    [['pointStar', 1]],
    'FUN_00430aa0 uses the manager table (id 6) after the spell singleton clears'
  );
});
