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
 *
 * Beam-group constants verified against the .rdata image of Th08.exe
 * (2026-08-24 static read): 0x4b4300=8.0 (attack width), 0x4b4308=4.0 (the
 * clear box's BOTH dims and the attack height — so clear width = attack/2),
 * 0x4b4524=pi/4, 0x4b4520=1/sqrt2, 0x4b4334=pi / 0x4b4460=2pi (wrap),
 * 0x4b4528=384 / 0x4b4440=192 / 0x4b42cc=32 (radius bases), 0x4b452c=88 /
 * 0x4b42e8=80 / 0x4b4530=50 (the size interpolation). The beam groups stay
 * anchored at the CAST point: the fixture's native gauge trajectory
 * (tests/th08-pacing.test.mjs f1276) pins this — the wave VMs' one-time
 * player-pos stores at 0x410c40 feed the wave ANIMATION, not the boxes.
 */

export interface Th08BombHost {
  /** Primary target cache (player+0xe2aa4, the enemy-manager max-y pick). */
  readonly targetPos: { x: number; y: number } | null;
  /**
   * Spawn a damaging attack area; `damage` is the native slot +0x34 value.
   * Returns the damage actually settled against live enemies (the slot
   * consumer's +0x30 accumulation).
   */
  addAttackSlot(
    x: number,
    y: number,
    radius: number,
    damage: number,
    cadenceCounter?: number,
    cadenceDivisor?: number
  ): number;
  /** FUN_0044dfa0 oriented rectangle from the boundary-wave callback. */
  addBoxAttackSlot(
    x: number,
    y: number,
    width: number,
    height: number,
    angle: number,
    damage: number,
    cadenceCounter?: number,
    cadenceDivisor?: number
  ): number;
  /** Clear enemy bullets inside the circle (FUN_0044df00 pools / 0x40be30). */
  clearBullets(x: number, y: number, radius: number): void;
  /** Oriented FUN_0044de60 clear paired with each boundary beam. */
  clearBulletsBox(x: number, y: number, width: number, height: number, angle: number): void;
  /** Shared gameplay RNG float used by the no-target deathbomb fallback. */
  randomFloat(): number;
  /** Effect VM request (FUN_00425430(script, pos, scale, color)). */
  effectVm(script: number, x: number, y: number, scale: number, color: number): void;
  /** Main effect-pool allocation paired with the authored VM request. */
  effectParticles(effectId: number, x: number, y: number, count: number, color: number): void;
  /** FUN_0045b8b0 type 1: independently scheduled camera shake. */
  startScreenShake(duration: number, from: number, to: number): void;
  /** FUN_0045b8b0 type 3: independently scheduled full-screen tint. */
  startScreenFlash(duration: number, repeats: number, argb: number): void;
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
// 0x40c010: FUN_0044e040(pos, r64, growth0, damage5, life200), then the
// slot's +0x34 threshold is overwritten to 200. Multiple live enemies can
// contribute five each in one pass; the old damage=200 transcription made
// every orb detonate on its first contact.
const ORB_AURA_DAMAGE = 5;
const ORB_AURA_THRESHOLD = 200;
// Detonation slots (0x40c010 / 0x40c910 burst writes).
const BURST_DAMAGE_NORMAL = 500;
const BURST_DAMAGE_DEATHBOMB = 50; // 0x32
const BURST_ATTACK_GROWTH_NORMAL = F32(12.8); // 0x414ccccd
const BURST_ATTACK_GROWTH_DEATHBOMB = F32(8.533333); // 0x41088889
const BURST_ATTACK_FRAMES_NORMAL = 12;
const BURST_ATTACK_FRAMES_DEATHBOMB = 15;
const BURST_CLEAR_GROWTH = F32(4.266667); // 0x40888889
const BURST_CLEAR_FRAMES = 30;
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
  burstDamage: number;
  auraDamage: number;
  dead: boolean;
}

interface BoundaryBeam {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  age: number;
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
  // 0x410c40/0x410fe0 allocate four independent expanding r100 fields.
  // They live in the native player+0xb8834 / +0xbb834 pools after the
  // callback returns; keep their ages here and republish their current
  // circles to the frame-local collision facade.
  private fieldAttacks: { age: number; life: number; x: number; y: number }[] = [];
  private fieldClears: { age: number; life: number; x: number; y: number }[] = [];
  private boundaryBeams: BoundaryBeam[] = [];
  // Per-group live visual state (FUN_004117b0's engine-driven fields): the
  // VM rotation +0x318 advances ±pi/80 every tick for the group's whole
  // life, so the four rendered frames keep spinning after the timer-50
  // publish. The port freezes the DAMAGE record at publish; the visuals
  // rotate about the group anchor at the published radius. Group colors are
  // the authored ins_9 rows of etama scripts 88-91 / 92-95.
  private beamGroupVisuals: {
    anchor: { x: number; y: number };
    angle: number;
    spin: number;
    radius: number;
    width: number;
    height: number;
    age: number;
  }[] = [];

  // §7 APPROXIMATION: the native wave VMs render through FUN_00464b00's
  // instance fan-out (FUN_004117b0's publish block passes +0x324*2+2), whose
  // exact quad topology is not recoverable statically. The port draws the
  // four proven beam quads per group, rotating at the native ±pi/80 rate.
  beamVisualFrames(): { x: number; y: number; width: number; height: number; angle: number; group: number }[] {
    const out: { x: number; y: number; width: number; height: number; angle: number; group: number }[] = [];
    const QUARTER = F32(PI_F / 2);
    for (let g = 0; g < this.beamGroupVisuals.length; g++) {
      const v = this.beamGroupVisuals[g];
      let radial = normalizeAngle(v.angle, F32(PI_F / 4));
      for (let i = 0; i < 4; i++) {
        out.push({
          x: F32(v.anchor.x + F32(Math.cos(radial) * v.radius)),
          y: F32(v.anchor.y + F32(Math.sin(radial) * v.radius)),
          width: v.width,
          height: v.height,
          angle: normalizeAngle(radial, QUARTER),
          group: g
        });
        radial = normalizeAngle(radial, QUARTER);
      }
    }
    return out;
  }

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
      host.effectParticles(12, x, y, 1, 0xff4040ff);
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
          burstAge: 0, burstDamage: 0,
          auraDamage: 0,
          dead: false
        });
        angle = F32(angle + PI_OVER_8);
        // The persistent r96 clear and r64/dmg5 aura are represented by the
        // state-1 publication below. The callback continues into that loop
        // on the cast frame, so allocating them here would duplicate it.
      }
      return;
    }
    // 0x410c40 / 0x410fe0: one expanding r100 damage field (growth 1,
    // damage 70, life 40) plus the matching clear field. Deathbomb type 3's
    // first clear lives 100 frames; its damage field is still only 40.
    // The cast callback publishes the raw r100 records after the current
    // item/bullet manager pass.  They are already visible at the replay
    // boundary (Stage-2 f697), but cannot be consumed by an ordinary bullet
    // until the following manager pass.  Keep age=1 for the next callback's
    // r101 publication and publish age zero synchronously here.
    this.fieldAttacks.push({ age: 1, life: 40, x: F32(x), y: F32(y) });
    this.fieldClears.push({
      age: 1,
      life: this.type === 1 ? 40 : 100,
      x: F32(x),
      y: F32(y)
    });
    host.addAttackSlot(x, y, 100, 70, 40, 5);
    host.clearBullets(x, y, 100);
    // The cast VM (archive script 0x58/0x5c) renders through
    // beamVisualFrames below — spawning a plain effect entry here drew an
    // unrotated 1x quad at the player (the frozen-beam visual bug).
  }

  /**
   * One invocation of the type's callback. `playerX/playerY` is the live
   * player position (the field bombs anchor on it every frame).
   */
  tick(host: Th08BombHost, playerX: number, playerY: number, shootHeld: boolean): void {
    // The authored wave scripts live 140 frames (etama 88-95) and the VM
    // rotation advance is unconditional in FUN_004117b0 — the visuals keep
    // spinning after the active bomb ends.
    for (const v of this.beamGroupVisuals) {
      v.angle = normalizeAngle(v.angle, v.spin);
      v.age++;
    }
    this.beamGroupVisuals = this.beamGroupVisuals.filter((v) => v.age < 140);
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
        this.publishBurstAreas(host, orb);
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
        // Cast-time r96/200 clear follows the orb throughout state 1; before
        // frame 40 the callback additionally publishes a one-pass r128
        // clear at the same location, which subsumes it spatially.
        host.clearBullets(orb.x, orb.y, t < CHARGE_RELEASE_FRAME ? 128 : 96);
        if (t < CHARGE_RELEASE_FRAME) {
          orb.x = F32(orb.x + orb.vx);
          orb.y = F32(orb.y + orb.vy);
        }
        // Aura settles >= 200 damage (slot +0x30 vs +0x34): the aura's
        // per-frame addAttackSlot feeds auraDamage.
        orb.auraDamage += host.addAttackSlot(orb.x, orb.y, 64, ORB_AURA_DAMAGE);
        if (orb.state === 1 && orb.auraDamage >= ORB_AURA_THRESHOLD) {
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
        host.clearBullets(orb.x, orb.y, 96);
        host.addAttackSlot(orb.x, orb.y, 64, ORB_AURA_DAMAGE);
        // Staggered forced burst at duration-0x28-i (220-i).
        if (t >= this.duration - 0x28 - i) {
          this.burstOrb(host, orb, BURST_DAMAGE_DEATHBOMB);
          continue;
        }
      } else if (orb.state === 2) {
        this.publishBurstAreas(host, orb);
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
      host.effectParticles(0x31, fallback.x, fallback.y, 1, 0xffffffff);
      host.effectParticles(0x37, fallback.x, fallback.y, 1, 0xffffffff);
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
      // The native ZunTimer is already current=1 on the first dispatched
      // callback: its 10/20/30 predicates therefore fire on this simulator's
      // zero-based callback frames 9/19/29.
      if (t + 1 === w.at) {
        this.fieldAttacks.push({
          age: 0,
          life: 40,
          x: F32(playerX),
          y: F32(playerY)
        });
        // 0x410c40 uses 40 for every clear. 0x410fe0 uses 40/100/100 at
        // t10/t20/t30 (all.c:7277-7370).
        const clearLife = this.type === 1 || w.at === 10 ? 40 : 100;
        this.fieldClears.push({
          age: 0,
          life: clearLife,
          x: F32(playerX),
          y: F32(playerY)
        });
        // The wave rings (archive scripts 0x59-0x5f) render through
        // beamVisualFrames below — see the cast-VM note.
        void w.script;
      }
    }
    // FUN_004117b0 is installed on the cast VM (scale 4) and the three
    // wave VMs (scales 5/6/7). On their timer-50 edge it publishes four
    // long oriented attack boxes through FUN_0044dfa0. The VM callback has
    // already executed 51 angle steps and its size fields still contain the
    // timer-49 interpolation, which is why the first native Stage-2 group
    // appears at replay f747 with width 1085.247 and height 38.4.
    if (t >= 49 && t <= 79 && (t - 49) % 10 === 0) {
      this.armBoundaryBeamGroup(host, (t - 49) / 10);
    }
    for (const field of this.fieldAttacks) {
      // FUN_0044e040 copies the player's position only when allocating the
      // persistent record. Callback 1/3 then sets record+0x38=5, so the
      // enemy collision scan settles damage only when its remaining-life
      // counter (+0x24) is divisible by five.
      host.addAttackSlot(
        field.x,
        field.y,
        F32(100 + field.age),
        70,
        field.life - field.age,
        5
      );
      field.age++;
    }
    this.fieldAttacks = this.fieldAttacks.filter((field) => field.age < field.life);
    for (const field of this.fieldClears) {
      host.clearBullets(field.x, field.y, F32(100 + field.age));
      field.age++;
    }
    this.fieldClears = this.fieldClears.filter((field) => field.age < field.life);
    for (const beam of this.boundaryBeams) {
      // FUN_004117b0 publishes both native records on the timer-50 callback.
      // That callback runs after the enemy manager but before the bullet
      // manager: age zero can clear bullets immediately, while enemies must
      // not consume its damage until a later frame. StageScene's host runs
      // before both managers, so defer only the attack projection by one
      // tick and publish the paired clear box below without that delay.
      const attackRemaining = 100 - beam.age;
      if (beam.age > 0 && attackRemaining > 0) {
        host.addBoxAttackSlot(
          beam.x, beam.y, beam.width, beam.height, beam.angle,
          60, attackRemaining, 2
        );
      }
      // The paired FUN_0044de60 record uses half the attack width, the same
      // 38.4px height and a 150-frame lifetime. The active bomb ends before
      // that clear record, but retaining it for this callback's lifetime is
      // sufficient for the delivered Stage-1/2 player state machine.
      host.clearBulletsBox(
        beam.x, beam.y, F32(beam.width / 2), beam.height, beam.angle
      );
      beam.age++;
    }
    this.boundaryBeams = this.boundaryBeams.filter((beam) => beam.age < 150);
  }

  private armBoundaryBeamGroup(host: Th08BombHost, group: number): void {
    // FUN_004117b0 calls FUN_0045b8b0 twice before publishing the boxes:
    // type 1 is a 16-frame 8->0 camera shake and type 3 is the authored
    // purple, eight-frame overlay. ScreenInf jobs are registered at priority
    // 0x15, after this effect-manager callback, so their first update is the
    // following frame. The shake's FUN_0045bdc0 callback advances its timer
    // before sampling and consumes two FUN_00406ef0(3) u32 draws at timer
    // values 1..15; overlapping groups remain independent scheduler jobs.
    host.startScreenShake(16, 8, 0);
    host.startScreenFlash(8, 1, 0x8f6060f0);
    const scale = 4 + group;
    // FUN_004117b0's timer-49 size interpolation followed by its sqrt(1/2)
    // radial projection. Keep the intermediate f32 stores: they reproduce
    // the native widths 1085.247/1266.194/1447.141/1628.088.
    const phase = F32(1 - F32(49 / 50));
    const outer = F32(group * 32 + 384);
    const base = F32(group * 32 + 192);
    const authoredRadius = F32(base - F32(outer * F32(phase * phase)));
    const radius = F32(authoredRadius * F32(Math.SQRT1_2));
    const width = F32(radius * 8);
    const height = F32(F32(88 - F32(F32(49 * 80) / 50)) * 4);

    // Initial angles are pi/4, 3pi/8, pi/2, 5pi/8. Even VM scales rotate
    // -pi/80 and odd scales +pi/80 once per callback, including the timer-50
    // edge; the box direction is another +pi/2 from its radial position.
    let vmAngle = F32(F32(PI_F / 4) + F32(group * F32(PI_F / 8)));
    const spin = (scale & 1) === 0 ? F32(-PI_F / 80) : F32(PI_F / 80);
    for (let i = 0; i < 51; i++) vmAngle = normalizeAngle(vmAngle, spin);
    // The visual keeps rotating from the publish-time VM angle at the same
    // native ±pi/80 rate (FUN_004117b0 advances +0x318 unconditionally).
    this.beamGroupVisuals.push({
      anchor: { x: this.castOrigin.x, y: this.castOrigin.y },
      angle: vmAngle,
      spin,
      radius,
      width,
      height,
      age: 0
    });
    let radial = normalizeAngle(vmAngle, F32(PI_F / 4));
    for (let i = 0; i < 4; i++) {
      const x = F32(this.castOrigin.x + F32(Math.cos(radial) * radius));
      const y = F32(this.castOrigin.y + F32(Math.sin(radial) * radius));
      const angle = normalizeAngle(radial, F32(PI_F / 2));
      this.boundaryBeams.push({ x, y, width, height, angle, age: 0 });
      radial = angle;
    }
  }

  private burstOrb(host: Th08BombHost, orb: BombOrb, damage: number): void {
    host.clearBullets(orb.x, orb.y, 64);
    host.addAttackSlot(orb.x, orb.y, 64, damage);
    // FUN_00425430(6 = effect 6): DAT_004c6d30[6] → archive script 38; the
    // settle plays sfx id 15 with the orb x as its pan value (0x40c667).
    host.effectVm(38, orb.x, orb.y, 8, 0xffffffff);
    host.effectParticles(6, orb.x, orb.y, 8, 0xffffffff);
    host.playSfx(0x0f, orb.x);
    orb.state = 2;
    orb.burstAge = 0;
    orb.burstDamage = damage;
  }

  private publishBurstAreas(host: Th08BombHost, orb: BombOrb): void {
    const deathbomb = orb.burstDamage === BURST_DAMAGE_DEATHBOMB;
    const attackFrames = deathbomb
      ? BURST_ATTACK_FRAMES_DEATHBOMB
      : BURST_ATTACK_FRAMES_NORMAL;
    const attackGrowth = deathbomb
      ? BURST_ATTACK_GROWTH_DEATHBOMB
      : BURST_ATTACK_GROWTH_NORMAL;
    // burstOrb published age zero synchronously. State 2 starts on the next
    // callback, so publish ages 1..N-1 here for the native total lifetime.
    const age = orb.burstAge + 1;
    if (age < BURST_CLEAR_FRAMES) {
      host.clearBullets(orb.x, orb.y, F32(64 + BURST_CLEAR_GROWTH * age));
    }
    if (age < attackFrames) {
      host.addAttackSlot(orb.x, orb.y, F32(64 + attackGrowth * age), orb.burstDamage);
    }
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
