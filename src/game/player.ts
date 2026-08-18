import { Sht, type ShtShot } from '../formats/sht';
import { Anm, AnmRunner } from '../formats/anm';
import { TH08_DATA } from '../data/th08-data';
import { clamp } from '../core/util';
import type { InputFrame } from '../core/input';

// TH08 (Imperishable Night) player: the Border Team is the single
// supported character. Movement speeds, hitbox, item radii, PoC line, and
// the per-power shooter tables all come from the embedded ply00a/ply00as
// .sht data; the bomb is the TH08 declaration machine (tryBomb latches the
// type, StageScene applies duration/invuln from the v1.00d tables).

// The Border Team is the only constructible character. The three TH07 ids
// below stay in the union ONLY because stage-scene.ts (not owned by this
// cleanup) still compares against them in its bomb clear-fade guards; they
// have no CHARACTERS row and can never select other data.
export type CharacterId = 'reimuYukari' | 'reimuA' | 'marisaB' | 'sakuyaB';

// TH07's MarisaB-only shot-allocation gate (Th07.exe FUN_0043a820 @
// 0x43a850-0x43a86b) is deleted along with the TH07 characters: TH08
// allocates player shots normally while a bomb is active. Kept as an
// export because stage-scene.ts (read-only here) still routes its fire
// gate through it.
export function playerShotAllocationAllowed(_character: CharacterId, _bombActive: boolean): boolean {
  return true;
}

// TH08 Border Team: human reads ply00a, focused Yukari reads ply00as.
// The deathbomb window is read from the .sht data (deathbombWindow, int32
// at header offset 8) rather than hardcoded here.
export const CHARACTERS = {
  family: 0,
  name: 'Reimu & Yukari',
  shtBase: 'ply00a',
  anmKey: 'player00'
} as const;

export interface PlayerBullet {
  // Stable slot in Th07.exe's 96-entry player-shot pool. Each firing pass
  // scans from slot 0, so slots freed by movement are reusable immediately.
  poolSlot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  speed: number;
  damage: number;
  shotType: number;
  // ShtShot.funcs[0], the spawn-time behavior selector: 4 = aim at an enemy
  // at spawn (SakuyaA focused); 5 = SakuyaB orbit-angle bank. TH08 Border
  // Team: 1 = aim at the cached target at spawn (FUN_00450240).
  behaviorFunc: number;
  // ShtShot.funcs[1], the per-tick behavior selector (TH08 uses it: 1 = the
  // seeking option tick FUN_00450320). Always 0 on the TH07 shot tables.
  tickFunc: number;
  hitboxW: number;
  hitboxH: number;
  sfxId: number; // from ShtShot.sfxId; playback not wired up (stage-scene.ts uses a fixed fire sound instead)
  age: number;
  state: 'fired' | 'collided';
  hitAge: number;
  // Per-shot ANM VM (Th07.exe: SHT `sprite` is a global ANM script id at
  // player base 1024; FUN_0043a290 ticks the embedded VM each frame and the
  // bullet dies when its script ends). Scripts carry the vanilla alpha/
  // scale/spin/auto-rotate; the impact switch re-arms the VM with script
  // sprite+0x20 (FUN_0043a980 @ 0x43aa8c: slot+0x1d8 += 0x20).
  runner: AnmRunner;
  impactScript: number;
  rect: { x: number; y: number; w: number; h: number; imageKey: string };
  dead?: boolean;
  // TH08 dialogue drift (FUN_004413e0): shot flagged harmless with velocity
  // (0, -0.5) while a conversation plays; never restored — expires offscreen.
  driftHarmless?: boolean;
  // Which option fired this shot (0 = player) and the record's own x offset —
  // MarisaB's persistent lasers (types 4/5) re-anchor to these every frame.
  orb: number;
  anchorX: number;
  // Per-frame vertical sprite stretch for the beam types (exe writes the VM
  // scaleY directly: optionY/14 resp. (playerY+64)/14 — sprite 70 is 14px).
  scaleYOverride?: number;
  // Type 5 beam-history ring: the physical ring is always 16 entries, while
  // historyDepth caches the spawning SHT record's interval and limits both
  // helper collision boxes and alpha-faded ghost draws.
  history?: { x: number; y: number }[];
  historyDepth?: number;
  // Beam release-fade request (exe slot+0x1c6): the ANM VM only consumes the
  // interrupt while parked at its waitInt checkpoint, so the request re-tries
  // each frame until delivered (spec-marisab-beams.md §0.4).
  fadePending?: boolean;
}

// Option (orb) offsets relative to the player; fire origins for orb shots.
// Th07.exe FUN_0043be00 option state machine (per-state constants re-read
// 2026-07: settled unfocused = (∓24, 0), settled focused = (∓8, −32);
// cross-validated vs the MarisaB laser gates (state 1 vs 3) and SakuyaB's
// orbit rest point. Overturns the earlier 0x43cb30 (∓32,+8) misread —
// see reference/re-specs/exe-player-shot.md §4.
const ORB_OFFSETS = {
  unfocused: { 1: { x: -24, y: 0 }, 2: { x: 24, y: 0 } },
  focused: { 1: { x: -8, y: -32 }, 2: { x: 8, y: -32 } }
} as const;

