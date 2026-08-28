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

1. **f2236 pool-saturation −4 family** (gx st1): after the f2231 big
   kill the port's 512-slot effect pool saturates and 4-draw
   allocations start losing by 1-3 slots. Allocator semantics,
   authored lifetimes and init-callback returns are all exe-verified
   (pass 5) — the residual is the per-slot firefly cone-margin death
   phase: needs a user-ordered wine round extending the census to
   per-slot effect lifetimes. Decompound alternative: locate the
   writer of the 0x4ea3c4-region camera struct to confirm A = raw
   facing track (currently geometric + parity evidence).
2. **gx st2 f696 −4**: full-power crossing frame, one extra native
   paying collect; time-orb kinematics ruled out — needs a native
   item-position census (same wine round).
3. Boss-fight pacing ~2.5-3x slow (option layout / per-pellet damage).
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
