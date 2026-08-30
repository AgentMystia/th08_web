import type { Rng } from '../core/rng';
import type { Anm, AnmRunner } from '../formats/anm';

// Optional verifier-only event stream. Production hosts leave the sink
// undefined, so collecting convergence evidence cannot affect simulation.
// `data` deliberately contains only scalar values so JSONL traces remain
// stable and can be compared with traces captured from Th08.exe.
export interface ReplayTraceEvent {
  kind:
    | 'timeline' | 'enemy-spawn' | 'enemy-kill' | 'ecl' | 'fire'
    | 'bullet-spawn' | 'bullet-contact' | 'graze' | 'item-spawn'
    | 'item-collect' | 'effect-spawn' | 'effect-death' | 'firefly-dot'
    | 'item-tick' | 'damage' | 'rank' | 'frame' | 'rng';
  frame: number;
  replayFrame?: number;
  enemyId?: number;
  enemySlot?: number;
  sub?: number;
  clock?: number;
  opcode?: number;
  bulletSlot?: number;
  data?: Record<string, number | string | boolean | null>;
}

export type ReplayTraceSink = (event: ReplayTraceEvent) => void;

export type ItemType =
  | 'point' | 'bomb'
  | 'powerSmall' | 'powerBig' | 'powerFull' | 'extend' | 'pointStar'
  | 'time' | 'pointSmall' | 'unknown9' | 'time2';

export interface EnemyBullet {
  id: number;
  // Stable slot in Th07.exe's fixed 0x400-entry bullet pool. Effects scan
  // this identity in slot order, independently of the browser-side array.
  poolSlot: number;
  // Spawn provenance (replay-divergence forensics: which emitter fired the
  // bullet that hit the player). Gameplay never reads these.
  ownerId: number; // Enemy.id of the emitter
  ownerSub: number; // ECL sub the emitter was running at fire time
  spawnFrame: number; // GameHost.frame at spawn
  // op-79 opcode 0x2000 grace (exe bullet+0xbf0): while it counts down the
  // off-screen cull is skipped entirely and collision keeps running — how
  // patterns park bullets outside the field before they sweep in.
  graceFrames?: number;
  // TH08 queue command 0x20000 (bullet+0xdac bit handler, all.c:23507): the
  // command ZunTimer armed by FUN_0042ffc0. The bit itself lives in exFlags
  // (native +0xdac); this counter is the timer's remaining frames. Motion
  // continues while it counts; FUN_0042ffc0 stalls on the next cond==0 slot
  // until the handler XOR-clears 0x20000.
  exWaitFrames?: number;
  // Frames spent continuously off-screen (exe bullet+0xbfe): dir-change/
  // bounce bullets (mask 0xdc0) survive up to 128 before dying; others die
  // immediately, draining any leftover count first.
  offscreenFrames?: number;
  // Shared special-effect state (bullet +0xc08). Different op121/122 effect
  // callbacks deliberately reuse it as a state, countdown, or laser id.
  effectState: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  angle: number;
  age: number;
  flags: number;
  sprite: number;
  spriteOffset: number;
  rect: { x: number; y: number; w: number; h: number; imageKey: string };
  // Native bullet+0x1d6. Templates initialize this to their offset-0 shape;
  // slowmo effect 10 overwrites it with the current shape for every live
  // bullet, and effect 11 restores it when the current shape is 0x260..26f.
  slowmoShapeBackupRect?: { x: number; y: number; w: number; h: number; imageKey: string };
  grazeW: number;
  grazeH: number;
  grazed: boolean;
  // Clock of the authored flags-selected spawn ANM state (native bullet
  // states 2/3/4). The normal-state `age` counter is reset to zero when
  // this reaches spawnDuration, exactly as FUN_004241c0 does.
  spawnAge?: number;
  spawnAgeFrac?: number;
  spawnDuration: number;
  spawnMoveScale: number;
  // Activated ex-behavior flags (exe bullet+0xbf4). FUN_004229f0 promotes
  // at most one movement slot per normal-state manager tick; construction
  // performs the first promotion and retains the remaining per-bullet queue.
  exFlags: number;
  // Snapshot of the firing enemy's five op-79 slots, the FIRE flags tested
  // against them, and the next queue index (exe +0xc14/+0xbf6/+0xc10).
  exSlots: (BulletExSlot | null)[];
  exFireFlags: number;
  exBehaviorIndex: number;
  // Per-behavior params resolved when the matching queue slot is promoted.
  // Each behavior owns the split clock/counter used by its native routine.
  exRampElapsed: number;
  exRampFrac: number;
  exAccel: {
    mag: number;
    angle: number;
    // FUN_004229f0 resolves the polar parameters once at promotion and
    // stores a float32 acceleration vector at bullet+0xccc/+0xcd0.
    vx: number;
    vy: number;
    limit: number;
  } | null; // 0x10
  exAccelElapsed: number;
  exAccelFrac: number;
  exAngle: { speedDelta: number; angleDelta: number; limit: number } | null; // 0x20
  // Dedicated elapsed counter for the 0x20 angle-change behavior (exe
  // bullet+0xcec int / +0xce8 frac, reset to 0 when the behavior is
  // promoted — FUN_004229f0 @ all.c:15499-15510). Bullet-effect id 1
  // installs 0x20 MID-LIFE, so elapsed cannot be derived from bullet age.
  exAngleElapsed: number;
  exAngleFrac: number;
  exDir: { angle: number; newSpeed: number; interval: number; maxTimes: number } | null; // 0x40/0x80/0x100
  exDirElapsed: number;
  exDirFrac: number;
  exBounce: { speed: number; maxTimes: number } | null; // 0x400/0x800
  dirTimes: number;
  exBounceTimes: number;
  // Native enemy-bullet state 5 (FUN_004241c0): bomb-clear contact does
  // not free the fixed slot immediately. The bullet becomes non-collidable,
  // moves at half velocity while its authored removal ANM runs, then releases
  // the slot. Stored as remaining logical ANM ticks; absent in normal states.
  clearFadeFrames?: number;
  clearRunner?: AnmRunner;
  // TH08 deferred quad kill (bullet+0xdbe latch): a spawn-state bullet that
  // contacts a death-clear quad converts at transition-VM completion, not on
  // the contact tick (all.c:23589-23644). Holds the contacting quad's param6
  // conversion type (player+0xe2a90 in the native); null = no pending kill.
  quadKillType?: number | null;
  dead?: boolean;
}