// Frames to glide between the unfocused/focused layouts on a focus-state
// change, and the interpolation formula, both CONFIRMED directly from the
// exe's tween state machine: the option X half-spread eases QUADRATICALLY,
// while Y eases LINEARLY. Th07.exe FUN_0043be00 (v1.00b), all.c:28343-28345
// and 28360-28362: focus-in is xHalf=24-16*t², y=-32*t; focus-out is
// xHalf=8+16*t², y=-32+32*t, where t=frame/8 after the frame's counter
// tick.
const GLIDE_FRAMES = 8;

// Player spawn / lifecycle, decoded from Th07.exe (v1.00b). The exe drives
// the player through a state byte at player+0x2408 (dispatcher fcn.0043eef0):
//   0 normal       controllable, vulnerable.
//   1 materialize  30-frame respawn-in (fcn.0043e170): scaleX 0->1, scaleY
//                  3->1, alpha 0->255, input locked; exits to state 3.
//   2 dying        deathbomb window + 30-frame death clock (fcn.0043dca0).
//   3 invuln       countdown (fcn.0043e2e0); sprite dark-tinted 0x404040 on
//                  frames where (timer & 7) < 2.
// Player::Init (fcn.0043f320 @ 0x43f320) spawns directly at the spawn point
// and preloads the materialize timer past its 0x1d threshold, so stage start
// SKIPS the materialize and enters a 240-frame (0xf0) invulnerability window.
// There is NO entrance fly-in in the original: the player is simply present,
// invulnerable. Respawn after death (die()) DOES run the materialize in place.
export const SPAWN_X = 192;
// y = fieldH - 64 (Init: DAT_00625850 - 64.0 @ 0x43f38a, 64.0 = rdata
// 0x48eb68); fieldH = 448 -> 384.
export const SPAWN_Y = 384;
// fcn.0043e170: materialize ramps over 30 frames (threshold 0x1d, divisor
// 30.0 = rdata 0x48eb60); at frame 30 it hands off to a 240-frame (0xf0)
// invuln window (fcn.0043e2e0).
const MATERIALIZE_FRAMES = 30;
const SPAWN_INVULN_FRAMES = 240;
// fcn.0043dca0 (+0x23f8==0 branch): after the deathbomb window lapses, a
// 30-frame in-place death squish (scaleX 1->0, scaleY 1->4) plays BEFORE the
// respawn teleport + materialize.
const DEATH_SQUISH_FRAMES = 30;

