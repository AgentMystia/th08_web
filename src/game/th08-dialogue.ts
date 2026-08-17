// Pure TH08 dialogue interpreter, modeled from GuiImpl::RunMsg in
// th08.exe v1.00d at 0x433db3.  It intentionally has no DOM, renderer, MSG
// parser, or asset dependencies: hosts decode MSG instructions into the
// public instruction shape and consume the returned events/state snapshot.

export const TH08_DIALOGUE_INPUT_BITS = {
  confirm: 0x0001,
  humanDirection: 0x0010,
  youkaiDirection: 0x0020,
  fastForward: 0x0100
} as const;

export interface Th08DialogueInstruction {
  /** Native MSG u16 timestamp. */
  readonly time: number;
  /** Native MSG opcode. */
  readonly op: number;
  /** Opcode arguments, excluding the 4-byte instruction header. */
  readonly args?: readonly number[];
  /** Decoded text for opcodes 3 and 16. */
  readonly text?: string;
}

export type Th08DialogueSide = 0 | 1;

export interface Th08DialoguePortraitSnapshot {
  readonly slot: 0 | 1 | 2 | 3;
  readonly initialized: boolean;
  readonly script: number;
  readonly interrupt: number;
  /** The same script interrupt, exposed with its higher-level name. */
  readonly expression: number;
  readonly position: number;
  readonly active: boolean;
}

export interface Th08DialogueSnapshot {
  readonly done: boolean;
  readonly instructionIndex: number;
  readonly clock: number;
  readonly currentSpeakerSlot: number;
  readonly nextTextLine: 0 | 1;
  readonly lines: readonly [string | null, string | null];
  readonly ownershipSide: Th08DialogueSide;
  readonly gameMode: Th08DialogueSide;
  readonly waiting: boolean;
  readonly waitRemaining: number;
  readonly portraits: readonly Th08DialoguePortraitSnapshot[];
}

export type Th08DialogueEvent =
  | { type: 'portrait-init'; slot: 0 | 1 | 2 | 3; script: number }
  | { type: 'portrait-interrupt'; slot: 0 | 1 | 2 | 3; interrupt: number }
  | { type: 'legacy-text'; speakerSlot: number; lineSlot: 0 | 1; text: string }
  | { type: 'wait-start'; duration: number }
  | { type: 'wait-complete'; duration: number; confirmed: boolean }
  | { type: 'slot-position'; slot: 0 | 1 | 2 | 3; position: number }
  | {
      type: 'active-slot';
      slot: 0 | 1 | 2 | 3;
      interrupts: readonly [number, number, number, number];
      positions: readonly [number, number, number, number];
    }
  | {
      type: 'slot-update';
      slot: 0 | 1 | 2 | 3;
      interrupt: number;
      expression: number;
      positions: readonly [number, number, number, number];
    }
  | {
      type: 'speaker-line';
      speakerSlot: number;
      lineSlot: 0 | 1;
      text: string;
      lines: readonly [string | null, string | null];
    }
  | {
      type: 'ownership-switch';
      from: Th08DialogueSide;
      to: Th08DialogueSide;
    }
  | { type: 'sound'; id: 12 }
  | { type: 'game-mode'; side: Th08DialogueSide }
  | { type: 'restart'; instructionIndex: 0 }
  // op6: the ECL resume ticket. RunMsg increments msg+0x22d78, which releases
  // the timeline's op-7 hold for exactly one update (the counter decrements
  // at the head of every RunMsg tick) — the boss-entry ECL resumes while the
  // conversation text keeps playing.
  | { type: 'resume-ticket' }
  | { type: 'done' };

interface PortraitState {
  slot: 0 | 1 | 2 | 3;
  initialized: boolean;
  script: number;
  interrupt: number;
  position: number;
  active: boolean;
}

function slot(value: number): 0 | 1 | 2 | 3 {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new RangeError(`TH08 dialogue portrait slot must be 0..3: ${value}`);
  }
  return value as 0 | 1 | 2 | 3;
}

