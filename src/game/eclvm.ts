import { Ecl, type EclInstr, type TimelineEvent } from '../formats/ecl';
import { Anm, AnmRunner } from '../formats/anm';
import { Std } from '../formats/std';
import { Msg } from '../formats/msg';
import {
  normalizeAngle, normalizeNativeAngleF32, clamp, TAU,
  NATIVE_PI_F32, NATIVE_TAU_F32, NATIVE_HALF_PI_F32
} from '../core/util';
import type { Rng } from '../core/rng';
import type { GameHost, Enemy, EnemyBullet, EclState, EclContext, BulletProps, BulletExSlot, ItemType, EnemyLaser } from './types';

// TH07 ECL virtual machine. Opcode semantics were derived by aligning thtk's
// th07 signature table against the TH06 instruction set (implemented in the
// TH06 Web runtime this project is based on), then validated instruction by
// instruction against the thecl disassembly of the original stage scripts.
// Approximations and open questions are marked with `TH07-TODO`.

// Th07.exe bullet pool is 0x400 = 1024 slots (FUN_00421e90 / FUN_00423480 both
// gate on `< 0x400`; audit-bullet-motion.md D4). Was 640 (an empirical probe
// ceiling), which starved the densest Lunatic patterns ~384 bullets early.
const ENEMY_BULLET_CAP = 1024;
const NATIVE_QUARTER_PI_F32 = 0.7853981852531433;
const NATIVE_SIXTH_PI_F32 = 0.5235987901687622;
const NATIVE_THIRD_PI_F32 = 1.0471975803375244;
const NATIVE_THREE_HALF_PI_F32 = 4.71238899230957;
const NATIVE_ONE_POINT_FIVE_F32 = 1.5;
const NATIVE_ONE_TENTH_F32 = 0.10000000149011612;
const EFFECT8_EASY_RANDOM_SCALE_F32 = 0.30000001192092896; // Th07.exe @ 0x48ead8
const EFFECT8_EASY_BASE_F32 = 0.699999988079071; // Th07.exe @ 0x48eb7c
const EFFECT8_HARD_RANDOM_SCALE_F32 = 0.4000000059604645; // Th07.exe @ 0x48ec74
const EFFECT8_HARD_BASE_F32 = 0.800000011920929; // Th07.exe @ 0x48eb78

// Th07.exe FUN_0043f2b0 @ 0x43f2b0: both deltas are float fields and an
// exactly coincident source/player pair returns the explicit π/2 constant
// instead of evaluating atan2(0, 0). Extra spell 122 deliberately reaches
// that case (boss and player both at 229.5733,74.5199); the fallback turns
// Sub100's whole volley downward and is therefore collision-visible.
function nativeAngleTowardPlayer(
  playerX: number,
  playerY: number,
  sourceX: number,
  sourceY: number
): number {
  const dx = Math.fround(playerX - sourceX);
  const dy = Math.fround(playerY - sourceY);
  return dx === 0 && dy === 0
    ? NATIVE_HALF_PI_F32
    : Math.fround(Math.atan2(dy, dx));
}

// Advance one fired bullet's copied op-79 queue exactly as FUN_004229f0
// @ 0x4229f0. Construction calls it once; FUN_004241c0 calls it on every
// normal-state bullet-manager tick, including the spawn-ANM transition tick.
// Unselected slots and 0x2000 grace slots can be skipped in one invocation,
// but at most ONE movement behavior is promoted before returning.
// TH08 (FUN_0042ffc0): the same ordered queue with the cond-stall rule, plus
// the immediate commands 0x20000 (wait gate), 0x4000 (prototype transform),
// 0x80000 (sfx), 0x40000 (fade-kill), which arrive through the optional host.
export function advanceBulletExBehavior(
  bullet: EnemyBullet,
  activationRate = 1,
  host?: { playSfx?(id: number): void; transformPrototype?(b: EnemyBullet, proto: number, spriteShift: number): void }
): void {
  if (!bullet.exSlots) return;
  let idx = bullet.exBehaviorIndex ?? 0;
  while (idx < bullet.exSlots.length) {
    const slot = bullet.exSlots[idx];
    if (!slot || slot.opcode === 0) return;
    // cond==0 waits at this slot while ANY earlier behavior flag is active.
    if (slot.cond === 0 && bullet.exFlags !== 0) return;
    idx++;
    bullet.exBehaviorIndex = idx;
    if ((bullet.exFireFlags & slot.opcode) === 0) continue;
    if (slot.opcode === 0x2000) {
      // +0xbf0 grace does not set +0xbf4 and does not consume the one-slot
      // movement budget; native immediately examines the next queue entry.
      bullet.graceFrames = Math.max(bullet.graceFrames ?? 0, slot.arg3 | 0);
      continue;
    }
    // TH08 immediate queue commands (FUN_0042ffc0 cases, all.c:23050-23086):
    // they never set an exFlags behavior bit and the walk continues inline.
    if (slot.opcode === 0x20000) {
      // Wait gate: arm the bullet's command timer for arg3 frames; the +0xdac
      // handler holds the queue there until it elapses (all.c:23507-23514).
      bullet.exWaitFrames = Math.max(bullet.exWaitFrames ?? 0, slot.arg3 | 0);
      continue;
    }
    if (slot.opcode === 0x4000) {
      // Prototype transform: swap the bullet's prototype block to arg3 and
      // shift its sprite by arg4 (all.c:23066-23074).
      host?.transformPrototype?.(bullet, slot.arg3 | 0, slot.arg4 | 0);
      continue;
    }
    if (slot.opcode === 0x80000) {
      host?.playSfx?.(slot.arg3 | 0);
      continue;
    }
    if (slot.opcode === 0x40000) {
      // Fade-kill (bullet state 5 at all.c:23061-23062).
      bullet.dead = true;
      return;
    }
    switch (slot.opcode) {
      case 1:
        bullet.exFlags |= 1;
        bullet.exRampElapsed = 0;
        bullet.exRampFrac = 0;
        break;
      case 0x10:
        bullet.exFlags |= 0x10;
        {
          const mag = Math.fround(Math.fround(slot.f0) * Math.fround(activationRate));
          const angle = Math.fround(slot.f1 <= -990 ? bullet.angle : slot.f1);
        bullet.exAccel = {
          // Th07.exe FUN_004229f0 @ 0x422be9-0x422c0f bakes the CURRENT
          // global slow-rate into the acceleration vector when the queue
          // slot is promoted. FUN_00423910 multiplies that retained vector
          // by the current rate again on every tick. Stage-6 Sub28 promotes
          // this slot while rate=1/2, so retaining the nominal magnitude
          // made its three bullet layers accelerate exactly 2x too fast and
          // produced the first false graze at PRE25254.
          mag,
          angle,
          vx: Math.fround(Math.cos(angle) * mag),
          vy: Math.fround(Math.sin(angle) * mag),
          limit: slot.arg3
        };
        }
        bullet.exAccelElapsed = 0;
        bullet.exAccelFrac = 0;
        break;
      case 0x20:
        bullet.exFlags |= 0x20;
        bullet.exAngle = { speedDelta: slot.f0, angleDelta: slot.f1, limit: slot.arg3 };
        bullet.exAngleElapsed = 0;
        bullet.exAngleFrac = 0;
        break;
      case 0x40:
      case 0x80:
      case 0x100:
        bullet.exFlags |= slot.opcode;
        bullet.exDir = {
          angle: slot.f0,
          newSpeed: slot.f1 <= -999 ? bullet.speed : slot.f1,
          interval: slot.arg3,
          maxTimes: slot.arg4
        };
        bullet.exDirElapsed = 0;
        bullet.exDirFrac = 0;
        bullet.dirTimes = 0;
        break;
      case 0x400:
      case 0x800:
        bullet.exFlags |= slot.opcode;
        bullet.exBounce = {
          // Native BulletManager.cpp:396 RunCommands 0x400/0x800: post-bounce
          // speed uses cmd->speed when >= 0, else preserves current speed (the
          // -999 sentinel is the DirChange angle convention, not bounce speed).
          speed: slot.f0 >= 0 ? slot.f0 : bullet.speed,
          maxTimes: slot.arg3
        };
        bullet.exBounceTimes = 0;
        break;
      default:
        warnOnce(`ex${slot.opcode}`, `op-79 opcode 0x${slot.opcode.toString(16)} has no behavior mapping`);
        break;
    }
    return;
  }
}

// Th08.exe .data @ VA 0x4c70d8: the 32-entry 1-in-3 default-drop table
// (FUN_0042bea0's DAT_00f54ce2-cycled bytes). Values are TH08 ItemType ids.
const TH08_DROP_TABLE = [0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0,
  1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0];
// TH08 ItemType enum ids (ItemManager.hpp) -> the engine's item type names.
const TH08_ITEM_TYPES = ['powerSmall', 'point', 'powerBig', 'bomb', 'powerFull',
  'extend', 'pointStar', 'time', 'pointSmall', 'unknown9', 'time2'] as const;

// Raw opcodes implemented by the TH08 v1.00d dispatcher below. Exported for
// the data-census regression: every opcode present in ecldata1.ecl must be
// handled directly, without translating through another game's numbering.
export const TH08_RAW_OPCODE_COVERAGE = new Set<number>([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
  40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
  53, 54, 55, 57, 58, 59, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,
  87, 88, 90, 91, 92, 93, 94, 95,
  96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
  109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
  121, 122, 123, 124, 126, 127, 128, 129, 130, 131, 132, 133,
  134, 135, 139, 140, 144, 148, 153, 158, 160, 173, 174, 175,
  176, 184
]);

// Th08.exe .rdata table @ VA 0x4b4ad8 (file offset 0xb44d8): 21 bullet
// prototypes x 5 etama.anm script slots. Values are GLOBAL sequential script
// indices over etama.anm's 116 scripts (on-disk id = value - 150): col0 =
// the main bullet script (Static-stops on its base sprite), cols 1-3 = the
// spawn-transition flash scripts for states 2/3/4, col4 = the death fade.
// Dumped from the binary; cross-checked against th08-bullet-anm.md §3.
const TH08_BULLET_PROTOTYPES: readonly (readonly number[])[] = [
  [0, 18, 19, 20, 15], [1, 21, 22, 23, 16], [2, 21, 22, 23, 16],
  [3, 21, 22, 23, 16], [4, 21, 22, 23, 16], [5, 21, 22, 23, 16],
  [6, 21, 22, 23, 16], [7, 24, 24, 24, 17], [8, 24, 24, 24, 17],
  [9, 24, 24, 24, 17], [25, 27, 27, 27, 26], [106, 21, 22, 23, 16],
  [107, 21, 22, 23, 16], [108, 21, 22, 23, 16], [109, 24, 24, 24, 17],
  [110, 24, 24, 24, 17], [111, 21, 22, 23, 16], [112, 21, 22, 23, 16],
  [113, 24, 24, 24, 17], [114, 24, 24, 24, 17], [115, 24, 24, 24, 17]
];

// Special variable ids (reads resolved from game state). Writable general
// variables live in the enemy's 26-slot block (EclState.vars). Th07.exe has
// NO call-window shift of any kind: 10000-10015 are fixed per-enemy locals
// shared by every sub the enemy runs, 10029-10036/10072-10073 are more fixed
// per-enemy slots, 10037-10044 are eight RUN-GLOBALS shared across all
// enemies, and everything else is a computed special. See varRead.
const VAR_BASE = 10000;

// f32 from raw i32 bits (for the TH08 captured-FIRE image, which stores its
// float operands as IEEE-754 words).
const __f32box = new Float32Array(1);
const __i32box = new Int32Array(__f32box.buffer);
function f32FromBits(bits: number): number {
  __i32box[0] = bits | 0;
  return __f32box[0];
}


