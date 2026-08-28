import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-option-shot.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-option-shot.mjs --log-level=silent'
);
const { updateTh08SeekingOptionShot } = await import('../tests/.build/th08-option-shot.mjs');

const f32 = Math.fround;

function makeShot(x, y, angle, speed) {
  return {
    x: f32(x), y: f32(y), angle: f32(angle), speed: f32(speed),
    vx: f32(Math.cos(angle) * speed),
    vy: f32(Math.sin(angle) * speed)
  };
}

test('a targetless seeking shot accelerates by native 1/3 and retains heading', () => {
  const b = makeShot(100, 100, Math.PI, 1);
  updateTh08SeekingOptionShot(b, null);
  assert.equal(b.speed, f32(f32(1) + 0.3333333432674408));
  assert.equal(b.angle, f32(Math.atan2(b.vy, b.vx)));
});

test('a target-seeking shot clamps speed into the native [1,10] range', () => {
  const slow = makeShot(0, 0, 0, 1);
  updateTh08SeekingOptionShot(slow, { x: 100, y: 0 });
  assert.equal(slow.speed, f32(1.25));
  assert.equal(slow.vx, f32(1.25));
  assert.equal(slow.angle, 0);

  const fast = makeShot(0, 0, 0, 20);
  fast.vx = 20;
  fast.vy = 0;
  updateTh08SeekingOptionShot(fast, { x: 100, y: 0 });
  assert.equal(fast.speed, 10);
  assert.equal(fast.vx, 10);
});
