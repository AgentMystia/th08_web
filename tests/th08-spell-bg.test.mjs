import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// TH08 spell-card playfield background (FUN_004152a0, all.c:9093-9095): the
// effect manager arms two VMs from the stage's eff0N.anm at spell start —
// archive script indices 0 and 1 — both 384x448 corner-anchored at (32,16),
// fading in over 60 frames, then tile-wrapping their 256x256 texture with
// the authored per-frame op26/27 scroll (eff01: eff01b v+0.008333/frame,
// eff01 v-0.002083/frame). Spell end deletes them outright.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

function makeScene(stageNumber) {
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    stageNumber, null, rpy.stages[stageNumber - 1].rngSeed
  );
  scene.mode = 'test';
  return scene;
}
const idle = () => ({ held: new Set(), pressed: new Set() });

test('stage 1 spell start arms the two authored eff01 sheets', () => {
  const scene = makeScene(1);
  scene.startBossSpell(1, 100000, 1000, 'test');
  const runners = scene.spellBackgroundRunners;
  assert.equal(runners.length, 2);
  // Archive index 0 = entry 0 (eff01b.png), index 1 = entry 1 (eff01.png).
  assert.match(runners[0].spriteFrame().imageKey, /eff01b/);
  assert.match(runners[1].spriteFrame().imageKey, /eff01\.png|eff01$/);
  // Both corner-anchored at (32,16), 384x448 (full playfield).
  for (const runner of runners) {
    const frame = runner.spriteFrame();
    assert.equal(frame.anchorTopLeft, true);
    assert.deepEqual([frame.vmX, frame.vmY, frame.w, frame.h], [32, 16, 384, 448]);
  }
});

test('the sheets fade in over 60 frames and scroll at the authored rates', () => {
  const scene = makeScene(1);
  scene.startBossSpell(1, 100000, 1000, 'test');
  const [fast, slow] = scene.spellBackgroundRunners;
  for (let f = 0; f < 30; f++) scene.update(idle());
  const mid = fast.spriteFrame().alpha;
  assert.ok(mid > 60 && mid < 200, `fade mid-way at 30f (alpha ${mid})`);
  for (let f = 0; f < 60; f++) scene.update(idle());
  assert.equal(fast.spriteFrame().alpha, 255, 'fade complete by ~60-90f');
  // op27 runs once per script frame inside the authored 1-frame loop; the
  // script clock resets each loop, so measure against the update count.
  assert.ok(Math.abs(fast.scrollV - 90 * 0.008333334) < 0.01,
    `eff01b scrolls v+0.008333/frame (got ${fast.scrollV} after 90 updates)`);
  assert.ok(Math.abs(slow.scrollV - 90 * -0.0020833334) < 0.01,
    `eff01 scrolls v-0.002083/frame (got ${slow.scrollV} after 90 updates)`);
});

test('stage 2 arms eff02, and spell end removes both VMs outright', () => {
  const scene = makeScene(2);
  scene.startBossSpell(21, 100000, 1000, 'test');
  assert.match(scene.spellBackgroundRunners[0].spriteFrame().imageKey, /eff02b/);
  assert.match(scene.spellBackgroundRunners[1].spriteFrame().imageKey, /eff02\.png|eff02$/);
  for (let f = 0; f < 70; f++) scene.update(idle());
  scene.endBossSpell();
  assert.equal(scene.spellBackgroundRunners.length, 0);
});

// Boss-fight HUD block (drawBossFightHud): the romaji nameplate from
// face_stNN_name.png's bottom row + the ins_134 phase-deadline countdown,
// while a boss is present. Native reference: userdemo shots n-f2950 /
// ns1-03700 (Wriggle) / ns2-6000 (Mystia). The exact native VM/rect is
// unrecovered in the partial export (§7); the row art + positions come from
// the name-strip texture + the native shots.
function stubRenderer() {
  const calls = { drawImage: [], text: [] };
  const r = {
    image: (key) => (key ? { w: 1 } : null),
    ctx: {
      save() {}, restore() {},
      drawImage: (...a) => calls.drawImage.push(a),
      fillRect() {},
      globalAlpha: 1, fillStyle: '', globalCompositeOperation: ''
    },
    drawSprite() {},
    text: (txt, x, y, opts) => calls.text.push({ txt, x, y, opts })
  };
  return { r, calls };
}

