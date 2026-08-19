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
const { Th08BorderBomb, TH08_BOMB_INVULN } = mod;

// A recording host: attack slots settle damage immediately against a
// configurable enemy list; every other request lands in a log.
function makeHost(enemies = [], targetPos = null) {
  const log = { slots: [], clears: [], effects: [], orbs: [], sfx: [] };
  return {
    log,
    targetPos,
    addAttackSlot(x, y, radius, damage) {
      let settled = 0;
      for (const e of enemies) {
        const dx = e.x - x, dy = e.y - y;
        if (dx * dx + dy * dy <= radius * radius) settled += damage;
      }
      log.slots.push({ x, y, radius, damage, settled });
      return settled;
    },
    clearBullets(x, y, radius) {
      log.clears.push({ x, y, radius });
    },
    randomFloat() {
      return 0.5;
    },
    effectVm(script, x, y, scale, color) {
      log.effects.push({ script, x, y, scale, color });
    },
    orbVm(index, script, x, y) {
      log.orbs.push({ index, script, x, y });
    },
    playSfx(id, arg) {
      log.sfx.push({ id, arg });
    }
  };
}

test('durations follow be30 param_4 (active) and param_5 (invuln)', () => {
  // The ACTIVE length is param_4 (player+0xfe4, the end compare at
  // 0x44c667); the LONGER param_5 clock is the post-cast invulnerability.
  assert.equal(new Th08BorderBomb(0, 0, 0).duration, 200);
  assert.equal(new Th08BorderBomb(1, 0, 0).duration, 150);
  assert.equal(new Th08BorderBomb(2, 0, 0).duration, 200);
  assert.equal(new Th08BorderBomb(3, 0, 0).duration, 250);
  assert.equal(TH08_BOMB_INVULN[0], 260);
  assert.equal(TH08_BOMB_INVULN[1], 200);
  assert.equal(TH08_BOMB_INVULN[2], 260);
  assert.equal(TH08_BOMB_INVULN[3], 300);
});

test('type 0 cast spawns the sixteen-orb ladder at -pi + i*pi/8', () => {
  const bomb = new Th08BorderBomb(0, 192, 200);
  const host = makeHost();
  bomb.cast(host, 192, 200);
  // Sixteen orb VMs on script 0x13 (0x40c010's FUN_004069f0 calls).
  assert.equal(host.log.orbs.filter(o => o.script === 0x13).length, 16);
  // Cast-frame r96 clear + red flash (effect 12 → archive script 44,
  // DAT_004c6d30) + cast sfx.
  assert.ok(host.log.clears.some(c => c.radius === 96));
  assert.ok(host.log.effects.some(e => e.script === 44));
  assert.ok(host.log.sfx.some(s => s.id === 0x0d));
});

test('type 0 orbs seek the primary cache with the /8 clamped recurrence', () => {
  const bomb = new Th08BorderBomb(0, 192, 200);
  const host = makeHost([], { x: 192, y: 40 });
  bomb.cast(host, 192, 200);
  const orb0 = bomb.orbAt(0);
  const before = { x: orb0.x, y: orb0.y };
  for (let i = 0; i < 10; i++) bomb.tick(host, 192, 200, true);
  const after = bomb.orbAt(0);
  assert.ok(after.y < before.y, 'orb must climb toward the target above');
  assert.ok(host.log.clears.some(c => c.radius === 128));
});

test('type 0 releases the spiral at frame 40 and bursts on settled aura', () => {
  const bomb = new Th08BorderBomb(0, 192, 200);
  const host = makeHost();
  bomb.cast(host, 192, 200);
  for (let i = 0; i < 40; i++) bomb.tick(host, 192, 200, true);
  assert.equal(bomb.orbAt(0).state, 1, 'still seeking before frame 40');
  bomb.tick(host, 192, 200, true); // 41st callback: counter 40, the release
  const released = bomb.orbAt(0);
  // The release callback lands at radius 8 using native x=sin/y=cos, then
  // grows the radius to 11.2 for the next callback. No stale seek velocity
  // is added after the polar placement.
  assert.ok(Math.abs(Math.hypot(released.x - 192, released.y - 200) - 8) < 0.001);
  assert.equal(bomb.orbAt(0).speed, Math.fround(Math.fround(8) + Math.fround(3.2)));
  // An aura settling >= 200 damage bursts the orb with the 500 damage slot.
  const burstHost = makeHost([{ x: 192, y: 200 }]);
  const bomb2 = new Th08BorderBomb(0, 192, 200);
  bomb2.cast(burstHost, 192, 200);
  burstHost.log.slots.length = 0;
  bomb2.tick(burstHost, 192, 200, true);
  assert.ok(burstHost.log.slots.some(s => s.damage === 500));
  assert.equal(bomb2.orbAt(0).state, 2);
  for (let i = 0; i < 31; i++) bomb2.tick(burstHost, 192, 200, true);
  assert.equal(bomb2.orbAt(0), null, 'orb removed after 30 burst frames');
});

test('type 2 deathbomb parks orbs at speed 0 and bursts them staggered', () => {
  const bomb = new Th08BorderBomb(2, 192, 300);
  const host = makeHost();
  bomb.cast(host, 192, 300);
  assert.ok(bomb.orbAt(0) != null && bomb.orbAt(0).speed === 0, 'dword 2 = 0 at cast');
  for (let i = 0; i < 30; i++) bomb.tick(host, 192, 300, true);
  assert.equal(bomb.orbAt(0).state, 1);
  // Orb 0's forced burst lands at param_4-0x28-0 = 160; run well past it.
  for (let i = 0; i < 175; i++) bomb.tick(host, 192, 300, true);
  assert.ok(bomb.frame >= 170);
  const orb0 = bomb.orbAt(0);
  assert.ok(orb0 === null || orb0.state === 2);
});