export class Player {
  x = SPAWN_X;
  y = SPAWN_Y;
  readonly character: CharacterId;
  readonly unfocused: Sht;
  readonly focused: Sht;
  readonly anm: Anm;
  focusHeld = false;
  // Frames elapsed since the last focus-state toggle, saturating at
  // GLIDE_FRAMES once the orb glide has settled; see orbOffset().
  private focusGlideFrame = GLIDE_FRAMES;
  // TH07 SakuyaB's option-orbit accumulator. The orbit STEER is deleted
  // with the TH07 characters; the field itself stays parked at its -PI/2
  // rest value because stage-scene.ts (read-only here) still reads it in
  // its behavior-func-5 (SakuyaB orbit-bank) spawn branch, which no
  // Border Team SHT record can ever select (ply00a/ply00as funcs[0] are
  // only 0/1).
  orbitAngle = -Math.PI / 2;
  shooting = false;
  // -1 while not shooting so that the first held frame lands on fireFrame 0
  // (see update()): a shot with delay 0 must fire on the very press frame,
  // not "interval" frames later.
  fireFrame = -1;
  private fireFrameFrac = 0;
  // FUN_0043a820 keeps the prior integer split-counter value separately and
  // only runs the shooter table when the integer phase changes.
  private prevFireFrame = -999;
  bullets: PlayerBullet[] = [];
  // TH07 MarisaB's persistent-laser slot tracker. The laser SPAWNING is
  // deleted with the TH07 characters (no ply00a record has funcs[0] 2/3, so
  // the array can never be populated); the field itself stays because
  // stage-scene.ts (read-only here) still iterates it in its beam tick and
  // bullet-reject paths.
  laserSlots: ({ bullet: PlayerBullet; timer: number; fading: boolean; shot: ShtShot } | null)[] = [null, null, null];
  lives = 2;
  bombs = 3;
  power = 0;
  // TH08 Border Team focused option (Yukari's shikigami familiar): the exe
  // runs a per-frame 0.2-lerp toward (player.x, max(32, player.y - 96))
  // (FUN_0044e770) and snaps to that anchor on the focus-in intro state
  // (FUN_0044e3a0 state 1). Option-sourced SHT records spawn from this live
  // position (player+0x6b0 read in the FUN_0044fb70 spawner).
  th08OptionX = 0;
  th08OptionY = 0;
  th08OptionLive = false;
  // The familiar's own ANM VM (player00 script 18), live only while focused.
  th08OptionRunner: AnmRunner | null = null;
  // The enemy-lunge (FUN_0044e3a0 sub-state 3, entered from FUN_0044e770's
  // tail when the shot cycle is armed, its counter >= 10, and the enemy
  // manager's pointer cache 0x18b89b4 holds a target): the option's anchor
  // switches to (enemy.x, max(32, enemy.y + 32)) via FUN_0044e8d0 — Ran
  // herself flies onto the enemy while her needles pour out point-blank.
  th08OptionLunge = false;
  // Live anchor fed by the scene each frame from the enemy manager's pointer
  // cache (the |x-224|<=64, upper-most enemy pick at 0x42d4a6).
  th08LungeTarget: { x: number; y: number } | null = null;
  // Frames since the last focus toggle (Timer player+0xe2ae8, Selected 0 at
  // each transition, 0x44b1b1/0x44b404): drives the gauge fire-rate ramp
  // (<=300 -> 20/frame, then counter/15, 0x44be67).
  th08FocusFrames = 0;
  // TH08 human(0)/youkai(1) form byte — exe player+5, read by FUN_0040bc40.
  // Teams flip it from the focus key through a stability gate: the native
  // counter (player+8, reset at each toggle) must exceed 6 first
  // (FUN_0044aec0 @ player-other.c:135-138/180-183) — with this port's
  // 1-based th08FocusFrames that is the 8th frame counting the toggle, i.e.
  // seven frames after the edge. Solos pin it by character-index parity
  // (out of slice scope). Enemy familiars gate their whole tangibility on
  // this byte; bomb side selection reads it too.
  th08Form: 0 | 1 = 0;
  // One-shot form-transition requests for the scene's etama effect layer
  // (FUN_0044aec0's toggle branch): 28 = effect 0x1c, the blue to-human
  // tint 0x808080ff; 29 = effect 0x1d, the red to-youkai tint 0x80ff8080.
  // Played only when the previous form held >= 5 frames (native `3 <
  // counter`, the 0-based stable count). Cleared by the scene each frame.
  pendingTh08FormEffect: 0 | 28 | 29 = 0;
  // Focus-in spawns the aura VM (FUN_00425870(0x16, pos, 2, 1, white),
  // handle player+0xbe834); focus-out fires interrupt 1 on it. Scene-owned.
  pendingTh08Aura: 'in' | 'out' | null = null;
  // TH08 bomb type (player+0xfe0): 0 human / 1 youkai / 2|3 deathbomb (the
  // side INVERTS before +2, 0x44c7f7). Latched by tryBomb.
  th08BombType: 0 | 1 | 2 | 3 = 0;
  invulnFrames = 0;
  // Player state-3's timer is the native {integer current, f32 fraction}
  // pair at +0x16a08/+0x16a04, retreated through FUN_00436a06. Keeping one
  // JS double made 1/3 slowmo retain a tiny positive tail for three extra
  // wall frames and shifted the player-shot collision gate in Stage 5.
  invulnFrac = 0;
  // Persistent deathbomb meter, exe player+0x23f8 (site enumeration in
  // recon exe-player-hit.md): seeded to SHT.deathbombWindow at spawn and at
  // the materialize->invuln handoff (0x43e2c7), zeroed while materializing
  // (0x43e237), decremented once per WALL-CLOCK frame while in the hit
  // state (0x43dcd9, no slow-rate term), and bumped min(N, meter+6) on
  // EVERY successful bomb (0x43dc4f-0x43dc7f). It doubles as the universal
  // bomb gate: the trigger fails outright while it reads 0 (0x43db08).
  deathbombMeter = 0;
  // Exe player state 2 while the meter is still nonzero: hit taken, the
  // deathbomb window is running. A hit never reloads the meter.
  hitState = false;
  // -1 when idle; 0..DEATH_SQUISH_FRAMES during the post-death squish (exe
  // state 2 with meter==0, fcn.0043dca0): scaleX=1-t, scaleY=1+3t, in place
  // at the death loc. Advances on the global split counter (FUN_00436acc).
  dyingFrame = -1;
  // -1 when idle; 0..MATERIALIZE_FRAMES during the respawn materialize (exe
  // state 1, fcn.0043e170): scaleX=t, scaleY=3-2t, alpha=t, t=frame/30.
  // Advances on the global split counter like the squish.
  materializeFrame = -1;
  bombTimer = 0;
  // Th07.exe player+0x23fc: shared 40-frame post-Border cooldown. Both
  // FUN_0043eb00 (break/cancel) and FUN_0043e620 (natural expiry) write 40;
  // FUN_0043d9a0 decrements it before accepting a normal held-X bomb.
  bombCooldown = 0;
  bombInvuln = 0;
  // Focus state latched at cast (exe player+0x16a24) — selects which side's
  // bomb declaration runs for the WHOLE bomb; toggling focus mid-bomb must
  // not change it.
  bombFocused = false;
  runner: AnmRunner;
  private poseState: 'idle' | 'left' | 'right' = 'idle';

