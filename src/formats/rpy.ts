import { BinaryView } from './bin';

// TH07/TH08 replay containers (.rpy, magic "T7RP"/"T8RP"). The TH07 load
// pipeline mirrors Th07.exe FUN_004402d0: decrypt from +0x10, verify its
// additive checksum, then LZSS-decompress at +0x54. TH08 version 6 instead
// carries rawFileSize at +0x0c, decrypts [0x18, rawFileSize) with the byte
// key at +0x15, stores compressed/decompressed sizes in the decrypted raw
// header, and starts the LZSS stream after its two fixed pointer tables at
// +0x68. In both cases the raw header plus decompressed ReplayData form the
// complete image; all stage and slowdown table pointers are image-relative.

const MAGIC = 0x50523754; // "T7RP"
const TH08_MAGIC = 0x50523854; // "T8RP"
const HEADER_SIZE = 0x54;
const TH08_RAW_HEADER_SIZE = 0x68;
const STAGE_SLOTS = 7; // 1-6 + Extra; Phantasm replays use th7_udXXXX slots too
const TH08_STAGE_SLOTS = 9;
const SUBHEADER_SIZE = 0x2c;
// T8RP stage metadata is 0x24 bytes (score..clock at +0x00..+0x22); frame
// records follow immediately. The old 0x40 value came from a block-size
// coincidence (0x40 + 5245*4 exactly fit stage 1) and misread every input.
const TH08_SUBHEADER_SIZE = 0x24;
export const MAX_RPY_BYTES = 16 * 1024 * 1024;

// Bits of the per-frame input word (a verbatim copy of DAT_004afe2c made by
// the recording tick FUN_0043fc40; playback injects it at FUN_0043fe30).
// Directions + shoot come from FUN_0042eab0 and menu code; bomb was pinned
// empirically (rare ~10-frame bursts in the demo replays, absent from a
// no-miss run), focus from the dominance of shoot|focus in a Sakuya score
// run, skip from held stretches spanning dialogue sections. The demo files
// also show a stray bit 0x2000 (one short burst each; unidentified, ignored).
export const RPY_BITS = {
  shoot: 0x0001,
  bomb: 0x0002,
  focus: 0x0004,
  up: 0x0010,
  down: 0x0020,
  left: 0x0040,
  right: 0x0080,
  skip: 0x0100
};

// Bits of the per-frame AUX word (the second u16 of each frame record,
// ctx+0x9e). The exe ORs event bits into it as the frame plays out — the
// recording preserves a per-frame EVENT STREAM of the original run, which
// makes it a frame-exact verification oracle. Every writer below was read at
// its `*(ushort *)(DAT_004afe28 + 0x9e) |= …` site in the decompile and then
// confirmed against our own simulation on already-converged replays:
//
//   0x1  @28486 — BOMB accepted. The site sits inside FUN_0043d9a0's trigger
//        branch, which goes on to set the bomb-active flag (+0x16a20 = 1),
//        arm the post-bomb cooldown (+0x23fc) and call FUN_0042bd01(-1) (the
//        -200 rank penalty). Confirmed: th7_udSg10 (Phantasm) records
//        [10405,27248,37748,50080,50870,51805,56039] and our seven bomb
//        frames are identical. The older "border-adjacent, PROBABLE" reading
//        of this bit was wrong.
//   0x2  @27780/27914 — player contact registered, BEFORE the
//        state/invulnerability outcome gate (a bordered or invulnerable
//        player still sets it).
//   0x4  @28596 — player MISS. The site is the branch where the deathbomb
//        meter (+0x23f8) decrements to zero, i.e. the frame the death is
//        committed — 30 squish frames before the life counter drops.
//        Confirmed: th7_udYo01 stage 2 records [8578] and our death state
//        starts at 8578, while `lives` only falls at 8608. The older
//        mapping had `bomb` on this bit.
//   0x8  @28928 — Supernatural Border START (FUN_0043e890 region).
//        Confirmed exact on all 20 borders of th7_udHm54 and all 8 of the
//        Lunatic fixture's stage 6.
//   0x10 @28994 — border BREAK only: the site is the tail of FUN_0043eb00
//        (32-petal burst, player state 3, 40-frame bomb cooldown). The
//        natural-expiry/cherry-full path FUN_0043e620 writes NO bit, so a
//        survived border must not be counted here. Confirmed: th7_udHm54
//        records [10853,11714] — exactly our two forced breaks — and none of
//        our finishBorderSurvival() ends appear in any file.
//   0x20 @13887/14351/14360 — enemy kill / slot vacate (incl. sweeps).
//   0x40 @22016 — item collected.
//   0x100 @29442 (DAT_00625620, a latched flag consumed each tick at
//        scheduler prio 6; observed as sparse single-tick pulses — 1-3 per
//        stage in the fixture, absent from most files — NOT a dialogue
//        window; setter not visible in the decompile, unidentified).
export const RPY_AUX_BITS = {
  bomb: 0x0001,
  playerHit: 0x0002,
  playerMiss: 0x0004,
  borderStart: 0x0008,
  borderBreak: 0x0010,
  enemyKill: 0x0020,
  itemCollect: 0x0040
};

