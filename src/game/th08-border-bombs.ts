/**
 * TH08 Border Team bombs, transcribed from the v1.00d callbacks.
 *
 * The bomb state machine (Th08.exe 0x44c650) calls ONE per-frame function for
 * the whole bomb, selected by bombType from the five-entry table copied to
 * player+0x1000 by Player::AddedCallback (rdata 0x4c7ad0, team block 0):
 *
 *   type 0 = 0x40c010  unfocused "Reimu" bomb   (16 seeking orbs + spiral, 260f)
 *   type 1 = 0x410c40  focused  "Yukari" bomb   (r100 field + 3 waves,     200f)
 *   type 2 = 0x40c910  focused-cast deathbomb   (16 charging orbs, staggered
 *                                                bursts, target bombardment)
 *   type 3 = 0x410fe0  unfocused-cast deathbomb (r100 field, stronger waves, 300f)
 *
 * A deathbomb INVERTS the side before adding +2 (0x44c7f7: fe0 = 1 - focus),
 * so casting focused runs table[2] and casting unfocused runs table[3]. The
 * machine ends the bomb when its timer reaches player+0xfe4 (set to the
 * callback's duration by the shared cast helper 0x40be30), and pays the gauge
 * ±26000/duration per frame (bypassing the lock) for the whole duration.
 *
 * Every constant below carries its native site. Slot damage fields that the
 * decompile shows explicitly are kept verbatim; the attack-slot pool plumbing
 * itself is represented by the damage/clear callbacks handed to the host.
 */

export interface Th08BombHost {
  /** Primary target cache (player+0xe2aa4, the enemy-manager max-y pick). */
  readonly targetPos: { x: number; y: number } | null;
  /**
   * Spawn a damaging attack area; `damage` is the native slot +0x34 value.
   * Returns the damage actually settled against live enemies (the slot
   * consumer's +0x30 accumulation).
   */
  addAttackSlot(x: number, y: number, radius: number, damage: number): number;
  /** Clear enemy bullets inside the circle (FUN_0044df00 pools / 0x40be30). */
  clearBullets(x: number, y: number, radius: number): void;
  /** Effect VM request (FUN_00425430(script, pos, scale, color)). */
  effectVm(script: number, x: number, y: number, scale: number, color: number): void;
  /** Orb VM request (FUN_004069f0(slotVm, script) on the 0x16f0-strided pool). */
  orbVm(index: number, script: number): void;
  playSfx(id: number, arg?: number): void;
}

export type Th08BombType = 0 | 1 | 2 | 3;

// 0x40be30's duration argument (param written to player+0xfe4).
const DURATION: Record<Th08BombType, number> = { 0: 260, 1: 200, 2: 260, 3: 300 };

const F32 = Math.fround;
const PI_F = F32(Math.PI);
// 0x4b439c = pi/8: the 16-orb ring step (0x40c010/0x40c910 cast).
const PI_OVER_8 = F32(Math.PI / 8);
// 0xbd567750 / 0x3d567750: the per-parity spin nudge applied every frame.
const SPIN_EVEN = F32(-0.0543);
const SPIN_ODD = 0.0543;
// 0x4b4398: phase-B radius growth for the 0x40c010 spiral release.
const SPIRAL_GROW = F32(3.2);
// 0x4b43b4/0x4b43b8: the 0x40c910 post-frame-40 outward acceleration.
const CHARGE_ACCEL_EVEN = F32(2.4);
const CHARGE_ACCEL_ODD = F32(1.2);
const SEEK_START_SPEED = 8;
const SEEK_MAX_SPEED = 10;
const SEEK_MIN_SPEED = 1;
const SEEK_DIVISOR = 4;
// 0x40c010: seek auras track each orb (r64 dmg 200 pool entry + the r128
// clear pool entry); an orb detonates once its aura settles 200 damage.
const ORB_AURA_DAMAGE = 200;
// Detonation slots (0x40c010 / 0x40c910 burst writes).
const BURST_DAMAGE_NORMAL = 500;
const BURST_DAMAGE_DEATHBOMB = 50; // 0x32
const ORB_COUNT = 16;
const CHARGE_RELEASE_FRAME = 40; // 0x28 gate in both orb bombs

