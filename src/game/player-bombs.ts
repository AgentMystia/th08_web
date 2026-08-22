// TH08 player attack-slot engine (player+0xb8834, 0xc0 x 0x40). Border-Team
// bomb callbacks publish circle/box records during the priority-8 player
// pass; FUN_00451670 consumes them later, once per enemy in priority 10.
// Keeping publication separate from collision is load-bearing: each fourth
// contact arms effect 3 from inside the enemy pass, interleaved with ECL
// effects instead of being paid early by the bomb callback.

export interface AttackSlot {
  poolSlot: number;
  x: number;
  y: number;
  radiusX: number; // FULL widths — halved at the point of test
  radiusY: number;
  damage: number;
  hitTally: number;
  /** Record +0x20; zero is the native axis-aligned fast path. */
  angle: number;
  /** Record +0x24, sampled by FUN_00451670's modulo damage gate. */
  cadenceCounter: number;
  /** Record +0x38; native constructors default it to one. */
  cadenceDivisor: number;
  active: boolean;
  source: 'shot' | 'bomb';
  shape: 'box' | 'circle';
}

const MAX_SLOTS = 0xc0;

export class BombEngine {
  slots: AttackSlot[] = Array.from({ length: MAX_SLOTS }, (_, poolSlot) => ({
    poolSlot,
    x: 0, y: 0, radiusX: 0, radiusY: 0, damage: 0, hitTally: 0,
    angle: 0, cadenceCounter: 0, cadenceDivisor: 1, active: false,
    source: 'bomb', shape: 'box'
  }));

  // FUN_0043d8f0 clears only dims.x for all 112 entries at the head of each
  // player tick. Other fields persist until an owner rewrites them.
  beginFrame(): void {
    for (const s of this.slots) {
      s.active = false;
      s.radiusX = 0;
    }
  }

  reset(): void {
    for (const s of this.slots) {
      s.active = false;
      s.radiusX = s.radiusY = s.damage = s.hitTally = 0;
      s.angle = 0;
      s.cadenceCounter = 0;
      s.cadenceDivisor = 1;
      s.source = 'bomb';
      s.shape = 'box';
    }
  }

  set(
    i: number,
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    damage: number,
    source: 'shot' | 'bomb' = 'bomb'
  ): AttackSlot {
    const s = this.slots[i];
    s.x = x;
    s.y = y;
    s.radiusX = radiusX;
    s.radiusY = radiusY;
    s.damage = damage;
    s.angle = 0;
    s.cadenceCounter = 0;
    s.cadenceDivisor = 1;
    s.active = true;
    s.source = source;
    s.shape = 'box';
    return s;
  }

  // FUN_0044e040 scans from slot zero and clears the complete 0x40-byte
  // record before publishing a circular attack area.
  allocateCircle(
    x: number,
    y: number,
    radius: number,
    damage: number,
    source: 'shot' | 'bomb' = 'bomb',
    cadenceCounter = 0,
    cadenceDivisor = 1
  ): AttackSlot | null {
    const s = this.slots.find((slot) => !slot.active);
    if (!s) return null;
    s.x = x;
    s.y = y;
    s.radiusX = radius;
    s.radiusY = 0;
    s.damage = damage;
    s.hitTally = 0;
    s.angle = 0;
    s.cadenceCounter = cadenceCounter;
    s.cadenceDivisor = Math.max(1, cadenceDivisor | 0);
    s.active = true;
    s.source = source;
    s.shape = 'circle';
    return s;
  }

  // FUN_0044dfa0 publishes an oriented rectangle in the same pool. The
  // Border-Team boundary-wave callback uses these with very long widths,
  // a 38.4px height, damage 60 and a two-frame cadence.
  allocateBox(
    x: number,
    y: number,
    width: number,
    height: number,
    angle: number,
    damage: number,
    source: 'shot' | 'bomb' = 'bomb',
    cadenceCounter = 0,
    cadenceDivisor = 1
  ): AttackSlot | null {
    const s = this.slots.find((slot) => !slot.active);
    if (!s) return null;
    s.x = x;
    s.y = y;
    s.radiusX = width;
    s.radiusY = height;
    s.damage = damage;
    s.hitTally = 0;
    s.angle = angle;
    s.cadenceCounter = cadenceCounter;
    s.cadenceDivisor = Math.max(1, cadenceDivisor | 0);
    s.active = true;
    s.source = source;
    s.shape = 'box';
    return s;
  }

  clear(i: number): void {
    const s = this.slots[i];
    s.active = false;
    s.radiusX = s.radiusY = s.damage = 0;
    s.angle = 0;
  }

  *activeSlots(): IterableIterator<AttackSlot> {
    for (const s of this.slots) if (s.active && s.radiusX > 0) yield s;
  }
}
