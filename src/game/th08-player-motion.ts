// Pure TH08 player movement core, mirroring Player::FUN_0044aec0. Rendering,
// shot callbacks, and option trails are integrated by the scene; this module
// owns the deterministic position/role arithmetic needed by replay alignment.
export interface Th08MotionSht {
  speed: number;
  focusedSpeed: number;
  diagSpeed: number;
  diagFocusedSpeed: number;
}

export interface Th08MotionInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  focus: boolean;
}

export interface Th08MotionUpdate {
  slowRate?: number;
  bombStage?: number;
  xScale?: number;
  yScale?: number;
  bounds?: readonly [number, number, number, number];
}

function directionCode(input: Th08MotionInput): number {
  if (input.up && input.left) return 5;
  if (input.up && input.right) return 6;
  if (input.down && input.left) return 7;
  if (input.down && input.right) return 8;
  if (input.up) return 1;
  if (input.down) return 2;
  if (input.left) return 3;
  if (input.right) return 4;
  return 0;
}

export class Th08PlayerMotion {
  x = 192;
  y = 416;
  direction = 0;
  isYoukai = false;
  focusHoldFrames = 0;
  inputVx = 0;
  inputVy = 0;
  frameVx = 0;
  frameVy = 0;

  constructor(
    private readonly humanSht: Th08MotionSht,
    private readonly youkaiSht: Th08MotionSht
  ) {}

  update(input: Th08MotionInput, options: Th08MotionUpdate = {}): boolean {
    const slowRate = Math.fround(options.slowRate ?? 1);
    const bombStage = options.bombStage ?? 0;
    const focused = bombStage !== 0 ? (bombStage & 1) !== 0 : input.focus;

    if (!focused) {
      if (!this.isYoukai) {
        this.focusHoldFrames++;
      } else {
        this.isYoukai = false;
        this.focusHoldFrames = 0;
      }
    } else {
      if (this.isYoukai) {
        this.focusHoldFrames++;
      } else {
        this.isYoukai = true;
        this.focusHoldFrames = 0;
      }
    }

    this.direction = directionCode(input);
    const sht = this.isYoukai ? this.youkaiSht : this.humanSht;
    let vx = 0;
    let vy = 0;
    switch (this.direction) {
      case 1: vy = -sht.speed; break;
      case 2: vy = sht.speed; break;
      case 3: vx = -sht.speed; break;
      case 4: vx = sht.speed; break;
      case 5: vx = -sht.diagSpeed; vy = vx; break;
      case 6: vx = sht.diagSpeed; vy = -vx; break;
      case 7: vy = sht.diagSpeed; vx = -vy; break;
      case 8: vx = sht.diagSpeed; vy = vx; break;
    }

    const xScale = Math.fround(options.xScale ?? 1);
    const yScale = Math.fround(options.yScale ?? 1);
    this.inputVx = Math.fround(vx * xScale);
    this.inputVy = Math.fround(vy * yScale);
    this.frameVx = Math.fround(this.inputVx * slowRate);
    this.frameVy = Math.fround(this.inputVy * slowRate);
    this.x = Math.fround(this.x + this.frameVx);
    this.y = Math.fround(this.y + this.frameVy);

    const [left, top, width, height] = options.bounds ?? [8, 16, 368, 416];
    const right = Math.fround(Math.fround(left) + width);
    const bottom = Math.fround(Math.fround(top) + height);
    if (this.x < left) this.x = Math.fround(left);
    else if (this.x > right) this.x = right;
    if (this.y < top) this.y = Math.fround(top);
    else if (this.y > bottom) this.y = bottom;

    return this.inputVx !== 0 || this.inputVy !== 0;
  }
}
