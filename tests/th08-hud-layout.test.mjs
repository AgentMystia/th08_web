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
  hudValuePosition,
  gaugeQuad
} = await import('../tests/.build/th08-hud-layout.mjs');

test('TH08 playfield and front label positions match v1.00d', () => {
  assert.deepEqual(TH08_PLAYFIELD, { x: 32, y: 16, width: 384, height: 448 });
  assert.deepEqual(TH08_HUD_FIELDS.score, {
    labelScript: 2,
    labelPosition: { x: 432, y: 40 },
    valuePosition: { x: 488, y: 40 }
  });
  assert.deepEqual(TH08_HUD_FIELDS.time.valuePosition, { x: 488, y: 184 });
  assert.equal(TH08_HUD.digitAdvance, 13);
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
