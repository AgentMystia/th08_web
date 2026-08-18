import { BinaryView } from './bin';

// TH08 ECL container: a raw u32 magic 0x0800 prefixes the header
// {u16 subCount, u16 timelineCount, u32 offsets[16 timeline slots + subs]}
// at +4. Timeline v2 entries are {i32 time, u16 op, u8 size, u8 rank}. Sub
// instructions have a 12-byte header ({u32 time, u16 id, u16 size, u16
// rank<<8, u16 paramMask}) and time==0xffffffff sentinels. (The TH07
// headerless v1 container and its i16 timeline layout are deleted with the
// TH07 engine path.)

export const TIMELINE_SLOTS = 16;
const TH08_MAGIC = 0x0800;

export interface EclInstr {
  time: number;
  id: number;
  size: number;
  rankMask: number; // upper byte of the raw field; bit per difficulty
  paramMask: number;
  args: number; // absolute offset of the argument block
  offset: number; // absolute offset of the instruction (for jumps)
}

export interface TimelineEvent {
  time: number;
  arg0: number; // sub id for spawn ops, raw first arg otherwise
  op: number;
  size: number;
  rank?: number;
  // Spawn events: position + life/item/score as i32s. TH08 spawn ops are
  // 0-5/11/12/15 with per-op layouts (see parseTimeline).
  x?: number;
  y?: number;
  z?: number;
  life?: number;
  item?: number;
  score?: number;
  // TH08 op 2/4 only: spawn x is drawn from [x, xMax] at runtime.
  xMax?: number;
  // TH08 op 11/12 only: extended death-drop fields (enemy +0x3308/+0x330c),
  // item is forced to -1 and score moves to the last dword.
  dropA?: number;
  dropB?: number;
  // Other events: two raw int args.
  i0?: number;
  i1?: number;
}

export class Ecl {
  readonly view: BinaryView;
  // Container version — always 8 (v1.00d); the magic check in the
  // constructor rejects anything else.
  readonly version = 8;
  readonly subCount: number;
  readonly subOffsets: number[] = [];
  readonly timelines: TimelineEvent[][] = [];
  // Instruction streams decoded per sub, indexed by byte offset for jumps.
  private subInstrs: Map<number, EclInstr[]> = new Map();

  constructor(source: string | Uint8Array) {
    this.view = new BinaryView(source);
    const v = this.view;
    if (v.length < 8 || v.u32(0) !== TH08_MAGIC) {
      throw new Error('not a TH08 ECL container (missing 0x0800 magic)');
    }
    const header = 4;
    this.subCount = v.u16(header);
    const timelineCount = Math.max(1, v.u16(header + 2));
    for (let i = 0; i < this.subCount; i++) {
      this.subOffsets.push(v.u32(header + 4 + (TIMELINE_SLOTS + i) * 4));
    }
    for (let t = 0; t < Math.min(timelineCount, TIMELINE_SLOTS); t++) {
      const off = v.u32(header + 4 + t * 4);
      if (!off || off >= v.length) break;
      this.timelines.push(this.parseTimeline(off));
    }
  }

  get timeline(): TimelineEvent[] {
    return this.timelines[0] ?? [];
  }

  private parseTimeline(start: number): TimelineEvent[] {
    const v = this.view;
    const out: TimelineEvent[] = [];
    for (let off = start, guard = 0; off + 8 <= v.length && guard < 4096; guard++) {
      // TH08 timeline v2: i32 time, u16 opcode, u8 total size, u8 rank.
      const time = v.i32(off);
      const op = v.u16(off + 4);
      const size = v.u8(off + 6);
      const rank = v.u8(off + 7);
      if (time < 0) break;
      if (size < 8) break;
      if (off + size > v.length) break;
      const evt: TimelineEvent = { time, arg0: 0, op, size, rank };
      // TH08 timeline v2 layouts from the exe's own switch (FUN_0042a8a0,
      // all.c:20270-20393). Each spawn op has its OWN arg layout:
      //   0/1/15 size 32: sub, x, y, life, item, score
      //   2/4    size 36: sub, xMin, xMax, y, life, item, score
      //   3/5    size 28: sub, y, life, item, score  (x = rng01()*384)
      //   11/12  size 36: sub, x, y, life, dropA(+0x3308), dropB(+0x330c),
      //          score   (item forced to -1 by the engine)
      // op 6 is a 12-byte MSG-start, NOT a spawn.
      if ((op <= 1 || op === 15) && size >= 32) {
        evt.arg0 = v.i32(off + 8);
        evt.x = v.f32(off + 12);
        evt.y = v.f32(off + 16);
        evt.life = v.i32(off + 20);
        evt.item = v.i32(off + 24);
        evt.score = v.i32(off + 28);
      } else if (op === 2 || op === 4) {
        if (size >= 36) {
          evt.arg0 = v.i32(off + 8);
          evt.x = v.f32(off + 12);
          evt.xMax = v.f32(off + 16);
          evt.y = v.f32(off + 20);
          evt.life = v.i32(off + 24);
          evt.item = v.i32(off + 28);
          evt.score = v.i32(off + 32);
        }
      } else if (op === 3 || op === 5) {
        if (size >= 28) {
          evt.arg0 = v.i32(off + 8);
          evt.y = v.f32(off + 12);
          evt.life = v.i32(off + 16);
          evt.item = v.i32(off + 20);
          evt.score = v.i32(off + 24);
        }
      } else if (op === 11 || op === 12) {
        if (size >= 36) {
          evt.arg0 = v.i32(off + 8);
          evt.x = v.f32(off + 12);
          evt.y = v.f32(off + 16);
          evt.life = v.i32(off + 20);
          evt.dropA = v.i32(off + 24);
          evt.dropB = v.i32(off + 28);
          evt.score = v.i32(off + 32);
        }
      } else if (size >= 16) {
        evt.i0 = v.i32(off + 8);
        evt.i1 = v.i32(off + 12);
      } else if (size >= 12) {
        evt.i0 = v.i32(off + 8);
      }
      out.push(evt);
      off += size;
    }
    return out;
  }

  // Decode a sub's instruction stream (cached). Offsets are relative to the
  // sub start, matching ECL jump instruction semantics.
  sub(subId: number): EclInstr[] {
    const cached = this.subInstrs.get(subId);
    if (cached) return cached;
    const start = this.subOffsets[subId];
    if (start == null) throw new Error(`ECL sub ${subId} out of range (subCount=${this.subCount})`);
    const v = this.view;
    const out: EclInstr[] = [];
    for (let off = start, guard = 0; off + 12 <= v.length && guard < 8192; guard++) {
      const time = v.u32(off);
      if (time === 0xffffffff) break;
      const id = v.u16(off + 4);
      const size = v.u16(off + 6);
      if (size < 12) break;
      if (off + size > v.length) break;
      // thtk's th06_instr_t is shared by TH07 and TH08: both sub instruction
      // masks remain u16 fields (`rank_mask >> 8`, then `param_mask`).
      out.push({
        time,
        id,
        size,
        rankMask: (v.u16(off + 8) >> 8) & 0xff,
        paramMask: v.u16(off + 10),
        args: off + 12,
        offset: off - start
      });
      off += size;
    }
    this.subInstrs.set(subId, out);
    return out;
  }
}
