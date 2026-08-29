import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 death white-out placement — Th08.exe v1.00d evidence:
//  - FUN_0044d2c0 draws FUN_0044de60(player, 768, 896, 0xffffffff, 0) EVERY
//    frame while player+0xe2a70 counts down;
//  - FUN_0044d180 arms +0xe2a70 = 0x3c on the miss commit and re-arms it
//    every death-squish frame (state 1), so the white quad spans the squish
//    plus 60 frames past it;
//  - the deathbomb WINDOW itself (state 2, FUN_0044cbf0) draws no white
//    quad — the old port's hitState overlay was placed in the wrong state.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

function makeScene() {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team, 1, null,
    rpy.stages[0].rngSeed
  );
  scene.mode = 'test';
  scene.playerObj.lives = 6;
  scene.playerObj.bombs = 3;
  for (let f = 0; f < 100; f++) scene.update({ held: new Set(), pressed: new Set() });
  const p = scene.playerObj;
  p.invulnFrames = 0;
  p.bombInvuln = 0;
  p.materializeFrame = -1;
  return scene;
}
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

test('no white quad during the deathbomb window', () => {
  const scene = makeScene();
  assert.equal(scene.playerObj.hit(), 'deathbomb-window');
  for (let f = 0; f < 10; f++) scene.update(idle());
  assert.equal(scene.playerObj.hitState, true, 'still inside the window');
  assert.equal(scene.th08DeathWhiteFrames, 0, 'window draws no white quad');
});

test('the miss commit arms 60, the squish holds it, then it counts down', () => {
  const scene = makeScene();
  const p = scene.playerObj;
  p.hit();
  // Stock 3 gives Border Team a 27-frame preDeadCount; let it lapse.
  for (let f = 0; f < 29; f++) scene.update(idle());
  assert.equal(p.hitState, false, 'window lapsed');
  assert.equal(scene.th08DeathWhiteFrames, 60, 'commit arms 60');
  // Through the 30-frame squish it stays pinned at 60.
  for (let f = 0; f < 40; f++) scene.update(idle());
  assert.equal(p.dyingFrame, -1, 'squish finished (respawned)');
  assert.ok(
    scene.th08DeathWhiteFrames > 60 - 15 && scene.th08DeathWhiteFrames <= 60,
    `counting down after the squish, got ${scene.th08DeathWhiteFrames}`
  );
});

test('a deathbomb rescue never arms the white-out', () => {
  const scene = makeScene();
  const p = scene.playerObj;
  p.hit();
  for (let f = 0; f < 5; f++) scene.update(idle());
  scene.update({ held: new Set(['bomb']), pressed: new Set() });
  assert.equal(p.th08BombType, 3, 'unfocused deathbomb ran table[3]');
  for (let f = 0; f < 30; f++) scene.update(idle());
  assert.equal(scene.th08DeathWhiteFrames, 0, 'rescued: no white-out');
  assert.equal(p.lives, 6, 'no life lost');
});

