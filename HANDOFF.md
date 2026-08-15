# TH08 vertical-slice handoff (2026-08-15)

## State

Branch `th08-vertical-slice`. TH08 Stage 1 is playable end to end through the
original data: title menu → difficulty → Border Team → Stage 1 with dialogue,
HUD, ECL-driven waves, spell cards, bombs, and the Wriggle boss fight.

All gates green: `npm run check`, `npm run build`, `npm test` (392),
`npm run replay:verify` (TH07 6/6 PASS), clean `dev-shot` boot.

## The convergence picture (honest)

`npm run replay:verify:th08` replays `replay/th8_udLy01.rpy` stage 1
(Border Team Lunatic, 5245 frames) through the production StageScene.
Current divergence from the recorded stage-2 entry snapshot:

| field | ours | native (stage-2 entry) |
|---|---|---|
| score | 56519 | 7376015 |
| graze | 178 | 536 |
| pointItems | 2 | 61 |
| pointItemValue | 300000 | 320690 |
| power | (untracked here) | 115 |
| lives | (divergence deaths) | 6 (deathless) |
| bombs | 3 | 3 |
| gauge | 0 | -7893 |
| clockTime | 0 | 1 |
| RNG draws | 9472 | 32816 (seed 0x8fbe→0x32fb) |

The recorded run is a low-interaction Lunatic survival playthrough: the
player never pushes above y≈160 (verified by integrating the recorded input
stream), so most wave enemies survive to the boss. Kills mostly come from
Yukari's seeking option during focused windows — our seeker wiring works
(collisions settle, enemies die when hit), but the kill count is short of
native by an order of magnitude, which starves the item/point/score/RNG
streams.

## What is proven vs open

Proven by the exe decompile (reference/re-specs/th08-ecl-ops-*.md,
th08-bullet-anm.md) and landed:
- ECL opcode remap + interpreter (all 183 raw opcodes for stage 1).
- FIRE family (9 angle modes), bullet prototypes (21, exe VA 0x4b4ad8),
  prototype hitboxes, spawn-state flash/fade scripts.
- Auto-fire capture+replay (ins_105-108) as a PERIODIC emitter.
- Timeline v2 op 6 = MSG start (dialogue machine runs it).
- Score = award/10 (FUN_004181f0), replay snapshots store that field.
- TH08 rank byte restore (T8RP +0x25), slowdown cadence buckets applied.

Open (blocked on native per-frame evidence):
- Enemy positions diverge from native early enough that the recorded
  grazing/dodging misses differently (first hit f1039). The likely upstream
  root is a movement/interp subtlety in the wave subs (ins_64/65/66 timing
  or the op-73/74 muzzle/fan writer pair) — the ECL data is fully decoded,
  but which micro-difference moves the field is not provable from the
  decompile alone.
- T8RP has NO per-frame aux event stream (the wide record's high word is
  input only; auxFlags are all zero). The convergence oracle is the
  stage-entry snapshot chain + RNG residue, which are integral and can only
  say "diverged", not "where".

## Native trace status

scripts/native-trace.mjs boots the original under wine+Xvfb and drives
winedbg's interactive prompt with breakpoints at the spawn/fire/RNG VAs.
In this environment the breakpoints never fired inside the window (the game
stays in the title under software rendering long enough that the read loop
timed out); the harness is a verified-boot scaffold, not yet evidence. A
future session with a working X11/longer window should finish it.

## Next steps (priority order)

1. Finish the native PRE-trace (or any frame-indexed native state dump) so
   the earliest divergence is a number, not a guess.
2. With the trace: fix the deterministic upstream root (never compensate
   with RNG/epsilon/special cases).
3. Stage-1 background (stage1.std) culling window: the ground slab's
   far-bound check (StageScene drawBackground, `objDot > size/2 + 880`)
   under-covers TH08's bigger slab — verify against Th08.exe Stage.cpp's
   actual bound before widening.
4. Item-pool swap to Th08ItemSpawnPool once drop rules are evidenced.
5. Visual acceptance against reference/native-shots/ (play/side/lower).

## Update (2026-08-15, second pass)

- Stage-1 background renders: fully-fogged ground cells draw on the TH08
  path (TH07's skip erased the floor — the native fog window sits inside
  the ground band's depth). dev-shot f2000/f2500 show the night sky, moon,
  tree silhouettes, rice paddy, and petal danmaku matching the native
  userdemo's look.
- Auto-fire capture+replay is periodic (was every-frame). Graze and score
  moved toward native (178 vs 536; 56519 vs 7376015) but the kill stream is
  still short: the recorded player survives stage 1 without dying and never
  pushes the PoC line, so most wave enemies live to the boss sweep. The
  residual divergence is upstream in the wave patterns' micro-geometry and
  is NOT provable from the decompile alone — it needs the native PRE-trace.
- The wine+winedbg harness (scripts/native-trace.mjs) boots the original
  and installs breakpoints at the spawn/fire/RNG VAs, but under Xvfb's
  software rendering the game did not reach stage-1 code inside the window
  in this environment. Finishing it (a working X11 or a longer window, or
  winedbg's own script mode) is the next session's first task.

## Update (2026-08-15, third pass — verifier accuracy + trace blocker pinned)

- The verifier's kill census was under-reporting by ~3x (it polled
  scene.enemies for hp<=0 after the manager had already spliced dead enemies
  out of the array). Instrumenting runtime.killEnemy shows the real stage-1
  kill count is 101 with the first at f269 — the damage/drop/settle chain is
  confirmed working at the right order of magnitude. The remaining score/
  graze/point gap is downstream of item collection (pointItems 2 vs 61),
  which is downstream of WHERE kills happen (kill geometry), which is
  upstream of the native evidence.
- The native trace blocker is now precisely characterized: under wine's
  software-rendered Direct3D on Xvfb, Th08.exe spins at 99.5% CPU without
  ever opening a game data file (no .dat/.rpy/.anm CreateFile in 300s) — it
  never reaches the title screen, so no breakpoint past the exe entry can
  fire. The harness itself is proven working (the entry breakpoint at
  0x4a619e fires and the gdb 'commands' loop prints + auto-continues). On a
  host where the original boots (real GPU or wine with GL), the same script
  produces the trace; it is not a code bug.

## Update (2026-08-15, fourth pass — trace blocker root-caused)

The native trace's failure is now root-caused to the container, not the
harness: wine 10 on this image provides ONLY wow64 mode (no separate
win32 prefix — `WINEARCH=win32` is rejected), and Th08.exe's Direct3D 8
device creation hangs under wow64 + Xvfb's software GLX: the process
spins at 99.5% CPU without ever opening th08.dat (verified via
WINEDEBUG=+file: zero game-data CreateFile calls in 300s). The exe-entry
breakpoint DOES fire (0x4a619e), proving the gdb-stub pipeline and the
breakpoint mechanism both work; nothing past startup is reachable here.

What would unblock it: a host with a real GPU (wine D3D on hardware GL),
or a wine build with 32-bit support, or running the trace natively on
Windows. The harness (scripts/native-trace.mjs) is ready and correct for
that environment.
