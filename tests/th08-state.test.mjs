import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-state.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-state.mjs --log-level=silent'
);
const { Th08RunState } = await import('../tests/.build/th08-state.mjs');

test('time-orb parity drives the native night-value ladder', () => {
  const state = new Th08RunState(3);
  assert.equal(state.pointItemValue, 300000);
  state.addTimeOrbs(1);
  assert.deepEqual(
    [state.currentTimeOrbs, state.totalTimeOrbs, state.pointItemValue],
    [1, 1, 300000]
  );
  state.addTimeOrbs(1);
  assert.deepEqual(
    [state.currentTimeOrbs, state.totalTimeOrbs, state.pointItemValue],
    [2, 2, 300010]
  );
  state.addTimeOrbs(4);
  assert.deepEqual(
    [state.currentTimeOrbs, state.totalTimeOrbs, state.pointItemValue],
    [6, 6, 300030]
  );
});

test('negative time orbs clamp current without underflowing total state', () => {
  const state = new Th08RunState(3);
  state.addTimeOrbs(5);
  state.addTimeOrbs(-6);
  assert.equal(state.currentTimeOrbs, 0);
  assert.equal(state.totalTimeOrbs, 5);
  assert.equal(state.pointItemValue, 300020);
});

test('youkai gauge clamps and honors the native lock/copy behavior', () => {
  const state = new Th08RunState(3);
  state.addYoukaiGauge(-12000);
  assert.equal(state.youkaiGauge, -10000);
  assert.equal(state.youkaiGaugeCopy, -10000);
  state.gaugeLocked = true;
  state.addYoukaiGauge(500);
  assert.equal(state.youkaiGauge, -10000);
  state.addYoukaiGauge(500, true);
  assert.equal(state.youkaiGauge, -9500);
  assert.equal(state.youkaiGaugeCopy, -9500);
});

test('point-item extend thresholds follow the v1.00d tables', () => {
  const state = new Th08RunState(3);
  const expected = [100, 250, 500, 800, 1100, 9999, 10499];
  for (const threshold of expected) {
    assert.equal(state.nextPointItemExtendThreshold, threshold);
    state.pointItemExtends++;
    state.updatePointItemExtendThreshold();
  }
});

test('point collection reproduces PoC, tens, human-gauge, and score scaling', () => {
  const state = new Th08RunState(3);
  const normal = state.collectPoint({ atOrAbovePoC: true, abovePoCRandom: 100 });
  assert.deepEqual(
    [normal.award, normal.creditedScore, normal.rankDelta, state.pointItemsCollected],
    [120000, 12000, 3, 1]
  );

  const human = new Th08RunState(3);
  human.addYoukaiGauge(-8000, true);
  assert.equal(human.gaugeIsExtremelyHuman(), true);
  const doubled = human.collectPoint({ atOrAbovePoC: false });
  assert.equal(doubled.award, 600000);
  assert.equal(doubled.creditedScore, 60000);
});

test('small point and time-orb awards use native score divisions', () => {
  const state = new Th08RunState(3);
  const point = state.collectPointSmall({ atOrAbovePoC: true, abovePoCRandom: 100 });
  assert.deepEqual([point.award, point.creditedScore], [12000, 1200]);

  const time = state.collectTimeOrb({ timerCurrent: 0, playerRole: 1 });
  assert.deepEqual(
    [time.award, time.creditedScore, time.gaugeDelta, state.currentTimeOrbs, state.pointItemValue],
    [100, 10, 111, 1, 300000]
  );
});
