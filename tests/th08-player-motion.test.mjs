import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-player-motion.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-player-motion.mjs --log-level=silent'
);
const { Th08PlayerMotion } = await import('../tests/.build/th08-player-motion.mjs');

const human = {
  speed: 4, focusedSpeed: 2, diagSpeed: 2.828427, diagFocusedSpeed: 1.414214
};
const youkai = {
  speed: 5, focusedSpeed: 3, diagSpeed: 3.5, diagFocusedSpeed: 2.5
};

test('Border Team diagonal movement uses the SHT float table', () => {
  const player = new Th08PlayerMotion(human, youkai);
  player.x = 192;
  player.y = 240;
  assert.equal(player.update({ up: true, down: false, left: true, right: false, focus: false }), true);
  assert.equal(player.direction, 5);
  assert.equal(player.inputVx, -2.8284270763397217);
  assert.equal(player.inputVy, -2.8284270763397217);
  assert.equal(player.x, 189.17156982421875);
  assert.equal(player.y, 237.17156982421875);
});

test('focus selects the youkai SHT immediately and scales by slow rate', () => {
  const player = new Th08PlayerMotion(human, youkai);
  player.x = 100;
  player.y = 100;
  player.update({ up: false, down: false, left: false, right: true, focus: true }, { slowRate: 0.5 });
  assert.equal(player.isYoukai, true);
  assert.equal(player.frameVx, 2.5);
  assert.equal(player.x, 102.5);
});

test('movement clamps to the native player-area bounds', () => {
  const player = new Th08PlayerMotion(human, youkai);
  player.x = 8;
  player.y = 16;
  player.update({ up: true, down: false, left: true, right: false, focus: false });
  assert.deepEqual([player.x, player.y], [8, 16]);

  player.x = 376;
  player.y = 432;
  player.update({ up: false, down: true, left: false, right: true, focus: false });
  assert.deepEqual([player.x, player.y], [376, 432]);
});