interface BombOrb {
  // state mirrors the native slot dword 0: 1 live, 2 burst, 0 dead.
  state: 0 | 1 | 2;
  x: number;
  y: number;
  angle: number;
  speed: number;
  vx: number;
  vy: number;
  // 0x40c910 only: the parked start position (dword 8/9).
  anchorX: number;
  anchorY: number;
  burstAge: number;
  auraDamage: number;
  dead: boolean;
}

export class Th08BorderBomb {
  readonly type: Th08BombType;
  readonly duration: number;
  /** Timer counter (Selected 0 at cast; the host ticks once per frame). */
  frame = 0;
  private orbs: BombOrb[] = [];
  private ended = false;
  private bombardmentArmed = false;
  private castOrigin = { x: 0, y: 0 };

  constructor(type: Th08BombType, castX: number, castY: number) {
    this.type = type;
    this.duration = DURATION[type];
    this.castOrigin = { x: castX, y: castY };
  }

  get active(): boolean {
    return !this.ended;
  }

  /** Live orb state for the visual layer (index 0..15). */
  orbAt(index: number): { x: number; y: number; angle: number; state: number } | null {
    const orb = this.orbs[index];
    return orb && !orb.dead ? orb : null;
  }

  /** The shared cast helper 0x40be30 + each callback's cast-frame block. */
  cast(host: Th08BombHost, x: number, y: number): void {
    this.castOrigin = { x: F32(x), y: F32(y) };
    // 0x40be30: screen bullet clear (0x415d60/0x4413e0 family) at cast.
    host.clearBullets(x, y, 200);
    host.playSfx(0x0d, 0);
    if (this.type === 0 || this.type === 2) {
      host.effectVm(0x0c, x, y, 1, 0xff4040ff);
      let angle = F32(-Math.PI);
      for (let i = 0; i < ORB_COUNT; i++) {
        // 0x40c010/0x40c910: orb VM script 0x13, ring at -pi + i*pi/8.
        host.orbVm(i, 0x13);
        const speed = this.type === 0 ? SEEK_START_SPEED : 0; // dword 2
        this.orbs.push({
          state: 1,
          x: F32(x), y: F32(y),
          angle, speed,
          vx: 0, vy: 0,
          anchorX: F32(x), anchorY: F32(y),
          burstAge: 0,
          auraDamage: 0,
          dead: false
        });
        angle = F32(angle + PI_OVER_8);
        // The r64 aura (dmg 200, kind 2) + r128 clear pool entry per orb.
        host.addAttackSlot(x, y, 64, ORB_AURA_DAMAGE);
      }
      return;
    }
    // 0x410c40 / 0x410fe0: the r100 field (0x42c80000) around the player.
    const first = this.type === 1 ? 0x28 : 100; // dmg-slot arg (dword +0x24)
    host.addAttackSlot(x, y, 100, 70); // 0x4e040 field slot (kind 5)
    host.addAttackSlot(x, y, 100, first); // 0x4df00 pool entry
    // First wave VM 0x24/0x25 at angle 0x3f490fdb.
    host.effectVm(this.type === 1 ? 0x24 : 0x25, x, y, 4, 0xffffffff);
  }

  /**
   * One invocation of the type's callback. `playerX/playerY` is the live
   * player position (the field bombs anchor on it every frame).
   */
  tick(host: Th08BombHost, playerX: number, playerY: number, shootHeld: boolean): void {
    if (this.ended) return;
    void shootHeld;
    if (this.type === 0) this.tickOrbSeek(host, playerX, playerY);
    else if (this.type === 2) this.tickOrbCharge(host);
    else this.tickField(host, playerX, playerY);
    // The machine's end check runs after the callback: counter >= duration.
    if (this.frame + 1 >= this.duration) this.ended = true;
    else this.frame++;
  }

