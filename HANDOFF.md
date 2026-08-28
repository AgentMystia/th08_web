# TH08 handoff (current state — full history in git log of this file)

Repo `AgentMystia/th08_web`. Browser reimplementation of TH08 Stage 1+2
(Border Team) from original data. Playable end to end: title → difficulty
→ team → stages with dialogue, HUD, ECL waves, spells, bombs, Wriggle and
Mystia fights; browser replay load & playback (title → Replay → .rpy).
Gates: `npm run check` / `npm run build` / `npm test` (213) + CI
(core/browser gate Pages; replay job advisory).

## Convergence picture (2026-08-29, post ede504b — pass 11)

Formal-mode earliest unexpected player hit (THE metric):

| fixture-stage | now | bullet family |
|---|---|---|
| udGx01 st1 | f3630 | Sub24 ring razor (spawn f3557) — was f3586 pre-clamp |
| udGx01 st2 | f4365 | Sub4 aimed fairy (age 76, speed 3.11) |
| udLy01 st1 | f3176 | Sub15 rain spoke (spawn f2995, age 180) |
| udLy01 st2 | f4985 | Sub4 (age 46) |

Goal: gx st1 = native No-Miss (0 unexpected hits over 11,460 frames).

**Pass-11 closed the st1 midboss movement defect**: op-75's rect clamp
(FUN_0042c180 — an ENEMY clamp, the identity accessor FUN_0040b460 was
misread as a player clamp) runs every manager pass around the movement
integrator and after every ins_63 setPos. The Sub22 ins_64(90,4,192,144)
tween now rides the y ceiling exactly like native (census-exact 128.000
from f3352; was parked at 144).

**st1 RNG stream: offset-0 parity through f2699** (85k draws frame-exact
vs fa-native-gx/rng-curve.jsonl, dedup keep-last). First persistent
divergence f2965: both effect pools hit 512 full simultaneously; native's
firefly batch allocates 1-of-4 (pre-batch 511), the port's 4-of-4
(pre-batch 508) → +78 draws, never repaid. Gap = 3 zero-draw effect VMs
(all draw-costed spawns provably match; id12/20/40/45/48 excluded —
death/bomb/hit paths). Downstream chain proven: RNG desync → Sub22 t190
op67 exit angle → 17px trajectory gap → the f3630 razor. Pinning the 3
VMs needs a wine round scanning the 0x200 effect pool's id histogram
f2930-3010 (user-gated). st2 keeps the f696 −4 collect deficit (slot8
one frame late; movement-precision family).

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

1. **st1 effect-pool 3-slot gap (the f3630 razor's direct root)**: RNG
   draws match native frame-exact to f2699, then the first simultaneous
   pool-full at f2965 splits the free-slot race. Candidates: id5/id51/id62
   tick-boundary lifetimes or an unmodeled zero-draw request. Sharpest
   probe: wine /proc round dumping the 0x200 effect pool's per-id
   histogram f2930-3010 (user-gated); same round can take native player
   coords f660-700 for the movement-precision family.
2. **Movement-precision family**: st2 sub12 0.46→0.8px drift (f1787+),
   f1558 early kills of the s1 y=160 left-movers, slot8/f696 player
   micro-position — ECL float-path + player-motion instruction-level
   collation.
3. Boss-fight pacing ~2.5-3x slow — measured to live entirely POST-wall;
   attack after the contact wall falls.
4. Visual: stage fog law, boss lifebar details. Replay block chaining UX.

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