// Engine frames in a stage's aux stream where the given event bit is set.
//
// `auxOffset` is the recording environment's aux-column alignment: the aux
// word at record index i describes engine tick `i - auxOffset`. Two
// conventions exist in real files (evidence: native Wine+gdb playback traces
// of the SAME patched Th07.exe v1.00b, 2026-07-16):
//
//   offset 1 ("recorder-lagged", the shipped v1.00b loop): the recorder tick
//     (FUN_0043fc40, scheduler priority 16) advances its pointer then writes
//     {input, aux}, while the aux word is cleared at priority 6
//     (FUN_0043fbd0) and event bits are OR'd during world-sim (prio 7-0xf) —
//     record tick t lands in slot t+1, and the input latched at prio 16
//     drives the NEXT tick, so input[i] drives tick i but aux[i] holds tick
//     i-1's events. th7_udYo01: first kill completes during native tick 600
//     (/tmp/yo-kill-native2.log) with the kill bit at record index 601.
//   offset 0 ("recorder-synchronous"): files recorded under a loop with no
//     input latch delay (vpatch-style limiters used by scoreplayers) carry
//     aux[i] describing tick i. th7_udFe25 (golden fixture): first kill
//     completes during native tick 610 (/tmp/fe25-spawn.log, hp 2->0 across
//     frame-BP labels 610->611) with the kill bit at record index 610.
//
// The header carries no marker for this (all known files stamp version
// 0x1100); use detectAuxAlignment() to infer it per stage.
export function auxEventFrames(stage: RpyStage, bit: number, auxOffset = 0): number[] {
  const out: number[] = [];
  // Frame 0's aux word can hold uninitialized heap garbage (0xCDCD in the
  // shipped demo replays) — the context struct is cleared on the first
  // stage tick, not at allocation.
  for (let f = 1; f < stage.auxFlags.length; f++) {
    if (stage.auxFlags[f] & bit) out.push(f - auxOffset);
  }
  return out;
}

