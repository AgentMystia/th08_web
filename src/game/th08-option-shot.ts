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
  // x87 narrowing law for every hypot in FUN_00450320: the caller computes
  // dx*dx+dy*dy in extended, then narrows the SUM to f32 when pushing it as
  // the sqrt argument (fstp dword [esp] @ 0x4503cf/0x450435/0x450512;
  // FUN_0040b440 takes an f32 formal). Math.hypot on the un-narrowed sum is
  // NOT equivalent — it shifts the result by 1 f32 ulp often enough to move a
  // seeking shot's wall-crossing frame (gx st1 f4228/f4230 settles).
  if (!target) {
    // The whole accelerate+renormalize block is gated on speed < 10
    // (fcomp [0x4b4390] / jp tail @ 0x4504c8-0x4504d5): at speed >= 10 the
    // exe leaves the velocity untouched instead of renormalizing it.
    if (b.speed < 10) {
      // DAT_004b6fd8 = 0x3eaaaaab = 0.3333333432674408f
      b.speed = f32(b.speed + 0.3333333432674408);
      const oldLength = f32(Math.sqrt(f32(b.vx * b.vx + b.vy * b.vy)));
      if (oldLength !== 0) {
        // Native: (vx * speed) / oldLength
        b.vx = f32((b.vx * b.speed) / oldLength);
        b.vy = f32((b.vy * b.speed) / oldLength);
      }
    }
  } else {
    // FUN_00450320 target branch, op-for-op: dx/dy narrow to f32 locals right
    // after the subtract (0x4503a0/0x4503bd — exact for f32 inputs); the
    // denominator narrows the FULL extended quotient `hypot / (speed / 4.0)`
    // once, not the hypot before the divide.
    const dx = target.x - b.x;
    const dy = target.y - b.y;
    let denominator = f32(Math.sqrt(f32(dx * dx + dy * dy)) / (b.speed / 4));
    if (denominator < 1) denominator = 1;
    const desiredVx = f32(dx / denominator + b.vx);
    const desiredVy = f32(dy / denominator + b.vy);
    // The 10.0 clamp compares the EXTENDED sqrt (of the f32-narrowed sum)
    // before any narrowing; the divisor of the final normalize is the
    // f32-narrowed length (fVar1).
    const lenExt = Math.sqrt(f32(desiredVx * desiredVx + desiredVy * desiredVy));
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
