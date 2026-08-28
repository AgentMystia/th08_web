import type { Rng } from '../core/rng';

export type Th08ItemType =
  | 'powerSmall' | 'point' | 'powerBig' | 'bomb' | 'powerFull' | 'extend'
  | 'pointStar' | 'time' | 'pointSmall' | 'unknown9' | 'time2';

export interface Th08Item {
  poolSlot: number;
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  type: Th08ItemType;
  state: number;
  targetX?: number;
  targetY?: number;
  targetZ?: number;
}

export const TH08_ITEM_POOL_SIZE = 2096;

const f32 = Math.fround;

function randomSigned(range: number, rng: Rng): number {
  // FUN_004143c0 @ 0x4143c0 / FUN_0043ed80 @ 0x43ed80:
  // (u32 / 2147483648.0 - 1.0) * range in extended, then fstp to f32.
  return f32((rng.f() * 2 - 1) * range);
}

export class Th08ItemSpawnPool {
  readonly items: Th08Item[];
  nextIndex = 0;

  constructor() {
    this.items = Array.from({ length: TH08_ITEM_POOL_SIZE }, (_, poolSlot) => ({
      poolSlot,
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      type: 'powerSmall' as Th08ItemType,
      state: 0
    }));
  }

  spawn(options: {
    x: number;
    y: number;
    z?: number;
    type: Th08ItemType;
    state?: number;
    rng: Rng;
    playerDead?: boolean;
    power?: number;
  }): Th08Item | null {
    const x = f32(options.x);
    if (x < -64 || x > 448) return null;

    let type = options.type;
    let state = options.state ?? 0;
    if ((options.power ?? 0) >= 128 && (type === 'powerSmall' || type === 'powerBig')) {
      type = 'pointSmall';
    }
    if (type === 'time') {
      state = 3;
    } else if (type === 'time2') {
      state = 5;
      type = 'time';
    }

    let candidate = this.nextIndex;
    for (let scanned = 0; scanned < TH08_ITEM_POOL_SIZE; scanned++) {
      this.nextIndex++;
      const current = this.items[candidate];
      if (current.active) {
        if (this.nextIndex >= TH08_ITEM_POOL_SIZE) this.nextIndex = 0;
        candidate = this.nextIndex;
        if (type === 'time') return null;
        continue;
      }

      if (this.nextIndex >= TH08_ITEM_POOL_SIZE) this.nextIndex = 0;
      current.active = true;
      current.x = x;
      current.y = f32(options.y);
      current.z = f32(options.z ?? 0);
      current.vx = 0;
      // Item spawner FUN_004400a0 writes +0x2b4 = 0xc00ccccd = -2.2f for
      // the plain fall state. Reading that literal as -2.1875 left every
      // ordinary drop 0.0125 px/frame too slow before the gravity tail.
      current.vy = f32(-2.2);
      current.vz = 0;
      current.type = type;
      current.state = state;
      current.targetX = current.targetY = current.targetZ = undefined;

      if (state === 2) {
        // FUN_004400a0 param_4==2 (all.c:30814-30817):
        // targetX = (float)(rng01 * 288.0 + 48.0), targetY = (float)(rng01 * 192.0 - 64.0).
        current.targetX = f32(options.rng.f() * 288 + 48);
        current.targetY = f32(options.rng.f() * 192 - 64);
        current.targetZ = 0;
        current.vx = current.x;
        current.vy = current.y;
        current.vz = current.z;
      } else if (state === 3 || state === 5) {
        // FUN_004400a0 param_4==3 (all.c:30824-30827):
        // vy = (float)(-2.0 - rng01 * 0.2), vx = (float)((rng01 * 2 - 1) * 0.6).
        // 0x3e4ccccd / 0x3f19999a are f32 constants — narrow the multipliers
        // themselves, not just the final store.
        current.vy = f32(-2 - options.rng.f() * f32(0.2));
        current.vx = randomSigned(f32(0.6), options.rng);
        if (options.playerDead) {
          current.state = 0;
          current.vx = 0;
          current.vy = f32(-0.9);
          current.vz = 0;
        }
      }
      return current;
    }
    return null;
  }
}
