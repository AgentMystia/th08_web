import { Sht, type ShtShot } from '../formats/sht';
import { Anm, AnmRunner } from '../formats/anm';
import { TH08_DATA } from '../data/th08-data';
import { clamp } from '../core/util';
import type { InputFrame } from '../core/input';

// TH08 (Imperishable Night) player: the Border Team is the single
// supported team. Movement speeds, hitbox, item radii, PoC line, and
// the per-power shooter tables all come from the embedded ply00a/ply00as
// .sht data; the bomb is the TH08 declaration machine (tryBomb latches the
// type, StageScene applies duration/invuln from the v1.00d tables).

export type Th08TeamId = 'reimuYukari';

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
  // Stable slot in Th08.exe's 128-entry player-shot pool. Each firing pass
  // scans from slot 0, so slots freed by movement are reusable immediately.
  poolSlot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  speed: number;
  damage: number;
  // SHT i16@+0x1e. A negative value marks human-form shots that may emit a
  // time item when the per-enemy hit accumulator crosses its threshold
  // (FUN_00451670 @ 0x451858-0x451897).
  timeOrbEligible: boolean;
  // ShtShot.funcs[0], the spawn-time behavior selector. Border Team uses
  // 1 to aim at the cached target at spawn (FUN_00450240).
  behaviorFunc: number;
  // ShtShot.funcs[1], the per-tick behavior selector (TH08 uses it: 1 = the
  // seeking option tick FUN_00450320).
  tickFunc: number;
  hitboxW: number;
  hitboxH: number;
  sfxId: number; // from ShtShot.sfxId; playback not wired up (stage-scene.ts uses a fixed fire sound instead)
  age: number;
  state: 'fired' | 'collided';
  // Per-shot ANM VM. TH08 ticks the embedded VM each frame and re-arms it
  // to the adjacent impact script when the shot settles.
  runner: AnmRunner;
  impactScript: number;
  rect: { x: number; y: number; w: number; h: number; imageKey: string };
  dead?: boolean;
  // TH08 dialogue drift (FUN_004413e0): shot flagged harmless with velocity
  // (0, -0.5) while a conversation plays; never restored — expires offscreen.
  driftHarmless?: boolean;
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
  readonly team: Th08TeamId;
  readonly unfocused: Sht;
  readonly focused: Sht;
  readonly anm: Anm;
  focusHeld = false;
  // Frames elapsed since the last focus-state toggle, saturating at
  // GLIDE_FRAMES once the orb glide has settled; see orbOffset().
  private focusGlideFrame = GLIDE_FRAMES;
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
  lives = 2;
  bombs = 3;
  power = 0;
  // TH08 Border Team focused option (Yukari's shikigami familiar): the exe
  // runs a damped pursuit toward (player.x, max(32, player.y - 96))
  // (FUN_0044e770) and snaps to that anchor on the focus-in intro state
  // (FUN_0044e3a0 state 1). Option-sourced SHT records spawn from this live
  // position (player+0x6b0 read in the FUN_0044fb70 spawner).
  th08OptionX = 0;
  th08OptionY = 0;
  private th08OptionVx = 0;
  private th08OptionVy = 0;
  private th08OptionAge = 0;
  // FUN_0044e3a0's VM+0x2cc direction/lunge sub-state: 0 neutral,
  // 1 moving left, 2 moving right, 3 pursuing the cached enemy.  Keeping
  // only a lunge boolean loses a deliberate one-tick orientation handoff
  // when a target disappears and another is published in the same manager
  // pass (Stage-2 native f922-925).
  private th08OptionSubstate = 0;
  th08OptionLive = false;
  // The familiar's own ANM VM (player00 script 18), live only while focused.
  th08OptionRunner: AnmRunner | null = null;
  // The enemy-lunge (FUN_0044e3a0 sub-state 3, entered from FUN_0044e770's
  // tail when the shot cycle is armed, the OPTION actor's timer is >= 10,
  // and the enemy manager's pointer cache 0x18b89b4 holds a target): the option's anchor
  // switches to (enemy.x, max(32, enemy.y + 32)) via FUN_0044e8d0 — Ran
  // herself flies onto the enemy while her needles pour out point-blank.
  th08OptionLunge = false;
  // Live anchor fed by the scene each frame from the enemy manager's pointer
  // cache (the |x-224|<=64, upper-most enemy pick at 0x42d4a6).
  th08LungeTarget: { x: number; y: number } | null = null;
  // Focus-stability counter at player+8. This flips the live form byte and
  // gates the gauge block after 30 stable frames; it is distinct from both
  // ZunTimers below.
  th08FocusFrames = 0;
  // player+0xe2ad0: the shot-idle timer. While the shot cycle is disarmed it
  // rises to 30; while armed it counts back to zero before firing can move
  // the gauge (0x44be3e-0x44be62 / 0x44bef9-0x44c00d).
  th08ShotIdleTimer = 0;
  // player+0xe2ae8: firing-side gauge ramp. Focus edges and four idle frames
  // reset it; otherwise it advances once per armed tick after the idle timer
  // has drained. The gauge amount is derived from its PRE-tick value.
  th08GaugeFireTimer = 0;
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
  // A deathbomb trigger leaves the native player state byte at 2 for the
  // trigger boundary. The selected callback releases it on the next player
  // tick, when the 999 sentinel becomes the authored duration.
  pendingDeathbombRescue = false;
  // FUN_0044cba0 latches the bomb callback's side into player+3. During an
  // active Border bomb this overrides the raw focus key until cleanup.
  th08BombFocusOverride: boolean | null = null;
  invulnFrames = 0;
  // Player state-3's timer is the native {integer current, f32 fraction}
  // pair at +0x16a08/+0x16a04, retreated through FUN_00436a06. Keeping one
  // JS double made 1/3 slowmo retain a tiny positive tail for three extra
  // wall frames and shifted the player-shot collision gate in Stage 5.
  invulnFrac = 0;
  // TH08 player+0xe2a68 preDeadCount. Init/respawn seed it from the SHT, but
  // FUN_0044ab40 RECOMPUTES it on every actual hit from bomb stock, the Time
  // quota state, boss presence and the team modifier. It decrements once per
  // WALL-CLOCK frame during state 2 and successful bombs add 6, capped by
  // the SHT value. It also doubles as the universal bomb gate.
  deathbombMeter = 0;
  // Exe player state 2 while the meter is still nonzero: hit taken, the
  // deathbomb window is running.
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

  constructor(team: Th08TeamId, anms: Record<string, Anm>) {
    this.team = team;
    const spec = CHARACTERS;
    const sht = TH08_DATA.sht as Record<string, string>;
    this.unfocused = new Sht(sht[spec.shtBase]);
    this.focused = new Sht(sht[`${spec.shtBase}s`]);
    this.anm = anms[spec.anmKey];
    this.bombs = Math.trunc(this.unfocused.bombsPerLife);
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
    // FUN_0044aec0 is skipped by Player::OnUpdate while the state byte is 2
    // (deathbomb window) or 1 (death squish). State 3 materialize does run
    // it. This keeps focus/form/option state frozen through the trigger
    // boundary of a deathbomb.
    if (!this.hitState && this.dyingFrame < 0) {
      this.updateFocusGlide(this.th08BombFocusOverride ?? input.held.has('focus'), rate);
      this.th08FocusFrames++;
      // FUN_0044aec0 tails: the form byte flips once the stable counter
      // passes 6 (player+8; 1-based here -> flip at 8). th08FocusFrames
      // was zeroed on the toggle frame and incremented right above, so
      // the flip lands on the 8th frame counting the toggle itself.
      const flipped = this.th08FocusFrames > 7 && this.th08Form !== (this.focusHeld ? 1 : 0);
      if (flipped) {
        this.th08Form = this.focusHeld ? 1 : 0;
        // The flip sites (0x44b1a5/0x44b1b1 youkai-ward, 0x44b3f8/0x44b404
        // human-ward) write ONLY player+8 = 0 and e2ae8 = 0 — no write to the
        // idle timer e2ad0 anywhere in .text (its full write set is init
        // 0x449e02, gauge-block decrement 0x44be57 / idle advance 0x44c007,
        // and the materialize reset 0x44d90f). The old "idle park at 30"
        // §7 model was a phantom: the gx stage-1 f565-651 episode it was
        // tuned to is fully explained by the MIDBOSS DIALOGUE gate (0x44bdf0
        // skips the whole block while dialogue is present; gauge frozen
        // f585-635, dialogue-end item vacuum at f636, e2ae8 restarts from 0
        // → tier-1 at f651), while the f2975 flip (no dialogue) resumes the
        // fire ramp immediately at the +8 gate (tier-1 at f3022, native
        // runstate-pinned) — a park would have delayed it to f3052.
      }
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
    // ORDER: the arm belongs to the player's MAIN callback, which the exe
    // scheduler runs BEFORE the option actor's separate callback
    // (FUN_0044e770). Arming after updateTh08Option made the option read a
    // one-tick-stale fireFrame on every arm tick: its lunge gate failed and
    // the fall-through clear of DAT_018b89b4 (player.ts updateTh08Option)
    // ate the target the same tick's SHT FIRE pass needed for beh1 aiming.
    // gx st1 witness: at replay f1171 the option volley flew straight;
    // native aimed it from (323,148) and its id5 impact drew at counter
    // 1181 — the port's first impact came at counter 1184 (draw parity
    // broke −4 at f1181).
    if (allowShotArm && this.shooting && this.fireFrame < 0) {
      this.fireFrame = 0;
      this.fireFrameFrac = 0;
    }
    // The option actor is a separate callback after the player's main
    // movement job.  It therefore pursues this tick's player position; doing
    // this before move() left its Stage-2 f907 source y exactly one frame old.
    if (!this.hitState && this.dyingFrame < 0) this.updateTh08Option(input, rate);
    this.updatePose(input);
    this.runner.update(rate);
    this.th08OptionRunner?.update(rate);
  }

  private updateTh08Option(input: InputFrame, rate: number): void {
    // The focused option is a second-order pursuit, not a direct 0.2 lerp:
    //   desired velocity = (anchor - position) / 16
    //   velocity += (desired velocity - velocity) * 0.2
    //   position += velocity
    // (FUN_0044e770/FUN_0044e8d0 @ 0x44e7c8-0x44e849).  The difference
    // is combat-significant: a direct lerp put Yukari on a Stage-2 fairy at
    // replay f912 and made her focused volley kill it 44 RNG draws early.
    if (!this.focusHeld) {
      this.th08OptionLive = false;
      this.th08OptionRunner = null;
      this.th08OptionLunge = false;
      this.th08OptionVx = 0;
      this.th08OptionVy = 0;
      this.th08OptionAge = 0;
      this.th08OptionSubstate = 0;
      this.th08LungeTarget = null;
      return;
    }
    if (!this.th08OptionLive) {
      this.th08OptionX = this.x;
      this.th08OptionY = Math.max(32, Math.fround(this.y - 96));
      this.th08OptionVx = 0;
      this.th08OptionVy = 0;
      // The actor's ZunTimer is ticked by the ANM owner on the activation
      // pass: native state 2 already reads timer=1 immediately after the
      // state-1 snap.  This makes the >=10 lunge gate land on the authored
      // tick after every focus-in, not one callback late.
      this.th08OptionAge = 1;
      this.th08OptionLunge = false;
      this.th08OptionSubstate = 0;
      // FUN_0044e3a0 state 1 clears the shared DAT_018b89b4 pointer on
      // every focus-in activation.
      this.th08LungeTarget = null;
      this.th08OptionLive = true;
      // The familiar (FUN_0044e3a0 state 1) runs player00.anm script 18 —
      // the ghostly Yukari hover cycle floating at the option anchor.
      if (this.anm.hasScript(18)) this.th08OptionRunner = new AnmRunner(this.anm, 18);
      return;
    }

    const target = this.th08LungeTarget;
    const oldSubstate = this.th08OptionSubstate;
    // State 3 runs its enemy pursuit once before testing retreat. If the
    // pointer vanished, this callback only returns to sub-state 0; ordinary
    // player pursuit resumes on the next frame.
    if (oldSubstate !== 3 || target) {
      const lunging = oldSubstate === 3;
      const anchorX = lunging ? target!.x : this.x;
      const anchorY = lunging
        ? Math.max(32, Math.fround(target!.y + 32))
        : Math.max(32, Math.fround(this.y - 96));
      const desiredVx = Math.fround(Math.fround(anchorX - this.th08OptionX) / 16);
      const desiredVy = Math.fround(Math.fround(anchorY - this.th08OptionY) / 16);
      const accelX = Math.fround(Math.fround(desiredVx - this.th08OptionVx) * Math.fround(0.2));
      const accelY = Math.fround(Math.fround(desiredVy - this.th08OptionVy) * Math.fround(0.2));
      this.th08OptionVx = Math.fround(this.th08OptionVx + accelX);
      this.th08OptionVy = Math.fround(this.th08OptionVy + accelY);
      this.th08OptionX = Math.fround(this.th08OptionX + this.th08OptionVx);
      this.th08OptionY = Math.fround(this.th08OptionY + this.th08OptionVy);
      // Both FUN_0044e770 and FUN_0044e8d0 apply the same |vx| dead zone
      // after integration (0x44e83a / 0x44e99d).  It is visible on the
      // second Stage-2 lunge, whose target stays almost directly below Ran.
      if (Math.abs(this.th08OptionVx) < 0.05) {
        this.th08OptionVx = 0;
      }
    }

    if (oldSubstate === 3) {
      const retreat = target == null || (this.fireFrame < 0 && !input.held.has('shoot'));
      if (retreat) {
        this.th08OptionSubstate = 0;
        this.th08LungeTarget = null;
        this.th08OptionRunner?.interrupt(1);
      }
    } else {
      // FUN_0044e770 may request sub-state 3 at its tail. The enclosing
      // switch then performs its direction transition using the sub-state
      // from callback entry. In state 0 a nonzero vx overwrites that request
      // with state 1/2, intentionally delaying the lunge by one tick.
      let next = oldSubstate;
      const lungeRequested = target && this.fireFrame >= 0 && this.th08OptionAge >= 10;
      if (lungeRequested) {
        next = 3;
      } else {
        // FUN_0044e770's fall-through clears DAT_018b89b4 whenever its
        // lunge gate does not return early. The enemy pass may publish a new
        // pointer later in this same scheduler tick.
        this.th08LungeTarget = null;
      }
      if (oldSubstate === 0) {
        if (this.th08OptionVx < 0) next = 1;
        else if (this.th08OptionVx > 0) next = 2;
      } else if (oldSubstate === 1) {
        if (this.th08OptionVx === 0) next = 0;
        else if (this.th08OptionVx > 0) next = 2;
      } else if (oldSubstate === 2) {
        if (this.th08OptionVx === 0) next = 0;
        else if (this.th08OptionVx < 0) next = 1;
      }
      this.th08OptionSubstate = next;
    }
    this.th08OptionLunge = this.th08OptionSubstate === 3;
    if (oldSubstate !== 3 && this.th08OptionSubstate === 3) {
      // The >=10 gate is option+0x2e0, not the cycling shot timer. Entry
      // changes substate only; enemy pursuit begins next tick.
      this.th08OptionRunner?.interrupt(3);
    }
    this.th08OptionAge += rate;
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
      // every focus transition (asm 0x44b1b1/0x44b404). player+8 is the
      // separate form-stability counter reset by the adjacent writes.
      this.th08FocusFrames = 0;
      this.th08GaugeFireTimer = 0;
      // Short-tap idle park (§7): a focus-OUT whose ENTIRE youkai visit fit
      // inside the still-closed +8 stability window (held frames < 30 and
      // the form byte still youkai at the release — the return settle is
      // still ~8 frames away) restarts the shot-idle countdown at its 30
      // cap. Native gauge law: the countdown's length IS e2ad0's value at
      // gate-reopen, and every fully-measured episode pins it — gx st1
      // release@f576 (11 held frames → tier-1 at f576+75) vs release@f1239
      // (101 held, drift was already live → f1239+45) vs press-only@f2975
      // (held, → press+47) vs sub-settle taps f487/f829 (→ +45). No e2ad0
      // write exists at the flip sites in .text (their full write set is
      // +8=0, e2ae8=0, pose and the SHT swap), so the exact native arm of
      // this law is unresolved; the model is this narrow condition,
      // five-way pinned.
      if (!focused && prevHeld < 30 && this.th08Form === 1) {
        this.th08ShotIdleTimer = 30;
      }
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

  // Advances player+0xe2ad0/e2ae8 in the order used by FUN_0044aec0,
  // which runs before FUN_00451500 advances/expires the actual shot cycle.
  // A non-null fireTimer means this tick should apply firing gauge drift;
  // idleReady means the 30-frame return-to-center branch is live.
  tickTh08GaugeTimers(armed: boolean, rate = 1): {
    fireTimer: number | null;
    idleReady: boolean;
  } {
    if (armed) {
      if (Math.trunc(this.th08ShotIdleTimer) > 0) {
        this.th08ShotIdleTimer = Math.max(0, this.th08ShotIdleTimer - rate);
        return { fireTimer: null, idleReady: false };
      }
      const fireTimer = this.th08GaugeFireTimer;
      this.th08GaugeFireTimer += rate;
      return { fireTimer, idleReady: false };
    }
    if (Math.trunc(this.th08ShotIdleTimer) >= 4) this.th08GaugeFireTimer = 0;
    if (Math.trunc(this.th08ShotIdleTimer) >= 30) {
      return { fireTimer: null, idleReady: true };
    }
    this.th08ShotIdleTimer += rate;
    return { fireTimer: null, idleReady: false };
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
    // Option-sourced records (source >= 1):
    // In focused form (Yukari), spawns from the shikigami option trail (player+0x6b0).
    // In unfocused form (Reimu), spawns from the yin-yang orb options (orb 1 = left, orb 2 = right).
    let source = { x: 0, y: 0 };
    if (shot.source >= 1) {
      if (this.focusHeld && this.th08OptionLive) {
        source = { x: Math.fround(this.th08OptionX - this.x), y: Math.fround(this.th08OptionY - this.y) };
      } else if (shot.source === 1 || shot.source === 2) {
        source = this.orbOffset(shot.source as 1 | 2);
      }
    }
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
      timeOrbEligible: shot.unknown30 < 0,
      behaviorFunc: shot.funcs[0],
      tickFunc: shot.funcs[1],
      hitboxW: shot.hitboxW,
      hitboxH: shot.hitboxH,
      sfxId: shot.sfxId,
      age: 0,
      state: 'fired',
      runner,
      impactScript,
      rect: rect
        ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h, imageKey: rect.imageKey }
        : { x: 0, y: 0, w: 0, h: 0, imageKey: '' }
    };
  }

  hit(options: { timeQuotaMet?: boolean; bossActive?: boolean } = {}): 'deathbomb-window' | 'invulnerable' {
    if (this.invulnFrames > 0 || this.bombInvuln > 0 || this.hitState) return 'invulnerable';
    // FUN_0044ab40 (all.c:36889-36915): bombs*6, +7 once Time quota is met,
    // cap 15; double (cap 30) while a boss is registered; Border Team then
    // applies *9/5. Native Stage-2 replay: stock 3 -> 27 at f677. This is
    // deliberately independent of the normal SHT seed (18 for ply00a).
    let preDeadCount = this.bombs * 6;
    if (options.timeQuotaMet) preDeadCount += 7;
    preDeadCount = Math.min(preDeadCount, 15);
    if (options.bossActive) preDeadCount = Math.min(preDeadCount * 2, 30);
    // This slice supports team 0 only; its table arm is integer *9/5.
    preDeadCount = Math.trunc(preDeadCount * 9 / 5);
    this.deathbombMeter = preDeadCount;
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
    // TH08 bomb machine (0x44c650, all.c:37720-37742): type = player+3 (the
    // FORM byte — the focus key latched through the 7-frame stability gate,
    // so a bomb cast inside that window uses the OLD side); a deathbomb
    // (player+4, cast from the hit state) computes 1 - type and then ADDS 2
    // — focused-cast runs table[2] (0x40c910), unfocused-cast table[3]
    // (0x410fe0). A deathbomb consumes TWO bombs when the stock has them
    // (FUN_00439883(-2)), one when it does not.
    const deathbomb = this.hitState;
    const base = this.th08Form;
    this.th08BombType = (deathbomb ? 3 - base : base) as 0 | 1 | 2 | 3;
    this.bombs -= deathbomb ? Math.min(this.bombs, 2) : 1;
    if (deathbomb) {
      // The trigger boundary still reports native state 2. The callback's
      // next tick completes the rescue and pays the +6 meter tail.
      this.pendingDeathbombRescue = true;
    } else {
      this.hitState = false;
      this.deathbombMeter = Math.min(
        Math.trunc(this.unfocused.deathbombWindow), this.deathbombMeter + 6
      );
    }
    // The frozen flag (player+0xfdc) owns invulnerability for exactly the
    // bomb's duration; the duration comes from the cast helper (0x40be30:
    // 260/200/260/300 by type) and is applied by the scene.
    this.bombFocused = this.focusHeld;
    return true;
  }

  completePendingDeathbombRescue(): void {
    if (!this.pendingDeathbombRescue) return;
    this.pendingDeathbombRescue = false;
    this.hitState = false;
    this.deathbombMeter = Math.min(
      Math.trunc(this.unfocused.deathbombWindow), this.deathbombMeter + 6
    );
  }

  die(): void {
    this.hitState = false;
    this.pendingDeathbombRescue = false;
    // Materialize holds the meter at 0 (0x43e237); it reloads at the
    // state-1 -> state-3 handoff in update().
    this.deathbombMeter = 0;
    this.lives--;
    this.bombs = Math.trunc(this.unfocused.bombsPerLife);
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