// Infers a stage's aux-column alignment (see auxEventFrames) by scoring the
// two candidate offsets against the simulation's own event streams and
// keeping the one with the longer exact leading agreement, summed across
// streams. This is metadata inference, not tolerance: the chosen offset must
// be a single whole-stage constant, the alternative loses by construction on
// any healthy stream (hundreds of events), and a genuine engine-timing
// regression cannot hide in it — a global 1-frame shift would flip the
// detected offset of the committed golden fixture, which the test gate pins
// to 0 (tests/th07-rpy-aux-alignment.test.mjs). Throws when the vote is not
// decisive rather than guessing.
export function detectAuxAlignment(
  stage: RpyStage,
  ourEvents: ReadonlyArray<{ bit: number; frames: ReadonlyArray<number> }>
): { offset: 0 | 1; prefixByOffset: [number, number] } {
  const prefixFor = (offset: 0 | 1): number => {
    let total = 0;
    for (const { bit, frames } of ourEvents) {
      const oracle = auxEventFrames(stage, bit, offset);
      const n = Math.min(oracle.length, frames.length);
      let p = 0;
      while (p < n && oracle[p] === frames[p]) p++;
      total += p;
    }
    return total;
  };
  const prefixByOffset: [number, number] = [prefixFor(0), prefixFor(1)];
  if (prefixByOffset[0] === prefixByOffset[1]) {
    throw new Error(
      `T7RP stage ${stage.stage} aux alignment is ambiguous ` +
        `(exact-prefix score ${prefixByOffset[0]} at both offsets)`
    );
  }
  return { offset: prefixByOffset[0] > prefixByOffset[1] ? 0 : 1, prefixByOffset };
}

export interface RpyStage {
  stage: number; // 1-based table index: 1..6 = stages, 7 = Extra
  offset: number; // absolute image offset of this stage's metadata block
  // TH08 exposes its full 0x40-byte stage snapshot under these names. The
  // compatibility fields below retain TH07's cherry/rank spelling for callers
  // that were written against T7RP.
  score: number;
  pointItemExtends: number;
  nextPointItemExtendThreshold: number;
  pointItemValue: number;
  youkaiGauge: number;
  rank: number;
  character: number;
  clockTime: number;
  // Stage-entry snapshot (+ scoreAtEnd). rngSeed (+0x20) is what
  // FUN_00440480 (all.c:29748) injects into the live RNG (DAT_00495e00) at
  // playback start. The cherry triple was pinned by cross-checking the
  // recorded values against INITIAL_CHERRY_MAX_BY_DIFFICULTY (Lunatic
  // 300000 == stage-1 cherryMax) and the CHERRY_PLUS_MAX=50000 cap the exe
  // enforces on the +0x10 slot; the extend pair matches the point-item
  // ladder (50/125/200/300/450/800+200n) exactly across all six stages of
  // the fixture run.
  scoreAtEnd: number; // +0x00 u32 — score at this stage's END (exe reads the
  // previous block's value for mid-run starts); the last stage's equals the
  // file's global score.
  pointItems: number; // +0x04 u32
  cherry: number; // +0x08 u32
  cherryMax: number; // +0x0C u32
  cherryPlus: number; // +0x10 u32 (≤ 50000)
  graze: number; // +0x14 u32
  extendLevel: number; // +0x18 u32
  extendThreshold: number; // +0x1C u32 — next point-item extend target
  rngSeed: number; // +0x20 u16
  power: number; // +0x22 u8
  lives: number; // +0x23 u8
  bombs: number; // +0x24 u8
  rankByte: number; // +0x25 u8 = DAT_00625884 (16 at run start, climbs; the
  // port's rank model is under review against this evidence)
  powerItemCountForScore: number; // +0x26 u8 — GameManager
  // powerItemCountForScore (ReplayManager.hpp:28), the full-power P-item
  // score-ladder index. 0 in a no-miss run: at full power power drops spawn
  // as cherry items, so the ladder only advances on the rare post-crossing
  // pickup of a pre-conversion power item (or after a miss rebuild).
  spellsCaptured: number; // +0x27 u8 (provisional — trajectory 0/3/7/12/16/21
  // over a Lunatic clear fits captures)
  inputs: Uint16Array; // per-frame input word (first u16 of each 4-byte record)
  inputHigh: Uint16Array; // high word of wide replay input records (TH08)
  auxFlags: Uint16Array; // second u16 (ctx+0x9e; opaque, usually 0)
  // One playback-observed-FPS byte per 30 input frames from the matching
  // +0x38 table block. The raw trailer has one leading recorder byte; native
  // playback reads pointer+1 before advancing, so this array intentionally
  // exposes raw[1..ceil(frames/30)]. Bit 7 is the slowdown marker and the low
  // 7 bits are FPS.
  slowdown: Uint8Array;
}

