# TH08 handoff (current state — full history in git log of this file)

Repo `AgentMystia/th08_web`. Browser reimplementation of TH08 Stage 1+2
(Border Team) from original data. Playable end to end: title → difficulty
→ team → stages with dialogue, HUD, ECL waves, spells, bombs, Wriggle and
Mystia fights; browser replay load & playback (title → Replay → .rpy).
Gates: `npm run check` / `npm run build` / `npm test` (213) + CI
(core/browser gate Pages; replay job advisory).

## Convergence picture (2026-08-28, post 6c24950 — pass 5)

Formal-mode earliest unexpected player hit (THE metric):

| fixture-stage | now | bullet family |
|---|---|---|
| udGx01 st1 | f2926 | Sub13 (spawn f2788, in-family shift) |
| udGx01 st2 | f4662 | Sub4 aimed fairy, speed 3.54 |
| udLy01 st1 | f3297 | Sub15 midboss rain spoke |
| udLy01 st2 | f4486 | Sub6, speed 1.72 (family unchanged) |

Goal: gx st1 = native No-Miss (0 unexpected hits over 11,460 frames).
All four current contacts are the same phantom family — razor-edge
misalignment of aimed bullets — downstream of small RNG draw-stream
drifts:

- gx st1 draw parity vs native census (`tmp/fa-native-gx/`) now holds
  to **f2236** (was f861). Two root causes closed this pass: the
  firefly spawn center (native = camera + facing/2 + (0,−50,−100), the
  view-ray midpoint — the port's camera+(0,+100,+30) spawned near the
  0.94 cone edge and died early, keeping ~2 pool slots free → the
  f861 +52), and the shot-cycle ARM/option-callback order (on arm
  ticks the option's fall-through target clear ate the same tick's
  beh1 SHT aim → the f1181 −4).
- The gx st2 constant −4 stage-entry offset is GONE (delta-domain
  exact to f695); ONE −4 remains at f696 (full-power crossing: five
  native collect checksums vs four), stream re-aligns at f697.
- RNG budget oracles: gx st1 ≡ 864, gx st2 ≡ 22674 (count-exact target).

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

1. **Homing-item collect razor edges (f2236 + f696, merged)**: the −4
   steps are native collect checksums the port misses — gx st1 time orb
   misses the grab box by 1.8px at f2235 (collects one frame late), gx
   st2 f696 powerSmall misses by 6.5px then crosses full power and pays
   0. Both are long-homing pursuit micro-drift (~0.03-0.04px/frame) that
   all pinned primitives cannot explain; a wine round with an
   ITEM-POSITION census (per-frame x/y/vx/vy per slot) would split it.
   The pool/firefly model is exe-exact (pass 6 pinned the whole camera
   VM chain; f32-vs-double verdict flips: zero).
2. **Formal contacts f2926/f4662/f3297/f4486**: phantom aimed-bullet
   family; post-f2236 bullet rank-speed rolls ride the −24 draw drift,
   so any stream realignment re-rolls the contact lottery. Same
   micro-geometry family as the gauge event phase flips (f918/f950 st1
   kills land 1-2 frames early at HP zero crossings) — pre-midboss
   enemy HP curves match native EXACTLY, the wall is per-frame geometry,
   not macro semantics.
3. Boss-fight pacing ~2.5-3x slow (option layout / per-pellet damage)
   — measured to live entirely POST-f2926; attack after the contact
   wall falls.
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