// One BULLET_EX (op 79) template slot on the firing enemy. op 79 writes slot
// `index` (arg0); up to 5 persist on the enemy and are snapshotted at each
// FIRE. Fields mirror the exe's queue entry pfVar1[0..5] (audit-bullet-motion
// §op79): opcode=arg1, cond=arg2, arg3=duration, arg4=maxTimes, f0/f1=floats.
export interface BulletExSlot {
  opcode: number; // 1 ramp / 0x10 accel / 0x20 angle / 0x40|0x80|0x100 dir (TH08 0x40=SET) / 0x400|0x800 bounce
  cond: number; // arg2: cond gate — a cond==0 slot activates only before any other behavior
  arg3: number; // duration / interval / limit / bounce-maxTimes
  arg4: number; // dir-change maxTimes
  f0: number; // angle / accel-mag / angle-change speedDelta / bounce-speed
  f1: number; // accel-angle / angle-change angleDelta / dir-change new-speed
}

// Th07.exe enemy laser (pool object 0x4ec bytes @ gamestate+0x366628; see
// scratchpad spec-lasers.md / re-specs exe-enemy-lasers.md). Field mapping:
// nearDist/farDist = +0x4a8/+0x4ac (live, auto-grown by speed), maxLength =
// +0x4b0, width = +0x4b4 (full), displayWidth = +0x4b8 (current on-screen),
// growDuration/holdDuration/shrinkDuration = +0x4c0/c8/cc, telegraphDelay =
// +0x4c4 (no hit test in grow before this), shrinkCutoff = +0x4d0 (no draw/
// hit in shrink after this), flags = +0x4e4 (bit0 manual width, bit2
// bomb-immune), state +0x4e8 (0 grow / 1 hold / 2 shrink), phaseFrame
// +0x4e0.
export interface EnemyLaser {
  id: number;
  // Stable slot in Th07.exe's fixed 64-entry enemy-laser pool.
  poolSlot: number;
  ownerId: number;
  inUse: boolean;
  sprite: number;
  color: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  nearDist: number;
  farDist: number;
  maxLength: number;
  width: number;
  displayWidth: number;
  growDuration: number;
  holdDuration: number;
  shrinkDuration: number;
  telegraphDelay: number;
  shrinkCutoff: number;
  flags: number;
  state: number;
  phaseFrame: number;
  // Fractional accumulator for phaseFrame under global slow motion.
  phaseFrac?: number;
  hideTipDuringGrow: boolean;
}

export interface ItemEntity {
  id: number;
  // Stable slot in Th07.exe's 1100-entry item pool. FUN_00430970 allocates
  // with a rotating next-fit cursor; FUN_00430c10 updates slots 0..1099.
  poolSlot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: ItemType;
  age: number;
  // Th07.exe item+0x27f: 0 = falling, 1 = homing toward the player (a
  // permanent latch), 2 = spawn-mode-2 positional tween (death drops).
  state: number;
  // Th07.exe item+0x280: guaranteed maximum value/color. This is distinct
  // from the +0x27f homing latch and is set when an active Border forces the
  // item into collection; ordinary PoC and pre-latched clear items leave it
  // false.
  guaranteedMax?: boolean;
  // Mode-2 tween block (exe item+0x258..+0x26c while state==2): origin and
  // target of the 60-frame lerp plus the split elapsed/frac counter
  // (+0x278/+0x274, advanced fractionally under slowmo via FUN_00436acc).
  tween?: { sx: number; sy: number; tx: number; ty: number; elapsed: number; frac: number };
  dead?: boolean;
}

export interface EffectParticle {
  id: number;
  poolSlot: number;
  effectId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color: number;
  size: number;
  kind: 'spark' | 'snow' | 'burst';
  // Border-break petals only: the exe overrides each petal's direction to
  // one of 32 fixed angles (Player.cpp:2183-2190) and flies it along it at
  // 256/30 px per frame (UpdateBurst30Frames). Visual-only.
  burstDir?: { x: number; y: number };
  ownerEnemyId?: number;
  releaseFrames?: number;
  world?: {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    ax: number; ay: number; az: number;
    angle: number; angularVelocity: number;
  };
}

