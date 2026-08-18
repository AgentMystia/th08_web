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
const { Th08BorderBomb } = mod;

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
    effectVm(script, x, y, scale, color) {
      log.effects.push({ script, x, y, scale, color });
    },
    orbVm(index, script) {
      log.orbs.push({ index, script });
    },
    playSfx(id, arg) {
      log.sfx.push({ id, arg });
    }
  };
}

test('durations follow the cast helper 0x40be30 (260/200/260/300)', () => {
  assert.equal(new Th08BorderBomb(0, 0, 0).duration, 260);
  assert.equal(new Th08BorderBomb(1, 0, 0).duration, 200);
  assert.equal(new Th08BorderBomb(2, 0, 0).duration, 260);
  assert.equal(new Th08BorderBomb(3, 0, 0).duration, 300);
});

test('type 0 cast spawns the sixteen-orb ladder at -pi + i*pi/8', () => {
  const bomb = new Th08BorderBomb(0, 192, 200);
  const host = makeHost();
  bomb.cast(host, 192, 200);
  // Sixteen orb VMs on script 0x13 (0x40c010's FUN_004069f0 calls).
  assert.equal(host.log.orbs.filter(o => o.script === 0x13).length, 16);
  // Cast-frame bullet clear + red flash (effect 12 → archive script 44,
  // DAT_004c6d30) + cast sfx.
  assert.ok(host.log.clears.some(c => c.radius === 200));
  assert.ok(host.log.effects.some(e => e.script === 44));
  assert.ok(host.log.sfx.some(s => s.id === 0x0d));
});

test('type 0 orbs seek the primary cache with the /4 clamped recurrence', () => {
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
  // Orb 0's speed resets to 8 and the same tick's spiral branch already
  // grows it by 3.2 (the phase-B recurrence runs every frame).
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
  // Orb 0's forced burst lands at duration-0x28-0 = 220; run well past it.
  for (let i = 0; i < 200; i++) bomb.tick(host, 192, 300, true);
  assert.ok(bomb.frame >= 210);
  const orb0 = bomb.orbAt(0);
  assert.ok(orb0 === null || orb0.state === 2);
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
    for (const s of waveScripts) assert.ok(effectScripts.includes(s), `wave ${s.toString(16)} for type ${type}`);
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
  for (let i = 0; i < 199; i++) bomb.tick(host, 192, 200, true);
  assert.ok(bomb.active);
  bomb.tick(host, 192, 200, true);
  assert.ok(!bomb.active);
});
