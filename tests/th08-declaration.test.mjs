import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeStubAssetsTh08 } from '../scripts/lib/replay-harness.mjs';

// TH08 player spell-card declaration (bomb cut-in) — Th08.exe FUN_00415d60
// via the cast helper FUN_0040be30. Pins the rdata spell-name table, the
// side/face-file selector, the deathbomb banner variant, and the name VM's
// bomb-end interrupt release.
const mod = await loadEngine();
const { anms } = makeStubAssetsTh08(mod);
const { Th08SpellDeclaration, th08BombSpellName } = mod;
const cdbg = new mod.Anm(mod.TH08_DATA.anm.face_cdbg, 'face_cdbg');

test('archive script indices resolve like FUN_004069f0 (file-order table)', () => {
  const { archiveScript } = mod;
  // etama: entry 0 holds 25 scripts, so index 37 (the shot-impact spark,
  // DAT_004c6d30 effect 5) is entry 1's 13th on-disk script (id -113);
  // index 38 = effect 6 (the bomb orb-release flash).
  const etama = anms.etama;
  assert.deepEqual(archiveScript(etama, 37), { entryIndex: 1, localId: etama.entries[1].scriptIds[12] });
  assert.deepEqual(archiveScript(etama, 38), { entryIndex: 1, localId: etama.entries[1].scriptIds[13] });
  assert.deepEqual(archiveScript(cdbg, 0), { entryIndex: 0, localId: cdbg.entries[0].scriptIds[0] });
  assert.throws(() => archiveScript(etama, 1000));
});

test('bomb spell names are the rdata strings (0x4b43a0 family)', () => {
  assert.equal(th08BombSpellName(0), '霊符「夢想妙珠」'); // 0x4b43a0
  assert.equal(th08BombSpellName(1), '境符「四重結界」'); // 0x4b44f4
  assert.equal(th08BombSpellName(2), '神霊「夢想封印　瞬」'); // 0x4b43bc
  assert.equal(th08BombSpellName(3), '境界「永夜四重結界」'); // 0x4b4508
});

test('face_cdbg.anm is embedded with its two banner sprites', () => {
  assert.equal(cdbg.entries.length, 1);
  assert.ok(cdbg.sprites.has(0) && cdbg.sprites.has(1));
  // The archive script table: index 0/2 are the player-bomb banner pair
  // (FUN_00415d60 spawns 0x668/0xbb0 with scripts 0 and 2).
  const ids = cdbg.entries[0].scriptIds;
  assert.equal(ids.length, 4);
});

function makeDecl(type) {
  const selector = type & 1;
  return {
    face: (type & 1) === 0 ? anms.face_rm00 : anms.face_yk00,
    decl: new Th08SpellDeclaration(
      { face: (type & 1) === 0 ? anms.face_rm00 : anms.face_yk00, cdbg, text: anms.text },
      selector,
      th08BombSpellName(type),
      type >= 2
    )
  };
}

test('portrait sweep: slides up from (48,144) and self-removes at 150', () => {
  const { decl } = makeDecl(0);
  let y0 = null;
  for (let i = 0; i < 150; i++) {
    decl.update(1);
    const frame = decl.face.spriteFrame();
    if (i === 20) y0 = frame.vmY;
    if (i === 149) assert.ok(frame == null || frame.alpha < 20, `portrait faded by 150 (alpha ${frame?.alpha})`);
  }
  assert.ok(y0 < 144, `portrait must climb (y=${y0})`);
  decl.update(1);
  assert.equal(decl.face.spriteFrame(), null, 'portrait removed at 150');
});

test('rotated banner band spans the playfield mid at hold, releases by 160', () => {
  const { decl } = makeDecl(0);
  for (let i = 0; i < 70; i++) decl.update(1);
  const band = decl.banner2.spriteFrame();
  // face_cdbg script 2: 94x512 strip rotated -pi/2 around (224,~270) —
  // a full-width ~94px band.
  assert.ok(band, 'banner2 visible during hold');
  assert.equal(Math.round(band.w), 94);
  assert.ok(Math.abs(band.rotation + Math.PI / 2) < 0.01, `rotation ${band.rotation}`);
  assert.ok(band.alpha > 200, `band fully faded in (alpha ${band.alpha})`);
  for (let i = 0; i < 95; i++) decl.update(1);
  // The bounded release (the authored hold loop resets its own counter, so
  // the port releases at 100 with the authored 50-frame fade).
  assert.ok(decl.banner2.spriteFrame() == null || decl.banner2.spriteFrame().alpha === 0,
    'banner released by 165');
});

test('name VM waits at label 1 and the bomb-end interrupt releases it', () => {
  const { decl } = makeDecl(1);
  for (let i = 0; i < 140; i++) decl.update(1);
  const waiting = decl.name.spriteFrame();
  assert.ok(waiting, 'name visible while waiting');
  // text.anm script 4 parks at ins_21(1) at t=130 — FUN_00416130 writes the
  // name VM's +0x1fe on bomb end; the port mirrors with interrupt(1).
  for (let i = 0; i < 100; i++) decl.update(1);
  assert.ok(decl.name.spriteFrame(), 'name still waiting without the interrupt');
  decl.end();
  for (let i = 0; i < 40; i++) decl.update(1);
  assert.equal(decl.name.spriteFrame(), null, 'name removed after the release');
});

test('deathbomb binding selects the red banner variant (sprite 1)', () => {
  const normal = makeDecl(0).decl;
  const death = makeDecl(2).decl;
  for (const d of [normal, death]) for (let i = 0; i < 60; i++) d.update(1);
  const n = normal.banner1.spriteFrame();
  const d = death.banner1.spriteFrame();
  assert.equal(n.x, 1, 'normal variant reads sprite 0 (tex x=1)');
  assert.equal(d.x, 97, 'deathbomb variant reads sprite 1 (tex x=97)');
});