  constructor(character: CharacterId, anms: Record<string, Anm>) {
    // `character` is vestigial: the Border Team is the single character, so
    // its ply00a/ply00as data loads regardless of the id passed in.
    this.character = character;
    const spec = CHARACTERS;
    const sht = TH08_DATA.sht as Record<string, string>;
    this.unfocused = new Sht(sht[spec.shtBase]);
    this.focused = new Sht(sht[`${spec.shtBase}s`]);
    this.anm = anms[spec.anmKey];
    this.bombs = Math.trunc(this.unfocused.bombs);
    // Exe Player::Init (0x43f320) seeds the deathbomb meter from the SHT.
    this.deathbombMeter = Math.trunc(this.unfocused.deathbombWindow);
    this.runner = new AnmRunner(this.anm, 0);
    // Stage start skips materialize (Init preloads its timer past threshold)
    // and enters the 240-frame spawn invulnerability directly
    // (fcn.0043f320 -> fcn.0043e2e0). The player is simply present, not flying in.
    this.invulnFrames = SPAWN_INVULN_FRAMES;
  }

  get sht(): Sht {
    return this.focusHeld ? this.focused : this.unfocused;
  }

  get hitboxHalf(): number {
    // sht hitbox/grazebox are FULL widths; the exe halves them at point of use
    // (rdata 2.0 @ 0x48eac0). Reimu hitbox 1.65 full => 0.825 half.
    return this.sht.hitbox / 2;
  }

  get grazeboxHalf(): number {
    return this.sht.grazebox / 2;
  }

  get alive(): boolean {
    // Not hittable/firable during the deathbomb window, the death squish, or
    // the respawn materialize (exe states 2/1); the invuln window (state 3) IS
    // alive.
    return !this.hitState && this.dyingFrame < 0 && this.materializeFrame < 0;
  }

  get controllable(): boolean {
    // Input is locked during the deathbomb window, the death squish, and the
    // respawn materialize; the spawn/respawn invuln window itself is
    // controllable.
    return !this.hitState && this.dyingFrame < 0 && this.materializeFrame < 0;
  }

  // Render transform for the death squish (exe state 2). null when not dying;
  // otherwise scaleX=1-t, scaleY=1+3t (fcn.0043dca0), t=frame/30.
  dyingTransform(): { scaleX: number; scaleY: number } | null {
    if (this.dyingFrame < 0) return null;
    const t = this.dyingFrame / DEATH_SQUISH_FRAMES;
    return { scaleX: 1 - t, scaleY: 1 + 3 * t };
  }

  // Render transform for the respawn materialize (exe state 1). null when not
  // materializing; otherwise the exe's ramps (fcn.0043e170: t=frame/30,
  // scaleX=t, scaleY=3-2t, alpha=t).
  materializeTransform(): { scaleX: number; scaleY: number; alpha: number } | null {
    if (this.materializeFrame < 0) return null;
    const t = this.materializeFrame / MATERIALIZE_FRAMES;
    return { scaleX: t, scaleY: 3 - 2 * t, alpha: t };
  }

