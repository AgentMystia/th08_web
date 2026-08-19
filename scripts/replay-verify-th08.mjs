#!/usr/bin/env node
// TH08 Stage-1 replay verifier (node). Replays the committed fixture
// tests/replays/th8_udLy01.rpy stage 1 through the production StageScene
// (the same bundle the browser ships) and reports the earliest frame where
// our simulation diverges from the recorded run — drive that number upward;
// it is the vertical slice's convergence oracle.
//
// Usage: node scripts/replay-verify-th08.mjs [replay-file]
//   [--trace A,B] [--trace-kinds kind,...] [--trace-every N] [--dump-frame F]
//   [--native-trace trace.jsonl] [--diagnostic]
import { existsSync, readFileSync } from 'node:fs';
import {
  loadEngine, makeStubAssetsTh08, makeStubAudio
} from './lib/replay-harness.mjs';

const args = process.argv.slice(2);
const optionValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const traceRange = (() => {
  const raw = optionValue('--trace');
  if (!raw) return null;
  const [fromRaw, toRaw = fromRaw] = raw.split(',');
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    console.error(`invalid --trace range ${raw}; expected A,B`);
    process.exit(2);
  }
  return { from, to };
})();
const dumpFrame = optionValue('--dump-frame') == null
  ? null
  : Number(optionValue('--dump-frame'));
if (dumpFrame != null && (!Number.isInteger(dumpFrame) || dumpFrame < 0)) {
  console.error('--dump-frame expects a non-negative replay frame');
  process.exit(2);
}
const diagnostic = args.includes('--diagnostic');
const nativeTracePath = optionValue('--native-trace');
const traceKinds = (() => {
  const raw = optionValue('--trace-kinds');
  if (!raw) return null;
  const kinds = raw.split(',').map((kind) => kind.trim()).filter(Boolean);
  if (kinds.length === 0) {
    console.error('--trace-kinds expects a comma-separated event-kind list');
    process.exit(2);
  }
  return new Set(kinds);
})();
const wantsTraceKind = (kind) => traceKinds == null || traceKinds.has(kind);
// Fixture resolution: the committed tests/replays/ copy first (CI has no
// local replay/ dir), the git-ignored local-evidence copy second.
const DEFAULT_REPLAYS = ['tests/replays/th8_udLy01.rpy', 'replay/th8_udLy01.rpy']
  .filter(existsSync);
const REPLAY = args[0] && !args[0].startsWith('-')
  ? args[0]
  : DEFAULT_REPLAYS[0] ?? 'replay/th8_udLy01.rpy';
if (!existsSync(REPLAY)) {
  console.error(`replay file not found: ${REPLAY} (expected the committed fixture tests/replays/th8_udLy01.rpy)`);
  process.exit(2);
}

const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync(REPLAY));
const stage = rpy.stages[0];
console.log(`TH08 replay verifier: ${REPLAY}`);
console.log(`shotType ${rpy.shotType} (${rpy.team}) difficulty ${rpy.difficulty} stage ${stage.stage} frames ${stage.inputs.length} rngSeed 0x${stage.rngSeed.toString(16)}`);
if (rpy.shotType !== 0 || rpy.difficulty !== 3) {
  console.error(`expected Border Team Lunatic (shotType 0, difficulty 3), got ${rpy.shotType}/${rpy.difficulty}`);
  process.exit(2);
}

const scene = new mod.StageScene(
  makeStubAssetsTh08(mod),
  makeStubAudio(),
  rpy.difficulty,
  rpy.team,
  1,
  null,
  stage.rngSeed
);
// The formal gate uses the real replay death path and stops at the first
// unexpected hit. Skipping the continue/game-over consequence is available
// only as an explicitly requested diagnostic run.
scene.mode = diagnostic ? 'test' : 'replay';

// Minimal native T8RP stage-entry restore: score/graze/lives/bombs/power
// plus the TH08 run-state fields.
// The recorded stage-entry rank (T8RP +0x25): the run's neutral point.
scene.rank = stage.rank;
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
    const value = orig();
    if (!inBootstrap && (nativeTracePath || (traceRange && currentFrame >= traceRange.from && currentFrame <= traceRange.to))) {
      const source = new Error().stack?.split('\n')[2]?.trim().replace(/^at\s+/, '') ?? 'unknown';
      scene.traceReplayEvent({
        kind: 'rng', frame: scene.frame,
        data: { source, draw: rngDraws, value, seed: scene.rng.seed }
      });
    }
    return value;
  };
  scene.rngBootstrapDone = () => { inBootstrap = false; };
}

scene.rngBootstrapDone?.();

function replaySlowdownAdvancesLocal(recordedFps, counter) {
  if (recordedFps < 20) return counter % 3 === 0;
  if (recordedFps < 30) return counter % 2 === 0;
  if (recordedFps < 40) return counter % 3 !== 0;
  if (recordedFps < 50) return counter % 6 !== 0;
  return true;
}

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
let currentFrame = -1;
let stoppedEarly = false;
let firstHitReplayFrame = null;
const traceEvery = Number(optionValue('--trace-every')) || 50;
const trace = [];
const eventTrace = [];
let frameDump = null;
const seenSpawned = new Set();