/**
 * Runs one MSG entry. The caller invokes update once per scheduler frame.
 * A blocked wait consumes that frame; all other updates advance the message
 * clock by one at the tail, matching RunMsg's instruction gate.
 */
export class Th08DialogueMachine {
  private readonly instructions: readonly Th08DialogueInstruction[];
  private readonly portraitStates: PortraitState[];
  private instructionIndex = 0;
  private clock = 0;
  private previousInput = 0;
  private waitCounter = 0;
  private waitDuration = 0;
  private waitActive = false;
  private currentSpeaker = 0;
  private textLine: 0 | 1 = 0;
  private lines: [string | null, string | null] = [null, null];
  private awaitingNewSpeakerBlock = true;
  private restartDelay = 0;
  private _done = false;
  // op13 arms this (RunMsg case 0xd, gui-run-msg.c:228): while it is set and
  // Ctrl (0x100) is held, RunMsg SetCurrents the message clock to the pending
  // instruction's time at the top of every update (line 33-35) and bypasses
  // the op4/op21 wait bodies outright — the recorded run's held-Ctrl burns
  // through a full conversation in a handful of frames.
  private skippable = false;
  private _ownershipSide: Th08DialogueSide = 0;
  private _gameMode: Th08DialogueSide = 0;

  constructor(
    instructions: readonly Th08DialogueInstruction[],
    options: { ownershipSide?: Th08DialogueSide; gameMode?: Th08DialogueSide } = {}
  ) {
    this.instructions = instructions;
    this._ownershipSide = options.ownershipSide ?? 0;
    this._gameMode = options.gameMode ?? this._ownershipSide;
    this.portraitStates = [0, 1, 2, 3].map((index) => ({
      slot: index as 0 | 1 | 2 | 3,
      initialized: false,
      script: 0,
      interrupt: -1,
      position: 4,
      active: false
    }));
  }

  get state(): Th08DialogueSnapshot {
    return {
      done: this._done,
      instructionIndex: this.instructionIndex,
      clock: this.clock,
      currentSpeakerSlot: this.currentSpeaker,
      nextTextLine: this.textLine,
      lines: [...this.lines] as [string | null, string | null],
      ownershipSide: this._ownershipSide,
      gameMode: this._gameMode,
      waiting: this.waitActive,
      waitRemaining: this.waitDuration === 0
        ? 0
        : Math.max(0, this.waitDuration - this.waitCounter),
      portraits: this.portraitStates.map((portrait) => ({
        ...portrait,
        expression: portrait.interrupt
      }))
    };
  }

