import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// Boss-fight structural audit (diagnostic + regression). Drives the full
// fixture replay per stage and records a phase ledger: every boss-slot
// enemy's ECL sub transitions, spell declarations, damage landing, and the
// live-bullet census during each card. This is the CI oracle for the four
// reported fidelity breaks: Wriggle's last two cards firing nothing, the
// boss Last Spell chain (timeline op-8 handoff to the post-death body),
// and Mystia's cloak-transition invisibility/invulnerability.
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

// Runs the stage, collecting the ledger. Boss-enemy tracking keys on
// ecl.isBoss (ins_127 registration); sub transitions and damage are sampled
// once per frame after update().
function auditStage(stageNumber) {
  const stage = rpy.stages[stageNumber - 1];
  const scene = makeScene(stageNumber, stage);
  const inputs = stage.inputs;
  const ledger = [];
  const spellCards = [];
  const bossTrack = new Map(); // enemy id -> last sub
  let lastSpell = '';
  let lastDialogue = false;
  const bulletCensus = [];
  let damageLanded = new Map(); // enemy id -> frames with hp decrease

  for (let f = 0; f < inputs.length; f++) {
    scene.update(inputBits(inputs[f]));
    const dialogue = scene.isDialogueActive();
    if (dialogue !== lastDialogue) {
      ledger.push({ f, kind: 'dialogue', on: dialogue });
      lastDialogue = dialogue;
    }
    if (scene.spellName !== lastSpell) {
      if (scene.spellName) spellCards.push({ f, name: scene.spellName, maxBullets: 0, start: f, bossHpDrop: 0 });
      lastSpell = scene.spellName;
      ledger.push({ f, kind: 'spell', name: scene.spellName || '(end)' });
    }
    let liveBullets = 0;
    for (const b of scene.enemyBullets) if (b && !b.dead) liveBullets++;
    if (spellCards.length) spellCards[spellCards.length - 1].maxBullets = Math.max(spellCards[spellCards.length - 1].maxBullets, liveBullets);
    if (f % 60 === 0) bulletCensus.push(liveBullets);
    for (const e of scene.enemies) {
      const s = e.ecl;
      if (!s || !s.isBoss) continue;
      const sub = s.ctx?.subId ?? -1;
      const prev = bossTrack.get(e.id);
      const hpDrop = prev != null && e.hp < prev.hp;
      if (hpDrop) damageLanded.set(e.id, (damageLanded.get(e.id) ?? 0) + 1);
      if (prev == null || prev.sub !== sub) {
        ledger.push({
          f, kind: 'phase', id: e.id, sub,
          hp: e.hp, flags: s.th08?.flags ?? 0,
          invisible: s.invisible,
          shot: s.shotCollision, body: s.collisionEnabled, dmg: s.canTakeDamage,
          x: Math.round(e.x), y: Math.round(e.y)
        });
      }
      bossTrack.set(e.id, { sub, hp: e.hp });
      if (spellCards.length && lastSpell) {
        // attribute hp movement on the currently-tracked boss to the live card
        if (hpDrop && prev.sub === sub) spellCards[spellCards.length - 1].bossHpDrop += prev.hp - e.hp;
      }
    }
  }
  return { ledger, spellCards, bulletCensus, damageLanded, frames: inputs.length };
}

