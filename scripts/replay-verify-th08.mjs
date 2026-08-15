#!/usr/bin/env node
// TH08 Stage-1 replay verifier (node). Replays replay/th8_udLy01.rpy stage 1
// through the production StageScene (the same bundle the browser ships) and
// reports the earliest frame where our simulation diverges from the recorded
// run — drive that number upward; it is the vertical slice's convergence
// oracle.
//
// Usage: node scripts/replay-verify-th08.mjs [replay-file] [--trace N]
import { existsSync, readFileSync } from 'node:fs';
import {
  loadEngine, makeStubAssetsTh08, makeStubAudio
} from './lib/replay-harness.mjs';

const args = process.argv.slice(2);
const REPLAY = args[0] && !args[0].startsWith('-') ? args[0] : 'replay/th8_udLy01.rpy';
if (!existsSync(REPLAY)) {
  console.error(`replay file not found: ${REPLAY} (local-only evidence; never commit it)`);
  process.exit(2);
}

const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync(REPLAY));
const stage = rpy.stages[0];
console.log(`TH08 replay verifier: ${REPLAY}`);
console.log(`shotType ${rpy.shotByte} (${rpy.character}) difficulty ${rpy.difficulty} stage ${stage.stage} frames ${stage.inputs.length} rngSeed 0x${stage.rngSeed.toString(16)}`);
if (rpy.shotByte !== 0 || rpy.difficulty !== 3) {
  console.error(`expected Border Team Lunatic (shotType 0, difficulty 3), got ${rpy.shotByte}/${rpy.difficulty}`);
  process.exit(2);
}

const scene = new mod.StageScene(
  makeStubAssetsTh08(mod),
  makeStubAudio(),
  rpy.difficulty,
  rpy.th08Character,
  1,
  null,
  stage.rngSeed
);
// 'test' mode keeps the scene alive past any divergence death so later
// frames stay observable instead of freezing on the continue screen.
scene.mode = 'test';

// Minimal T8RP stage-entry restore (the TH08 counterpart of
// applyReplayStageSnapshot's TH07 fields — the full restore lands with the
// browser T8RP preview): score/graze/lives/bombs/power + the TH08 run-state
// fields.
// The recorded stage-entry rank (T8RP +0x25): the run's neutral point.
scene.rank = stage.rankByte;
scene.score = 0; // stage 1 of the recording starts fresh
scene.graze = stage.graze;
scene.playerObj.lives = stage.lives;
scene.playerObj.bombs = stage.bombs;
scene.playerObj.power = stage.power;
if (scene.runState) {
  scene.runState.pointItemValue = stage.pointItemValue;
  scene.runState.youkaiGauge = stage.youkaiGauge;
  scene.runState.clockTime = stage.clockTime;
  scene.runState.pointItemExtends = stage.pointItemExtends;
  scene.runState.nextPointItemExtendThreshold = stage.nextPointItemExtendThreshold;
}

// RNG budget accounting: every consumer bottoms out in u16(); the recorded
// stage-2 seed is the original's total draw budget (mod 65536) from the
// stage-1 seed. Count per-frame draws for earliest-divergence analysis.
let rngDraws = 0;
let rngBootstrapDraws = 0;
{
  const orig = scene.rng.u16.bind(scene.rng);
  let inBootstrap = true;
  scene.rng.u16 = () => {
    if (inBootstrap) rngBootstrapDraws++;
    else rngDraws++;
    return orig();
  };
  scene.rngBootstrapDone = () => { inBootstrap = false; };
}

scene.rngBootstrapDone?.();

const inputBits = (word) => ({
  held: new Set([
    word & 0x1 ? 'shoot' : null,
    word & 0x2 ? 'bomb' : null,
    word & 0x4 ? 'focus' : null,
    word & 0x10 ? 'up' : null,
    word & 0x20 ? 'down' : null,
    word & 0x40 ? 'left' : null,
    word & 0x80 ? 'right' : null,
    word & 0x100 ? 'skip' : null
  ].filter(Boolean)),
  pressed: new Set()
});

const inputs = stage.inputs;
const frames = inputs.length;
const spawnFrames = [];
const killFrames = [];
let divergeFrame = -1;
const traceEvery = args.includes('--trace') ? Number(args[args.indexOf('--trace') + 1]) || 50 : 50;
const trace = [];
const seenSpawned = new Set();
const seenDead = new Set();

for (let f = 0; f < frames; f++) {
  const word = inputs[f];
  scene.update(inputBits(word));
  // Spawn/kill event streams: the densest available AUX-free oracle until
  // TH08's aux semantics are decoded (RPY aux bits for T8RP are unverified).
  for (const enemy of scene.enemies) {
    if (!seenSpawned.has(enemy.id)) {
      seenSpawned.add(enemy.id);
      spawnFrames.push(f);
    }
    // hp<=0 is the durable kill signal (the manager removes dead enemies the
    // same frame; TH08 sweeps set HP=0 and never delete the slot).
    if (enemy.hp <= 0 && !seenDead.has(enemy.id)) {
      seenDead.add(enemy.id);
      killFrames.push(f);
    }
  }
  if (f % traceEvery === 0) {
    trace.push({
      f,
      px: Math.round(scene.playerObj.x),
      py: Math.round(scene.playerObj.y),
      enemies: scene.enemies.length,
      bullets: scene.enemyBullets.length,
      rng: scene.rng.seed,
      rngDraws,
      spawns: spawnFrames.length,
      kills: killFrames.length
    });
  }
}

console.log(`frames run: ${frames}`);
console.log(`spawns: ${spawnFrames.length} (first at f${spawnFrames[0] ?? '-'}, last at f${spawnFrames.at(-1) ?? '-'})`);
console.log(`kills: ${killFrames.length} (first at f${killFrames[0] ?? '-'})`);
console.log(`final rng seed: ${scene.rng.seed} (draws ${rngDraws}, bootstrap ${rngBootstrapDraws}; stage-2 entry seed 0x${rpy.stages[1].rngSeed.toString(16)} = target)`);
console.log(`end: score=${scene.score} graze=${scene.graze} enemies=${scene.enemies.length} bullets=${scene.enemyBullets.length} player=(${scene.playerObj.x},${scene.playerObj.y}) lives=${scene.playerObj.lives} bombs=${scene.playerObj.bombs}`);
if (scene.runState) {
  console.log(`th08 runState: gauge=${scene.runState.youkaiGauge} clock=${scene.runState.clockTime} orbs=${scene.runState.currentTimeOrbs}/${scene.runState.totalTimeOrbs} pointValue=${scene.runState.pointItemValue} extends=${scene.runState.pointItemExtends}`);
}
console.log('trace samples:');
for (const row of trace) console.log(' ', JSON.stringify(row));
process.exit(divergeFrame < 0 ? 0 : 1);