  update(input = 0): Th08DialogueEvent[] {
    if (this._done) return [];

    const events: Th08DialogueEvent[] = [];
    const rising = input & ~this.previousInput;
    this.previousInput = input;

    if (this.restartDelay > 0) {
      this.restartDelay--;
      return events;
    }

    // RunMsg evaluates every instruction at or before the split-clock value.
    // Op4/21 return from the middle of the loop while incomplete and do not
    // advance the clock for that scheduler frame.
    const skipping = this.skippable
      && (input & TH08_DIALOGUE_INPUT_BITS.fastForward) !== 0;
    for (let guard = 0; guard < 4096 && !this._done; guard++) {
      const instruction = this.instructions[this.instructionIndex];
      if (!instruction) {
        this.finish(events);
        return events;
      }
      // The skip fast-forward: the clock jumps straight to the pending
      // instruction's timestamp instead of creeping one frame per update.
      if (skipping && instruction.time > this.clock) this.clock = instruction.time;
      if (instruction.time > this.clock) break;

      const args = instruction.args ?? [];
      switch (instruction.op) {
        case 0:
          this.finish(events);
          return events;

        case 1: {
          const portraitSlot = slot(args[0] ?? 0);
          const script = args[1] ?? 0;
          const portrait = this.portraitStates[portraitSlot];
          portrait.initialized = true;
          portrait.script = script;
          events.push({ type: 'portrait-init', slot: portraitSlot, script });
          break;
        }

        case 2: {
          const portraitSlot = slot(args[0] ?? 0);
          const interrupt = args[1] ?? 0;
          this.setInterrupt(portraitSlot, interrupt);
          events.push({ type: 'portrait-interrupt', slot: portraitSlot, interrupt });
          break;
        }

        case 3: {
          const speakerSlot = args[0] ?? 0;
          const lineSlot: 0 | 1 = (args[1] ?? 0) === 0 ? 0 : 1;
          const text = instruction.text ?? '';
          if (lineSlot === 0) this.lines = [text, null];
          else this.lines[1] = text;
          this.currentSpeaker = speakerSlot;
          this.waitCounter = 0;
          events.push({ type: 'legacy-text', speakerSlot, lineSlot, text });
          break;
        }

        case 4: {
          const duration = Math.max(0, args[0] ?? 0);
          if (skipping) {
            // Skippable + Ctrl: RunMsg's case-4 body is bypassed wholesale;
            // the wait completes on the frame it is reached.
            this.completeWait(events, duration, false);
            break;
          }
          const confirmed = (rising & TH08_DIALOGUE_INPUT_BITS.confirm) !== 0
            && this.waitCounter >= 30;
          if (this.waitCounter === 0 && duration > 0) {
            events.push({ type: 'wait-start', duration });
          }
          if (!confirmed && this.waitCounter < duration) {
            this.beginWaitFrame(duration);
            return events;
          }
          this.completeWait(events, duration, confirmed);
          break;
        }

        case 5: {
          const portraitSlot = slot(args[0] ?? 0);
          const position = args[1] ?? 0;
          this.portraitStates[portraitSlot].position = position;
          events.push({ type: 'slot-position', slot: portraitSlot, position });
          break;
        }

        case 15: {
          const activeSlot = slot(args[0] ?? 0);
          this.applyActiveSlot(activeSlot);
          for (let index = 0; index < 4; index++) {
            const interrupt = args[index + 1] ?? -1;
            if (interrupt >= 0) this.portraitStates[index].interrupt = interrupt;
          }
          const finalInterrupts: [number, number, number, number] = [
            this.portraitStates[0].interrupt,
            this.portraitStates[1].interrupt,
            this.portraitStates[2].interrupt,
            this.portraitStates[3].interrupt
          ];
          const positions = this.currentPositions();
          this.currentSpeaker = activeSlot;
          this.awaitingNewSpeakerBlock = true;
          events.push({
            type: 'active-slot',
            slot: activeSlot,
            interrupts: finalInterrupts,
            positions
          });
          break;
        }

        case 16: {
          if (this.awaitingNewSpeakerBlock) {
            this.textLine = 0;
            this.lines = [null, null];
            this.awaitingNewSpeakerBlock = false;
          }
          const lineSlot = this.textLine;
          const text = instruction.text ?? '';
          this.lines[lineSlot] = text;
          this.waitCounter = 0;
          events.push({
            type: 'speaker-line',
            speakerSlot: this.currentSpeaker,
            lineSlot,
            text,
            lines: [...this.lines] as [string | null, string | null]
          });
          this.textLine = lineSlot === 0 ? 1 : 0;
          break;
        }

        case 17: {
          const activeSlot = slot(args[0] ?? 0);
          const interrupt = args[1] ?? -1;
          const positions = this.applyActiveSlot(activeSlot);
          if (interrupt >= 0) this.setInterrupt(activeSlot, interrupt);
          this.currentSpeaker = activeSlot;
          this.awaitingNewSpeakerBlock = true;
          events.push({
            type: 'slot-update',
            slot: activeSlot,
            interrupt: this.portraitStates[activeSlot].interrupt,
            expression: this.portraitStates[activeSlot].interrupt,
            positions
          });
          break;
        }

        case 21: {
          // Left/right rising edges swap ownership before the long-wait test.
          // A genuine switch emits sound 12 in the same RunMsg case.
          if (
            (rising & TH08_DIALOGUE_INPUT_BITS.humanDirection) !== 0
            && this._ownershipSide !== 0
          ) {
            events.push({ type: 'ownership-switch', from: this._ownershipSide, to: 0 });
            events.push({ type: 'sound', id: 12 });
            this._ownershipSide = 0;
          }
          if (
            (rising & TH08_DIALOGUE_INPUT_BITS.youkaiDirection) !== 0
            && this._ownershipSide !== 1
          ) {
            events.push({ type: 'ownership-switch', from: this._ownershipSide, to: 1 });
            events.push({ type: 'sound', id: 12 });
            this._ownershipSide = 1;
          }

          const duration = Math.max(0, args[0] ?? 0);
          if (skipping) {
            this.completeWait(events, duration, false);
            break;
          }
          if (this.waitCounter === 0 && duration > 0) {
            events.push({ type: 'wait-start', duration });
          }
          if (this.waitCounter < duration) {
            this.beginWaitFrame(duration);
            return events;
          }
          this.completeWait(events, duration, false);
          break;
        }

        case 13:
          // RunMsg case 0xd: text-skippability flag (arg0 byte).
          this.skippable = (args[0] ?? 0) !== 0;
          break;

        case 6:
          // RunMsg case 6: msg+0x22d78 += 1 — the ECL resume ticket.
          events.push({ type: 'resume-ticket' });
          break;

        case 22: {
          // FUN_00439810 receives side+1, replaces the active MSG entry, and
          // RunMsg restarts its outer loop. The replacement is represented as
          // an event plus index/clock reset without reaching into game state.
          this._gameMode = this._ownershipSide;
          this.instructionIndex = 0;
          this.clock = 0;
          this.restartDelay = 1;
          events.push({ type: 'game-mode', side: this._gameMode });
          events.push({ type: 'restart', instructionIndex: 0 });
          return events;
        }

        default:
          // The referenced build accepts additional inert/flow opcodes. They
          // consume an instruction here without fabricating renderer effects.
          break;
      }

      this.instructionIndex++;
    }

    if (!this._done) this.clock++;
    return events;
  }

