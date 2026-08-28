import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 op-75 rect clamp — Th08.exe v1.00d evidence:
//  - FUN_0042c180 (all.c:21039-21071): while enemy flags (+0x3324) bit 19 is
//    armed (ins_75 writes the rect at +0x3340..+0x334c and sets the bit;
//    ins_76 clears only the bit), the enemy's OWN logical position
//    (+0x2d34/+0x2d38) clamps into [x1,x2]×[y1,y2]. FUN_0040b460 is an
//    identity accessor — the old port misread it as a PLAYER clamp and left
//    the whole mechanism a no-op.
//  - The clamp runs EVERY manager pass, sandwiching the movement integrator
//    FUN_0042deb0 (all.c:21347-21349), and again after every ins_63 setPos
//    (dispatcher case 0x3e). An interpolated move may compute a mid-curve
//    point outside the rect, but the enemy can never integrate, render or
//    collide outside it.
//  - Census pin (udGx01 st1, native counter f == port state after input f−1):
//    the stage-1 midboss (Sub15) arms rect (32,48,352,128) at its t60; the
//    Sub22 phase's t0 ins_64(90, 4, 192, 144) therefore rides the y ceiling —
//    native y pins at EXACTLY 128.000 from f3352 (port f3351) while the x
//    component tweens 102.2→192 unconstrained, parking at (192,128).
//    Pre-fix, the port tweened y to 144.000 (16px off) and every downstream
//    contact razor (the f3586 Sub24 ring, the op67 exit move) shifted.
test('op-75 rect clamp pins the stage-1 midboss at y=128 through the Sub22 move', async () => {
  const mod = await loadEngine();
  const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udGx01.rpy'));
  const stage = rpy.stages[0];
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team, 1, null,
    stage.rngSeed
  );
  scene.mode = 'replay';
  scene.rank = stage.rank;
  scene.score = 0;
  scene.graze = stage.graze;
  scene.playerObj.lives = stage.lives;
  scene.playerObj.bombs = stage.bombs;
  scene.playerObj.power = stage.power;
  if (scene.runState) {
    scene.runState.score = 0;
    scene.runState.pointItemValue = stage.pointItemValue;
    scene.runState.youkaiGauge = stage.youkaiGauge;
    scene.runState.clockTime = stage.clockTime;
    scene.runState.pointItemExtends = stage.pointItemExtends;
    scene.runState.nextPointItemExtendThreshold = stage.nextPointItemExtendThreshold;
  }
  const ri = new mod.ReplayInputSource();
  let mid = null;
  for (let f = 0; f <= 3424; f++) {
    scene.update(ri.frame(stage.inputs[f] ?? 0));
    if (f === 3424) mid = scene.enemies.find((e) => e.poolSlot === 1 && !e.dead) ?? null;
    if (f === 3351) {
      const m = scene.enemies.find((e) => e.poolSlot === 1 && !e.dead);
      // First clamped frame (native f3352 = 128.000 exactly); x stays on the
      // authored tween (native 132.1).
      assert.ok(m, 'midboss alive at f3351');
      assert.equal(Math.fround(m.y), 128, 'y pins at the armed ceiling on the first crossing frame');
      assert.ok(Math.abs(m.x - 132.075) < 0.01, `x tween unconstrained (${m.x})`);
    }
  }
  assert.ok(mid, 'midboss alive at the park');
  assert.equal(Math.fround(mid.x), 192, 'park x = 192 (inside [32,352])');
  assert.equal(Math.fround(mid.y), 128, 'park y = ceiling 128, NOT the authored 144');
});
