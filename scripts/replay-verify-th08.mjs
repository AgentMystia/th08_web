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
// --clear-check: liveness diagnostic. Replays the recorded inputs with the
// player pinned invulnerable, then idles Z until the stage tally latches —
// answers "does the stage still complete" without the RNG-lottery phantom
// hits stopping the run. Not a fidelity gate (fidelity = the formal mode).
const clearCheck = args.includes('--clear-check');
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
// --stage N (default 1): replay stage N of the fixture and compare the end
// state against stage N+1's recorded entry snapshot.
const stageNumber = Math.max(1, Number(optionValue('--stage') ?? 1) | 0);
const stageIndex = rpy.stages.findIndex((s) => s.stage === stageNumber);
if (stageIndex < 0) {
  console.error(`replay has no stage ${stageNumber} block (present: ${rpy.stages.map((s) => s.stage).join(', ')})`);
  process.exit(2);
}
const stage = rpy.stages[stageIndex];
const entryScore = stageIndex > 0 ? rpy.stages[stageIndex - 1].scoreAtEnd : 0;
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
  stageNumber,
  null,
  stage.rngSeed
);
// The formal gate uses the real replay death path and stops at the first
// unexpected hit. Skipping the continue/game-over consequence is available
// only as an explicitly requested diagnostic run.
scene.mode = diagnostic || clearCheck ? 'test' : 'replay';

// Minimal native T8RP stage-entry restore: score/graze/lives/bombs/power
// plus the TH08 run-state fields. The entry score is the PREVIOUS stage's
// recorded end score (stage 1 starts fresh at 0); addScore routes through
// runState, so both fields must be restored.
// The recorded stage-entry rank (T8RP +0x25): the run's neutral point.
scene.rank = stage.rank;
scene.score = entryScore;
scene.graze = stage.graze;
scene.playerObj.lives = stage.lives;
scene.playerObj.bombs = stage.bombs;
scene.playerObj.power = stage.power;
if (scene.runState) {
  scene.runState.score = entryScore;
  scene.runState.pointItemValue = stage.pointItemValue;
  scene.runState.youkaiGauge = stage.youkaiGauge;
  scene.runState.clockTime = stage.clockTime;
  scene.runState.pointItemExtends = stage.pointItemExtends;
  scene.runState.nextPointItemExtendThreshold = stage.nextPointItemExtendThreshold;
}

// RNG budget accounting: every consumer bottoms out in u16(); the recorded
// stage-2 seed is the original's total draw budget (mod 65536) from the
// stage-1 seed. Native's GLOBAL diagnostic counter is not reset when the T8RP
// seed is restored: FUN_0043b984 and the pre-stage runtime init consume 90
// draws first. Those draws must appear in /proc counter comparisons, but MUST
// NOT advance the replay RNG stream or enter the stage-entry seed-distance
// oracle. StageScene construction then consumes the two native manager-cursor
// draws from the restored stage seed before this harness can wrap u16().
const rngPreRestoreDraws = 90;
let rngStageDraws = 2;
let rngDraws = rngPreRestoreDraws + rngStageDraws;
const rngBootstrapDraws = rngDraws;
{
  const orig = scene.rng.u16.bind(scene.rng);
  scene.rng.u16 = () => {
    rngStageDraws++;
    rngDraws++;
    const value = orig();
    if (nativeTracePath || (traceRange && currentFrame >= traceRange.from && currentFrame <= traceRange.to)) {
      const source = new Error().stack?.split('\n')[2]?.trim().replace(/^at\s+/, '') ?? 'unknown';
      scene.traceReplayEvent({
        kind: 'rng', frame: scene.frame,
        data: { source, draw: rngDraws, stageDraw: rngStageDraws, value, seed: scene.rng.seed }
      });
    }
    return value;
  };
}

// Feed decoder: ReplayInputSource is the canonical T8RP word → InputFrame
// mapper (rising edges per button, Z/X dual-mapped to confirm/back — the
// exe's own prev-word compare, FUN_0043fe30 consumers). The old local
// inputBits mapped single buttons with pressed=∅, which suppressed every
// edge-triggered consumer: most visibly the stage-tally shoot-confirm
// (stageClearTimer>90 && pressed), forcing clear-check runs through the
// >900-frame timeout per tally and inflating them by ~2500 frames of
// post-recording economy.
const replayInput = new mod.ReplayInputSource();

