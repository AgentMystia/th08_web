// Extracts the vertical-slice runtime surfaces from locally owned TH08 data.
// thanm is a build-time tool; reference/ and extracted originals never ship.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'reference/th08-original');
const imageOut = join(root, 'assets/th08-img');
const sfxOut = join(root, 'assets/sfx/th08');

export const ANM_FILES = [
  'title01', 'player00', 'ascii', 'text', 'front', 'times', 'capture',
  'enemy', 'etama',
  'stg1bg', 'stg1enm', 'stg1txt', 'eff01',
  'stg2bg', 'stg2enm', 'stg2txt', 'eff02',
  'face_rm00', 'face_yk00', 'face_st01', 'face_st01sp', 'face_st02', 'face_st02sp',
  // face_cdbg.anm carries the spell-declaration banner strips (2 sprites,
  // 94x512) used by the player bomb cut-in (Th08.exe FUN_00415d60 loads it
  // as archive id 0xf into the declaration manager at 0x4ea670+0x2634).
  'face_cdbg'
];

function findThanm() {
  const candidates = [
    process.env.TH08_THANM,
    'thanm',
    '/tmp/thtk-1786734539101457666/build/thanm/thanm',
    join(root, 'reference/tools/thanm/thanm')
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-V'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next known build location.
    }
  }
  throw new Error('thanm v8 support is required; set TH08_THANM to the executable');
}

function extractAnmTextures() {
  const thanm = findThanm();
  mkdirSync(imageOut, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'th08-anm-'));
  const collisions = [];
  try {
    for (const name of ANM_FILES) {
      const archive = join(source, `${name}.anm`);
      const work = join(scratch, name);
      mkdirSync(work, { recursive: true });
      execFileSync(thanm, ['-x', '8', archive], { cwd: work, stdio: 'ignore' });
      collectPngs(work, imageOut, collisions);
    }
    for (const raw of ['title00.png', 'select00.png']) {
      cpSync(join(source, raw), join(imageOut, raw));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (collisions.length) {
    throw new Error(`TH08 texture name collisions: ${collisions.join(', ')}`);
  }
}

function collectPngs(from, to, collisions) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(png|jpg)$/i.test(entry.name)) {
        const destination = join(to, basename(path));
        try {
          const existing = statSync(destination);
          const incoming = statSync(path);
          if (existing.size !== incoming.size) {
            collisions.push(`${destination} <- ${path}`);
            continue;
          }
          // Same-size same-name textures have so far been byte-identical global
          // sheets; retain the first extraction and verify in the data test.
        } catch {
          cpSync(path, destination);
        }
      }
    }
  };
  visit(from);
}

function copySfx() {
  mkdirSync(sfxOut, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name.endsWith('.wav')) cpSync(join(source, name), join(sfxOut, name));
  }
}

export function main() {
  extractAnmTextures();
  copySfx();
  console.log(`extracted TH08 images to ${imageOut}`);
  console.log(`extracted TH08 SFX to ${sfxOut}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