const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[eclvm] ${message}`);
}

// Th08.exe v1.00d FUN_00422c40 @ 0x422c40 stores the normalized progress
// and the selected polynomial through float locals before constructing the
// Cartesian target. This is separate from ANM interpolation formulas.
function applyEclEaseNativeF32(t: number, mode: number): number {
  const v = Math.fround(t);
  switch (mode) {
    case 1: return Math.fround(v * v);
    case 2: return Math.fround(v * v * v);
    case 3: return Math.fround(v * v * v * v);
    case 4: {
      const inv = Math.fround(1 - v);
      return Math.fround(1 - Math.fround(inv * inv));
    }
    case 5: {
      const inv = Math.fround(1 - v);
      return Math.fround(1 - Math.fround(inv * inv * inv));
    }
    case 6: {
      const inv = Math.fround(1 - v);
      return Math.fround(1 - Math.fround(inv * inv * inv * inv));
    }
    default: return v;
  }
}

export interface StageData {
  ecl: string;
  std: string;
  msg: string;
  enemyAnm: string;
  bulletAnm?: string;
  bgAnm: string;
  // Stage 4 swaps between additional background ANM banks mid-stage.
  extraBgAnms?: readonly string[];
  effectAnm: string;
  stdTxtAnm: string;
  faceAnm: string;
  faceAnms?: readonly string[];
}

interface SpawnEclEnemyOptions {
  subId: number;
  x: number;
  y: number;
  z?: number;
  life?: number;
  item?: number;
  score?: number;
  mirrored?: boolean;
  parent?: Enemy | null;
  // FUN_0041db60 installs inherited scratch variables before the child's
  // first synchronous ECL dispatch.
  initialVars?: ArrayLike<number>;
  // TH08 familiar marking (ops 90-93, exe cases 0x59-0x5c): applied BEFORE
  // the synchronous t0 core so the child's own FIRE re-arms contact after
  // the spawn's clear — the native order (all.c:12082-12116 constructs and
  // marks before the first sub tick).
  th08Familiar?: boolean;
}

export class StageRuntime {
  readonly ecl: Ecl;
  readonly std: Std;
  readonly msg: Msg;
  readonly enemyAnm: Anm;
  // TH08 loads TWO enemy ANM files per stage (Th08.exe
  // EnemyManager::AddedCallback @ 0x42ebf0: slot 7 = enemy.anm, slot 8 =
  // stgNenm.anm). The dispatcher picks per enemy via flags2 bit 2 (cleared by
  // the plain anm ops 54/55/57 -> the common file, set by the alt ops
  // 58/59/61 -> the stage file; asm 0x419850/0x419acc/0x419d2f/0x419d4e).
  // Undefined on the TH07 path, which keeps its single merged file.
  readonly enemyAnmStage: Anm | undefined;
  readonly bulletAnm: Anm;
  readonly effectAnm: Anm;
  // TH07 runs several timelines in parallel (stage 1: main waves + ambience).
  timelineCursors: { index: number; frame: number }[] = [];
  // Trace of fired timeline spawn events (see update()); for timing audits.
  spawnLog: { t: number; time: number; sub: number }[] = [];
  // Test-only entity-lifecycle trace (PLAN.md Phase 0 / LIFE-001): spawn,
  // kill, release, boss-slot and visibility transitions, ring-capped.
  // Gameplay never reads it; the ?test=1 snapshot exposes it.
  lifecycleLog: { f: number; ev: string; id: number; sub: number; a?: number }[] = [];
  private randomItemIndex = 0;
  private randomSpawnIndex = 0;
  // FUN_00421e90 starts at a retained cursor and scans the 0x400-slot pool
  // circularly for the next free bullet.
  private bulletPoolCursor = 0;
  // Rebuilt from the live bullet list for each independent volley. A fixed
  // byte table preserves the exe's 0x400-slot scan order without allocating
  // and hashing a Set for every ECL fire instruction.
  private readonly bulletPoolOccupied = new Uint8Array(ENEMY_BULLET_CAP);
  private readonly bulletRectCache = new Map<string, { x: number; y: number; w: number; h: number; imageKey: string }>();
  bossSlots: (Enemy | null)[] = [];
  // Th07.exe DAT_00495bf4: true while any boss entity is registered.
  private bossRegistered = false;
  // TH08 DAT_00f54e1c: four-slot parallel-timeline latch table (timeline ops
  // 13 consume / 14 release; -1 = free). TH08 DAT_00f54e2c: spawn-suppress
  // flag written by sub op 175 and OR-ed into the timeline boss gate.
  private timelineLatches = [-1, -1, -1, -1];
  private timelineSpawnSuppress = 0;
  // TH08 ECL-manager timer (+0x5354), written by ins_160; see the case-160
  // comment in executeTh08.
  private th08ManagerTimer = 0;
  // Th07.exe DAT_012f40a8: GLOBAL spell-card-active state (op90 sets 1,
  // op91 clears). Every enemy's FIRE — boss AND op92/93 helpers — skips the
  // non-spell rank count/speed scaling while it is set. This was previously
  // a per-enemy flag, so helpers spawned during a spell fired rank-scaled
  // bullets (e.g. Letty final-spell 1.8 -> 1.3 at rank 0; CADENCE-001).
  spellActive = false;
  // DAT_012f40b8: current spell id written by op90. It is consulted by the
  // Stage-7/8 bomb collision guard in the enemy-core tail.
  private currentSpellId = -1;
  // TH08's run-global FLOAT bank: vars 10061-10068 map to the eight globals
  // DAT_004ece20..004ece3c (Th08.exe float resolver cases 0x274d-0x2754).
  // Boss pattern subs write shared rotation/phase parameters here and child
  // emitters read them back (stage-1 boss subs 26/38/44/48 write 10065).
  th08RunFloats = new Float64Array(8);
  // Every native ANM VM consumes the same gameplay RNG at 0x495e00.
  // Enemy runners are created from ECL dispatch, so retain the host stream
  // for constructors reached indirectly by pose changes and auxiliary slots.
  private anmRng: Rng | undefined;
  // DAT_0056babc bit 5. Effect 11 can latch this permanently when its own
  // parameter is >1; shipped TH07 ECL uses only 0/1, but the executable's
  // reachable counter semantics still include the branch.
  private slowCounterExtraStep = false;

  constructor(stage: StageData, anms: { etama: Anm; enemy: Anm; effect: Anm; enemyStage?: Anm }) {
    this.ecl = new Ecl(stage.ecl);
    this.std = new Std(stage.std);
    this.msg = new Msg(stage.msg);
    this.enemyAnm = anms.enemy;
    this.enemyAnmStage = anms.enemyStage;
    this.bulletAnm = anms.etama;
    this.effectAnm = anms.effect;
  }

  // The anm file an enemy script resolves against: the stage file while
  // flags2 bit 2 is set (TH08 two-file rule), else the common file.
  private enemyAnmFor(s: EclState): Anm {
    if (!this.enemyAnmStage || !s.th08) return this.enemyAnm;
    return (s.th08.flags2 & 4) !== 0 ? this.enemyAnmStage : this.enemyAnm;
  }

  private logLifecycle(game: GameHost, ev: string, e: Enemy, a?: number): void {
    if (this.lifecycleLog.length >= 4096) this.lifecycleLog.splice(0, 1024);
    this.lifecycleLog.push({ f: game.frame, ev, id: e.id, sub: e.ecl.subId, ...(a !== undefined ? { a } : {}) });
  }

  reset(): void {
    this.timelineCursors = this.ecl.timelines.map(() => ({ index: 0, frame: 0 }));
    this.bulletPoolCursor = 0;
    this.bossSlots = [];
    this.bossRegistered = false;
    this.timelineLatches = [-1, -1, -1, -1];
    this.timelineSpawnSuppress = 0;
    this.th08ManagerTimer = 0;
    this.spellActive = false;
    this.currentSpellId = -1;
    this.slowCounterExtraStep = false;
    this.lifecycleLog = [];
    this.th08RunFloats.fill(0);
    this.std.reset();
  }

  initializeRandomCounters(_rng: Rng): void {
    // TH08's drop counters (DAT_00f54ce0 the 1-in-3 phase, DAT_00f54ce2
    // the 32-entry table cursor) are BSS zero-init globals that simply
    // persist across stages — no per-stage RNG reseed exists in the exe
    // (no writes anywhere but the use site at all.c:20977-20985). Drawing
    // them from the stream here desynced every later random read by two
    // u16s and started the drop cycle at a random phase.
    this.randomSpawnIndex = 0;
    this.randomItemIndex = 0;
  }

  isTimelineComplete(): boolean {
    return this.timelineCursors.every((c, t) => c.index >= this.ecl.timelines[t].length);
  }

  get mainTimeline(): { index: number; frame: number } {
    return this.timelineCursors[0] ?? { index: 0, frame: 0 };
  }

  private isEnemyActive(game: GameHost, enemy: Enemy | null): boolean {
    return !!enemy && !enemy.dead && game.enemies.includes(enemy);
  }

  update(game: GameHost): void {
    const rate = game.slowRate ?? 1;
    if (!game.timeStopped) this.std.advance(rate);
    if (this.timelineCursors.length === 0) this.reset();
    for (let t = 0; t < this.ecl.timelines.length; t++) {
      const timeline = this.ecl.timelines[t];
      const cursor = this.timelineCursors[t];
      let held = false;
      while (cursor.index < timeline.length && timeline[cursor.index].time <= cursor.frame) {
        const evt = timeline[cursor.index];
        // Negative-time events never fire in the original engine.
        if (evt.time < 0) {
          cursor.index++;
          continue;
        }
        const action = this.runTimelineEventTh08(game, evt);
        game.traceReplayEvent?.({
          kind: 'timeline', frame: game.frame,
          data: {
            timeline: t, index: cursor.index, clock: cursor.frame,
            eventTime: evt.time, opcode: evt.op, action: action ?? 'advance'
          }
        });
        if (action === 'hold') {
          held = true;
          break;
        }
        cursor.index++;
      }
      // Timeline clock advances at the global rate (spec-slowmo.md §3.2).
      // Th07.exe (v1.00b) FUN_0041de20 @ all.c:13533-13720 has no
      // manager-wide dialogue gate here.  Timeline op 9 implements the
      // authored wait locally by cancelling this tail increment while the
      // message manager is active; op 8 starting a message must not freeze
      // the clock on its own.
      // TH08 holds freeze the clock too: FUN_0042a8a0's hold cases (op 7
      // dialogue @ 42abdc, op 10 boss-alive @ 42ac3d, op 13 latch @ 42ac81)
      // each call FUN_00418110 (ZunTimer::Subtract 1) BEFORE `goto
      // LAB_0042ad52` (ZunTimer::Tick +1) — net zero while parked. The
      // dispatcher only fires an op when the clock equals its time exactly,
      // so a parked-but-running clock would skip every op between two holds.
      // This reverts the 2026-08-17 reading that the goto alone advanced
      // the clock: it measured the tick but missed the compensating
      // subtract. Stage-1's timeline confirms the freeze: the post-midboss
      // waves sit at t=2935..3735 with the midboss hold parked at 2935, so
      // they stream for ~800 real frames after the midboss dies, and the
      // pre-boss dialogue (t=4175) lands midboss-death + ~1240 frames.
      if (!held) cursor.frame += rate;
    }
  }

  // TH08 timeline v2 dispatch, case-by-case from the exe's own interpreter
  // (FUN_0042a8a0, all.c:20220-20393). Differences from TH07: spawn ops are
  // 0-5/11/12/15 with per-op arg layouts, mirror ops are 1/4/5/12, op 6
  // starts a message, op 7 holds while the message manager is active, op 8
  // writes a boss interrupt, op 10 holds while a boss slot is alive, ops
  // 13/14 are the parallel-timeline latch table (DAT_00f54e1c), and every
  // event carries a per-difficulty rank byte — (rank & (1<<difficulty)) == 0
  // skips the body while the cursor still advances (DAT_0160f53c = 1 <<
  // difficulty, all.c:27733). Spawn ops 0-5/11/12 are DROPPED while a boss is
  // registered (FUN_0042f320) or the op-175 suppress flag is set
  // (DAT_00f54e2c); op 15 bypasses that gate.
  private runTimelineEventTh08(game: GameHost, evt: TimelineEvent): 'hold' | null {
    if (((evt.rank ?? 0xff) & (1 << game.difficulty)) === 0) return null;
    switch (evt.op) {
      case 0: case 1: case 2: case 3: case 4: case 5:
      case 11: case 12: case 15: {
        if (evt.op !== 15 && (this.bossRegistered || this.timelineSpawnSuppress !== 0)) return null;
        // TH08 spawn coordinates are literal (the TH07 -990 randomization
        // sentinel does not exist in FUN_0042a8a0); ops 2/4 and 3/5 draw
        // their x through FUN_0040d390 = rng01()*range.
        let x = evt.x ?? 0;
        if (evt.op === 2 || evt.op === 4) {
          x = Math.fround(game.rng.range(Math.fround((evt.xMax ?? 0) - (evt.x ?? 0))) + (evt.x ?? 0));
        } else if (evt.op === 3 || evt.op === 5) {
          x = Math.fround(game.rng.range(384));
        }
        const mirrored = evt.op === 1 || evt.op === 4 || evt.op === 5 || evt.op === 12;
        const extDrops = evt.op === 11 || evt.op === 12;
        this.spawnLog.push({ t: 0, time: evt.time, sub: evt.arg0 });
        const enemy = this.spawnEclEnemy(game, {
          subId: evt.arg0,
          x, y: evt.y ?? 0, z: 0,
          life: evt.life ?? -1,
          item: extDrops ? -1 : (evt.item ?? -1),
          score: evt.score ?? -1,
          mirrored
        });
        if (extDrops && !enemy.dead) {
          // Written AFTER the spawn core returns (all.c:20354-20355).
          enemy.ecl.th08!.deathDropA = evt.dropA ?? 0;
          enemy.ecl.th08!.deathDropB = evt.dropB ?? 0;
        }
        return null;
      }
      case 6:
        // MSG start (FUN_00439810, "msg start %d").
        game.startDialogue?.(evt.i0 ?? 0);
        return null;
      case 7:
        // Hold while the message manager is active (FUN_0043587e) — but the
        // predicate includes the op-6 resume ticket: msg+0x22d78 > 0 releases
        // the hold for one pass while the conversation keeps playing.
        if (game.consumeDialogueResume?.()) return null;
        return game.isDialogueActive?.() ? 'hold' : null;
      case 8: {
        // Boss interrupt write: bossSlots[i0].+0x2d30 = (u16)i1.
        const boss = this.bossSlots[evt.i0 ?? 0];
        if (this.isEnemyActive(game, boss)) boss!.ecl.pendingInterrupt = evt.i1 ?? 0;
        return null;
      }
      case 9:
        // FUN_00406fa0: float write into a manager sub-struct (+0x98), exact
        // target unproven; unused by every stage-1 timeline.
        warnOnce('tl9', 'unhandled TH08 timeline op 9');
        return null;
      case 10: {
        // Hold while boss slot i0 is alive (boss != null && flags bit0).
        const boss = this.bossSlots[evt.i0 ?? 0];
        return this.isEnemyActive(game, boss) ? 'hold' : null;
      }
      case 13: {
        // Consume a parallel-timeline latch; park (hold) while it is absent.
        const idx = this.timelineLatches.indexOf(evt.i0 ?? 0);
        if (idx < 0) return 'hold';
        this.timelineLatches[idx] = -1;
        return null;
      }
      case 14: {
        // Release a parallel timeline: insert into the first free latch slot.
        const free = this.timelineLatches.indexOf(-1);
        if (free >= 0) this.timelineLatches[free] = evt.i0 ?? 0;
        return null;
      }
      case 16:
        // DAT_0164d0bb = 1 (player-side stage-event flag); unused in stage 1.
        return null;
      default:
        warnOnce(`tl${evt.op}`, `unhandled TH08 timeline op ${evt.op}`);
        return null;
    }
  }

  spawnEclEnemy(game: GameHost, opts: SpawnEclEnemyOptions): Enemy {
    const {
      subId, x, y, z = 0, life = -1, item = -1, score = -1,
      mirrored = false, parent = null, initialVars
    } = opts;
    const hasLife = life >= 0;
    const hasScore = score >= 0;
    // The native template still carries its default random-drop marker during
    // the synchronous t0 core. Both allocators write itemDrop and score only
    // after FUN_0040f6c0 returns (all.c:13395-13412/13448-13474).
    const ecl = this.makeEnemyState(subId, mirrored, -1, parent);
    if (initialVars) {
      const count = Math.min(ecl.vars.length, initialVars.length);
      for (let i = 0; i < count; i++) ecl.vars[i] = Number(initialVars[i]);
    }
    const e: Enemy = {
      id: game.id++,
      poolSlot: -1,
      x, y, z,
      hp: hasLife ? life | 0 : 1,
      maxHp: hasLife ? life | 0 : 1,
      pendingShotDmg: 0,
      pendingBombDmg: 0,
      score: 100,
      frame: 0,
      ecl
    };
    // TH08 familiar master link (exe child+0x2da4): consumed by the death
    // sweep. makeEnemyState only used the pointer for var inheritance.
    if (parent) ecl.parent = parent;
    // Familiar marking BEFORE the synchronous t0 core (native order: the
    // spawn's flag writes precede the child's first sub tick, so a t0
    // FIRE re-arms contact after the spawn's clear).
    if (opts.th08Familiar && ecl.th08) {
      const t8 = ecl.th08;
      const form = game.th08PlayerForm ? game.th08PlayerForm() : 0;
      t8.familiar = true;
      t8.sideBit = form;
      t8.managerList = form === 1 ? 0 : 2;
      t8.flags = (t8.flags | 0x100 | (form << 11)) & ~4;
      ecl.collisionEnabled = false;
      game.playSfx(36); // se_option — FUN_0045d660(0x24, parentPos)
    }
    if (game.addEnemy) {
      if (!game.addEnemy(e)) e.dead = true;
    } else {
      game.enemies.push(e);
    }
    this.logLifecycle(game, 'spawn', e, parent?.id);
    game.traceReplayEvent?.({
      kind: 'enemy-spawn', frame: game.frame, enemyId: e.id,
      enemySlot: e.poolSlot, sub: subId,
      data: { x: e.x, y: e.y, mirrored, parentId: parent?.id ?? null }
    });
    // Apply the timeline life/score BEFORE the initial ECL run so a t=0
    // op110 (set HP) is not clobbered by the spawn-event life afterwards.
    // Bosses ship with life=1 as a placeholder; their real HP comes from
    // op110 inside the entry sub. The old post-run overwrite reset every
    // stage-4+ multi-slot boss back to 1 and let the first player shot
    // fire its death-callback (op99(-1)) on frame 1.
    if (hasLife) e.hp = e.maxHp = life | 0;
    // Both native allocators execute one complete FUN_0040f6c0 core tick
    // synchronously, including the movement controller, but do not run the
    // enemy manager's position integrator, regular ANM update,
    // collision/death pass, or tail timers. A timeline-spawned actor whose
    // slot has not yet been scanned can therefore run the core twice before
    // its first integration: once here and once in the manager pass.
    this.tickEnemyCore(game, e, true);
    if (e.dead) {
      // Th07.exe (v1.00b) FUN_0041da10/FUN_0041db60 @ all.c:13402-13408 /
      // 13461-13467: when the synchronous FUN_0040f6c0 returns -1, the
      // allocator clears enemy+0x2e28 bit7 immediately. It does NOT call
      // FUN_0041ea00, so no replay AUX-0x20 slot-vacate event is emitted.
      // Stage 2 Sub28/29 are common t=0 fire wrappers that take this path.
      if (game.discardAllocatedEnemy) game.discardAllocatedEnemy(e);
      else {
        const dense = game.enemies.indexOf(e);
        if (dense >= 0) game.enemies.splice(dense, 1);
      }
      return e;
    }
    // FUN_0041db60 (child allocator) reapplies an explicit HP after t0;
    // timeline FUN_0041da10 deliberately keeps a t0 op110 result.
    if (parent && hasLife) e.hp = life | 0;
    e.ecl.itemDrop = item;
    if (hasScore) e.score = score | 0;
    e.maxHp = Math.max(1, e.hp);
    return e;
  }

  private makeEnemyState(subId: number, mirrored: boolean, itemDrop: number, parent: Enemy | null): EclState {
    const state: EclState = {
      ctx: { subId, index: 0, time: 0, timeFrac: 0, waitTimer: 0 },
      stack: [],
      subId,
      mirrored,
      itemDrop,
      // Children inherit the parent's whole 26-dword variable block —
      // Th07.exe FUN_0041db60 copies 0x1a dwords from parent+0x6fc (locals,
      // extra floats, both rand configs) into every op92/93 spawn.
      vars: parent ? parent.ecl.vars.slice() : new Float64Array(26),
      axisSpeed: { x: 0, y: 0, z: 0 },
      angle: 0,
      angularVelocity: 0,
      speed: 0,
      acceleration: 0,
      shootOffset: { x: 0, y: 0, z: 0 },
      laserSlots: new Array(32).fill(null),
      laserSlotIndex: 0,
      interpSlots: new Array(8).fill(null),
      effectArm: null,
      movementSuppressedByEffect0: false,
      periodicSub: null,
      periodicExportArmed: false,
      pendingInterrupt: -1,
      hitbox2: null,
      moveMode: 0,
      interpKind: 0,
      interp: null,
      heading: 0,
      orbitAngle: 0,
      orbitAngularVelocity: 0,
      orbitSpeed: 0,
      orbitAcceleration: 0,
      orbitTarget: { x: 0, y: 0, z: 0 },
      orbitDuration: 0,
      orbitLeft: 0,
      bulletProps: null,
      bulletSfx: 0,
      bulletSfxInterval: 0,
      // TH07's op-79 queue is five slots; TH08's ins_111 record area at
      // enemy+0x2e44 spans the whole copied template block (stage 1 uses
      // slots 0-9) — 16 covers the shipped data.
      bulletExSlots: [null, null, null, null, null],
      shootDisabled: false,
      shootInterval: 0,
      shootTimer: 0,
      shootTimerFrac: 0,
      hitbox: { x: 28, y: 28, z: 32 },
      isBoss: false,
      bossSlot: null,
      canTakeDamage: true,
      collisionEnabled: true,
      interactable: true,
      shotCollision: true, // default bit4=1, Th07.exe FUN_0041d190 @ 0x41d190
      pauseDuringBombOrBorder: false,
      bombCollisionSuppressed: false,
      bombCollisionSuppressionHold: 0,

      deathMode: 0,
      deathCallbackSub: -1,
      lifeThresholds: [{threshold:-1,sub:-1},{threshold:-1,sub:-1},{threshold:-1,sub:-1},{threshold:-1,sub:-1}],
      timerCallbackThreshold: -1,
      timerCallbackSub: -1,
      bossTimer: 0,
      bossTimerPrevious: -999,
      currentAnm: -1,
      anmRunner: null,
      anmSlots: [],
      anmExDefaults: -1,
      anmExFarLeft: -1,
      anmExFarRight: -1,
      anmExLeft: -1,
      anmExRight: -1,
      anmExFlags: 0xff,
      deathAnm1: 0,
      deathAnm2: 0,
      deathAnm3: 0,
      integratorPreviousPosition: { x: 0, y: 0, z: 0 },
      frameVx: 0,
      frameVy: 0,
      frameVz: 0,
      anmRotateWithAngle: false,
      bossLifeCount: 0,
      lasers: [],
      laserStore: 0,
      disableCallStack: false,
      invisible: false,
      spellTimeoutFlag: false,
      // Enemy-manager template defaults, Th07.exe FUN_0041d190
      // @ 0x41d51f-0x41d52f: the allocator copies -0.15/+0.15 into every
      // fresh enemy. The wider -0.5/+0.5 pair belongs only to phase-entry
      // resets (FUN_0041e4a0/phaseTransition), handled separately below.
      bulletRankSpeedLow: -0.15000000596046448,
      bulletRankSpeedHigh: 0.15000000596046448,
      bulletRankAmount1Low: 0,
      bulletRankAmount1High: 0,
      bulletRankAmount2Low: 0,
      bulletRankAmount2High: 0,
      lowerMoveLimit: { x: 0, y: 0 },
      upperMoveLimit: { x: 384, y: 448 },
      shouldClamp: false,
      spellName: '',
      seen: false,
      sweepItemFlag: false,
      offscreenCullExempt: false,
      // FUN_0041d6a0 reserves 96 entries at enemy+0x2f78, initially zeroed
      // by the allocator template. Op138 changes only the four config fields;
      // it deliberately does not clear an already-running history.
      trailFlags: 0,
      trailCount: 0,
      trailStart: 0,
      trailStride: 0,
      // Th07.exe FUN_0041d190 initializes the X dword of all 96 template
      // history entries to -999.0 (manager+0x2f80, i.e. enemy+0x2f78),
      // leaving Y/Z zero. The cull/render validity gate is x >= -990. A
      // zero-filled tail therefore looks like an on-screen point and keeps a
      // freshly armed op138 actor's fixed slot alive long after its real
      // head has exited.
      trailHistory: Array.from({ length: 96 }, () => ({ x: -999, y: 0, z: 0 })),
      damageShield: 0,
      damageShieldFrac: 0
    };
    // TH08 frame-scope var layout (Th08.exe frame+0x18 block, 28 dwords —
      // the op90-94 spawner copies 30 dwords of it, covering this range plus
      // trailing frame padding): [0..7] ints 10000-10007, [8..15] floats
      // 10016-10023, [16..19] ints 10036-10039, [20..23] ints 10053-10056,
      // [24..27] floats 10057-10060, [28]/[29] floats 10094/10095 (VMframe
      // +0x68/+0x6c — the ins_38 angle→vector pair targets).
      // Enemy-scope locals (10008-10015 int, 10024-10031 float, exe
      // enemy+0x2ca8/+0x2cc8) live in state.th08 — they are NOT part of the
      // saved call frame.
    state.vars = parent ? parent.ecl.vars.slice() : new Float64Array(30);
    state.bulletExSlots = new Array(16).fill(null);
    state.th08 = {
        enemyInts: new Int32Array(8),
        enemyFloats: new Float64Array(8),
        scratch88: new Float64Array(6),
        poolCopyA: 0,
        poolCopyB: 0,
        pendingDynCall: -1,
        dynCallTable: new Int32Array(32).fill(-1),
        movement: {
          mode: 0,
          ease: 0,
          timerPrevious: -999,
          timerFraction: 0,
          timerCurrent: 0,
          timerTotal: 0,
          angle: 0,
          angularVelocity: 0,
          speed: 0,
          acceleration: 0,
          orbitAngle: 0,
          orbitAngularVelocity: 0,
          orbitSpeed: 0,
          orbitAcceleration: 0,
          displacement: { x: 0, y: 0, z: 0 },
          origin: { x: 0, y: 0, z: 0 },
          positionOffset: { x: 0, y: 0, z: 0 }
        },
        // FUN_00415c80 @ all.c:9244: fire rank-lerp defaults ±0.5 speed,
        // zero counts (phase entries reset back to these).
        fireRankSpeedLow: -0.5,
        fireRankSpeedHigh: 0.5,
        fireRankCount1Low: 0,
        fireRankCount1High: 0,
        fireRankCount2Low: 0,
        fireRankCount2High: 0,
        capturedFire: null,
        loopHeadX: 0,
        loopHeadY: 0,
        autoFireDeadline: 0,
        autoFireNext: 0,
        transformType: -1,
        deathDropA: 0,
        deathDropB: 0,
        stageInterpTemplate: 0,
        deathEffectId: 0,
        dropEffectId: 0,
        deathByte2: 0,
        flags: mirrored ? 0x40000 : 0,
        flags2: 0,
        familiar: false,
        sideBit: 0,
        markerHandle: null,
        markerActor: null,
        clampRect: null,
        suppressRadiusSq: 0,
        managerList: 0,
        spellBonus: 0,
        spellDecay: 0,
        subContexts: []
    };
    state.bulletRankSpeedLow = -0.5;
    state.bulletRankSpeedHigh = 0.5;
    return state;
  }



  // ---- TH08 variables ---------------------------------------------------

  private varRead(game: GameHost, e: Enemy, id: number, asFloat = false): number {
    return this.varRead8(game, e, id, asFloat);
  }

  private varWriteInt(game: GameHost, e: Enemy, id: number, value: number): void {
    this.varWriteInt8(game, e, id, value);
  }

  private varWrite(game: GameHost, e: Enemy, id: number, value: number): void {
    this.varWrite8(game, e, id, value);
  }

  private getInt(game: GameHost, e: Enemy, off: number): number {
    const raw = this.ecl.view.i32(off);
    // Th07.exe (v1.00b) FUN_0040d750 -> FUN_00481260: the latter is MSVC's
    // x87 `_ftol` helper. Despite Ghidra rendering its initial FISTP as
    // ROUND(), the correction tail implements a C cast (truncate toward
    // zero). Stage-3 Sub29 supplies 15.8464 through var10006 to op54 and the
    // native controller duration is 15, not 16.
    if (raw >= VAR_BASE && raw < VAR_BASE + 100) return Math.trunc(this.varRead(game, e, raw, false));
    return raw;
  }

  private getShort(game: GameHost, e: Enemy, off: number): number {
    const raw = this.ecl.view.i16(off);
    if (raw >= VAR_BASE && raw < VAR_BASE + 100) return Math.trunc(this.varRead(game, e, raw, false));
    return raw;
  }

  private getFloat(game: GameHost, e: Enemy, off: number): number {
    const value = this.ecl.view.f32(off);
    const asInt = Math.trunc(value);
    if (Math.abs(value - asInt) < 0.00001 && asInt >= VAR_BASE && asInt < VAR_BASE + 100) {
      return Number(this.varRead(game, e, asInt, true));
    }
    return value;
  }

  // ---- per-frame enemy processing -----------------------------------------

  updateEnemy(game: GameHost, e: Enemy): void {
    // Compatibility/full-manager wrapper used by focused VM tests. The live
    // StageScene calls the same phases around its native cull/collision/death
    // work so their ordering remains visible there.
    do {
      this.tickEnemyCore(game, e);
      if (e.dead) return;
      this.integrateEnemyPosition(e, game.slowRate ?? 1);
    } while (this.processEnemyCallbacks(game, e));
    this.updateEnemyAnm(e, game.slowRate ?? 1);
    this.tickEnemyManagerTail(game, e);
  }

  // FUN_0040f6c0: the reusable enemy core. Both allocators call this once
  // synchronously, and the manager calls it again when it reaches the slot.
  // Position integration, regular ANM ticking, collision/death, bossTimer,
  // and the damage-shield countdown are deliberately manager-only.
  tickEnemyCore(game: GameHost, e: Enemy, allocatorCore = false): void {
    this.anmRng = game.rng;
    const s = e.ecl;
    // The +0x2d88 loop-head position sync (0x418520): refreshed before every
    // dispatch, pre-movement. The auto-fire re-execution fires from THIS
    // snapshot even though it runs after the enemy's movement for the tick.
    if (s.th08) {
      s.th08.loopHeadX = e.x;
      s.th08.loopHeadY = e.y;
    }
    // dispatchEcl owns LAB_0040f6d1's interrupt/periodic preamble. Native
    // CALL and RETURN both jump back to that label, so the op144 timer may
    // advance multiple times inside one enemy-core invocation.
    // Dispatch precedes movement and auto-fire. The clock increments only at
    // the very tail, after op122/op27 (all.c:7105-7329).
    const advanceClock = this.dispatchEcl(game, e);
    if (e.dead) return;
    // TH08 ins_135 sub-ECL contexts tick alongside the main context
    // (round-robin in FUN_004184b0's fetch loop, all.c:10770-10800).
    if (s.th08 && s.th08.subContexts.length > 0) this.tickTh08SubContexts(game, e);
    // op121 may change DAT_0056baa8 inside dispatch. Native tail helpers read
    // the global after dispatch, so movement and the ECL split clock use the
    // newly written rate on that same core tick (FUN_00436acc call sites),
    // while the periodic pre-dispatch timer above used the entry rate.
    const tailRate = game.slowRate ?? 1;
    // Th07.exe (v1.00b): both FUN_0041da10 and FUN_0041db60 call the complete
    // FUN_0040f6c0 core synchronously. The controller is inside that core;
    // only FUN_0041d050 position integration is manager-only. Consequently a
    // newly spawned, not-yet-scanned slot advances the controller here and
    // again when the manager reaches it later in the same pass.
    this.updateMovementController(e, tailRate);
    this.updateAutoShoot(game, e);
    this.updateAnmPose(e);
    // Armed op122 and op27 slots are HP-gated and run after dispatch, so an
    // instruction armed at t0 takes effect during this same allocation core.
    if (e.hp > 0) {
      if (s.effectArm) this.runBulletEffect(game, e, s.effectArm.id, this.getInt(game, e, s.effectArm.paramOff));
      this.tickInterpSlots(game, e);
    }
    if (advanceClock) this.advanceEclClock(s, tailRate);
    // TH08's auto-fire (FUN_00423150) runs in the interpreter's unwind path
    // AFTER the frame clock's tick (all.c:10775-10786): when the clock
    // reaches the deadline during this tick's advance, the exe fires on this
    // same tick. Evaluating before the advance fired every volley one tick
    // late.
    if (s.th08) this.updateTh08AutoFire(game, e);
    this.updateHighSpellBombCollisionGate(game, e);
  }

  // Th07.exe (v1.00b) FUN_0040f6c0 @ 0x416933-0x4169c8. For a registered
  // boss on runtime stage 7/8, an active bomb during spell id >= 118 sets
  // enemy+0x2e2b bit2 and refreshes i16 +0x2e2c to 1. FUN_0041ed50 then
  // skips body collision, FUN_0043a980 (shots + attack slots), damage and
  // homing-target publication. Once the condition ends, one core tick only
  // decrements the hold; the following core tick clears the bit.
  // One dispatch pass over every live TH08 sub-ECL context (ins_135). The
  // contexts share the enemy's execute()/var machinery, so the active
  // context + frame vars are swapped in for the pass. Each context owns its
  // clock; it advances once per core tick like the main context's.
  private tickTh08SubContexts(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    const mainCtx = s.ctx;
    const mainVars = s.vars;
    const rate = game.slowRate ?? 1;
    for (const sub of s.th08!.subContexts) {
      if (!sub) continue;
      s.ctx = sub.ctx;
      s.vars = sub.vars;
      let ended = false;
      let waited = false;
      for (let guard = 0; guard < 64; guard++) {
        if (s.ctx.waitTimer > 0) {
          s.ctx.waitTimer -= rate;
          waited = true;
          break;
        }
        const instrs = this.ecl.sub(s.ctx.subId);
        const instr = instrs[s.ctx.index];
        if (!instr) {
          ended = true;
          break;
        }
        if (s.ctx.time !== instr.time) break;
        // Same all.c:10801 gate as the main dispatch: the ins_135
        // sub-contexts are fetched by the SAME round-robin loop
        // (LAB_0041ebd3), so a familiar's sub-context rows must also carry
        // the current form bit (Wriggle's Sub42 volley rows: 0x3f =
        // human-form only, 0x5f = youkai-form only).
        let rankGate = 1 << game.difficulty;
        if (e.ecl.th08?.familiar && game.th08PlayerForm) {
          rankGate |= game.th08PlayerForm() === 1 ? 0x40 : 0x20;
        }
        if ((instr.rankMask & rankGate) === rankGate) {
          const prevExecuting = this.executingEnemy;
          this.executingEnemy = e;
          const action = this.execute(game, e, instr);
          this.executingEnemy = prevExecuting;
          if (action === 'delete') {
            ended = true;
            break;
          }
          if (action === 'flow') continue;
        }
        s.ctx.index++;
      }
      if (ended) {
        sub.ctx.index = 0;
        sub.ctx.time = 0;
      } else if (!waited) {
        // The instruction clock freezes while the ins_2 wait timer runs
        // (the native pass head Subtracts it once, canceling the tail tick).
        this.advanceEclClock(s, rate);
      }
    }
    s.ctx = mainCtx;
    s.vars = mainVars;
  }

  private updateHighSpellBombCollisionGate(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    if (!s.isBoss || (game.stageNumber ?? 0) <= 6) return;
    if (game.isBombActive?.() && this.spellActive && this.currentSpellId >= 0x76) {
      s.bombCollisionSuppressed = true;
      s.bombCollisionSuppressionHold = 1;
      return;
    }
    if (s.bombCollisionSuppressionHold > 0) {
      s.bombCollisionSuppressionHold--;
    } else {
      s.bombCollisionSuppressed = false;
    }
  }

  private tickPeriodicSub(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    if (!s.periodicSub || s.periodicSub.subId < 0) return;
    // Th07.exe FUN_0040f6c0 @ all.c:7074-7082 stores the op144 clock as
    // integer +0x2f64 and fraction +0x2f60 and advances it with
    // FUN_00436acc. The old single-double accumulation reaches only
    // 5.999999999999998 after 18 additions of 1/3, delaying every period-6
    // callback by one wall frame. Stage-5 spell 75 repeats that callback
    // five times during bullet-time, displacing its sword-cut parents by
    // exactly five slowed velocity vectors.
    const periodic = s.periodicSub;
    periodic.elapsedFrac ??= 0;
    const rate = game.slowRate ?? 1;
    if (rate > 0.99) {
      periodic.elapsed++;
    } else {
      periodic.elapsedFrac += rate;
      if (periodic.elapsedFrac >= 1) {
        periodic.elapsed++;
        periodic.elapsedFrac -= 1;
      }
    }
    if (periodic.elapsed < periodic.period) return;
    periodic.elapsed = 0;
    periodic.elapsedFrac = 0;
    // all.c:7081-7102: periodic entry pushes the current 0x218-byte frame,
    // loads the sub's persistent variable stash, and arms the first RETURN
    // to export that stash through enemy+0x8f4.
    this.pushFrame(s);
    s.vars.set(s.periodicSub.savedVars);
    s.periodicExportArmed = true;
    this.enterSub(s, s.periodicSub.subId);
  }

  private updateMovementController(e: Enemy, rate: number): void {
    const s = e.ecl;
    const native = s.th08?.movement;
    if (!native || native.mode === 0) return;
    const rateF32 = Math.fround(rate);

    // FUN_00422c40 mode 1: integrate the polar heading/speed, derive the
    // manager velocity, then count down an optional ZunTimer.
    if (native.mode === 1) {
      native.angle = normalizeNativeAngleF32(
        native.angle,
        Math.fround(rateF32 * Math.fround(native.angularVelocity))
      );
      native.speed = Math.fround(
        Math.fround(rateF32 * Math.fround(native.acceleration)) + Math.fround(native.speed)
      );
      s.axisSpeed = {
        x: Math.fround(Math.cos(native.angle) * native.speed),
        y: Math.fround(Math.sin(native.angle) * native.speed),
        z: 0
      };
      native.angle = s.heading = s.angle = Math.fround(native.angle);
      s.speed = native.speed;
      s.angularVelocity = native.angularVelocity;
      s.acceleration = native.acceleration;
      if (native.timerTotal > 0) {
        this.subtractTh08MovementTimer(native, rateF32);
        if (native.timerCurrent <= 0) this.setTh08MovementMode(s, 0);
      }
      return;
    }

    // Mode 2 is a tracking delta: target = origin + displacement*ease(t),
    // then velocity = target-current. Both the target math and each stored
    // component round to f32. Mirrored enemies negate the controller delta;
    // the manager integrator negates it again when applying it.
    if (native.mode === 2) {
      this.subtractTh08MovementTimer(native, rateF32);
      const elapsed = native.timerCurrent + native.timerFraction;
      const progress = Math.fround(Math.max(0, 1 - elapsed / Math.max(1, native.timerTotal)));
      const eased = applyEclEaseNativeF32(progress, native.ease);
      const tx = Math.fround(Math.fround(native.displacement.x * eased) + native.origin.x);
      const ty = Math.fround(Math.fround(native.displacement.y * eased) + native.origin.y);
      const tz = Math.fround(Math.fround(native.displacement.z * eased) + native.origin.z);
      let vx = Math.fround(tx - Math.fround(e.x));
      const vy = Math.fround(ty - Math.fround(e.y));
      const vz = Math.fround(tz - Math.fround(e.z));
      if (s.mirrored) vx = Math.fround(-vx);
      s.axisSpeed = { x: vx, y: vy, z: vz };
      native.angle = s.heading = s.angle = Math.fround(Math.atan2(vy, vx));
      if (native.timerCurrent <= 0) {
        e.x = Math.fround(native.origin.x + native.displacement.x);
        e.y = Math.fround(native.origin.y + native.displacement.y);
        e.z = Math.fround(native.origin.z + native.displacement.z);
        s.axisSpeed = { x: 0, y: 0, z: 0 };
        this.setTh08MovementMode(s, 0);
      }
      return;
    }

    // Mode 3 follows a polar offset around a fixed origin. Unlike mode 2,
    // FUN_00422c40 does not pre-flip its X delta; the manager's mirror bit
    // remains the sole screen-space inversion.
    native.orbitAngle = normalizeNativeAngleF32(
      native.orbitAngle,
      Math.fround(rateF32 * Math.fround(native.orbitAngularVelocity))
    );
    native.orbitSpeed = Math.fround(
      Math.fround(rateF32 * Math.fround(native.orbitAcceleration)) + Math.fround(native.orbitSpeed)
    );
    const ox = Math.fround(Math.cos(native.orbitAngle) * native.orbitSpeed);
    const oy = Math.fround(Math.sin(native.orbitAngle) * native.orbitSpeed);
    s.axisSpeed = {
      x: Math.fround(Math.fround(ox + native.origin.x) - Math.fround(e.x)),
      y: Math.fround(Math.fround(oy + native.origin.y) - Math.fround(e.y)),
      z: 0
    };
    native.angle = s.heading = s.angle = Math.fround(Math.atan2(s.axisSpeed.y, s.axisSpeed.x));
    if (native.timerTotal > 0) {
      this.subtractTh08MovementTimer(native, rateF32);
      if (native.timerCurrent <= 0) this.setTh08MovementMode(s, 0);
    }
  }

  private subtractTh08MovementTimer(
    timer: NonNullable<EclState['th08']>['movement'],
    rate: number
  ): void {
    timer.timerPrevious = timer.timerCurrent;
    if (rate > 0.99) {
      timer.timerCurrent--;
      return;
    }
    timer.timerFraction = Math.fround(timer.timerFraction - rate);
    while (timer.timerFraction < 0) {
      timer.timerCurrent--;
      timer.timerFraction = Math.fround(timer.timerFraction + 1);
    }
  }

  private resetTh08MovementTimer(s: EclState, total: number): void {
    const timer = s.th08!.movement;
    timer.timerPrevious = -999;
    timer.timerFraction = 0;
    timer.timerCurrent = total | 0;
    timer.timerTotal = total | 0;
  }

  private setTh08MovementMode(s: EclState, mode: 0 | 1 | 2 | 3, ease = 0): void {
    const native = s.th08!.movement;
    native.mode = mode;
    native.ease = ease & 7;
    s.moveMode = mode;
    s.interpKind = native.ease;
    s.th08!.flags = (s.th08!.flags & ~0x1f000)
      | (mode << 12)
      | (native.ease << 14)
      | (s.mirrored ? 0x40000 : 0);
  }

  integrateEnemyPosition(e: Enemy, rate = 1): void {
    const s = e.ecl;
    // FUN_0041eae0 clamps immediately before and after FUN_0041d050.
    if (s.movementSuppressedByEffect0) return;
    this.clampEnemyPosition(e);
    // FUN_0041d050 snapshots the displacement that ALREADY happened since
    // the previous manager pass, then latches the pre-integration position.
    // ECL dispatch therefore reads these values one manager tick later than
    // the controller velocity used below (all.c:13120-13125).
    const prev = s.integratorPreviousPosition;
    s.frameVx = e.x - prev.x;
    s.frameVy = e.y - prev.y;
    s.frameVz = e.z - prev.z;
    prev.x = e.x;
    prev.y = e.y;
    prev.z = e.z;
    // Th07.exe (v1.00b) FUN_0041d050 @ all.c:13115-13118 performs each
    // multiply/add in x87, then fstp writes the result back to the enemy's
    // 32-bit x/y/z fields. Preserving JS-double positions accumulates a
    // sub-pixel drift; in Stage 3 it moved bullet slot 109 just outside the
    // graze box on frame 12024 and delayed its id8 RNG event by one frame.
    const rateF32 = Math.fround(rate);
    e.x = Math.fround(e.x + (s.mirrored ? -s.axisSpeed.x : s.axisSpeed.x) * rateF32);
    e.y = Math.fround(e.y + s.axisSpeed.y * rateF32);
    e.z = Math.fround(e.z + s.axisSpeed.z * rateF32);
    this.clampEnemyPosition(e);
  }

  private clampEnemyPosition(e: Enemy): void {
    const s = e.ecl;
    if (!s.shouldClamp) return;
    e.x = clamp(e.x, s.lowerMoveLimit.x, s.upperMoveLimit.x);
    e.y = clamp(e.y, s.lowerMoveLimit.y, s.upperMoveLimit.y);
  }

  processEnemyCallbacks(game: GameHost, e: Enemy): boolean {
    return this.checkCallbacks(game, e);
  }

  updateEnemyAnm(e: Enemy, rate = 1): void {
    const s = e.ecl;
    s.anmRunner?.update(rate);
    for (const slot of s.anmSlots) slot?.runner?.update(rate);
  }

  tickEnemyManagerTail(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    // Enemy+0x2bcc is a per-enemy split counter, despite the historical
    // bossTimer name. FUN_0041ed50 snapshots it to +0x2bc4 and advances it
    // for every occupied slot (all.c:14436-14439); body graze uses both.
    // DAT_0061c25c gates only this tail clock during a true global freeze.
    if (!game.timeStopped) {
      s.bossTimerPrevious = s.bossTimer;
      const rate = game.slowRate ?? 1;
      s.bossTimerFrac = (s.bossTimerFrac ?? 0) + rate;
      if (s.bossTimerFrac >= 1) {
        s.bossTimer++;
        s.bossTimerFrac -= 1;
      }
    }
    // op142's countdown is manager-tail only, so the allocation core cannot
    // consume shield time. Th07.exe FUN_0041ed50 @ all.c:14440 calls
    // FUN_00436a06(1), not a flat decrement: the {current,frac} pair at
    // +0x4f40/+0x4f3c retreats on the global slowmo split clock. A wall-
    // clock `--` expired Youmu's 240-tick shield during her rate-1/3 spell
    // 192 damage too early (Stage 5 native HP 205 vs WT 13 at PRE7732).
    if (s.damageShield > 0) {
      const rate = Math.fround(game.slowRate ?? 1);
      if (rate > 0.99) {
        s.damageShield--;
      } else {
        // FUN_00436a06 is a retreat clock: subtract first, then borrow one
        // integer tick whenever the f32 fraction crosses below zero. The old
        // forward accumulator delayed the first shield decrement until the
        // third 1/3-rate wall tick, leaving Stage-5 spell 87 one HP too high
        // at its native lethal hit (processing 18748).
        s.damageShieldFrac = Math.fround(s.damageShieldFrac - rate);
        while (s.damageShieldFrac < 0) {
          s.damageShield--;
          s.damageShieldFrac = Math.fround(s.damageShieldFrac + 1);
        }
      }
      if (s.damageShield <= 0) {
        s.damageShield = 0;
        s.damageShieldFrac = 0;
      }
    }
  }

  // Th07.exe (v1.00b) FUN_0041ed50 @ 0x41ef7f calls
  // FUN_00436a06(1) with ECX=enemy+0x2bc4 on op161's manager short-circuit.
  // This is the same {previous,fraction,current} split timer as bossTimer,
  // but it retreats rather than advances. At normal speed the helper's fast
  // path changes only current; at slow rates it snapshots current, subtracts
  // an f32 fraction, and borrows whole ticks after crossing below zero.
  tickEnemyPausedManagerClock(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    const rate = Math.fround(game.slowRate ?? 1);
    // Th07.exe FUN_00436a06 @ 0x436a06 executes the latched bit-5 retreat
    // before its ordinary rate branch and resets the split pair's sentinel.
    if (this.slowCounterExtraStep) {
      s.bossTimer--;
      s.bossTimerFrac = 0;
      s.bossTimerPrevious = -999;
    }
    if (rate > 0.99) {
      s.bossTimer--;
      return;
    }
    s.bossTimerPrevious = s.bossTimer;
    s.bossTimerFrac = Math.fround((s.bossTimerFrac ?? 0) - rate);
    while (s.bossTimerFrac < 0) {
      s.bossTimer--;
      s.bossTimerFrac = Math.fround(s.bossTimerFrac + 1);
    }
  }

  // Boss phase callbacks, matching the original engine's behavior: the timer
  // callback target is re-chained to the death callback whenever a callback
  // fires, life callbacks fire on hp < threshold (strict) and clamp hp up.
  private checkCallbacks(game: GameHost, e: Enemy): boolean {
    const s = e.ecl;
    // Life callbacks: exe FUN_0041e4a0 scans slots 0..3 in order, fires the
    // FIRST armed slot with hp < threshold, clamps hp UP to it, and also
    // cancels any pending timer callback.
    for (let i = 0; i < 4; i++) {
      const t = s.lifeThresholds[i];
      if (t.threshold >= 0 && t.sub >= 0 && e.hp < t.threshold) {
        e.hp = t.threshold;
        t.threshold = -1;
        s.timerCallbackThreshold = -1; // exe: cleared on every life-cb fire
        s.timerCallbackSub = s.deathCallbackSub;
        this.phaseTransition(game, e, t.sub);
        return true;
      }
    }
    if (s.timerCallbackThreshold >= 0 && s.timerCallbackSub >= 0 && s.bossTimer >= s.timerCallbackThreshold) {
      const sub = s.timerCallbackSub;
      // exe FUN_0041e6b0: clamp hp to the LARGEST still-armed life threshold
      let best = -1, bestIdx = -1;
      for (let i = 0; i < 4; i++) {
        if (s.lifeThresholds[i].threshold > best) { best = s.lifeThresholds[i].threshold; bestIdx = i; }
      }
      if (best > 0 && bestIdx >= 0) { e.hp = best; s.lifeThresholds[bestIdx].threshold = -1; }
      s.timerCallbackThreshold = -1;
      s.timerCallbackSub = s.deathCallbackSub;
      s.bossTimer = 0;
      s.bossTimerPrevious = -999;
      // Timing out voids the spell capture unless the ECL flagged otherwise.
      if (s.spellName && !s.spellTimeoutFlag) game.voidSpellCapture?.();
      // Exe timer-callback path (all.c:13820-13840, gated on the same
      // +0x2e2a bit6 flag): cherry -25% penalty — fires on nonspell
      // timeouts as well, not just spell cards.
      if (!s.spellTimeoutFlag) game.onBossPhaseTimeout?.();
      this.phaseTransition(game, e, sub);
      return true;
    }
    return false;
  }

  private phaseTransition(game: GameHost, e: Enemy, sub: number): void {
    const s = e.ecl;
    s.bulletRankSpeedLow = -0.5;
    s.bulletRankSpeedHigh = 0.5;
    s.bulletRankAmount1Low = 0;
    s.bulletRankAmount1High = 0;
    s.bulletRankAmount2Low = 0;
    s.bulletRankAmount2High = 0;
    this.resetFireTemplateState(s);
    s.stack.length = 0;
    s.periodicExportArmed = false;
    // The exe disarms the op144 periodic sub (+0x2ee4 = -1) on EVERY phase
    // entry — HP-threshold dispatch all.c:13754, timeout sweep all.c:13845.
    // Leaving it armed leaked the previous phase's emitter across spell
    // boundaries (Yuyuko 幽曲 sub38's period-8 rice into 桜符 sub58 for its
    // first ~1020 frames — the 米弹 leak, LIFE-001/STG6-001).
    s.periodicSub = null;
    if (s.isBoss) this.clearNonBossEnemies(game, e);
    this.enterSub(s, sub);
  }

  private resetFireTemplateState(s: EclState): void {
    // Native HP/timeout phase transitions and retained death-callback entry
    // all restore the 0x35-dword FIRE template at enemy+0x2bd4 from
    // DAT_009a26bc, then clear the auto-fire interval at +0x2ca8 (Th07.exe
    // v1.00b FUN_0041e4a0 @ 0x41e5ad, FUN_0041e6b0 @ 0x41e8bb, and
    // FUN_0041ed50 @ 0x4203de). This includes every op79 EX slot and the
    // op81 sound fields. The split counter at +0x2cac..+0x2cb4 is outside
    // that block and deliberately survives while the zero interval keeps it
    // dormant. Retaining the old template leaked a previous Stage-6 phase's
    // third/fourth EX behaviours into the next phase's bullets.
    s.bulletProps = null;
    s.bulletExSlots.fill(null);
    s.bulletSfx = 0;
    s.bulletSfxInterval = 0;
    s.shootInterval = 0;
  }

  private enterSub(s: EclState, subId: number): void {
    s.ctx = {
      subId,
      index: 0,
      time: 0,
      timeFrac: 0,
      waitTimer: 0
    };
  }

  // TH08 LAB_0041c88a saves the active 0x228-byte ECL context before a
  // dynamic call: cursor, frame variables, wait timer, interpolation slots,
  // and the periodic-export latch all return with the caller.
  private pushFrame(s: EclState): void {
    s.stack.push({
      ctx: { ...s.ctx },
      vars: s.vars.slice(),
      interps: s.interpSlots.map((slot) => (slot ? { ...slot } : null)),
      periodicExportArmed: s.periodicExportArmed
    });
  }

  // TH08 FUN_0040f6c0: enemy+0x2d30 stores a dynamic-call table INDEX, not
  // a global sub id. Timeline op 8 writes that index; raw op 126 fills the
  // enemy+0x2cf0 table it selects. The next enemy-core pass saves the live
  // caller context and enters the selected sub through the native CALL tail
  // (LAB_0041c88a). This is the Stage-1 boss-dialogue handoff: Sub25 maps
  // slot 1 to Sub26 before the timeline requests slot 1.
  private runPendingInterrupt(s: EclState): void {
    if (s.pendingInterrupt < 0) return;
    const interruptIndex = s.pendingInterrupt;
    s.pendingInterrupt = -1;
    const sub = s.th08?.dynCallTable[interruptIndex] ?? -1;
    if (sub == null || sub < 0) return;
    const next = this.ecl.sub(s.ctx.subId)[s.ctx.index];
    if (!s.disableCallStack && next) this.pushFrame(s);
    this.enterSub(s, sub);
  }

  // op27 per-frame tick (exe all.c:7271-7324 + FUN_0040ecd0/FUN_0040ed30):
  // modes 0-6 = 2-point LERP of f0..f1, mode 7 = cubic Hermite with f2/f3
  // as start/end tangents; ease curves per spec-op27-effects.md §1.3. The
  // final-frame write still happens before the slot frees.
  private tickInterpSlots(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    // FUN_0040f6c0 @ all.c:7266-7324 snapshots position before the eight
    // op27 slots run. Own-X/Y/Z targets are temporary writes: after all
    // slots produce their values, the executable captures the combined
    // displacement into +0x2b18/1c/20, rolls position back, and lets the
    // manager's later FUN_0041d050 integration apply that delta once. The
    // final delta deliberately remains after the interpolation slot frees.
    const oldX = e.x;
    const oldY = e.y;
    const oldZ = e.z;
    let positionTargetTouched = false;
    for (let i = 0; i < s.interpSlots.length; i++) {
      const slot = s.interpSlots[i];
      if (!slot) continue;
      slot.elapsed += game.slowRate ?? 1;
      const done = slot.elapsed >= slot.duration;
      // Native EclManager.cpp:618-652: op27 runs the SAME staged-float ease
      // as the mode-2 movement controller (FUN_0040f6c0's float locals), not
      // the double-precision polynomial — sub-ULP t differences accumulate
      // into visible drift over long interpolations.
      const t = applyEclEaseNativeF32(done ? 1 : slot.elapsed / Math.max(1, slot.duration), slot.ease);
      let value: number;
      if (slot.mode === 7) {
        // MathCubicInterp (EclManager.cpp:626-652): each Hermite basis is a
        // float local (single f32 store per basis), and the exe sums in the
        // order h00*p0 + h01*p1 + h10*m0 + h11*m1.
        const h00 = Math.fround((t - 1) * (t - 1) * (2 * t + 1));
        const h01 = Math.fround(t * t * (3 - 2 * t));
        const h10 = Math.fround((1 - t) * (1 - t) * t);
        const h11 = Math.fround((t - 1) * t * t);
        value = h00 * slot.f0 + h01 * slot.f1 + h10 * slot.f2 + h11 * slot.f3;
      } else {
        // MathLerp (EclManager.cpp:618-624): (b - a) * t + a.
        value = (slot.f1 - slot.f0) * t + slot.f0;
      }
      this.interpWrite(game, e, slot.target, value);
      if (slot.target === 10018 || slot.target === 10019 || slot.target === 10020) {
        positionTargetTouched = true;
      }
      if (done) s.interpSlots[i] = null;
    }
    if (positionTargetTouched) {
      const dx = e.x - oldX;
      const dy = e.y - oldY;
      const dz = e.z - oldZ;
      if (dx !== 0 || dy !== 0) s.heading = Math.atan2(dy, dx);
      e.x = oldX;
      e.y = oldY;
      e.z = oldZ;
      s.axisSpeed = { x: dx, y: dy, z: dz };
    }
  }

  // op27 writes go through the exe's FLOAT write path (FUN_0040e560),
  // which CAN write own-position (unlike the int path our varWrite
  // models). Position writes are temporary; tickInterpSlots rolls them back
  // and transfers their combined displacement to axisSpeed after all slots.
  // Position and heading targets are f32 fields natively (enemy+0x2c/30/34
  // and +0x2b54), so the write stores through Math.fround.
  private interpWrite(game: GameHost, e: Enemy, id: number, value: number): void {
    switch (id) {
      case 10018: e.x = Math.fround(value); return;
      case 10019: e.y = Math.fround(value); return;
      case 10020: e.z = Math.fround(value); return;
      case 10045: e.ecl.heading = Math.fround(value); e.ecl.angle = Math.fround(value); return;
      default: this.varWrite(game, e, id, value);
    }
  }

  private bulletsInPoolOrder(game: GameHost): EnemyBullet[] {
    return game.enemyBullets
      .filter((bullet) => !bullet.dead)
      .slice()
      .sort((a, b) => a.poolSlot - b.poolSlot);
  }

  private lasersInPoolOrder(game: GameHost): EnemyLaser[] {
    return game.enemyLasers
      .filter((laser) => laser.inUse)
      .slice()
      .sort((a, b) => a.poolSlot - b.poolSlot);
  }

  private occupiedBulletPoolSlots(game: GameHost): Uint8Array {
    const occupied = this.bulletPoolOccupied;
    occupied.fill(0);
    for (const bullet of game.enemyBullets) {
      if (!bullet.dead && bullet.poolSlot >= 0 && bullet.poolSlot < ENEMY_BULLET_CAP) {
        occupied[bullet.poolSlot] = 1;
      }
    }
    return occupied;
  }

  private allocateBulletPoolSlot(occupied: Uint8Array): number {
    for (let i = 0; i < ENEMY_BULLET_CAP; i++) {
      const slot = (this.bulletPoolCursor + i) % ENEMY_BULLET_CAP;
      if (occupied[slot]) continue;
      occupied[slot] = 1;
      this.bulletPoolCursor = (slot + 1) % ENEMY_BULLET_CAP;
      return slot;
    }
    return -1;
  }


  private bulletInsideLaser(bullet: EnemyBullet, laser: EnemyLaser, widthScale = 1): boolean {
    // Th07.exe (v1.00b) FUN_00417cb0 @ 0x417d32-0x417e5c stages
    // every rectangle input and both transformed coordinates through f32
    // locals before FUN_00417740 performs its inclusive AABB test.  Keeping
    // the algebra in relative double precision is observably different at
    // rotating-laser edges: native Stage-4 PRE23639 accepts fixed bullet
    // slot 1011 with 0.00067px remaining, while the unstaged port rejects it
    // by 0.00168px and shifts every later effect-8 RNG draw.
    const lx = Math.fround(laser.x);
    const ly = Math.fround(laser.y);
    const angle = Math.fround(laser.angle);
    const cos = Math.fround(Math.cos(angle));
    const sin = Math.fround(Math.sin(angle));
    const dx = Math.fround(Math.fround(bullet.x) - lx);
    const dy = Math.fround(Math.fround(bullet.y) - ly);
    const nearDist = Math.fround(laser.nearDist);
    const farDist = Math.fround(laser.farDist);
    const length = Math.fround(farDist - nearDist);
    const width = Math.fround(Math.fround(laser.width) * Math.fround(widthScale));
    // The center expression remains in x87 until this final f32 store; it
    // recomputes far-near instead of consuming the stored length local.
    const centerX = Math.fround((farDist - nearDist) / 2 + nearDist + lx);
    const rotatedX = Math.fround(Math.fround(dx * cos + dy * sin) + lx);
    const rotatedY = Math.fround(Math.fround(dy * cos - dx * sin) + ly);
    const halfLength = Math.fround(length / 2);
    const halfWidth = Math.fround(width / 2);
    const minX = Math.fround(centerX - halfLength);
    const maxX = Math.fround(centerX + halfLength);
    const minY = Math.fround(ly - halfWidth);
    const maxY = Math.fround(ly + halfWidth);
    // FUN_00417740 rejects only strict separation, so all four edges count.
    return rotatedX >= minX && rotatedX <= maxX && rotatedY >= minY && rotatedY <= maxY;
  }

  private isType8Seed(bullet: EnemyBullet): boolean {
    // etama entry 0 script 8 starts at global sprite 0x278; its eight color
    // offsets therefore cover exactly the exe's [0x278, 0x280) seed range.
    return bullet.sprite === 8 && bullet.spriteOffset >= 0 && bullet.spriteOffset < 8;
  }

  private resetDeflectedBulletTemplate(bullet: EnemyBullet): void {
    const stillSpawning = (bullet.spawnAge ?? bullet.spawnDuration) < bullet.spawnDuration;
    // Both laser-deflection callbacks copy template 5's first 0xb8c bytes
    // over the live bullet, preserving the FIRE color offset at +0xbf8.
    // Th07.exe v1.00b FUN_004179f0 @ 0x417bd1 and FUN_00417cb0 @ 0x417e70;
    // DAT_006292f4 = template base 0x625938 + 5*0xb8c.
    bullet.sprite = 5;
    bullet.rect = this.bulletRect(5, bullet.spriteOffset);
    bullet.grazeW = this.th08BulletHitbox(5);
    bullet.grazeH = this.th08BulletHitbox(5);
    if (stillSpawning) {
      // The copied block contains all five embedded ANM VMs. State 2/3/4
      // itself lives after +0xb8c and is retained, so a deflection during a
      // spawn intro restarts template 5's corresponding authored VM clock.
      bullet.spawnAge = 0;
      bullet.spawnAgeFrac = 0;
      bullet.spawnDuration = bullet.flags & 2 ? 10 : bullet.flags & 4 ? 16 : 32;
    }
  }

  // op121/122 bullet-effect table (24 entries @ Th07.exe .data 0x495148).
  // Id 3 is a true executable no-op; other missing ids remain explicit below.
  private runBulletEffect(game: GameHost, e: Enemy, id: number, param: number): void {
    switch (id) {
      case 0: { // FUN_00416d00: permanently attach movement to a tracked enemy
        const t = this.bossSlots[param];
        if (t) {
          e.x = t.x;
          e.y = t.y;
          e.z = t.z;
          e.ecl.axisSpeed = { ...t.ecl.axisSpeed };
          e.ecl.angle = t.ecl.angle;
          e.ecl.movementSuppressedByEffect0 = true;
        }
        return;
      }
      case 5: { // FUN_004173d0: track the selected boss's live position
        const t = this.bossSlots[param];
        if (t) {
          // Destination +0x2b8c/90/94 receives the source enemy's CURRENT
          // +0x2b0c/10/14 position, not its own orbit target. Stage-3's
          // Alice helpers arm this every frame so their ring follows the
          // moving boss while retaining the copied radius/angular rate.
          e.ecl.orbitTarget = { x: t.x, y: t.y, z: t.z };
          e.ecl.orbitSpeed = t.ecl.orbitSpeed;
          e.ecl.orbitAngularVelocity = t.ecl.orbitAngularVelocity;
        }
        return;
      }
      case 7: { // FUN_004179f0: bullets rebound from alternating global laser slots
        const selectedSlot = Math.trunc(e.ecl.bossTimer) % 2;
        const bullets = this.bulletsInPoolOrder(game);
        for (const laser of this.lasersInPoolOrder(game)) {
          if (laser.poolSlot !== selectedSlot || laser.state >= 2) continue;
          const laserAngle = Math.fround(laser.angle);
          const sin = Math.fround(Math.sin(laserAngle));
          const cos = Math.fround(Math.cos(laserAngle));
          for (const bullet of bullets) {
            if (bullet.dead || !this.bulletInsideLaser(bullet, laser)) continue;
            if (bullet.effectState > 0) bullet.effectState--;
            if (bullet.effectState !== 0) continue;
            if (bullet.speed > 0.5) bullet.speed = Math.fround(bullet.speed - NATIVE_ONE_TENTH_F32);
            const side = Math.fround(
              sin * Math.fround(bullet.vx) + cos * Math.fround(bullet.vy)
            );
            bullet.angle = normalizeNativeAngleF32(
              laserAngle,
              side < 0 ? -NATIVE_HALF_PI_F32 : NATIVE_HALF_PI_F32
            );
            const scaledSpeed = Math.fround(Math.fround(game.slowRate ?? 1) * bullet.speed);
            bullet.vx = Math.fround(Math.cos(bullet.angle) * scaledSpeed);
            bullet.vy = Math.fround(Math.sin(bullet.angle) * scaledSpeed);
            bullet.effectState = 10;
            this.resetDeflectedBulletTemplate(bullet);
          }
        }
        return;
      }
      case 8: { // FUN_00417cb0: one-use/cross-laser normal deflection
        const selectedModulo = Math.trunc(e.ecl.bossTimer) % 3;
        const bullets = this.bulletsInPoolOrder(game);
        for (const laser of this.lasersInPoolOrder(game)) {
          if (laser.poolSlot % 3 !== selectedModulo || laser.state >= 2) continue;
          const laserAngle = Math.fround(laser.angle);
          const sin = Math.fround(Math.sin(laserAngle));
          const cos = Math.fround(Math.cos(laserAngle));
          const nx = Math.fround(-sin);
          const ny = cos;
          for (const bullet of bullets) {
            // local_24[0x79] is the live ANM sprite pointer. Every drawable
            // bullet in this port has a resolved rect, so `dead` is the
            // corresponding allocation/live gate.
            if (bullet.dead || bullet.effectState < 0 || bullet.effectState === laser.poolSlot + 1) continue;
            if (!this.bulletInsideLaser(bullet, laser, NATIVE_ONE_POINT_FIVE_F32)) continue;
            // FUN_0042ffc0 is consumed only after every filter and the rectangle test.
            const random = game.rng.u32() / 0x100000000;
            const scale = game.difficulty < 2
              ? EFFECT8_EASY_RANDOM_SCALE_F32
              : EFFECT8_HARD_RANDOM_SCALE_F32;
            const base = game.difficulty < 2 ? EFFECT8_EASY_BASE_F32 : EFFECT8_HARD_BASE_F32;
            // The random multiply/add and old-speed multiply stay in x87;
            // only the completed nominal speed is stored to bullet+0xbb0.
            bullet.speed = Math.fround((random * scale + base) * Math.fround(bullet.speed));
            const normalDot = Math.fround(nx * Math.fround(bullet.vx) + ny * Math.fround(bullet.vy));
            const chosenX = normalDot < 0 ? Math.fround(-nx) : nx;
            const chosenY = normalDot < 0 ? Math.fround(-ny) : ny;
            // The selected unit normal is first stored to vx/vy, converted
            // to a stored f32 angle by atan2, then FUN_004074e0 overwrites
            // vx/vy with f32 FSINCOS products at the new nominal speed.
            bullet.vx = chosenX;
            bullet.vy = chosenY;
            this.resetDeflectedBulletTemplate(bullet);
            bullet.angle = Math.fround(Math.atan2(bullet.vy, bullet.vx));
            bullet.vx = Math.fround(Math.cos(bullet.angle) * bullet.speed);
            bullet.vy = Math.fround(Math.sin(bullet.angle) * bullet.speed);
            bullet.effectState = game.difficulty < 2 ? -1 : laser.poolSlot + 1;
          }
        }
        return;
      }
      case 10: { // FUN_00418020: enter bullet-time. Sets the GLOBAL rate to
        // 1/param and retroactively rescales every live bullet's velocity
        // vector (never the nominal speed field) — the per-frame bullet
        // integrator is unscaled, so this one-time edit IS the slowdown
        // (spec-slowmo.md §1). Repeated enters compound, like the exe.
        const f = param > 0 ? 1 / param : 1;
        for (const b of game.enemyBullets) {
          if (!b.dead) {
            b.vx *= f;
            b.vy *= f;
            // Th07.exe (v1.00b) FUN_00418020 @ 0x418020: +0x1d6 always
            // snapshots the live shape. Global shapes 0x260..0x26f are the
            // etama template-6 color row and are rebound to fixed 0x26f.
            b.slowmoShapeBackupRect = b.rect;
            if (b.sprite === 6) {
              b.rect = this.bulletRect(6, 15);
              b.grazeW = this.th08BulletHitbox(6);
              b.grazeH = this.th08BulletHitbox(6);
            }
          }
        }
        game.setBulletTimeVisual?.(true);
        game.setSlowRate?.(f);
        return;
      }
      case 11: { // FUN_00418130: exit bullet-time — exact algebraic inverse
        // of whatever rate is CURRENTLY active, then rate = 1.
        const f = 1 / (game.slowRate ?? 1);
        for (const b of game.enemyBullets) {
          if (!b.dead) {
            b.vx *= f;
            b.vy *= f;
            // FUN_00418130 @ 0x418130 only restores bullets whose CURRENT
            // shape is still in the 0x260..0x26f family. Deflection effects
            // may have rebound the bullet to template 5 in the meantime.
            if (b.sprite === 6 && b.slowmoShapeBackupRect) {
              b.rect = b.slowmoShapeBackupRect;
              b.grazeW = this.th08BulletHitbox(6);
              b.grazeH = this.th08BulletHitbox(6);
            }
          }
        }
        // Th07.exe @ 0x4181ff-0x41820b: latch DAT_0056babc bit 5 only when
        // this exit instruction's OWN param makes 1/param < 1. Real stage
        // data passes 0 or 1, so this is normally dormant rather than an
        // unconditional slow-motion-exit side effect.
        if (1 / param < 1) this.slowCounterExtraStep = true;
        game.setBulletTimeVisual?.(false);
        game.setSlowRate?.(1);
        return;
      }
      case 16: { // FUN_00418880: emit a five-way wave from every live seed
        const speed = Number(this.varRead(game, e, 10005));
        const occupied = this.occupiedBulletPoolSlots(game);
        const props: BulletProps = {
          sprite: 0,
          offset: 6,
          count1: 5,
          count2: 1,
          speed1: speed,
          speed2: speed,
          angle1: 0,
          angle2: Math.PI / 8,
          flags: 2,
          sfx: -1,
          exSlots: [null, null, null, null, null],
          aimMode: 1
        };
        for (const seed of this.bulletsInPoolOrder(game)) {
          if (seed.effectState !== 0 || !this.isType8Seed(seed)) continue;
          props.angle1 = normalizeAngle(seed.angle + Math.PI);
          this.spawnBullets(game, e, props, { x: seed.x, y: seed.y }, occupied);
        }
        return;
      }
      case 17: { // FUN_004189f0: detonate seeds into current-sub+1 helpers
        const inheritedVars = Array.from(e.ecl.vars.slice(0, 26));
        let fanAngle = -Math.PI;
        for (const seed of this.bulletsInPoolOrder(game)) {
          if (!this.isType8Seed(seed)) continue;
          if (seed.spriteOffset === 4 && seed.effectState === 0) {
            const initialVars = inheritedVars.slice();
            initialVars[4] = seed.angle;
            initialVars[11] = fanAngle;
            fanAngle += Math.PI / 4;
            this.spawnEclEnemy(game, {
              subId: e.ecl.ctx.subId + 1,
              x: seed.x,
              y: seed.y,
              life: 1,
              item: -2,
              score: 10,
              initialVars
            });
          }
          seed.dead = true;
        }
        return;
      }
      case 18: { // FUN_00418b30: expose the number of pending offset-4 seeds
        let count = 0;
        for (const seed of this.bulletsInPoolOrder(game)) {
          if (seed.sprite === 8 && seed.spriteOffset === 4 && seed.effectState === 0) count++;
        }
        e.ecl.vars[0] = count;
        return;
      }
      case 20:
        // TH07 remnant: this case used to fire the Yuyuko phase-2 BGM cue
        // ('th07_13b'). The TH08-native behavior of effect 20 is unrecovered
        // and Stage-1 data never arms it, so it stays a flagged no-op instead
        // of playing a wrong cue.
        return;
      case 1: { // FUN_00416da0 @ 0x416da0: "declaw" + slow-turn. The filter
        // field is the FIRE instruction's second i16 — spriteOffset, exe
        // bullet+0xbf8 (param 1 restricts to offset 8, param 2 to offset 4,
        // any other param applies no offset gate). Each first-time match:
        // nominal speed = 0.3 (.text imm 0x3e99999a), the whole 5-slot
        // behavior queue is wiped and a fresh opcode-0x20 slow-turn is
        // installed with its own elapsed counter: E/N/H 60 ticks at
        // +0.01666666753590107/tick (0x3c888889), Lunatic/Extra 240 ticks
        // at +0.005263158120214939 (0x3bac7692); turn rate ±π/(rng01*60+180)
        // per tick, + for offsets 6/8, − for 2/4, one RNG draw per matched
        // bullet in pool-slot order. The same bullet-manager tick recomputes
        // the velocity from 0.3+delta. Marked processed (+0xc08=1) so a
        // repeat call skips it. Plus a 12->0 shake over 30f and a 3x4f pale
        // flash (raw asm 0x416db4-0x416ddc).
        game.startScreenShake?.(30, 12, 0);
        game.startScreenFlash?.(4, 3, 0x80ffcfcf);
        // Exe leaves the wobble stack slot stale for offsets outside
        // {2,4,6,8} (retail data never fires those); carry the last value.
        let wobble = 0;
        const lunatic = game.difficulty >= 3;
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.effectState !== 0) continue;
          if (param === 1 && b.spriteOffset !== 8) continue;
          if (param === 2 && b.spriteOffset !== 4) continue;
          const k = b.spriteOffset;
          if (k === 2 || k === 4) wobble = -Math.PI / (game.rng.f() * 60 + 180);
          else if (k === 6 || k === 8) wobble = Math.PI / (game.rng.f() * 60 + 180);
          b.speed = 0.3;
          // Queue wipe + fresh slot-0 install (rep stos @ 0x416f4d then
          // FUN_004260d0). The port folds queue and live registers into the
          // ex* fields; retail bullets here carry no live motion behavior.
          const speedDelta = lunatic ? 0.005263158120214939 : 0.01666666753590107;
          const limit = lunatic ? 240 : 60;
          b.exFlags = 0;
          b.exSlots = [
            { opcode: 0x20, cond: 1, arg3: limit, arg4: 0, f0: speedDelta, f1: wobble },
            null, null, null, null
          ];
          b.exFireFlags |= 0x20;
          b.exBehaviorIndex = 0;
          b.exAccel = null;
          b.exDir = null;
          b.exBounce = null;
          b.exAngle = null;
          b.exRampElapsed = 0;
          b.exRampFrac = 0;
          b.exAccelElapsed = 0;
          b.exAccelFrac = 0;
          b.exAngleElapsed = 0;
          b.exAngleFrac = 0;
          b.exDirElapsed = 0;
          b.exDirFrac = 0;
          b.dirTimes = 0;
          b.exBounceTimes = 0;
          b.effectState = 1;
        }
        return;
      }
      case 2: { // FUN_00416fc0 @ 0x416fc0: convert nearby OFFSET-2 bullets
        // into a pair of real accelerating bullets, then delete the parent.
        // FUN_00423480 is the enemy-bullet constructor, not the similarly
        // named general visual-effect allocator FUN_0041b320.
        const thresholds = [128, 192, 256, 999];
        const thr = thresholds[param] ?? 999;
        if (param === 0) {
          game.startScreenShake?.(32, 12, 0);
          game.startScreenFlash?.(4, 1, 0x80cfcfff);
        }
        const occupied = this.occupiedBulletPoolSlots(game);
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.spriteOffset !== 2) continue;
          if (Math.hypot(e.x - b.x, e.y - b.y) >= thr) continue;
          // Native order is one frand for the shared acceleration magnitude,
          // followed by one aimMode-6 frand for each of the two children.
          const accel = Math.fround(game.rng.f() * Math.fround(0.005) + Math.fround(0.013));
          this.spawnBullets(game, e, {
            sprite: 0,
            offset: 6,
            count1: 2,
            count2: 1,
            speed1: Math.fround(0.7),
            speed2: 0,
            angle1: 0,
            angle2: -NATIVE_PI_F32,
            flags: 0x12,
            sfx: -1,
            exSlots: [
              { opcode: 0x10, cond: 0, arg3: 0xb4, arg4: 0, f0: accel, f1: NATIVE_HALF_PI_F32 },
              null, null, null, null
            ],
            aimMode: 6
          }, { x: b.x, y: b.y }, occupied);
          if (game.removeEnemyBullet) game.removeEnemyBullet(b);
          else b.dead = true;
          if (b.poolSlot >= 0 && b.poolSlot < occupied.length) occupied[b.poolSlot] = 0;
        }
        return;
      }
      case 4: { // FUN_00417290: find the FIRST live big-sprite bullet
        // (descriptor size > 60), remember its position in locals 10004/5,
        // burst + delete it. Sentinel -999 when none found. Param unused.
        this.varWrite(game, e, 10004, -999);
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || Math.max(b.rect.w, b.rect.h) <= 60) continue;
          this.varWrite(game, e, 10004, b.x);
          this.varWrite(game, e, 10005, b.y);
          game.spawnEffectParticles(2, b.x, b.y, 1, 0xffffffff);
          b.dead = true;
          break;
        }
        return;
      }
      case 6: { // FUN_00417440 @ 0x417440: convert one OFFSET family into
        // three real enemy-bullet rings, then delete each parent. The old
        // implementation used generic effect particles, which both removed
        // the collidable rings and consumed four bogus RNG draws per ring.
        const off = param === 0 ? 6 : param === 1 ? 15 : param === 2 ? 2 : -1;
        if (off < 0) return;
        const childOffset = param === 0 ? 15 : param === 1 ? 2 : 10;
        const useGrace = param === 0 || (param === 1 && game.difficulty === 3);
        const occupied = this.occupiedBulletPoolSlots(game);
        const graceSlot: BulletExSlot = {
          opcode: 0x2000, cond: 0, arg3: 0x82, arg4: 0, f0: 0, f1: 0
        };
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.spriteOffset !== off) continue;
          const angle = normalizeNativeAngleF32(b.angle, NATIVE_PI_F32);
          const fireRing = (count1: number, speedScale: number, angle2: number, flags: number): void => {
            this.spawnBullets(game, e, {
              sprite: 6,
              offset: childOffset,
              count1,
              count2: 1,
              speed1: Math.fround(b.speed * Math.fround(speedScale)),
              speed2: 0,
              angle1: angle,
              angle2,
              flags,
              sfx: -1,
              exSlots: [{ ...graceSlot }, null, null, null, null],
              aimMode: 1
            }, { x: b.x, y: b.y }, occupied);
          };
          fireRing(
            game.difficulty < 3 ? 4 : 2,
            1.1,
            game.difficulty < 3 ? NATIVE_SIXTH_PI_F32 : NATIVE_HALF_PI_F32,
            (useGrace ? 0x2000 : 0) | 2
          );
          fireRing(2, 0.7, NATIVE_THIRD_PI_F32, useGrace ? 0x2000 : 0);
          fireRing(1, 0.85, NATIVE_THIRD_PI_F32, useGrace ? 0x2000 : 0);
          if (game.removeEnemyBullet) game.removeEnemyBullet(b);
          else b.dead = true;
          if (b.poolSlot >= 0 && b.poolSlot < occupied.length) occupied[b.poolSlot] = 0;
        }
        return;
      }
      case 9: // FUN_00417ff0: strong 80-frame screen shake, 8->0 (§6).
        game.startScreenShake?.(80, 8, 0);
        return;
      case 12: case 21: { // FUN_00418260 @ 0x418260 / FUN_00418bc0 @ 0x418bc0
        // These are the Stage-5 sword-cut effects. They do NOT create visual
        // particles: every matching big bullet is replaced by a dense volley
        // of real, collidable enemy bullets through FUN_00423480, then the
        // big bullet is deleted. Misclassifying these as effect particles was
        // why 獄神剣「業風神閃斬」 visibly cut the 大玉 without releasing its
        // small-bullet barrage, and also skipped thousands of gameplay RNG
        // draws at each slash.
        game.startScreenFlash?.(8, 1, 0x50cfcfff);
        const hard = game.difficulty >= 2;
        const band = id === 12 ? (hard ? 48 : 64) : (game.difficulty === 2 ? 128 : 180);
        const count = id === 12 ? [10, 18, 22, 25][Math.min(3, game.difficulty)] : 15;
        const occupied = this.occupiedBulletPoolSlots(game);
        const variants = id === 12
          ? [[0, 2], [3, 2], [7, 1]] as const
          : [[0, 4], [3, 4], [7, 2]] as const;
        for (const b of this.bulletsInPoolOrder(game)) {
          // Both handlers compare the sprite descriptor's +0x2c field,
          // which is the frame HEIGHT, against 48. Width does not qualify a
          // wide-but-short bullet (FUN_00418260 @ 0x41834d and
          // FUN_00418bc0 @ 0x418c6b).
          if (b.dead || b.rect.h <= 48) continue;
          if (Math.abs(b.y - e.y) >= band) continue;
          for (let i = 0; i < count; i++) {
            // Exact per-child RNG order: x frand, y frand, kind u16, angle
            // frand, EX speed-delta frand = nine raw u16 draws. All five are
            // consumed before FUN_00423480 attempts fixed-pool allocation, so
            // a full bullet pool still advances the stream.
            const x = Math.fround(b.x + (game.rng.f() * 32 - 16));
            const y = Math.fround(b.y + (game.rng.f() * 32 - 16));
            const [sprite, offset] = variants[game.rng.u16() % 3];
            const randomAngle = game.rng.f();
            const angle = param === 0
              ? Math.fround(randomAngle * NATIVE_THREE_HALF_PI_F32 - NATIVE_HALF_PI_F32)
              : normalizeNativeAngleF32(
                  Math.fround(randomAngle * NATIVE_THREE_HALF_PI_F32),
                  NATIVE_QUARTER_PI_F32
                );
            const speedDelta = Math.fround(game.rng.f() * Math.fround(0.008) + Math.fround(0.01));
            const flags = 0x20 | (id === 12 && (i & 1) ? 2 : 0);
            this.spawnBullets(game, e, {
              sprite,
              offset,
              count1: 1,
              count2: 1,
              speed1: Math.fround(0.1),
              speed2: 0,
              angle1: angle,
              angle2: 0,
              flags,
              sfx: -1,
              exSlots: [
                { opcode: 0x20, cond: 0, arg3: 100, arg4: 0, f0: speedDelta, f1: 0 },
                null, null, null, null
              ],
              aimMode: 1
            }, { x, y }, occupied);
          }
          // Native deletion happens only after every child template has
          // consumed its RNG and attempted allocation. The now-free parent
          // slot is reusable by children from later big bullets in this same
          // fixed-slot scan.
          if (game.removeEnemyBullet) game.removeEnemyBullet(b);
          else b.dead = true;
          if (b.poolSlot >= 0 && b.poolSlot < occupied.length) occupied[b.poolSlot] = 0;
        }
        return;
      }
      case 13: { // FUN_00418650 (armed, per-frame): bullets drifting into
        // the narrow strip directly below the enemy (|dx|<16, y<352) get a
        // real opcode-0x20 motion record in slot 0. Despite the old
        // "cosmetic overlay" reading, a native fixed-slot trace proves the
        // record changes the bullet trajectory immediately: Stage-5 slot
        // 878 at processing 14055 loses speed/180 and turns -pi/60 on the
        // same manager pass (Th07.exe v1.00b @ 0x418650 / 0x4260d0).
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.effectState !== 0) continue;
          if (b.y <= e.y || b.y >= 352 || Math.abs(b.x - e.x) >= 16) continue;
          const turn = Math.fround((b.poolSlot & 1) === 0 ? -Math.PI / 60 : Math.PI / 60);
          const speedDelta = Math.fround(-Math.fround(b.speed) / 180);
          b.exSlots ??= [null, null, null, null, null];
          b.exSlots[0] = { opcode: 0x20, cond: 0, arg3: 0xa0, arg4: 0, f0: speedDelta, f1: turn };
          b.exFireFlags |= 0x20;
          // FUN_00426020 resets bullet+0xc10 so the normal bullet-manager
          // queue pass reconsiders slot 0; it does not clear active flags.
          b.exBehaviorIndex = 0;
          b.effectState = 1;
        }
        return;
      }
      case 14: { // FUN_00418780: sweep every id13-tagged bullet (processed
        // ==1) and queue a real opcode-0x10 acceleration toward the player's
        // current position: 90 ticks at f32 0.0266666673. FUN_00426110 uses
        // the same bullet movement queue as op79, not a separate cosmetic
        // overlay (Th07.exe v1.00b @ 0x418780 / 0x426110).
        game.startScreenFlash?.(16, 1, 0x50cfcfff);
        for (const b of this.bulletsInPoolOrder(game)) {
          if (b.dead || b.effectState !== 1) continue;
          const dx = game.player.x - b.x;
          const dy = game.player.y - b.y;
          const angle = dx === 0 && dy === 0
            ? NATIVE_HALF_PI_F32
            : Math.fround(Math.atan2(dy, dx));
          b.exSlots ??= [null, null, null, null, null];
          b.exSlots[0] = {
            opcode: 0x10, cond: 0, arg3: 0x5a, arg4: 0,
            f0: Math.fround(0.02666666731238365), f1: angle
          };
          // Native explicitly clears bullet+0xc3c, the opcode field of the
          // following queue record, after FUN_00426110 installs slot 0.
          b.exSlots[1] = null;
          b.exFireFlags |= 0x10;
          b.exBehaviorIndex = 0;
          b.effectState = 2;
        }
        return;
      }
      case 15: // FUN_00418850: single pale flash, duration = the op's own
        // param (live-read; §10). Color 0xd0cfcfff.
        game.startScreenFlash?.(Math.max(1, param), 1, 0xd0cfcfff);
        return;
      case 19: // FUN_00418ee0: fade the current BGM out over 3.0 seconds.
        game.fadeBgm?.(3);
        return;
      case 22: case 23: { // FUN_00418f20 @ 0x418f20 / FUN_00419150 @ 0x419150
        // Extra/Phantasm arm these handlers continuously with op122. Despite
        // their aura-like presentation, each qualifying large parent calls
        // the real enemy-bullet constructor (FUN_00423480), so omitting them
        // removes collidable bullets, their fixed-pool pressure, and one
        // frand from the shared RNG stream per parent.
        const group = e.ecl.bossTimer % 3;
        if ((id === 22 && group === 0) || (id === 23 && group === 2)) return;
        const occupied = this.occupiedBulletPoolSlots(game);
        for (const b of this.bulletsInPoolOrder(game)) {
          // Native filters bullet+0xbf4 bit 6 (the active EX mask), Y<320,
          // and the sprite descriptor's +0x2c HEIGHT strictly above 60.
          if ((b.exFlags & 0x40) !== 0 || b.y >= 320 || b.rect.h <= 60) continue;
          const variant = id === 22 ? (e.ecl.bossTimer & 1) : group;
          const angle = Math.fround(game.rng.f() * NATIVE_TAU_F32 - NATIVE_PI_F32);
          // The odd group (variant !== 0) attaches a real delayed-release
          // record via FUN_00426190 BEFORE the constructor (all.c:11197 op22 /
          // 11276 op23). FUN_00426190 -> FUN_00426080 ORs 0x80 into the fire
          // template's flags (0x208 -> 0x288) and seeds the template's +0x20
          // op-79 scratch slot 0 with a type-0x80 record. FUN_00421e90 then
          // memcpy's that +0x20 block into the newborn bullet's own +0xc14
          // queue (all.c:15374-15381), and the per-frame dispatch
          // FUN_004229f0 -> FUN_00423e70 (all.c:15936-15972) decays the
          // bullet's speed toward 0 over `interval` frames, then snaps it to
          // `newSpeed` and re-aims at the player. This is what makes the aura
          // bullets pause then shoot off fast; omitting it left them drifting
          // at ~1.0 and missed the Phantasm frame-5850 graze. (Web's 0x80
          // exSlot -> dirChangeBullet('aimed') already models FUN_00423e70.)
          const oddGroup = variant !== 0;
          this.spawnBullets(game, e, {
            sprite: variant === 0 ? 3 : 1,
            offset: id === 22
              ? (b.spriteOffset === 1 ? 6 : 2)
              : (b.spriteOffset === 2 ? 10 : 13),
            count1: id === 22 && variant === 0 ? 2 : 1,
            count2: 1,
            speed1: variant === 0 ? Math.fround(0.8) : Math.fround(1.2),
            speed2: 0,
            angle1: angle,
            angle2: -NATIVE_PI_F32,
            // Odd group carries the 0x80 EX-record activation bit (native
            // template flags +0xc4 |= 0x80 -> bullet +0xbf6 = 0x288).
            flags: oddGroup ? 0x288 : 0x208,
            sfx: 0x19,
            exSlots: oddGroup
              ? [
                  {
                    // FUN_00426190(&tmpl, 0, interval, 1, 0, newSpeed):
                    // op22 -> 60 frames / 3.1; op23 -> 40 frames / 2.9.
                    opcode: 0x80,
                    cond: 1,
                    arg3: id === 22 ? 0x3c : 0x28,
                    arg4: 1,
                    f0: 0,
                    f1: id === 22 ? Math.fround(3.1) : Math.fround(2.9)
                  },
                  null, null, null, null
                ]
              : [null, null, null, null, null],
            aimMode: 3
          }, { x: b.x, y: b.y }, occupied);
        }
        return;
      }
      case 3: return; // exe stub (confirmed empty; unused by real data)
      default:
        // Retail data uses exactly ids 0-23, all handled above — an id here
        // means new/modded data or a decode bug worth surfacing.
        warnOnce(`fx${id}`, `bullet-effect id ${id} out of the 24-entry table`);
        return;
    }
  }

  // TH08 auto-fire (FUN_00423150, all.c:16278): while the bullet pool
  // (enemy HP) is live and a deadline is armed, the ECL clock reaching the
  // deadline re-executes the raw FIRE instruction captured at +0x3034 by
  // ins_107 — every frame at/after the deadline, until the pool empties.
  // TH08's deadline is a frame count from arming (the ZunTimer at the
  // enemy's ECL clock); the port models it against ctx.time, which the
  // dispatcher advances once per core tick.
  private updateTh08AutoFire(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    const t = s.th08!;
    if (e.hp <= 0 || t.autoFireDeadline <= 0 || !t.capturedFire) return;
    // Periodic: fire each time the clock crosses the next deadline, then
    // advance by the interval (FUN_00423150's fire+reset pair).
    while (t.autoFireNext > 0 && s.ctx.time >= t.autoFireNext) {
      this.fireTh08Raw(game, e, t.capturedFire);
      t.autoFireNext += t.autoFireDeadline;
    }
  }

  // Re-run a captured raw 11-dword FIRE instruction image (the 44-byte block
  // at +0x3034): header + 8 dwords of args. Routed back through fireTh08's
  // gate/mode logic with var resolution disabled (the raw image's operands
  // were resolved at capture time in the exe — but the var-resolved bits
  // were the EXE's live-var reads, so re-resolve where the data asks).
  private fireTh08Raw(game: GameHost, e: Enemy, raw: Int32Array): void {
    const s = e.ecl;
    const t = s.th08!;
    if (e.hp <= 0) return;
    const mode = raw[1] & 0xffff;
    const instrLike = {
      args: 12, // dword layout starts after the 12-byte header
      id: mode,
      offset: 0,
      time: 0,
      size: raw[2] & 0xffff,
      rankMask: ((raw[2] >>> 16) & 0xffff) >> 8,
      paramMask: (raw[2] >>> 16) & 0xffff
    };
    void instrLike;
    // Read the fields straight from the captured image: header dwords 0-2,
    // then args at dwords 3..10. FUN_00422720 reads args with the paramMask
    // still attached, so VAR-RANGE operands re-resolve against the LIVE vars
    // at each fire (the midboss's captured fans carry [10016.0f] bases).
    // Same value-range rule as the main dispatch's getInt/getFloat.
    const gi = (d: number) => {
      const rawVal = raw[3 + d] | 0;
      return rawVal >= VAR_BASE && rawVal < VAR_BASE + 100
        ? Math.trunc(this.varRead(game, e, rawVal, false))
        : rawVal;
    };
    const gf = (d: number) => {
      const val = f32FromBits(raw[3 + d]);
      const asInt = Math.trunc(val);
      return Math.abs(val - asInt) < 0.00001 && asInt >= VAR_BASE && asInt < VAR_BASE + 100
        ? this.varRead(game, e, asInt, true)
        : val;
    };
    const sprite = raw[3] & 0xffff;
    const offset = (raw[3] >>> 16) & 0xffff;
    const count1raw = gi(1);
    const count2raw = gi(2);
    const angle1 = gf(5);
    const speed1 = gf(3);
    const angle2 = gf(6);
    const speed2 = gf(4);
    // The captured image holds 11 dwords (3 header + 8 args); flags are arg 7
    // = raw[10], the last dword. Reading raw[11] yielded undefined|0 = 0 and
    // silently stripped every auto-fired volley's spawn-state/sfx/gate bits.
    const flags = gi(7);
    if ((flags & 0x8000) !== 0 && (t.flags & 0x800) === 0) return;
    if ((flags & 0x10000) !== 0 && (t.flags & 0x800) !== 0) return;
    if (t.suppressRadiusSq > 0) {
      const dx = game.player.x - e.x;
      const dy = game.player.y - e.y;
      if (dx * dx + dy * dy < t.suppressRadiusSq) return;
    }
    const rank = game.rank;
    const lerpI = (lo: number, hi: number) => Math.trunc((hi - lo) * rank / 32) + lo;
    const lerpF = (lo: number, hi: number) => Math.fround(Math.fround((hi - lo) * rank) / 32 + lo);
    const count1 = Math.max(1, count1raw + lerpI(t.fireRankCount1Low, t.fireRankCount1High));
    const count2 = Math.max(1, count2raw + lerpI(t.fireRankCount2Low, t.fireRankCount2High));
    const rankSpeed = lerpF(t.fireRankSpeedLow, t.fireRankSpeedHigh);
    const props: BulletProps = {
      sprite,
      offset,
      count1,
      count2,
      speed1: speed1 !== 0 ? Math.max(0.3, Math.fround(speed1 + rankSpeed)) : 0,
      speed2: Math.max(0.3, Math.fround(speed2 + Math.fround(rankSpeed / 2))),
      angle1,
      angle2,
      flags,
      sfx: s.bulletSfx,
      exSlots: s.bulletExSlots.slice(),
      aimMode: mode - 96
    };
    s.bulletProps = props;
    // FUN_00422720's template position is vec3add(+0x2d88, +0x2db8): the
    // loop-head snapshot plus the muzzle offset — NOT the live post-move
    // enemy position (this re-execution runs after the enemy's movement).
    this.spawnBullets(game, e, props, {
      x: Math.fround(t.loopHeadX + s.shootOffset.x),
      y: Math.fround(t.loopHeadY + s.shootOffset.y)
    });
  }

  private updateAutoShoot(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    // Exe auto-shoot tick (all.c:7194-7208) fires purely on interval>0 &&
    // hp>0 — it does NOT consult the op75/76 bit (that bit only suppresses
    // the immediate fire inside FIRE ops 64-72). Checking shootDisabled here
    // silenced every op75-then-op73 pattern. The hp>0 gate freezes the timer
    // AND the fire while dead/dying — no death-frame extra volley
    // (CADENCE-001).
    if (!s.shootInterval || !s.bulletProps || e.hp <= 0) return;
    // Th07.exe FUN_0040f6c0 @ all.c:7195-7207 advances the integer field
    // +0x2cb4 and fractional field +0x2cb0 through FUN_00436acc, then
    // compares only the integer half with +0x2ca8. Keeping this as one JS
    // double made 1/3 accumulate to 4.999999999999999 for interval 5, so
    // every slowmo volley fired one wall frame late. Stage-5 spell 75's
    // large bullets accumulated five such late ticks before the sword cut.
    const rate = game.slowRate ?? 1;
    if (rate > 0.99) {
      s.shootTimer++;
    } else {
      s.shootTimerFrac += rate;
      if (s.shootTimerFrac >= 1) {
        s.shootTimer++;
        s.shootTimerFrac -= 1;
      }
    }
    if (s.shootTimer >= s.shootInterval) {
      s.shootTimer = 0;
      s.shootTimerFrac = 0;
      this.spawnBullets(game, e, s.bulletProps);
    }
  }

  setCurrentAnm(e: Enemy, script: number): void {
    const s = e.ecl;
    if (script < 0) return;
    const anm = this.enemyAnmFor(s);
    // The same script id can live in both TH08 enemy files — the cache key
    // must include the file or a file switch would keep the stale runner.
    if (s.currentAnm === script && s.anmRunnerAnm === anm) return;
    s.currentAnm = script;
    s.anmRunnerAnm = anm;
    s.anmRunner = this.makeEnemyAnmRunner(script, s.anmRunner ?? undefined, anm);
  }

  private makeEnemyAnmRunner(script: number, inheritSpriteFrom?: AnmRunner, anm: Anm = this.enemyAnm): AnmRunner | null {
    // Enemy ECL uses the executable loader's concatenated script ids. ANM
    // entries store local ids independently; stg6enm global 147..155 are
    // stg6enm2 local 0..8. Keep the flat fallback for the small test mocks
    // and any single-entry data lacking the additive resolver.
    const resolved = typeof anm.resolveGlobalScript === 'function'
      ? anm.resolveGlobalScript(script)
      : null;
    if (resolved) {
      return new AnmRunner(anm, resolved.localId, {
        entryIndex: resolved.entryIndex,
        spriteIndexOffset: resolved.spriteBase,
        rng: this.anmRng,
        // Th07.exe FUN_004486e0 @ 0x4486e0 resets the embedded ANM VM but
        // leaves enemy+0x1e4's current sprite pointer intact. Stage-1
        // Sub35 script 11's fourth random branch sets no sprite and must
        // retain script 0's 32x32 rect so FUN_0042bdc7 can cull it.
        inheritSpriteFrom
      });
    }
    return anm.hasScript(script)
      ? new AnmRunner(anm, script, { rng: this.anmRng, inheritSpriteFrom })
      : null;
  }

  private updateAnmPose(e: Enemy): void {
    const s = e.ecl;
    if (s.anmExLeft < 0) return;
    // Pose selection runs inside FUN_0040f6c0 before the manager integrator
    // and reads +0x2b18 directly. Mirrored actors invert its interpretation
    // in the branch table (all.c:7210-7229); slowRate is not multiplied here.
    const screenVx = s.mirrored ? -s.axisSpeed.x : s.axisSpeed.x;
    const vx = Math.abs(screenVx) < 0.0001 ? 0 : screenVx;
    const pose = vx < 0 ? 1 : vx > 0 ? 2 : 0;
    if (s.anmExFlags === pose) return;
    if (pose === 0) {
      if (s.anmExFlags === 0xff) this.setCurrentAnm(e, s.anmExDefaults);
      else if (s.anmExFlags === 1) this.setCurrentAnm(e, s.anmExFarLeft);
      else this.setCurrentAnm(e, s.anmExFarRight);
    } else if (pose === 1) this.setCurrentAnm(e, s.anmExLeft);
    else this.setCurrentAnm(e, s.anmExRight);
    s.anmExFlags = pose;
  }

  // ---- the interpreter -----------------------------------------------------

  private dispatchEcl(game: GameHost, e: Enemy): boolean {
    const s = e.ecl;
    let restartPreamble = true;
    for (let guard = 0; guard < 512; guard++) {
      if (restartPreamble) {
        // Th07.exe FUN_0040f6c0 @ LAB_0040f6d1 (all.c:7055-7104).
        // case 0x28 CALL and case 0x29 RETURN both goto this label. Stage 6
        // Sub44 calls Sub47 from its periodic body, so a firing tick resets
        // the timer and then advances it three times before the next PRE:
        // nested CALL, inner RETURN, outer RETURN (native PRE6080 = 3).
        this.runPendingInterrupt(s);
        this.tickPeriodicSub(game, e);
        restartPreamble = false;
      }
      const ctx = s.ctx;
      // op45 is a per-context WAIT, not an active-lifetime gate. At normal
      // speed the exe decrements both +0x76c and the ECL clock here, then the
      // frame-tail clock increment cancels out (0x40f83a-0x40f872). Checking
      // on every dispatcher pass also handles RETURN restoring a waiting
      // caller after an op144 periodic gosub.
      if (ctx.waitTimer > 0) {
        ctx.waitTimer -= game.slowRate ?? 1;
        return false;
      }
      const instrs = this.ecl.sub(ctx.subId);
      const instr = instrs[ctx.index];
      if (!instr) return false;
      if (ctx.time !== instr.time) break;
      // Rank gate (all.c:10801): the mask byte must cover the difficulty
      // bit AND — for FAMILIARS only — the current form bit (enemy+0x3330
      // = 0x40 youkai / 0x20 human, set by FUN_0042c420; ordinary enemies
      // keep +0x3330 = 0). Stage-1 masks only exercise this via 0xff/0xf1
      // rows, so the form leg is inert there but structurally required.
      let rankGate = 1 << game.difficulty;
      if (e.ecl.th08?.familiar && game.th08PlayerForm) {
        rankGate |= game.th08PlayerForm() === 1 ? 0x40 : 0x20;
      }
      if ((instr.rankMask & rankGate) === rankGate) {
        game.traceReplayEvent?.({
          kind: 'ecl', frame: game.frame, enemyId: e.id,
          enemySlot: e.poolSlot, sub: ctx.subId, clock: ctx.time,
          opcode: instr.id,
          data: {
            instructionIndex: ctx.index, x: e.x, y: e.y,
            moveMode: e.ecl.th08?.movement.mode ?? e.ecl.moveMode
          }
        });
        const prevExecuting = this.executingEnemy;
        this.executingEnemy = e;
        const action = this.execute(game, e, instr);
        this.executingEnemy = prevExecuting;
        if (action === 'delete') {
          e.dead = true;
          return false;
        }
        if (action === 'restart') {
          restartPreamble = true;
          continue;
        }
        if (action === 'flow') continue;
      }
      ctx.index++;
    }
    return true;
  }

  private advanceEclClock(s: EclState, rate: number): void {
    // FUN_00436acc at the core tail (all.c:7327-7329). Integer semantics are
    // load-bearing because instruction dispatch compares time with ===.
    if (rate > 0.99) {
      s.ctx.time++;
    } else {
      // Both the global rate and enemy+0x6ec are float32 fields. Native
      // FUN_00436acc loads, adds, and stores that fraction every call. A JS
      // double retained 0.9999999999999991 across Stage-5 Sub1's t18->t14
      // loop and delayed each id31 flake burst by one wall frame at PRE17165.
      s.ctx.timeFrac = Math.fround(s.ctx.timeFrac + Math.fround(rate));
      if (s.ctx.timeFrac >= 1) {
        s.ctx.time++;
        s.ctx.timeFrac = Math.fround(s.ctx.timeFrac - 1);
      }
    }
  }

  private jumpTo(s: EclState, targetOffset: number, newTime: number): void {
    const instrs = this.ecl.sub(s.ctx.subId);
    // Binary offsets are relative to the current instruction.
    const absolute = instrs[s.ctx.index].offset + targetOffset;
    const idx = instrs.findIndex((i) => i.offset === absolute);
    if (idx < 0) throw new Error(`ECL jump to unknown offset ${absolute} in sub ${s.ctx.subId}`);
    s.ctx.index = idx;
    s.ctx.time = newTime;
  }

  private execute(game: GameHost, e: Enemy, instr: EclInstr): 'delete' | 'flow' | 'restart' | null {
    return this.executeTh08(game, e, instr);
  }

  // ---- bullets, items, misc -----------------------------------------------

  bulletRect(sprite: number, offset: number): { x: number; y: number; w: number; h: number; imageKey: string } {
    return this.bulletRectTh8(sprite, offset);
  }

  createBulletClearRunner(sprite: number): AnmRunner | null {
    const prototype = TH08_BULLET_PROTOTYPES[sprite];
    if (!prototype) return null;
    const ref = this.etamaScriptByGlobalIndex(prototype[4]);
    if (!ref) return null;
    return new AnmRunner(this.bulletAnm, ref.localId, {
      entryIndex: ref.entryIndex,
      spriteIndexOffset: this.bulletAnm.entries[ref.entryIndex]?.spriteBase ?? 0
    });
  }

  spawnBullets(
    game: GameHost,
    e: Enemy,
    p: BulletProps,
    origin: { x: number; y: number } | null = null,
    occupiedPoolSlots: Uint8Array | null = null
  ): void {
    // FUN_00423480 @ 0x42348b gates the WHOLE volley on DAT_0099fa60,
    // which is the previous FUN_004241c0 manager-entry census. It is not the
    // current number of occupied slots: bullets culled later in that manager
    // pass leave holes, but enemy FIRE in the next priority-10 pass still
    // refuses the volley when the latched count was 1024. The allocator below
    // independently enforces the physical fixed-pool limit for other cases.
    if ((game.enemyBulletManagerEntryCount ?? 0) >= ENEMY_BULLET_CAP) return;
    // FUN_0040f6c0 stages enemy position + FIRE offset through f32 template
    // fields (+0x2bd8/+0x2bdc), and FUN_00421e90 copies those bits verbatim
    // into bullet+0xb8c/+0xb90.  These are gameplay coordinates before the
    // first same-frame bullet-manager move, not merely render precision.
    // TH08 v1.00d cross-check: FUN_00422720 @ 0x4227f8 builds the template
    // position as vec3add(enemy+0x2d88, enemy+0x2db8), where +0x2d88 is the
    // ANM position synced at the ECL loop head (0x418520: +0x2d88 = +0x2d34
    // + the spawn-anchor +0x2d40, zero for stage-1 spawners) BEFORE the
    // instruction dispatch — i.e. the step-START position, exactly this
    // pre-movement e.x. Verified against the f530 ring: our origin (320,
    // 67.0) equals the enemy's step-head position, and two of the seven
    // phantom-death killers (f916/f2105 volleys) fire from STATIONARY
    // enemies, so no position-field phase can explain them.
    const shootX = Math.fround(origin?.x ?? e.x + e.ecl.shootOffset.x);
    const shootY = Math.fround(origin?.y ?? e.y + e.ecl.shootOffset.y);
    game.traceReplayEvent?.({
      kind: 'fire', frame: game.frame, enemyId: e.id,
      enemySlot: e.poolSlot, sub: e.ecl.subId, clock: e.ecl.ctx.time,
      data: {
        x: shootX, y: shootY, enemyX: e.x, enemyY: e.y,
        sprite: p.sprite, offset: p.offset, count1: p.count1, count2: p.count2,
        speed1: p.speed1, speed2: p.speed2, angle1: p.angle1,
        angle2: p.angle2, aimMode: p.aimMode, flags: p.flags,
        rank: game.rank
      }
    });
    // Test-only observability (PLAN.md Phase 0 / LIFE-001): last frame this
    // enemy emitted bullets. Gameplay never reads it.
    e.ecl.lastFireFrame = game.frame;
    // FUN_0043f2b0 stores both deltas as f32 before FPATAN; FUN_00423480 then
    // stores the returned aim once more as f32 before passing it by value.
    // The enemy FIRE pass aims through the GameManager's player mirror,
    // which holds the position as of the frame START: the calc chain runs
    // descending (bullets 14 -> enemies 11 -> player 9), so the enemy pass
    // sees where the player ended the previous frame. Verified empirically:
    // aiming at the live (post-move) player produced phantom contacts at
    // f2182/f3259 that the one-frame mirror clears.
    const aimMirror = game.playerPosAtFrameStart ?? game.player;
    const aim = nativeAngleTowardPlayer(aimMirror.x, aimMirror.y, shootX, shootY);
    // The FIRE template endpoints are raw f32 values.  Do not pre-wrap angle
    // endpoints: random modes 6/8 interpolate the authored interval first,
    // then FUN_0042fff0 wraps only the completed per-bullet angle.
    const speed1 = Math.fround(p.speed1);
    const speed2 = Math.fround(p.speed2);
    const angle1 = Math.fround(p.angle1);
    const angle2 = Math.fround(p.angle2);
    const rate = Math.fround(game.slowRate ?? 1);
    const occupied = occupiedPoolSlots ?? this.occupiedBulletPoolSlots(game);
    let rect: { x: number; y: number; w: number; h: number; imageKey: string } | null = null;
    for (let j = 0; j < p.count2; j++) {
      const speed = p.count2 < 2
        ? speed1
        : Math.fround(speed1 - ((speed1 - speed2) * j) / p.count2);
      for (let i = 0; i < p.count1; i++) {
        const poolSlot = this.allocateBulletPoolSlot(occupied);
        if (poolSlot < 0) return;
        let angle = 0;
        if (p.aimMode <= 1) {
          angle = Math.fround(
            ((p.count1 & 1) ? Math.floor((i + 1) / 2) : Math.floor(i / 2) + 0.5) * angle2
          );
          if (i & 1) angle = Math.fround(-angle);
          if (p.aimMode === 0) angle = Math.fround(angle + aim);
          angle = Math.fround(angle + angle1);
        } else if (p.aimMode === 2 || p.aimMode === 3) {
          if (p.aimMode === 2) angle = aim;
          angle = Math.fround(angle + (i * NATIVE_TAU_F32) / p.count1);
          angle = Math.fround(j * angle2 + angle1 + angle);
        } else if (p.aimMode === 4 || p.aimMode === 5) {
          if (p.aimMode === 4) angle = aim;
          angle = Math.fround(angle + NATIVE_PI_F32 / p.count1);
          angle = Math.fround(angle + (i * NATIVE_TAU_F32) / p.count1);
          angle = Math.fround(angle + angle1);
        } else if (p.aimMode === 6) {
          const span = Math.fround(angle1 - angle2);
          angle = Math.fround(game.rng.range(span) + angle2);
        } else if (p.aimMode === 7) {
          // TH08 mode 7 is the aimed fan plus random speed (spec 0x5f §3).
          angle = aim;
          angle = Math.fround(angle + (i * NATIVE_TAU_F32) / p.count1);
          angle = Math.fround(j * angle2 + angle1 + angle);
        } else {
          const span = Math.fround(angle1 - angle2);
          angle = Math.fround(game.rng.range(span) + angle2);
        }
        angle = normalizeNativeAngleF32(angle);
        const spd = p.aimMode === 7 || p.aimMode === 8
          ? Math.fround(game.rng.range(Math.fround(speed1 - speed2)) + speed2)
          : speed;
        // FUN_00421e90 stores nominal speed/angle as f32, stages
        // speed*DAT_0056baa8 through a temporary f32 argument, then
        // FUN_004074e0 writes each FSINCOS product to f32 vx/vy fields.
        const scaledSpeed = Math.fround(spd * rate);
        const vx = Math.fround(Math.cos(angle) * scaledSpeed);
        const vy = Math.fround(Math.sin(angle) * scaledSpeed);
        if (!rect) rect = this.bulletRect(p.sprite, p.offset);
        const flags = p.flags | 0;
        // Flags select authored TH08 etama spawn states 2/3/4. The state
        // lifetime comes from that prototype's flash script.
        const hasSpawnState = (flags & 0xe) !== 0;
        const spawnDuration = !hasSpawnState ? 0 : this.th08FlashDuration(p.sprite, flags);
        // Th08.exe v1.00d BulletManager::OnUpdate (0x431240) state jump
        // table @ 0x432156: state 2 -> 0x43176e, state 3 -> 0x431880,
        // state 4 -> 0x431991, state 5 (death) -> 0x431aa2. Each block does
        // pos += vel * (1.0f/k) via FUN_0040c7d0 (fdiv of the 1.0f at
        // 0x4b4338), pushing k = 0x40000000 (=2.0f) at 0x43177e/0x431aa2,
        // 0x40200000 (=2.5f) at 0x431890, 0x40400000 (=3.0f) at 0x4319a1 —
        // i.e. creep 1/2, 1/2.5, 1/3 (the 1/4, 1/8 reading of these
        // immediates was a bit-pattern misparse: 4.0f is 0x40800000 and
        // 8.0f is 0x41000000). The empirical A/B agrees: with 1/4, 1/8 the
        // first unexpected replay hit regressed f3301 -> f998.
        const spawnMoveScale = flags & 2 ? 1 / 2 : flags & 4 ? 1 / 2.5 : flags & 8 ? 1 / 3 : 1;
        // Spawn-time rate bake-in (exe FUN_00421e90/FUN_004229f0:
        // FUN_004074e0(angle, speed * DAT_0056baa8); spec-slowmo.md §3.4) —
        // the nominal speed field stays unscaled.
        const bullet: EnemyBullet = {
          id: game.id++,
          poolSlot,
          ownerId: e.id,
          ownerSub: e.ecl.subId,
          spawnFrame: game.frame,
          effectState: 0,
          // Spawn states 2/3/4 back the copied f32 origin up by four stored
          // velocity vectors.  Each multiply and subtract is separately
          // fstp'd to f32 in FUN_00421e90 @ 0x4225cf..0x422900.
          x: spawnDuration
            ? Math.fround(shootX - Math.fround(vx * 4))
            : shootX,
          y: spawnDuration
            ? Math.fround(shootY - Math.fround(vy * 4))
            : shootY,
          vx,
          vy,
          speed: spd,
          angle,
          age: 0,
          flags,
          sprite: p.sprite,
          spriteOffset: p.offset,
          rect,
          // FUN_004256d0 initializes template +0x1d6 from its offset-0
          // +0x1d4 shape. FUN_00421e90 changes the live shape for FIRE's
          // color offset without changing this backup, which matters for a
          // template-6 bullet spawned after slowmo has already begun.
          slowmoShapeBackupRect: this.bulletRect(p.sprite, 0),
          // TH08 hitboxes are PROTOTYPE-derived (main script id + base
          // sprite height, AddedCallback @ all.c:24344-24420), never
          // per-offset.
          grazeW: this.th08BulletHitbox(p.sprite),
          grazeH: this.th08BulletHitbox(p.sprite),
          grazed: false,
          spawnAge: 0,
          spawnAgeFrac: 0,
          spawnDuration,
          spawnMoveScale,
          exFlags: 0,
          exSlots: p.exSlots.map((slot) => slot ? { ...slot } : null),
          exFireFlags: flags,
          exBehaviorIndex: 0,
          exRampElapsed: 0,
          exRampFrac: 0,
          exAccel: null,
          exAccelElapsed: 0,
          exAccelFrac: 0,
          exAngle: null,
          exAngleElapsed: 0,
          exAngleFrac: 0,
          exDir: null,
          exDirElapsed: 0,
          exDirFrac: 0,
          exBounce: null,
          dirTimes: 0,
          exBounceTimes: 0,
          graceFrames: 0,
          offscreenFrames: 0
        };
        game.traceReplayEvent?.({
          kind: 'bullet-spawn', frame: game.frame, enemyId: e.id,
          enemySlot: e.poolSlot, sub: e.ecl.subId, bulletSlot: poolSlot,
          data: {
            id: bullet.id, x: bullet.x, y: bullet.y, angle: bullet.angle,
            speed: bullet.speed, vx: bullet.vx, vy: bullet.vy,
            sprite: bullet.sprite, offset: bullet.spriteOffset,
            flags: bullet.flags, spawnDuration: bullet.spawnDuration,
            exFlags: bullet.exFlags
          }
        });
        // FUN_00421e90 calls FUN_004229f0 once after copying the queue into
        // the allocated fixed slot. Spawn-state bullets wait until their ANM
        // transition before the bullet manager promotes another slot.
        advanceBulletExBehavior(bullet, game.slowRate ?? 1, {
          playSfx: (id: number) => game.playSfx(id),
          transformPrototype: (b, proto, shift) => this.th08BulletTransform(b, proto, shift)
        });
        if (game.addEnemyBullet) {
          if (!game.addEnemyBullet(bullet)) return;
        } else {
          game.enemyBullets.push(bullet);
        }
      }
    }
    // Template bit 0x200 is the sole firing-sound gate.
    if (p.flags & 0x200) game.playSfx(p.sfx);
  }

  // Mark a trash mob for the normal manager death path. FUN_004217c0 runs
  // inside one enemy slot's ECL dispatch, so later slots still execute their
  // core once before FUN_0041ed50 observes hp <= 0 and enters the callback.
  // Eagerly entering the callback here skipped those later-slot instructions
  // (Stage 1 PRE8061 lost three op9 draws after Letty's op91 sweep).
  private clearNonBossEnemy(
    game: GameHost,
    enemy: Enemy,
    sweepItems: boolean
  ): Array<{ x: number; y: number; z: number }> {
    enemy.hp = 0;
    const s = enemy.ecl;
    const drops: Array<{ x: number; y: number; z: number }> = [];
    if (sweepItems && s.sweepItemFlag) {
      drops.push({ x: enemy.x, y: enemy.y, z: enemy.z });
      // Th07.exe (v1.00b) FUN_004217c0 @ 0x421863-0x42196d walks an
      // op138 actor's stored trail at indices 0,6,12,... < trailCount and
      // creates another type-6/mode-1 item at every sampled position. The
      // popup/score ramp advances once per trail item too. Stage 1's three
      // Sub41 helpers each contribute six such samples at the pre-dialogue
      // sweep; omitting them left the run 18 Cherry items short and delayed
      // the final Border by about 545 frames despite an exact RNG stream.
      if (s.trailFlags !== 0) {
        const limit = Math.min(96, s.trailCount, s.trailHistory.length);
        for (let i = 0; i < limit; i += 6) {
          const point = s.trailHistory[i];
          drops.push({ x: point.x, y: point.y, z: point.z });
        }
      }
      for (const drop of drops) game.spawnItem('time', drop.x, drop.y, { state: 1 });
    }
    // Th07.exe (v1.00b) FUN_004217c0 @ 0x421925-0x42195f: the normal
    // manager death switch handles interactable enemies after hp becomes 0,
    // but an op116-disabled helper cannot enter that switch. The sweep enters
    // its death callback directly and consumes the callback handle here.
    // This is only a raw FUN_0040d6d0 cursor entry: unlike killEnemy's retained
    // death path it does not reset rank/fire templates or the periodic slot.
    if (!s.interactable && s.deathCallbackSub >= 0) {
      const callback = s.deathCallbackSub;
      s.deathCallbackSub = -1;
      this.enterSub(s, callback);
    }
    return drops;
  }

  // Th07.exe FUN_004217c0 (op94's handler, also called at op91/spell-end
  // and boss nonspell death): sweeps every live non-boss enemy — hp = 0
  // always; enemies flagged by op136 (`+0x2e29` bit5) additionally drop an
  // auto-collecting cherry item (type 6, mode 1) with an escalating value
  // popup: 2000 + 30 per drop, capped at 8000, all summed into a running
  // total the CALLER may (op91/boss death: score += total/10, all.c:6632/
  // 14343) or may not (op94: return discarded, all.c:9029) bank as score.
  // Pass startTotal to run the item sweep and continue that accumulator;
  // omit it for an itemless clear (spell-timeout op91, phase transitions —
  // the exe has no engine-side helper sweep on those paths).
  killNonBossEnemies(
    game: GameHost,
    owner: Enemy | null = this.executingEnemy,
    startTotal?: number,
    valueCap = 8000
  ): number {
    const sweepItems = startTotal !== undefined;
    let total = startTotal ?? 0;
    let value = 2000;
    for (const enemy of game.enemies) {
      if (enemy === owner || enemy.ecl.isBoss) continue;
      // TH08 sweep gate (FUN_0042efb0(8000,0), all.c:22367): only active,
      // non-intangible (flags bit1), non-exempt (flags2 bit6) enemies are
      // swept — controllers like stage-1's ambient Sub14 set bit6 via
      // ins_80(56) and must survive boss entries.
      const t8 = enemy.ecl.th08;
      if (t8 && ((t8.flags & 2) !== 0 || (t8.flags2 & 0x40) !== 0)) continue;
      const drops = this.clearNonBossEnemy(game, enemy, sweepItems);
      for (const drop of drops) {
        // FUN_004217c0: escalating popup per swept drop — white while
        // ramping, yellow at the cap (spec-popups.md §4.2).
        game.spawnScorePopup?.(value, drop.x, drop.y, value < valueCap ? 0xffffffff : 0xffffff00);
        total += value;
        value = Math.min(valueCap, value + 30);
      }
    }
    return total;
  }

  private clearNonBossEnemies(game: GameHost, owner: Enemy): void {
    for (const enemy of game.enemies) {
      if (enemy === owner || enemy.ecl.isBoss) continue;
      const t8 = enemy.ecl.th08;
      if (t8 && ((t8.flags & 2) !== 0 || (t8.flags2 & 0x40) !== 0)) continue;
      this.clearNonBossEnemy(game, enemy, false);
    }
  }

  private executingEnemy: Enemy | null = null;

  // Recompute bossRegistered + setBossPresent from the live bossSlots table.
  // Slot 0 is the primary (UI marker / damageBoss target); if empty, fall
  // through to the lowest occupied slot. No occupied slots → clear.
  private syncBossPresence(game: GameHost): void {
    let primary: Enemy | null = null;
    let any = false;
    for (let i = 0; i < this.bossSlots.length; i++) {
      const b = this.bossSlots[i];
      if (!b || b.dead) continue;
      any = true;
      if (primary == null || i === 0) primary = b;
      if (i === 0) break;
    }
    this.bossRegistered = any;
    game.setBossPresent?.(any, primary);
  }

  // FUN_0041ed50 writes DAT_00495bf4 directly on boss death transitions;
  // the registered slot remains live so callback ECL and remote interrupts
  // can still address the actor during its transition.
  private clearBossPresence(game: GameHost): void {
    this.bossRegistered = false;
    game.setBossPresent?.(false, null);
  }

  // Must be called whenever an enemy is removed from the game for any reason,
  // so boss slots and presence flags don't go stale.
  releaseEnemy(game: GameHost, e: Enemy): void {
    const s = e.ecl;
    this.logLifecycle(game, 'release', e);
    game.releaseEnemyEffects?.(e.id);
    if (s.bossSlot != null && this.bossSlots[s.bossSlot] === e) {
      this.bossSlots[s.bossSlot] = null;
    }
    // Only clear presence if no other slot still holds a live boss — a
    // helper in slot 1/2/3 dying must not blank the main boss in slot 0.
    if (s.isBoss) this.syncBossPresence(game);
  }

  killEnemy(game: GameHost, e: Enemy, bombContactThisFrame = false): boolean {
    const s = e.ecl;
    const t = s.th08;
    // FUN_0041ed50 @ 0x420005 gates death only on hp <= 0 and op116's
    // interactable bit. op132 invisibility has no bearing on lifecycle.
    if (!s.interactable || (t && (t.flags2 & 8) !== 0)) return true;
    // TH08 v1.00d FUN_0041ed50 @ all.c:21620 sets enemy+0x3328 bit 3
    // before branching on death mode. Modes 1-3 retain the actor to execute
    // its callback, so this manager-owned latch prevents the same hp<=0
    // actor from settling score, drops and effects every following frame.
    if (t) t.flags2 |= 8;
    game.traceReplayEvent?.({
      kind: 'enemy-kill', frame: game.frame, enemyId: e.id,
      enemySlot: e.poolSlot, sub: s.subId,
      data: { x: e.x, y: e.y, hp: e.hp, bombContact: bombContactThisFrame }
    });
    this.logLifecycle(game, 'kill', e, s.deathMode & 7);

    for (const threshold of s.lifeThresholds) threshold.threshold = -1;
    s.timerCallbackThreshold = -1;
    s.timerCallbackSub = -1;
    // Death dispatch preamble clears the op144 periodic slot too
    // (all.c:14309; the callback-entry tail repeats it at 14384).
    s.periodicSub = null;

    // TH08's death mode lives in enemy flags bits 20-22, written by ins_129.
    const mode = ((t?.flags ?? 0) >> 20) & 7;
    // all.c:14318-14323 clears presence for boss modes 0/1; case 3 clears it
    // unconditionally at all.c:14367. Mode 2 deliberately leaves it set.
    if (((mode === 0 || mode === 1) && s.isBoss) || mode === 3) {
      this.clearBossPresence(game);
    }
    if (mode === 0 || mode === 1) {
      // The ECL spawn score is stored at enemy+0x2bc0 in display*10 units;
      // FUN_0041ed50 adds that value / 10 for modes 0 and 1 only. TH08's
      // addScore (FUN_004181f0) already divides by 10 — pass the raw value
      // there so the kill credit isn't divided twice.
      game.addScore(e.score || 0);
    }
    if (mode === 1) s.interactable = false;
    if (mode === 3) {
      // Special boss-death transition: retain the actor at 1 HP, disable
      // damage, and make its next scripted zero-HP death a mode-0 removal.
      e.hp = 1;
      s.canTakeDamage = false;
      s.deathMode = 0;
    } else {
      // FUN_0041ed50's preburst and item constructor are interleaved before
      // the boss field sweep and before the common death effects. This order
      // is load-bearing because every effect veto shares the gameplay RNG.
      this.spawnDeathDropAndPreburst(game, e, bombContactThisFrame);
      if (s.isBoss) {
        if (!this.spellActive) {
          let total = game.sweepBulletsToItems();
          total = this.killNonBossEnemies(game, e, total);
          if (total > 0) game.addScore(total);
        }
        // During an active spell the death switch deliberately leaves the
        // bullet field alone. Mode-1 bosses retain their slot and enter the
        // authored death-callback sub; its op91 runs on the following enemy
        // tick and performs FUN_00423100's scored bullets-to-items sweep.
        // Clearing here one frame early discarded the entire field before
        // op91 could convert it (Th07.exe v1.00b all.c:14318-14398, then
        // FUN_0040f340 @ 0x40f340).
      }
    }
    // Op 105 is an immediate PlaySE. A callback's own op105 plays separately
    // when that sub runs; this is the generic enemy-death request.
    // Exe death SE (TH07 disasm @ 0x420379; TH08's own site 0x42d9c0):
    // slot 2 + (counter & 1) — plain kills alternate se_enep00's two
    // volume slots (-1200/-1500 mB). The TH08 46-channel id table keeps
    // the doubled pair at ids 2/3 (bank clones of se_enep00, .data
    // 0x4c8040), resolving the earlier "+2 bank-site" discrepancy.
    game.playSfx(2 + (e.id & 1));
    if (mode === 3 && s.deathAnm1 >= 0) {
      game.spawnEffectParticles(s.deathAnm1, e.x, e.y, 3, 0xffffffff);
    }
    if (s.deathAnm1 >= 0) {
      game.spawnEffectParticles(s.deathAnm1, e.x, e.y, 1, 0xffffffff);
      game.spawnEffectParticles(s.deathAnm2 + 4, e.x, e.y, 4, 0xffffffff);
    }
    game.spawnEnemyDeathEffect?.(e, mode);

    const callback = s.deathCallbackSub;
    s.deathCallbackSub = -1;
    // Mode 0 clears the enemy slot's active bit (+0x2e28 bit7, all.c:14313)
    // BEFORE the common tail enters the callback sub (FUN_0040d6d0 @
    // all.c:14393) — and the master loop skips inactive slots outright
    // (`if (-1 < *(char*)(enemy+0x2e28)) goto end` @ all.c:14039), so the
    // entered callback never executes for mode 0. Adjudicated twice
    // (2026-07-11): the dispatch IS reached, the sub does NOT run.
    if (mode === 0) return false;
    if (callback >= 0) {
      // FUN_0041ed50 death-callback entry, Th07.exe v1.00b
      // @ 0x4203de-0x420411 (all.c:14373-14379): every retained callback
      // actor receives the same rank-template reset as a boss phase entry
      // before its callback ECL runs. This also applies to ordinary mode-1
      // enemies; Stage-4 Sub17's death callback immediately fires bullets
      // whose native rank-32 speed is raw+0.5, not the fresh-enemy +0.15.
      s.bulletRankSpeedLow = -0.5;
      s.bulletRankSpeedHigh = 0.5;
      s.bulletRankAmount1Low = 0;
      s.bulletRankAmount1High = 0;
      s.bulletRankAmount2Low = 0;
      s.bulletRankAmount2High = 0;
      this.resetFireTemplateState(s);
      s.stack.length = 0;
      s.periodicExportArmed = false;
      this.enterSub(s, callback);
    }
    // Modes 1-3 retain the actor for their scripted death/phase transition.
    return true;
  }

  private spawnDeathDropAndPreburst(
    game: GameHost,
    e: Enemy,
    bombContactThisFrame: boolean
  ): void {
    // TH08 routes death drops through FUN_0042bea0 (all.c:20959): the
    // item-drop mode (+0x3304, ECL var 10092) picks the branch: >=0 spawns
    // that item type, -1 is the 1-in-3 global random drop, <=-2 (the
    // default) drops nothing; +0x330c adds that many ±64px jittered sub-drops.
    this.spawnDeathDropTh08(game, e, bombContactThisFrame);
  }

  // TH08 death drop (FUN_0042bea0 @ all.c:20959). Item types are the TH08
  // ItemType enum ids (ItemManager.hpp): 0 powerSmall, 1 point, 2 powerBig,
  // 3 bomb, 4 powerFull, 5 extend, 6 pointStar, 7 time, 8 pointSmall, 9,
  // 10 time2.
  private spawnDeathDropTh08(game: GameHost, e: Enemy, bombContactThisFrame: boolean): void {
    const t = e.ecl.th08;
    const itemDrop = e.ecl.itemDrop;
    const spawnMode = bombContactThisFrame ? 1 : 0;
    if (itemDrop < 0) {
      if (itemDrop === -1) {
        // 1-in-3 global random drop: DAT_00f54ce0 counter % 3, type from the
        // 32-entry table DAT_004c70d8 cycled by DAT_00f54ce2.
        if (this.randomSpawnIndex % 3 === 0) {
          game.spawnEffectParticles((t?.dropEffectId ?? 0) + 4, e.x, e.y, 6, 0xffffffff);
          const typeId = TH08_DROP_TABLE[this.randomItemIndex++ % TH08_DROP_TABLE.length];
          game.spawnItem(TH08_ITEM_TYPES[typeId] ?? 'point', e.x, e.y, { state: spawnMode });
        }
        this.randomSpawnIndex++;
      }
    } else {
      game.spawnEffectParticles((t?.dropEffectId ?? 0) + 4, e.x, e.y, 3, 0xffffffff);
      const type = TH08_ITEM_TYPES[itemDrop];
      if (type) game.spawnItem(type, e.x, e.y, { state: spawnMode });
    }
    // +0x330c: extra jittered sub-drops (frand*128-64 per axis, one raw draw
    // choosing power(0) vs point(1) per drop), then the field zeroes.
    const extra = t?.deathDropB ?? 0;
    if (extra > 0) {
      for (let i = 0; i < extra; i++) {
        const x = Math.fround(e.x + game.rng.f() * 128 - 64);
        const y = Math.fround(e.y + game.rng.f() * 128 - 64);
        const typeId = game.rng.u16() < 0x80 ? 0 : 1;
        game.spawnItem(TH08_ITEM_TYPES[typeId] ?? 'point', x, y, { state: spawnMode });
      }
      if (t) t.deathDropB = 0;
    }
    // +0x3308 (deathDropA, ins_144): each drop is a POINT item (type 1) at
    // a frand*128-64 jittered position — two frand draws per item, no type
    // draw (all.c:21030-21043). The point-item economy's second tap.
    const extraA = t?.deathDropA ?? 0;
    if (extraA > 0) {
      for (let i = 0; i < extraA; i++) {
        const x = Math.fround(e.x + game.rng.f() * 128 - 64);
        const y = Math.fround(e.y + game.rng.f() * 128 - 64);
        game.spawnItem(TH08_ITEM_TYPES[1] ?? 'point', x, y, { state: spawnMode });
      }
      if (t) t.deathDropA = 0;
    }
  }

  // =========================================================================
  // TH08 vertical-slice interpreter (Th08.exe v1.00d).
  //
  // Evidence base: reference/re-specs/th08-ecl-ops-0x00-0x2f.md,
  // th08-ecl-ops-0x30-0x5e.md, th08-ecl-ops-0x5f-0x8f.md,
  // th08-ecl-ops-0x90-0xb7.md and th08-bullet-anm.md (all decoded from the
  // Ghidra export of Th08.exe, cross-checked against the raw stage ECLs and
  // etama.anm). Case comments cite exe anchors inline.
  //
  // Numbering: cases below use RAW TH08 opcodes (= thanm's ins_N decimal).
  // The interpreter switch in the exe keys on opcode-1 (all.c:10803).

  // ---- TH08 variable system ----------------------------------------------

  private varRead8(game: GameHost, e: Enemy, id: number, _asFloat: boolean): number {
    const s = e.ecl;
    const t = s.th08!;
    if (id >= 10000 && id <= 10007) return s.vars[id - 10000];
    if (id >= 10016 && id <= 10023) return s.vars[8 + (id - 10016)];
    if (id >= 10036 && id <= 10039) return s.vars[16 + (id - 10036)];
    if (id >= 10053 && id <= 10056) return s.vars[20 + (id - 10053)];
    if (id >= 10057 && id <= 10060) return s.vars[24 + (id - 10057)];
    if (id >= 10008 && id <= 10015) return t.enemyInts[id - 10008];
    if (id >= 10024 && id <= 10031) return t.enemyFloats[id - 10024];
    // 10061-10068: the eight run-global floats (DAT_004ece20..3c).
    if (id >= 10061 && id <= 10068) return this.th08RunFloats[id - 10061];
    if (id >= 10088 && id <= 10093) return t.scratch88[id - 10088];
    if (id >= 10094 && id <= 10095) return s.vars[28 + (id - 10094)];
    switch (id) {
      // The RNG vars draw from the shared 16-bit generator FUN_0043ecc0
      // ((s^0x9630)+0x9aad, rotate-left-2) — the same stream as TH07.
      // FUN_0043ed20 assembles one u32 from TWO draws (first draw high,
      // all.c:29910-29918), so every 32-bit-flavored read below consumes
      // two draws; 10082 routes through FUN_0040d390 -> FUN_0043ed50 and is
      // therefore also a two-draw read (all.c:14627, 5411-5419).
      case 10032:
        return (((game.rng.u16() << 16) | game.rng.u16()) & 0x7fffffff) >>> 0;
      case 10033:
        return ((game.rng.u16() << 16) | game.rng.u16()) / 4294967296;
      case 10034:
        return (((game.rng.u16() << 16) | game.rng.u16()) | 0);
      case 10035:
        return ((game.rng.u16() << 16) | game.rng.u16()) / 2147483648 - 1;
      case 10082:
        return (game.rng.u16() << 16 | game.rng.u16()) / 4294967296 * 6.2831854820251465 - 3.1415927410125732;
      case 10040: return game.difficulty;
      case 10041: return game.rank;
      // 10042-10044: enemy x/y/z. Writes land on the ECL position; reads see
      // the same position (the render-position distinction is a TH08 exe
      // internal refreshed from it every dispatch).
      case 10042: return e.x;
      case 10043: return e.y;
      case 10044: return e.z;
      case 10045: return game.player.x;
      case 10046: return game.player.y;
      case 10047: return 0; // player z
      case 10048: return nativeAngleTowardPlayer(game.player.x, game.player.y, e.x, e.y);
      case 10050: return Math.hypot(game.player.x - e.x, game.player.y - e.y, -e.z);
      case 10051: return e.hp; // bullet pool (Th08 replaces plain HP)
      case 10069: return t.movement.angle;
      case 10070: return t.movement.angularVelocity;
      case 10071: return t.movement.speed;
      case 10072: return t.movement.acceleration;
      case 10073: return t.movement.orbitSpeed;
      case 10074: return t.movement.origin.x;
      case 10075: return t.movement.origin.y;
      case 10076: return t.movement.origin.z;
      case 10077: return t.movement.orbitAngle;
      case 10078: return t.movement.orbitAngularVelocity;
      case 10079: return t.movement.displacement.x;
      case 10080: return t.movement.displacement.y;
      case 10081: return t.movement.displacement.z;
      case 10085: return t.movement.positionOffset.x;
      case 10086: return t.movement.positionOffset.y;
      case 10087: return t.movement.positionOffset.z;
      // 10099 (resolver case 0x2773): the replay-playback flag read — zero in
      // live play (which is what the recorded run was), so live-path
      // conditionals match the recording. A future T8RP browser playback
      // must revisit this (native reads DAT_0164d0b4's bits 9/2).
      case 10099: return 0;
      // 10098 has NO case in the exe's own float resolver (all.c:14691 falls
      // to the literal default) — boss sub37's op50 compares it against 2 and
      // never matches, exactly like the literal below. Cased here only to
      // keep the console clean.
      case 10098: return 10098;
      case 10092: return s.itemDrop;
      case 10093: return e.score;
      case 10096: {
        // exe 0x2770 (all.c:14123-14138): the chain-keeper's live child
        // count — FUN_0041f000 selects enemies with no master link whose +8
        // child chain is nonempty, FUN_0041fd40 counts its +8 hops; children
        // (master link set) read 0. The chain links only familiar spawns
        // (ops 90-93), so count live familiar children of this enemy.
        let count = 0;
        if (game.enemies) {
          for (const child of game.enemies) {
            if (!child.dead && child.ecl.th08?.familiar && child.ecl.parent === e) count++;
          }
        }
        return count;
      }
    }
    if (id >= VAR_BASE && id < VAR_BASE + 100) {
      warnOnce(`r8-${id}`, `TH08 read of unmapped variable ${id}`);
    }
    // Exe float resolver default: an unmapped id returns its own literal
    // value (all.c:14691-14693).
    return id;
  }

  private varWriteInt8(game: GameHost, e: Enemy, id: number, value: number): void {
    const s = e.ecl;
    const t = s.th08!;
    const integer = Math.trunc(value);
    if (id >= 10000 && id <= 10007) { s.vars[id - 10000] = integer; return; }
    if (id >= 10036 && id <= 10039) { s.vars[16 + (id - 10036)] = integer; return; }
    if (id >= 10053 && id <= 10056) { s.vars[20 + (id - 10053)] = integer; return; }
    if (id >= 10008 && id <= 10015) { t.enemyInts[id - 10008] = integer; return; }
    if (id >= 10088 && id <= 10093) { t.scratch88[id - 10088] = integer; return; }
    if (id >= 10094 && id <= 10095) { s.vars[28 + (id - 10094)] = integer; return; }
    switch (id) {
      case 10040: game.difficulty = integer; return;
      case 10041: game.rank = integer; return;
      case 10051: e.hp = integer; return;
      case 10092: s.itemDrop = integer; return;
      case 10093: e.score = integer; return;
    }
  }

  private varWrite8(game: GameHost, e: Enemy, id: number, value: number): void {
    const s = e.ecl;
    const t = s.th08!;
    const f32 = Math.fround(value);
    if (id >= 10016 && id <= 10023) { s.vars[8 + (id - 10016)] = f32; return; }
    if (id >= 10057 && id <= 10060) { s.vars[24 + (id - 10057)] = f32; return; }
    if (id >= 10024 && id <= 10031) { t.enemyFloats[id - 10024] = f32; return; }
    // 10061-10068: the eight run-global floats (DAT_004ece20..3c), f32-stored.
    if (id >= 10061 && id <= 10068) { this.th08RunFloats[id - 10061] = f32; return; }
    if (id >= 10088 && id <= 10093) { t.scratch88[id - 10088] = f32; return; }
    if (id >= 10094 && id <= 10095) { s.vars[28 + (id - 10094)] = f32; return; }
    switch (id) {
      case 10042: e.x = f32; return;
      case 10043: e.y = f32; return;
      case 10044: e.z = f32; return;
      case 10051: e.hp = value; return;
      case 10069: t.movement.angle = s.heading = s.angle = f32; return;
      case 10070: t.movement.angularVelocity = s.angularVelocity = f32; return;
      case 10071: t.movement.speed = s.speed = f32; return;
      case 10072: t.movement.acceleration = s.acceleration = f32; return;
      case 10073: t.movement.orbitSpeed = f32; return;
      case 10074: t.movement.origin.x = f32; return;
      case 10075: t.movement.origin.y = f32; return;
      case 10076: t.movement.origin.z = f32; return;
      case 10077: t.movement.orbitAngle = f32; return;
      case 10078: t.movement.orbitAngularVelocity = f32; return;
      case 10079: t.movement.displacement.x = f32; return;
      case 10080: t.movement.displacement.y = f32; return;
      case 10081: t.movement.displacement.z = f32; return;
      case 10085: t.movement.positionOffset.x = f32; return;
      case 10086: t.movement.positionOffset.y = f32; return;
      case 10087: t.movement.positionOffset.z = f32; return;
      case 10092: s.itemDrop = Math.trunc(value); return;
      case 10093: e.score = Math.trunc(value); return;
    }
    if (id >= VAR_BASE && id < VAR_BASE + 100) {
      warnOnce(`w8-${id}`, `ignored TH08 write to unmapped variable ${id}`);
    }
  }

  // ---- TH08-only opcode dispatch -------------------------------------------

  private executeTh08(game: GameHost, e: Enemy, instr: EclInstr): 'delete' | 'flow' | 'restart' | null {
    const s = e.ecl;
    const ctx = s.ctx;
    const v = this.ecl.view;
    const a = instr.args;
    const op = instr.id;
    const gi = (o: number) => this.getInt(game, e, a + o);
    const gf = (o: number) => this.getFloat(game, e, a + o);
    const gs = (o: number) => this.getShort(game, e, a + o);
    const setIntVar = (id: number, val: number) => this.varWriteInt(game, e, id, val);
    const setFloatVar = (id: number, val: number) => this.varWrite(game, e, id, val);
    const t = s.th08!;

    switch (op) {
      case 0: return null;
      case 1: return 'delete';
      case 4: { // jump(time, relativeOffset)
        this.jumpTo(s, v.i32(a + 4), v.i32(a));
        return 'flow';
      }
      case 5: { // decrement variable and loop while positive
        const varId = v.i32(a + 8);
        const left = Math.trunc(this.varRead(game, e, varId)) - 1;
        setIntVar(varId, left);
        if (left <= 0) return null;
        this.jumpTo(s, v.i32(a + 4), v.i32(a));
        return 'flow';
      }
      case 6: setIntVar(v.i32(a), gi(4)); return null;
      case 7: setFloatVar(Math.trunc(v.f32(a)), gf(4)); return null;
      case 8: {
        const sign = (game.rng.u16() & 1) === 0 ? -1 : 1;
        setIntVar(v.i32(a), sign * gi(4));
        return null;
      }
      case 9: {
        const sign = (game.rng.u16() & 1) === 0 ? -1 : 1;
        setFloatVar(Math.trunc(v.f32(a)), sign * gf(4));
        return null;
      }
      case 3: return null; // no case 2 in the exe switch: dead opcode (spec §op3)
      case 2:
        // ins_2(n) = the TH08 ECL WAIT. Exe case 1 (asm 0x418662-0x418678)
        // SetCurrents the context's SECOND ZunTimer at ctx+0x90 — and the
        // per-instruction pass head (asm 0x418557-0x418598) gates dispatch on
        // that timer: while its current > 0, each frame Subtracts it once AND
        // Subtracts the ctx+4 instruction clock once (canceling the pass-tail
        // tick, so the instruction clock freezes) and skips the fetch. The
        // 2026-08-17 "SetCurrent on the sub clock" reading was wrong (it
        // killed every ins_2 wait loop — Wriggle's Sub42 familiar volley
        // cycle — after its first pass). waitTimer return-false already
        // freezes the clock, matching the net-zero subtract.
        ctx.waitTimer = gi(0);
        return null;
      case 160:
        // ins_160(n) = ZunTimer::SetCurrent on the ECL-MANAGER timer at
        // +0x5354 (exe case 0x9f, th08-stage1.md) — NOT the sub's clock, so
        // the sub flow is unaffected. The manager timer's consumer is
        // unproven (PROBABLE: boss-entrance/stage-clock bookkeeping); the
        // value is retained for future evidence.
        this.th08ManagerTimer = gi(0);
        return null;
      case 10: case 11: case 12: case 13: case 14: {
        // int compound-assign (exe cases 9-0xd, all.c:10884-10944): the dest
        // slot is arg0, the single source operand is arg1 — dst op= src.
        const id = v.i32(a);
        const cur = Math.trunc(this.varRead(game, e, id));
        const rhs = gi(4);
        const r = op === 10 ? cur + rhs : op === 11 ? cur - rhs : op === 12 ? cur * rhs
          : op === 13 ? (rhs ? cur / rhs : 0) : (rhs ? cur % rhs : 0);
        setIntVar(id, Math.trunc(r));
        return null;
      }
      case 15: case 16: case 17: case 18: case 19: {
        // float compound-assign (exe cases 0xe-0x12, all.c:10934-11000):
        // dst op= src, one f32 store.
        const id = Math.trunc(v.f32(a));
        const cur = this.varRead(game, e, id, true);
        const rhs = gf(4);
        const r = op === 15 ? cur + rhs : op === 16 ? cur - rhs : op === 17 ? cur * rhs
          : op === 18 ? (rhs ? cur / rhs : 0) : (rhs ? cur % rhs : 0);
        setFloatVar(id, Math.fround(r));
        return null;
      }
      case 20: setIntVar(gi(0), gi(4) + gi(8)); return null;   // int a+b
      case 21: setIntVar(gi(0), gi(4) - gi(8)); return null;   // int a-b
      case 22: setIntVar(gi(0), gi(4) * gi(8)); return null;   // int a*b
      case 23: setIntVar(gi(0), Math.trunc(gi(4) / gi(8))); return null; // int a/b
      case 24: setIntVar(gi(0), gi(4) % gi(8)); return null;   // int a%b
      case 25: setFloatVar(Math.trunc(v.f32(a)), Math.fround(gf(4) + gf(8))); return null;
      case 26: setFloatVar(Math.trunc(v.f32(a)), Math.fround(gf(4) - gf(8))); return null;
      case 27: setFloatVar(Math.trunc(v.f32(a)), Math.fround(gf(4) * gf(8))); return null;
      case 28: setFloatVar(Math.trunc(v.f32(a)), Math.fround(gf(4) / gf(8))); return null;
      case 29: setFloatVar(Math.trunc(v.f32(a)), Math.fround(gf(4) % gf(8))); return null;
      case 30: {
        const id = v.i32(a);
        setIntVar(id, Math.trunc(this.varRead(game, e, id)) + 1);
        return null;
      }
      case 31: {
        const id = v.i32(a);
        setIntVar(id, Math.trunc(this.varRead(game, e, id)) - 1);
        return null;
      }
      case 32: setFloatVar(Math.trunc(v.f32(a)), Math.fround(Math.sin(gf(4)))); return null;
      case 33: setFloatVar(Math.trunc(v.f32(a)), Math.fround(Math.cos(gf(4)))); return null;
      case 34:
        setFloatVar(
          Math.trunc(v.f32(a)),
          Math.fround(Math.atan2(gf(16) - gf(8), gf(12) - gf(4)))
        );
        return null;
      case 35: { // lerp: var = (a - b) * t + b  (FUN_00421300)
        setFloatVar(Math.trunc(v.f32(a)), Math.fround(Math.fround(gf(4) - gf(8)) * gf(12) + gf(8)));
        return null;
      }
      case 36: { // install one of the eight variable interpolators
        const target = Math.trunc(v.f32(a));
        const slot = {
          target,
          duration: gi(4),
          mode: gi(8),
          ease: gi(12),
          f0: gf(16),
          f1: gf(20),
          f2: gf(24),
          f3: gf(28),
          elapsed: 0
        };
        for (let i = 0; i < s.interpSlots.length; i++) {
          if (!s.interpSlots[i] || s.interpSlots[i]!.target === target) {
            s.interpSlots[i] = slot;
            break;
          }
        }
        return null;
      }
      case 37: {
        const target = Math.trunc(v.f32(a));
        setFloatVar(target, Math.fround(normalizeAngle(gf(0))));
        return null;
      }
      case 38: { // (xVar, yVar) = (cos, sin) * r  (all.c:11260-11288)
        const ang = normalizeNativeAngleF32(gf(8));
        const r = gf(12);
        setFloatVar(Math.trunc(v.f32(a)), Math.fround(Math.cos(ang) * r));
        setFloatVar(Math.trunc(v.f32(a + 4)), Math.fround(Math.sin(ang) * r));
        return null;
      }
      case 39: { // 2D distance (all.c:11289-11324)
        const dx = gf(8) - gf(16);
        const dy = gf(4) - gf(12);
        setFloatVar(Math.trunc(v.f32(a)), Math.fround(Math.hypot(dx, dy)));
        return null;
      }
      case 40: case 41: case 42: case 43: case 44: case 45:
      case 46: case 47: case 48: case 49: case 50: case 51: {
        const isFloat = (op & 1) === 1;
        const lhs = isFloat ? gf(0) : gi(0);
        const rhs = isFloat ? gf(4) : gi(4);
        const mode = (op - 40) >> 1;
        const pass = mode === 0 ? lhs === rhs : mode === 1 ? lhs !== rhs
          : mode === 2 ? lhs < rhs : mode === 3 ? lhs <= rhs
            : mode === 4 ? lhs > rhs : lhs >= rhs;
        if (!pass) return null;
        this.jumpTo(s, v.i32(a + 12), v.i32(a + 8));
        return 'flow';
      }
      case 52: { // CALL (FUN_00421bd0): push the 0x228-byte frame, then ZERO
        // the callee's vars 10053-10060 (frame+0x70) — TH07 copied the
        // run-globals there instead; TH08 has no run-global bus. The saved
        // return cursor is instr + size (the next instruction).
        if (!s.disableCallStack) {
          s.stack.push({
            ctx: { ...ctx, index: ctx.index + 1 },
            vars: s.vars.slice(),
            interps: s.interpSlots.map((x) => (x ? { ...x } : null)),
            periodicExportArmed: s.periodicExportArmed
          });
        }
        this.enterSub(s, v.i32(a));
        s.vars.fill(0, 20, 28);
        return 'flow';
      }
      case 53: { // RETURN (FUN_00421cb0)
        const frame = s.stack.pop();
        if (!frame) return 'restart';
        ctx.subId = frame.ctx.subId;
        ctx.index = frame.ctx.index;
        ctx.time = frame.ctx.time;
        ctx.timeFrac = frame.ctx.timeFrac;
        ctx.waitTimer = frame.ctx.waitTimer;
        s.vars.set(frame.vars);
        s.interpSlots = frame.interps;
        s.periodicExportArmed = frame.periodicExportArmed;
        return 'flow';
      }
      case 54: case 58: // setMainAnm: 54 = common enemy.anm, 58 = stage stgNenm.anm
        // Th08.exe resolves the script against the file the op selects, then
        // latches that choice in flags2 bit 2 (asm 0x419850/0x419acc).
        t.flags2 = op === 58 ? t.flags2 | 4 : t.flags2 & ~4;
        this.setCurrentAnm(e, v.i32(a));
        return null;
      case 55: case 59: { // setDirectionAnmRun(base) (59 = auto-dir on)
        // FUN_00421de0 writes six u16 pose scripts in an interleaved field
        // order (enemy+0x3332 = base+0, +0x3334 = base+3, +0x3336 = base+4,
        // +0x3338 = base+1, +0x333a = base+2, +0x333c = base+5).
        const base = v.i32(a);
        s.anmExDefaults = base;
        s.anmExFarLeft = base + 3;
        s.anmExLeft = base + 4;
        s.anmExRight = base + 1;
        s.anmExFarRight = base + 2;
        s.anmExFlags = 0xff;
        t.flags2 = op === 59 ? t.flags2 | 4 : t.flags2 & ~4;
        return null;
      }
      case 57: case 61: { // setSubAnm(index, script): TH08 has TWO slots
        // (enemy+0x2b0 + i*0x2a4); script < 0 disables via u16 0xFFFF. 57
        // resolves against the common file, 61 against the stage file.
        t.flags2 = op === 61 ? t.flags2 | 4 : t.flags2 & ~4;
        const slot = v.i32(a) | 0;
        const script = v.i32(a + 4);
        if (slot === 0 || slot === 1) {
          s.anmSlots[slot] = script < 0 ? null : { script, runner: this.makeEnemyAnmRunner(script, undefined, this.enemyAnmFor(s)) };
        }
        return null;
      }
      case 62: // re-apply the last direction pose (all.c:11477-11484)
        if (s.anmExDefaults >= 0) this.setCurrentAnm(e, s.anmExDefaults + 5);
        return null;
      case 63: { // setPos(x, y) + armed player clamp (FUN_0042c180)
        e.x = gf(0);
        e.y = gf(4);
        e.z = 0;
        this.applyTh08PlayerClamp(game);
        return null;
      }
      case 64: { // interpolate position to (x, y) over `duration` frames,
        // easing `mode` (FUN_00420f40 -> FUN_00422c40 mode 2)
        const duration = gi(0);
        const mode = gi(4);
        const tx = gf(8);
        const ty = gf(12);
        if (duration <= 0) {
          e.x = tx;
          e.y = ty;
          e.z = 0;
          this.setTh08MovementMode(s, 0);
        } else {
          // The displacement is relative to the render-position snapshot
          // (+0x2d88), while the interpolation origin copies +0x2d34.
          this.armTh08InterpolatedMotion(
            s,
            e,
            duration,
            mode,
            Math.fround(tx - t.loopHeadX),
            Math.fround(ty - t.loopHeadY),
            Math.fround(-e.z),
            true
          );
        }
        return null;
      }
      case 65: {
        // ins_65 arms FUN_00422c40 mode 1 and clears its stop timer.
        this.armTh08PolarMotion(s, gf(0), gf(4), 0);
        return null;
      }
      case 66: {
        // ins_66: duration<1 is the mode-1 form; otherwise FUN_00420d10
        // stores a duration-scaled displacement consumed by mode 2.
        const duration = gi(0);
        const ease = gi(4);
        const angle = normalizeNativeAngleF32(gf(8));
        const speed = gf(12);
        if (duration < 1) {
          this.armTh08PolarMotion(s, angle, speed, 0);
        } else {
          const dx = Math.fround(Math.cos(angle) * speed * duration);
          const dy = Math.fround(Math.sin(angle) * speed * duration);
          this.armTh08InterpolatedMotion(s, e, duration, ease, dx, dy, 0, true, true);
        }
        return null;
      }
      case 67: { // random inward move, folded at the op-75 rect margins
        const duration = gi(0);
        const ease = gi(4);
        const speed = gf(8);
        let angle = e.x <= game.player.x
          ? Math.fround(Math.fround(game.rng.f() * NATIVE_HALF_PI_F32) - NATIVE_QUARTER_PI_F32)
          : normalizeNativeAngleF32(
              Math.fround(game.rng.f() * NATIVE_HALF_PI_F32),
              2.356194496154785
            );
        const rect = t.clampRect ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
        // FUN_00422020 repeatedly passes enemy+0x2d34 through the identity
        // accessor FUN_0040b460 before these four comparisons. Only the
        // initial left/right random fan compares against the player-X global;
        // the margin folds are based on the ENEMY position inside its armed
        // rect. Using the player position here drove Wriggle upward whenever
        // Reimu stayed below the boss arena, eventually culling the boss.
        if (e.x < rect.x1 + 96) {
          if (angle <= NATIVE_HALF_PI_F32) {
            if (angle < -NATIVE_HALF_PI_F32) angle = Math.fround(-NATIVE_PI_F32 - angle);
          } else {
            angle = Math.fround(NATIVE_PI_F32 - angle);
          }
        }
        if (rect.x2 - 96 < e.x) {
          if (NATIVE_HALF_PI_F32 <= angle || angle < 0) {
            if (-NATIVE_HALF_PI_F32 < angle && angle < 0) {
              angle = Math.fround(-NATIVE_PI_F32 - angle);
            }
          } else {
            // This branch reads the pre-existing +0x2d94 field in the exe.
            angle = Math.fround(NATIVE_PI_F32 - t.movement.angle);
          }
        }
        if (e.y < rect.y1 + 48 && angle < 0) angle = Math.fround(-angle);
        if (rect.y2 - 48 < e.y && angle > 0) angle = Math.fround(-angle);
        if (duration < 1) this.armTh08PolarMotion(s, angle, speed, 0);
        else {
          const dx = Math.fround(Math.cos(angle) * speed * duration);
          const dy = Math.fround(Math.sin(angle) * speed * duration);
          // FUN_004222b0 does not apply FUN_00420d10's bit-18 pre-flip.
          this.armTh08InterpolatedMotion(s, e, duration, ease, dx, dy, 0, false, true);
        }
        return null;
      }
      case 68: { // adjust an armed motion to aim-at-player + offset
        const angle = normalizeNativeAngleF32(
          nativeAngleTowardPlayer(game.player.x, game.player.y, e.x, e.y),
          gf(0)
        );
        t.movement.angle = s.angle = s.heading = angle;
        t.movement.speed = s.speed = Math.fround(gf(4));
        return null;
      }
      case 69: { // aimed mode-1 form / curved mode-2 form
        const duration = gi(0);
        const ease = gi(4);
        const offset = gf(8);
        const speed = gf(12);
        if (duration < 1) {
          const angle = normalizeNativeAngleF32(
            nativeAngleTowardPlayer(game.player.x, game.player.y, e.x, e.y),
            offset
          );
          this.armTh08PolarMotion(s, angle, speed, duration);
        } else {
          // The executable's >=1 branch calls FUN_00420d10 and therefore
          // treats arg2 as an absolute angle, despite the aimed short form.
          const angle = normalizeNativeAngleF32(offset);
          const dx = Math.fround(Math.cos(angle) * speed * duration);
          const dy = Math.fround(Math.sin(angle) * speed * duration);
          this.armTh08InterpolatedMotion(s, e, duration, ease, dx, dy, 0, true, true);
        }
        return null;
      }
      case 70:
        t.movement.angularVelocity = s.angularVelocity = Math.fround(gf(0));
        this.setTh08MovementMode(s, 1);
        return null;
      case 71:
        t.movement.acceleration = s.acceleration = Math.fround(gf(0));
        this.setTh08MovementMode(s, 1);
        return null;
      case 72: { // motion3 (anm, f1..f6): movement accel x/y + speeds
        const m = t.movement;
        this.resetTh08MovementTimer(s, gi(0));
        m.origin = { x: Math.fround(gf(4)), y: Math.fround(gf(8)), z: 0 };
        m.orbitAngle = Math.fround(gf(12));
        m.orbitAngularVelocity = Math.fround(gf(16));
        m.orbitSpeed = Math.fround(gf(20));
        m.orbitAcceleration = Math.fround(gf(24));
        this.setTh08MovementMode(s, 3);
        return null;
      }
      case 73: { // motionPos: accel from own position snapshot
        const m = t.movement;
        this.resetTh08MovementTimer(s, gi(0));
        m.origin = { x: Math.fround(e.x), y: Math.fround(e.y), z: Math.fround(e.z) };
        m.orbitAngle = Math.fround(gf(4));
        m.orbitAngularVelocity = Math.fround(gf(8));
        m.orbitSpeed = 0;
        m.orbitAcceleration = Math.fround(gf(12));
        this.setTh08MovementMode(s, 3);
        return null;
      }
      case 74: // speed34 (anm, s3, s4)
        this.resetTh08MovementTimer(s, gi(0));
        t.movement.orbitAngularVelocity = Math.fround(gf(4));
        t.movement.orbitAcceleration = Math.fround(gf(8));
        this.setTh08MovementMode(s, 3);
        return null;
      case 75: // player clamp rect on (flags bit 19)
        t.clampRect = { x1: gf(0), y1: gf(4), x2: gf(8), y2: gf(12) };
        t.flags |= 0x80000;
        return null;
      case 76: // player clamp rect off
        t.flags &= ~0x80000;
        return null;
      case 77: s.hitbox = { x: gf(0), y: gf(4), z: s.hitbox.z }; return null;
      case 78: s.hitbox2 = { x: gf(0), y: gf(4), z: 0 }; return null;
      case 79: { // writeFlags6 (all.c:11847-11867): inverted low bits
        const arg = gi(0);
        t.flags = (t.flags & ~(0x40 | 4 | 8))
          | ((arg & 1) === 0 ? 0x40 : 0)
          | ((arg & 2) === 0 ? 4 : 0)
          | ((arg & 4) === 0 ? 8 : 0)
          | (arg & 8 ? 0x10 : 0)
          | (arg & 0x10 ? 0x10000000 : 0);
        t.flags2 = (t.flags2 & ~0x40) | (arg & 0x20 ? 0x40 : 0);
        // The manager reads bits 6/2 through the semantic collision flags
        // (the exe's damage gate all.c:21473 and contact gate all.c:21451):
        // bit 6 = shootable by player shots/attack slots, bit 2 = body
        // contact. Stage-1 familiars FIRE(16) — both re-armed at sub entry
        // (op 92's spawn had cleared bit 2).
        s.shotCollision = (t.flags & 0x40) !== 0;
        s.collisionEnabled = (t.flags & 4) !== 0;
        return null;
      }
      case 80: case 81: { // complementary clear/set flag pairs (0x50/0x51)
        const arg = gi(0);
        const set = op === 81;
        for (let bit = 0; bit < 6; bit++) {
          if (!(arg & (1 << bit))) continue;
          const on = set === (bit < 3);
          switch (bit) {
            case 0: t.flags = on ? t.flags | 0x40 : t.flags & ~0x40; break;
            case 1: t.flags = on ? t.flags | 4 : t.flags & ~4; break;
            case 2: t.flags = on ? t.flags | 8 : t.flags & ~8; break;
            case 3: t.flags = on ? t.flags | 0x10 : t.flags & ~0x10; break;
            case 4: t.flags = on ? t.flags | 0x10000000 : t.flags & ~0x10000000; break;
            case 5: t.flags2 = on ? t.flags2 | 0x40 : t.flags2 & ~0x40; break;
          }
        }
        return null;
      }
      case 82: t.suppressRadiusSq = Math.fround(gf(0) * gf(0)); return null;
      case 83: t.flags2 = (t.flags2 & ~2) | (gi(0) & 1) << 1; return null;
      case 87: { // write a float var on a registered (boss-slot) enemy
        const slot = gi(8);
        const target = this.bossSlots[slot];
        if (target && !target.dead) {
          this.varWrite(game, target, Math.trunc(v.f32(a)), gf(4));
        }
        return null;
      }
      case 88: { // CALL variant: sub id from arg1 (raw)
        if (!s.disableCallStack) {
          s.stack.push({
            ctx: { ...ctx, index: ctx.index + 1 },
            vars: s.vars.slice(),
            interps: s.interpSlots.map((x) => (x ? { ...x } : null)),
            periodicExportArmed: s.periodicExportArmed
          });
        }
        this.enterSub(s, v.i32(a + 4));
        s.vars.fill(0, 20, 28);
        return 'flow';
      }
      case 90: { // createEnemy absolute 2D (sub, x, y, life, item, score)
        if (e.hp <= 0) return null;
        this.spawnTh08Familiar(game, {
          subId: v.i32(a), x: gf(4), y: gf(8), life: gi(12),
          item: gi(16), score: gi(20), mirrored: false, parent: e
        });
        return null;
      }
      case 91: { // createEnemy at parent's render position + (x, y)
        if (e.hp <= 0) return null;
        this.spawnTh08Familiar(game, {
          subId: v.i32(a), x: e.x + gf(4), y: e.y + gf(8), life: gi(12),
          item: gi(16), score: gi(20), mirrored: false, parent: e
        });
        return null;
      }
      case 92: { // createEnemy inheriting the parent transform: TH08 spawns
        // relative then copies origin fields + flags 0x200. The parent-side
        // matrix is the ANM transform; approximate with a plain relative
        // spawn (flagged: vertical slice has no ANM-transform inheritance).
        if (e.hp <= 0) return null;
        this.spawnTh08Familiar(game, {
          subId: v.i32(a), x: e.x + gf(4), y: e.y + gf(8), life: gi(12),
          item: gi(16), score: gi(20), mirrored: false, parent: e
        }, true);
        return null;
      }
      case 93: { // familiar child at a parent-relative 3D position
        if (e.hp <= 0) return null;
        this.spawnTh08Familiar(game, {
          subId: v.i32(a), x: e.x + gf(4), y: e.y + gf(8), z: e.z + gf(12),
          life: gi(16), item: gi(20), score: gi(24),
          mirrored: false, parent: e
        });
        return null;
      }
      case 94: { // ordinary enemy at an absolute 3D position
        if (e.hp <= 0) return null;
        this.spawnEclEnemy(game, {
          subId: v.i32(a), x: gf(4), y: gf(8), z: gf(12),
          life: gi(16), item: gi(20), score: gi(24),
          mirrored: false, parent: e
        });
        return null;
      }
      case 95:
        this.killNonBossEnemies(game, this.executingEnemy, 0);
        return null;
      case 96: case 97: case 98: case 99:
      case 100: case 101: case 102: case 103: case 104:
        return this.fireTh08(game, e, instr, op - 96);
      case 109: // re-fire the current template (0 uses in shipped data)
        if (s.bulletProps) this.spawnBullets(game, e, s.bulletProps);
        return null;
      case 105: case 106: { // auto-fire deadline (FUN_00422720's caller):
        // value + rankLerp(v/5, -v/5) (FUN_00421ba0 — same formula as TH07
        // ops 73/74). ins_105 zeroes the fire timer at arming (first volley
        // one deadline later); ins_106 starts it at FUN_00406ef0(deadline) —
        // a u32 % deadline draw (TWO u16s) — so its first volley lands
        // deadline - phase frames out.
        let iv = gi(0);
        if (iv !== 0) {
          const fifth = Math.trunc(iv / 5);
          iv = iv + fifth + Math.trunc((-2 * fifth * game.rank) / 32);
        }
        t.autoFireDeadline = iv;
        if (iv > 0 && op === 106) {
          const phase = game.rng.u32InRange(iv);
          t.autoFireNext = ctx.time + Math.max(1, iv - phase);
        } else {
          t.autoFireNext = iv > 0 ? ctx.time + iv : 0;
        }
        return null;
      }
      case 107: // capture FIREs ON (flags bit 17): ops 96-104 store their raw
        // instruction at +0x3034 for the auto-fire tick (all.c:12289-12291)
        t.flags |= 0x20000;
        s.shootDisabled = true;
        return null;
      case 108: // capture FIREs OFF
        t.flags &= ~0x20000;
        s.shootDisabled = false;
        return null;
      case 110: s.shootOffset = { x: gf(0), y: gf(4), z: 0 }; return null;
      case 111: { // bullet transform record (TH07 op-79 analog; exe case 0x6e
        // all.c:12321-12373): 6-float record at enemy+0x2e44+slot*0x18 in a
        // scattered arg order — rec[4]=arg1 (opcode/flags), rec[5]=arg2
        // (cond), rec[2]=arg3 (interval), rec[3]=arg4 (maxTimes),
        // rec[0]=arg5 (angle), rec[1]=arg6 (speed; -999.9 = keep current).
        const slot = gi(0);
        if (slot >= 0 && slot < 16) {
          s.bulletExSlots[slot] = {
            opcode: gi(4), cond: gi(8), arg3: gi(12), arg4: gi(16),
            f0: gf(20), f1: gf(24)
          };
        }
        if (s.bulletProps) s.bulletProps.exSlots = s.bulletExSlots.slice();
        return null;
      }
      case 112:
        game.cancelBulletsToItems();
        return null;
      case 113: { // FIRE on-fire trigger config (template+0x200)
        const id = v.i32(a);
        s.bulletSfx = id < 0 ? 0 : id;
        if (id < 0) s.bulletProps && (s.bulletProps.flags &= ~0x200);
        else if (s.bulletProps) s.bulletProps.flags |= 0x200;
        return null;
      }
      case 114: case 115: { // createLaser (115 aims at the player)
        this.createTh08Laser(game, e);
        return null;
      }
      case 116:
        s.laserSlotIndex = gi(0);
        return null;
      case 117: {
        const laser = s.laserSlots[gi(0)];
        if (laser) laser.angle = normalizeNativeAngleF32(laser.angle, gf(4));
        return null;
      }
      case 118: {
        const laser = s.laserSlots[gi(0)];
        if (laser) {
          laser.angle = normalizeNativeAngleF32(
            nativeAngleTowardPlayer(game.player.x, game.player.y, laser.x, laser.y),
            gf(4)
          );
        }
        return null;
      }
      case 119: {
        const laser = s.laserSlots[gi(0)];
        if (laser) {
          laser.x = Math.fround(e.x + gf(4));
          laser.y = Math.fround(e.y + gf(8));
        }
        return null;
      }
      case 120:
        return null; // native writes a vestigial is-alive result
      case 121: {
        const laser = s.laserSlots[gi(0)];
        if (laser && laser.inUse && laser.state < 2) {
          laser.state = 2;
          laser.phaseFrame = 0;
          laser.width = laser.displayWidth;
        }
        return null;
      }
      case 122: return this.declareSpellTh08(game, e, instr);
      case 123: {
        s.spellName = '';
        this.spellActive = false;
        this.currentSpellId = -1;
        const sweep = game.endBossSpell?.() ?? true;
        if (sweep) {
          let total = game.sweepBulletsToItems();
          total = this.killNonBossEnemies(game, this.executingEnemy, total);
          if (total > 0) game.addScore(total);
        } else {
          this.killNonBossEnemies(game);
        }
        return null;
      }
      case 124: {
        // aux anm/sound request (FUN_0045d660): writes the arg + enemy x into
        // a 12-channel ring. FUN_0045d660 calls NO rng (its FUN_004a3e70 is a
        // float→int helper) — a phantom u16 draw here desynced the stream by
        // one draw per op-124 (the boss spell subs fire it constantly).
        return null;
      }
      case 126: t.dynCallTable[gi(4)] = gi(0); return null;
      case 127: { // boss-slot register (>=0) / unregister (<0) — DAT_00f54cc0
        // (all.c:12664-12720, spec §127). Registering also makes the enemy
        // intangible (flags bit1) and clears its fire-suppress radius; the
        // exe's anm-interrupt/effect-VM side effects (FUN_00422bb0/
        // FUN_0042a820/FUN_00422be0) are visual-only and not modeled.
        const arg = gi(0);
        if (s.bossSlot != null && this.bossSlots[s.bossSlot] === e) this.bossSlots[s.bossSlot] = null;
        if (arg < 0) {
          s.bossSlot = null;
          s.isBoss = false;
          t.flags &= ~2;
          t.transformType = -1;
        } else {
          s.bossSlot = arg;
          s.isBoss = true;
          this.bossSlots[arg] = e;
          t.flags |= 2;
          t.transformType = arg;
          t.suppressRadiusSq = 0;
        }
        this.logLifecycle(game, 'bossSlot', e, arg);
        this.syncBossPresence(game);
        return null;
      }
      case 128: {
        // transform cloud effect: effect id 13 at the enemy position with
        // r/g/b floats (FUN_00425430). Visual family not yet ported; the
        // original draws no gameplay RNG here.
        return null;
      }
      case 129: t.flags = (t.flags & ~0x700000) | ((gi(0) & 7) << 20); return null;
      case 130: s.deathCallbackSub = v.i32(a); return null;
      case 131: { // set the bullet pool ("HP") + copies
        e.hp = gi(0);
        e.maxHp = Math.max(1, e.hp);
        t.poolCopyA = e.hp;
        t.poolCopyB = e.hp;
        return null;
      }
      case 132: game.playSfx(gi(0)); return null;
      case 133: { // phase-end thresholds (4 slots)
        const slot = gi(0);
        if (slot >= 0 && slot < 4) s.lifeThresholds[slot] = { threshold: gi(4), sub: v.i32(a + 8) };
        return null;
      }
      case 134: { // phase timer deadline + timeout sub
        s.timerCallbackThreshold = gi(0);
        s.timerCallbackSub = v.i32(a + 4);
        s.bossTimer = 0;
        s.bossTimerPrevious = -999;
        return null;
      }
      case 135: { // spawn a persistent sub-ECL context (up to 4)
        const slot = v.i32(a) | 0;
        const sub = v.i32(a + 4);
        if (slot < 0 || slot > 3) return null;
        if (sub < 0) {
          t.subContexts.length = Math.min(t.subContexts.length, slot);
          return null;
        }
        t.subContexts[slot] = {
          ctx: { subId: sub, index: 0, time: 0, timeFrac: 0, waitTimer: 0 },
          vars: s.vars.slice()
        };
        return null;
      }
      case 139:
        game.spawnEffectParticles(gi(0), e.x, e.y, gi(4), v.u32(a + 8) >>> 0);
        return null;
      case 140:
        game.spawnEffectParticles(
          gi(0), e.x, e.y, gi(4), v.u32(a + 8) >>> 0,
          { x: gf(12), y: gf(16), z: gf(20) }
        );
        return null;
      case 144: t.deathDropA = gi(0); t.deathDropB = gi(4); return null;
      case 148: {
        // SetEventIdAndAdvancePlayClock: stage play clock +30s per call
        // (DAT_0164d30c += 0x708). The clock display is a Step-2 HUD item;
        // retain the event id only.
        return null;
      }
      case 153: { // force the phase-boundary bookkeeping now
        s.timerCallbackSub = s.deathCallbackSub;
        s.bossTimer = 0;
        return null;
      }
      case 158: {
        // laser slot params (FUN_004230e0/110): color + per-slot scaling.
        // Stored on the current laser slot; the divisor semantics are
        // UNRESOLVED in the decompile (spec §op158 caveat).
        const laser = s.laserSlots[s.laserSlotIndex];
        if (laser) (laser as unknown as { color: number }).color = v.u32(a + 12) >>> 0;
        return null;
      }
      case 173: t.flags = (t.flags & ~0x40000000) | ((gi(0) & 1) << 30); return null;
      case 174: {
        // enemy effect VM (FUN_00425b70, id = arg + 0x20): ambient visual.
        game.spawnEffectParticles(gi(0) + 0x20, e.x, e.y, 1, 0xffffffff);
        return null;
      }
      case 175:
        // DAT_00f54e2c: manager-wide timeline spawn suppress (all.c:13492,
        // case 0xae). OR-ed with the boss gate by spawn ops 0-5/11/12.
        this.timelineSpawnSuppress = gi(0);
        return null;
      case 176: {
        // dialogue-mode global rework + force flag bit 30: the side bits
        // feed the TH08 dialogue presenter (Step 2c).
        t.flags |= 0x40000000;
        return null;
      }
      case 184: {
        // SetHumanYoukaiSide — the receiver is the GLOBAL side mirror
        // (singleton 0x4ea670's base dword, bit 11: `mov ecx,0x4ea670` at
        // 0x41e7da before the call), NOT the running enemy. Every boss/
        // midboss phase sub opens with ins_184(1). Consumers seen so far:
        // FUN_00416b10 gates the spell-bonus accumulator on the bit being
        // CLEAR (0x4ea670-family this) — the full consumer set stays
        // flagged in AGENTS.md §7; the write itself is recorded on the
        // run state when the host provides the hook.
        const value = (gi(0) & 1) as 0 | 1;
        game.th08SetSideMirror?.(value);
        return null;
      }
      case 145: {
        // ins_145(n) = ZunTimer::Add(n) on the context's instruction clock
        // (exe case 0x91, asm 0x41d5df-0x41d5eb: FUN_0041fdf0(ctx+4, n) =
        // FUN_00447295). Stage 2+ uses it (107x, all ins_145(1)) to nudge
        // the clock one tick ahead inside dense fire rows.
        const n = gi(0);
        const rate = game.slowRate ?? 1;
        if (rate > 0.99) {
          ctx.time += n;
        } else {
          ctx.timeFrac += n * rate;
          while (ctx.timeFrac >= 1) {
            ctx.time++;
            ctx.timeFrac -= 1;
          }
        }
        return null;
      }
      case 152: {
        // ins_152 = the stage-interp template reset (exe case 0x98, asm
        // 0x41ddae-0x41ddd1): enemy+0x337c = (i16)enemy+0x2cee and
        // SetCurrent(0) on the enemy+0x2e14 timer. Every shipped use passes
        // all-zero args (34x); the template fields have no modeled consumer
        // in the port (approximation: recorded, not executed).
        t.stageInterpTemplate = gi(0);
        return null;
      }
      default:
        warnOnce(`op8-${op}`, `unhandled TH08 ECL op ${op} (sub ${ctx.subId})`);
        return null;
    }
  }

  private armTh08PolarMotion(s: EclState, angle: number, speed: number, duration: number): void {
    const movement = s.th08!.movement;
    movement.angle = s.angle = s.heading = normalizeNativeAngleF32(angle);
    movement.speed = s.speed = Math.fround(speed);
    this.resetTh08MovementTimer(s, duration);
    this.setTh08MovementMode(s, 1);
  }

  private armTh08InterpolatedMotion(
    s: EclState,
    e: Enemy,
    duration: number,
    ease: number,
    dx: number,
    dy: number,
    dz: number,
    preFlipMirroredX: boolean,
    originFromLoopHead = false
  ): void {
    const movement = s.th08!.movement;
    let displacementX = Math.fround(dx);
    if (preFlipMirroredX && s.mirrored) displacementX = Math.fround(-displacementX);
    movement.displacement = {
      x: displacementX,
      y: Math.fround(dy),
      z: Math.fround(dz)
    };
    movement.origin = originFromLoopHead
      ? {
          x: Math.fround(s.th08!.loopHeadX),
          y: Math.fround(s.th08!.loopHeadY),
          z: Math.fround(e.z)
        }
      : { x: Math.fround(e.x), y: Math.fround(e.y), z: Math.fround(e.z) };
    this.resetTh08MovementTimer(s, duration);
    this.setTh08MovementMode(s, 2, ease);
    s.axisSpeed = { x: 0, y: 0, z: 0 };
  }

  private applyTh08PlayerClamp(game: GameHost): void {
    // FUN_0042c180 @ all.c:21039-21071: while the clamp rect is armed, every
    // op-63 setPos also clamps the PLAYER into the rect. The player-side
    // write lands with the Border Team motion wiring (Step 3); armed rects
    // stay stored meanwhile.
    void game;
  }

  // TH08 familiar (使魔) spawn wrapper for the child-spawn ops 90-93 (exe
  // cases 0x59-0x5c, all.c:12020-12117). The heavy lifting (flags bit 8,
  // side bit 11 = the player's CURRENT form, manager list 0/2, contact
  // cleared, sfx 36 se_option) lives in spawnEclEnemy so it applies BEFORE
  // the child's synchronous t0 core — the child's own FIRE re-arms contact
  // afterwards (stage-1 familiars run ins_79(16)). `posInherit` records
  // flags bit 9 (0x200, the op-92/93 origin-copy marker); our spawn
  // already resolved the child position.
  private spawnTh08Familiar(
    game: GameHost,
    opts: Omit<SpawnEclEnemyOptions, 'th08Familiar'>,
    posInherit = false
  ): Enemy | null {
    const child = this.spawnEclEnemy(game, { ...opts, th08Familiar: true });
    if (child?.ecl.th08 && posInherit) child.ecl.th08.flags |= 0x200;
    return child;
  }

  private createTh08Laser(game: GameHost, e: Enemy): void {
    // TH08 laser creation (ins_114/115) reaches here only from stages that
    // use them; stage 1 fires none. The 13-arg TH08 template maps onto the
    // TH07 EnemyLaser pool in a later pass (see th08-ecl-ops-0x5f-0x8f.md
    // §4) — flagged rather than approximated.
    void game;
    void e;
    warnOnce('th08-laser', 'TH08 laser creation (ins_114/115) is not ported yet');
  }

  private declareSpellTh08(game: GameHost, e: Enemy, instr: EclInstr): 'delete' | 'flow' | 'restart' | null {
    // ins_122 (FUN_00421280 -> FUN_004152a0): dword0 = number | variant<<16,
    // dword1 = bonus, then four inline strings — the spell NAME at byte
    // +0x14 XOR 0xAA 0xAA-padded (0x30 bytes), subtitle + two dialogue lines
    // in raw Shift-JIS after it. Bonus decay = (bonus - bonus/7)/(timer/60)
    // into the live spell-bonus field; the timer is ins_134's deadline.
    const a = instr.args;
    const v = this.ecl.view;
    const spellId = v.u16(a);
    const bonus = v.i32(a + 4);
    const bytes = v.bytes;
    const start = a + 8;
    let end = start;
    while (end < bytes.length && bytes[end] !== 0xaa && end - start < 0x30) end++;
    const decoded = new Uint8Array(end - start);
    for (let i = 0; i < decoded.length; i++) decoded[i] = bytes[start + i] ^ 0xaa;
    const name = new TextDecoder('shift_jis').decode(decoded);
    const s = e.ecl;
    s.spellName = name;
    this.spellActive = true;
    this.currentSpellId = spellId;
    const timer = s.timerCallbackThreshold > 0 ? s.timerCallbackThreshold : 60;
    const decay = Math.trunc(timer / 60) > 0
      ? Math.trunc((bonus - Math.trunc(bonus / 7)) / Math.trunc(timer / 60))
      : 0;
    game.startBossSpell?.(spellId, bonus, decay, name);
    s.th08!.spellBonus = bonus;
    s.th08!.spellDecay = decay;
    game.cancelBulletsToItems();
    return null;
  }

  // ---- TH08 FIRE -----------------------------------------------------------

  private fireTh08(game: GameHost, e: Enemy, instr: EclInstr, mode: number): 'delete' | 'flow' | 'restart' | null {
    const s = e.ecl;
    const t = s.th08!;
    const a = instr.args;
    // FUN_00422720 gates the whole fire on the bullet pool > 0 (all.c:15944).
    if (e.hp <= 0) return null;
    // Capture mode (flags bit 17, ins_107): store the raw instruction for
    // the auto-fire tick instead of executing (all.c:12245-12253).
    if (t.flags & 0x20000) {
      const raw = new Int32Array(11);
      const base = instr.args - 12; // absolute instruction start
      for (let i = 0; i < 11; i++) raw[i] = this.ecl.view.i32(base + i * 4);
      t.capturedFire = raw;
      return null;
    }
    // Var-resolve order is RNG-load-bearing (spec 0x5f §96-104): sprite,
    // count1, count2, base angle, speed1, spread, speed2, offset LAST.
    const gi = (o: number) => this.getInt(game, e, a + o);
    const gf = (o: number) => this.getFloat(game, e, a + o);
    const gs = (o: number) => this.getShort(game, e, a + o);
    const sprite = gs(0);
    const count1raw = gi(4);
    const count2raw = gi(8);
    const angle1 = gf(20);
    const speed1 = gf(12);
    const angle2 = gf(24);
    const speed2 = gf(16);
    const offset = gs(2);
    const flags = this.ecl.view.i32(a + 28);
    // Entry gates (all.c:15944-15952): tag bit 0x8000 requires enemy flag
    // bit 11, bit 0x10000 forbids it; fire is suppressed while the player
    // stands inside the squared suppress radius (op 85's field).
    if ((flags & 0x8000) !== 0 && (t.flags & 0x800) === 0) return null;
    if ((flags & 0x10000) !== 0 && (t.flags & 0x800) !== 0) return null;
    if (t.suppressRadiusSq > 0) {
      const dx = game.player.x - e.x;
      const dy = game.player.y - e.y;
      if (dx * dx + dy * dy < t.suppressRadiusSq) return null;
    }
    // Rank scaling (FUN_00422720 tail; settings bit0 gates it off — the
    // port models the default-on configuration): int rank-lerp truncates
    // the product before adding the low base; speeds floor at 0.3.
    const rank = game.rank;
    const lerpI = (lo: number, hi: number) => Math.trunc((hi - lo) * rank / 32) + lo;
    const lerpF = (lo: number, hi: number) => Math.fround(Math.fround((hi - lo) * rank) / 32 + lo);
    const count1 = Math.max(1, count1raw + lerpI(t.fireRankCount1Low, t.fireRankCount1High));
    const count2 = Math.max(1, count2raw + lerpI(t.fireRankCount2Low, t.fireRankCount2High));
    const rankSpeed = lerpF(t.fireRankSpeedLow, t.fireRankSpeedHigh);
    const props: BulletProps = {
      sprite,
      offset,
      count1,
      count2,
      speed1: speed1 !== 0 ? Math.max(0.3, Math.fround(speed1 + rankSpeed)) : 0,
      speed2: Math.max(0.3, Math.fround(speed2 + Math.fround(rankSpeed / 2))),
      angle1,
      angle2,
      flags,
      sfx: s.bulletSfx,
      exSlots: s.bulletExSlots.slice(),
      aimMode: mode
    };
    s.bulletProps = props;
    this.spawnBullets(game, e, props);
    return null;
  }

  // ---- TH08 bullet visuals ---------------------------------------------------

  // Global sequential etama.anm script index -> {entryIndex, localId}. The
  // 116 on-disk script ids are contiguous -150..-35 across six entries.
  private th08EtamaScriptMap: ({ entryIndex: number; localId: number } | undefined)[] | null = null;

  private etamaScriptByGlobalIndex(globalIndex: number): { entryIndex: number; localId: number } | null {
    if (!this.th08EtamaScriptMap) {
      const map: ({ entryIndex: number; localId: number } | undefined)[] = [];
      this.bulletAnm.entries.forEach((entry, entryIndex) => {
        for (const localId of entry.scriptIds) {
          if (localId >= -150 && localId <= -35) map[localId + 150] = { entryIndex, localId };
        }
      });
      this.th08EtamaScriptMap = map;
    }
    return this.th08EtamaScriptMap[globalIndex] ?? null;
  }

  private th08BulletHeightCache = new Map<number, number>();

  // The MAIN script's base sprite pixel height: drives the aux-VM offset
  // shift tables and the prototype hitbox. Static-cached per type.
  private th08BulletBaseHeight(type: number): number {
    const cached = this.th08BulletHeightCache.get(type);
    if (cached !== undefined) return cached;
    let height = 8;
    const proto = TH08_BULLET_PROTOTYPES[type];
    if (proto) {
      const ref = this.etamaScriptByGlobalIndex(proto[0]);
      if (ref) {
        const runner = new AnmRunner(this.bulletAnm, ref.localId, {
          entryIndex: ref.entryIndex,
          spriteIndexOffset: this.bulletAnm.entries[ref.entryIndex]?.spriteBase ?? 0
        });
        const frame = runner.spriteFrame();
        if (frame) height = frame.h;
      }
    }
    this.th08BulletHeightCache.set(type, height);
    return height;
  }

  private bulletRectTh8(type: number, offset: number): { x: number; y: number; w: number; h: number; imageKey: string } {
    const key = `t${type}:${offset}`;
    const cached = this.bulletRectCache.get(key);
    if (cached) return cached;
    const proto = TH08_BULLET_PROTOTYPES[type];
    if (!proto) {
      throw new Error(`TH08 FIRE type ${type} is outside the 21-prototype table @ 0x4b4ad8`);
    }
    const ref = this.etamaScriptByGlobalIndex(proto[0]);
    if (!ref) throw new Error(`TH08 bullet prototype ${type} main script ${proto[0]} missing in etama.anm`);
    // The engine SetSprites the Static-stopped main VM with base+offset in
    // GLOBAL sprite space (FUN_0042f5f0 @ 0x42fa87); AnmRunner expresses the
    // same shift via spriteIndexOffset.
    const runner = new AnmRunner(this.bulletAnm, ref.localId, {
      entryIndex: ref.entryIndex,
      spriteIndexOffset: (this.bulletAnm.entries[ref.entryIndex]?.spriteBase ?? 0) + offset
    });
    const frame = runner.spriteFrame();
    if (!frame) throw new Error(`missing TH08 bullet frame for type ${type} offset ${offset}`);
    const rect = { x: frame.x, y: frame.y, w: frame.w, h: frame.h, imageKey: frame.imageKey || 'etama' };
    this.bulletRectCache.set(key, rect);
    return rect;
  }

  // Hitbox half-extents + death-chain category per prototype (AddedCallback
  // @ all.c:24344-24420): derived from the MAIN script id and the BASE
  // sprite's height; the per-shot offset never changes it.
  th08BulletHitbox(type: number): number {
    const proto = TH08_BULLET_PROTOTYPES[type];
    if (!proto) return 4;
    const s = proto[0];
    const h = this.th08BulletBaseHeight(type);
    // The fnstsw parity chains at 0x43331d/0x433387 decode to inclusive
    // tiers on the VM's +0x30 sprite-size field (the same field FUN_0042fea0
    // compares against the 16/48 .rdata thresholds): v<=8 -> 4 (cat 5);
    // 8<v<=16 -> rice-family scripts {2,4,5,6,106,107,108,111,112} = 4,
    // DEFAULT 12.0 (cat 3); 16<v<=48 -> {8,113,114,115} = 5, {9,109,110}
    // = 8, default 10; v>48 -> 24 (cat 0). Only types 1 and 3 (16px
    // non-rice sprites) differ from the old table (6 -> 12).
    if (h > 48) return 24;
    if (h > 16) {
      if (s === 8 || s === 113 || s === 114 || s === 115) return 5;
      if (s === 9 || s === 109 || s === 110) return 8;
      return 10;
    }
    if (h > 8) {
      if (s === 2 || s === 4 || s === 5 || s === 6 || s === 106 || s === 107 || s === 108 || s === 111 || s === 112) return 4;
      return 12;
    }
    return 4;
  }

  private th08FlashDurationCache = new Map<number, number>();

  // Spawn-state lifetime = the prototype's flash script length, read from
  // etama.anm: state flags 2/4/8 select proto cols 1/2/3, and the duration
  // is the script's own remove/static instruction time.
  private th08FlashDuration(type: number, flags: number): number {
    const col = flags & 2 ? 1 : flags & 4 ? 2 : 3;
    const proto = TH08_BULLET_PROTOTYPES[type];
    if (!proto) return 10;
    const scriptIndex = proto[col];
    const cached = this.th08FlashDurationCache.get(scriptIndex);
    if (cached !== undefined) return cached;
    let duration = 10;
    const ref = this.etamaScriptByGlobalIndex(scriptIndex);
    if (ref) {
      const v = this.bulletAnm.view;
      let off = this.bulletAnm.scriptRefInEntry(ref.entryIndex, ref.localId).start;
      for (let guard = 0; guard < 256 && off + 8 <= v.length; guard++) {
        const op = v.u16(off);
        const len = v.u16(off + 2);
        const time = v.i16(off + 4);
        if (len < 8) break;
        if (op === 1 || op === 2) {
          // A static/remove at t0 means no transition (proto 10's main);
          // otherwise the state lasts until the remove's frame.
          duration = time > 0 ? time : (op === 2 ? 0 : 10);
          break;
        }
        off += len;
      }
    }
    this.th08FlashDurationCache.set(scriptIndex, duration);
    return duration;
  }

  // Bullet command 0x4000 (FUN_0042ffc0, all.c:23066-23074): swap the
  // bullet's prototype block (DAT_00f54e90 + proto*0xd44) and shift its live
  // sprite by spriteShift (FUN_0045e430 current+shift).
  th08BulletTransform(bullet: EnemyBullet, proto: number, spriteShift: number): void {
    if (!TH08_BULLET_PROTOTYPES[proto]) return;
    bullet.sprite = proto;
    bullet.spriteOffset = bullet.spriteOffset + spriteShift;
    bullet.rect = this.bulletRectTh8(proto, bullet.spriteOffset);
    const hb = this.th08BulletHitbox(proto);
    bullet.grazeW = hb;
    bullet.grazeH = hb;
  }
}
