import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 spell-card playfield background (FUN_004152a0, all.c:9093-9095): the
// effect manager arms two VMs from the stage's eff0N.anm at spell start —
// archive script indices 0 and 1 — both 384x448 corner-anchored at (32,16),
// fading in over 60 frames, then tile-wrapping their 256x256 texture with
// the authored per-frame op26/27 scroll (eff01: eff01b v+0.008333/frame,
// eff01 v-0.002083/frame). Spell end deletes them outright.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

function makeScene(stageNumber) {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    stageNumber, null, rpy.stages[stageNumber - 1].rngSeed
  );
  scene.mode = 'test';
  return scene;
}
const idle = () => ({ held: new Set(), pressed: new Set() });

test('stage 1 spell start arms the two authored eff01 sheets', () => {
  const scene = makeScene(1);
  scene.startBossSpell(1, 100000, 1000, 'test');
  const runners = scene.spellBackgroundRunners;
  assert.equal(runners.length, 2);
  // Archive index 0 = entry 0 (eff01b.png), index 1 = entry 1 (eff01.png).
  assert.match(runners[0].spriteFrame().imageKey, /eff01b/);
  assert.match(runners[1].spriteFrame().imageKey, /eff01\.png|eff01$/);
  // Both corner-anchored at (32,16), 384x448 (full playfield).
  for (const runner of runners) {
    const frame = runner.spriteFrame();
    assert.equal(frame.anchorTopLeft, true);
    assert.deepEqual([frame.vmX, frame.vmY, frame.w, frame.h], [32, 16, 384, 448]);
  }
});

test('the sheets fade in over 60 frames and scroll at the authored rates', () => {
  const scene = makeScene(1);
  scene.startBossSpell(1, 100000, 1000, 'test');
  const [fast, slow] = scene.spellBackgroundRunners;
  for (let f = 0; f < 30; f++) scene.update(idle());
  const mid = fast.spriteFrame().alpha;
  assert.ok(mid > 60 && mid < 200, `fade mid-way at 30f (alpha ${mid})`);
  for (let f = 0; f < 60; f++) scene.update(idle());
  assert.equal(fast.spriteFrame().alpha, 255, 'fade complete by ~60-90f');
  // op27 runs once per script frame inside the authored 1-frame loop; the
  // script clock resets each loop, so measure against the update count.
  assert.ok(Math.abs(fast.scrollV - 90 * 0.008333334) < 0.01,
    `eff01b scrolls v+0.008333/frame (got ${fast.scrollV} after 90 updates)`);
  assert.ok(Math.abs(slow.scrollV - 90 * -0.0020833334) < 0.01,
    `eff01 scrolls v-0.002083/frame (got ${slow.scrollV} after 90 updates)`);
});

test('stage 2 arms eff02, and spell end removes both VMs outright', () => {
  const scene = makeScene(2);
  scene.startBossSpell(21, 100000, 1000, 'test');
  assert.match(scene.spellBackgroundRunners[0].spriteFrame().imageKey, /eff02b/);
  assert.match(scene.spellBackgroundRunners[1].spriteFrame().imageKey, /eff02\.png|eff02$/);
  for (let f = 0; f < 70; f++) scene.update(idle());
  scene.endBossSpell();
  assert.equal(scene.spellBackgroundRunners.length, 0);
});
