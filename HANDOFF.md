# TH08 handoff (current state — full history in git log of this file)

Repo `AgentMystia/th08_web`. Browser reimplementation of TH08 Stage 1+2
(Border Team) from original data. Playable end to end: title → difficulty
→ team → stages with dialogue, HUD, ECL waves, spells, bombs, Wriggle and
Mystia fights; browser replay load & playback (title → Replay → .rpy).
Gates: `npm run check` / `npm run build` / `npm test` (213) + CI
(core/browser gate Pages; replay job advisory).

## Convergence picture (2026-08-28, post fa6410f — pass 7)

Formal-mode earliest unexpected player hit (THE metric):

| fixture-stage | now | bullet family |
|---|---|---|
| udGx01 st1 | f3184 | Sub15 midboss rain spoke (spawn f2995, age 180) |
| udGx01 st2 | f4365 | Sub4 aimed fairy (age 76, speed 3.11) |
| udLy01 st1 | f3174 | Sub15 rain spoke (family shift) |
| udLy01 st2 | f3708 | Sub1 (age 99, family shift) |

Goal: gx st1 = native No-Miss (0 unexpected hits over 11,460 frames).

**st1 RNG stream: frame-exact parity over the FULL native census coverage
f0-f11457** (was first-diff f2236 / frozen −24). Root cause closed this
pass: the kill gauge delta signs on the RAW focus byte (player+3,
objdump 0x42d65c), not the form byte — wrong signs kept the gauge short
of the −8000 human-extreme threshold, silently disarming the per-death
bonus time orb (4 draws each) = the whole f2236 staircase. Remaining st1
defects are PURE bullet geometry (stream exact). st2 keeps one stream
defect: f696 −4 (two item collects whose id0 flashes never pay; slot8
arrives one frame late; power timeline verified frame-exact).

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

1. **Bullet-path micro-geometry (gx st1 f3184 + st2 f4365)**: with the st1
   stream frame-exact end-to-end, every remaining contact is pure
   per-frame geometry. Method: dump the contact bullet's full trajectory,
   independently re-simulate the exe law in f32 from the same spawn
   params, and diff — the port's own integration vs the decoded law.
2. **st2 f696 −4**: two item collects whose id0 flashes never pay in the
   port (8 vs 10 collects at N696; the deficit never repays — full-power
   power→pointSmall conversion interaction suspected); slot8's one-frame
   late arrival (5.21px short at f695; power/PoC timelines verified
   exact, so the lag is in its earlier pursue path).
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