export const RPY_CHARACTERS = ['reimuA', 'reimuB', 'marisaA', 'marisaB', 'sakuyaA', 'sakuyaB'] as const;
export const RPY_TH08_CHARACTERS = [
  'reimuYukari', 'marisaAlice', 'sakuyaRemilia', 'yuyukoYoumu'
] as const;

export class Rpy {
  version!: number;
  shotByte!: number; // TH07 shot index, or raw TH08 ReplayData shotType
  difficulty!: number; // 0=Easy .. 3=Lunatic, 4=Extra, 5=Phantasm
  date!: string; // "MM/DD"
  name!: string;
  score!: number; // raw internal units; displayed value is ×10
  // Config starting-lives at record time (global header +0x38, the 8th int of
  // the 14-int run-state block FUN_00440480 restores to DAT_0061c254 at
  // playback start; low byte 2-5). Drives the results-screen "Player
  // Penalty" clear-bonus scaling (FUN_00429446: 3 -> x5/10, 4 -> x2/10) and
  // matches the first stage sub-header's lives field in every known file.
  initialLives!: number;
  readonly stages: RpyStage[] = [];
  image!: BinaryView; // decrypted+decompressed full image (debugging)

  constructor(source: string | Uint8Array) {
    const raw = new BinaryView(source);
    if (raw.length > MAX_RPY_BYTES) throw new Error('replay file exceeds 16 MiB safety limit');
    const magic = raw.u32(0);
    if (magic === TH08_MAGIC) {
      this.parseTh08(raw);
      return;
    }
    if (raw.length < HEADER_SIZE || magic !== MAGIC) throw new Error('not a T7RP replay');
    this.version = raw.u16(4);
    if ((this.version & 0xfff) !== 0x100) throw new Error(`unsupported T7RP version 0x${this.version.toString(16)}`);

    const data = raw.bytes.slice();
    let key = data[0x0d];
    for (let i = 0x10; i < data.length; i++) {
      data[i] = (data[i] - key) & 0xff;
      key = (key + 7) & 0xff;
    }
    let sum = 0x3f000318;
    for (let i = 0x0d; i < data.length; i++) sum = (sum + data[i]) >>> 0;
    if (sum !== raw.u32(8)) throw new Error('T7RP checksum mismatch');

    const dec = new BinaryView(data);
    const compSize = dec.u32(0x14);
    const decompSize = dec.u32(0x18);
    if (decompSize > MAX_RPY_BYTES) throw new Error('T7RP decompressed body exceeds 16 MiB safety limit');
    if (HEADER_SIZE + compSize > data.length) throw new Error('T7RP truncated body');
    const image = new Uint8Array(HEADER_SIZE + decompSize);
    image.set(data.subarray(0, HEADER_SIZE));
    lzssDecompress(data.subarray(HEADER_SIZE, HEADER_SIZE + compSize), image.subarray(HEADER_SIZE));
    const v = new BinaryView(image);
    this.image = v;

    this.shotByte = v.u8(HEADER_SIZE + 0x02);
    this.difficulty = v.u8(HEADER_SIZE + 0x03);
    if (this.difficulty > 5) throw new Error(`T7RP difficulty ${this.difficulty} is out of range`);
    this.date = v.cstring(HEADER_SIZE + 0x04);
    this.name = v.cstring(HEADER_SIZE + 0x0a).trim();
    this.score = v.u32(HEADER_SIZE + 0x18);
    this.initialLives = v.u8(HEADER_SIZE + 0x38);

    const inputOffsets: number[] = [];
    const trailerOffsets: number[] = [];
    for (let i = 0; i < STAGE_SLOTS; i++) {
      inputOffsets.push(v.u32(0x1c + i * 4));
      trailerOffsets.push(v.u32(0x38 + i * 4));
    }
    // Stage input blocks are laid out contiguously; each frame stream runs to
    // the next present block. The last one ends where the per-stage slowdown
    // trailers begin (the smallest +0x38-table offset).
    const trailerStart = Math.min(...trailerOffsets.filter((o) => o > 0), v.length);
    const present = inputOffsets
      .map((offset, i) => ({ offset, stage: i + 1 }))
      .filter((s) => s.offset > 0)
      .sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < present.length; i++) {
      const { offset, stage } = present[i];
      const end = i + 1 < present.length ? present[i + 1].offset : trailerStart;
      this.stages.push(parseStage(v, stage, offset, end, this.shotByte));
    }
    this.stages.sort((a, b) => a.stage - b.stage);
    for (const stage of this.stages) {
      const offset = trailerOffsets[stage.stage - 1];
      const length = Math.ceil(stage.inputs.length / 30);
      if (offset <= 0 || offset + 1 + length > v.length) {
        throw new Error(`T7RP stage ${stage.stage} slowdown trailer out of bounds`);
      }
      stage.slowdown = v.bytes.slice(offset + 1, offset + 1 + length);
    }
  }

  get character(): (typeof RPY_CHARACTERS)[number] {
    // The existing engine's character enum predates TH08 teams. Preserve its
    // TH07-compatible primary-character selection; `shotByte` remains the
    // authoritative raw TH08 ReplayData shotType.
    if (this.version === 6) return RPY_CHARACTERS[(this.shotByte & 3) === 3 ? 0 : this.shotByte * 2];
    const table = RPY_CHARACTERS;
    const c = table[this.shotByte];
    if (!c) throw new Error(`replay shot byte ${this.shotByte} out of range`);
    return c;
  }

  get th08Character(): (typeof RPY_TH08_CHARACTERS)[number] {
    const c = RPY_TH08_CHARACTERS[this.shotByte];
    if (!c) throw new Error(`T8RP shotType ${this.shotByte} out of range`);
    return c;
  }

  private parseTh08(raw: BinaryView): void {
    if (raw.length < TH08_RAW_HEADER_SIZE) throw new Error('truncated T8RP replay');
    this.version = raw.u16(4);
    if (this.version !== 6) throw new Error(`unsupported T8RP version ${this.version}`);

    const rawFileSize = raw.u32(0x0c);
    if (rawFileSize < TH08_RAW_HEADER_SIZE || rawFileSize > raw.length) {
      throw new Error(`T8RP invalid raw file size 0x${rawFileSize.toString(16)}`);
    }

    const data = raw.bytes.slice();
    let key = data[0x15];
    for (let i = 0x18; i < rawFileSize; i++) {
      data[i] = (data[i] - key) & 0xff;
      key = (key + 7) & 0xff;
    }
    const dec = new BinaryView(data);
    const compressedSize = dec.u32(0x18);
    const decompSize = dec.u32(0x1c);
    if (decompSize > MAX_RPY_BYTES) throw new Error('T8RP decompressed body exceeds 16 MiB safety limit');
    if (compressedSize > rawFileSize - TH08_RAW_HEADER_SIZE) throw new Error('T8RP truncated compressed body');

    const image = new Uint8Array(TH08_RAW_HEADER_SIZE + decompSize);
    image.set(data.subarray(0, TH08_RAW_HEADER_SIZE));
    const produced = lzssDecompress(
      data.subarray(TH08_RAW_HEADER_SIZE, TH08_RAW_HEADER_SIZE + compressedSize),
      image.subarray(TH08_RAW_HEADER_SIZE)
    );
    if (produced !== decompSize) throw new Error('T8RP decompressed size mismatch');
    const v = this.image = new BinaryView(image);

    const body = TH08_RAW_HEADER_SIZE;
    this.shotByte = v.u8(body + 0x02);
    this.difficulty = v.u8(body + 0x03);
    if (this.difficulty > 4) throw new Error(`T8RP difficulty ${this.difficulty} is out of range`);
    this.date = v.cstring(body + 0x04);
    this.name = v.cstring(body + 0x0a).trim();
    this.score = v.u32(body + 0x48);
    this.initialLives = v.u8(body + 0x5c);

    const inputOffsets: number[] = [];
    const slowdownOffsets: number[] = [];
    for (let i = 0; i < TH08_STAGE_SLOTS; i++) {
      inputOffsets.push(v.u32(0x20 + i * 4));
      slowdownOffsets.push(v.u32(0x44 + i * 4));
    }
    const slowdownStart = Math.min(...slowdownOffsets.filter((o) => o > 0), v.length);
    const present = inputOffsets
      .map((offset, i) => ({ offset, stage: i + 1 }))
      .filter((s) => s.offset > 0)
      .sort((a, b) => a.offset - b.offset);

    for (let i = 0; i < present.length; i++) {
      const { offset, stage } = present[i];
      const end = i + 1 < present.length ? present[i + 1].offset : slowdownStart;
      this.stages.push(this.parseTh08Stage(v, stage, offset, end));
    }
    this.stages.sort((a, b) => a.stage - b.stage);
    for (const stage of this.stages) {
      const offset = slowdownOffsets[stage.stage - 1];
      const length = Math.ceil(stage.inputs.length / 30);
      if (offset <= 0 || offset + 1 + length > v.length) {
        throw new Error(`T8RP stage ${stage.stage} slowdown trailer out of bounds`);
      }
      stage.slowdown = v.bytes.slice(offset + 1, offset + 1 + length);
    }
  }

  private parseTh08Stage(v: BinaryView, stage: number, offset: number, end: number): RpyStage {
    if (offset + TH08_SUBHEADER_SIZE > end || end > v.length) {
      throw new Error(`T8RP stage ${stage} block out of bounds (${offset}..${end})`);
    }
    // Th08.exe v1.00d replay stage blocks are {0x24-byte metadata, then N x
    // u16 input words} — v6 replays have NO per-frame aux word. Evidence:
    // the recorder (FUN_00452310) writes one u16 per frame and the playback
    // feed (FUN_00452550) strides 2; the stage-entry hook starts the record
    // cursor at block+0x24 (all.c:40991). The stride-6 feed FUN_004526c0 is
    // selected only for pre-v6 replay images (all.c:40683-40685). Frame
    // counts cross-validate against the slowdown trailer: one bucket byte
    // per 30 frames + a 1-byte lead (stage 1: 10510 records -> 351 buckets,
    // 352-byte trailer region).
    const frames = Math.floor((end - offset - TH08_SUBHEADER_SIZE) / 2);
    const inputs = new Uint16Array(frames);
    for (let f = 0; f < frames; f++) {
      inputs[f] = v.u16(offset + TH08_SUBHEADER_SIZE + f * 2);
    }
    const inputHigh = new Uint16Array(0);
    const score = v.u32(offset);
    const pointItems = v.u32(offset + 0x04);
    const graze = v.u32(offset + 0x08);
    const pointItemExtends = v.u32(offset + 0x0c);
    const nextPointItemExtendThreshold = v.u32(offset + 0x10);
    const pointItemValue = v.u32(offset + 0x14);
    const youkaiGauge = v.i16(offset + 0x18);
    const rngSeed = v.u16(offset + 0x1a);
    return {
      stage,
      offset,
      score,
      pointItems,
      graze,
      pointItemExtends,
      nextPointItemExtendThreshold,
      pointItemValue,
      youkaiGauge,
      rngSeed,
      power: v.u8(offset + 0x1c),
      lives: v.u8(offset + 0x1d),
      bombs: v.u8(offset + 0x1e),
      rank: v.u8(offset + 0x1f),
      character: v.u8(offset + 0x20),
      clockTime: v.u8(offset + 0x22),
      scoreAtEnd: score,
      cherry: youkaiGauge,
      cherryMax: 0,
      cherryPlus: 0,
      extendLevel: pointItemExtends,
      extendThreshold: nextPointItemExtendThreshold,
      rankByte: v.u8(offset + 0x1f),
      powerItemCountForScore: 0,
      spellsCaptured: 0,
      inputs,
      inputHigh,
      auxFlags: new Uint16Array(0),
      slowdown: new Uint8Array(0)
    };
  }
}