test('Stage-2 native contact enters the 27-frame window and starts type-3 on the next tick', () => {
  const stageIndex = rpy.stages.findIndex((entry) => entry.stage === 2);
  const stage = rpy.stages[stageIndex];
  const entryScore = rpy.stages[stageIndex - 1].scoreAtEnd;
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team, 2,
    null, stage.rngSeed
  );
  scene.mode = 'test';
  scene.rank = stage.rank;
  scene.score = entryScore;
  scene.graze = stage.graze;
  scene.playerObj.lives = stage.lives;
  scene.playerObj.bombs = stage.bombs;
  scene.playerObj.power = stage.power;
  Object.assign(scene.runState, {
    score: entryScore,
    youkaiGauge: stage.youkaiGauge,
    clockTime: stage.clockTime,
    pointItemValue: stage.pointItemValue,
    pointItemExtends: stage.pointItemExtends,
    nextPointItemExtendThreshold: stage.nextPointItemExtendThreshold
  });

  for (let f = 0; f <= 946; f++) {
    scene.update(replayInput(stage.inputs[f]));
    if (f === 675) assert.equal(scene.hitLog.length, 0, 'no early contact');
    if (f === 676) {
      const hit = scene.hitLog[0];
      assert.equal(hit?.kind, 'bullet');
      assert.equal(hit?.bullet?.spawnFrame, 655);
      assert.equal(hit?.bullet?.sprite, 1);
      assert.equal(hit?.bullet?.spriteOffset, 2);
      assert.ok(Math.abs(hit.bullet.x - 168.773193359375) < 1e-6);
      assert.ok(Math.abs(hit.bullet.y - 129.134521484375) < 1e-6);
      assert.equal(scene.playerObj.hitState, true);
      assert.equal(scene.playerObj.deathbombMeter, 27);
      assert.equal(scene.playerObj.power, 128);
      assert.equal(scene.runState.currentTimeOrbs, 38, 'contact tick precedes the window debit');
      assert.equal(scene.runState.youkaiGauge, 0, 'Player::Die clears only the live gauge');
    }
    if (f === 677) {
      assert.equal(scene.runState.currentTimeOrbs, 23, 'first window tick debits 15 time orbs');
      assert.equal(scene.runState.youkaiGauge, 0, 'state 2 skips the normal gauge drift');
      assert.equal(scene.rng.seed, 52865, 'successful debit regenerates the two-field checksum');
    }
    if (f === 678) {
      assert.equal(scene.runState.currentTimeOrbs, 8, 'second window tick debits 15 time orbs');
      assert.equal(scene.rng.seed, 64385, 'second successful debit consumes another four u16 draws');
    }
    if (f === 679) {
      assert.equal(scene.runState.currentTimeOrbs, 0, 'underflowing debit clamps only the current counter');
      assert.equal(scene.rng.seed, 64385, 'underflow clamp consumes no integrity RNG');
    }
    if (f === 696) {
      const attacks = [...scene.bombEngine.activeSlots()];
      assert.equal(scene.playerObj.hitState, false, 'trigger callback completes the native rescue');
      assert.equal(scene.playerObj.pendingDeathbombRescue, false);
      assert.equal(scene.playerObj.th08BombType, 3);
      assert.equal(scene.playerObj.bombs, 1);
      assert.equal(scene.playerObj.power, 128, 'deathbomb never committed a miss');
      assert.equal(scene.playerObj.bombTimer, 250);
      assert.equal(attacks.length, 1);
      assert.deepEqual(
        [attacks[0].poolSlot, attacks[0].x, attacks[0].y,
          attacks[0].radiusX, attacks[0].damage, attacks[0].shape],
        [0, 172, 126, 100, 70, 'circle']
      );
      assert.equal(scene.items.length, 14, 'trigger-tail item re-arm does not move or collect this pass');
      assert.equal(scene.th08ItemPool.nextIndex, 86, 'native declaration advances the fixed item probe once');
      assert.equal(scene.enemyBulletSlots[15]?.clearFadeFrames, 12, 'the near bullet is silently retired by raw r100');
      assert.equal(scene.items.some((item) => item.type === 'pointStar'), false);
    }
    if (f === 697) {
      const attacks = [...scene.bombEngine.activeSlots()];
      assert.equal(scene.playerObj.hitState, false);
      assert.equal(scene.playerObj.pendingDeathbombRescue, false);
      assert.equal(scene.playerObj.bombTimer, 249);
      assert.equal(attacks.length, 1);
      assert.deepEqual(
        [attacks[0].poolSlot, attacks[0].x, attacks[0].y,
          attacks[0].radiusX, attacks[0].damage, attacks[0].shape],
        [0, 172, 126, 101, 70, 'circle']
      );
      const star = scene.items.find((item) => item.type === 'pointStar');
      assert.ok(star);
      assert.deepEqual(
        [star.poolSlot, star.state, star.x, star.y, scene.th08ItemPool.nextIndex],
        [86, 1, 268.5787048339844, 142.79617309570312, 87]
      );
    }
    if (f === 701) {
      assert.equal(
        scene.particles.filter((particle) => particle.effectId === 62).length,
        0,
        'option afterimages have not crossed the native >699/modulo gate'
      );
    }
    if (f === 702) {
      assert.equal(
        scene.particles.filter((particle) => particle.effectId === 62).length,
        12,
        'the trigger boundary still advances the player clock: native f703 arms the first batch'
      );
    }
    if (f === 726) {
      // Native replay f727 (the playback feed is one frame behind the sim):
      // the nearest fairy is x=280.806 while Reimu is x=172, so the
      // abs(enemy.x-player.x)<64 lunge cache is empty. Yukari stays parked
      // at (172,32), and FUN_00450240 retains the three authored headings.
      const shots = scene.playerBullets
        .filter((shot) => shot.poolSlot >= 8 && shot.poolSlot <= 10)
        .sort((a, b) => a.poolSlot - b.poolSlot);
      assert.deepEqual(shots.map((shot) => [shot.poolSlot, shot.x, shot.y]), [
        [8, 172, 32], [9, 172, 32], [10, 172, 32]
      ]);
      assert.ok(Math.abs(shots[0].vx - 0.6975647211074829) < 1e-6);
      assert.ok(Math.abs(shots[0].vy - -9.975640296936035) < 1e-6);
      assert.ok(Math.abs(shots[1].vx) < 1e-6);
      assert.equal(shots[1].vy, -10);
      assert.ok(Math.abs(shots[2].vx - -0.6975647211074829) < 1e-6);
      assert.ok(Math.abs(shots[2].vy - -9.975640296936035) < 1e-6);
      assert.equal(scene.playerObj.th08OptionX, 172);
      assert.equal(scene.playerObj.th08OptionY, 32);
      assert.equal(scene.playerObj.th08OptionLunge, false);
    }
    if (f === 946) {
      // Native counter f947: the 250th type-3 callback tears down before
      // movement and shooter dispatch in this same player pass. Raw focus
      // therefore moves 4px and the new source-1 records originate at the
      // player rather than the retired Ran actor.
      assert.equal(scene.playerObj.bombTimer, 0);
      assert.equal(scene.playerObj.focusHeld, false);
      assert.equal(scene.playerObj.y, 302);
      const slot25 = scene.playerBullets.find((shot) => shot.poolSlot === 25);
      assert.ok(slot25);
      assert.deepEqual([slot25.x, slot25.y, slot25.age], [172, 302, 0]);
    }
  }
});

