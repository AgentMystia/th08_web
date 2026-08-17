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

## Update (2026-08-15, fifth pass — decompile-driven convergence, no trace)

Per the redirect away from the blocked native-trace path, the TH08 item
system is now reproduced from the ItemManager decompile:

- Th08ItemSpawnPool wired into spawnItem: ItemManager::SpawnItem's exact
  2096-slot cursor, bounds reject, full-power conversion, time/time2 state
  forcing, and the state-2/3/5 RNG draw order (tests pin the draw counts).
- Death drops run FUN_0042bea0 with the exe's DAT_004c70d8 32-byte table.
- Collects settle through Th08RunState (point ladder, time-orb gauge/clock).
- Bullet cancels convert to time orbs (DAT_018b8988==9 -> two type-7 drops).

Residual divergence is now cleanly isolated: the recorded player survives
stage 1 deathless, and our sim's three deaths (f1039/f1371/f1718) cascade
into the power/score/gauge gaps (each death zeroes power and drops the
field). The deaths themselves come from wave-danmaku micro-geometry that
the decompile fully decodes but whose frame-exact placement cannot be
verified without the native trace. Everything decompilation can prove is
implemented; the remaining gap is measurement, not modeling.

## Update (2026-08-17 — decompile-driven fidelity pass, three commits)

Direction per user: abandon the blocked wine trace; converge by exact
decompile reproduction. The playtest report (all enemies render as
Wriggle, stage timing wrong, player shots wrong) traced to four engine
root causes, all fixed from Th08.exe disassembly evidence:

1. **Timeline v2 dispatch** (eclvm runTimelineEventTh08): the old switch
   dropped spawn ops 1/3/5/11/12/15 entirely (~half the waves), never
   applied the per-difficulty rank byte (so !EN waves fired on Lunatic),
   misread op 8 (boss interrupt) as a dialogue start, op 10 (boss-alive
   hold) as an interrupt write, and never implemented the 13/14 timeline
   latch (Timeline 1 jumped its midboss gate). Arg layouts per op from
   FUN_0042a8a0 (all.c:20270-20393): 2/4 draw x in [min,max) with an
   rng01 draw, 3/5 draw x=rng01*384, 11/12 write the +0x3308/+0x330c
   extended drops with item forced -1; op 15 alone bypasses the
   boss-registered spawn gate.
2. **ins_2/ins_160 are ZunTimer::SetCurrent, not waits** — remapping them
   to TH07's op 45 parked sub clocks and ran time-0 tails 60 frames late,
   which teleported the stage-1 midboss offscreen after its seen-latch
   and got it offscreen-culled at f2994. The TH08 sub model is the ==-
   gated clock with data-driven instruction times.
3. **Two-file enemy ANM**: the dispatcher resolves enemy scripts via
   flags2 bit 2 — plain ops 54/55/57 hit the common enemy.anm, alt ops
   58/59/61 the stage stgNenm.anm (asm 0x419850/0x419acc/0x419d2f/d4e).
   Fairies were rendering Wriggle's six pose scripts. ins_127 now does
   the boss-slot registration (DAT_00f54cc0) so op-10 holds work.
4. **Player shot chain**: shot ANM script = sht.sprite + 10
   (FUN_0044fb70 @ 0x44fd32); shot textures face +x so autoRotate uses
   the raw velocity angle; behavior dispatch uses funcs[1] for the
   per-frame seek (FUN_00450320, with its 40-frame age gate) and funcs[0]
   for the spawn-time aim at the cached target (FUN_00450240, no RNG);
   the fire cycle is 20 frames (FUN_00451500, asm 0x4515b8), not TH07's
   30. Option-sourced records spawn at the player center pending the
   option-trail model (flagged).

Plus: bullet command queue (ins_111) field order fixed (opcode=arg1,
cond=arg2, angle/speed=args5/6), slots widened to 16, and the immediate
commands 0x20000/0x4000/0x80000/0x40000 implemented; TH08 vars
10088-10095 mapped; item visuals are the etama.anm scripts itemType+61
(global index - 150 = on-disk id); spawn-state durations now read the
flash scripts' real lengths; all ANM v3 opcodes in the embedded data
implemented (44/49/80-87); TH08 sidebar rows completed (Power bar, Point
n/100, Time orbs/3000, the bottom-left human/youkai gauge, night-clock
advance at the tally).