// Interface the ECL VM uses to talk to the game — mirrors the TH06 Web seam
// between Th06StageRuntime and Game.
export interface GameHost {
  rng: Rng;
  difficulty: number; // 0 E, 1 N, 2 H, 3 L
  // Runtime stage number (1..8); optional for focused VM hosts.
  stageNumber?: number;
  rank: number;
  // ECL var 10028 (Th07.exe DAT_00625627): character*2 + shotType (0=ReimuA
  // TH08 Border Team selector (0 for this vertical slice).
  shotIndex?: number;
  frame: number;
  id: number;
  player: { x: number; y: number };
  enemies: Enemy[];
  enemyBullets: EnemyBullet[];
  // The bullet manager recounts fixed live slots at manager entry, before
  // updating or culling them. Enemy FIRE therefore reads the previous
  // manager-entry snapshot rather than the current dense array.
  // Lightweight VM-test hosts may omit it; the allocator still enforces the
  // physical 1024-slot limit.
  enemyBulletManagerEntryCount?: number;
  enemyLasers: EnemyLaser[];
  items: ItemEntity[];
  power: number;
  score: number;
  timeStopped?: boolean;
  // Test-only replay convergence seam. Runtime code emits events only when
  // a verifier installs this optional callback.
  traceReplayEvent?(event: ReplayTraceEvent): void;
  // Native DAT_004ca4d8, sampled for the current scheduler pass. Stage 7/8
  // boss cores use it to suppress every player-shot/attack/body collision
  // during spell ids >= 118, with a one-core-tick release tail.
  isBombActive?(): boolean;
  // Global slow-motion rate (exe DAT_0056baa8, spec-slowmo.md): 1.0 normal;
  // bullet-effect 10 writes 1/param, effect 11 restores 1.0. Continuous
  // motion multiplies by it per frame; discrete timers accumulate it
  // fractionally; collision always runs at wall clock.
  slowRate?: number;
  setSlowRate?(rate: number): void;
  // Bullet-time visual state for the global spell-background ANM VMs.
  setBulletTimeVisual?(active: boolean): void;
  addScore(v: number): void;
  spawnItem(type: ItemType, x: number, y: number, options?: { state?: number }): void;
  // seed = op118's 3-float operand (exe writes it to the particle's velocity-
  // seed field +0x96/97/98, NOT a position offset); op117 passes none. Some
  // effect types' per-particle RNG draw count branches on its x sign.
  spawnEffectParticles(
    effectId: number,
    x: number,
    y: number,
    count: number,
    color: number,
    seed?: { x: number; y: number; z: number },
    ownerEnemyId?: number
  ): void;
  releaseEnemyEffects?(ownerEnemyId: number): void;
  playSfx(id: number): void;
  // TH08 form byte (exe player+5 via FUN_0040bc40): 0 human / 1 youkai.
  // Familiar spawning, the per-tick side sync, and the ECL form-rank gate
  // read it live. Minimal test hosts may omit it.
  /** Player position as of the start of this frame. TH08 runs its calc
   * chain in descending priority (bullets 14, enemies 11, player 9), so
   * enemy FIRE aims at where the player ended the previous frame. */
  playerPosAtFrameStart?: { x: number; y: number };
  th08PlayerForm?(): 0 | 1;
  // FUN_00406d10/FUN_00406d70: true while the youkai gauge is beyond
  // either effects threshold. Native enemy deaths use this to emit one
  // state-1 time item from their common tail.
  th08GaugeExtreme?(): boolean;
  // TH08 op 184's receiver is the GLOBAL side mirror (singleton 0x4ea670
  // dword bit 11, `mov ecx,0x4ea670` @ 0x41e7da) — not the running enemy.
  th08SetSideMirror?(value: 0 | 1): void;
  startDialogue?(index: number): void;
  isDialogueActive?(): boolean;
  consumeDialogueResume?(): boolean;
  startBossSpell?(
    spellId: number,
    bonus: number,
    decayPerSecond: number,
    name: string,
    timeLimitFrames?: number
  ): void;
  // Returns whether the TH08 phase-end field sweep applies. Timeouts fade
  // the field without the scored sweep.
  endBossSpell?(opts?: { fromBossDeath?: boolean }): boolean;
  voidSpellCapture?(): void;
  setBossPresent?(present: boolean, enemy: Enemy | null): void;
  setBossLifeCount?(count: number): void;
  spawnEnemyDeathEffect?(e: Enemy, deathMode?: number): void;
  // Every live enemy bullet, plus samples along each non-immune laser,
  // becomes auto-collecting TH08 time items without an immediate popup.
  cancelBulletsToItems(): void;
  // Floating score popup; color is D3D ARGB.
  spawnScorePopup?(value: number, x: number, y: number, color: number): void;
  // Frames remaining of the exe's post-field-clear laser-spawn suppression
  // (gamestate+0x37a12c, set to 10 by every FUN_00422ea0 call; op-82/83
  // fires are gated on it unless the laser is bomb-immune, all.c:15737).
  postBombLaserCounter?: number;
  // Bullet-effect BGM cue.
  playBgmTrack?(name: string): void;
  // Bullet-effect id 19 (FUN_00418ee0): three-second BGM fade-out.
  fadeBgm?(seconds: number): void;
  // Screen FX scheduler (exe FUN_004459c0): type-1 shake (magnitude ramps
  // from->to over duration) and type-3 repeating full-screen tint flash.
  startScreenShake?(duration: number, from: number, to: number): void;
  startScreenFlash?(duration: number, repeats: number, argb: number): void;
  // TH08 night blindness (ins_136 builtin 0 → FUN_00423390): the executing
  // ECL context exports int var 10000 (intensity 0-255) and float var 10016
  // (lit radius) to DAT_004e3d28/24; FUN_00405420 (all.c:1583-1609) renders
  // the playfield darkness around the player from them. ins_123 clears the
  // intensity at spell end (all.c:9422).
  setNightBlindness?(intensity: number, radius: number): void;
  // FUN_00422ea0's laser half: graceful-cancel non-bomb-immune lasers
  // (unconditional = the bombType-10 spell-timeout variant).
  cancelLasers?(unconditional: boolean): void;
  // FUN_00423100(8000,1): like cancelBulletsToItems but each bullet also
  // pops an escalating score value (2000, +20 per bullet, capped 8000);
  // returns the summed total for the caller to bank as score/10 (op91
  // spell end, boss nonspell death).
  sweepBulletsToItems(): number;
  // FUN_0041ed50 shared-tail wipe (all.c:21659-21668): for a dying enemy
  // carrying flags2 bit1 with bit0 clear, convert every still-live enemy
  // bullet into a point item with an escalating chip (2000, +20 per bullet,
  // cap 8000), chip remaining live enemies (+30 per head), bank the grand
  // total once, and pop the raw value as the BONUS floater.
  th08DeathWipeBonus?(dead: object): void;
  configureAmbience?(op: number, args: number[]): void;
  // Boss timer callback with the ECL "timeout is normal" flag unset.
  onBossPhaseTimeout?(): void;
  unpauseStd(label: number): void;
  // Native fixed-pool registration hooks. StageScene implements these with
  // slot-faithful storage; lightweight unit-test hosts may omit them and use
  // the dense-array fallback in StageRuntime.
  addEnemy?(enemy: Enemy): boolean;
  // A t=0 op1 returned from the allocator core frees the native slot without
  // passing through the manager's release/AUX-event path.
  discardAllocatedEnemy?(enemy: Enemy): void;
  addEnemyBullet?(bullet: EnemyBullet): boolean;
  removeEnemyBullet?(bullet: EnemyBullet): void;
  clearEnemyBullets?(): void;
}