const inputs = stage.inputs;
const frames = inputs.length;
// T8RP v6 has no per-frame auxiliary event word, so contacts cannot be
// recovered from the replay image itself. The committed Border-Team fixture
// deliberately contains one native Stage-2 contact followed by a successful
// deathbomb. These checkpoints come from the frame-aligned /proc trace
// (native counter N == sim input N-1). Treating every non-empty hitLog as an
// error both stopped on a correct run and, worse, could not detect a missing
// native contact. Keep this small oracle seed-scoped so alternate replays do
// not inherit fixture-specific outcomes.
// The oracle is replay-mode-only: --clear-check forces player invulnerability
// (below), which suppresses every hitLog entry by construction, so checking
// the native-contact/deathbomb oracle there can only emit a guaranteed-false
// divergence (observed as the bogus "f676 native-player-contact" in the
// 2026-08-25 clear-check run).
const nativePlayerOracle = stageNumber === 2 && !clearCheck && stage.rngSeed === 0x32fb
  ? {
      hits: new Map([[676, {
        kind: 'bullet', ownerSub: 1, spawnFrame: 655, sprite: 1,
        spriteOffset: 2, x: 168.773193359375, y: 129.134521484375,
        deathbombMeter: 27
      }]]),
      checkpoints: new Map([
        // Native counter 697 already exposes the completed rescue plus the
        // cast-tail raw r100 record; counter 698 exposes its first ordinary
        // r101/life39 update. The Web facade counts the authored 250 active
        // callbacks down, while native keeps 250 in param_4 and advances a
        // separate ZunTimer, hence 249 at the second Web checkpoint.
        [696, { hitState: false, bombType: 3, bombs: 1, power: 128, bombTimer: 250,
          attacks: 1, attackRadius: 100, attackDamage: 70 }],
        [697, { hitState: false, bombType: 3, bombs: 1, power: 128, bombTimer: 249,
          attacks: 1, attackRadius: 101, attackDamage: 70 }]
      ])
    }
  : { hits: new Map(), checkpoints: new Map() };
const spawnFrames = [];
const killFrames = [];
let currentFrame = -1;
let stoppedEarly = false;
let observedHitCount = 0;
let playerDivergence = null;
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

let clearedAt = -1;
if (clearCheck) {
  scene.playerObj.invulnFrames = 999999;
  scene.playerObj.bombInvuln = 999999;
}
const simFrameCap = clearCheck ? frames + 20000 : frames;
for (let f = 0; f < simFrameCap; f++) {
  // T8RP v6 already contains one u16 input record per gameplay update.
  // The parallel 30-frame slowdown table records observed presentation FPS;
  // it is telemetry, not a command to discard simulation ticks. Native
  // /proc traces prove counter f == port state after input f-1 even in the
  // stage-2 opening bucket (48 FPS). Skipping four of its first 30 records
  // delayed the ECL/effect clocks, rerolled auto-fire deadlines, and created
  // a false f588 divergence.
  currentFrame = f;
  const word = f < frames ? inputs[f] : 0x1;
  if (clearCheck) {
    scene.playerObj.invulnFrames = 999999;
    scene.playerObj.bombInvuln = 999999;
  }
  scene.update(replayInput.frame(word));
  const newHits = scene.hitLog.slice(observedHitCount);
  observedHitCount = scene.hitLog.length;
  const expectedHit = nativePlayerOracle.hits.get(f);
  if (!playerDivergence && expectedHit) {
    const hit = newHits[0];
    const b = hit?.bullet;
    const exact = newHits.length === 1
      && hit.kind === expectedHit.kind
      && b?.ownerSub === expectedHit.ownerSub
      && b?.spawnFrame === expectedHit.spawnFrame
      && b?.sprite === expectedHit.sprite
      && b?.spriteOffset === expectedHit.spriteOffset
      && Math.abs(b.x - expectedHit.x) < 1e-6
      && Math.abs(b.y - expectedHit.y) < 1e-6
      && scene.playerObj.deathbombMeter === expectedHit.deathbombMeter;
    if (!exact) {
      playerDivergence = {
        replayFrame: f, reason: 'native-player-contact',
        ours: { hits: newHits, deathbombMeter: scene.playerObj.deathbombMeter },
        native: expectedHit
      };
    }
  } else if (!playerDivergence && newHits.length > 0) {
    playerDivergence = {
      replayFrame: f, reason: 'unexpected-player-hit', ours: newHits, native: null
    };
  }
  const playerCheckpoint = nativePlayerOracle.checkpoints.get(f);
  if (!playerDivergence && playerCheckpoint) {
    const attacks = [...scene.bombEngine.activeSlots()];
    const ours = {
      hitState: scene.playerObj.hitState,
      bombType: scene.playerObj.th08BombType,
      bombs: scene.playerObj.bombs,
      power: scene.playerObj.power,
      bombTimer: scene.playerObj.bombTimer,
      attacks: attacks.length,
      attackRadius: attacks[0]?.radiusX,
      attackDamage: attacks[0]?.damage
    };
    const exact = Object.entries(playerCheckpoint).every(([key, value]) => ours[key] === value);
    if (!exact) {
      playerDivergence = {
        replayFrame: f, reason: 'native-player-checkpoint', ours, native: playerCheckpoint
      };
    }
  }
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
  if (clearCheck && scene.stageClear) {
    clearedAt = f;
    break;
  }
  if (!diagnostic && !clearCheck && playerDivergence) {
    stoppedEarly = true;
    break;
  }
}

