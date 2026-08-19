import { BinaryView } from './bin';

// TH08 replay container (.rpy, magic "T8RP"). The load pipeline mirrors
// Th08.exe: version 6 carries rawFileSize at +0x0c, decrypts
// [0x18, rawFileSize) with the byte key at +0x15, stores compressed/
// decompressed sizes in the decrypted raw header, and starts the LZSS
// stream after its two fixed pointer tables at +0x68. The raw header plus
// decompressed ReplayData form the complete image; all stage and slowdown
// table pointers are image-relative.

const TH08_MAGIC = 0x50523854; // "T8RP"
const TH08_RAW_HEADER_SIZE = 0x68;
const TH08_STAGE_SLOTS = 9;
// T8RP stage metadata is 0x24 bytes (score..clock at +0x00..+0x22); frame
// records follow immediately. The old 0x40 value came from a block-size
// coincidence (0x40 + 5245*4 exactly fit stage 1) and misread every input.
const TH08_SUBHEADER_SIZE = 0x24;
export const MAX_RPY_BYTES = 16 * 1024 * 1024;

// Bits of the per-frame input word (a verbatim copy of the recording tick's
// DirectInput mask). Directions + shoot come from the input mapper and menu
// code; Z = shoot+confirm and X = bomb+back share physical keys.
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

export interface RpyStage {
  stage: number; // 1-based table index: 1..6 = stages, 7+ = Extra/final
  offset: number; // absolute image offset of this stage's metadata block
  scoreAtEnd: number; // +0x00 u32
  pointItems: number; // +0x04 u32
  graze: number; // +0x08 u32
  pointItemExtends: number;
  nextPointItemExtendThreshold: number;
  pointItemValue: number;
  youkaiGauge: number;
  rank: number;
  team: number;
  clockTime: number;
  rngSeed: number; // +0x1a u16
  power: number; // +0x1c u8
  lives: number; // +0x1d u8
  bombs: number; // +0x1e u8
  inputs: Uint16Array; // per-frame input word (one u16 per frame)
  // One playback-observed-FPS byte per 30 input frames from the matching
  // slowdown table block. The raw trailer has one leading recorder byte;
  // native playback reads pointer+1 before advancing, so this array
  // intentionally exposes raw[1..ceil(frames/30)]. Bit 7 is the slowdown
  // marker and the low 7 bits are FPS.
  slowdown: Uint8Array;
}

export const RPY_TH08_TEAMS = [
  'reimuYukari', 'marisaAlice', 'sakuyaRemilia', 'yuyukoYoumu'
] as const;

export class Rpy {
  version!: number;
  shotType!: number; // raw TH08 ReplayData shot/team selector
  difficulty!: number; // 0=Easy .. 3=Lunatic, 4=Extra
  date!: string; // "MM/DD"
  name!: string;
  score!: number; // raw internal units; displayed value is ×10
  // Config starting-lives at record time (global header +0x5c). Matches the
  // first stage sub-header's lives field in every known file.
  initialLives!: number;
  readonly stages: RpyStage[] = [];
  image!: BinaryView; // decrypted+decompressed full image (debugging)

  constructor(source: string | Uint8Array) {
    const raw = new BinaryView(source);
    if (raw.length > MAX_RPY_BYTES) throw new Error('replay file exceeds 16 MiB safety limit');
    if (raw.u32(0) !== TH08_MAGIC) throw new Error('not a T8RP replay');
    this.parseTh08(raw);
  }

  get team(): (typeof RPY_TH08_TEAMS)[number] {
    const team = RPY_TH08_TEAMS[this.shotType];
    if (!team) throw new Error(`T8RP shotType ${this.shotType} out of range`);
    return team;
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
    this.shotType = v.u8(body + 0x02);
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
    // per 30 frames + a 1-byte lead (stage 1: 10504 records -> 351 buckets,
    // 352-byte trailer region).
    const frames = Math.floor((end - offset - TH08_SUBHEADER_SIZE) / 2);
    const inputs = new Uint16Array(frames);
    for (let f = 0; f < frames; f++) {
      inputs[f] = v.u16(offset + TH08_SUBHEADER_SIZE + f * 2);
    }
    const scoreAtEnd = v.u32(offset);
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
      scoreAtEnd,
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
      team: v.u8(offset + 0x20),
      clockTime: v.u8(offset + 0x22),
      inputs,
      slowdown: new Uint8Array(0)
    };
  }
}

// T8RP's bitstream LZSS decoder uses a 0x2000-byte zero-initialized window
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
