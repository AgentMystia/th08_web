# TH08 handoff (current state — full history in git log of this file)

Repo `AgentMystia/th08_web`. Browser reimplementation of TH08 Stage 1+2
(Border Team) from original data. Playable end to end: title → difficulty
→ team → stages with dialogue, HUD, ECL waves, spells, bombs, Wriggle and
Mystia fights; browser replay load & playback (title → Replay → .rpy).
Gates: `npm run check` / `npm run build` / `npm test` (213) + CI
(core/browser gate Pages; replay job advisory).

## Convergence picture (2026-08-28, post ce2ba87)

Formal-mode earliest unexpected player hit (THE metric):

| fixture-stage | now | bullet family |
|---|---|---|
| udGx01 st1 | f3217 | Sub13 (spawn f2726) |
| udGx01 st2 | f3021 | Sub4 aimed fairy, speed 2.9625 |
| udLy01 st1 | f3193 | Sub15 midboss rain spoke |
| udLy01 st2 | f4487 | Sub6, speed 1.72 |

Goal: gx st1 = native No-Miss (0 unexpected hits over 11,460 frames).
All four current contacts are the same phantom family — razor-edge
misalignment of aimed bullets whose every kinematic ingredient is
machine-code-pinned. They are downstream of small RNG draw-stream drifts:

- gx st1 draw parity vs native census (`tmp/fa-native-gx/`) now holds to
  **f861**, then ONE +52 event (two effect-51 fireflies; ±2-slot
  effect-pool pressure phase — port n62/n51 counts match native steady
  state; suspect STD camera / cone geometry lifetimes).
- gx st2 delta-domain parity holds except one −4 event at f696 + a
  constant −4 stage-entry offset (both pre-existing across HEAD).
- RNG budget oracles: gx st1 ≡ 864, gx st2 ≡ 22674 (count-exact target).

This pass closed the long-standing "(600,900] draw-drift window": the
death-wipe gate read ins_83's +0x3328 bit instead of ins_127's +0x3324
boss-registration bit (ordinary enemies fired the full-field wipe; f585
= 56-draw/frame deficit), and the gauge drift family got objdump-pinned
(cap 21 + equality-divides via fnstsw 0x41, youkai idle −3 tier,
youkai-flip idle park through the +0xfdc bomb gate). ly st2 moved
f2036 → f4487 as a direct consequence.

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

1. **f861 firefly pool-pressure event** (gx st1): needs native per-slot
   effect lifetimes — either a user-ordered wine round extending the
   census to the effect pool, or decompile-audit FUN_00426280/FUN_004264f0
   cone geometry vs our STD camera/facing.
2. **gx st2 f696 −4 event**: one extreme-gate time-orb the native census
   did not pay; find the gate mismatch (compare which enemy died there).
3. Constant −4 stage-entry offset in gx st2 delta parity.
4. Boss-fight pacing ~2.5-3x slow (option layout / per-pellet damage).
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
