import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 death white-out placement — Th08.exe v1.00d evidence:
//  - FUN_0044d2c0 draws FUN_0044de60(player, 768, 896, 0xffffffff, 0) EVERY
//    frame while player+0xe2a70 counts down;
//  - FUN_0044d180 arms +0xe2a70 = 0x3c on the miss commit and re-arms it
//    every death-squish frame (state 1), so the white quad spans the squish
//    plus 60 frames past it;
//  - the deathbomb WINDOW itself (state 2, FUN_0044cbf0) draws no white
//    quad — the old port's hitState overlay was placed in the wrong state.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

function makeScene() {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team, 1, null,
    rpy.stages[0].rngSeed
  );
  scene.mode = 'test';
  scene.playerObj.lives = 6;
  scene.playerObj.bombs = 3;
  for (let f = 0; f < 100; f++) scene.update({ held: new Set(), pressed: new Set() });
  const p = scene.playerObj;
  p.invulnFrames = 0;
  p.bombInvuln = 0;
  p.materializeFrame = -1;
  return scene;
}
const idle = () => ({ held: new Set(), pressed: new Set() });

test('no white quad during the deathbomb window', () => {
  const scene = makeScene();
  assert.equal(scene.playerObj.hit(), 'deathbomb-window');
  for (let f = 0; f < 10; f++) scene.update(idle());
  assert.equal(scene.playerObj.hitState, true, 'still inside the window');
  assert.equal(scene.th08DeathWhiteFrames, 0, 'window draws no white quad');
});

test('the miss commit arms 60, the squish holds it, then it counts down', () => {
  const scene = makeScene();
  const p = scene.playerObj;
  p.hit();
  // Let the 18-frame window lapse un-bombed: the commit arms the white-out.
  for (let f = 0; f < 20; f++) scene.update(idle());
  assert.equal(p.hitState, false, 'window lapsed');
  assert.equal(scene.th08DeathWhiteFrames, 60, 'commit arms 60');
  // Through the 30-frame squish it stays pinned at 60.
  for (let f = 0; f < 40; f++) scene.update(idle());
  assert.equal(p.dyingFrame, -1, 'squish finished (respawned)');
  assert.ok(
    scene.th08DeathWhiteFrames > 60 - 15 && scene.th08DeathWhiteFrames <= 60,
    `counting down after the squish, got ${scene.th08DeathWhiteFrames}`
  );
});

test('a deathbomb rescue never arms the white-out', () => {
  const scene = makeScene();
  const p = scene.playerObj;
  p.hit();
  for (let f = 0; f < 5; f++) scene.update(idle());
  scene.update({ held: new Set(['bomb']), pressed: new Set() });
  assert.equal(p.th08BombType, 3, 'unfocused deathbomb ran table[3]');
  for (let f = 0; f < 30; f++) scene.update(idle());
  assert.equal(scene.th08DeathWhiteFrames, 0, 'rescued: no white-out');
  assert.equal(p.lives, 6, 'no life lost');
});
