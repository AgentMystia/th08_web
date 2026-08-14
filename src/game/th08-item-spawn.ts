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
  return f32(f32(f32(rng.f() * 2) - 1) * range);
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
      current.vy = f32(-2.2);
      current.vz = 0;
      current.type = type;
      current.state = state;
      current.targetX = current.targetY = current.targetZ = undefined;

      if (state === 2) {
        current.targetX = f32(f32(options.rng.range(288)) + 48);
        current.targetY = f32(f32(options.rng.range(192)) - 64);
        current.targetZ = 0;
        current.vx = current.x;
        current.vy = current.y;
        current.vz = current.z;
      } else if (state === 3 || state === 5) {
        current.vy = f32(f32(-2) - f32(options.rng.range(0.2)));
        current.vx = randomSigned(0.6, options.rng);
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