export interface EclContext {
  subId: number;
  index: number; // instruction index within sub
  time: number;
  // Fractional accumulator for the script clock under global slow motion
  // (exe: split (int, frac) counter at enemy+0x6f0/+0x6ec advanced by
  // FUN_00436acc at the DAT_0056baa8 rate; spec-slowmo.md §5).
  timeFrac: number;
  // op45 wait countdown (exe context +0x80 == enemy +0x764/+0x76c).
  // CALL saves/restores it with the rest of the 0x218-byte ECL context.
  waitTimer: number;
}

export interface EclInterpSlot {
  target: number;
  duration: number;
  elapsed: number;
  mode: number;
  ease: number;
  f0: number;
  f1: number;
  f2: number;
  f3: number;
}

// One saved call frame. Th07.exe pushes the whole 0x218-byte context block
// (+0x6e4..+0x8fb) on op41 CALL, interrupt entry, and op144 periodic entry —
// that block spans the instruction cursor, the 26 variable dwords, the op45
// wait timer, and the op27 interp slots. op42 RETURN restores all of it, so
// callee writes to locals/params/interps roll back at return.
export interface EclFrame {
  ctx: EclContext;
  vars: Float64Array;
  interps: (EclInterpSlot | null)[];
  // enemy+0x8f4 lies inside the saved 0x218-byte frame. A nested CALL from
  // an op144 body therefore restores the armed export flag for the outer
  // RETURN after the inner RETURN has temporarily cleared it.
  periodicExportArmed: boolean;
}

