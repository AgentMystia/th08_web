/**
 * TH08 Border Team bombs, transcribed from the v1.00d callbacks.
 *
 * The bomb state machine (Th08.exe 0x44c650) calls ONE per-frame function for
 * the whole bomb, selected by bombType from the five-entry table copied to
 * player+0x1000 by Player::AddedCallback (rdata 0x4c7ad0, team block 0):
 *
 *   type 0 = 0x40c010  unfocused "Reimu" bomb   (16 seeking orbs + spiral, 200f)
 *   type 1 = 0x410c40  focused  "Yukari" bomb   (r100 field + 3 waves,     150f)
 *   type 2 = 0x40c910  focused-cast deathbomb   (16 charging orbs, staggered
 *                                                bursts, target bombardment)
 *   type 3 = 0x410fe0  unfocused-cast deathbomb (r100 field, stronger waves, 300f)
 *
 * A deathbomb INVERTS the side before adding +2 (0x44c7f7: fe0 = 1 - focus),
 * so casting focused runs table[2] and casting unfocused runs table[3].
 * 0x40be30 takes two counts, and BOTH are live clocks. param_4 lands at
 * player+0xfe4 and is the ACTIVE bomb length: the machine's end compare
 * (0x44c667), the deathbomb's staggered-burst gate (param_4-0x28-i) and
 * the type-0 aura-burst gate (param_4-0x1e) all read it, and the gauge
 * pays ±26000/param_4 per frame (0x44c81b-0x44c850, lock bypassed).
 * param_5 arms the separate, LONGER timer at player+0xe2af4 — the
 * post-cast invulnerability that outlives the active bomb.
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
  /** Shared gameplay RNG float used by the no-target deathbomb fallback. */
  randomFloat(): number;
  /** Effect VM request (FUN_00425430(script, pos, scale, color)). */
  effectVm(script: number, x: number, y: number, scale: number, color: number): void;
  /**
   * Orb VM request (FUN_004069f0(slotVm, script) on the 0x16f0-strided
   * pool). x/y are the spawn position — the bombardment slots (16/17)
   * draw at the TARGET, not the player.
   */
  orbVm(index: number, script: number, x?: number, y?: number): void;
  playSfx(id: number, arg?: number): void;
}

export type Th08BombType = 0 | 1 | 2 | 3;

