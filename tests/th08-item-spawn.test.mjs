import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-item-spawn.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-item-spawn.mjs --log-level=silent'
);
execSync(
  'npx esbuild src/core/rng.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-rng.mjs --log-level=silent'
);
const { Th08ItemSpawnPool, TH08_ITEM_POOL_SIZE } =
  await import('../tests/.build/th08-item-spawn.mjs');
const { Rng: RngClass } = await import('../tests/.build/th08-rng.mjs');

function rng(seed = 0x8fbe) {
  return new RngClass(seed);
}

test('the first native item allocation consumes slot zero and advances the cursor', () => {
  const pool = new Th08ItemSpawnPool();
  const item = pool.spawn({ x: 192, y: 240, type: 'point', rng: rng() });
  assert.equal(item.poolSlot, 0);
  assert.equal(item.active, true);
  assert.deepEqual([item.vx, item.vy, item.vz], [0, Math.fround(-2.2), 0]);
  assert.equal(pool.nextIndex, 1);
});

test('out-of-bounds x rejects before pool or RNG mutation', () => {
  const pool = new Th08ItemSpawnPool();
  assert.equal(pool.spawn({ x: -64.1, y: 0, type: 'point', rng: rng() }), null);
  assert.equal(pool.spawn({ x: 448.1, y: 0, type: 'point', rng: rng() }), null);
  assert.equal(pool.nextIndex, 0);
  assert.equal(pool.items[0].active, false);
});

test('full power converts power drops to small point items', () => {
  const pool = new Th08ItemSpawnPool();
  const item = pool.spawn({
    x: 100, y: 100, type: 'powerBig', state: 1, rng: rng(), power: 128
  });
  assert.equal(item.type, 'pointSmall');
  assert.equal(item.state, 1);
});

test('time items force native state three and randomized death-drop motion', () => {
  const seed = 0x1234;
  const expected = rng(seed);
  // FUN_004400a0 param_4==3: 0x3e4ccccd is 0.2f, so
  // vy = -2.0 - rng01*0.2 and vx = signed rng01*0.6.
  const vy = Math.fround(Math.fround(-2) - Math.fround(expected.range(0.2)));
  const vx = Math.fround(Math.fround(Math.fround(expected.f() * 2) - 1) * 0.6);

  const pool = new Th08ItemSpawnPool();
  const item = pool.spawn({ x: 100, y: 100, type: 'time', state: 0, rng: rng(seed) });
  assert.equal(item.type, 'time');
  assert.equal(item.state, 3);
  assert.equal(item.vx, vx);
  assert.equal(item.vy, vy);

  const dead = pool.spawn({ x: 100, y: 100, type: 'time', rng: rng(seed), playerDead: true });
  assert.equal(dead.state, 0);
  assert.deepEqual([dead.vx, dead.vy, dead.vz], [0, Math.fround(-0.9), 0]);
});

test('state two captures a random in-field tween target', () => {
  const seed = 0x4040;
  const expected = rng(seed);
  const tx = Math.fround(Math.fround(expected.range(288)) + 48);
  const ty = Math.fround(Math.fround(expected.range(192)) - 64);
  const pool = new Th08ItemSpawnPool();
  const item = pool.spawn({ x: 10, y: 400, type: 'point', state: 2, rng: rng(seed) });
  assert.deepEqual([item.targetX, item.targetY, item.targetZ], [tx, ty, 0]);
  assert.deepEqual([item.vx, item.vy, item.vz], [10, 400, 0]);
});

test('a time item encountering an occupied slot aborts without RNG draws', () => {
  const pool = new Th08ItemSpawnPool();
  pool.items[0].active = true;
  const before = rng().seed;
  assert.equal(pool.spawn({ x: 10, y: 10, type: 'time', rng: rng() }), null);
  assert.equal(before, 0x8fbe);
  assert.equal(pool.nextIndex, 1);
});

test('the rotating cursor wraps at the native pool boundary', () => {
  const pool = new Th08ItemSpawnPool();
  pool.nextIndex = TH08_ITEM_POOL_SIZE - 1;
  const item = pool.spawn({ x: 10, y: 10, type: 'point', rng: rng() });
  assert.equal(item.poolSlot, TH08_ITEM_POOL_SIZE - 1);
  assert.equal(pool.nextIndex, 0);
});