test('the fight nameplate blits the stage romaji row at the playfield top-left', () => {
  const scene = makeScene(1);
  scene.bossActive = { ecl: { timerCallbackThreshold: -1, bossTimer: 0 } };
  const { r, calls } = stubRenderer();
  scene.drawBossFightHud(r);
  assert.equal(calls.drawImage.length, 1, 'one nameplate blit');
});

test('the phase timer counts the armed deadline down in seconds, top-right', () => {
  const scene = makeScene(1);
  scene.bossActive = { ecl: { timerCallbackThreshold: 1800, bossTimer: 300 } };
  const { r, calls } = stubRenderer();
  scene.drawBossFightHud(r);
  const timer = calls.text.find((c) => /^[0-9]+$/.test(c.txt));
  assert.ok(timer, 'timer number drawn');
  assert.equal(timer.txt, '25', 'ceil((1800-300)/60) = 25');
  // No deadline armed -> no timer (nonspell phases before ins_134 arms).
  const none = makeScene(1);
  none.bossActive = { ecl: { timerCallbackThreshold: -1, bossTimer: 0 } };
  const probe = stubRenderer();
  none.drawBossFightHud(probe.r);
  assert.equal(probe.calls.text.filter((c) => /^[0-9]+$/.test(c.txt)).length, 0);
});

test('the declaration ring uses etama3 script-76 strip geometry and releases at spell end', () => {
  const scene = makeScene(1);
  scene.bossActive = { x: 192, y: 96, ecl: { timerCallbackThreshold: -1, bossTimer: 0 } };
  scene.startBossSpell(1, 100000, 1000, 'test');
  assert.deepEqual(scene.spellRing, { x: 192, y: 96 }, 'ring anchored at declaration position');
  scene.spellcard.declAge = 120;
  const slices = [];
  const ctx = {
    save() {}, restore() {}, translate() {}, rotate() {},
    drawImage: (...args) => slices.push(args),
    globalCompositeOperation: '', globalAlpha: 1
  };
  scene.drawSpellRing({ image: (key) => key === 'etama3' ? {} : null, ctx }, 32, 16);
  assert.equal(slices.length, 96, 'six 128px texture repeats, 16 segments each');
  assert.ok(slices.every((args) => args[1] === 0 && args[3] === 16),
    'segments sample etama3 sprite221 x=0 width=16');
  scene.endBossSpell();
  assert.equal(scene.spellRing, null, 'released at spell end');
});

test('enemy declaration art has no invented teal flash and is layered below danmaku', () => {
  const scene = makeScene(1);
  scene.bossActive = { x: 192, y: 96, ecl: { timerCallbackThreshold: -1, bossTimer: 0 } };
  scene.startBossSpell(1, 100000, 1000, 'test');
  scene.spellcard.declAge = 30;
  const fills = [];
  scene.drawSpellDeclaration({
    ctx: { fillRect: (...args) => fills.push(args) },
    drawAnmFrame() {}
  });
  assert.deepEqual(fills, [], 'native f3415..3540 has no teal full-playfield fill');

  const source = readFileSync('src/game/stage-scene.ts', 'utf8');
  const declaration = source.indexOf('this.drawSpellDeclaration(r);');
  const worldRing = source.indexOf('this.drawSpellRing(r, ox, oy);');
  const enemies = source.indexOf("this.markPass('enemies');");
  const bullets = source.indexOf("this.markPass('bullets');");
  assert.ok(declaration >= 0 && declaration < enemies,
    'portrait is drawn before enemies');
  assert.ok(worldRing >= 0 && worldRing < declaration && worldRing < bullets,
    'declaration ring is drawn below danmaku');
  assert.ok(source.indexOf('this.drawSpellOverlay(r);') < bullets,
    'spell name/bonus row is drawn below danmaku');
});

test('spell history excludes the live attempt and commits at spell end', () => {
  const scene = makeScene(1);
  scene.startBossSpell(7, 100000, 1000, 'test');
  assert.deepEqual(scene.spellHistory.get(7), { seen: 0, got: 0 });
  scene.endBossSpell();
  scene.settleTh08CapturedSpell();
  assert.deepEqual(scene.spellHistory.get(7), { seen: 1, got: 1 });
});