  private applyActiveSlot(activeSlot: 0 | 1 | 2 | 3): [number, number, number, number] {
    const oldSpeaker = this.currentSpeaker;
    for (let index = 0; index < 4; index++) {
      const portraitSlot = slot(index);
      if (portraitSlot === activeSlot) continue;
      if (portraitSlot === oldSpeaker) {
        this.portraitStates[portraitSlot].position =
          Math.trunc(oldSpeaker / 2) === Math.trunc(activeSlot / 2) ? 4 : 6;
      } else {
        this.portraitStates[portraitSlot].position = 4;
      }
    }
    this.portraitStates[activeSlot].position = 3;
    for (const portrait of this.portraitStates) portrait.active = portrait.slot === activeSlot;
    return this.currentPositions();
  }

  private setInterrupt(portraitSlot: 0 | 1 | 2 | 3, interrupt: number): void {
    this.portraitStates[portraitSlot].interrupt = interrupt;
  }

  private currentPositions(): [number, number, number, number] {
    return [
      this.portraitStates[0].position,
      this.portraitStates[1].position,
      this.portraitStates[2].position,
      this.portraitStates[3].position
    ];
  }

  private beginWaitFrame(duration: number): void {
    this.waitActive = true;
    this.waitDuration = duration;
    this.waitCounter++;
  }

  private completeWait(events: Th08DialogueEvent[], duration: number, confirmed: boolean): void {
    this.waitActive = false;
    this.waitDuration = 0;
    this.awaitingNewSpeakerBlock = true;
    events.push({ type: 'wait-complete', duration, confirmed });
  }

  private finish(events: Th08DialogueEvent[]): void {
    this._done = true;
    this.waitActive = false;
    this.waitDuration = 0;
    events.push({ type: 'done' });
  }
}
