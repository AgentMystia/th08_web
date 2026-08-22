// Slices the local Ogg BGM timeline using the original PCM byte table.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'reference');
const outDir = join(root, 'assets/audio/th08');

// The slice ships the title theme plus both Stage 1+2 stage/boss pairs
// (Stage 1: th08_00/th08_03, Stage 2: th08_04/th08_05). Keep the parser aware
// of every track so the data test can lock the complete original loop table.
export const TRACK_WHITELIST = new Set(['th08_01', 'th08_00', 'th08_03', 'th08_04', 'th08_05']);

export function parseThbgmFmt(buf) {
  const tracks = [];
  for (let o = 0; o + 52 <= buf.length; o += 52) {
    if (buf[o] === 0) break;
    const name = buf.toString('latin1', o, o + 16).replace(/\0.*$/, '');
    tracks.push({
      name: name.replace(/\.wav$/i, ''),
      start: buf.readUInt32LE(o + 16),
      checksum: buf.readUInt32LE(o + 20),
      loopStartBytes: buf.readUInt32LE(o + 24),
      lengthBytes: buf.readUInt32LE(o + 28),
      wFormatTag: buf.readUInt16LE(o + 32),
      channels: buf.readUInt16LE(o + 34),
      sampleRate: buf.readUInt32LE(o + 36),
      avgBytesPerSec: buf.readUInt32LE(o + 40),
      blockAlign: buf.readUInt16LE(o + 44),
      bitsPerSample: buf.readUInt16LE(o + 46)
    });
  }
  return tracks;
}

async function main() {
  const { readFileSync } = await import('node:fs');
  const fmt = parseThbgmFmt(readFileSync(join(root, 'reference/th08-original/thbgm.fmt')));
  mkdirSync(outDir, { recursive: true });
  const wav = join(tmpdir(), 'th08-thbgm-full.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(source, 'thbgmogg.dat'), wav]);
  for (const track of fmt) {
    if (!TRACK_WHITELIST.has(track.name)) continue;
    const startSample = Math.floor(track.start / 4);
    const endSample = Math.floor((track.start + track.lengthBytes) / 4);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', wav,
      '-af', `atrim=start_sample=${startSample}:end_sample=${endSample}`,
      '-c:a', 'libvorbis', '-q:a', '6', join(outDir, `${track.name}.ogg`)
    ]);
    console.log(`${track.name}.ogg samples=${endSample - startSample} loop=${Math.floor(track.loopStartBytes / 4)}`);
  }
  rmSync(wav, { force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
