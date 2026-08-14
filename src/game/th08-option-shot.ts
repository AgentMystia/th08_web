// Yukari-style seeking option shot, derived from SHT callbacks
// FUN_00450240 (init 1) and FUN_00450320 (tick 1).
export interface Th08SeekTarget {
  x: number;
  y: number;
}

const f32 = Math.fround;

function hypot32(x: number, y: number): number {
  return f32(Math.hypot(x, y));
}

export class Th08SeekingOptionShot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  heading: number;

  constructor(
    x: number,
    y: number,
    angle: number,
    speed: number,
    private readonly mode = 1
  ) {
    this.x = f32(x);
    this.y = f32(y);
    this.speed = f32(speed);
    this.heading = f32(angle);
    this.vx = f32(f32(Math.cos(angle)) * speed);
    this.vy = f32(f32(Math.sin(angle)) * speed);
  }

  static spawnsNow(frame: number, interval: number, phase: number): boolean {
    return interval > 0 && frame % interval === phase;
  }

  update(target: Th08SeekTarget | null): void {
    if (this.mode !== 1) return;

    if (!target) {
      if (this.speed < 10) {
        this.speed = f32(this.speed + f32(1 / 3));
      }
      const oldLength = hypot32(this.vx, this.vy);
      if (oldLength !== 0) {
        this.vx = f32(f32(this.vx / oldLength) * this.speed);
        this.vy = f32(f32(this.vy / oldLength) * this.speed);
      }
    } else {
      const dx = f32(target.x - this.x);
      const dy = f32(target.y - this.y);
      const distance = hypot32(dx, dy);
      let denominator = f32(distance / f32(this.speed / 4));
      if (denominator < 1) denominator = 1;
      let desiredVx = f32(f32(dx / denominator) + this.vx);
      let desiredVy = f32(f32(dy / denominator) + this.vy);
      const desiredLength = hypot32(desiredVx, desiredVy);
      let newSpeed = desiredLength;
      if (newSpeed > 10) newSpeed = 10;
      if (newSpeed < 1) newSpeed = 1;
      this.speed = newSpeed;
      if (desiredLength !== 0) {
        this.vx = f32(f32(desiredVx / desiredLength) * newSpeed);
        this.vy = f32(f32(desiredVy / desiredLength) * newSpeed);
      }
    }

    this.heading = f32(Math.atan2(this.vy, this.vx));
    this.x = f32(this.x + this.vx);
    this.y = f32(this.y + this.vy);
  }
}
