import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadEngine, makeStubAssetsTh08, makeStubAudio } from '../scripts/lib/replay-harness.mjs';

// Draw-path regression locks for the 2026-08-25 boss-fidelity round. The
// headless harness never calls draw(), so the Yukari-bomb crash (the beam
// sprite resolved WITHOUT its entry sprite base — the AnmRunner constructor
// threw "etama: script -62 references missing sprite 225" on the first drawn
// group, ~50 frames after every focused/deathbomb cast) and the authored
// beam fade were invisible to the suite until now.
const mod = await loadEngine();
const rpy = new mod.Rpy(readFileSync('tests/replays/th8_udLy01.rpy'));

const inputBits = (word) => ({
  held: new Set([
    word & 0x1 ? 'shoot' : null,
    word & 0x2 ? 'bomb' : null,
    word & 0x4 ? 'focus' : null
  ].filter(Boolean)),
  pressed: new Set()
});

function makeScene(stageNumber) {
  const stage = rpy.stages[stageNumber - 1];
  const scene = new mod.StageScene(
    makeStubAssetsTh08(mod), makeStubAudio(), rpy.difficulty, rpy.team,
    stageNumber, null, stage.rngSeed
  );
  scene.mode = 'test';
  return scene;
}

test('etama wave/cast scripts resolve into runners with the entry sprite base', () => {
  const etama = new mod.Anm(mod.TH08_DATA.anm.etama, 'etama');
  // The crash site built `new AnmRunner(etama, ref.localId, { entryIndex })`
  // — no spriteIndexOffset. Multi-entry archives key sprites globally as
  // entryBase + embedded id, so the constructor's t0 set-sprite missed.
  for (const script of [0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f]) {
    const runner = mod.archiveScriptRunner(etama, script);
    assert.ok(runner, `archive script ${script} resolves to a runner`);
    const frame = runner.spriteFrame();
    assert.ok(frame, `archive script ${script} has a t0 sprite`);
    assert.equal(frame.w, 16, `script ${script} uses the 16px-wide beam strip`);
    assert.equal(frame.h, 768, `script ${script} uses the full-height beam strip`);
  }
});

test('a focused bomb renders beam visuals through the authored fade and they outlive the machine', () => {
  const scene = makeScene(2);
  scene.playerObj.bombs = 3;
  const drawn = [];
  const stubRenderer = {
    drawAnmFrame(frame, x, y, options) {
      drawn.push({ frame, x, y, options });
      return true;
    }
  };
  let bombEndF = -1;
  let lastDrawF = -1;
  let bombed = false;
  for (let f = 0; f < 340; f++) {
    scene.playerObj.bombs = 3;
    // Hold focus + shoot throughout; press bomb once input unlocks (the
    // stage-opening conversation eats keys).
    let word = 0x5;
    if (!bombed && !scene.isDialogueActive() && f > 30) {
      word |= 0x2;
      bombed = true;
    }
    scene.update(inputBits(word));
    scene.drawTh08BeamVisuals(stubRenderer, 32, 16);
    if (scene.th08Bomb === null && bombEndF < 0 && f > 10) bombEndF = f;
    if (drawn.length) lastDrawF = f;
  }
  assert.ok(drawn.length > 100, `beam groups render (got ${drawn.length} quad draws)`);
  for (const d of drawn) {
    assert.equal(d.frame.imageKey, 'etama3', 'beams draw the etama3 strip');
  }
  // Authored fade-in: the early draws are dim, late draws are bright.
  const early = Math.min(...drawn.slice(0, 6).map((d) => d.frame.alpha));
  const late = Math.max(...drawn.slice(-12).map((d) => d.frame.alpha));
  assert.ok(late > early, `alpha climbs with the authored fade (early ${early} → late ${late})`);
  assert.ok(bombEndF > 0, 'the active machine ends');
  assert.ok(
    lastDrawF > bombEndF,
    `visuals outlive the machine (last draw f${lastDrawF} > end f${bombEndF})`
  );
  assert.equal(scene.th08RetiredBombVisual, null, 'the retired visual hands off cleanly');
});

test('night blindness paints four cover rects plus the rim sprite centered on the player', () => {
  const scene = makeScene(2);
  scene.playerObj.x = 192;
  scene.playerObj.y = 240;
  scene.setNightBlindness(255, 128);
  const rects = [];
  const sprites = [];
  const stubRenderer = {
    ctx: {
      globalAlpha: 1,
      fillStyle: '',
      save() {},
      restore() {},
      fillRect(x, y, w, h) {
        rects.push({ x, y, w, h, alpha: this.globalAlpha, style: this.fillStyle });
      }
    },
    drawAnmFrame(frame, x, y, options) {
      sprites.push({ frame, x, y, options });
      return true;
    }
  };
  scene.drawNightBlindness(stubRenderer, 32, 16);
  // half = 64 * 128/63 ≈ 130.16 around (224,256): all four strips exist.
  assert.equal(rects.length, 4, `four cover rects (got ${rects.length})`);
  for (const r of rects) {
    assert.equal(r.style, '#000', 'cover rects are black');
    assert.equal(r.alpha, 1, 'cover alpha tracks intensity/255');
  }
  const left = rects.find((r) => r.x === 32);
  const right = rects.find((r) => r.x + r.w === 416);
  assert.ok(left && Math.abs(left.w - (224 - 64 * 128 / 63 - 32)) < 0.01, 'left strip ends at the hole edge');
  assert.ok(right && right.w > 0, 'right strip covers to the playfield edge');
  assert.equal(sprites.length, 1, 'one rim sprite');
  const s = sprites[0];
  assert.equal(s.x, 224);
  assert.equal(s.y, 256);
  assert.equal(s.frame.imageKey, 'etama5', 'the radial gradient is etama5.png (script 105)');
  assert.ok(Math.abs(s.options.scaleX - 128 / 63) < 1e-9, 'sprite scales radius/63');
  assert.equal(s.options.alpha, 1);
  // ins_123's clear path switches the effect off.
  scene.setNightBlindness(0, 0);
  assert.equal(scene.nightBlindIntensity, 0);
});
