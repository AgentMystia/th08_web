import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-option-shot.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-option-shot.mjs --log-level=silent'
);
const { Th08SeekingOptionShot } = await import('../tests/.build/th08-option-shot.mjs');

test('SHT interval phase gates callback-1 option spawning', () => {
  assert.equal(Th08SeekingOptionShot.spawnsNow(15, 5, 0), true);
  assert.equal(Th08SeekingOptionShot.spawnsNow(15, 5, 1), false);
});

test('a targetless seeking shot accelerates by native 1/3 and retains heading', () => {
  const shot = new Th08SeekingOptionShot(100, 100, Math.PI, 1);
  shot.update(null);
  assert.equal(shot.speed, Math.fround(Math.fround(1) + Math.fround(1 / 3)));
  assert.equal(shot.heading, Math.fround(Math.atan2(shot.vy, shot.vx)));
  assert.equal(shot.x, Math.fround(100 - shot.speed));
});

test('a target-seeking shot clamps speed into the native [1,10] range', () => {
  const slow = new Th08SeekingOptionShot(0, 0, 0, 1);
  slow.update({ x: 100, y: 0 });
  assert.equal(slow.speed, Math.fround(1.25));
  assert.equal(slow.vx, Math.fround(1.25));
  assert.equal(slow.heading, 0);

  const fast = new Th08SeekingOptionShot(0, 0, 0, 20);
  fast.vx = 20;
  fast.vy = 0;
  fast.update({ x: 100, y: 0 });
  assert.equal(fast.speed, 10);
  assert.equal(fast.vx, 10);
});
