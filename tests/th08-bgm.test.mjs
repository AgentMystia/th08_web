import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

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