  // `rate` = global slow-motion rate: movement scales directly, the
  // player-side timers accumulate fractionally (spec-slowmo.md §3.1/§3.2).
  update(input: InputFrame, rate = 1, allowShotArm = true): void {
    this.updateFocusGlide(input.held.has('focus'), rate);
    this.th08FocusFrames++;
    // FUN_0044aec0 tails: the form byte flips once the stable counter
    // passes 6 (player+8; 1-based here -> flip at 8). th08FocusFrames
    // was zeroed on the toggle frame and incremented right above, so
    // the flip lands on the 8th frame counting the toggle itself.
    if (this.th08FocusFrames > 7) this.th08Form = this.focusHeld ? 1 : 0;
    // The focused option follows its anchor with the exe's 0.2 lerp
    // (FUN_0044e770); on focus-in it snaps to the anchor first. While the
    // lunge trigger holds (FUN_0044e770 tail: cycle armed, counter >= 10,
    // pointer-cache target alive) the anchor is the ENEMY (FUN_0044e8d0:
    // enemy pos with y+32, clamped >= 32) instead of the player.
    const lunging = this.focusHeld && this.th08OptionLive && this.th08LungeTarget != null &&
      this.shooting && this.fireFrame >= 10;
    if (this.focusHeld) {
      const anchorX = lunging ? this.th08LungeTarget!.x : this.x;
      const anchorY = lunging
        ? Math.max(32, Math.fround(this.th08LungeTarget!.y + 32))
        : Math.max(32, Math.fround(this.y - 96));
      if (lunging !== this.th08OptionLunge) {
        this.th08OptionLunge = lunging;
        // FUN_00407120(3) on entry, (1) on retreat — the familiar's spin
        // interrupts (player00.anm script 18 labels).
        this.th08OptionRunner?.interrupt(lunging ? 3 : 1);
      }
      if (!this.th08OptionLive) {
        this.th08OptionX = anchorX;
        this.th08OptionY = anchorY;
        this.th08OptionLive = true;
        // The familiar (FUN_0044e3a0 state 1) runs player00.anm script 18 —
        // the ghostly Yukari hover cycle (sprites 22-28) floating at the
        // option anchor. It is a separate ANM VM from the main sprite.
        if (this.anm.hasScript(18)) this.th08OptionRunner = new AnmRunner(this.anm, 18);
      } else {
        const k = Math.fround(Math.fround(0.2) * Math.fround(rate));
        this.th08OptionX = Math.fround(this.th08OptionX + Math.fround((anchorX - this.th08OptionX) * k));
        this.th08OptionY = Math.fround(this.th08OptionY + Math.fround((anchorY - this.th08OptionY) * k));
      }
    } else {
      this.th08OptionLive = false;
      this.th08OptionRunner = null;
      this.th08OptionLunge = false;
    }
    if (this.invulnFrames > 0) {
      const rateF32 = Math.fround(rate);
      if (rateF32 > 0.99) {
        this.invulnFrames--;
      } else {
        this.invulnFrac = Math.fround(this.invulnFrac - rateF32);
        while (this.invulnFrac < 0) {
          this.invulnFrames--;
          this.invulnFrac = Math.fround(this.invulnFrac + 1);
        }
      }
      // FUN_0043e2e0 exits state 3 as soon as the integer current is < 1;
      // the remaining positive fraction is discarded with the state reset.
      if (this.invulnFrames < 1) {
        this.invulnFrames = 0;
        this.invulnFrac = 0;
      }
    }
    if (this.bombInvuln > 0) this.bombInvuln = Math.max(0, this.bombInvuln - rate);
    if (this.bombTimer > 0) this.bombTimer = Math.max(0, this.bombTimer - rate);
    if (this.materializeFrame >= 0) {
      // Respawn materialize (fcn.0043e170): ramp scale/alpha IN PLACE over 30
      // simulation ticks (split counter), then enter the 240-tick invuln
      // window. No movement/firing. The exe zeroes the deathbomb meter every
      // state-1 frame (0x43e237) and reseeds it from the SHT at the
      // state-1 -> state-3 handoff (0x43e2c7).
      this.deathbombMeter = 0;
      this.materializeFrame += rate;
      if (this.materializeFrame >= MATERIALIZE_FRAMES) {
        this.materializeFrame = -1;
        this.invulnFrames = SPAWN_INVULN_FRAMES;
        this.invulnFrac = 0;
        this.deathbombMeter = Math.trunc(this.unfocused.deathbombWindow);
      }
    }
    if (this.controllable) this.move(input, rate);
    this.shooting = input.held.has('shoot') && this.controllable;
    // Shot-cycle ARM (exe FUN_0043a930): holding shoot re-arms the counter
    // to 0 only while it is DISARMED (< 0). A re-press mid-cycle does NOT
    // reset the grid, and releasing does NOT stop the cycle — the armed
    // counter free-runs to 19 firing its remaining record phases ("release
    // inertia"), then the TH08 20-frame cycle disarms it (see fire()).
    // FUN_0043be00 gates FUN_0043a930 (the disarmed -> frame-0 re-arm)
    // on FUN_00429483()==0, the MSG-active predicate. The surrounding
    // player callback still runs for timestamp-only messages: an already
    // armed cycle keeps advancing and existing shots keep moving, but once
    // that cycle expires holding Z cannot start another until the message
    // ends.
    if (allowShotArm && this.shooting && this.fireFrame < 0) {
      this.fireFrame = 0;
      this.fireFrameFrac = 0;
    }
    this.updatePose(input);
    this.runner.update(rate);
    this.th08OptionRunner?.update(rate);
  }

