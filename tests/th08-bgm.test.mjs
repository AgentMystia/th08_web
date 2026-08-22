import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync('tests/.build', { recursive: true });
execSync('npx esbuild src/game/bgm.ts --bundle --format=esm --outfile=tests/.build/bgm.mjs --log-level=silent');
const { stageBgmTrack, stageBgmTracks } = await import('../tests/.build/bgm.mjs');

test('TH08 stage-local BGM slots map to the original stage/boss track pairs', () => {
  assert.deepEqual([...stageBgmTracks(1)], ['th08_00', 'th08_03']);
  assert.deepEqual([...stageBgmTracks(2)], ['th08_04', 'th08_05']);
  assert.deepEqual([...stageBgmTracks(6)], ['th08_13', 'th08_14']);
  assert.deepEqual([...stageBgmTracks(7)], ['th08_18', 'th08_19']);
});

test('MSG op 7 slot 1 selects each stage boss theme', () => {
  for (let stage = 1; stage <= 7; stage++) {
    assert.equal(stageBgmTrack(stage, 1), stageBgmTracks(stage)[1]);
  }
  assert.equal(stageBgmTrack(1, -1), null);
  assert.equal(stageBgmTrack(1, 2), null);
});

// Ship-safety lock: the slice's runtime tracks must actually exist as audio
// files. Stage 2 requested th08_04/th08_05 while only the stage-1 pair
// shipped, and the parity fallback in audio.ts silently replayed the entire
// Stage 1 score over Stage 2 (the reported wrong-BGM bug).
test('every title/stage/boss track of the Stage 1+2 slice ships as an ogg', () => {
  const shipped = new Set(['th08_01']);
  for (const stage of [1, 2]) for (const track of stageBgmTracks(stage)) shipped.add(track);
  for (const track of shipped) {
    assert.ok(
      existsSync(join('assets/audio/th08', `${track}.ogg`)),
      `assets/audio/th08/${track}.ogg is missing — the runtime parity fallback would substitute the wrong BGM`
    );
  }
});
