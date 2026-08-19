import { BinaryView } from './bin';

// TH08 SHT player-data format (one file per team/focus-state).
//
// Layout validated against the TH08 files ply00a/ply00as and Th08.exe
// v1.00d: a 56-byte main header and 56-byte shooter records.
//
// 56-byte header: i16 unknown, i16 levelCount, f32 bombsPerLife,
// i32 deathbombWindow, then 8 floats: hitbox, grazebox, autocollectSpeed,
// itemRadius, pocLineY, speed, focusedSpeed, diagSpeed, diagFocusedSpeed
// (hitbox/grazebox/speeds are FULL widths and px/frame; 1.65 is Reimu's
// FULL hitbox — the exe halves it at the point of use, so 0.825 is the
// half-width). Two header fields remain unnamed (u32 @ +0x20, f32 @ +0x34). Then
// levelCount × {u32 offset, u32 powerThreshold} at +0x38, each pointing at
// a 56-byte shooter record:
//   u16 interval, u16 delay, 6×f32 (x, y, hitboxW, hitboxH, angle, speed),
//   i16 damage, i16 unknown, u8 orb (0 = player, 1/2 = option), u8
//   shotType, i16 unknown, i16 sprite, i16 sfxId (-1 = no sound), then
//   4×i32 behavior function indices (func_on_init/tick/draw/hit per
//   sht-webedit), parsed into `funcs`. funcs[0] is the spawn-time behavior
//   selector (TH08 Border Team uses 0 = plain and 1 = aim at the cached
//   target at spawn, FUN_00450240); funcs[1] is the per-tick selector
//   (1 = the seeking option tick FUN_00450320). Shooter records run until
//   an interval/delay sentinel of 0xffff/0xffff.

export interface ShtShot {
  interval: number;
  delay: number;
  x: number;
  y: number;
  hitboxW: number;
  hitboxH: number;
  angle: number;
  speed: number;
  damage: number;
  orb: number; // 0 = player, 1 = left option, 2 = right option
  unknown30: number;
  shotType: number;
  unknown33: number;
  unknown34: number;
  sprite: number; // player-anm script id (the spawner adds 10: FUN_0044fb70)
  sfxId: number; // sound effect id to play on fire, -1 = none (not yet wired to playback)
  funcs: [number, number, number, number]; // behavior function indices (see header comment)
}

export interface ShtLevel {
  // Strict upper power bound for this table. The exe selects only when
  // livePower < threshold, so an exact threshold value advances to the
  // following table (128 -> 999).
  power: number;
  shots: ShtShot[];
}

// Header/record offsets for the 56-byte TH08 layout.
const TABLE_OFFSET = 56;
const RECORD_SIZE = 56;

export class Sht {
  readonly headerUnknown0: number;
  readonly bombsPerLife: number;
  readonly deathbombWindow: number;
  readonly hitbox: number;
  readonly grazebox: number;
  readonly autocollectSpeed: number;
  readonly itemRadius: number;
  readonly pocLineY: number;
  readonly speed: number;
  readonly focusedSpeed: number;
  readonly diagSpeed: number;
  readonly diagFocusedSpeed: number;
  readonly headerUnknown32: number;
  readonly headerUnknown52: number;
  readonly levels: ShtLevel[] = [];

  constructor(source: string | Uint8Array) {
    const v = new BinaryView(source);
    const levelCount = v.i16(2);
    this.headerUnknown0 = v.i16(0);
    this.bombsPerLife = v.f32(4);
    this.deathbombWindow = v.i32(8);
    this.hitbox = v.f32(12);
    this.grazebox = v.f32(16);
    this.autocollectSpeed = v.f32(20);
    this.itemRadius = v.f32(24);
    this.pocLineY = v.f32(28);
    this.headerUnknown32 = v.u32(32);
    this.speed = v.f32(36);
    this.focusedSpeed = v.f32(40);
    this.diagSpeed = v.f32(44);
    this.diagFocusedSpeed = v.f32(48);
    this.headerUnknown52 = v.f32(52);
    for (let i = 0; i < levelCount; i++) {
      const offset = v.u32(TABLE_OFFSET + i * 8);
      const power = v.u32(TABLE_OFFSET + i * 8 + 4);
      const shots: ShtShot[] = [];
      for (let o = offset; o + RECORD_SIZE <= v.length;) {
        const interval = v.u16(o);
        const delay = v.u16(o + 2);
        if (interval === 0xffff && delay === 0xffff) break;
        shots.push({
          interval,
          delay,
          x: v.f32(o + 4),
          y: v.f32(o + 8),
          hitboxW: v.f32(o + 12),
          hitboxH: v.f32(o + 16),
          angle: v.f32(o + 20),
          speed: v.f32(o + 24),
          damage: v.i16(o + 28),
          unknown30: v.i16(o + 30),
          orb: v.u8(o + 32),
          unknown33: v.u8(o + 33),
          unknown34: v.i16(o + 34),
          shotType: v.u8(o + 33),
          sprite: v.i16(o + 36),
          sfxId: v.i16(o + 38),
          funcs: [v.i32(o + 40), v.i32(o + 44), v.i32(o + 48), v.i32(o + 52)]
        });
        o += RECORD_SIZE;
      }
      this.levels.push({ power, shots });
    }
  }

  // The shooter table active at a given power (0-128).
  shotsForPower(power: number): ShtShot[] {
    for (const level of this.levels) {
      if (power < level.power) return level.shots;
    }
    return this.levels.length ? this.levels[this.levels.length - 1].shots : [];
  }
}
