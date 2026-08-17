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

## Update (2026-08-17, ninth pass — item economy chain audit)

Verifier-directed audit of the item economy against all.c's ItemManager.
Fixed:
- **Time-orb homing** (states 3/5): tossed orbs now crest and home to the
  player (all.c:31084-31108) instead of falling offscreen — the gauge/orb
  income streams live again (gauge -1443 -> -3996 toward native -7893).
- **Drop counters zero-init**: DAT_00f54ce0/00f54ce2 are persistent BSS
  globals in the exe; our TH07-style RNG reseed desynced the stream by 2
  draws from frame 0 and randomized the 32-entry drop-table phase.

Verified correct, no change: collect AABB (item ±12 vs grab ±12,
FUN_0044a5a0), state-0 fall (0.03 accel / 3.0 cap), typed/-1/-2 drop
mapping (FUN_0042bea0), drop spawn at the enemy's render position.

The 61-vs-3 point-item gap is predominantly downstream of the death
cascade (fewer kills + no phase-transition cancels while the midboss
stalls), not an independent item-chain defect: per-kill drops, spawn
positions, and fall physics all match the exe.

## Update (2026-08-17, tenth pass — the T8RP parse was wrong; five root fixes)

**The largest finding: the T8RP stage-block layout was mis-parsed all
along.** The exe evidence (recorder FUN_00452310 writes one u16/frame;
v6 playback feed FUN_00452550 strides 2; the stage-entry hook starts the
record cursor at block+0x24, all.c:40991) plus two independent size
cross-checks (the slowdown trailer is exactly 1 + ceil(10504/30) = 352
bytes; the stage-2 block pointer) prove the v6 layout is `{0x24-byte
metadata, N x u16 input words}` — stage 1 has **10504** frame records,
not 5245. The old `0x40 + 4-byte {input, aux}` parse read every other
true input word starting at true-frame 14: the whole stage ran at half
length with a scrambled route, and every earlier "player path verified
bit-exact" claim was circular (model vs sim sharing the same bad parse).
There is NO per-frame aux word in v6 — the "inputHigh" column was an
artifact of the mis-parse.

Exe-proven fixes landed this pass (commits 634704d, f106ff8, 7dc4333):

- **Auto-fire flags**: the captured-FIRE replay read the flags dword one
  slot past the 11-dword image (`gi(8)` → undefined → 0). Every
  auto-fired volley lost its spawn-state (the ÷2 intro + 4-vector
  backup), sfx, and the 0x8000/0x10000 gates. `gi(7)` restores them.
- **Arith ops 10-19** are two-operand compound assigns (dst op= arg1;
  exe cases 9-0x12, all.c:10884-11000), not TH07's three-operand forms.
  The remap read a phantom third operand from the next instruction's
  header; op17 (`*=`) against a zero time-field zeroed Sub0's chase
  target (`0.6*(player-enemy)+enemy`), so wave fairies never entered
  the shot column — the kill/collect cascade died with it.
