# TH08 handoff (current state — full history in git log of this file)

Repo `AgentMystia/th08_web`. Browser reimplementation of TH08 Stage 1+2
(Border Team) from original data. Playable end to end: title → difficulty
→ team → stages with dialogue, HUD, ECL waves, spells, bombs, Wriggle and
Mystia fights; browser replay load & playback (title → Replay → .rpy).
Gates: `npm run check` / `npm run build` / `npm test` + CI
(core/browser gate Pages; replay job advisory).

## Convergence picture (2026-08-30 pass 28 — the boss-death orbit-emitter round)

| run | pass-27 | pass-28 | note |
|-----|---------|---------|------|
| udGx01 st1 | f7413 | **f7531** | first orbit-emitter implementation; f4123 settle fork is still first, contact is a re-roll |
| udGx01 st2 | f9253 | f9253 | flat, zero regression |
| udLy01 st1 | f3177 | f3177 | flat |
| udLy01 st2 | f3471 | f3471 | flat |

Pass-28 implemented the captured-card tail from FUN_004161b0/00416b90:
the native budget formula (gx st1 = 442), nine-tick warm-up, opposite
128px type-10 bursts, native partial debit, and the reconstructed 1/16
player easing. The f4132 burst centers/positions are float-exact against
wine after inverting the first item tick. Honest §7 residuals: the native
presentation clock's +10-frame lead, the effect-39 actor transform, and
the branch mapping for easing. A new contradiction remains: asm budget442
with 14 debited per full tick yields 416 calls, while wine observes 442
type-10 items; the port follows asm and does not fake the count. Full
detail: tmp/gx-findings.md pass 28.

Pass-27 root-caused the whole st1 stream fork to the midboss death settle
at f4122 (draws vs rng-curve: first permanent fork, −828 at the wipe
frame). Two fixes landed: (1) the master-death tail pays the +0x3380
attach-LEDGER ×2 as orbs (all.c:20533 — the port paid live-children ×2,
10 vs native 136); (2) the wipe sweep leaves quad-zone-covered bullets to
the armed zones (native splits 209 sweep pointStars + 63 quad time items;
port pointStar count now exact). f5911 fan-aim SUPERSDED — the sub27 var
chain decoded clean (var10016 = rand10082×0.04 + π/3-family), native's
draw ≈ 0 vs port −2.29: pure stream-fork downstream. Remaining fork, in
draw order: the boss-death ORBIT EMITTER (type-10 orbs 13/frame
[min(budget,7)+6], ~442 total ≈ 1768 draws, spiral at enemy+0x2e0, asm
0x4175f6 family, budget writer TBD), quad double-conversion (+216), ins_92
ledger cadence 46-vs-68. Full detail: tmp/gx-findings.md pass 27.

