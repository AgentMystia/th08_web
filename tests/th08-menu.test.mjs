import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-menu.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-menu.mjs --log-level=silent'
);
const { Th08MenuModel, TH08_INPUT_BITS } = await import('../tests/.build/th08-menu.mjs');

function advance(model, frames, input = 0) {
  const events = [];
  for (let i = 0; i < frames; i++) events.push(...model.update(input));
  return events.flat();
}

test('title flow reaches Border Team Stage 1 after native input gates', () => {
  const menu = new Th08MenuModel();
  advance(menu, 8);
  assert.deepEqual(menu.update(TH08_INPUT_BITS.shoot), [
    { type: 'select', screen: 'title', cursor: 0 }
  ]);
  assert.equal(menu.screen, 'difficulty');

  advance(menu, 8);
  assert.deepEqual(menu.update(TH08_INPUT_BITS.down), [
    { type: 'move', screen: 'difficulty', cursor: 2, direction: 1 }
  ]);
  advance(menu, 1);
  assert.deepEqual(menu.update(TH08_INPUT_BITS.enter), [
    { type: 'select', screen: 'difficulty', cursor: 2 }
  ]);
  assert.equal(menu.screen, 'character');

  advance(menu, 8);
  assert.deepEqual(menu.update(TH08_INPUT_BITS.shoot), [
    { type: 'start', difficulty: 2, shotType: 0 }
  ]);
  assert.deepEqual(menu.result, { difficulty: 2, shotType: 0 });
});

test('held menu scrolling waits 30 frames and repeats on eighth frames', () => {
  const menu = new Th08MenuModel();
  advance(menu, 8);
  const moves = advance(menu, 46, TH08_INPUT_BITS.down).filter(e => e.type === 'move');
  assert.deepEqual(moves.map(e => e.cursor), [1, 2, 3]);
});

test('disabled title items emit a denied event without inventing submenus', () => {
  const menu = new Th08MenuModel();
  advance(menu, 8);
  advance(menu, 1, TH08_INPUT_BITS.down);
  advance(menu, 1);
  assert.deepEqual(menu.update(TH08_INPUT_BITS.shoot), [
    { type: 'denied', screen: 'title', cursor: 1 }
  ]);
  assert.equal(menu.screen, 'title');
});

test('the Replay entry opens the replay picker and stays on the title screen state', () => {
  const menu = new Th08MenuModel();
  advance(menu, 8);
  for (let i = 0; i < 4; i++) {
    advance(menu, 1, TH08_INPUT_BITS.down);
    advance(menu, 1);
  }
  assert.equal(menu.cursor, 4);
  assert.deepEqual(menu.update(TH08_INPUT_BITS.shoot), [{ type: 'replay' }]);
  // The model itself does not change screens — the host swaps in the picker.
  assert.equal(menu.screen, 'title');
});
