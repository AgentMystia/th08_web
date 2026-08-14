/**
 * Pure TH08 Border Team bomb simulation.
 *
 * This file deliberately has no renderer, ANM VM, audio device, or engine
 * dependency.  It reproduces the observable state changes that can be read
 * from the supplied Ghidra output and emits integration events for the host
 * engine.  Values whose exe meaning is not established are retained as raw
 * native arguments rather than being silently reinterpreted as gameplay
 * values.
 */

export type Th08BorderBombSide = 'human' | 'youkai';
export type Th08BorderBombMode = 'normal' | 'deathbomb' | 'final';
export type Th08BorderBombStage = 'idle' | 'active' | 'finish' | 'ended';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export interface Th08BombTarget extends Vec3 {
  id: number;
  /** Enemy hit radius; only used to choose the nearest target center. */
  radius?: number;
}

export interface Th08BombEnemy extends Vec3 {
  id: number;
  radius?: number;
}

export interface Th08BombBullet extends Vec2 {
  id: number;
  /** Integration-owned flag; the bomb only changes it for bullets in a region. */
  cleared?: boolean;
}

export interface Th08BorderBombInput {
  player: Vec3;
  /** Candidate target centers. Empty means the original's no-target path. */
  targets?: readonly Th08BombTarget[];
  /** Mutable bullets passed by the integrating engine. */
  bullets?: readonly Th08BombBullet[];
}

export type Th08BorderBombEvent =
  | {
      kind: 'sfx';
      frame: number;
      /** Native SFX/effect-call id and arguments from the decompilation. */
      id: number;
      args: readonly number[];
      callback: number;
      provenance: string;
    }
  | {
      kind: 'anm';
      frame: number;
      script: number;
      position: Vec3;
      args: readonly number[];
      callback: number;
      provenance: string;
    }
  | {
      kind: 'attack-slot';
      frame: number;
      slot: number;
      position: Vec3;
      script: number;
      /** Native damage is not present in the supplied callbacks. */
      damage: number | null;
      callback: number;
      provenance: string;
    }
  | {
      kind: 'bullet-clear';
      frame: number;
      region: Th08BulletClearRegion;
      clearedBulletIds: readonly number[];
      callback: number;
      provenance: string;
    }
  | {
      kind: 'state';
      frame: number;
      from: Th08BorderBombStage;
      to: Th08BorderBombStage;
      callback: number | null;
      provenance: string;
    };

export interface Th08BulletClearRegion {
  shape: 'circle' | 'rect';
  x: number;
  y: number;
  radius?: number;
  width?: number;
  height?: number;
  /** Raw 0x... word when the radius came directly from an exe argument. */
  rawRadius?: number;
}

export interface Th08BorderBombOrb extends Vec3 {
  slot: number;
  state: 'seeking' | 'burst' | 'inactive';
  angle: number;
  speed: number;
  vx: number;
  vy: number;
  age: number;
}

export interface Th08BorderBombAttackSlot {
  slot: number;
  x: number;
  y: number;
  z: number;
  script: number;
  active: boolean;
  /** Left null rather than inventing an unsourced damage constant. */
  damage: number | null;
}

export interface Th08BorderBombCallbacks {
  side: Th08BorderBombSide;
  /** Exactly the five addresses supplied for this side, in table order. */
  addresses: readonly [number, number, number, number, number];
}

/**
 * Player::AddedCallback @ 0x44d650 copies five callbacks for each selected
 * side using the Border Team's shotType-0 pointer-table block.  The supplied
 * export labels the first block human/Reimu and the second youkai/Yukari.
 */
export const TH08_BORDER_HUMAN_CALLBACKS: Th08BorderBombCallbacks = {
  side: 'human',
  addresses: [0x40c010, 0x410c40, 0x40c910, 0x410fe0, 0x40d100],
};

export const TH08_BORDER_YOUKAI_CALLBACKS: Th08BorderBombCallbacks = {
  side: 'youkai',
  addresses: [0x40c820, 0x40d950, 0x40d010, 0x4113a0, 0x40d310],
};

