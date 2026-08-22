import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 stage tally (native draw FUN_0043826b, all.c:26466-26606; op9
// snapshot all.c:24830-24847; credit all.c:25435-25478) + the extreme-gauge
// score trickle (player tick tail, all.c:37597-37614).
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
const Z = () => ({ held: new Set(['shoot']), pressed: new Set() });

test('the clear base is the per-stage DAT_004c7158 table (stage 2 = 1.5M)', () => {
  const s1 = makeScene(1, rpy.stages[0]);
  s1.computeClearBonus();
  assert.equal(s1.clearBonus.clear, 10000000, 'stage 1: 1,000,000 x10 display');
  const s2 = makeScene(2, rpy.stages[1]);
  s2.computeClearBonus();
  assert.equal(s2.clearBonus.clear, 15000000, 'stage 2: 1,500,000 x10 display');
});

test('extreme-gauge trickle: +10 live score per non-dialogue frame past ±8000', () => {
  const scene = makeScene(1, rpy.stages[0]);
  scene.runState.youkaiGauge = 9000;
  const score0 = scene.score;
  for (let f = 0; f < 10; f++) scene.update(idle());
  assert.equal(scene.score - score0, 100, 'FUN_004181f0(100) per frame = +10 live');
  assert.equal(scene.runState.gaugeTrickYoukai, 10);
  assert.equal(scene.runState.gaugeTrickHuman, 0);
  assert.equal(scene.runState.gaugeTrickTotal, 10);

  const human = makeScene(1, rpy.stages[0]);
  human.runState.youkaiGauge = -8000; // the compare is <= / >= (all.c:2322/2342)
  for (let f = 0; f < 5; f++) human.update(idle());
  assert.equal(human.runState.gaugeTrickHuman, 5, 'human side counts at exactly -8000');

  const mid = makeScene(1, rpy.stages[0]);
  mid.runState.youkaiGauge = 7999;
  for (let f = 0; f < 5; f++) mid.update(idle());
  assert.equal(mid.runState.gaugeTrickYoukai + mid.runState.gaugeTrickHuman, 0);
  assert.equal(mid.runState.gaugeTrickTotal, 5, 'denominator still counts');
});

test('the trickle pauses while a dialogue is present (IsDialogPresent gate)', () => {
  const scene = makeScene(1, rpy.stages[0]);
  scene.runState.youkaiGauge = 9000;
  scene.th08Dialogue = {
    machine: { state: { done: false, portraits: [0, 1, 2, 3].map(() => ({ position: 4 })) }, update: () => [] },
    runners: [], portraitOffsets: [0, 0, 0, 0], lastPositions: [4, 4, 4, 4]
  };
  const score0 = scene.score;
  for (let f = 0; f < 5; f++) scene.update(idle());
  assert.equal(scene.score - score0, 0);
  assert.equal(scene.runState.gaugeTrickTotal, 0);
});

test('tally rows match the native set, order, colors, and formats', () => {
  const scene = makeScene(1, rpy.stages[0]);
  scene.runState.currentTimeOrbs = 3200; // quota met (Lunatic s1 = 3000) → +1
  scene.runState.gaugeTrickTotal = 1000;
  scene.runState.gaugeTrickHuman = 125; // 12.50%
  scene.runState.gaugeTrickYoukai = 34; //  3.40%
  scene.activateStageResults();
  const rows = scene.stageClearRows();
  const texts = rows.map((r) => r.text);
  assert.deepEqual(texts, [
    'Stage Clear',
    'Clear =  10000000',
    `Point = ${String(0).padStart(8)}0`,
    `Graze = ${String(0).padStart(8)}0`,
    `Time  = ${String(3200 * 100).padStart(8)}0`,
    'over-80% =  12.50%',
    'over 80% =   3.40%',
    'Lunatic Rank *1.5',
    `Total = ${String(Math.trunc((1000000 + 320000) * 1.5)).padStart(8)}0`,
    'PM11:00', '>>', 'PM11:00'
  ]);
  assert.deepEqual(rows.map((r) => r.y), [96, 128, 144, 160, 176, 192, 208, 240, 256, 296, 296, 296]);
  assert.deepEqual(rows.map((r) => r.x), [120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 219, 253]);
  assert.equal(rows[0].color, '#ffff40', '0xffffff40 heading');
  assert.equal(rows[7].color, '#ff8080', '0xffff8080 rank');
  assert.equal(rows[10].color, '#afafaf', '0xffafafaf ">>"');
  assert.equal(rows[11].color, '#ff8f8f', '0xffff8f8f advanced clock');
});

test('the advanced clock counts up after a 60-frame beat, +4 with Z held', () => {
  const scene = makeScene(1, rpy.stages[0]);
  scene.runState.currentTimeOrbs = 3200; // met → target 子の二つ = 660+30
  scene.activateStageResults();
  assert.equal(scene.tallyClockShown, 660);
  assert.equal(scene.tallyClockTarget, 690);
  for (let f = 0; f < 60; f++) scene.update(idle());
  assert.equal(scene.tallyClockShown, 660, 'still at the entry time through the beat');
  scene.update(idle());
  assert.equal(scene.tallyClockShown, 661, '+1/min frame after the beat');
  scene.update(Z());
  assert.equal(scene.tallyClockShown, 665, '+4 with Z held (all.c:25493-25495)');
  for (let f = 0; f < 40; f++) scene.update(Z());
  assert.equal(scene.tallyClockShown, 690, 'clamped at the target');
  const clock = scene.stageClearRows().at(-1).text;
  assert.equal(clock, 'PM11:30');
});

test('a missed quota pays +2 (PM11:00 → AM 0:00 across midnight)', () => {
  const scene = makeScene(1, rpy.stages[0]);
  scene.runState.currentTimeOrbs = 100; // missed
  scene.activateStageResults();
  assert.equal(scene.tallyClockTarget, 720);
  const rows = scene.stageClearRows();
  assert.equal(rows.at(-3).text, 'PM11:00', 'entry row stays at the current time');
});

test('the Phantasm rank line exists and applies no multiplier (native quirk)', () => {
  // all.c:26554-26557 prints "Phantasm Rank*2.0" but the multiplier chain
  // (all.c:25449-25460) has no case 5.
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), 5, rpy.team, 1, null, rpy.stages[0].rngSeed
  );
  scene.mode = 'test';
  scene.computeClearBonus();
  assert.equal(scene.clearBonus.mult, 2.0, 'displayed mult');
  assert.equal(scene.clearBonus.total, 10000000, 'award NOT doubled (no case-5 arm)');
  assert.ok(scene.stageClearRows().some((r) => r.text === 'Phantasm Rank*2.0'));
});