  private updateFocusGlide(focused: boolean, rate: number): void {
    let advancedOnReverse = false;
    if (focused !== this.focusHeld) {
      this.focusHeld = focused;
      // Frames the previous form actually held, in this port's 1-based
      // counting of th08FocusFrames (toggle frame = 1). Native gate is
      // `3 < counter` on the 0-based player+8, i.e. five held frames.
      const prevHeld = this.th08FocusFrames;
      // Timer player+0xe2ae8 (the gauge fire-rate clock) re-arms to 0 at
      // every focus transition (0x44b1b1/0x44b404).
      this.th08FocusFrames = 0;
      // The human/youkai sprite swap is immediate with the focus flip (no
      // glide between different characters); refresh the pose runner here
      // since pose changes key off direction.
      const script = focused ? 5 : 0;
      if (this.anm.hasScript(script)) this.runner = new AnmRunner(this.anm, script);
      // FUN_0044aec0's transition branch: the tint fires only after the
      // previous form held long enough; the aura arms on every focus-in
      // and is released by interrupt 1 on the way out.
      this.pendingTh08FormEffect = prevHeld > 4 ? (focused ? 29 : 28) : 0;
      this.pendingTh08Aura = focused ? 'in' : 'out';
      if (this.focusGlideFrame < GLIDE_FRAMES) {
        // FUN_0043be00 states 2 and 4 use the same reversal sequence: advance
        // the OLD split counter, complement its integer around 8, clear the
        // old fraction, then advance the NEW state once in the same callback
        // (all.c:28338-28372). Native th7_ud8141 processing 8631 pins this:
        // a 5-tick focus-in reversed at input 8615 yields focus-out ticks
        // 3,4,5, so the option-fired slot 50 starts at (xHalf=14.25,y=-12).
        const oldWhole = Math.floor(this.focusGlideFrame + rate);
        this.focusGlideFrame = Math.min(GLIDE_FRAMES, GLIDE_FRAMES - oldWhole + rate);
        advancedOnReverse = true;
      } else {
        // A settled toggle initializes the opposite state at zero; its case
        // body advances to `rate` on this same frame.
        this.focusGlideFrame = 0;
      }
    }
    if (!advancedOnReverse && this.focusGlideFrame < GLIDE_FRAMES) {
      this.focusGlideFrame = Math.min(GLIDE_FRAMES, this.focusGlideFrame + rate);
    }
  }

  private move(input: InputFrame, rate = 1): void {
    const sht = this.sht;
    // TH08 FUN_0044aec0 (asm 0x44aec0+): diagonal masks win first in the
    // order UL(0x50), DL(0x60), UR(0x90), DR(0xa0); the singles chain then
    // takes DOWN over up and LEFT over right — the opposite of TH07's
    // FUN_0043be00 priority (up, then right). The stage-1 Lunatic recording
    // holds left+right for 14 frames starting at f123; TH07's chain moves
    // the player right where the original moves left.
    let dx = 0;
    let dy = 0;
    const up = input.held.has('up');
    const down = input.held.has('down');
    const left = input.held.has('left');
    const right = input.held.has('right');
    if (up && left) { dx = -1; dy = -1; }
    else if (down && left) { dx = -1; dy = 1; }
    else if (up && right) { dx = 1; dy = -1; }
    else if (down && right) { dx = 1; dy = 1; }
    else if (down) dy = 1;
    else if (up) dy = -1;
    else if (left) dx = -1;
    else if (right) dx = 1;
    const diagonal = dx !== 0 && dy !== 0;
    const speed = diagonal
      ? (this.focusHeld ? sht.diagFocusedSpeed : sht.diagSpeed)
      : (this.focusHeld ? sht.focusedSpeed : sht.speed);
    // Th07.exe (v1.00b) Player::Update clamp @ 0x43c3cc-0x43c47c reads
    // DAT_00625854/58/5c/60 = {8,16,368,416}: the player CENTER is limited
    // to x∈[8,376], y∈[16,432], inset from the 384×448 field edges.
    // exe FUN_0043be00: velocity = inputDir * speed * DAT_0056baa8.
    // FUN_0043be00 @ 0x43c32d-0x43c39f stores the rate-scaled velocity in
    // player+0x9cc/0x9d0 and then stores the position add back into the
    // float32 player+0x930/0x934 fields before clamping. Keeping these in JS
    // doubles accumulates sub-pixel drift across long replays: native Stage-2
    // PRE9297 is (317.226684570,373.816131592), while the old WT state was
    // (317.226537466,373.815521240), enough to move SakuyaA slot 32 just
    // outside a boss hitbox and lose its first-hit id5 event.
    const vx = Math.fround(dx * speed * rate);
    const vy = Math.fround(dy * speed * rate);
    this.x = clamp(Math.fround(this.x + vx), 8, 376);
    this.y = clamp(Math.fround(this.y + vy), 16, 432);
  }

  private updatePose(input: InputFrame): void {
    const movingRight = input.held.has('right');
    const movingLeft = !movingRight && input.held.has('left');
    const pose = movingLeft ? 'left' : movingRight ? 'right' : 'idle';
    if (pose === this.poseState) return;
    this.poseState = pose;
    // TH08 Border Team (player00.anm): unfocused Reimu banks are the shared
    // scripts 1/3 (mirrored); focused Yukari has her OWN bank family — the
    // pose switch at 0x44b232+ selects scripts 6/8 for the left/right lean
    // (transitions 7/9), with 0/5 the respective idles.
    const script = this.focusHeld
      ? (pose === 'left' ? 6 : pose === 'right' ? 8 : 5)
      : (pose === 'left' ? 1 : pose === 'right' ? 3 : 0);
    if (this.anm.hasScript(script)) this.runner = new AnmRunner(this.anm, script);
  }