/** Native float32 constants as written by Ghidra. */
const F32 = (value: number): number => Math.fround(value);
const NATIVE_PI = F32(Math.PI);
const NATIVE_PI_OVER_8 = F32(Math.PI / 8);
const ORB_COUNT = 0x10;
const YOUKAI_DEATH_SLOT_COUNT = 0x80;
const SEEK_START_SPEED = F32(8);
const SEEK_MAX_SPEED = F32(10);
const HUMAN_SEEK_FRAMES = 0x28;
const HUMAN_BURST_FRAMES = 0x1e;
const HUMAN_DEATHBOMB_FIRST_BURST = 0x28;
const HUMAN_DEATHBOMB_TARGET_PERIOD = 0x14;
const YOUKAI_FIELD_FRAMES = 0x3c;
const PLAYFIELD = { x: 32, y: 16, width: 384, height: 448 } as const;

function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function nearestTarget(player: Vec3, targets: readonly Th08BombTarget[]): Th08BombTarget | null {
  let best: Th08BombTarget | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const distance = distanceSquared(player, target);
    if (distance < bestDistance || (distance === bestDistance && target.id < (best?.id ?? 0))) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

function inRegion(bullet: Th08BombBullet, region: Th08BulletClearRegion): boolean {
  if (region.shape === 'circle') {
    const radius = region.radius ?? 0;
    return distanceSquared(bullet, region) <= radius * radius;
  }
  const halfWidth = (region.width ?? 0) / 2;
  const halfHeight = (region.height ?? 0) / 2;
  return Math.abs(bullet.x - region.x) <= halfWidth && Math.abs(bullet.y - region.y) <= halfHeight;
}

/**
 * Apply a clear region to integration-owned bullets.  The return value is
 * also emitted as an event so replay/render layers can consume it without
 * inspecting object identity.
 */
export function clearTh08BulletsInRegion(
  bullets: readonly Th08BombBullet[],
  region: Th08BulletClearRegion
): number[] {
  const cleared: number[] = [];
  for (const bullet of bullets) {
    if (!bullet.cleared && inRegion(bullet, region)) {
      bullet.cleared = true;
      cleared.push(bullet.id);
    }
  }
  return cleared;
}

export interface Th08BorderBombOptions {
  side: Th08BorderBombSide;
  /**
   * Normal maps to callback 0/2 depending on side; deathbomb maps to the
   * callback-2 family; final maps to callback 4.  The mapping is explicit in
   * activeCallback below so uncertain callback-table semantics stay visible.
   */
  mode?: Th08BorderBombMode;
}

export class Th08BorderBombSim {
  readonly side: Th08BorderBombSide;
  readonly mode: Th08BorderBombMode;
  readonly callbacks: Th08BorderBombCallbacks;
  frame = -1;
  stage: Th08BorderBombStage = 'idle';
  player: Vec3 = { x: 0, y: 0, z: 0 };
  target: Th08BombTarget | null = null;
  orbs: Th08BorderBombOrb[] = [];
  attackSlots: Th08BorderBombAttackSlot[] = [];
  private targetSlotCursor = 0;

  constructor(options: Th08BorderBombOptions) {
    this.side = options.side;
    this.mode = options.mode ?? 'normal';
    this.callbacks = options.side === 'human'
      ? TH08_BORDER_HUMAN_CALLBACKS
      : TH08_BORDER_YOUKAI_CALLBACKS;
  }

  /** Main callback selected for this run; addresses remain numerical keys. */
  get activeCallback(): number {
    if (this.mode === 'final') return this.callbacks.addresses[4];
    if (this.mode === 'deathbomb') {
      return this.side === 'human'
        ? this.callbacks.addresses[2]
        : this.callbacks.addresses[2];
    }
    return this.callbacks.addresses[0];
  }

  get duration(): number {
    if (this.side === 'human') {
      return HUMAN_SEEK_FRAMES + HUMAN_BURST_FRAMES + 1;
    }
    return YOUKAI_FIELD_FRAMES;
  }

  get ended(): boolean {
    return this.stage === 'ended';
  }

  tick(input: Th08BorderBombInput): Th08BorderBombEvent[] {
    if (this.stage === 'ended') return [];
    const events: Th08BorderBombEvent[] = [];
    this.frame++;
    this.player = { x: input.player.x, y: input.player.y, z: input.player.z };
    if (this.stage === 'idle') {
      this.target = nearestTarget(this.player, input.targets ?? []);
      const from = this.stage;
      this.stage = 'active';
      events.push(this.stateEvent(from, this.stage));
      if (this.side === 'human') this.initializeHumanOrbs();
      else this.initializeYoukaiField();
      events.push(...this.startEvents());
    }

    if (this.side === 'human') {
      events.push(...this.tickHuman(input));
    } else {
      events.push(...this.tickYoukai(input));
    }

    // The 0x44c650 caller keeps bomb state active until its native timer
    // reaches the configured limit.  These durations are the callback-derived
    // orbital/field phases, not a claim that fe4 was initialized to them.
    if (this.frame + 1 >= this.duration) {
      const from = this.stage;
      this.stage = 'ended';
      events.push(this.stateEvent(from, this.stage));
    }
    return events;
  }

  private stateEvent(from: Th08BorderBombStage, to: Th08BorderBombStage): Th08BorderBombEvent {
    return {
      kind: 'state',
      frame: this.frame,
      from,
      to,
      callback: this.activeCallback,
      provenance: '0x44c650 bomb-state gate; phase duration derived in this module',
    };
  }

  private initializeHumanOrbs(): void {
    // 0x40c010/0x40c910 both initialize sixteen slots with:
    // angle = -pi_f32 + i * (pi/8)_f32.
    let angle = -NATIVE_PI;
    for (let i = 0; i < ORB_COUNT; i++) {
      this.orbs.push({
        slot: i,
        state: 'seeking',
        x: this.player.x,
        y: this.player.y,
        z: this.player.z,
        angle,
        speed: SEEK_START_SPEED,
        vx: 0,
        vy: 0,
        age: 0,
      });
      angle = F32(angle + NATIVE_PI_OVER_8);
      this.attackSlots.push({
        slot: i,
        x: this.player.x,
        y: this.player.y,
        z: this.player.z,
        script: 0x13,
        active: true,
        damage: null,
      });
    }
  }

  private initializeYoukaiField(): void {
    // 0x40c820 iterates sixteen already-owned slots; 0x40d010 iterates 128.
    const count = this.mode === 'deathbomb' ? YOUKAI_DEATH_SLOT_COUNT : ORB_COUNT;
    const angle = F32(-Math.PI);
    for (let i = 0; i < count; i++) {
      const slotAngle = F32(angle + i * NATIVE_PI_OVER_8);
      const radius = this.mode === 'deathbomb' ? 128 : 64;
      this.orbs.push({
        slot: i,
        state: 'seeking',
        x: F32(this.player.x + Math.cos(slotAngle) * radius),
        y: F32(this.player.y + Math.sin(slotAngle) * radius),
        z: this.player.z,
        angle: slotAngle,
        speed: 0,
        vx: 0,
        vy: 0,
        age: 0,
      });
      this.attackSlots.push({
        slot: i,
        x: this.player.x,
        y: this.player.y,
        z: this.player.z,
        // 0x4113a0 supplies two VM scripts (0x15/0x16). Slot damage is absent.
        script: i === 0 ? 0x15 : i === 1 ? 0x16 : 0x13,
        active: true,
        damage: null,
      });
    }
  }

  private startEvents(): Th08BorderBombEvent[] {
    const events: Th08BorderBombEvent[] = [];
    const cb = this.activeCallback;
    events.push({
      kind: 'sfx', frame: this.frame, id: 0x0d, args: [0],
      callback: cb, provenance: 'FUN_0045d550(0x0d, 0)',
    });
    events.push({
      kind: 'anm', frame: this.frame, script: 0x0c,
      position: { ...this.player }, args: [1, 0xff4040ff],
      callback: cb, provenance: 'FUN_00425430(0x0c, player, 1, 0xff4040ff)',
    });
    return events;
  }

  private tickHuman(input: Th08BorderBombInput): Th08BorderBombEvent[] {
    const events: Th08BorderBombEvent[] = [];
    // Callback-1/callback-3 add effect waves at native frames 10/20/30.
    for (const nativeFrame of [10, 20, 30]) {
      if (this.frame === nativeFrame) {
        const wave = nativeFrame / 10 - 1;
        events.push({
          kind: 'anm', frame: this.frame,
          script: this.side === 'human' ? 0x24 : 0x25,
          position: { ...this.player }, args: [4 + wave, 1, 0xffffffff],
          callback: this.mode === 'deathbomb' ? this.callbacks.addresses[3] : this.callbacks.addresses[1],
          provenance: `${(this.mode === 'deathbomb' ? this.callbacks.addresses[3] : this.callbacks.addresses[1]).toString(16)}: FUN_0040e350(${nativeFrame})`,
        });
      }
    }

    const targetPoint: Vec3 = this.target ?? this.player;
    for (const orb of this.orbs) {
      if (orb.state === 'inactive') continue;
      orb.age = F32(orb.age + 1);
      if (orb.state === 'seeking') {
        this.updateHumanSeek(orb, targetPoint);
        const transitionFrame = this.mode === 'deathbomb'
          ? HUMAN_DEATHBOMB_FIRST_BURST - orb.slot
          : HUMAN_SEEK_FRAMES;
        if (this.frame >= transitionFrame) {
          orb.state = 'burst';
          orb.age = 0;
          events.push(...this.humanOrbBurst(orb));
        }
      } else if (orb.state === 'burst') {
        orb.x = F32(orb.x + orb.vx);
        orb.y = F32(orb.y + orb.vy);
        // 0x40c010 increments slot[1] and clears at >0x1d (30 frames).
        if (orb.age >= HUMAN_BURST_FRAMES) orb.state = 'inactive';
      }
      const slot = this.attackSlots[orb.slot];
      if (slot) {
        slot.x = orb.x;
        slot.y = orb.y;
        slot.z = orb.z;
        slot.active = orb.state !== 'inactive';
      }
    }

    if (this.mode === 'deathbomb') {
      events.push(...this.spawnDeathbombTargetSlots());
    }
    events.push(...this.emitCurrentClears(input));
    return events;
  }

  /**
   * Literal transcription of the 0x40c010 seeking equations, with the unknown
   * global frame-rate scalar DAT_017ce8e0 conservatively represented by 1.
   */
  private updateHumanSeek(orb: Th08BorderBombOrb, target: Vec3): void {
    const dx = F32(target.x - orb.x);
    const dy = F32(target.y - orb.y);
    const denominator = Math.max(1, F32(orb.speed / 8));
    let vx = F32(F32(dx / denominator) + orb.vx);
    let vy = F32(F32(dy / denominator) + orb.vy);
    const magnitude = Math.hypot(vx, vy);
    const nextSpeed = Math.min(SEEK_MAX_SPEED, magnitude);
    if (magnitude > 0 && magnitude !== nextSpeed) {
      vx = F32(F32(vx * nextSpeed) / magnitude);
      vy = F32(F32(vy * nextSpeed) / magnitude);
    }
    orb.vx = vx;
    orb.vy = vy;
    orb.speed = F32(nextSpeed);
    orb.x = F32(orb.x + vx);
    orb.y = F32(orb.y + vy);
  }

  private humanOrbBurst(orb: Th08BorderBombOrb): Th08BorderBombEvent[] {
    const events: Th08BorderBombEvent[] = [];
    const position = { x: orb.x, y: orb.y, z: orb.z };
    const region: Th08BulletClearRegion = {
      shape: 'circle', x: orb.x, y: orb.y, radius: 64, rawRadius: 0x42800000,
    };
    // Clearing is supplied to the integration layer; the decompiled call is
    // FUN_0044e040(..., 0x42800000, 0x414ccccd, 500, 0x0c), whose exact
    // semantic boundary is retained as rawRadius.
    events.push({
      kind: 'anm', frame: this.frame, script: 0x06, position,
      args: [8, 0xffffffff], callback: this.activeCallback,
      provenance: 'FUN_00425430(6, orb, 8, 0xffffffff)',
    });
    events.push({
      kind: 'sfx', frame: this.frame, id: 8, args: [0, 0x15],
      callback: this.activeCallback, provenance: 'FUN_0045b8b0(8,0,0,0x15)',
    });
    events.push({
      kind: 'sfx', frame: this.frame, id: 15, args: [orb.slot],
      callback: this.activeCallback, provenance: 'FUN_0045d660(0x0f, orb.x)',
    });
    events.push({
      kind: 'attack-slot', frame: this.frame, slot: orb.slot, position,
      script: this.mode === 'deathbomb' ? 5 : 4,
      damage: null, callback: this.activeCallback,
      provenance: 'FUN_0044e040 attack/effect slot; damage field absent in Ghidra output',
    });
    return events;
  }

  private spawnDeathbombTargetSlots(): Th08BorderBombEvent[] {
    const events: Th08BorderBombEvent[] = [];
    // 0x40c910: at timer 40, and every 20 frames while modulo-20 is zero,
    // activate slots beginning at 16. The supplied function does not show an
    // explicit upper-bound branch, so retain the native 128-slot pool limit.
    if (this.frame < HUMAN_DEATHBOMB_FIRST_BURST ||
        (this.frame - HUMAN_DEATHBOMB_FIRST_BURST) % HUMAN_DEATHBOMB_TARGET_PERIOD !== 0 ||
        this.targetSlotCursor + ORB_COUNT >= YOUKAI_DEATH_SLOT_COUNT) {
      return events;
    }
    const target = this.target ?? this.player;
    for (let i = 0; i < ORB_COUNT; i++) {
      const slotNumber = this.targetSlotCursor + ORB_COUNT + i;
      if (slotNumber >= YOUKAI_DEATH_SLOT_COUNT) break;
      this.attackSlots.push({
        slot: slotNumber, x: target.x, y: target.y, z: target.z,
        script: 0x14, active: true, damage: null,
      });
      events.push({
        kind: 'attack-slot', frame: this.frame, slot: slotNumber,
        position: { x: target.x, y: target.y, z: target.z }, script: 0x14,
        damage: null, callback: this.callbacks.addresses[2],
        provenance: '0x40c910 slot pool [0x10,0x80); target cache and script 0x14',
      });
    }
    this.targetSlotCursor += ORB_COUNT;
    return events;
  }

  private tickYoukai(input: Th08BorderBombInput): Th08BorderBombEvent[] {
    const events: Th08BorderBombEvent[] = [];
    const target = this.target ?? this.player;
    for (const orb of this.orbs) {
      orb.age = F32(orb.age + 1);
      // 0x40c820/0x40d010 update each slot from its cached transformed
      // position. The transform inputs are not in these excerpts, so only
      // target-relative motion is modeled and flagged through events.
      const phase = F32(orb.angle + orb.age * 0.01);
      const radius = this.mode === 'deathbomb' ? 128 : 64;
      orb.x = F32(target.x + Math.cos(phase) * radius);
      orb.y = F32(target.y + Math.sin(phase) * radius);
      const slot = this.attackSlots[orb.slot];
      if (slot) {
        slot.x = orb.x;
        slot.y = orb.y;
        slot.active = this.frame < YOUKAI_FIELD_FRAMES;
      }
    }

    if (this.frame === 0) {
      events.push({
        kind: 'anm', frame: 0, script: 0x15,
        position: { x: target.x, y: target.y, z: F32(0.01) },
        args: [], callback: this.callbacks.addresses[3],
        provenance: '0x4113a0 first VM position z=0x3c23d70a',
      });
      events.push({
        kind: 'anm', frame: 0, script: 0x16,
        position: { x: target.x, y: target.y, z: 0 },
        args: [], callback: this.callbacks.addresses[3],
        provenance: '0x4113a0 second VM position z=0',
      });
    }
    events.push(...this.emitCurrentClears(input));
    return events;
  }

  private emitCurrentClears(input: Th08BorderBombInput): Th08BorderBombEvent[] {
    const events: Th08BorderBombEvent[] = [];
    if (this.side === 'human') {
      // Only emit at actual burst transitions, not throughout aftermath.
      const bursts = this.orbs.filter(orb => orb.state === 'burst' && orb.age === 0);
      for (const orb of bursts) {
        const region: Th08BulletClearRegion = {
          shape: 'circle', x: orb.x, y: orb.y, radius: 64, rawRadius: 0x42800000,
        };
        const ids = input.bullets ? clearTh08BulletsInRegion(input.bullets, region) : [];
        events.push({
          kind: 'bullet-clear', frame: this.frame, region, clearedBulletIds: ids,
          callback: this.activeCallback,
          provenance: 'orb transition radius word 0x42800000; boundary integration contract',
        });
      }
      return events;
    }

    // Yukari's callbacks expose fade/slot motion rather than a literal circle.
    // The full playfield rectangle is emitted as the integrable major clear
    // region; its provenance marks the geometry as inferred from native
    // camera bounds rather than a direct 0x40c820 radius argument.
    const region: Th08BulletClearRegion = {
      shape: 'rect',
      x: F32(PLAYFIELD.x + PLAYFIELD.width / 2),
      y: F32(PLAYFIELD.y + PLAYFIELD.height / 2),
      width: PLAYFIELD.width,
      height: PLAYFIELD.height,
    };
    const ids = input.bullets ? clearTh08BulletsInRegion(input.bullets, region) : [];
    events.push({
      kind: 'bullet-clear', frame: this.frame, region, clearedBulletIds: ids,
      callback: this.activeCallback,
      provenance: 'inferred TH08 playfield from _DAT_0164d2dc/e0 offsets; no literal radius in 0x40c820',
    });
    return events;
  }
}