function parseStage(
  v: BinaryView, stage: number, offset: number, end: number, shotByte: number
): RpyStage {
  if (offset + SUBHEADER_SIZE > end || end > v.length) {
    throw new Error(`T7RP stage ${stage} block out of bounds (${offset}..${end})`);
  }
  const frames = Math.floor((end - offset - SUBHEADER_SIZE) / 4);
  const inputs = new Uint16Array(frames);
  const auxFlags = new Uint16Array(frames);
  for (let f = 0; f < frames; f++) {
    inputs[f] = v.u16(offset + SUBHEADER_SIZE + f * 4);
    auxFlags[f] = v.u16(offset + SUBHEADER_SIZE + f * 4 + 2);
  }
  return {
    stage,
    offset,
    score: v.u32(offset),
    scoreAtEnd: v.u32(offset),
    pointItems: v.u32(offset + 0x04),
    cherry: v.u32(offset + 0x08),
    cherryMax: v.u32(offset + 0x0c),
    cherryPlus: v.u32(offset + 0x10),
    graze: v.u32(offset + 0x14),
    pointItemExtends: v.u32(offset + 0x18),
    nextPointItemExtendThreshold: v.u32(offset + 0x1c),
    pointItemValue: 0,
    youkaiGauge: v.u32(offset + 0x08),
    extendLevel: v.u32(offset + 0x18),
    extendThreshold: v.u32(offset + 0x1c),
    rngSeed: v.u16(offset + 0x20),
    power: v.u8(offset + 0x22),
    lives: v.u8(offset + 0x23),
    bombs: v.u8(offset + 0x24),
    rankByte: v.u8(offset + 0x25),
    rank: v.u8(offset + 0x25),
    character: shotByte,
    clockTime: 0,
    powerItemCountForScore: v.u8(offset + 0x26),
    spellsCaptured: v.u8(offset + 0x27),
    inputs,
    inputHigh: new Uint16Array(frames),
    auxFlags,
    slowdown: new Uint8Array(0)
  };
}