  /** 0x40c010: seek phase (<40) toward the primary cache, then spiral. */
  private tickOrbSeek(host: Th08BombHost, playerX: number, playerY: number): void {
    const t = this.frame;
    if (t === CHARGE_RELEASE_FRAME) {
      // The 0x28 edge block: every still-seeking orb releases at speed 8
      // along its current heading into the phase-B spiral.
      for (const orb of this.orbs) {
        if (orb.state !== 1) continue;
        orb.speed = SEEK_START_SPEED;
        orb.angle = Math.atan2(orb.vy, orb.vx);
      }
    }
    for (let i = 0; i < this.orbs.length; i++) {
      const orb = this.orbs[i];
      if (orb.dead) continue;
      if (orb.state === 1) {
        if (t < CHARGE_RELEASE_FRAME) {
          // FUN_00450320's formula against the primary target cache
          // (falls back to the player when the cache is unset, -999 gate).
          const target = host.targetPos ?? { x: playerX, y: playerY };
          const dx = F32(target.x - orb.x);
          const dy = F32(target.y - orb.y);
          const dist = Math.hypot(dx, dy);
          let denom = F32(dist / F32(orb.speed / SEEK_DIVISOR));
          if (denom < 1) denom = 1;
          const pullX = F32(F32(dx / denom) + orb.vx);
          const pullY = F32(F32(dy / denom) + orb.vy);
          const len = Math.hypot(pullX, pullY);
          let speed = len > SEEK_MAX_SPEED ? SEEK_MAX_SPEED : F32(len);
          if (speed < SEEK_MIN_SPEED) speed = SEEK_MIN_SPEED;
          orb.speed = F32(speed);
          if (len > 0) {
            orb.vx = F32(F32(pullX / len) * orb.speed);
            orb.vy = F32(F32(pullY / len) * orb.speed);
          }
          // The r128 clear entry tracks each orb every seek frame.
          host.clearBullets(orb.x, orb.y, 128);
          // Aura settles >= 200 damage (slot +0x30 vs +0x34): the aura's
          // per-frame addAttackSlot below feeds auraDamage.
          if (t >= this.duration - 30) {
            this.burstOrb(host, orb, BURST_DAMAGE_NORMAL);
            continue;
          }
        } else {
          // Phase B spiral: angle wobble by parity, radius grows 3.2/frame.
          orb.angle = normalizeAngle(orb.angle, (i & 1) === 0 ? SPIN_EVEN : SPIN_ODD);
          orb.speed = F32(orb.speed + SPIRAL_GROW);
          orb.x = F32(this.castOrigin.x + Math.cos(orb.angle) * orb.speed);
          orb.y = F32(this.castOrigin.y + Math.sin(orb.angle) * orb.speed);
        }
      } else if (orb.state === 2) {
        orb.burstAge++;
        if (orb.burstAge > 29) orb.dead = true; // dword 1 > 0x1d
      }
      if (orb.state === 1) {
        orb.x = F32(orb.x + orb.vx);
        orb.y = F32(orb.y + orb.vy);
        orb.auraDamage += host.addAttackSlot(orb.x, orb.y, 64, ORB_AURA_DAMAGE);
        if (orb.state === 1 && orb.auraDamage >= ORB_AURA_DAMAGE) {
          this.burstOrb(host, orb, BURST_DAMAGE_NORMAL);
        }
      }
    }
  }