Pass-26 landed three exe-pinned fixes (see gx-findings §AD2-AD4): the
addTimeOrbs parity (pv curve now native-exact), the pointStar/type-6
collect law (graze-scaled fixed award), and the FIRE rank-lerp spell gate
(wine-pinned: sub24's 123-bullet volley fires exactly 3.0 native during
the spell; the pass-20 ±0.15-lattice story is superseded). Next targets:
the st1 f5911 fan-aim divergence (sub25's 14-bullet fan: everything
native-exact except the center rotated 0.1104 rad — §AC14's var family
made concrete) and the st2 post-gate bisection (port field empty by f8950
vs native 511). CAVEAT learned this pass: the bullet walk runs 0,1535..1
DESCENDING — mid-pass wine/census rows lag one tick on LOW slot numbers;
use the position-or-minus-velocity matcher (probe-driftscan2.mjs) before
believing any single-bullet "skip". The wine tooling is
tmp/wine-bulcensus.mjs + tmp/wine-out/*.jsonl (full-pool bullets/items/
player per frame).

### Prior picture (pass 23, kept for history)

Formal-mode earliest unexpected player hit (THE metric):

| fixture-stage | pass 20 | pass 22 | now | note |
|---|---|---|---|---|
| udGx01 st1 | f6348 | f6013 | **f6021** | +8; dialogue now runs at native pace |
| udGx01 st2 | f8061 | f8252 | **f10058** | +1805; dialogue-edge fix + the 0x20-spiral queue-gate fix |
| udLy01 st1 | f3177 | f3177 | f3177 | same wall (sub15 volley family) |
| udLy01 st2 | f3471 | f3471 | f3471 | f677 native deathbomb still exact |

**Pass 22 closed the dialogue pacing root cause** (c22b8a1): the §7
"1.5f/char typewriter floor" was mis-calibrated (the native ~348f budget
IS the 6/8-frame confirm arms); removing it put the boss-fight entries
~24f from native (was 182) and moved gx st2 +191. The old gx st1 f6348
was a phantom of the shifted timeline — frontiers measured across a
pacing defect measure nothing.

**Pass 24 closed the st2 dialogue root cause (3f1560f)**: the native
confirm is the SHOT-KEY RISING EDGE + armed threshold (all.c:24781-24793;
0x164d534 = the previous frame's input), not the level rule — the replay
taps the shot key, so the port's level rule ate 1-4 extra frames per op4
wait: Mystia's entry landed 79 ticks late and the whole stationary-seed
lattice re-rolled. The fix moved gx st2 f8252 -> f10043 (+1791) and gx
st1 f6013 -> f6021; ly unchanged; 216 tests green. The old 2026-08-27
A/B ("edge rules stall the ly dialogue") mis-attributed the ly dialogue's
speed — its waits TIME OUT at short authored durations because held keys
never produce edges.

**Pass 25 closed the queue-walk gate defect (cbd8d9d)**: the bullet
behavior walk's TH07-heritage `exFireFlags & opcode` skip buried later
queue slots — native FUN_0042ffc0 gates only on cond==0 (+0xdb0 is a
bomb-time bit). The gx st2 contact bullet's 0x20 spiral slot (angle
-0.0262/tick after the 0x10 accel) never armed, freezing the coast; the
fork explained the f10043 contact. Fix: gate removed, gx st2
f10043 -> f10058; ly/st1 unchanged.

**Pass 23 (reconnaissance round, zero src changes)**: the native module
table is fully resolved (ascending execution; 8=enemy ANM prep, 9/10=
player, 11=enemy ECL main + tail, 12=bomb/POC + effects A, 13=effects B
+ the 0x59c×0x100 familiar pool, 14=the ONLY bullet pass with the item
walk at its head) — there is NO second bullet integration pass, and the
port's et_ex handler order matches native. The probe-label law is
pinned (port scene.frame = input+1; census row f ≡ input f−1 ≡
scene.frame f — all historical graze comparisons were correctly
aligned). The fireflies fire their own stationary sprite-3 bullets every
~5-6 inputs. One controlled experiment was implemented and FALSIFIED:
"op90-93 children run eclT −1" (from census row f3626 e[4]=1) regressed
gx st1 f6013 → f2919 via effect-pool pressure re-rolling the RNG; it
was reverted same-round. e[4]'s identity for fresh children stays open.

**The next walls (unchanged anchors)**: (1) gx st1 — the sub21 one-step
residual is inside the bullet-pass mechanics or graze geometry (all
clock stories falsified; the fire-frame accounting is exact). (2) gx
st2 — the f8252 contact is downstream of the f7869 auto-fire volley
regime: Mystia's ins_105/106 periodic emitter wobbles ±1 frame
(repaying) until the aim-tracking variable crosses zero at f7869, after
which offsets stop repaying (−18 → +90 by f7950). Two laws to decode:
the auto-fire timer primitive order (FUN_00406610/660/40, b8e0, e390
all read this pass) and the aim-tracking wrap. Probes for both walls
are in tmp/probe-*.mjs.

Goal: gx st1 = native No-Miss (0 unexpected hits over 11,460 frames).

**Pass-11 closed the st1 midboss movement defect**: op-75's rect clamp
(FUN_0042c180 — an ENEMY clamp, the identity accessor FUN_0040b460 was
misread as a player clamp) runs every manager pass around the movement
integrator and after every ins_63 setPos. The Sub22 ins_64(90,4,192,144)
tween now rides the y ceiling exactly like native (census-exact 128.000
from f3352; was parked at 144).

**st1 RNG stream (pass-17 revision)**: the old f2699/f2965 story is
superseded — after the pass-16 ins_128 fix the stream is draw-exact
through **f3581**, and the first persistent divergence is **f3582**
(see the convergence picture above: missing native hit-event sparks in
the midboss window, −7778 draws by f5001). Any downstream analysis
that assumed a clean stream past f3582 (fan angles from var 10082,
firefly cone inputs past f3731) is measuring the diverged stream.
st2 keeps the f696 −4 collect deficit (slot8 one frame late;
movement-precision family).

## Method that works (keep using it)

1. Collide the port against native ground truth per frame:
   `tmp/parity*.mjs` (RNG draw counts), `tmp/goffset.mjs` (gauge),
   `tmp/win*.mjs` (window deltas). Alignment: native counter f == port
   state after input f−1; dedupe census rows.
2. Pin the divergent semantic in the binary (all.c + objdump + .rdata
   constants) BEFORE touching code. Wrong semantics fake progress by
   re-rolling the contact lottery — re-verify any "improvement".
3. Fix, then re-run all four formal verifiers + full tests; record the
   honest movement in `tmp/gx-findings.md` and AGENTS §6.

## Known-good subsystems (regression surfaces)

ECL v8 interpreter (exe case = on-disk −1; ins_2 waits, timeline holds,
ins_135 sub-contexts + CALL float-bank copy), bullet manager (spawn-state
fall-through, et_ex dir family, construction flag zeroing), graze tiers,
T8RP replay restore + browser playback parity, item/damage economy
(time-orb accumulator 40/40, death-wipe chips, quad conversions, familiars
sweep + attach ledger), gauge machinery (see AGENTS §3), RNG draw economy
(effect pool pressure load-bearing), dialogue op4 level-confirm.

## Next targets (ordered)

1. **The f3582 stream wall (THE gate)**: identify why native pays 2
   extra effect-5 impact sparks per 6 ticks against the invulnerable
   parked midboss (f3582-3594) and 1 extra per hit-tick during damage
   (f3628+). Compare the port's shot-vs-invulnerable-enemy collision
   against the native shot settle (all.c:40425-40438, FUN_0043a980
   re-arm / FUN_00425d70 init callback). Probes: tmp/probe-parity*.mjs,
   tmp/probe-pdelta.mjs (aligned per-frame draw deltas vs census).
2. Re-derive both gx frontiers on a stream-true run (they WILL move;
   direction unknown — record honestly).
3. Movement-precision family: st2 sub12 drift, slot8/f696 player
   micro-position — wine-gated.
4. Boss-fight pacing ~2.5-3x slow — POST-wall.
5. Visual: stage fog law, boss lifebar details. Replay block chaining UX.

## Tooling notes (hard-won)

- Wine rounds are user-ordered only; pre-baked win32 prefix image
  `localhost/th08winedop` boots Th08.exe in ~2s (Containerfile.prefix in
  ignored tmp/podman-trace).
- Bullet pool allocates from slot 1535 DOWN — probe the whole pool.
- `--trace` stdout can truncate on process.exit; redirect to file.
- The analyze_image MCP vision tool is STATEFUL across calls — never read
  numbers from images it wasn't shown in the same query.
- fnstsw test masks: `0x41` = C0|C3 (equality takes the first branch);
  float constants must be read through the PE section table, not VA−0x200
  outside .text.