if (traceRange || nativeTracePath) {
  scene.traceReplayEvent = (event) => {
    if (!wantsTraceKind(event.kind)) return;
    const enriched = { ...event, replayFrame: currentFrame };
    if (!traceRange || (currentFrame >= traceRange.from && currentFrame <= traceRange.to)) {
      eventTrace.push(enriched);
    }
  };
}

// Kill stream: instrument the runtime's killEnemy. Polling scene.enemies for
// hp<=0 misses enemies removed in the same update pass (the manager splices
// them out before the next frame's census).
const origKill = scene.runtime.killEnemy.bind(scene.runtime);
scene.runtime.killEnemy = (game, e, bombContact) => {
  killFrames.push(currentFrame);
  return origKill(game, e, bombContact);
};

let modeCounter = 0;
for (let f = 0; f < frames; f++) {
  // Native replay slowdown (recorded per 30 frames): the recorded cadence
  // bucket decides whether this replay input advances the simulation.
  const recordedFps = stage.slowdown[Math.floor(f / 30)] & 0x7f;
  const advances = recordedFps >= 60 || replaySlowdownAdvancesLocal(recordedFps, ++modeCounter);
  if (!advances) continue;
  currentFrame = f;
  const word = inputs[f];
  scene.update(inputBits(word));
  if (firstHitReplayFrame == null && scene.hitLog.length > 0) firstHitReplayFrame = f;
  // Spawn stream census; the kill stream comes from the killEnemy hook above.
  for (const enemy of scene.enemies) {
    if (!seenSpawned.has(enemy.id)) {
      seenSpawned.add(enemy.id);
      spawnFrames.push(f);
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
  if (traceRange && wantsTraceKind('frame') && f >= traceRange.from && f <= traceRange.to) {
    eventTrace.push({
      kind: 'frame', frame: scene.frame, replayFrame: f,
      data: {
        input: word, playerX: scene.playerObj.x, playerY: scene.playerObj.y,
        playerState: scene.playerObj.hitState, lives: scene.playerObj.lives,
        bombs: scene.playerObj.bombs, power: scene.playerObj.power,
        rank: scene.rank, rankAccumulator: scene.rankAccumulator,
        youkaiGauge: scene.runState?.youkaiGauge ?? 0,
        timelineClock: scene.runtime.mainTimeline.frame,
        timelineIndex: scene.runtime.mainTimeline.index,
        enemies: scene.enemies.length, bullets: scene.enemyBullets.length,
        items: scene.items.length, rng: scene.rng.seed, rngDraws
      }
    });
  }
  if (dumpFrame === f) {
    frameDump = {
      replayFrame: f, simFrame: scene.frame, input: word,
      player: {
        x: scene.playerObj.x, y: scene.playerObj.y,
        lives: scene.playerObj.lives, bombs: scene.playerObj.bombs,
        power: scene.playerObj.power, form: scene.playerObj.th08Form
      },
      timeline: scene.runtime.mainTimeline,
      rank: scene.rank, rankAccumulator: scene.rankAccumulator,
      youkaiGauge: scene.runState?.youkaiGauge,
      rng: scene.rng.seed, rngDraws,
      enemies: scene.enemies.map((enemy) => ({
        id: enemy.id, slot: enemy.poolSlot, sub: enemy.ecl.subId,
        clock: enemy.ecl.ctx.time, x: enemy.x, y: enemy.y, hp: enemy.hp,
        moveMode: enemy.ecl.th08?.movement.mode ?? enemy.ecl.moveMode
      })),
      bullets: scene.enemyBullets.map((bullet) => ({
        id: bullet.id, slot: bullet.poolSlot, ownerId: bullet.ownerId,
        ownerSub: bullet.ownerSub, spawnFrame: bullet.spawnFrame,
        x: bullet.x, y: bullet.y, angle: bullet.angle, speed: bullet.speed,
        age: bullet.age, exFlags: bullet.exFlags
      })),
      items: scene.items.map((item) => ({
        slot: item.poolSlot, type: item.type, x: item.x, y: item.y,
        state: item.state, age: item.age
      }))
    };
  }
  if (!diagnostic && scene.hitLog.length > 0) {
    stoppedEarly = true;
    break;
  }
}

console.log(`replay frames visited: ${currentFrame + 1}/${frames}`);
console.log(`spawns: ${spawnFrames.length} (first at f${spawnFrames[0] ?? '-'}, last at f${spawnFrames.at(-1) ?? '-'})`);
console.log(`kills: ${killFrames.length} (first at f${killFrames[0] ?? '-'})`);
console.log(`final rng seed: ${scene.rng.seed} (draws ${rngDraws}, bootstrap ${rngBootstrapDraws}; stage-2 entry seed 0x${rpy.stages[1].rngSeed.toString(16)} = target)`);
console.log(`end: score=${scene.score} graze=${scene.graze} enemies=${scene.enemies.length} bullets=${scene.enemyBullets.length} player=(${scene.playerObj.x},${scene.playerObj.y}) lives=${scene.playerObj.lives} bombs=${scene.playerObj.bombs}`);
if (scene.runState) {
  console.log(`th08 runState: gauge=${scene.runState.youkaiGauge} clock=${scene.runState.clockTime} orbs=${scene.runState.currentTimeOrbs}/${scene.runState.totalTimeOrbs} pointValue=${scene.runState.pointItemValue} extends=${scene.runState.pointItemExtends}`);
}

// End-of-stage state vs the recorded stage-2 entry snapshot (the original
// engine's own ground truth for what stage 1 must produce). Every field is
// an integral of the whole run — matching them forces near-total
// convergence. PASS requires all fields exact plus the RNG residue.
const next = rpy.stages[1];
const checks = [
  ['score', scene.score, stage.scoreAtEnd],
  ['power', scene.playerObj.power, next.power],
  ['lives', scene.playerObj.lives, next.lives],
  ['bombs', scene.playerObj.bombs, next.bombs],
  ['graze', scene.graze, next.graze],
  ['pointItems', scene.pointItems, next.pointItems]
];
if (scene.runState) {
  checks.push(
    ['youkaiGauge', scene.runState.youkaiGauge, next.youkaiGauge],
    ['clockTime', scene.runState.clockTime, next.clockTime],
    ['pointItemValue', scene.runState.pointItemValue, next.pointItemValue],
    ['pointItemExtends', scene.runState.pointItemExtends, next.pointItemExtends],
    ['nextExtendThreshold', scene.runState.nextPointItemExtendThreshold, next.nextPointItemExtendThreshold]
  );
}
// RNG residue: the original's total stage-1 draw budget (mod 65536) is the
// distance from the stage-1 seed to the stage-2 seed.
let rngBudget = -1;
{
  let s = stage.rngSeed;
  for (let i = 0; i < 65536; i++) {
    const a = ((s ^ 0x9630) - 0x6553) & 0xffff;
    s = (((a & 0xc000) >> 14) + a * 4) & 0xffff;
    if (s === next.rngSeed) { rngBudget = i + 1; break; }
  }
}
const rngMatch = rngBudget >= 0 && rngDraws % 65536 === rngBudget % 65536;
const ranAllFrames = !stoppedEarly;
let allPass = rngMatch && ranAllFrames && scene.hitLog.length === 0;
if (ranAllFrames) {
  console.log('end-of-stage vs native stage-2 entry:');
  for (const [name, ours, native] of checks) {
    const ok = ours === native;
    if (!ok) allPass = false;
    console.log(`  ${name}: ours=${ours} native=${native} ${ok ? 'exact' : 'DIFF'}`);
  }
  console.log(`  rng: ours=${rngDraws} native≡${rngBudget} (mod 65536) ${rngMatch ? 'exact' : 'DIFF'}`);
} else {
  console.log('end-of-stage vs native stage-2 entry: NOT REACHED (formal replay stopped at first committed hit)');
}
console.log(allPass ? 'STAGE 1 PASS' : 'STAGE 1 DIVERGED');
if (scene.hitLog.length > 0) {
  console.log(`unexpected player hits: ${scene.hitLog.length}`);
  for (const hit of scene.hitLog) console.log(' ', JSON.stringify(hit));
}
let earliestDivergence = scene.hitLog[0]
  ? { replayFrame: firstHitReplayFrame, reason: 'unexpected-player-hit', ours: scene.hitLog[0] }
  : null;
if (nativeTracePath) {
  if (!existsSync(nativeTracePath)) {
    console.error(`native trace not found: ${nativeTracePath}`);
    process.exit(2);
  }
  const raw = readFileSync(nativeTracePath, 'utf8').trim();
  const nativeEvents = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const count = Math.max(eventTrace.length, nativeEvents.length);
  for (let i = 0; i < count; i++) {
    if (JSON.stringify(eventTrace[i]) !== JSON.stringify(nativeEvents[i])) {
      earliestDivergence = {
        replayFrame: eventTrace[i]?.replayFrame ?? nativeEvents[i]?.replayFrame ?? -1,
        reason: 'native-event-stream', eventIndex: i,
        ours: eventTrace[i] ?? null, native: nativeEvents[i] ?? null
      };
      allPass = false;
      break;
    }
  }
}
console.log(`EARLIEST DIVERGENCE: ${earliestDivergence ? JSON.stringify(earliestDivergence) : 'none observed'}`);
if (frameDump) console.log(`FRAME DUMP: ${JSON.stringify(frameDump)}`);
if (traceRange) {
  console.log(`event trace ${traceRange.from},${traceRange.to}:`);
  for (const event of eventTrace) console.log(JSON.stringify(event));
}
console.log('trace samples:');
for (const row of trace) console.log(' ', JSON.stringify(row));
process.exit(allPass ? 0 : 1);