  // Option (orb) offset relative to the player, used by the scene to draw
  // the yin-yang orbs at power >= 8. TH07 SakuyaB's orbit variant is
  // deleted; the settled/glide layout below is the shared TH07/TH08 form
  // (settled unfocused = (∓24, 0), settled focused = (∓8, −32); the glide
  // eases xHalf quadratically and y linearly over GLIDE_FRAMES — Th07.exe
  // FUN_0043be00, all.c:28343-28362).
  orbOffset(orb: 1 | 2): { x: number; y: number } {
    const to = ORB_OFFSETS[this.focusHeld ? 'focused' : 'unfocused'][orb];
    if (this.focusGlideFrame >= GLIDE_FRAMES) return to;
    const t = this.focusGlideFrame / GLIDE_FRAMES;
    const xHalf = this.focusHeld ? 24 - 16 * t * t : 8 + 16 * t * t;
    const y = this.focusHeld ? -32 * t : -32 + 32 * t;
    return { x: orb === 1 ? -xHalf : xHalf, y };
  }

  fire(rate = 1, allowSpawn = true): PlayerBullet[] {
    // exe FUN_0043a820: runs while the cycle is ARMED, independent of the
    // shot key — released cycles still fire their remaining phases.
    if (this.fireFrame < 0) return [];
    if (this.dyingFrame >= 0 || this.materializeFrame >= 0) {
      this.fireFrame = -1;
      this.fireFrameFrac = 0;
      this.prevFireFrame = -999;
      return [];
    }
    const out: PlayerBullet[] = [];
    if (allowSpawn && this.fireFrame !== this.prevFireFrame) {
      for (const shot of this.sht.shotsForPower(this.power)) {
        const interval = Math.max(1, shot.interval);
        if (this.fireFrame % interval !== shot.delay % interval) continue;
        const b = this.makeBullet(shot);
        if (b) out.push(b);
      }
    }
    this.prevFireFrame = this.fireFrame;
    // Advance the split counter (FUN_00436acc) and expire the cycle past
    // frame 19 — TH08 runs a 20-frame shot cycle, not TH07's 30: Th08.exe
    // FUN_00451500 resets the fire timer to -1 once it reaches 0x14 and
    // re-arms it to 0 while Z stays held (asm 0x4515b8-0x451606).
    if (rate > 0.99) {
      this.fireFrame++;
      this.fireFrameFrac = 0;
    } else {
      this.fireFrameFrac += rate;
      if (this.fireFrameFrac >= 1) {
        this.fireFrameFrac -= 1;
        this.fireFrame++;
      }
    }
    if (this.fireFrame > 19) {
      this.fireFrame = -1;
      this.fireFrameFrac = 0;
      this.prevFireFrame = -999;
    }
    return out;
  }

