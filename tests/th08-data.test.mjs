import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/data/th08-data.ts src/formats/anm.ts src/formats/sht.ts ' +
  'src/formats/bin.ts --bundle --format=esm --outdir=tests/.build/th08-data ' +
  '--out-extension:.js=.mjs --log-level=silent'
);
const { TH08_DATA } = await import('../tests/.build/th08-data/data/th08-data.mjs');
const { Anm } = await import('../tests/.build/th08-data/formats/anm.mjs');
const { Sht } = await import('../tests/.build/th08-data/formats/sht.mjs');

test('TH08 vertical-slice data embeds Stage 1 and its original scripts', () => {
  assert.deepEqual(Object.keys(TH08_DATA.stages), ['1']);
  const stage = TH08_DATA.stages[1];
  assert.deepEqual(
    [stage.enemyAnm, stage.bulletAnm, stage.bgAnm, stage.effectAnm, stage.stdTxtAnm, stage.faceAnm],
    ['stg1enm', 'etama', 'stg1bg', 'eff01', 'stg1txt', 'face_st01']
  );
  assert.deepEqual(stage.faceAnms, ['face_rm00', 'face_yk00', 'face_st01']);

  const ecl = Buffer.from(stage.ecl, 'base64');
  assert.equal(ecl.readUInt32LE(0), 0x800);
  assert.equal(ecl.readUInt16LE(4), 53);
  assert.equal(ecl.readUInt16LE(6), 2);
});

test('every stripped TH08 ANM resolves its shipped texture', () => {
  const expectedKeys = [
    'title01', 'player00', 'ascii', 'text', 'front', 'times', 'capture',
    'enemy', 'etama', 'stg1bg', 'stg1enm', 'stg1txt', 'eff01',
    'face_rm00', 'face_yk00', 'face_st01', 'face_st01sp'
  ];
  assert.deepEqual(Object.keys(TH08_DATA.anm), expectedKeys);
  const images = new Set(readdirSync('assets/th08-img'));
  for (const [key, encoded] of Object.entries(TH08_DATA.anm)) {
    const anm = new Anm(Buffer.from(encoded, 'base64'), key);
    assert.ok(anm.entries.length > 0, `${key} has entries`);
    assert.ok(anm.entries.every(entry => entry.version === 3), `${key} is ANM v3`);
    for (const entry of anm.entries) {
      if (!entry.imageKey) continue;
      assert.ok(
        images.has(`${entry.imageKey}.png`) || images.has(`${entry.imageKey}.jpg`),
        `${key} texture ${entry.imageKey}`
      );
    }
  }
});

test('Border Team SHTs preserve both focus roles and native movement fields', () => {
  for (const key of ['ply00a', 'ply00as']) {
    const sht = new Sht(Buffer.from(TH08_DATA.sht[key], 'base64'));
    assert.equal(sht.isTh08, true);
    assert.equal(sht.bombPerLife, 3);
    assert.equal(sht.hitbox, Math.fround(1.65));
    assert.equal(sht.speed, 4);
    assert.equal(sht.focusedSpeed, 2);
    assert.equal(sht.diagSpeed, Math.fround(2.828427));
    assert.equal(sht.diagFocusedSpeed, Math.fround(Math.SQRT2));
  }
});

test('TH08 BGM loop table is complete and the slice ships its three tracks', () => {
  assert.equal(TH08_DATA.bgm.length, 21);
  assert.equal(TH08_DATA.bgm[0].name, 'th08_01');
  assert.equal(TH08_DATA.bgm[1].name, 'th08_00');
  assert.equal(TH08_DATA.bgm[2].name, 'th08_03');
  assert.deepEqual(
    TH08_DATA.bgm.slice(0, 3).map(track => [track.loopStartSample, track.totalSamples]),
    [[247472, 3178816], [174976, 5782208], [696320, 3440640]]
  );
  for (const name of ['th08_01', 'th08_00', 'th08_03']) {
    assert.ok(existsSync(`assets/audio/th08/${name}.ogg`), `${name}.ogg`);
  }
});
