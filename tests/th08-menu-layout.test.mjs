import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-menu-layout.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-menu-layout.mjs --log-level=silent'
);
const {
  TH08_TITLE_ANM_RANGES,
  TH08_CHARACTER_HIGHLIGHT_SCRIPTS,
  titleEntryForScript,
  titleMenuItemLayout,
  difficultyLayout
} = await import('../tests/.build/th08-menu-layout.mjs');

test('title01 global scripts map to their original ANM entries', () => {
  assert.equal(TH08_TITLE_ANM_RANGES.length, 25);
  assert.deepEqual(
    [titleEntryForScript(0), titleEntryForScript(1), titleEntryForScript(119)],
    [
      TH08_TITLE_ANM_RANGES[0],
      TH08_TITLE_ANM_RANGES[1],
      TH08_TITLE_ANM_RANGES[11]
    ]
  );
  assert.throws(() => titleEntryForScript(142));
});

test('nine title items use scripts 1..9 and paired sprite banks', () => {
  const layouts = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(titleMenuItemLayout);
  assert.deepEqual(layouts.map((layout) => layout.scriptId), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(layouts.map((layout) => layout.selectedSprite), [1, 3, 13, 5, 7, 9, 11, 15, 17]);
  assert.ok(layouts.every(({ entryIndex, unselectedSprite, selectedSprite }) =>
    entryIndex === 1 && unselectedSprite === selectedSprite + 1
  ));
});

test('difficulty banners and Border Team highlights use native script ids', () => {
  assert.deepEqual([0, 1, 2, 3].map(difficultyLayout).map((layout) => layout.scriptId), [131, 132, 133, 134]);
  assert.deepEqual(TH08_CHARACTER_HIGHLIGHT_SCRIPTS[0], [0x77, 0x6f, 0x70]);
  assert.equal(titleEntryForScript(0x77).entryIndex, 11);
  assert.equal(titleEntryForScript(0x6f).entryIndex, 3);
  assert.equal(titleEntryForScript(0x70).entryIndex, 4);
});
