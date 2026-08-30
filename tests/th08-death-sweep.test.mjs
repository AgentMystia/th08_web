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

test('spell capture checksum follows the scored sweep, not spell teardown', () => {
  const scene = makeScene();
  scene.startBossSpell(99, 12345, 100, 'order-test');
  scene.armTh08DeathClearZone(192, 224, 32, 0, 2, 7);
  injectBullet(scene, 0, 192, 224);

  const events = [];
  let draws = 0;
  const originalDraw = scene.rng.u16.bind(scene.rng);
  scene.rng.u16 = () => {
    draws++;
    return originalDraw();
  };
  const originalChecksum = scene.payTh08ProtectedChecksum.bind(scene);
  scene.payTh08ProtectedChecksum = () => {
    events.push('checksum');
    originalChecksum();
  };
  const originalSpawn = scene.spawnItem.bind(scene);
  scene.spawnItem = (type, x, y, options) => {
    events.push(`item:${type}`);
    return originalSpawn(type, x, y, options);
  };

  scene.endBossSpell();
  assert.equal(draws, 0, 'teardown itself is draw-free');
  assert.equal(scene.runState.spellcardsCaptured, 0, 'capture tail is pending');

  scene.sweepBulletsToItems();
  assert.equal(draws, 4, 'the zone type-7 conversion pays its toss pair first');
  assert.deepEqual(events, ['item:time']);

  scene.settleTh08CapturedSpell();
  assert.equal(draws, 8, 'FUN_00406e50 pays its four-u16 checksum after the sweep');
  assert.deepEqual(events, ['item:time', 'checksum']);
  assert.equal(scene.runState.spellcardsCaptured, 1);
});

// player+0xe2a90 (DAT_018b8988) law (all.c:23595-23602 + the FUN_0044a230 /
// FUN_0044a470 entry stores): the spawn-state quad latch (+0xdbe) is a plain
// boolean and the transition-VM-end payment reads the LIVE global, which
// every normal bullet's hit/graze probe resets to 6. A bullet latched under
// a quad that expired before its VM ends therefore converts to a pointStar
// (zero toss draws), not the zone's time orb — Stage-2 gx f4909 pays exactly
// the eight volley bullets whose ending-tick probe still touches the f4897
// master quad (native 150 draws), not all 88 latched (old port: 470).
test('deferred spawn-state quad payment reads the live conversion global', () => {
  const scene = makeScene();
  scene.mode = 'test';
  scene.playerObj.invulnFrames = 9999;
  const idle = () => ({ held: new Set(), pressed: new Set() });
  const shooter = scene.runtime.spawnEclEnemy(scene, { subId: 0, x: 192, y: 64, life: 1000 });
  shooter.ecl.shootOffset = { x: 0, y: 0 };
  scene.runtime.spawnBullets(scene, shooter, {
    sprite: 2, offset: 2, count1: 1, count2: 1,
    speed1: 0, speed2: 0, angle1: Math.PI / 2, angle2: 0,
    flags: 0x2, sfx: 0, aimMode: 3, exSlots: []
  });
  const latched = scene.enemyBullets.at(-1);
  assert.ok(latched, 'fired the spawn-state bullet');
  assert.ok((latched.spawnDuration ?? 0) > 0, 'flags bit1 opens spawn state 2');
  // A type-7 quad over the spawn point that expires long before the VM ends.
  scene.armTh08DeathClearZone(192, 64, 32, 0, 2, 7);
  // A normal-state bullet far away: its per-tick probes keep resetting the
  // conversion global to 6 after the zone expires.
  const far = scene.runtime.spawnEclEnemy(scene, { subId: 0, x: 192, y: 300, life: 1000 });
  far.ecl.shootOffset = { x: 0, y: 0 };
  scene.runtime.spawnBullets(scene, far, {
    sprite: 2, offset: 2, count1: 1, count2: 1,
    speed1: 0, speed2: 0, angle1: 0, angle2: 0,
    flags: 0, sfx: 0, aimMode: 3, exSlots: []
  });
  const normal = scene.enemyBullets.at(-1);
  assert.equal(normal.spawnDuration ?? 0, 0, 'flags without bits 2/4/8 start in state 1');

  for (let i = 0; i < 12; i++) scene.update(idle());

  assert.deepEqual(
    scene.items.map((item) => item.type),
    ['pointStar'],
    'expired quad + reset global pays pointStar, not the latched time orb'
  );
});

test('a quad still overlapped on the ending tick pays its own param6 twice', () => {
  // Same law, opposite branch: the ending-tick probe still contacts the live
  // quad, so the deferred payment reads the quad's freshly-published param6,
  // and the promoted bullet's normal-path probe contacts it again for the
  // second payment (the f736 double-settlement structure).
  const scene = makeScene();
  scene.mode = 'test';
  scene.playerObj.invulnFrames = 9999;
  const idle = () => ({ held: new Set(), pressed: new Set() });
  const shooter = scene.runtime.spawnEclEnemy(scene, { subId: 0, x: 192, y: 64, life: 1000 });
  shooter.ecl.shootOffset = { x: 0, y: 0 };
  scene.runtime.spawnBullets(scene, shooter, {
    sprite: 2, offset: 2, count1: 1, count2: 1,
    speed1: 0, speed2: 0, angle1: Math.PI / 2, angle2: 0,
    flags: 0x2, sfx: 0, aimMode: 3, exSlots: []
  });
  const latched = scene.enemyBullets.at(-1);
  assert.ok((latched?.spawnDuration ?? 0) > 0, 'flags bit1 opens spawn state 2');
  scene.armTh08DeathClearZone(192, 64, 32, 0, 30, 7);

  for (let i = 0; i < 12; i++) scene.update(idle());

  assert.deepEqual(
    scene.items.map((item) => item.type),
    ['time', 'time'],
    'live quad pays its time orb at the VM end and again on the normal-path contact'
  );
});
