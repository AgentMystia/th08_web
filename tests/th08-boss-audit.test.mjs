import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// Boss-fight structural audit, round 2: clear-check extension (invulnerable
// player, recorded inputs then hold-shoot) so the audit runs the ENTIRE boss
// fight past the recording end, with per-frame boss-state change tracking
// (gates, shield, phase timer, pending interrupt, sub transitions) to pin
// the stage-2 post-dialogue stall and the damage-during-cards question.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

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

function makeScene(stageNumber, stage) {
  const entryScore = stageNumber > 1 ? rpy.stages[stageNumber - 2].scoreAtEnd : 0;
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    stageNumber, null, stage.rngSeed
  );
  scene.mode = 'test';
  scene.rank = stage.rank;
  scene.score = entryScore;
  scene.playerObj.lives = stage.lives;
  scene.playerObj.bombs = stage.bombs;
  scene.playerObj.power = stage.power;
  if (scene.runState) {
    scene.runState.score = entryScore;
    scene.runState.pointItemValue = stage.pointItemValue;
    scene.runState.youkaiGauge = stage.youkaiGauge;
    scene.runState.clockTime = stage.clockTime;
  }
  return scene;
}

function auditStage(stageNumber, extraFrames) {
  const stage = rpy.stages[stageNumber - 1];
  const scene = makeScene(stageNumber, stage);
  const inputs = stage.inputs;
  const frames = inputs.length + extraFrames;
  const log = [];
  const spellCards = [];
  let lastSpell = '';
  let lastDialogue = false;
  const prev = new Map(); // enemy id -> state string
  const dmgFrames = new Map();

  const snap = (e) => {
    const s = e.ecl;
    return {
      sub: s.ctx?.subId ?? -1, hp: e.hp,
      inv: s.invisible ? 1 : 0,
      sbd: `${s.shotCollision ? 1 : 0}${s.collisionEnabled ? 1 : 0}${s.canTakeDamage ? 1 : 0}`,
      shield: s.damageShield ?? 0,
      bt: s.bossTimer ?? 0, tt: s.timerCallbackThreshold ?? -1, ts: s.timerCallbackSub ?? -1,
      pi: s.pendingInterrupt ?? -1,
      f1: (s.th08?.flags ?? 0) >>> 0,
      x: Math.round(e.x), y: Math.round(e.y)
    };
  };
  const key = (p) => `${p.sub}|${p.inv}|${p.sbd}|${p.shield>0?1:0}|${p.tt}|${p.pi}`;

  for (let f = 0; f < frames; f++) {
    scene.playerObj.invulnFrames = 999999;
    scene.playerObj.bombInvuln = 999999;
    const word = f < inputs.length ? inputs[f] : 0x1;
    scene.update(inputBits(word));
    const dialogue = scene.isDialogueActive();
    if (dialogue !== lastDialogue) { log.push(`f${f} dialogue ${dialogue ? 'start' : 'end'}`); lastDialogue = dialogue; }
    if (scene.spellName !== lastSpell) {
      if (scene.spellName) spellCards.push({ f, name: scene.spellName, maxBullets: 0, hpDrop: 0 });
      lastSpell = scene.spellName;
      log.push(`f${f} spell ${scene.spellName || '(end)'}`);
    }
    let liveBullets = 0;
    for (const b of scene.enemyBullets) if (b && !b.dead) liveBullets++;
    if (spellCards.length) {
      const card = spellCards[spellCards.length - 1];
      card.maxBullets = Math.max(card.maxBullets, liveBullets);
    }
    for (const e of scene.enemies) {
      const s = e.ecl;
      if (!s || !s.isBoss) continue;
      const p = snap(e);
      const before = prev.get(e.id);
      if (!before || before.key !== key(p)) {
        log.push(`f${f} e${e.id} sub${p.sub} hp=${p.hp} inv=${p.inv} sbd=${p.sbd} shield=${p.shield} bt=${p.bt} tt=${p.tt}->${p.ts} pi=${p.pi} f1=0x${p.f1.toString(16)} pos=(${p.x},${p.y})`);
      }
      if (before && p.hp < before.p.hp) {
        dmgFrames.set(e.id, (dmgFrames.get(e.id) ?? 0) + 1);
        if (spellCards.length && lastSpell) spellCards[spellCards.length - 1].hpDrop += before.p.hp - p.hp;
      }
      prev.set(e.id, { key: key(p), p });
    }
  }
  return { log, spellCards, dmgFrames };
}

test('stage 1 full boss fight: phases, cards, Last Spell', () => {
  const { log, spellCards, dmgFrames } = auditStage(1, 22000);
  console.log('=== STAGE 1 BOSS LOG ===');
  for (const line of log) console.log(line);
  console.log('=== STAGE 1 CARDS ===');
  for (const c of spellCards) console.log(`f${c.f} "${c.name}" maxBullets=${c.maxBullets} hpDrop=${c.hpDrop}`);
  const subs = [...new Set(log.match(/sub-?\d+/g) ?? [])];
  console.log('sub ids seen:', subs.join(','));
  assert.ok(log.some((l) => / sub38 /.test(l) || / sub38$/.test(l) || l.includes('sub38 ')), 'spell 1 sub 38 runs');
  assert.ok(log.some((l) => l.includes('sub44 ')), 'spell 2 sub 44 runs');
  assert.ok(log.some((l) => l.includes('sub37 ')), 'Last Spell body sub 37 spawns');
  assert.ok(log.some((l) => l.includes('sub48 ')), 'Last Spell card sub 48 runs');
  assert.ok(spellCards.filter((c) => c.maxBullets > 10).length >= 2, 'at least two cards emit bullets');
  assert.ok([...dmgFrames.values()].some((n) => n > 30), 'boss takes sustained damage');
});

test('stage 2 full boss fight: phases, cards, Last Spell', () => {
  const { log, spellCards, dmgFrames } = auditStage(2, 8000);
  console.log('=== STAGE 2 BOSS LOG ===');
  for (const line of log) console.log(line);
  console.log('=== STAGE 2 CARDS ===');
  for (const c of spellCards) console.log(`f${c.f} "${c.name}" maxBullets=${c.maxBullets} hpDrop=${c.hpDrop}`);
  assert.ok(log.some((l) => l.includes('sub27 ')), 'post-dialogue nonspell sub 27 runs');
  assert.ok(log.some((l) => l.includes('sub38 ')), 'spell 2 sub 38 runs');
  assert.ok(log.some((l) => l.includes('sub44 ')), 'spell 3 sub 44 runs');
  assert.ok(log.some((l) => l.includes('sub52 ')), 'spell 4 sub 52 runs');
  assert.ok(log.some((l) => l.includes('sub62 ')), 'final flourish sub 62 runs');
  assert.ok(log.some((l) => l.includes('sub32 ')), 'Last Spell body sub 32 spawns');
  assert.ok(log.some((l) => l.includes('sub58 ')), 'Last Spell card sub 58 runs');
  assert.ok(spellCards.filter((c) => c.maxBullets > 10).length >= 3, 'at least three cards emit bullets');
  assert.ok([...dmgFrames.values()].some((n) => n > 30), 'boss takes sustained damage');
});
