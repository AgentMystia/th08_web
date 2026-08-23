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
    const word = f < inputs.length ? inputs[f] : 0x5;
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
      if (f % 300 === 0) {
        log.push(`f${f} hb e${e.id} sub=${p.sub} hp=${e.hp} fr=${e.frame} ps=${e.poolSlot} owns=${scene.enemySlots[e.poolSlot] === e} bt=${p.bt} x=${Math.round(e.x)} y=${Math.round(e.y)} dead=${e.dead}`);
      }
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
    // A boss enemy leaving the list entirely (mode-0 removal) or dying.
    for (const [id, snap0] of prev) {
      if (!scene.enemies.some((e) => e.ecl && e.ecl.isBoss && e.id === id && !e.dead)) {
        log.push(`f${f} e${id} LEFT sub=${snap0.p.sub} hp=${snap0.p.hp} inv=${snap0.p.inv} sbd=${snap0.p.sbd} bt=${snap0.p.bt} tt=${snap0.p.tt}`);
        prev.delete(id);
      }
    }
  }
  for (const e of scene.enemies) {
    if (e.ecl && e.ecl.isBoss && !e.dead) {
      const p = snap(e);
      log.push(`END e${e.id} sub=${p.sub} hp=${e.hp} inv=${p.inv} sbd=${p.sbd} bt=${p.bt} tt=${p.tt}`);
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
  console.log('sub transitions seen');
  assert.ok(log.some((l) => / sub38 /.test(l) || / sub38$/.test(l) || l.includes('sub38 ')), 'spell 1 sub 38 runs');
  assert.ok(log.some((l) => l.includes('sub44 ')), 'spell 2 sub 44 runs');
  assert.ok(log.some((l) => l.includes('sub37 ')), 'Last Spell body sub 37 spawns');
  assert.ok(log.some((l) => l.includes('sub48 ')), 'Last Spell card sub 48 runs');
  assert.ok(spellCards.filter((c) => c.maxBullets > 10).length >= 2, 'at least two cards emit bullets');
  assert.ok([...dmgFrames.values()].some((n) => n > 30), 'boss takes sustained damage');
});

test('stage 2 full boss fight: phases, cards, Last Spell', () => {
  const { log, spellCards, dmgFrames } = auditStage(2, 20000);
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


// Round 5: the recorded-input audits above prove the Lunatic chain under
// replay pressure; the user-visible breaks must come from other play
// conditions. Sweep difficulty (E/N/H rows of the same subs) and a bombing
// variant (the user reports the Yukari bomb misbehaving during the last
// cards), both with synthetic focus-fire pressure and no recorded inputs.
function auditSynthetic(stageNumber, difficulty, opts = {}) {
  const stage = rpy.stages[stageNumber - 1];
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), difficulty, rpy.team,
    stageNumber, null, stage.rngSeed
  );
  scene.mode = 'test';
  if (opts.quotaMet) scene.runState.currentTimeOrbs = 99999;
  const log = [];
  const spellCards = [];
  let lastSpell = '';
  const bombEvery = opts.bombEvery ?? 0;
  const frames = opts.frames ?? 30000;
  for (let f = 0; f < frames; f++) {
    if (opts.invuln !== false) {
      scene.playerObj.invulnFrames = 999999;
      scene.playerObj.bombInvuln = 999999;
    }
    let word = 0x5;
    if (bombEvery && f % bombEvery === 0 && f > 4000) word |= 0x2;
    scene.update(inputBits(word));
    if (scene.spellName !== lastSpell) {
      if (scene.spellName) spellCards.push({ f, name: scene.spellName, maxBullets: 0 });
      lastSpell = scene.spellName;
      log.push(`f${f} spell ${scene.spellName || '(end)'}`);
    }
    let liveBullets = 0;
    for (const b of scene.enemyBullets) if (b && !b.dead) liveBullets++;
    if (spellCards.length) spellCards[spellCards.length - 1].maxBullets = Math.max(spellCards[spellCards.length - 1].maxBullets, liveBullets);
    if (f % 3000 === 0) {
      const boss = scene.enemies.find((e) => e.ecl?.isBoss && !e.dead);
      log.push(`f${f} boss=${boss ? `sub${boss.ecl.ctx?.subId} hp=${boss.hp} inv=${boss.ecl.invisible ? 1 : 0}` : 'none'} bullets=${liveBullets}`);
    }
  }
  return { log, spellCards };
}

for (const difficulty of [0, 1, 2]) {
  test(`stage 1 difficulty ${difficulty}: cards fire through the fight`, () => {
    const { log, spellCards } = auditSynthetic(1, difficulty, { frames: 24000 });
    console.log(`=== S1 D${difficulty} ===`);
    for (const l of log) console.log(l);
    for (const c of spellCards) console.log(`card f${c.f} "${c.name}" maxBullets=${c.maxBullets}`);
    const cards = spellCards.filter((c) => c.maxBullets > 10);
    assert.ok(cards.length >= 2, `D${difficulty}: at least two cards emit bullets (got ${spellCards.map((c) => c.maxBullets).join(',')})`);
  });
  test(`stage 2 difficulty ${difficulty}: cards fire and Mystia stays visible after the mid-fight transition`, () => {
    const { log, spellCards } = auditSynthetic(2, difficulty, { frames: 30000 });
    console.log(`=== S2 D${difficulty} ===`);
    for (const l of log) console.log(l);
    for (const c of spellCards) console.log(`card f${c.f} "${c.name}" maxBullets=${c.maxBullets}`);
    const cards = spellCards.filter((c) => c.maxBullets > 10);
    assert.ok(cards.length >= 2, `D${difficulty}: at least two cards emit bullets`);
    assert.ok(!log.some((l) => l.includes('inv=1')), `D${difficulty}: the mode-1 hide latch never sticks`);
  });
}

test('stage 1 Lunatic with periodic bombs: the last two cards still fire', () => {
  const { log, spellCards } = auditSynthetic(1, 3, { frames: 24000, bombEvery: 540 });
  console.log('=== S1 LUNATIC + bombs every 540f ===');
  for (const l of log) console.log(l);
  for (const c of spellCards) console.log(`card f${c.f} "${c.name}" maxBullets=${c.maxBullets}`);
  const cards = spellCards.filter((c) => c.maxBullets > 10);
  assert.ok(cards.length >= 2, `cards emit under bombing (got ${spellCards.map((c) => c.maxBullets).join(',')})`);
});

test('stage 1 Last Spell requires the time quota (var 10098 gate)', () => {
  const met = auditSynthetic(1, 3, { frames: 24000, quotaMet: true });
  const unmet = auditSynthetic(1, 3, { frames: 24000, quotaMet: false });
  const lastCard = (r) => r.spellCards[r.spellCards.length - 1]?.name ?? '';
  console.log('quota met last card:', lastCard(met), '| unmet last card:', lastCard(unmet));
  assert.ok(met.spellCards.length > unmet.spellCards.length, 'quota met plays strictly more cards');
});
