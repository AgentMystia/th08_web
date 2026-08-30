// TH08 bullet-probe edge regressions — Th08.exe v1.00d:
//  - FUN_0044a470 (graze, 0x44a4b4-0x44a519) and FUN_0044a230 (killbox)
//    build the BULLET's four probe edges as one extended pos±half[±20]
//    chain each, narrowed by a single fstps, and compare them against the
//    player's stored AABB (+0x3a4 graze / +0x38c hitbox). FUN_00451ce0
//    (player-shot collision) narrows every box edge the same way.
//  - A center-distance test on unrounded f64 values rounds at different
//    places than those edge stores: on the knife edge the two forms
//    disagree, and the exe follows the f32 edge. The cases below were
//    brute-forced real disagreements (graze half 1.4, margin 20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const outDir = 'tests/.build/th08-probe-edges';
mkdirSync(outDir, { recursive: true });
execSync(
  `npx esbuild src/game/stage-scene.ts --bundle --format=esm ` +
  `--outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`
);
const { th08ProbeEdges } = await import(`../${outDir}/stage-scene.mjs`);

const GRAZE_HALF = Math.fround(1.4);

function playerMaxX(px) {
  return Math.fround(px + GRAZE_HALF);
}

// |dx| exceeds hit/2 + grazeHalf + 20 by a fraction of an f64 ulp (the sum
// form says NO graze) yet the single-fstps bullet edge still rounds low
// enough to touch the player's stored max edge (the exe grazes).
const knifeEdges = [
  { px: 111.24872589111328, w: 7.0, bx: 136.1487274169922 },
  { px: 101.54773712158203, w: 3.0, bx: 124.44773864746094 },
  { px: 104.62250518798828, w: 4.0, bx: 128.0225067138672 },
  { px: 87.60832977294922, w: 4.0, bx: 111.00833129882812 },
];

test('TH08 probe edges narrow each edge to f32 before the inclusive compares', () => {
  for (const { px, w, bx } of knifeEdges) {
    const edges = th08ProbeEdges(bx, 200, w, 4, 20);
    const sumForm = Math.abs(bx - px) <= w / 2 + GRAZE_HALF + 20;
    const edgeForm = playerMaxX(px) >= edges.minX;
    assert.equal(sumForm, false, 'fixture must sit past the exact sum boundary');
    assert.equal(edgeForm, true, 'the f32-rounded bullet edge must still touch');
  }
});

test('TH08 probe edges keep the ordinary interior/exterior cases unchanged', () => {
  const inside = th08ProbeEdges(110, 200, 3, 4, 20);
  assert.ok(playerMaxX(100) >= inside.minX);
  const outside = th08ProbeEdges(140, 200, 3, 4, 20);
  assert.ok(playerMaxX(100) < outside.minX);
  // The killbox variant drops the 20px margin entirely (FUN_0044a230).
  const kill = th08ProbeEdges(102, 200, 3, 4, 0);
  assert.ok(playerMaxX(100) >= kill.minX);
});
