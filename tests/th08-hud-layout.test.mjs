import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-hud-layout.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-hud-layout.mjs --log-level=silent'
);
const {
  TH08_PLAYFIELD,
  TH08_HUD_FIELDS,
  TH08_HUD,
  TH08_DIFFICULTY_TAG,
  TH08_FORM_GAUGE,
  formGaugeCursorX,
  formGaugePercentX,
  hudValuePosition,
  gaugeQuad
} = await import('../tests/.build/th08-hud-layout.mjs');

test('TH08 playfield and front label positions match v1.00d', () => {
  assert.deepEqual(TH08_PLAYFIELD, { x: 32, y: 16, width: 384, height: 448 });
  // Exe DrawGameScene value rows (FUN_0043625d): HiScore y=40 ABOVE Score
  // y=56 (floats 0x4b432c/0x4b42a8); front.png's baked labels read
  // HiScore..Time top-down (sprites 2-9).
  assert.deepEqual(TH08_HUD_FIELDS.highScore, {
    labelScript: 2,
    labelPosition: { x: 432, y: 40 },
    valuePosition: { x: 488, y: 40 }
  });
  assert.deepEqual(TH08_HUD_FIELDS.score, {
    labelScript: 3,
    labelPosition: { x: 432, y: 56 },
    valuePosition: { x: 488, y: 56 }
  });
  assert.deepEqual(TH08_HUD_FIELDS.power.valuePosition, { x: 488, y: 136 });
  assert.deepEqual(TH08_HUD_FIELDS.graze.valuePosition, { x: 488, y: 152 });
  assert.deepEqual(TH08_HUD_FIELDS.point.valuePosition, { x: 488, y: 168 });
  assert.deepEqual(TH08_HUD_FIELDS.time.valuePosition, { x: 488, y: 184 });
  assert.equal(TH08_HUD.digitAdvance, 13);
});

test('difficulty tag reads sprites 283-288 from ascii.anm pause entry', () => {
  assert.equal(TH08_DIFFICULTY_TAG.imageKey, 'pause');
  assert.deepEqual(TH08_DIFFICULTY_TAG.position, { x: 552, y: 200 });
  assert.deepEqual(TH08_DIFFICULTY_TAG.rects[3], [128, 16, 64, 16]);
});

test('human/youkai gauge uses ascii.anm scripts 5-8 geometry', () => {
  assert.equal(TH08_FORM_GAUGE.imageKey, 'ascii');
  assert.deepEqual(TH08_FORM_GAUGE.plate, {
    rect: [0, 224, 128, 16],
    position: { x: 32, y: 449 }
  });
  assert.deepEqual(TH08_FORM_GAUGE.human.position, { x: 32, y: 449 });
  assert.deepEqual(TH08_FORM_GAUGE.youkai.position, { x: 144, y: 449 });
  assert.deepEqual(TH08_FORM_GAUGE.cursor, {
    rect: [128, 208, 8, 12],
    centerY: 453
  });
  assert.equal(formGaugeCursorX(-10000), 32);
  assert.equal(formGaugeCursorX(0), 88);
  assert.equal(formGaugeCursorX(10000), 144);
  assert.equal(formGaugePercentX(-10000, 8), 32);
  assert.equal(formGaugePercentX(10000, 7), 104);
});

test('resource icons use the native 16-pixel column pitch', () => {
  assert.equal(TH08_HUD.resourceIconStep, 16);
  assert.deepEqual(hudValuePosition('lives'), { x: 488, y: 88 });
  assert.deepEqual(hudValuePosition('bombs'), { x: 488, y: 104 });
});

test('the power gauge is a 128-wide quad from y136 to y152', () => {
  assert.deepEqual(gaugeQuad(128), [
    { x: 488, y: 136 },
    { x: 616, y: 136 },
    { x: 616, y: 152 },
    { x: 488, y: 152 }
  ]);
  assert.deepEqual(gaugeQuad(64)[1], { x: 552, y: 136 });
  assert.deepEqual(gaugeQuad(-1)[1], { x: 488, y: 136 });
  assert.deepEqual(gaugeQuad(200)[1], { x: 616, y: 136 });
});

// Native boss HP strip: measured on the native demo captures
// (n-f5900/n-f6050) — a 2px bar at y=19 spanning x=34..414, grey-white
// fill over a dark-blue remainder, draining right-to-left.
test('the boss lifebar is the native 2px strip at y=19', () => {
  assert.deepEqual(TH08_HUD.bossLifebar, {
    x: 34,
    y: 19,
    width: 380,
    height: 2,
    fillColor: 0x959595ff,
    emptyColor: 0x00001cff
  });
});