test('miss drops are pool state-2 spawns: scattered tween targets, not straight falls', async () => {
  const { loadEngine, makeStubAssetsTh08, makeStubAudio } = await import('../scripts/lib/replay-harness.mjs');
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team, 1, null,
    rpy.stages[0].rngSeed
  );
  scene.mode = 'test';
  scene.playerObj.lives = 6;
  scene.playerObj.bombs = 3;
  for (let f = 0; f < 100; f++) scene.update(idle());
  const p = scene.playerObj;
  p.invulnFrames = 0;
  p.bombInvuln = 0;
  p.materializeFrame = -1;
  p.power = 50;
  p.x = 192;
  p.y = 240;
  p.hit();
  for (let f = 0; f < 29; f++) scene.update(idle());
  assert.equal(p.hitState, false, 'window lapsed, miss committed');

  // FUN_0043dca0 (all.c:37886-37909): power >= 1 drops 1x powerBig + 5x
  // powerSmall, every one a FUN_004400a0(pos, type, 2) pool spawn. State 2
  // pays its two draws in the found-slot block and arms the 60-frame
  // positional tween; the death point itself only supplies the origin.
  const drops = scene.items.filter((it) => it.type === 'powerBig' || it.type === 'powerSmall');
  assert.equal(drops.length, 6);
  for (const it of drops) {
    assert.equal(it.state, 2, 'death drop spawns in tween state');
    assert.ok(it.tween, 'tween target captured');
    assert.ok(it.tween.tx >= 48 && it.tween.tx < 48 + 304, `targetX in [48,352): ${it.tween.tx}`);
    assert.ok(it.tween.ty >= -64 && it.tween.ty < -64 + 192, `targetY in [-64,128): ${it.tween.ty}`);
    assert.ok(it.tween.sx === 192 && it.tween.sy === 240, 'origin is the death point');
  }
  // Mid-tween items lerp toward their targets instead of falling: after one
  // tick every drop moved strictly toward its target.
  scene.update(idle());
  for (const it of drops) {
    const before = Math.hypot(it.tween.tx - 192, it.tween.ty - 240);
    const after = Math.hypot(it.tween.tx - it.x, it.tween.ty - it.y);
    assert.ok(after < before, `drop moved toward its target (${after} < ${before})`);
    assert.notEqual(it.vy, Math.fround(-2.2), 'no ordinary fall during the tween');
  }
});
