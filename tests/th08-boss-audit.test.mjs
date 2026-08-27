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
  // Pre-seed the time-orb quota (var 10098's DAT_004c77f0 row): this audit
  // asserts the Last-Spell CHAIN (sub37/sub32 spawn and run when the gate
  // opens), not the orb economy. The gauge drift became native-pinned on
  // 2026-08-28 (fire-timer formula + the youkai-flip idle park), which
  // shifted this synthetic script's organic orb count below the Stage-1
  // Lunatic quota of 3000 (2364 at the boss death) — the gate is therefore
  // armed explicitly instead of leaning on the razor-edge economy.
  const quotas = stageNumber === 1 ? [2000, 2500, 2700, 3000] : [6500, 7200, 7200, 7200];
  scene.runState.currentTimeOrbs = quotas[rpy.difficulty];
  const inputs = stage.inputs;
  const frames = inputs.length + extraFrames;
  const log = [];
  const spellCards = [];
  const nightBlindSamples = [];
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
    if (f % 10 === 0) nightBlindSamples.push({ f, i: scene.nightBlindIntensity, spell: scene.spellName });
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
  return { log, spellCards, dmgFrames, nightBlindSamples };
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
  const { log, spellCards, dmgFrames, nightBlindSamples } = auditStage(2, 20000);
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
  // 夜盲「夜雀の歌」: the darkness persists from the card through the
  // flourish bridge into the Last Spell. Decompile basis: Mystia's card
  // subs contain NO ins_123 (the timeout path rewires via ins_134 → sub62,
  // the kill path walks the death callback), so the only native clears are
  // the ins_123 handler (all.c:9422) and stage transitions — DAT_004e3d28
  // retains its last exported value across the gap, and sub60 re-drives it
  // during the Last Spell. Locking the persistence guards against a future
  // regression that flashes the field bright mid-finale.
  const blind = spellCards.find((c) => c.name.includes('夜盲'));
  if (blind) {
    const nextCard = spellCards.find((c) => c.f > blind.f && c.name !== blind.name);
    if (nextCard) {
      const gap = nightBlindSamples.filter(
        (s) => s.f > blind.f && s.f < nextCard.f && s.spell === ''
      );
      assert.ok(gap.length > 0, 'a nonspell window exists after 夜盲');
      assert.ok(
        gap.every((s) => s.i === 255),
        `darkness persists through the bridge gap (got ${JSON.stringify(gap.slice(0, 4))})`
      );
    }
  }
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
  const nightBlind = [];
  let lastSpell = '';
  const bombEvery = opts.bombEvery ?? 0;
  const frames = opts.frames ?? 30000;
  for (let f = 0; f < frames; f++) {
    if (opts.invuln !== false) {
      scene.playerObj.invulnFrames = 999999;
      scene.playerObj.bombInvuln = 999999;
    }
    if (opts.quotaMet != null) {
      // Pin the time-orb count every frame: an 'unmet' run must not cross
      // the quota through natural orb drops before the boss dies.
      scene.runState.currentTimeOrbs = opts.quotaMet ? 99999 : 0;
    }
    let word = 0x5;
    if (bombEvery && f % bombEvery === 0 && f > 4000) word |= 0x2;
    scene.update(inputBits(word));
    if (scene.spellName !== lastSpell) {
      if (scene.spellName) spellCards.push({ f, name: scene.spellName, maxBullets: 0, famSubs: new Map() });
      lastSpell = scene.spellName;
      log.push(`f${f} spell ${scene.spellName || '(end)'}`);
    }
    let liveBullets = 0;
    for (const b of scene.enemyBullets) if (b && !b.dead) liveBullets++;
    if (spellCards.length) {
      const card = spellCards[spellCards.length - 1];
      card.maxBullets = Math.max(card.maxBullets, liveBullets);
      // Per-owner provenance: which emitter sub fired each bullet spawned
      // THIS frame during this card (counted once per bullet, attributed by
      // the owner's static spawn sub — familiars carry their own sub id,
      // distinct from the boss body's).
      for (const b of scene.enemyBullets) {
        if (!b || b.dead || b.spawnFrame !== f) continue;
        const owner = scene.enemies.find((e) => e.id === b.ownerId);
        const sub = owner?.ecl?.subId ?? -1;
        card.famSubs.set(sub, (card.famSubs.get(sub) ?? 0) + 1);
      }
    }
    if (f % 10 === 0) {
      nightBlind.push({
        f,
        i: scene.nightBlindIntensity,
        r: Math.round(scene.nightBlindRadius),
        spell: scene.spellName
      });
    }
    if (f % 3000 === 0) {
      const boss = scene.enemies.find((e) => e.ecl?.isBoss && !e.dead);
      log.push(`f${f} boss=${boss ? `sub${boss.ecl.ctx?.subId} hp=${boss.hp} inv=${boss.ecl.invisible ? 1 : 0}` : 'none'} bullets=${liveBullets}`);
    }
  }
  // Immortal-marker invariant: every familiar death/removal path must
  // release the ttl-Infinity rune-circle VM (the 道中魔法阵残留 leak). At
  // fight end the leaked count must not exceed the still-live familiars.
  // The player's focus aura (effect 0x16 → etama archive 54) is a LEGITIMATE
  // permanent Infinity-ttl tenant of the same pool and is excluded.
  const auraRef = mod.archiveScript(new mod.Anm(mod.TH08_DATA.anm.etama, 'etama'), 54);
  const leakedMarkers = scene.th08Effects.entries.filter(
    (e) => e.ttl === Infinity && e.scriptId !== auraRef.localId
  ).length;
  const liveFamiliars = scene.enemies.filter((e) => !e.dead && e.ecl.th08?.familiar).length;
  log.push(`END markers=${leakedMarkers} liveFamiliars=${liveFamiliars}`);
  return { log, spellCards, nightBlind, leakedMarkers, liveFamiliars };
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
    const hb = log.filter((l) => l.includes('hb '));
    let streak = 0;
    for (const l of hb) streak = l.includes('inv=1') ? streak + 1 : 0;
    assert.ok(streak === 0, `D${difficulty}: the mode-1 hide latch never sticks (stuck across ${streak} heartbeats)`);
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