  /** 0x40c910: orbs parked at the player, staggered bursts, bombardment. */
  private tickOrbCharge(host: Th08BombHost): void {
    const t = this.frame;
    for (let i = 0; i < this.orbs.length; i++) {
      const orb = this.orbs[i];
      if (orb.dead) continue;
      if (orb.state === 1) {
        orb.angle = normalizeAngle(orb.angle, (i & 1) === 0 ? SPIN_EVEN : SPIN_ODD);
        if (t >= CHARGE_RELEASE_FRAME) {
          orb.speed = F32(orb.speed + ((i & 1) === 0 ? CHARGE_ACCEL_EVEN : CHARGE_ACCEL_ODD));
        }
        orb.x = F32(orb.anchorX + Math.cos(orb.angle) * orb.speed);
        orb.y = F32(orb.anchorY + Math.sin(orb.angle) * orb.speed);
        // Staggered forced burst at duration-0x28-i (220-i).
        if (t >= this.duration - 0x28 - i) {
          this.burstOrb(host, orb, BURST_DAMAGE_DEATHBOMB);
          continue;
        }
      } else if (orb.state === 2) {
        orb.burstAge++;
        if (orb.burstAge > 29) orb.dead = true;
      }
    }
    if (t >= CHARGE_RELEASE_FRAME && (t - CHARGE_RELEASE_FRAME) % 20 === 0) {
      // 0x5241-0x5276: every ~20 frames past 40, an extra bombardment slot
      // (index 16+) lands on the primary target (or a random screen point
      // when unset): VM 0x14, r64 dmg 400 kind 2 + effect VMs 0x31/0x37.
      const fallback = host.targetPos ?? {
        x: F32(320 + Math.random() * 64 + 32),
        y: F32(384 + Math.random() * 64 + 32)
      };
      host.effectVm(0x31, fallback.x, fallback.y, 1, 0);
      host.effectVm(0x37, fallback.x, fallback.y, 1, 0);
      host.addAttackSlot(fallback.x, fallback.y, 64, 400);
      host.playSfx(0x0f, fallback.x);
    }
  }

  /** 0x410c40 / 0x410fe0: re-arm the r100 field and fire the wave VMs. */
  private tickField(host: Th08BombHost, playerX: number, playerY: number): void {
    const t = this.frame;
    // The field slots re-spawn at frames 10/20/30 with escalating wave VMs
    // (0x59/0x5a/0x5b for type 1, 0x5d/0x5e/0x5f for type 3).
    const waves: { at: number; script: number; angle: number }[] = [
      { at: 10, script: this.type === 1 ? 0x59 : 0x5d, angle: 0x3f96cbe4 },
      { at: 20, script: this.type === 1 ? 0x5a : 0x5e, angle: 0x3fc90fdb },
      { at: 30, script: this.type === 1 ? 0x5b : 0x5f, angle: 0x3ffb53d2 }
    ];
    for (const w of waves) {
      if (t === w.at) {
        host.addAttackSlot(playerX, playerY, 100, 70);
        host.addAttackSlot(playerX, playerY, 100, this.type === 1 ? 0x28 : 100);
        host.effectVm(this.type === 1 ? 0x24 : 0x25, playerX, playerY, 5, 0xffffffff);
        host.orbVm(1 + w.at / 10, w.script);
      }
    }
    // The field persists around the live player for the whole duration.
    host.addAttackSlot(playerX, playerY, 100, 70);
  }

  private burstOrb(host: Th08BombHost, orb: BombOrb, damage: number): void {
    host.clearBullets(orb.x, orb.y, 64);
    host.addAttackSlot(orb.x, orb.y, 64, damage);
    host.effectVm(6, orb.x, orb.y, 8, 0xffffffff);
    host.playSfx(0x0f, orb.x);
    host.playSfx(8);
    orb.state = 2;
    orb.burstAge = 0;
  }

  /** The per-frame gauge payment: ±26000/duration, bypassing the lock. */
  gaugeDeltaThisFrame(): number {
    const per = Math.trunc(26000 / this.duration);
    return (this.type & 1) === 1 ? per : -per;
  }
}

function normalizeAngle(a: number, delta: number): number {
  let v = F32(a + delta);
  while (v > Math.PI) v = F32(v - F32(2 * Math.PI));
  while (v <= -Math.PI) v = F32(v + F32(2 * Math.PI));
  return v;
}
