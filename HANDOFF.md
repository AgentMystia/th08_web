# TH08 handoff (current state — full history in git log of this file)

Repo `AgentMystia/th08_web`. Browser reimplementation of TH08 Stage 1+2
(Border Team) from original data. Playable end to end: title → difficulty
→ team → stages with dialogue, HUD, ECL waves, spells, bombs, Wriggle and
Mystia fights; browser replay load & playback (title → Replay → .rpy).
Gates: `npm run check` / `npm run build` / `npm test` + CI
(core/browser gate Pages; replay job advisory).

## Convergence picture (2026-08-30 pass 17)

Formal-mode earliest unexpected player hit (THE metric):

| fixture-stage | pass 16 | now | note |
|---|---|---|---|
| udGx01 st1 | f6352 | f6352 | **stream phantom** (see below) |
| udGx01 st2 | f5853 | f5853 | stream phantom (same family) |
| udLy01 st1 | f3176 | f3176 | Sub15 rain spoke (spawn f2995) |
| udLy01 st2 | f3470 | f3470 | f677 native deathbomb still exact |

Pass 17 was an AUDIT round: the pass-16 WIP verified 7/8 binary-exact
(ins_128 clouds, 0x20000 OR+RETURN, 0x40000 state-5, the three power
crossing checksums, extends, the time-orb ladder, the spell-capture
checksum arm, pointItems carry); the 8th (0x20000 wait gate) cleared
its bit one pass early — native checks the timer BEFORE decrementing
(all.c:23507-23514) — fixed + test re-pinned; all four frontiers
re-verified unmoved.

**THE discovery: the st1 RNG draw stream diverges from native at
f3582.** census.jsonl per-frame draws (native f == port after input
f−1): first miss +8 at f3582 (3 events, period 6, 24 draws), then +4
per hit-event through the midboss damage phase, −7778 by f5001. The
consumer: native pays MORE player-shot impact sparks (effect-5, 4
draws) than the port in the midboss window — 2 extra per 6 ticks
against the INVULNERABLE parked boss (HP pinned f3582-3604), 1 extra
per hit-tick during damage. Everything else is excluded (bullet ANM
scripts have no random ops; the spawn-state manager path draws
nothing; the enemy census is frame-exact through the window). Since
sub27/sub17 rebuild their fan base angle from RNG var 10082, the
f6352/f5853 contacts are phantoms of a diverged stream — the Sub25
bullet's motion law (0x40 sawtooth/turn + 0x10 accel) is asm-verified
binary-exact and was never the defect.

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