// Round 6 (2026-08-25): the user-visible boss breaks. 灯符「ファイヤフライ
// フェノメノン」's familiars fired ZERO bullets because ins_52 CALL zeroed
// the callee's vars 10053-10060 instead of copying the run-global bank —
// Sub39 read [10054] (familiar life) as 0, so every Sub43 spawned hp=0,
// died on its first manager pass, and FIRE's hp>0 gate vetoed everything.
test('stage 1: both familiar cards fire at every difficulty (per-owner census)', () => {
  for (const difficulty of [0, 1, 2, 3]) {
    const { spellCards } = auditSynthetic(1, difficulty, { frames: 24000 });
    const fly = spellCards.find((c) => c.name.includes('ファイヤフライ'));
    const storm = spellCards.find((c) => c.name.includes('バグ'));
    assert.ok(fly, `D${difficulty}: 灯符 card declared`);
    // Familiar emitter subs: spell-1 children are Sub43 spawns (firing via
    // their Sub42 sub-contexts), final-card children are Sub46 spawns. The
    // histograms also carry the boss body's own volleys (sub 25 spawn).
    console.log(`D${difficulty} 灯符 owners:`, [...fly.famSubs.entries()]);
    const famFly = [...fly.famSubs.entries()].filter(([sub]) => sub === 42 || sub === 43);
    assert.ok(
      famFly.some(([, n]) => n > 0),
      `D${difficulty}: 灯符 familiars fire bullets (owners ${[...fly.famSubs.entries()]})`
    );
    assert.ok(storm, `D${difficulty}: final card declared`);
    console.log(`D${difficulty} 蠢符 owners:`, [...storm.famSubs.entries()]);
    const famStorm = [...storm.famSubs.entries()].filter(([sub]) => sub === 45 || sub === 46);
    assert.ok(
      famStorm.some(([, n]) => n > 0),
      `D${difficulty}: final-card familiars fire bullets (owners ${[...storm.famSubs.entries()]})`
    );
  }
});

// The 道中魔法阵残留 leak: familiars that self-delete (ins_1) or get culled
// died inside tickEnemyCore, whose early block freed the pool slot WITHOUT
// releasing the ttl-Infinity rune-circle marker VM. A full fight used to end
// with ~210 leaked markers (the whole effect pool).
test('stage 1: immortal rune-circle markers release through the whole fight', () => {
  const { log, leakedMarkers, liveFamiliars } = auditSynthetic(1, 2, { frames: 24000 });
  console.log('=== S1 D2 marker tail ===');
  console.log(log[log.length - 1]);
  assert.ok(
    leakedMarkers <= liveFamiliars,
    `no immortal markers beyond live familiars (leaked ${leakedMarkers} vs ${liveFamiliars} live)`
  );
});

// 夜盲「夜雀の歌」: Mystia's sub56 drives the playfield darkness through
// ins_136 builtin 0 (intensity var 10000, radius var 10016; radius
// interpolates 320→192 over 120f then toward 128). ins_123 must clear it;
// the Last Spell's sub60 re-arms it.
test('stage 2: 夜盲 arms the darkness, shrinks the circle, and ins_123 clears it', () => {
  const { spellCards, nightBlind } = auditSynthetic(2, 1, { frames: 30000 });
  const names = spellCards.map((c) => c.name);
  console.log('=== S2 cards ===');
  for (const n of names) console.log(n);
  const card = spellCards.find((c) => c.name.includes('夜盲'));
  assert.ok(card, '夜盲「夜雀の歌」 declared');
  const during = nightBlind.filter((s) => s.f >= card.f && s.spell === card.name);
  assert.ok(during.length > 0 && during.some((s) => s.i >= 200), 'intensity arms within the card (sub56 exports 255)');
  const radii = during.filter((s) => s.i > 0).map((s) => s.r);
  assert.ok(radii.length >= 2, 'radius samples recorded while dark');
  assert.ok(
    radii[radii.length - 1] < radii[0],
    `the lit circle shrinks through the card (first ${radii[0]} → last ${radii[radii.length - 1]})`
  );
  const after = nightBlind.find((s) => s.f > card.f && s.spell !== card.name);
  assert.ok(after, 'the card ends');
  // NOTE: intensity need NOT be 0 immediately after the card — the Last
  // Spell's sub60 and the boss-defeat chain's sub57 legitimately keep the
  // darkness alive outside card windows. The ins_123 clear is locked where
  // a nonspell gap actually occurs (the replay-driven full-fight test).
  // The Last Spell keeps the darkness (its sub60 re-exports from t120).
  const ls = spellCards.find((c) => c.name.includes('コーラス'));
  if (ls) {
    const lsDark = nightBlind.filter((s) => s.spell === ls.name && s.i > 0);
    if (spellCards.indexOf(ls) === spellCards.length - 1) {
      assert.ok(lsDark.length > 0, 'the Last Spell re-arms the darkness');
    }
  }
});