export interface EclState {
  ctx: EclContext;
  stack: EclFrame[];
  subId: number;
  mirrored: boolean;
  itemDrop: number;
  // TH08 child-spawn parent link (exe enemy+0x2da4): the familiar's
  // master, cleared by FUN_0042adb0's death sweep.
  parent?: Enemy | null;
  // The enemy's 26-dword ECL variable block, Th07.exe enemy+0x6fc..+0x763.
  // [0..15]  locals 10000-10015 (ints 10000-10003/10012-10015, floats
  //          10004-10011 — one shared block for every sub this enemy runs;
  //          there is NO call-window shift in the executable).
  // [16..17] extra float slots, vars 10072/10073 (+0x73c/+0x740).
  // [18..21] rand-int config, vars 10029-10032 (+0x744..+0x750): var 10056's
  //          int form reads base[19] + rng % range[18].
  // [22..25] rand-float config, vars 10033-10036 (+0x754..+0x760): var
  //          10056's float form reads base[23] + rng01()*range[22].
  // op92/93 child spawns copy the whole block from the parent (FUN_0041db60
  // copies 0x1a dwords from parent+0x6fc into the child).
  vars: Float64Array;
  axisSpeed: { x: number; y: number; z: number };
  angle: number;
  angularVelocity: number;
  speed: number;
  acceleration: number;
  shootOffset: { x: number; y: number; z: number };
  // Per-enemy laser handle table (exe enemy+0x2d8c, 32 slots) + the op-84
  // "current slot" register (+0x2e0c) that the NEXT op-82/83 fire writes
  // into. Ops 85-89/152/156-158 take their own index arg.
  laserSlots: (EnemyLaser | null)[];
  laserSlotIndex: number;
  // op27 timed float interpolators (exe enemy+0x770, 8 slots stride 0x30):
  // target = special-var-id tag, mode 0-6 = 2-point LERP, 7 = cubic Hermite
  // (f2/f3 = tangents), ease 0-6 per spec-op27-effects.md §1.3.
  interpSlots: (EclInterpSlot | null)[];
  // op122 armed per-frame bullet-effect (exe enemy+0x6f4): param re-resolved
  // live from the arming instruction each frame (paramOff = absolute byte
  // offset of arg1 in the ECL image).
  effectArm: { id: number; paramOff: number } | null;
  // FUN_00416d00 sets enemy +0x2e2b bit0 on the first effect-0 callback.
  // No instruction clears it: normal movement stays disabled for the rest
  // of this entity's lifetime, even after op122 disarms the callback.
  movementSuppressedByEffect0: boolean;
  // op144 periodic gosub (exe +0x2f58/+0x2f64/+0x2ee4): every `period`
  // frames, nested call into subId; -1 disarms.
  // op144 periodic gosub. The periodic sub runs on its own PERSISTENT
  // 26-dword variable block (exe stash at enemy+0x2ee8): loaded into the
  // live vars at each firing (all.c:7089-7095), exported back at that
  // firing's op42 return (+0x8f4 flag, all.c:10024-10032) — its state
  // carries across firings without disturbing the interrupted flow.
  periodicSub: {
    period: number;
    subId: number;
    // enemy+0x2f64/+0x2f60: integer/fraction split counter advanced by
    // FUN_00436acc. A single JS double drifts at rate 1/3.
    elapsed: number;
    elapsedFrac: number;
    savedVars: Float64Array;
  } | null;
  // The +0x8f4 flag: the next op42 exports the live vars to the stash.
  periodicExportArmed: boolean;
  // Pending interrupt-table index (exe +0x2b08), written by op109/timeline
  // op8 and drained through the op108 table at frame/interpreter top.
  pendingInterrupt: number;
  // op153 secondary shot-collision extent triple (exe +0x2b48/4c/50).
  hitbox2: { x: number; y: number; z: number } | null;
  moveMode: number;
  interpKind: number;
  interp: { start: { x: number; y: number; z: number }; delta: { x: number; y: number; z: number }; duration: number; left: number } | null;
  // Live movement heading, exe enemy+0x2b54 (recon exe-heading.md): modes
  // 2/3 + op27 position interps recompute atan2 of the frame delta every
  // frame; mode 1 carries its integrated polar angle; a stationary enemy
  // retains the last value. Read by var 10045 and the op120 draw rotation.
  heading: number;
  // mode-3 orbit group (exe +0x2b5c/60/6c/70/8c-94), see
  // reference/re-specs/exe-enemy-move-fields.md §3 Group B / §5.1.
  orbitAngle: number;
  orbitAngularVelocity: number;
  orbitSpeed: number;
  orbitAcceleration: number;
  orbitTarget: { x: number; y: number; z: number };
  // Shared movement-mode timer (+0x2ba4/+0x2ba0). Ops 56/60 use it for
  // mode 3; op59 uses the same fields for a bounded mode-1 move.
  orbitDuration: number; // 0 = never auto-stop
  orbitLeft: number;
  bulletProps: BulletProps | null;
  bulletSfx: number;
  // Th07.exe enemy+0x2ca0, written by op81 arg1 (all.c:8714). No consumer
  // has been traced; retain the exact state without inventing behavior.
  bulletSfxInterval: number;
  // op-79 template slots, indexed by arg0 (0..4). Persist across FIREs (exe
  // enemy+0x2bf4 table); snapshotted into BulletProps.exSlots at each FIRE.
  bulletExSlots: (BulletExSlot | null)[];
  shootDisabled: boolean;
  shootInterval: number;
  // enemy+0x2cb4/+0x2cb0: native split auto-fire counter. The integer and
  // fractional halves must stay separate under slowmo; repeated JS `1/3`
  // addition makes interval-5 volleys drift one wall frame per cycle.
  shootTimer: number;
  shootTimerFrac: number;
  hitbox: { x: number; y: number; z: number };
  isBoss: boolean;
  bossSlot: number | null;
  canTakeDamage: boolean;
  collisionEnabled: boolean;
  interactable: boolean;
  // Th07.exe enemy flags +0x2e29 bit4 (op 104, dispatcher case 0x67): gates
  // the entire player-shot/bomb hit test (FUN_0041ed50 @ all.c:14174-14176)
  // — a 0 makes the enemy shot-transparent (no damage, no shot absorption,
  // no homing eligibility). Distinct from collisionEnabled (bit1, op 102),
  // which gates only the enemy-body-vs-player check.
  shotCollision: boolean;
  // Op 161 (enemy+0x2e2b bit3): opt this enemy into the native manager
  // short-circuit while a bomb or Supernatural Border is active. The skip
  // covers ECL, movement, ANM, collisions, damage, callbacks and aim-cache
  // publication; only the boss-timer retreat clock still runs.
  pauseDuringBombOrBorder: boolean;
  // FUN_0040f6c0's Extra/Phantasm high-spell bomb guard
  // (enemy+0x2e2b bit2 and i16 +0x2e2c). While set, FUN_0041ed50 skips the
  // entire body/player-shot/attack collision and homing-target publication
  // block for this boss.
  bombCollisionSuppressed: boolean;
  bombCollisionSuppressionHold: number;
  deathMode: number;
  deathCallbackSub: number;
  lifeThresholds: { threshold: number; sub: number }[];
  timerCallbackThreshold: number;
  timerCallbackSub: number;
  bossTimer: number;
  // Enemy+0x2bc4: the split timer's previous/sentinel word. Normal forward
  // ticks snapshot bossTimer before advancing; op161's normal-rate retreat
  // fast path deliberately leaves it unchanged. Body-graze cadence compares
  // it with bossTimer.
  bossTimerPrevious?: number;
  // Fractional accumulator for bossTimer under global slow motion.
  bossTimerFrac?: number;
  currentAnm: number;
  anmRunner: AnmRunner | null;
  // The anm file the runner was built from (TH08 two-file selection; the
  // same script id can exist in both enemy.anm and stgNenm.anm).
  anmRunnerAnm?: Anm | null;
  anmSlots: ({ script: number; runner: AnmRunner | null } | null)[];
  anmExDefaults: number;
  anmExFarLeft: number;
  anmExFarRight: number;
  anmExLeft: number;
  anmExRight: number;
  anmExFlags: number;
  deathAnm1: number;
  deathAnm2: number;
  deathAnm3: number;
  // FUN_0041d050's previous-position latch (+0x2b24..+0x2b2c). It is
  // template-zeroed and updated immediately before each manager integration.
  integratorPreviousPosition: { x: number; y: number; z: number };
  // Previous manager-pass displacement (+0x2b30..+0x2b38), exposed as ECL
  // vars 10063..10065. These are distinct from the current controller
  // velocity (+0x2b18..+0x2b20) used by pose selection and heading.
  frameVx: number;
  frameVy: number;
  frameVz: number;
  anmRotateWithAngle: boolean;
  // ECL op150 (exe case 0x95): absolute Z rotation written into the enemy's
  // embedded ANM VM (+8), consumed by the sprite draw (radians).
  anmRotZ?: number;
  bossLifeCount: number;
  lasers: (EnemyLaser | null)[];
  laserStore: number;
  disableCallStack: boolean;
  invisible: boolean;
  // Test-only: last game frame this enemy emitted bullets (LIFE-001 traces).
  lastFireFrame?: number;
  spellTimeoutFlag: boolean;
  // Th07.exe DAT_012f40a8: set while a boss spell card is active. Gates the
  // rank/count/speed bullet scaling off (spell bullets use raw ECL values).
  bulletRankSpeedLow: number;
  bulletRankSpeedHigh: number;
  bulletRankAmount1Low: number;
  bulletRankAmount1High: number;
  bulletRankAmount2Low: number;
  bulletRankAmount2High: number;
  lowerMoveLimit: { x: number; y: number };
  upperMoveLimit: { x: number; y: number };
  shouldClamp: boolean;
  spellName: string;
  seen: boolean;
  // Op 136 (exe case 0x87 @ 0x413.. -> `+0x2e29` bit5, arg&1): gates the
  // FUN_004217c0 sweep's cherry-item drop (op94 / op91 spell-end / boss
  // death — verified directly at all.c:14884) and enables the enemy body's
  // periodic re-graze (exe-collision.md §6, ~every 6 frames while
  // touching) -- same bit, both consumers.
  // Default false: no confirmed default-on case in stage 1's own data.
  sweepItemFlag: boolean;
  // Op 137 (exe case 0x88 @ 0x413.. -> `+0x2e2a` bit7, arg&1): exempts the
  // enemy from the off-screen auto-cull (exe-misc-ecl-ops.md §4). Default
  // false -- ordinary enemies get culled once seen-then-offscreen.
  offscreenCullExempt: boolean;
  // Op 138 (exe case 0x89 @ 0x413..): enemy position-trail contract at
  // +0x4f30/+0x4f32/+0x4f34/+0x4f36. The native object owns 96 history
  // entries; authored Stage 1-8 data requests at most 64. Besides drawing
  // the trail, FUN_0041ed50 keeps a seen enemy alive until BOTH its current
  // sprite rect and the oldest configured history point are off-screen.
  trailFlags: number;
  trailCount: number;
  trailStart: number;
  trailStride: number;
  trailHistory: { x: number; y: number; z: number }[];
  // Op 142 (exe case 0x8d @ 0x413.. -> `+0x4f40/+0x4f3c/+0x4f38`): PROBABLE
  // op 142 damage shield, frames remaining (exe enemy+0x4f40, case 0x8d):
  // while > 0, settled damage is /9 for bosses and 0 for non-bosses
  // (FUN_0041ed50 @ all.c:14245). Decrement located: the enemy loop ticks
  // the {+0x4f38,+0x4f3c,+0x4f40} countdown via FUN_00436a06(1) each frame
  // while > 0 (all.c:14440) — resolves exe-misc-ecl-ops.md §5's UNRESOLVED.
  // Every stage-1 spell card arms it at declare (Cirno 60f, Ringing Cold
  // 300f, finals 360/240/240f).
  damageShield: number;
  // Fractional half of the op142 countdown's native split timer
  // (enemy+0x4f3c; current integer is +0x4f40).
  damageShieldFrac: number;
  // TH08 vertical-slice interpreter state (Th08.exe v1.00d). Present only
  // when the stage ECL carries the 0x800 magic; every field cites its exe
  // offset — see reference/re-specs/th08-ecl-ops-*.md and th08-bullet-anm.md.
  th08?: Th08EclState;
}