if (clearCheck) {
  if (clearedAt >= 0) {
    console.log(`clear-check: STAGE ${stageNumber} CLEARED at replay frame ${clearedAt} (recorded length ${frames})`);
    console.log(`clear-check end: score=${scene.score} lives=${scene.playerObj.lives} bombs=${scene.playerObj.bombs} clock=${scene.runState?.clockTime}`);
  } else {
    console.log(`clear-check: STAGE ${stageNumber} NOT CLEARED within ${simFrameCap} frames`);
  }
}

console.log(`replay frames visited: ${currentFrame + 1}/${frames}`);
console.log(`spawns: ${spawnFrames.length} (first at f${spawnFrames[0] ?? '-'}, last at f${spawnFrames.at(-1) ?? '-'})`);
console.log(`kills: ${killFrames.length} (first at f${killFrames[0] ?? '-'})`);
const next = rpy.stages[stageIndex + 1] ?? null;
console.log(`final rng seed: ${scene.rng.seed} (stage draws ${rngStageDraws}; sim counter ${rngDraws}, bootstrap ${rngBootstrapDraws}${next ? `; stage-${next.stage} entry seed 0x${next.rngSeed.toString(16)} = target` : ''})`);
console.log(`end: score=${scene.score} graze=${scene.graze} enemies=${scene.enemies.length} bullets=${scene.enemyBullets.length} player=(${scene.playerObj.x},${scene.playerObj.y}) lives=${scene.playerObj.lives} bombs=${scene.playerObj.bombs}`);
if (scene.runState) {
  console.log(`th08 runState: gauge=${scene.runState.youkaiGauge} clock=${scene.runState.clockTime} orbs=${scene.runState.currentTimeOrbs}/${scene.runState.totalTimeOrbs} pointValue=${scene.runState.pointItemValue} extends=${scene.runState.pointItemExtends}`);
}

// End-of-stage state vs the recorded next-stage entry snapshot (the original
// engine's own ground truth for what this stage must produce). Every field
// is an integral of the whole run — matching them forces near-total
// convergence. PASS requires all fields exact plus the RNG residue.
if (!next) {
  console.log(`end-of-stage: last recorded stage — no next-stage snapshot to compare`);
}
const checks = !next ? [] : [
  ['score', scene.score, stage.scoreAtEnd],
  ['power', scene.playerObj.power, next.power],
  ['lives', scene.playerObj.lives, next.lives],
  ['bombs', scene.playerObj.bombs, next.bombs],
  ['graze', scene.graze, next.graze],
  ['pointItems', scene.pointItems, next.pointItems]
];
if (next && scene.runState) {
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
if (next) {
  let s = stage.rngSeed;
  for (let i = 0; i < 65536; i++) {
    const a = ((s ^ 0x9630) - 0x6553) & 0xffff;
    s = (((a & 0xc000) >> 14) + a * 4) & 0xffff;
    if (s === next.rngSeed) { rngBudget = i + 1; break; }
  }
}
const rngMatch = !next || (rngBudget >= 0 && rngStageDraws % 65536 === rngBudget % 65536);
const ranAllFrames = !stoppedEarly;
let allPass = rngMatch && ranAllFrames && playerDivergence == null;
if (ranAllFrames && next) {
  console.log(`end-of-stage vs native stage-${next.stage} entry:`);
  for (const [name, ours, native] of checks) {
    const ok = ours === native;
    if (!ok) allPass = false;
    console.log(`  ${name}: ours=${ours} native=${native} ${ok ? 'exact' : 'DIFF'}`);
  }
  console.log(`  rng: ours=${rngStageDraws} native≡${rngBudget} (mod 65536) ${rngMatch ? 'exact' : 'DIFF'}`);
} else if (!stoppedEarly) {
  console.log('end-of-stage: no next-stage snapshot (RNG residue not applicable)');
} else {
  console.log(`end-of-stage vs native stage-${next?.stage ?? '?'} entry: NOT REACHED (formal replay stopped at first committed hit)`);
}
console.log(allPass ? `STAGE ${stageNumber} PASS` : `STAGE ${stageNumber} DIVERGED`);
if (scene.hitLog.length > 0) {
  console.log(`player contacts observed: ${scene.hitLog.length} (native fixture expects ${nativePlayerOracle.hits.size})`);
  for (const hit of scene.hitLog) console.log(' ', JSON.stringify(hit));
}
let earliestDivergence = playerDivergence;
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
if (clearCheck) {
  // Contact detection is impossible in this mode (forced invulnerability
  // suppresses every hitLog entry); "none observed" here is NOT convergence.
  // The end-of-stage snapshot diff above is this mode's only signal.
  console.log('clear-check note: player invulnerable — contact oracle disabled; read the end-of-stage diff, not this line.');
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