test('stage 1 boss: phase chain, cards fire bullets, Last Spell body spawns', () => {
  const { ledger, spellCards, damageLanded } = auditStage(1);
  console.log('=== STAGE 1 LEDGER ===');
  for (const row of ledger) {
    if (row.kind === 'phase') {
      console.log(`f${row.f} phase e${row.id} sub${row.sub} hp=${row.hp} flags=0x${(row.flags >>> 0).toString(16)} inv=${row.invisible ? 1 : 0} gates(sbd)=${row.shot ? 1 : 0}${row.body ? 1 : 0}${row.dmg ? 1 : 0} pos=(${row.x},${row.y})`);
    } else if (row.kind === 'spell') {
      console.log(`f${row.f} spell ${row.name}`);
    } else {
      console.log(`f${row.f} dialogue ${row.on ? 'start' : 'end'}`);
    }
  }
  console.log('=== STAGE 1 CARDS ===');
  for (const c of spellCards) console.log(`f${c.start} "${c.name}" maxBullets=${c.maxBullets} hpDrop=${c.bossHpDrop}`);
  const subs = ledger.filter((r) => r.kind === 'phase').map((r) => r.sub);
  console.log('phase sub sequence:', subs.join(','));
  // Wriggle Lunatic native chain: 26 (non1) 38 (spell1) 33 (non2) 44 (spell2)
  // -> death -> 50 (flourish) -> 37 (Last Spell body) -> 48 (Last Spell).
  assert.ok(subs.includes(26), 'first nonspell sub 26 runs');
  assert.ok(subs.includes(38), 'spell 1 sub 38 runs');
  assert.ok(subs.includes(44), 'spell 2 (second-to-last card) sub 44 runs');
  assert.ok(subs.includes(37), 'Last Spell body sub 37 spawns after the fight');
  assert.ok(subs.includes(48), 'Last Spell card sub 48 runs');
  const firing = spellCards.filter((c) => c.maxBullets > 10);
  assert.ok(firing.length >= 2, `at least two cards emit bullets (got ${spellCards.map((c) => c.maxBullets).join(',')})`);
  assert.ok([...damageLanded.values()].some((n) => n > 10), 'the boss takes player damage');
});

test('stage 2 boss: cloak chain, cards fire bullets, Mystia hittable during spells', () => {
  const { ledger, spellCards, damageLanded } = auditStage(2);
  console.log('=== STAGE 2 LEDGER ===');
  for (const row of ledger) {
    if (row.kind === 'phase') {
      console.log(`f${row.f} phase e${row.id} sub${row.sub} hp=${row.hp} flags=0x${(row.flags >>> 0).toString(16)} inv=${row.invisible ? 1 : 0} gates(sbd)=${row.shot ? 1 : 0}${row.body ? 1 : 0}${row.dmg ? 1 : 0} pos=(${row.x},${row.y})`);
    } else if (row.kind === 'spell') {
      console.log(`f${row.f} spell ${row.name}`);
    } else {
      console.log(`f${row.f} dialogue ${row.on ? 'start' : 'end'}`);
    }
  }
  console.log('=== STAGE 2 CARDS ===');
  for (const c of spellCards) console.log(`f${c.start} "${c.name}" maxBullets=${c.maxBullets} hpDrop=${c.bossHpDrop}`);
  const subs = ledger.filter((r) => r.kind === 'phase').map((r) => r.sub);
  console.log('phase sub sequence:', subs.join(','));
  // Mystia Lunatic native chain: 19 (non1) 23 (spell1) 22 (cloak transition)
  // -> 27 (non2) 38 (HL spell2) 29 (non3) 44 (spell3) 51/52 (spell4)
  // -> 62 (flourish) -> 32 (Last Spell body) -> 58 (Last Spell).
  assert.ok(subs.includes(19), 'first nonspell sub 19 runs');
  assert.ok(subs.includes(23), 'spell 1 sub 23 runs');
  assert.ok(subs.includes(27), 'post-dialogue nonspell sub 27 runs (op-8 handoff)');
  assert.ok(subs.includes(32), 'Last Spell body sub 32 spawns');
  assert.ok(subs.includes(58), 'Last Spell card sub 58 runs');
  const firing = spellCards.filter((c) => c.maxBullets > 10);
  assert.ok(firing.length >= 3, `at least three cards emit bullets (got ${spellCards.map((c) => c.maxBullets).join(',')})`);
  // The cloak-transition fix: after sub 22/27 handoff Mystia must be
  // shootable again (mode-1 death hide cleared by the re-armed phases).
  const bossDamageFrames = [...damageLanded.values()].reduce((a, b) => a + b, 0);
  assert.ok(bossDamageFrames > 100, `boss receives sustained damage (got ${bossDamageFrames} frames)`);
});