// TH08-only per-enemy interpreter state. Frame-scope locals (10000-10007 int,
// 10016-10023 float, 10036-10039, 10053-10060) stay in EclState.vars with the
// TH08 layout documented in eclvm.ts so the existing call-frame save/restore
// machinery covers them; enemy-scope locals and the TH08-only systems live
// here. All offsets are from the Th08.exe Enemy object (stride 0x53d0).
export interface Th08MovementController {
  // FUN_00422c40 selects the native controller from flags bits 12-13.
  mode: 0 | 1 | 2 | 3;
  // Mode-2 polynomial selector from flags bits 14-16.
  ease: number;
  // ZunTimer at enemy+0x2ddc and its authored limit at +0x2de8.
  timerPrevious: number;
  timerFraction: number;
  timerCurrent: number;
  timerTotal: number;
  // Mode 1 polar motion (+0x2d94/+0x2d98/+0x2da8/+0x2dac).
  angle: number;
  angularVelocity: number;
  speed: number;
  acceleration: number;
  // Mode 3 polar offset (+0x2d9c/+0x2da0/+0x2db0/+0x2db4).
  orbitAngle: number;
  orbitAngularVelocity: number;
  orbitSpeed: number;
  orbitAcceleration: number;
  // Mode 2 displacement / mode 3 anchor (+0x2dc4..cc/+0x2dd0..d8).
  displacement: { x: number; y: number; z: number };
  origin: { x: number; y: number; z: number };
  // Vars 10085-10087, enemy+0x2d64/+0x2d68/+0x2d6c. The native loop adds
  // this visual/controller offset to the ECL position before publishing
  // vars 10042-10044. Stage 1's Sub32 reads x/y while building its cubic
  // boss-movement control points, so an unmapped-literal fallback is fatal.
  positionOffset: { x: number; y: number; z: number };
}