- **Timeline holds advance the clock**: op 7 (dialogue), op 10 (boss
  alive), op 13 (latch) all `goto LAB_0042ad52` in FUN_0042a8a0 — the
  clock advances while the cursor parks. Freezing it put the boss intro
  at midboss-death + 1236 frames. (TH07's freeze retained for TH07.)
- **Death mode is flags bits 20-22** (ins_129; the switch at
  all.c:21639), not the TH07 deathMode field. The misread forced every
  TH08 death to mode 0, skipping the death callback — the midboss never
  ran her phase-exit sub, so the spell never ended and the boss never
  spawned. With it, the full chain (midboss death → end-spell →
  unregister → intro chat → boss spawn → boss phases → stage clear)
  runs end-to-end.
- **Rank table**: DAT_004c7880 = E/N 10/8/16, H/L 8/8/12, Ex 16/15/16
  (init/min/max per difficulty, read from the binary) — not TH07's
  16-start with Lunatic [10,32].
- **Dialogue**: op13 arms the skippable flag; skippable + Ctrl
  fast-forwards (the msg clock SetCurrent-jumps to the pending
  instruction's time and op4/op21 waits bypass, gui-run-msg.c:33/116/
  228); op6 is the ECL resume ticket releasing the timeline's op-7 hold
  mid-conversation (msg+0x22d78); the op5 portrait/script bridge packed
  an i16 pair as one i32 and crashed the intro chat's tail.
- **Items**: launch vy = −2.1875 (0xc00ccccd, not −2.2); orb toss vy =
  −2 − rng·0.1; the state-0 fall snaps vy to 3.0 once y ≥ 3.0 with the
  0.03·rate gravity only above that, and state-1 homing skips the
  gravity tail entirely (all.c:31064-31121).
- **Vars 10061-10068** are the eight run-global floats DAT_004ece20..3c
  (boss pattern parameter bus; subs 26/38/44/48 write 10065); 10099 is
  the replay-playback flag (0 in live play = the recording's context);
  10098 is intentionally unmapped-in-exe (literal default).

**Current verifier state** (`replay:verify:th08`): the full 10504-frame
stage plays; a dialogue-tapping invulnerable playthrough reaches the
boss, fights her phases （隠蟲「永夜蟄居」 etc.), and CLEARS the stage.
The recorded run itself still DIVERGES: 7 phantom deaths at
f685/1012/1405/1793/2198/3300/3790.

**The death residual, precisely**: every death is a sub-2px borderline
interception (the f685 ring bullet hits with 1.16px/0.64px slack on the
two axes; ±1 tick of volley phase or ±2px of trajectory flips every one
to a clean miss). Verified exe-exact, each against all.c: the player
path (movement/chord/speeds/clamps, independent-model diff ≤ 0.0002px),
the volley phases (deadline rank-lerp 33, post-clock unwind evaluation,
spawn-day double-tick), the fan/ring shapes and the rank-bumped speeds
(−0.25/−0.125 at rank 8, matching the exe's init −0.5/+0.5 configs), the
spawn-state lifecycle (backup 4 + 10 half-moves + end-tick full), the
kill box (proto half 4.0 /2 + player 0.825 = 2.825), the scheduler order
(player 9 → enemies 11 → bullets 14), and the slowdown cadence
(all.c:27443-27452 = the harness's buckets exactly). The residual is
sub-frame and, per the AGENTS.md fidelity workflow, belongs to a native
PRE trace; wine still cannot boot Th08.exe here, so
scripts/native-trace.mjs waits for a working host.

Also ruled out with evidence this pass: fan-angle mirroring (the exe has
no mirror-bit consumer in the fire path), the "+0xbb834 attack-slot
shoot-down of spawn-state bullets" (bomb-slot table; the recording never
bombs), the eased-move fraction phase (FUN_00422c40 ticks-then-reads,
matching our pre-decrement), and the 58-fps slowdown buckets (an engine
rhythm, not density).

## 2026-08-18 mechanics alignment pass (cb42c0f + this commit)

User-facing fidelity fixes, all static-RE derived (no wine/images):

1. **使魔突进**: Ran now lunges onto enemies (anchor (enemy.x, max(32,
   enemy.y+32)) once the pointer cache arms after 10 firing-cycle frames,
   0x44e3a0 sub-3 / 0x44e8d0), her needles (ply00as funcs[0]=1 records)
   spawn from the lunging position aimed at the pointer-cache enemy at
   speed ×1.5 (0x450240), and the unfocused amulets seek the primary
   max-y cache (0x450320). Node probe: option at (255,178) against an
   enemy at (267,122) with lunge=true.
2. **人妖量表**: full exe model (fire ±20/frame ramping counter/15 past
   300 focus-stable frames, idle drift 2/3/5 by depth, kills ∓200, grazes
   +100, dialogue −g/12, bomb ±26000/duration bypass; limits ±10000,
   effects ±8000, tint ±2000 from 0x44d9ee). HUD: notches + cursor +
   extreme blink.
3. **Bomb**: exe-faithful rewrite. The dispatched table is player+0x1000
   (rdata 0x4c7ad0 team-0 block: 0x40c010 unfocused / 0x410c40 focused /
   0x40c910+0x410fe0 deathbombs); the 0x40c820 youkai block is never
   dispatched. Durations 260/200/260/300. Deathbomb inverts the side and
   costs 2 bombs. Focused bomb = r100 field + waves at 10/20/30, NOT 16
   orbs. Probes: type-0 runs exactly 260f, gauge −100/frame clamped
   −10000, ends cleanly.
4. **決死結界**: 18-frame SHT window; white screen flash while open.

**Death residual after this pass** (re-measured): f684/1011/1338/1779/
2197/2664/3117, ALL Y-axis-bound with 0.48-1.86px slack — the uniform
needed correction is "bullet 0.5-1.9px higher", uncorrelated with age or
speed. This pass additionally verified native-equal: the TH08 bullet
state machine 0x431240 (case 2/3/4 half-move → VM-end → same-tick case-1
fallthrough; +0xd50 velocity add; +0xdac behavior dispatch order), the
killbox 0x44a230 (AABB, player box from sht[0xc]/2 at +0x3d4→+0x38c..,
bullet size +0xd34), the graze-then-killbox order with the
attack-slot-contact early-out (0x449ff0 → bullets inside bomb-aura slots
enter state 5 and cannot kill), and the player killbox init (0x44d7d1).
Still needs a native trace.

**Gates this pass**: 393/393 tests, TH07 replay:verify 6/6 PASS, clean
headless boot (0 page errors), TH08 stage runs all 10504 frames. Play
band f800/f2500 shifted (needle ×1.5 changed kill cadence — exe-correct);
side/lower bands byte-consistent with the AGENTS baseline (18/19/24 and
97/7/99). Playtest server: `python3 -m http.server 8000 --directory
/workspace` (dist rebuilt).

## 2026-08-18 second forensic pass — the fire-position hypothesis disproven

The completion review proposed the ECL FIRE reads a different enemy
position field (+0x2d34 logical vs +0x2d88 ANM, ~2.16px phase). Decoded
from the exe: FUN_00422720 @ 0x4227f8 builds the fire origin as
vec3add(enemy+0x2d88, enemy+0x2db8); +0x2d88 is synced at the ECL loop
head (0x418520) as +0x2d34 + the spawn-anchor +0x2d40 (only ever written
at op91/timeline child creation, zero for stage-1 firers) BEFORE the
instruction dispatch — the native fire origin is the step-START position,
exactly what we use (f530 ring center (320, 67.0) = the pre-move value).
Decisive counter-evidence: two of the seven killers (the f916 and f2105
volleys behind deaths f1011/f2197) are fired by STATIONARY enemies
(pre == post position) — no position field or interp ordering can shift
those volleys at all. Also disproven this pass: the player Y clamp
(FUN_0043c686 initializes the clamp box 8/16/368/416 → x∈[8,376],
y∈[16,432], byte-equal to the inherited TH07 values; death#7's y=432.00
IS the native clamp). The f684 killer's full flight re-integrated
numerically: 280.2px over 155 ticks = 146 full moves + 9 half-speed
spawn-state moves — constant velocity with the 9-tick spawn state,
exactly our model. Every geometric link (fire origin, volley
modes/angle-set equivalence, layer speeds, rank bump, spawn state,
killbox AABB/sizes, graze order, clamp, hitbox) is exe-verified; the
residual requires a native per-frame trace (wine prerequisite).

## 2026-08-18 third forensic pass — first-move phase and SHT speeds

The proposed bullet-first-move phase was verified natively equal: the
constructor FUN_0042f5f0 writes spawn state 2/3/4 (+0xdb8) at construction
(flags bits 1/2/3), runs one queue pass, and does NOT move the bullet; the
first move comes from the same scheduler tick's bullet manager (priority 14
runs after the enemy manager's 11 in the same frame) — identical to our
updateEnemies→updateBullets same-frame order. The f684 killer's profile was
re-derived exactly: constructed during the f529 scene update, 11 half-speed
spawn ticks (the authored etama duration — data-derived, not tunable) + 146
full ticks, with the transition tick's half+full double move per
FUN_00431240 case 2's goto-case-1 fall-through; measured displacement
(−233.04, +155.71) = 11×(−0.769, 0.514) + 146×(−1.538, 1.028) exactly.
The uniform-flip test: the seven deaths need extra Y separations of
0.65/1.18/0.65/1.13/1.70/1.86/0.48 px = 0.71–2.10 half-tick units — no
integer phase shift flips all seven (+1 flips 2/7, +2 flips 6/7, −1 none).
A single-tick phase root cause is mathematically excluded; per-volley or
player-side per-frame differences remain, which only a native trace can
pin. Also verified this pass: our SHT parser's speed/diag/focused offsets
(36/40/44/48 = exe 0x24/0x28/0x2c/0x30) and values (4/2/2.828/1.414) are
exactly the fields FUN_0044aec0 reads — the player movement chain is
byte-verified end to end. No behavior change landed (none was warranted).

## 2026-08-18 native-trace attempt — empirically blocked by this host's wine build

The completion review directed running scripts/native-trace.mjs. Executed
in full; the game boots and renders under wine here, but every debugger
route is structurally blocked by the wow64-only wine build (wine-10.0
Ubuntu repack):

1. PLAIN launch: `Xvfb + LIBGL_ALWAYS_SOFTWARE=1 + wine th08.exe` boots,
   title renders (verified numerically: logo band bright 126 / texture
   96%), but ONLY from the SECOND launch in a wineserver session (the
   first is always a black-window 100%-CPU spin). The attract demo would
   play from here — but a plain run yields no per-frame data.
2. winedbg LAUNCH mode (`--gdb --port --no-start`): the stub and gdb
   client work (breakpoints bind at 0x44d650/0x431240/0x44a230/0x422720),
   but the debugger-spawned game always lands in the black busy-loop —
   D3D8 init never completes under the debug spawn, so no breakpoint is
   ever reached.
3. winedbg ATTACH mode (fifo-driven internal gdb): breakpoints set and
   memory reads work, but the first `cont` kills the game with
   0xC0000005 inside the wow64 thunk (0xffd3961c) — suspending/resuming
   wow64 threads corrupts their syscall emulation.
4. The clean fix — a WINEARCH=win32 prefix (native 32-bit, no wow64) —
   is refused by this build: "WINEARCH is set to 'win32' but this is not
   supported in wow64 mode". ptrace_scope=1 is also read-only here, so
   no direct gdb -p either.

Recipe notes for a future capable host (kept in /tmp, not committed):
warm the wineserver with one sacrificial launch before the real one;
`winedbg --gdb <wpid>` needs a held-open fifo stdin or it exits on EOF;
the stub port accepts exactly one gdb connection per session. The trace
script /tmp/native-trace2.gdb holds the four breakpoints and the KILLBOX
per-event dump format (frame, player pos, bullet pos/size/vel/state) —
ready to run unchanged once a host can debug the game.

The 7 phantom deaths therefore remain the documented residual; all
static candidates were exhausted (three forensic passes, each with
recorded disproofs), and the dynamic oracle is unavailable on this host.
