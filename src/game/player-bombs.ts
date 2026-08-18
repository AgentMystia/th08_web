// Player bomb attack-slot engine (Th07.exe player+0x9dc pool, shared by
// TH08's per-frame bomb callbacks). Damage delivery: the exe writes moving
// attack hitboxes into the player+0x9dc array (stride 0x20: pos, radiusX/Y
// as FULL widths halved at test, damage, hitTally), consumed by
// FUN_0043a980 every frame per enemy — an overlapping slot applies its
// damage value EVERY frame it overlaps. Bullet cancellation is the same
// spatial touch, gated on bomb-active. The twelve TH07 per-form bomb state
// machines that used to live here are deleted with the TH07 characters;
// the TH08 Border Team bomb runs through th08-border-bombs.ts, feeding
// slots into this engine via the scene's addAttackSlot.

export interface AttackSlot {
  poolSlot: number;
  x: number;
  y: number;
  radiusX: number; // FULL widths — halved at the point of test
  radiusY: number;
  damage: number;
  hitTally: number;
  active: boolean;
  source: 'shot' | 'bomb';
}

const MAX_SLOTS = 112; // exe pool size (0x70)

export class BombEngine {
  slots: AttackSlot[] = Array.from({ length: MAX_SLOTS }, (_, poolSlot) => ({
    poolSlot,
    x: 0, y: 0, radiusX: 0, radiusY: 0, damage: 0, hitTally: 0, active: false,
    source: 'bomb'
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
      s.source = 'bomb';
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
    s.active = true;
    s.source = source;
    return s;
  }

  clear(i: number): void {
    const s = this.slots[i];
    s.active = false;
    s.radiusX = s.radiusY = s.damage = 0;
  }

  *activeSlots(): IterableIterator<AttackSlot> {
    for (const s of this.slots) if (s.active && s.radiusX > 0) yield s;
  }
}
