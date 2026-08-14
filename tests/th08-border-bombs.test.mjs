import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-border-bombs.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-border-bombs.mjs --log-level=silent'
);
const mod = await import('../tests/.build/th08-border-bombs.mjs');
const {
  Th08BorderBombSim,
  TH08_BORDER_HUMAN_CALLBACKS,
  TH08_BORDER_YOUKAI_CALLBACKS,
  clearTh08BulletsInRegion,
} = mod;

const player = (x = 192, y = 200) => ({ x, y, z: 0 });
const target = { id: 7, x: 192, y: 80, z: 0, radius: 16 };

function run(sim, frames, input) {
  const events = [];
  for (let i = 0; i < frames; i++) events.push(...sim.tick(input));
  return events.flat();
}

test('callback tables preserve the exact supplied Border Team addresses', () => {
  assert.deepEqual(TH08_BORDER_HUMAN_CALLBACKS.addresses, [
    0x40c010, 0x410c40, 0x40c910, 0x410fe0, 0x40d100,
  ]);
  assert.deepEqual(TH08_BORDER_YOUKAI_CALLBACKS.addresses, [
    0x40c820, 0x40d950, 0x40d010, 0x4113a0, 0x40d310,
  ]);
});

test('Reimu initializes sixteen seeking orbs at the native angular ladder', () => {
  const sim = new Th08BorderBombSim({ side: 'human' });
  const events = run(sim, 1, { player: player(), targets: [target] });
  assert.equal(sim.frame, 0);
  assert.equal(sim.target.id, 7);
  assert.equal(sim.orbs.length, 16);
  assert.equal(new Set(sim.orbs.map(o => o.slot)).size, 16);
  assert.equal(sim.orbs[0].angle, Math.fround(-Math.PI));
  assert.equal(sim.orbs[1].angle, Math.fround(Math.fround(-Math.PI) + Math.fround(Math.PI / 8)));
  let expectedAngle = Math.fround(-Math.PI);
  for (let i = 0; i < 15; i++) expectedAngle = Math.fround(expectedAngle + Math.fround(Math.PI / 8));
  assert.equal(sim.orbs[15].angle, expectedAngle);
  assert.ok(sim.orbs.every(o => o.state === 'seeking'));
  assert.ok(events.some(e => e.kind === 'state' && e.to === 'active' && e.callback === 0x40c010));
  assert.ok(events.some(e => e.kind === 'sfx' && e.id === 0x0d));
  assert.ok(events.some(e => e.kind === 'anm' && e.script === 0x0c));
});

test('Reimu orbs seek the cached target and burst at frame forty', () => {
  const sim = new Th08BorderBombSim({ side: 'human' });
  const before = { x: sim.orbs[0]?.x, y: sim.orbs[0]?.y };
  const events = run(sim, 41, { player: player(), targets: [target] });
  assert.notDeepEqual(before, { x: sim.orbs[0].x, y: sim.orbs[0].y });
  assert.ok(sim.orbs.every(o => o.state !== 'seeking'));
  const clears = events.filter(e => e.kind === 'bullet-clear');
  assert.equal(clears.length, 16);
  assert.ok(clears.every(e => e.region.shape === 'circle' && e.region.radius === 64));
  assert.ok(events.some(e => e.kind === 'sfx' && e.id === 8));
  assert.ok(events.some(e => e.kind === 'attack-slot' && e.damage === null));
});

test('Reimu seeking speed is clamped to the native maximum ten', () => {
  const sim = new Th08BorderBombSim({ side: 'human' });
  const far = { id: 2, x: 1000, y: -500, z: 0 };
  run(sim, 20, { player: player(), targets: [far] });
  assert.ok(sim.orbs.every(o => o.speed <= Math.fround(10)));
});

test('Reimu aftermath ends after thirty burst frames', () => {
  const sim = new Th08BorderBombSim({ side: 'human' });
  run(sim, 71, { player: player(), targets: [target] });
  assert.equal(sim.frame, 70);
  assert.equal(sim.stage, 'ended');
  assert.ok(sim.orbs.every(o => o.state === 'inactive'));
});

test('bullet clear regions mutate passed bullets exactly once', () => {
  const bullets = [
    { id: 1, x: 195, y: 203 },
    { id: 2, x: 300, y: 300 },
  ];
  const ids = clearTh08BulletsInRegion(bullets, { shape: 'circle', x: 192, y: 200, radius: 64 });
  assert.deepEqual(ids, [1]);
  assert.deepEqual(clearTh08BulletsInRegion(bullets, { shape: 'circle', x: 192, y: 200, radius: 64 }), []);
});

test('Yukari side emits the full-playfield major clear and sixty-frame state', () => {
  const sim = new Th08BorderBombSim({ side: 'youkai' });
  const bullets = [
    { id: 1, x: 33, y: 17 }, { id: 2, x: 415, y: 463 },
    { id: 3, x: 20, y: 200 },
  ];
  const events = run(sim, 1, { player: player(), targets: [target], bullets });
  const clear = events.find(e => e.kind === 'bullet-clear');
  assert.equal(clear.region.shape, 'rect');
  assert.deepEqual(
    [clear.region.x, clear.region.y, clear.region.width, clear.region.height],
    [224, 240, 384, 448]
  );
  assert.deepEqual(clear.clearedBulletIds, [1, 2]);
  assert.equal(bullets[2].cleared, undefined);
  assert.equal(sim.activeCallback, 0x40c820);
  assert.equal(sim.stage, 'active');
  run(sim, 59, { player: player(), targets: [target] });
  assert.equal(sim.frame, 59);
  assert.equal(sim.stage, 'ended');
});

test('Yukari deathbomb exposes the native 128-slot pool and two anchor VMs', () => {
  const sim = new Th08BorderBombSim({ side: 'youkai', mode: 'deathbomb' });
  const events = run(sim, 1, { player: player(), targets: [target] });
  assert.equal(sim.orbs.length, 0x80);
  assert.equal(sim.activeCallback, 0x40d010);
  const anchors = events.filter(e => e.kind === 'anm' && (e.script === 0x15 || e.script === 0x16));
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map(e => e.script), [0x15, 0x16]);
  assert.equal(anchors[0].position.z, Math.fround(0.01));
});

test('human deathbomb uses staggered orb transitions and later target slots', () => {
  const sim = new Th08BorderBombSim({ side: 'human', mode: 'deathbomb' });
  const events = run(sim, 61, { player: player(), targets: [target] });
  assert.equal(sim.activeCallback, 0x40c910);
  assert.ok(sim.orbs.some(o => o.state === 'burst' || o.state === 'inactive'));
  const later = events.filter(e => e.kind === 'attack-slot' && e.slot >= 16);
  assert.ok(later.length > 0);
  assert.ok(later.every(e => e.position.x === target.x && e.position.y === target.y));
});

test('effect waves occur at exact native frames ten twenty and thirty', () => {
  const sim = new Th08BorderBombSim({ side: 'human' });
  const events = run(sim, 31, { player: player(), targets: [target] });
  const waves = events.filter(e => e.kind === 'anm' && [4, 5, 6, 7].includes(e.args[0]));
  assert.deepEqual(waves.map(e => e.frame), [10, 20, 30]);
  assert.deepEqual(waves.map(e => e.args[0]), [4, 5, 6]);
});
