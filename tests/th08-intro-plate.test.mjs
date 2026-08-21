import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 stage-intro night-time plate (times.anm script 0): the native intro
// shows the current 时刻 below the stage title (userdemo-t17..t22 — stage 1
// is 子の刻 pm11:00). The runner arms on the first stage-frame tick with
// the sprite slot = runState.clockTime (T8RP +0x22) and self-removes with
// the authored fade.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

function makeScene(stageNumber, snapshot) {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    stageNumber, null, snapshot.rngSeed
  );
  scene.mode = 'test';
  if (scene.runState) scene.runState.clockTime = snapshot.clockTime;
  return scene;
}
const idle = () => ({ held: new Set(), pressed: new Set() });

test('stage 1 intro arms the 子の刻 plate (times.anm slot 0) on the first tick', () => {
  const scene = makeScene(1, rpy.stages[0]);
  assert.equal(scene.stageIntroRunners.length, 4, 'stdNtxt four scripts only');
  // The native stage-load GUI init arms stgNtxt scripts 0-3 verbatim
  // (all.c:26963-26964 → FUN_00462360(gui+0x2a44, 0, 4)); the demo-only
  // "Demonstration" branch (all.c:26966-26972) must never appear here.
  assert.deepEqual(scene.stageIntroRunners.map((r) => r.scriptId), [0, 1, 2, 3]);
  assert.match(scene.stageIntroRunners[0].anm.entries[0].name, /stg1txt/);
  scene.update(idle());
  assert.equal(scene.stageIntroRunners.length, 5, 'times plate joined');
  const frame = scene.stageIntroRunners[4].spriteFrame();
  assert.ok(frame, 'plate has a sprite frame');
  assert.equal(frame.y, 0, 'slot 0 = 子の刻 pm11:00 (texture row 0)');
  assert.equal(frame.x, 0);
});

test('the stage-theme BGM credit rides intro script 3 (bottom slide-in strip)', () => {
  // stgNtxt script 3 IS the BGM credit: sprite3 = the baked
  // "BGM: 幻視の夜 ～ Ghostly Eyes" 256x24 strip at texture (0,80), sliding
  // (544,456)->(288,456) over t=200-260 (userdemo-t20). No separate arm.
  const scene = makeScene(1, rpy.stages[0]);
  const credit = scene.stageIntroRunners.find((r) => r.scriptId === 3);
  assert.ok(credit, 'script 3 among the intro runners');
  scene.update(idle());
  const frame = credit.spriteFrame();
  assert.deepEqual([frame.x, frame.y, frame.w, frame.h], [0, 80, 256, 24]);
});

test('stage 2 intro arms the 子の二つ plate (slot = clockTime 1)', () => {
  const scene = makeScene(2, rpy.stages[1]);
  assert.deepEqual(scene.stageIntroRunners.map((r) => r.scriptId), [0, 1, 2, 3]);
  assert.match(scene.stageIntroRunners[0].anm.entries[0].name, /stg2txt/);
  scene.update(idle());
  const plate = scene.stageIntroRunners.at(-1);
  const frame = plate.spriteFrame();
  assert.equal(frame.y, 32, 'slot 1 = 子の二つ pm11:30 (texture row 32)');
});

test('the plate self-removes with the authored fade', () => {
  const scene = makeScene(1, rpy.stages[0]);
  for (let f = 0; f < 600; f++) scene.update(idle());
  assert.ok(scene.stageIntroRunners.at(-1).removed, 'plate removed by ~460 like the rest of the intro');
});