test('type 2 polar motion stores position before applying the next radius increment', () => {
  const bomb = new Th08BorderBomb(2, 192, 300);
  const host = makeHost();
  bomb.cast(host, 192, 300);
  for (let i = 0; i < 41; i++) bomb.tick(host, 192, 300, true);
  const at40 = bomb.orbAt(0);
  assert.deepEqual({ x: at40.x, y: at40.y }, { x: 192, y: 300 }, 'frame 40 still uses radius 0');
  assert.equal(at40.speed, Math.fround(2.4), 'frame 40 arms the next radius');
  bomb.tick(host, 192, 300, true);
  const at41 = bomb.orbAt(0);
  assert.ok(Math.abs(Math.hypot(at41.x - 192, at41.y - 300) - Math.fround(2.4)) < 0.001);
  assert.ok(at41.x > 192, 'native x=sin(angle) convention rotates orb 0 to the right here');
});

test('type 2 bombardments land their orb VM at the TARGET, not the player', () => {
  // 0x5241-0x5276: every 20 frames past 40 the bombardment slot (16 then
  // 17) fires at the primary target with VM 0x14 — the 20-frame 4x flash
  // family must draw at the target position.
  const bomb = new Th08BorderBomb(2, 192, 300);
  const host = makeHost();
  host.targetPos = { x: 240, y: 120 };
  bomb.cast(host, 192, 300);
  for (let i = 0; i < 61; i++) bomb.tick(host, 192, 300, true);
  const bombardments = host.log.orbs.filter(o => o.index >= 16);
  assert.ok(bombardments.length >= 1, 'first bombardment by frame 60');
  assert.equal(bombardments[0].script, 0x14);
  assert.deepEqual(
    { x: bombardments[0].x, y: bombardments[0].y },
    { x: 240, y: 120 },
    'orb VM spawned at the target coords'
  );
  assert.ok(!host.log.orbs.some(o => o.index < 16 && o.script === 0x14), 'ring orbs keep script 0x13');
});

test('type 2 no-target bombardment uses two shared-RNG draws over the native field', () => {
  const bomb = new Th08BorderBomb(2, 192, 300);
  const host = makeHost();
  const draws = [0.25, 0.75];
  host.randomFloat = () => draws.shift();
  bomb.cast(host, 192, 300);
  for (let i = 0; i < 41; i++) bomb.tick(host, 192, 300, true);
  const shot = host.log.orbs.find(o => o.index >= 16);
  assert.ok(shot, 'first no-target bombardment spawned at frame 40');
  assert.deepEqual({ x: shot.x, y: shot.y }, { x: 112, y: 320 });
  assert.deepEqual(draws, [], 'exactly two gameplay RNG draws consumed');
  const scripts = host.log.effects.slice(-2).map(effect => effect.script);
  assert.deepEqual(scripts, [0x56, 0x57], 'native effect ids 0x31/0x37 mapped to archive scripts');
});

test('type 1/3 field bombs re-arm the r100 aura and fire waves at 10/20/30', () => {
  for (const type of [1, 3]) {
    const bomb = new Th08BorderBomb(type, 192, 200);
    const host = makeHost();
    bomb.cast(host, 192, 200);
    const waveScripts = type === 1 ? [0x59, 0x5a, 0x5b] : [0x5d, 0x5e, 0x5f];
    for (let i = 0; i < 31; i++) bomb.tick(host, 192, 200, true);
    // The wave rings ride the etama effect layer by archive script index.
    const effectScripts = host.log.effects.map(e => e.script);
    assert.ok(effectScripts.includes(type === 1 ? 0x58 : 0x5c), 'mapped cast effect');
    for (const s of waveScripts) assert.ok(effectScripts.includes(s), `wave ${s.toString(16)} for type ${type}`);
    assert.ok(!effectScripts.includes(type === 1 ? 0x24 : 0x25), 'raw effect id is not an archive script');
    // The field aura follows the player at r100 with damage 70.
    assert.ok(host.log.slots.some(s2 => s2.radius === 100 && s2.damage === 70));
  }
});

test('the machine pays the gauge +-26000/param_4 each frame (0x44c81b)', () => {
  // The denominator is 0x40be30's param_4 (player+0xfe4: 200/150/200/250),
  // NOT the bomb duration (param_5, player+0xe2af4's frame limit).
  const human = new Th08BorderBomb(0, 0, 0);
  assert.equal(human.gaugeDeltaThisFrame(), -Math.trunc(26000 / 200));
  const youkai = new Th08BorderBomb(1, 0, 0);
  assert.equal(youkai.gaugeDeltaThisFrame(), Math.trunc(26000 / 150));
  // Deathbomb types pay toward the INVERTED side: the focused-cast table[2]
  // (was youkai, now human-side) pays negative, the unfocused-cast table[3]
  // positive — the sign follows the post-inversion bombType bit 0.
  const focusedCast = new Th08BorderBomb(2, 0, 0);
  assert.equal(focusedCast.gaugeDeltaThisFrame(), -Math.trunc(26000 / 200));
  const unfocusedCast = new Th08BorderBomb(3, 0, 0);
  assert.equal(unfocusedCast.gaugeDeltaThisFrame(), Math.trunc(26000 / 250));
});

test('the bomb ends exactly at its duration', () => {
  const bomb = new Th08BorderBomb(1, 192, 200);
  const host = makeHost();
  bomb.cast(host, 192, 200);
  for (let i = 0; i < 149; i++) bomb.tick(host, 192, 200, true);
  assert.ok(bomb.active);
  bomb.tick(host, 192, 200, true);
  assert.ok(!bomb.active);
});
