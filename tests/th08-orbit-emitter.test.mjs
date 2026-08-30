import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// FUN_004161b0/00416b90 captured-card tail.  The replay-facing cadence is
// covered by the formal verifier/native item telemetry; this focused test
// pins the budget bank and the ten-tick actor warm-up without depending on
// the still-divergent f4123 death-quad item-pool state.
const mod = await loadEngine();

function makeScene() {
  return new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), 3, 'reimuYukari', 1, null, 0x28ac
  );
}

function arm(scene, flags = 0) {
  scene.startBossSpell(0, 10_000_000, 244_897, 'test', 2100);
  scene.spellcard.elapsed = 787;
  scene.bossActive = { x: 258.5, y: 75.8, ecl: { th08: { flags } } };
  scene.armTh08BossOrbitEmitter(scene.spellcard);
  return scene.th08BossOrbitEmitter;
}

test('normal card orbit budget uses the native late-card interpolation', () => {
  const scene = makeScene();
  const emitter = arm(scene);
  assert.equal(emitter.budget, 442);
  assert.equal(emitter.timer, 19);
  assert.equal(emitter.warmup, 9);
});

test('Last Spell orbit budget is the flat native 700', () => {
  const scene = makeScene();
  const emitter = arm(scene, 0x08000000);
  assert.equal(emitter.budget, 700);
});

test('orbit emitter waits ten actor ticks, then pays 7+6 type-10 orbs', () => {
  const scene = makeScene();
  const emitter = arm(scene);
  const spawns = [];
  scene.traceReplayEvent = (event) => {
    if (event.kind === 'item-spawn') {
      spawns.push({ frame: event.frame, type: event.data.type, state: event.data.state });
    }
  };
  for (let i = 0; i < 9; i++) scene.updateTh08BossOrbitEmitter();
  assert.equal(spawns.length, 0, 'the first nine ticks only move the actor');
  assert.equal(emitter.timer, 28);
  scene.updateTh08BossOrbitEmitter();
  assert.equal(emitter.timer, 29);
  assert.equal(spawns.length, 13);
  assert.ok(spawns.every(({ type, state }) => type === 'time' && state === 5));
  assert.equal(emitter.budget, 428);
});