// The TH06-era bitstream LZSS ZUN reuses across pak-family formats
// (Th07.exe FUN_00454e50, all.c:42203): 0x2000-byte zero-initialized window
// with the write cursor starting at 1, MSB-first bits, control bit 1 =
// literal (8 bits), 0 = match (13-bit absolute window position, 0 terminates;
// 4-bit length-3). Matches copy from the absolute position wrapping &0x1FFF,
// and everything emitted is also written back into the window.
export function lzssDecompress(src: Uint8Array, dst: Uint8Array): number {
  const win = new Uint8Array(0x2000);
  let wpos = 1;
  let acc = 0;
  let accBits = 0;
  let sp = 0;
  let dp = 0;
  const bits = (n: number): number => {
    while (accBits < n) {
      acc = (acc << 8) | (sp < src.length ? src[sp++] : 0);
      accBits += 8;
    }
    accBits -= n;
    const out = (acc >>> accBits) & ((1 << n) - 1);
    acc &= (1 << accBits) - 1;
    return out;
  };
  while (dp < dst.length) {
    if (bits(1)) {
      const b = bits(8);
      dst[dp++] = b;
      win[wpos] = b;
      wpos = (wpos + 1) & 0x1fff;
    } else {
      const pos = bits(13);
      if (pos === 0) break;
      const len = bits(4) + 3;
      for (let i = 0; i < len && dp < dst.length; i++) {
        const b = win[(pos + i) & 0x1fff];
        dst[dp++] = b;
        win[wpos] = b;
        wpos = (wpos + 1) & 0x1fff;
      }
    }
  }
  return dp;
}