**Convergence state after the pass**: `replay:verify:th08` still reports
DIVERGED — kills 104, rng 10010 vs 32816, and the recorded run dies six
times to wave-bullet micro-geometry (killer provenance logged: subs
1/3/10/12 dir-change bullets, ages 74-207). The deaths cascade the
item/power/DPS chain, so the midboss fight never finishes in-sim and the
boss never spawns there. Every system above is now exact to the
decompile; the residual is the kind of sub-frame bullet placement that
only a native per-frame trace can pin. The harness
(scripts/native-trace.mjs) remains ready for a host where Th08.exe
boots.

**Note**: two isolated test flakes were observed this session (a
border/bomb timing test failed once each in two full-suite runs out of
ten; both green on reruns, never twice in a row). Not reproducible on
demand; watch for them in CI.

## Update (2026-08-17, seventh pass — first-death forensics + flag semantics)

Verifier-directed decompile work on the first phantom death (f1024, Sub3's
f884 aimed-fan middle layer). Every link verified exe-exact, so the bullet
is fully accounted for in our sim: spawn f850, double-tick day counted,
mode-4 easing confirmed 1-(1-t)^2 (all.c:10733), volley phase at
ctx.time 34 (deadline 33 + arm tick), aim = exact atan2 at the fire-tick
inputs (player 128.54,369.37 / enemy 192,75.21 -> 1.7833 rad), fan
{0,±0.0898,±0.1795}, layer speeds 3.0125/2.310/1.608 at rank 10, spawn
backup 4 velocity vectors, spawn-state /2. The contact at f1024 is inside
the exe's own AABB by ~3px — so the native miss must come from a sub-frame
volley-phase/position difference that the snapshot chain cannot pin.

New evidence-driven fixes landed (commit 3e61e5c):
- The field sweep exemption: FUN_0042efb0 spares flags2-bit6 enemies —
  Sub14 (the stage-1 ambient emitter) was dying to every boss-entry
  sweep, and to the seeking pair before that (flags bit4 = the TH08
  collision-disable: contact, damage, AND homing-target publication are
  all gated on it clear, all.c:21448). Sub37's boss body now stays
  intangible for its authored 150-frame entrance.
- Effect pool: TH08 runs 512 slots (FUN_0042efb0 scan), effect 51 modeled
  from etama script 73 (241-frame life, 10 u16s/spawn).

**RNG-residue note (important correction)**: the native "budget" is only
known mod 65536 (the seed residue) — 32816 OR 98352 OR ... Our ambient
stream alone draws ~53k at full rate, so the native's true count is
probably 98352, with the ~40k gap being the boss-fight economy that never
runs while the midboss fight stalls. The residue can only converge once
the deaths are fixed.

**Rank/graze audit**: TH08's per-event rank awards all match the exe
(+6 graze @0x44aa14, +1 power-small, +3/+10 point, -1600 death,
+200 extend, survival +100 per 2400-240*lives frames). The graze COUNTER
steps +1..+3 per event in the native (FUN_00406d10/40 tier reads on four
manager threshold words) — our +1/event undercounts the field (270 vs 536)
without a geometry gap; the tier table is undecoded (flagged).

## Update (2026-08-17, eighth pass — verifier-directed order-of-operations audit)

Two specific order-of-operations rules verified exe-exact, no change needed:

1. **New bullets integrate on their birth frame.** TH08's bullet manager
   (priority 12) runs after the enemy manager (priority 10), so a bullet
   created this frame receives its case-1 tick (motion, then cull, then the
   player-collision block) in the same OnUpdate — our updateBullets after
   updateEnemies matches, including the spawn-state halved first move
   (state 2/3/4 divide velocity by 2/2.5/3, all.c:23585-23656).
2. **Enemy fire uses the pre-integration position.** The ECL interpreter
   (fires) runs at all.c:21340, the position integration at 21356 — fire
   reads the position as of frame start. Our tickEnemyCore dispatches
   (fires) before integrateEnemyPosition — same.

First-death (f612) full closure: the player position at f611 is
bit-identical to a standalone integration of the recorded inputs (diff
0.00 through f611) — movement, chords, and stage-start (in-residence +
240f invuln; the fly-in modernization is not present in the current tree)
are all exact. The killer is the outermost (-0.1795) fan bullet of Sub1's
first auto-fire volley, spawned f534 with the exe's own phase math; it
clips the player by ~1.7px per axis at f611. The remaining miss margin is
below what the snapshot-chain evidence can resolve.

**Where the residual actually lives**: the recording's deathless run is
separated from ours by differences of 1-3 frames of volley phase or ~1-3px
of bullet path — exactly the class the AGENTS.md fidelity workflow assigns
to a native PRE trace. scripts/native-trace.mjs is ready for a host where
Th08.exe boots (real GPU wine or Windows).