export interface Th08EclState {
  // Vars 10008-10015 (enemy+0x2ca8) / 10024-10031 (enemy+0x2cc8).
  enemyInts: Int32Array;
  enemyFloats: Float64Array;
  // Vars 10088-10093 (enemy+0x3358..+0x336c): six more enemy-scope scratch
  // dwords (th08-ecl-ops-0x00-0x2f.md §3). 10094/10095 are frame-scope
  // (VMframe +0x68/+0x6c) and live in EclState.vars[28]/[29] instead.
  scratch88: Float64Array;
  // +0x2e00/+0x2e04: pool copies written alongside HP by ins_131.
  poolCopyA: number;
  poolCopyB: number;
  // +0x2d30: pending dynamic-call table index (ins_125), -1 = none.
  pendingDynCall: number;
  // +0x2cf0[i]: dynamic call-target table (ins_126 stores, ins_125 jumps).
  dynCallTable: Int32Array;
  // TH08-native enemy movement controller (FUN_00422c40).
  movement: Th08MovementController;
  // +0x2dec/+0x2df0 fire rank-lerp speed bounds (defaults ±0.5,
  // FUN_00415c80) and +0x2df4/+0x2df6/+0x2df8/+0x2dfa count bounds.
  fireRankSpeedLow: number;
  fireRankSpeedHigh: number;
  fireRankCount1Low: number;
  fireRankCount1High: number;
  fireRankCount2Low: number;
  fireRankCount2High: number;
  // +0x3034: captured raw FIRE instruction (11 dwords) while flags bit 17 is
  // set (ins_107), replayed by the auto-fire tick.
  capturedFire: Int32Array | null;
  // Variable bank of the ECL context that captured the template. Native
  // auto-fire continues resolving VAR operands through that context; an
  // ins_135 private frame must not fall back to the main frame's locals.
  capturedFireVars: Float64Array | null;
  // +0x3060: auto-fire deadline (ins_105/106); 0 = disarmed. The native
  // timer fires when its elapsed reaches the deadline, then resets elapsed
  // (FUN_004065f0(0) after FUN_00422720 in FUN_00423150, all.c:16287-16291)
  // — a PERIODIC emitter: every `interval` frames.
  autoFireDeadline: number;
  // +0x3064 ZunTimer's integer/fractional elapsed halves. This timer is
  // independent of the active ECL context clock: ins_2 WAIT freezes ctx.time
  // but FUN_00423150 still advances this timer once per enemy-core tick.
  autoFireElapsed: number;
  autoFireElapsedFrac: number;
  // Enemy position at the ECL loop head (the +0x2d88 sync at 0x418520,
  // refreshed before every dispatch). The auto-fire re-execution (bullet
  // manager phase, after the enemy's movement) rebuilds its template origin
  // from THIS pre-movement snapshot, not the live post-move position.
  loopHeadX: number;
  loopHeadY: number;
  // +0x3313: transform ("intangible") type byte; -1 = none.
  transformType: number;
  // +0x3308/+0x330c: ins_144 death-drop pair (extra children count etc.).
  deathDropA: number;
  deathDropB: number;
  // ins_152's stage-interp template write (exe case 0x98; data uses zeros
  // only, no modeled consumer in the port).
  stageInterpTemplate: number;
  // +0x3310/+0x3311/+0x3312: ins_138 death/drop effect id bytes.
  deathEffectId: number;
  dropEffectId: number;
  deathByte2: number;
  // +0x3324/+0x3328: the two raw TH08 flags words. Bits not consumed by a
  // decoded system stay here verbatim.
  flags: number;
  flags2: number;
  // TH08 familiar (使魔) system — enemy flags bit 8 (0x100), set by the
  // child-spawn ops 90-93 (all.c:12020-12117): the child is a FAMILIAR and
  // runs the per-tick human/youkai side sync FUN_0042c420.
  familiar: boolean;
  // +0x3380: attached-children ledger on the MASTER (all.c:12044/12075/
  // 12114 increment on attach, 21629 decrements when a linked child dies
  // through the normal death path). The master-death sweep tail multiplies
  // it by two for its orb count (all.c:20533).
  attachCount: number;
  // Enemy flags bit 11 (0x800): the side mirror, synced to the player's
  // form byte each tick (FUN_0042c420 tail). 0 = human-side (materialized:
  // shootable, contact per team rules, damage flash), 1 = youkai-side
  // (ethereal: player shots pass through, no contact, ghost tint).
  sideBit: 0 | 1;
  // The familiar's attached marker VM (FUN_00425b70(0x20) at spawn —
  // etama archive script 48): interrupt 2 on materialize, 1 on ethereal,
  // 3 on death. Scene-owned handle.
  markerHandle: { interrupt(label: number): void; release(): void } | null;
  // The marker VM's follow actor (keeps the marker at the enemy).
  markerActor: { x: number; y: number; angle: number; state: number } | null;
  // +0x3340..+0x334c: player clamp rect (ins_75), armed by flags bit 19.
  clampRect: { x1: number; y1: number; x2: number; y2: number } | null;
  // +0x3350: squared suppress-fire radius (ins_85's op writes f*f).
  suppressRadiusSq: number;
  // +0x332f: manager-list id (0/2 human/youkai, 1 neutral).
  managerList: number;
  // ins_122's bonus + derived per-frame decay, retained for the TH08 spell
  // presentation (Step 2).
  spellBonus: number;
  spellDecay: number;
  // ins_135 persistent sub-ECL contexts (up to 4, "ECLInt" 0x24b0 blocks):
  // each keeps its own cursor + frame-scope var block, ticked by the
  // interpreter round-robin alongside the main context. Each ALSO carries
  // its own call stack: sharing the enemy's main stack let a sub-context's
  // ins_53 steal the main caller's frame (stage-2 Mystia's Sub61 return
  // popped the Sub32→Sub58 call frame, so the sub-context re-entered Sub32
  // and re-called Sub58 EVERY frame — boss hp refilled per cycle, then the
  // spell re-declared per frame).
  subContexts: { ctx: EclContext; vars: Float64Array; interps: (EclInterpSlot | null)[]; stack: EclFrame[] }[];
}

