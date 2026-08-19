import { BinaryView } from './bin';

// TH08 MSG dialogue format: u32 message count, u32 offsets[count], then
// per message a stream of {u16 time, u8 op, u8 argLength, args…} until op 0.
// Ops 0-14 cover the base dialogue controls (0 end, 1/2 portrait enter (side,
// anm script), 3 text line (color?, lineIndex, shift-jis text), 4 wait,
// 5 face expression (side, variant), 6 ecl-resume ticket, 7 music change,
// 8 boss intro line, 9 stage-result snapshot, 10 post-transition stop, 11
// stage transition, 12 BGM fadeout, 13 text-skippability flag, 14 screen
// fade); ops 15-22 extend them with TH08 controls. Text payloads (including
// op 16) are XOR-0x77-encoded Shift-JIS.

export interface MsgInstr {
  time: number;
  op: number;
  size: number;
  args?: number[];
  portrait?: number;
  script?: number;
  color?: number;
  line?: number;
  text?: string;
  arg?: number;
  arg2?: number;
  slot?: number;
  interrupts?: number[];
  interrupt?: number;
}

export class Msg {
  readonly view: BinaryView;
  readonly messages: MsgInstr[][] = [];

  constructor(source: string | Uint8Array) {
    this.view = new BinaryView(source);
    const count = this.view.i32(0);
    for (let i = 0; i < count; i++) {
      this.messages.push(this.parseMessage(this.view.u32(4 + i * 4)));
    }
  }

  private parseMessage(off: number): MsgInstr[] {
    const v = this.view;
    const out: MsgInstr[] = [];
    for (let guard = 0; guard < 512 && off + 4 <= v.length; guard++) {
      const instr: MsgInstr = { time: v.u16(off), op: v.u8(off + 2), size: v.u8(off + 3) };
      const args: number[] = [];
      for (let a = 0; a + 4 <= instr.size; a += 4) args.push(v.i32(off + 4 + a));
      if (args.length) instr.args = args;
      const a = off + 4;
      if (instr.op === 1 || instr.op === 2 || instr.op === 5) {
        instr.portrait = v.i16(a);
        instr.script = v.i16(a + 2);
      } else if (instr.op === 3 || instr.op === 8) {
        instr.color = v.i16(a);
        instr.line = v.i16(a + 2);
        instr.text = this.text(a + 4, off + 4 + instr.size);
      } else if (instr.op === 15) {
        instr.slot = v.i32(a);
        instr.interrupts = [v.i32(a + 4), v.i32(a + 8), v.i32(a + 12), v.i32(a + 16)];
      } else if (instr.op === 16) {
        instr.text = this.text(a, off + 4 + instr.size);
      } else if (instr.op === 17) {
        instr.slot = v.i32(a);
        instr.interrupt = v.i32(a + 4);
      } else if (instr.size >= 8) {
        instr.arg = v.i32(a);
        instr.arg2 = v.i32(a + 4);
      } else if (instr.size >= 4) {
        instr.arg = v.i32(a);
      }
      out.push(instr);
      off += 4 + instr.size;
      if (instr.op === 0) break;
    }
    return out;
  }

  private text(start: number, end: number): string {
    const v = this.view;
    const max = Math.min(end, v.length);
    const bytes = new Uint8Array(Math.max(0, max - start));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = v.bytes[start + i] ^ 0x77;
    }
    let nul = bytes.indexOf(0);
    if (nul < 0) nul = bytes.length;
    return new TextDecoder('shift-jis').decode(bytes.subarray(0, nul));
  }

  message(idx: number): MsgInstr[] | null {
    return this.messages[idx] ?? null;
  }
}
