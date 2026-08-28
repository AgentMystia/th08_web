// Yukari-style seeking option shot, derived from SHT callbacks
// FUN_00450240 (init 1) and FUN_00450320 (tick 1).
export interface Th08SeekTarget {
  x: number;
  y: number;
}

export interface PlayerBulletTarget {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  angle: number;
}

const f32 = Math.fround;

export function updateTh08SeekingOptionShot(b: PlayerBulletTarget, target: Th08SeekTarget | null): void {
  if (!target) {
    if (b.speed < 10) {
      // DAT_004b6fd8 = 0x3eaaaaab = 0.3333333432674408f
      b.speed = f32(b.speed + 0.3333333432674408);
    }
    const oldLength = f32(Math.hypot(b.vx, b.vy));
    if (oldLength !== 0) {
      // Native: (vx * speed) / oldLength
      b.vx = f32((b.vx * b.speed) / oldLength);
      b.vy = f32((b.vy * b.speed) / oldLength);
    }
  } else {
    // FUN_00450320 target branch, op-for-op: dx/dy stay in extended (x87
    // subtract of two f32s never rounds before the hypot); the denominator
    // narrows the FULL extended quotient `hypot / (speed / 4.0)` once, not
    // the hypot before the divide.
    const dx = target.x - b.x;
    const dy = target.y - b.y;
    let denominator = f32(Math.hypot(dx, dy) / (b.speed / 4));
    if (denominator < 1) denominator = 1;
    const desiredVx = f32(dx / denominator + b.vx);
    const desiredVy = f32(dy / denominator + b.vy);
    // The 10.0 clamp compares the EXTENDED hypot before any narrowing;
    // the divisor of the final normalize is the f32-narrowed length (fVar1).
    const lenExt = Math.hypot(desiredVx, desiredVy);
    const desiredLength = f32(lenExt);
    let newSpeed = desiredLength;
    if (lenExt > 10) newSpeed = 10;
    if (newSpeed < 1) newSpeed = 1;
    b.speed = newSpeed;
    if (desiredLength !== 0) {
      b.vx = f32((desiredVx * b.speed) / desiredLength);
      b.vy = f32((desiredVy * b.speed) / desiredLength);
    }
  }

  b.angle = f32(Math.atan2(b.vy, b.vx));
  // Note: Position is NOT integrated here. Native FUN_00450320 only updates velocity/heading.
  // The global bullet update loop handles the position integration.
}
