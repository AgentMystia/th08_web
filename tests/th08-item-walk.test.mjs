import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 item-walk laws — Th08.exe v1.00d evidence (FUN_00440500 disasm):
//  - Collect reach: the walk prologue (0x440538) builds the item size vector
//    (SHT+0x18, SHT+0x18, 16.0) and FUN_0044a5a0 halves it (/2.0 via
//    FUN_0040c7d0); the player's grab AABB half-extents come from the SAME
//    field (player init all.c:38182: +0x3f0 = SHT+0x18 / 2.0). Both sides
//    are itemRadius/2 = 12 for Border (ply00a.sht @24 = 24.0 — the "26.0"
//    once claimed in a port comment was a misread) — axis boundary
//    |Δ| = 24 INCLUSIVE, both halves derived from the one SHT field.
//  - Bottom cull (0x44095b): fnstsw 0x41 parity keeps the item at exactly
//    the line (448+16) and frees only strictly beyond — y > 464.
//  - Toss states 3/5 differ (0x440746-0x4407e7 vs 0x4407e8-0x4408f6):
//    state 3 = 0.05*global gravity, one moveRate integration, 0.03*moveRate
//    tail, collect blocked while the state byte is still 3; state 5 =
//    gravity, integration BEFORE the crest test, non-crest frames take NO
//    0.03 tail and NO collect test, and the crest frame re-integrates at
//    the shared 0x440936 label (double moveRate step) before the tail.
//  - Iteration order: FUN_004400a0 tail-links every spawn into the active
//    list and the walk follows +0x2dc head-to-tail — SPAWN order.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

const f = Math.fround;
// The walk's own scalars at full speed (Border Team both forms).
const gr = f(1);            // globalRate = fround(slowRate)
const mr = f(f(0.9) * gr);  // moveRate = fround(itemMoveRate * globalRate)

function makeScene() {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team, 1, null,
    rpy.stages[0].rngSeed
  );
  scene.mode = 'test';
  for (let i = 0; i < 100; i++) scene.update({ held: new Set(), pressed: new Set() });
  return scene;
}

const idle = () => ({ held: new Set(), pressed: new Set() });

function inject(scene, over) {
  const it = {
    id: 900000 + scene['items'].length, poolSlot: -1,
    x: 200, y: 200, vx: 0, vy: 0, type: 'time', age: 0, state: 0, ...over
  };
  scene['items'].push(it);
  return it;
}

test('collect reach is itemRadius/2 on BOTH sides — Δx 23.9 collects, 24.1 misses', () => {
  const scene = makeScene();
  const p = scene.playerObj;
  const a = inject(scene, { x: f(p.x + 23.9), y: p.y, type: 'point' });
  const b = inject(scene, { x: f(p.x + 24.1), y: p.y, type: 'point' });
  scene.update(idle());
  assert.equal(a.dead, true, 'inside 24 (12+12) collects');
  assert.equal(b.dead ?? false, false, 'outside 24 does not collect');
});

test('bottom cull is strict — y exactly 464 survives one more frame', () => {
  const scene = makeScene();
  const it = inject(scene, { x: 100, y: 464, state: 0 });
  scene.update(idle());
  assert.equal(it.dead ?? false, false, 'equality at the line keeps the item alive');
  assert.ok(it.vy > 0, 'the equality frame still pays the gravity tail');
  scene.update(idle());
  assert.equal(it.dead, true, 'strictly past the line the next frame frees it');
});

test('state-3 toss: 0.05*global gravity, one integration, 0.03*moveRate tail', () => {
  const scene = makeScene();
  const it = inject(scene, { x: 32, y: 300, state: 3, vy: f(-0.2) });
  scene.update(idle());
  const vy1 = f(f(-0.2) + f(0.05) * gr);
  assert.equal(it.vy, f(vy1 + f(0.03) * mr), '0.05 gravity then 0.03*moveRate tail');
  assert.equal(it.y, f(300 + f(vy1 * mr)), 'single moveRate integration');
});

test('state-5 toss: non-crest frame pays NO 0.03 tail', () => {
  const scene = makeScene();
  const it = inject(scene, { x: 32, y: 300, state: 5, vy: f(-0.2) });
  scene.update(idle());
  const vy1 = f(f(-0.2) + f(0.05) * gr);
  assert.equal(it.state, 5, 'still rising');
  assert.equal(it.vy, vy1, 'only the 0.05*global gravity advances this frame');
  assert.equal(it.y, f(300 + f(vy1 * mr)), 'one moveRate integration');
});

test('state-5 toss: crest frame double-integrates then pays the tail', () => {
  const scene = makeScene();
  const it = inject(scene, { x: 32, y: 300, state: 5, vy: f(-0.04) });
  scene.update(idle());
  const vy1 = f(f(-0.04) + f(0.05) * gr); // > 0 → crest
  const step = f(vy1 * mr);
  assert.equal(it.state, 1, 'crest flips to homing state');
  assert.equal(it.y, f(f(300 + step) + step), 'two sequential moveRate integrations');
  assert.equal(it.vy, f(vy1 + f(0.03) * mr), '0.03*moveRate tail after the double move');
});

test('state-5 toss skips collection even inside the grab box while rising', () => {
  const scene = makeScene();
  const p = scene.playerObj;
  const it = inject(scene, { x: p.x, y: p.y, state: 5, vy: f(-0.2) });
  scene.update(idle());
  assert.equal(it.dead ?? false, false, 'rising state-5 orb on the player is not collected');
  assert.equal(it.state, 5);
});

test('the dense item array iterates in spawn order, not pool-slot order', () => {
  const scene = makeScene();
  const before = scene['items'].length;
  scene.spawnItem('point', 100, 200);
  scene.spawnItem('point', 120, 200);
  const items = scene['items'];
  assert.equal(items.length, before + 2);
  assert.ok(items[items.length - 2].x === 100 && items[items.length - 1].x === 120,
    'appended in call order (native +0x2dc tail-link)');
});
