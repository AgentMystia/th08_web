import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 stage tally: the night clock advance (FUN_0043c35f) pays +1 when the
// stage's time-orb quota (DAT_004c77f0 per stage+difficulty) is met, +2
// when missed. The carry across stages keeps the run state (clock, gauge,
// item ladder) — T8RP stage-entry snapshots mirror these fields.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

function makeScene(stageNumber = 1) {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    stageNumber, null, rpy.stages[0].rngSeed
  );
  scene.mode = 'test';
  return scene;
}

test('constructing the stage performs only the two native drop-cursor RNG draws', () => {
  const seed = rpy.stages[1].rngSeed;
  const advance = (value) => {
    const a = ((value ^ 0x9630) - 0x6553) & 0xffff;
    return (((a & 0xc000) >> 14) + a * 4) & 0xffff;
  };
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    2, null, seed
  );
  assert.equal(scene.rng.seed, advance(advance(seed)),
    'AddedCallback draws twice; render-only cached item VMs draw nothing');
});

test('the tally clock advance is +1 when the stage quota is met, +2 when missed', () => {
  const met = makeScene(1);
  met.runState.currentTimeOrbs = 3000; // Lunatic stage-1 quota is 3000
  met.finishStageResults();
  assert.equal(met.runState.clockTime, 1, 'quota met -> +1');
  const missed = makeScene(1);
  missed.runState.currentTimeOrbs = 2999;
  missed.finishStageResults();
  assert.equal(missed.runState.clockTime, 2, 'quota missed -> +2');
  // Stage 2's Lunatic quota is 7200.
  const s2 = makeScene(2);
  s2.runState.currentTimeOrbs = 7199;
  s2.finishStageResults();
  assert.equal(s2.runState.clockTime, 2, 'stage-2 quota missed -> +2');
  const s2met = makeScene(2);
  s2met.runState.currentTimeOrbs = 7200;
  s2met.finishStageResults();
  assert.equal(s2met.runState.clockTime, 1, 'stage-2 quota met -> +1');
});

test('carryState keeps the run state and the carry restores it', () => {  const a = makeScene(1);
  a.score = 1234560;
  a.runState.score = 1234560;
  a.runState.clockTime = 1;
  a.runState.youkaiGauge = -4321;
  a.runState.pointItemValue = 320690;
  a.runState.pointItemExtends = 1;
  a.runState.nextPointItemExtendThreshold = 250;
  const carry = a.carryState();
  const b = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team, 2, carry,
    rpy.stages[1].rngSeed
  );
  assert.equal(b.score, 1234560);
  assert.equal(b.runState.score, 1234560, 'runState mirror restored (addScore cannot clobber it)');
  assert.equal(b.runState.clockTime, 1);
  assert.equal(b.runState.youkaiGauge, -4321);
  assert.equal(b.runState.pointItemValue, 320690);
  assert.equal(b.runState.pointItemExtends, 1);
  assert.equal(b.runState.nextPointItemExtendThreshold, 250);
});

test('the tally shows the night-clock plate and advances its slot', () => {
  const scene = makeScene(1);
  scene.startStageClearPresentation();
  assert.ok(scene.clearTimeRunner, 'current plate spawned');
  const curFrame = scene.clearTimeRunner.spriteFrame();
  assert.equal(curFrame.y, 0, 'current plate = 子の刻 (slot 0)');
  assert.equal(scene.clearTimeAdvancedRunner, null, 'no advanced plate yet');
  scene.runState.currentTimeOrbs = 3000; // met -> +1
  scene.finishStageResults();
  assert.ok(scene.clearTimeAdvancedRunner, 'advanced plate spawned at the advance');
  const advFrame = scene.clearTimeAdvancedRunner.spriteFrame();
  assert.equal(advFrame.y, 32, 'advanced plate = 子の二つ (slot 1, +1 advance)');
});