  private makeBullet(shot: ShtShot): PlayerBullet | null {
    // Th08.exe shot spawner FUN_0044fb70 @ 0x44fd32-0x44fd44: the shot VM
    // runs player00.anm script (sht.sprite + 10) — scripts 0-9 are the
    // Reimu/Yukari pose family, the shot scripts start at 10.
    const scriptId = shot.sprite + 10;
    if (!this.anm.hasScript(scriptId)) return null;
    const runner = new AnmRunner(this.anm, scriptId);
    const rect = this.anm.sprites.get(scriptId) ?? this.anm.sprites.get(64);
    // Option-sourced records (src >= 1) spawn from the focused option's
    // live trail position (player+0x6b0, FUN_0044fb70); unfocused records
    // are all src 0 (the player center). The exe reads the live option-trail
    // struct; this port anchors to the player-relative option position.
    const source = shot.orb >= 1 && this.th08OptionLive
      ? { x: Math.fround(this.th08OptionX - this.x), y: Math.fround(this.th08OptionY - this.y) }
      : { x: 0, y: 0 };
    // TH08 impact: the settle path (all.c:40427-40431) re-arms the shot VM
    // with script sprite+0xb — one past the flight script, the odd-numbered
    // 30-frame fade-out family in player00.anm entry 0.
    const impactScript = scriptId + 1;
    return {
      poolSlot: -1,
      // FUN_00438b70 writes spawn position and velocity into the player's
      // fixed shot slot as f32 fields. Keeping the constructor in double
      // precision lets long-lived shots cross enemy hitboxes on a different
      // wall frame even when their authored SHT values are identical.
      x: Math.fround(this.x + source.x + shot.x),
      y: Math.fround(this.y + source.y + shot.y),
      vx: Math.fround(Math.cos(shot.angle) * shot.speed),
      vy: Math.fround(Math.sin(shot.angle) * shot.speed),
      angle: shot.angle,
      speed: shot.speed,
      damage: shot.damage,
      shotType: shot.shotType,
      behaviorFunc: shot.funcs[0],
      tickFunc: shot.funcs[1],
      hitboxW: shot.hitboxW,
      hitboxH: shot.hitboxH,
      sfxId: shot.sfxId,
      age: 0,
      state: 'fired',
      hitAge: 0,
      runner,
      impactScript,
      orb: shot.orb,
      anchorX: shot.x,
      rect: rect
        ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h, imageKey: rect.imageKey }
        : { x: 0, y: 0, w: 0, h: 0, imageKey: '' }
    };
  }

  hit(): 'deathbomb-window' | 'invulnerable' {
    if (this.invulnFrames > 0 || this.bombInvuln > 0 || this.hitState) return 'invulnerable';
    // Exe FUN_0043bd60: entering state 2 does NOT reload the meter — the
    // window length is whatever the persistent meter currently holds (a
    // recent late deathbomb leaves a shortened window).
    this.hitState = true;
    return 'deathbomb-window';
  }

  // Death sequence (exe state 2, fcn.0043dca0). While in the hit state the
  // deathbomb meter decrements once per WALL-CLOCK call ('pending'); the
  // frame it reaches 0 the miss commits: returns 'effects' once and starts
  // the death squish. The squish advances on the split counter (rate);
  // when it finishes, returns 'respawn' once. 'none' when idle. A
  // successful bomb (tryBomb) leaves the hit state and cancels the miss.
  tickDeath(rate = 1): 'effects' | 'respawn' | 'pending' | 'none' {
    if (this.hitState) {
      this.deathbombMeter--;
      if (this.deathbombMeter <= 0) {
        this.deathbombMeter = 0;
        this.hitState = false;
        this.dyingFrame = 0; // begin the death squish
        return 'effects';
      }
      return 'pending';
    }
    if (this.dyingFrame >= 0) {
      this.dyingFrame += rate;
      if (this.dyingFrame >= DEATH_SQUISH_FRAMES) {
        this.dyingFrame = -1;
        return 'respawn';
      }
      return 'pending';
    }
    return 'none';
  }

  tryBomb(): boolean {
    // Exe trigger gates (FUN_0043d9a0 @ 0x43db08-0x43db2e): the deathbomb
    // meter must be nonzero — this single gate is what closes bombing during
    // the squish (meter 0), the materialize (zeroed each frame) and past the
    // end of the deathbomb window.
    if (this.bombs <= 0 || this.bombTimer > 0 || this.bombCooldown > 0 || this.deathbombMeter <= 0) return false;
    // TH08 bomb machine (0x44c650/0x44c71b-0x44c75f): bombType = the FORM
    // byte (FUN_0040bc40 reads player+5 — the focus key latched through
    // the 7-frame stability gate, so a bomb cast inside that window uses
    // the OLD side); a deathbomb (cast from the hit state) INVERTS the
    // side before adding 2 — focused-cast runs table[2] (0x40c910),
    // unfocused-cast runs table[3] (0x410fe0). A deathbomb consumes TWO
    // bombs when the stock has them (FUN_00439883(-2)), one when it does
    // not.
    const deathbomb = this.hitState;
    const base = this.th08Form;
    this.th08BombType = (deathbomb ? 1 - base : base) as 0 | 1 | 2 | 3;
    this.bombs -= deathbomb ? Math.min(this.bombs, 2) : 1;
    this.hitState = false; // deathbomb rescue
    this.deathbombMeter = Math.min(Math.trunc(this.unfocused.deathbombWindow), this.deathbombMeter + 6);
    // The frozen flag (player+0xfdc) owns invulnerability for exactly the
    // bomb's duration; the duration comes from the cast helper (0x40be30:
    // 260/200/260/300 by type) and is applied by the scene.
    this.bombFocused = this.focusHeld;
    return true;
  }

  die(): void {
    this.hitState = false;
    // Materialize holds the meter at 0 (0x43e237); it reloads at the
    // state-1 -> state-3 handoff in update().
    this.deathbombMeter = 0;
    this.lives--;
    this.bombs = Math.trunc(this.unfocused.bombs);
    // Power loss happens at the MISS itself, before the drops spawn
    // (StageScene#onPlayerDeath, exe FUN_0043dca0) — not here.
    // Respawn (fcn.0043dca0 at the death-clock lapse): teleport to the spawn
    // point and enter the materialize state (fcn.0043e170) -- a 30-frame
    // in-place scale/alpha ramp, NOT a fly-in -- followed by 240f invuln
    // (set in update() when the materialize ends).
    this.x = SPAWN_X;
    this.y = SPAWN_Y;
    this.materializeFrame = 0;
    this.invulnFrames = 0;
    this.invulnFrac = 0;
    this.bullets.length = 0;
  }
}