// 0x40be30's param_4 → player+0xfe4: the ACTIVE bomb length. The state
// machine ends the callback when the count-up reaches it (0x44c667), the
// deathbomb's staggered bursts fire at (param_4-0x28-i), and the type-0
// aura-burst gate is (param_4-0x1e).
const DURATION: Record<Th08BombType, number> = { 0: 200, 1: 150, 2: 200, 3: 250 };
// 0x40be30's param_5: the separate, LONGER clock at player+0xe2af4 — the
// post-cast invulnerability that outlives the active bomb.
export const TH08_BOMB_INVULN: Record<Th08BombType, number> = { 0: 260, 1: 200, 2: 260, 3: 300 };
// The gauge denominator is the same param_4 (±26000 per active frame).
const GAUGE_DENOMINATOR: Record<Th08BombType, number> = DURATION;

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
const SEEK_DIVISOR = 8; // _DAT_004b4300
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
  // Next bombardment slot index (16+, the 0x40c910 latch at bombmgr+0x14).
  private bombardments = 0;
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
    host.playSfx(0x0d, 0);
    if (this.type === 0 || this.type === 2) {
      // FUN_00425430(0xc = effect 12): DAT_004c6d30[12] → archive script 44.
      host.effectVm(44, x, y, 1, 0xff4040ff);
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
        // FUN_0044df00's cast pool is r96; the r64 damage aura is the
        // separate FUN_0044e040 allocation. All sixteen pools overlap at
        // cast, but fixed-pool identity remains per orb in the executable.
        host.clearBullets(x, y, 96);
        host.addAttackSlot(x, y, 64, ORB_AURA_DAMAGE);
      }
      return;
    }
    // 0x410c40 / 0x410fe0: the r100 field (0x42c80000) around the player.
    const first = this.type === 1 ? 0x28 : 100; // dmg-slot arg (dword +0x24)
    host.addAttackSlot(x, y, 100, 70); // 0x4e040 field slot (kind 5)
    host.addAttackSlot(x, y, 100, first); // 0x4df00 pool entry
    host.clearBullets(x, y, 100);
    // First wave VM 0x24/0x25 at angle 0x3f490fdb.
    // Effect ids 0x24/0x25 map through DAT_004c6d30 to archive scripts
    // 0x58/0x5c. Those scripts deliberately use etama3's tall blue/red
    // boundary texture; the raw ids point at unrelated archive scripts.
    host.effectVm(this.type === 1 ? 0x58 : 0x5c, x, y, 4, 0xffffffff);
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
        } else {
          // Phase B spiral (all.c:5022-5035): TH08's polar convention is
          // x=sin(angle), y=cos(angle). Position uses the CURRENT radius,
          // then the radius grows for the next callback. This branch does
          // not receive the seek phase's trailing velocity integration.
          orb.angle = normalizeAngle(orb.angle, (i & 1) === 0 ? SPIN_EVEN : SPIN_ODD);
          orb.x = F32(this.castOrigin.x + Math.sin(orb.angle) * orb.speed);
          orb.y = F32(this.castOrigin.y + Math.cos(orb.angle) * orb.speed);
          orb.speed = F32(orb.speed + SPIRAL_GROW);
        }
      } else if (orb.state === 2) {
        orb.burstAge++;
        if (orb.burstAge > 29) orb.dead = true; // dword 1 > 0x1d
      }
      // FUN_0040b8e0(param_4 - 0x1e) gates BOTH phases (0x40c036 outer
      // compare): every still-live orb force-bursts in the last 30 frames.
      if (orb.state === 1 && t >= this.duration - 30) {
        this.burstOrb(host, orb, BURST_DAMAGE_NORMAL);
        continue;
      }
      if (orb.state === 1) {
        if (t < CHARGE_RELEASE_FRAME) {
          orb.x = F32(orb.x + orb.vx);
          orb.y = F32(orb.y + orb.vy);
        }
        // Aura settles >= 200 damage (slot +0x30 vs +0x34): the aura's
        // per-frame addAttackSlot feeds auraDamage.
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
        // all.c:5198-5209: the deathbomb uses the same x=sin/y=cos polar
        // convention. Acceleration is written AFTER this frame's position,
        // so frame 40 remains parked and frame 41 uses the first increment.
        orb.x = F32(orb.anchorX + Math.sin(orb.angle) * orb.speed);
        orb.y = F32(orb.anchorY + Math.cos(orb.angle) * orb.speed);
        if (t >= CHARGE_RELEASE_FRAME) {
          orb.speed = F32(orb.speed + ((i & 1) === 0 ? CHARGE_ACCEL_EVEN : CHARGE_ACCEL_ODD));
        }
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
        // FUN_0040d390(320/384) + 32: two draws from the shared game RNG,
        // not Math.random and not the old bottom-right 64px corner box.
        x: F32(host.randomFloat() * 320 + 32),
        y: F32(host.randomFloat() * 384 + 32)
      };
      // FUN_004069f0(slot16+n, 0x14): the bombardment's own orb VM (the
      // 20-frame 4x flash family), plus effects 0x31/0x37 and the r64
      // damage-400 slot at the target (0x40d047-0x40d0a0).
      // The 0x40c910 latch writes literal 1 after each spawn: slot 16 for
      // the first bombardment, then slot 17 for every following one.
      host.orbVm(16 + (this.bombardments > 0 ? 1 : 0), 0x14, fallback.x, fallback.y);
      // Effect ids 0x31/0x37 map to archive scripts 0x56/0x57.
      host.effectVm(0x56, fallback.x, fallback.y, 1, 0);
      host.effectVm(0x57, fallback.x, fallback.y, 1, 0);
      host.addAttackSlot(fallback.x, fallback.y, 64, 400);
      host.playSfx(0x0f, fallback.x);
      this.bombardments++;
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
        host.clearBullets(playerX, playerY, 100);
        // The wave rings are etama VMs (archive scripts 0x59-0x5f), not
        // player00 orb art. Native creates effect id 0x24/0x25 and replaces
        // that same VM's base 0x58/0x5c script immediately; spawning both
        // left an unrelated base effect behind in the port.
        host.effectVm(w.script, playerX, playerY, 1, 0xffffffff);
      }
    }
    // The field persists around the live player for the whole duration.
    host.addAttackSlot(playerX, playerY, 100, 70);
  }

  private burstOrb(host: Th08BombHost, orb: BombOrb, damage: number): void {
    host.clearBullets(orb.x, orb.y, 64);
    host.addAttackSlot(orb.x, orb.y, 64, damage);
    // FUN_00425430(6 = effect 6): DAT_004c6d30[6] → archive script 38; the
    // settle plays sfx id 15 with the orb x as its pan value (0x40c667).
    host.effectVm(38, orb.x, orb.y, 8, 0xffffffff);
    host.playSfx(0x0f, orb.x);
    orb.state = 2;
    orb.burstAge = 0;
  }

  /**
   * The per-frame gauge payment: ±trunc(26000/player+0xfe4), bypassing the
   * lock (0x44c81b-0x44c850). Odd (youkai-side) types pay positive.
   */
  gaugeDeltaThisFrame(): number {
    const per = Math.trunc(26000 / GAUGE_DENOMINATOR[this.type]);
    return (this.type & 1) === 1 ? per : -per;
  }
}

function normalizeAngle(a: number, delta: number): number {
  let v = F32(a + delta);
  while (v > Math.PI) v = F32(v - F32(2 * Math.PI));
  while (v <= -Math.PI) v = F32(v + F32(2 * Math.PI));
  return v;
}