export interface BulletProps {
  sprite: number;
  offset: number;
  count1: number;
  count2: number;
  speed1: number;
  speed2: number;
  angle1: number;
  angle2: number;
  flags: number;
  sfx: number;
  exSlots: (BulletExSlot | null)[];
  aimMode: number;
}

export interface Enemy {
  id: number;
  // Stable slot in Th07.exe's 480-entry enemy pool. Allocation always scans
  // from slot 0; the manager updates slots 0..479 in order.
  poolSlot: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  // Current boss-phase HP ceiling for the HUD lifebar: re-latched at every
  // ins_131 life arm and at every life/timer callback clamp, so the strip
  // refills to full at each nonspell/spell phase entry (native TH08 bar
  // behavior — one attack = one full drain of the strip).
  phaseHpCeiling: number;
  // Damage taken this frame, settled once per frame through the exe's
  // pipeline (Th07.exe FUN_0041ed50: cherry from the pre-cap sum, cap 70,
  // spell-card /7, op-142 shield /9) — see StageScene#settlePendingDamage.
  pendingShotDmg: number;
  pendingBombDmg: number;
  // TH08 enemy+0x2e10: raw player-attack damage accumulated toward the next
  // human-form hit time item. Fresh enemies start at the global threshold,
  // so their first eligible hit performs one threshold check immediately.
  timeOrbDamageAccumulator: number;
  // HP actually removed by the most recent per-frame settle. In TH08 this is
  // enemy+0x3354 / ECL var 10083 (the TH07 var-10061 mapping does not apply).
  damageThisFrame?: number;
  score: number;
  frame: number;
  dead?: boolean;
  ecl: EclState;
}

// The stage time-orb quotas (.data 0x4c77f0, per stage and difficulty):
// the tally's clock-advance switch (FUN_0043c35f) and the HUD Time row
// both read this table. Extra's row reads 0.
export const TH08_STAGE_ORB_QUOTAS: readonly (readonly number[])[] = [
  [2000, 2500, 2700, 3000],
  [6500, 7200, 7200, 7200],
  [7500, 8500, 8800, 8800],
  [9999, 9999, 9999, 9999],
  [7500, 8500, 8500, 8500],
  [9999, 9999, 9999, 9999],
  [0, 0, 0, 0]
];
