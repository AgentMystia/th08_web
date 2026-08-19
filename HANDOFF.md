# TH08 vertical-slice handoff (2026-08-15)

## State

Standalone repo `AgentMystia/th08_web` (main = the vertical-slice branch;
CI deploys Pages). TH08 Stage 1 is playable end to end through the original
data: title menu → difficulty → Border Team → Stage 1 with dialogue, HUD,
ECL-driven waves, spell cards, bombs, and the Wriggle boss fight.

Gates: `npm run check`, `npm run build`, `npm test`, clean `dev-shot` boot,
plus the CI jobs in `.github/workflows/deploy.yml` (core / browser / replay
advisory → pages). Current status lives in Actions:
https://github.com/AgentMystia/th08_web/actions

## The convergence picture (honest)

`npm run replay:verify:th08` replays `tests/replays/th8_udLy01.rpy` stage 1
(Border Team Lunatic, 10504 frames) through the production StageScene.
Divergence from the recorded stage-2 entry snapshot (2026-08-15 snapshot;
see the latest dated entry at the bottom for the current numbers):

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
- **Timeline holds NET-FREEZE the clock** (2026-08-19 correction of the
  entry below's original claim): op 7 (dialogue), op 10 (boss alive),
  op 13 (latch) each call FUN_00418110 (Subtract 1) before `goto
  LAB_0042ad52` (Tick +1) — net zero while parked. The old "advances"
  reading measured the tick and missed the compensating subtract; the
  boss intro at midboss-death + ~1240 frames is native-correct pacing
  (post-midboss waves t=2935..3735 stream from the release point).
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

## Update (2026-08-18 presentation pass — bomb cut-in, sfx table, shot impacts)

Static-decompile alignment of the presentation layer (no wine; every fact
below is from Th08.exe v1.00d / the unpacked data):

1. **Player spell-card declaration now exists** (src/game/th08-declaration.ts).
   FUN_0040be30 (bomb cast) → FUN_00415d60 on the singleton at 0x4ea670:
   portrait VM (face_rm00/face_yk00 by be30's EDX selector), two banner VMs
   from face_cdbg.anm (archive scripts 0 + 2; the deathbomb's param_6=1
   binds the red sprite variant), and the name VM (text.anm script 4,
   waiting at ins_21(1) until FUN_00416130's bomb-end interrupt). Names are
   the rdata strings 0x4b43a0/0x4b44f4/0x4b43bc/0x4b4508; text.anm's '@'
   surface is exe-runtime so the name is canvas-typeset at the VM's live
   position/alpha. face_cdbg.anm is now embedded (extractor + generator
   lists, assets/th08-img/face_cdbg.png).
2. **TH08 sfx ids use their own table** (.data 0x4c81b0, 36 entries): playSfx
   dispatches TH08_SFX_SLOTS on the TH08 path; shared call sites branch by
   runState (graze 24, death 2, item 18, damage 17, powerup 25, extend 22,
   pause 26, ok 8). Bomb start plays id 13 (se_lazer00) + the declaration's
   id 14 (se_lazer01). FUN_0045d550's second arg is a pan value (shot spawns
   pass the player x).
3. **Shot impacts**: settle re-arms the VM to script sprite+0xb (the odd
   30-frame fade family) and spawns effect 5 → etama archive script 37;
   TH08 effects run on an etama-bound PlayerEffects layer (the old host fed
   archive indices to the player00-bound layer — every bomb effect visual
   silently culled). DAT_004c6d30: 5→37, 6→38, 12→44.
4. **Gauge denominator fix**: be30 param_4 (player+0xfe4, 200/150/200/250)
   not the duration — ±trunc(26000/param_4)/frame (0x44c81b).
5. **ANM interp channels now run on a monotonic tick** (exe
   interpCurrentTimers semantics): op5 loops / interrupts resetting the
   script clock no longer freeze armed tweens. One TH07 test
   (eff05b bullet-time overlay) was updated to the true gradual-growth
   semantics; TH07 replay:verify stays 6/6 PASS.

Verified: check/build clean, 399/400 tests (1 pre-existing skip),
replay:verify 6/6 PASS, replay:verify:th08 still STAGE 1 DIVERGED with the
same phantom-death residual but a closer end state (score 615305 vs the
pre-change 356160 against native 7376015 — the impact re-arm frees shot
slots 30f after hit, matching the exe, which shifts kills earlier).
Declaration probe (repo harness, batched advances): portrait sweep visible
(fresh→hold, region texture 97%), the rotated band 96% textured during
hold and released by 165f, the name present through the bomb and removed
after the end interrupt; standard checkpoints f120/f800 unchanged (play
8%/9% texture, side/lower in band). NOTE for probe authors: hand-rolled
static servers that mislabel .wav MIME starve the audio pipeline and the
HUD never draws (white sidebar) — always use scripts/lib/browser-harness
startStaticServer; and advance() in small per-frame batches can catch the
desync backbuffer mid-present (batch ≥30).

## Update (2026-08-18 second pass — kill sfx, bomb clocks, orb burst visuals)

User-reported defects round 2, all resolved from the decompile:

1. **Fairy-kill sfx was the miss sound**: the shared ECL death site plays
   TH07 id 2/3 (the doubled enep00 pair); TH08's de-duplicated table maps
   2/3 to se_pldead00/se_power0. The TH08 branch now plays id 1 (enep00,
   byte-identical wav across both games). The exe's own death site
   (0x42d9c0) computes (counter%2)+2 — flagged unreconciled. Also learned:
   FUN_0045d660's second arg is a per-request FREQUENCY value (the
   consumer feeds the channel's average to vtable+0x40), not a pan.
2. **Bomb clocks were swapped**: be30's param_4 (player+0xfe4) is the
   ACTIVE length 200/150/200/250 — the machine's end compare (0x44c667),
   the staggered-burst gate (param_4-0x28-i), the type-0 force-burst gate
   (param_4-0x1e), and the ±26000/param_4 gauge denominator; param_5
   (the +0xe2af4 clock) is the LONGER post-cast invulnerability
   260/200/260/300. bombTimer/bombInvuln now take the two tables
   respectively.
3. **The type-0 force-burst gate sat inside the t<40 seek branch** (its
   condition could never be true there): spiral-phase orbs silently flew
   offscreen with no explosion. Moved to the outer per-orb loop.
4. **Orb burst visuals**: player00 entry-1 script 19's burst state is an
   INTERRUPT — label 1 runs the authored 6x balloon + 20-frame fade +
   delete. The orb actors now keep PlayerEffectHandles and the 1->2 state
   transition fires interrupt(1) (FUN_00407120's VM+0x1fe write).
5. Orb seek turn denominator is speed/8 (_DAT_004b4300), not /4; the
   0x40c910 bombardment also spawns its own orb VM (script 0x14, slot 16
   then 17 forever per the literal-1 latch) besides effects 0x31/0x37.

Verified: 400/401 tests, replay:verify 6/6 PASS, clean boot, no page
errors. Kill-power probes: bomb into the f480 fairy wave shows on-screen
aura-burst kills (score 202 by bomb-frame 24) and the burst window reads
play texture 86-90% with warm additive centers (#8c671c) — the balloon
explosions render. Deathbomb probe: hit at f586, invuln window follows the
new tables, wave cleared (score +17k); the miss-vs-deathbomb race in that
probe is a probe-timing artifact, the deathbomb gates are unit-tested.

## 2026-08-19: 使魔实体化系统 + SFX 表重建 + Bomb 视觉落位 (pending commit)

User report: "Bomb视觉效果还是一塌糊涂，永夜抄的系统也没做好。妖形态，
敌方使魔应该可以攻击（实体化）；人形态，敌方使魔虚化……全系统应做做好。"

**Polarity correction (user's description was inverted; three independent
sources agree):** HUMAN form (unfocused, Reimu) MATERIALIZES familiars —
shootable, contact per team rules; YOUKAI form (focused, Yukari)
ETHEREALIZES them — shots pass through, no contact, ghost tint. Evidence:
all.c:21448 (damage+contact+pointer-cache block requires flags bit11==0 =
player human), all.c:21757 (the permanent half-alpha tint when bit11==1),
and the transition sound ids 39=se_opshow (player→human) / 40=se_ophide
(player→youkai) from the 46-channel table. Touhou Wiki concurs: "Familiars
may only be hit while the player is in human form."

Decoded + implemented (all exe sites cited in AGENTS.md §0's 2026-08-19
block):
1. **Player form byte** player+5: `player.th08Form`, 8-frame stability
   gate (FUN_0044aec0), transition tints (effects 0x1c/0x1d after >=5
   held frames), focus aura VM (effect 0x16, interrupt 1 on release).
   Bomb side + gauge kill/fire direction now read the FORM byte.
2. **Familiar marking** on ops 90-93 children (flags bit 8, side bit 11 =
   form, manager list 0/2, contact cleared BEFORE the child's synchronous
   t0 core so its FIRE(16) re-arms, sfx 36 se_option, parent link). The
   FIRE bit-6/bit-2 writes now bridge onto shotCollision/collisionEnabled.
3. **Per-tick side sync** FUN_0042c420: transition flashes (etama 59 red
   →human / 60 blue →youkai with the native ARGB colors), marker VM
   (etama 48) interrupt 1/2, sfx 39/40, list relink; marker attached
   lazily with a follow actor.
4. **Tangibility gates**: damageEnemy skips ethereal familiars (covers
   shots, attack slots, the bomb host); collideEnemyBody skips familiars
   entirely for the Border Team (Reimu's special skill, FUN_0042c290 @
   21101 with FUN_0041fd20 = is-familiar) and ethereal familiars for
   everyone.
5. **Ghost tint**: VM color1 decode (enemy+0x200..3 = B,G,R,A; ghost =
   R=G=0x20, B base, A/2) drawn as rgb 0x2020ff @ alpha 0.5 (channel
   order flagged).
6. **ECL form-rank gate** (all.c:10801): familiar instruction masks must
   contain the form bit (0x20/0x40). Stage-1 census: only one authored
   0x5f row (Sub42) — inert for non-familiars.
7. **op 184 fix**: receiver is the GLOBAL singleton 0x4ea670 bit 11, not
   the enemy — recorded on Th08RunState.th08SideMirror (consumers
   unwired, flagged).
8. **Deaths**: familiar kill → marker interrupt 3; master death sweep →
   children silent-killed (mode 8, enep00 pop, links cleared) + the
   time-orb shower (2N scattered with exact RNG draw order + a 16-orb
   burst, the FUN_0044df00 pool part flagged).
9. **SFX table rebuilt** as the real 46-channel id table (.data 0x4c8040
   {srcBank, volA} over the 36-file 0x4c81b0 table; gains 10^(volA/2000)).
   This fixed the whole id≥2 mapping: miss=4(pldead00), graze=30,
   item=21, damage=20, extend=28, powerup=31, pause=34, bomb cast=13
   (gun00), declaration=14 (cat00), and resolved the old "+2 bank-site"
   kill-sfx flag (ids 2/3 are enep00's two volume slots, matching TH07).
10. **Bomb visuals**: bombardment orb VMs (slot 16/17, script 0x14) now
    spawn AT THE TARGET with the sync loop covering them; effectVm's
    scale/color host params are applied (the burst flash's 8x magnitude,
    the cast flash color) instead of being void-dropped.

Verification: check/build clean; 409/410 tests (8 new familiar tests + 1
bombardment test); replay:verify 6/6 PASS (TH07 golden untouched); clean
headless boot; full-stage familiar sweep with zero page errors — Sub19/20
(Wriggle, ~f3600) and the boss's 6-familiar waves (~f4025+) live, side
flips verified in both directions by live probe (form byte + all
familiars' sideBit + managerList). replay:verify:th08 unchanged
DIVERGED (the phantom-death cascade predates this; kills 144→122 with
the gating = the replay player was youkai-side during familiar phases,
so those kills were wrongly credited before). Ghost-tint pixel diff is
inconclusive (frame drift between A/B captures) — the tint is verified
structurally; a frozen-frame A/B would pin it visually.

## 2026-08-19 (later): 节奏/收敛 pass — 7e142c6 / c161589 / 7232e34

用户报告：Boss战节奏崩坏 + 道中对话期间小怪仍在攻击 + 要求静态逆向完成
Stage 1 replay 收敛。三个 exe 实证根因（两项推翻/修正了 08-17 的结论）：

1. **时间线 hold 净冻结时钟**（7e142c6）：op 7/10/13 先 FUN_00418110
   Subtract(1) 再 goto Tick(+1) —— 净零。08-17 的"时钟推进"读法漏了
   Subtract，把两 hold 之间的所有 op 压缩掉了：midboss 死后波次（t=2935..
   3735，从死亡时刻起播）瞬间齐发、boss 提前 ~1240 帧出现。ECL 解码佐证：
   #124 op10 停在 2935 → 波次从释放点播 800 帧 → t=4175 op6 对话 → 释放后
   立即 spawn boss。AGENTS/HANDOFF 的旧结论已撤回。
2. **对话开始清场**（c161589）：FUN_0043396d 尾部三调用 ——
   FUN_00415c60（弹→时计玉+laser 取消）、FUN_0042efb0(0,0)（普通敌清扫，
   hp=0 走死亡路径，豁免 flags1 bit1/flags2 bit6，cap=0）、FUN_004413e0
   （自机弹无害上漂 (0,−0.5)，每 MSG 帧重申；仅死亡/决死重置）。原生不
   force-collect、玩家可动、背景照常滚 —— 只清场上实体。我们的
   forceCollectAllItems 是发明的，已删；敌机清扫此前缺失（"对话中被小怪
   打死"的根因）。killNonBossEnemies 增加 valueCap 参数镜像 (0,0) 调用。
3. **弹幕过渡积分**（7232e34）：state 2/3/4 分步速度 = ½/¼/⅛（0x431240
   立即数 0x40000000/0x40200000/0x40400000；此前沿用 TH07 的 ½,1/2.5,⅓）；
   过渡跨 duration+2 个管理 tick（FUN_0045e430 构造无同步 t0 消化 +
   终止指令后一 tick 才报完成）。+2 parity 由录像实证钉死（f530 环的穿越
   带只在 +2 清空 f685 幻影死亡；0/+1 均残留）。autofire 重执行炮口取
   +0x2d88 循环头快照+炮口偏移（Th08EclState.loopHeadX/Y）。

顺带一手核实的事实（防后人重查）：mode-3 = row·spread+base+col·2π/count1
（无 π/count1 相位、无瞄准）；sprite-2 米弹命中尺寸 = 4.0（AddedCallback
0x40800000 档）；机炮链 ins_107/96/108 + ins_105 读时间线 spawn 写入的
var 10000=30 → rank8 期限 33、每 33 tick 连发；f545 前 rank 恒 8；
T8RP stage1 = 10504×u16（trailer 352=1+ceil(10504/30) 实证；
re-specs/th08-replay.md 里"5245×u32/0x40 头"是旧读法，勿信）。

收敛现状：f685 死亡清除；首个分歧移至 f830 机炮族（row-3 速 1.5667 弹，
玩家骑线 dy=0.48；开火相位 ±1 tick 与 −2 均仍命中——需要 ~2 tick 前置，
机制未定位）；其余死亡为级联。无敌直通下 midboss 活到出现后 1444 帧，
其后全部内容整体后移；道具经济偏薄（point 生成 47 vs 原生收集 61，
无敌下收集 36/power96/score158万）。下一步线索：每杀掉落表/数量、
以及（有 wine 环境时）逐帧原生 trace。

验证：check/build 干净；409/410 测试过；TH07 replay:verify 6/6（全程未动
TH07 路径）；dev-shot 无 PAGE ERRORS。replay:verify:th08 仍 DIVERGED
（如实：收敛未完成，残差见上）。

## 2026-08-19（二）——f829 根因落定 + 全面去 TH07 化 + 收敛推进

### 收敛（静态逆向,无 wine 动态调试）

**f829 机炮幻影接触的根因:TH08_OP_REMAP 的 `66: 54`。** TH08 原始 op 66
（dispatcher label 0x41,all.c:11530-11562）不是 TH07 op54 定时移动:
arg0<1 = label-0x40 速度写入;arg0≥1 = FUN_00420d10 武装态（总位移向量
dir·speed·anmId 入 +0x2dc4、原点快照入 var 10058-60 bank、停止计时器
+0x2de8=anmId、flags 0x2000|spriteOffset<<14）。旧 remap 把 Sub1 的
ins_66(60,4,π/2,3.2) 当作 (duration=60, mode=4) 移动执行,机炮妖精被
幻影位移 61px,f796 齐射因此打中玩家。删除 remap 后 f829 接触消失。

**creep 因子修正**:0x431240 四处 FUN_0040c7d0 调用的 k 为
2.0/2.5/3.0/2.0（0x43177e/0x431890/0x4319a1/0x431aa2;FUN_0040c7d0 =
vel×(1.0/k),fld 1.0 fdiv k）——TH07 的 ½, 1/2.5, ⅓ 原样沿用;此前的
¼,⅛ 是浮点位型误读。修正后 parity 重钉:0/1 会复现 f684/685 接触,2 仍最优。

**ins_66 武装消费者未恢复**（本会话明确尝试并排除:线性 dir·speed·anmId
帧移动 → 更早的 f634 接触;瞬移总向量 → 复现 f829。当前武装分支为有记录的
no-op,妖精停留在时间轴出生位 (320,−32) 后 t=180 起 π/8·0.7 镜像漂移——
实证最优变体）。恢复消费者是 f873（现首分歧,f796 齐射弹被玩家上移撞上）
及后续 611 族接触的钥匙。

**其余静态确认**（全部与端口一致,免再查）:自动机枪原点 = render pos
(+0x2d88 = 活动位 +0x2d34 + 基准位 +0x2d40,普通敌基准为 0) + 枪口偏移
(+0x2db8,ins_110);瞄准 = atan2(玩家镜像 0x17d61ac/0x17d61b0 − 模板原点),
每齐射一次;TH08 spawn-state 弹**确实**回退 4×速度向量（0x42fc4c-0x42fc6d:
pos −= vel×4.0,此前怀疑不成立——上一节的"枪口低 5px/瞄准左偏 4px"就是
这个回退的分量,并非错误）;行速插值 speed1−(speed1−speed2)·row/count2;
op105/106 相位抽取 FUN_00406ef0=u32%deadline,u32 合成 hi<<16|lo 与端口一致;
全局速度乘子 DAT_017ce8e0=1.0;firefly（etama 脚本 73）每粒 10 抽
（5 个随机 op×2,Global.hpp GetRandomU32=2×u16 确认）;RNG 早期流干净
（同种子同抽数→同值）,超支 ~15.5k 抽全部在首死级联之后（对话期生成器
仍在跑是级联产物）。

**去 TH07 化**（本分支正式决策,见 AGENTS §0 新检查点）:TH07 路径/模块/
数据/资产/测试/脚本/CI 全部移除;`npm test` 仅 th08-*+engine-*;
`__TH07_TEST__`→`__TH08_TEST__`;fixture th8_udLy01.rpy 入库 tests/replays/。
TH07 引擎行为回归网由 replay:verify:th08 + th08 测试承担。

**原生工具现状**:wine 纯启动可行（标题 demo 会自动播 demorpy0,截图验证
到 f700+）,但 winedbg --gdb 下游戏早死、gdb 无法解析 wine ELF、
ptrace_scope=1 且无 CAP_SYS_PTRACE → 逐帧原生 trace 在本环境仍不可行;
scripts/native-trace.mjs 已重写（去 RNG 断点 + 异常穿通 + P/V/B/S 事件）,
留待有权限的宿主。reference/native-shots 的 userdemo 系列只覆盖到 ~f780。

### 当前验证状态（如实）

- check/build/test（105 过）绿;dev-shot 干净启动。
- replay:verify:th08 仍 DIVERGED:首意外死 f873（was f829）;
  score 690229/7376015、pointItems 14/61、graze 123/536、lives −1/6、
  RNG 113890 vs ≡32816。收敛未完成;下一钥匙 = ins_66 武装消费者
  （影响 611 族全部齐射几何）。

## 2026-08-19（三）——链序根因:首分歧推进到 f3952

**第三个根因:TH08 calc chain 降序执行**(提交 11a420f)。RegisterChain
优先级 player=9(0x44c2ef)/EnemyManager=11(0x42c5d7)/BulletManager=14
(0x4311f0),链按**降序**跑:弹→敌→玩家。敌人 FIRE 读的 GameManager 玩家
镜像(0x17d61ac)因此是**帧首快照**——每发瞄准弹按玩家上一帧结束位置计算。
对准活位置产生随飞行距离增长的幻影接触(f2182:300px 处 1.4px;f3259 族同),
一帧镜像整族清除。同一序向也解释 spawn-state 的 +2 parity(敌人 pass 生成的
弹要到下一帧的弹 pass 才首次 tick)。

**ins_65/ins_66 语义修正**(提交 08f7169):全 .text 扫描证明 +0x2d94/
+0x2da0 无任何移动器读取(仅 var 访问器 0x41f9b0/0x42067f)——两 op 都是
var 记账;敌人静止在时间轴出生位。机枪族(611、3513 同模板)接触全消。

会话累计收敛轨迹:**f829 → f873 → f2182 → f3952**;score 441k → 1,048,449;
pointItems 8 → 27;lives −1 → 4(玩家存活到 boss 段);bombs/extends/
nextExtend 三字段 exact。

**下一钥匙**(按序):
1. f3952:boss 段大弹(sprite 7,flags 0 无 spawn 态,114 tick 长飞,dy 差
   1.9px 进箱)——同"长飞 grazing"类,查 owner 5746/15(boss 相位)的齐射
   几何与计时。
2. graze 64 vs 536 双重缺口:(a) 步进惯例——原生每事件 +1..+3
   (FUN_00406d10/d40 读 manager 阈值 u16 +0x3ddfc/+0x3de00,两谓词均无
   .text 写入者,阈值疑似 0 ⇒ Lunatic 全程 +3,Lunatic 事件数≈178 与
   536=178×3 吻合,未定案);(b) 缺失弹幕(armed-fire 曲线弹未实现)。
3. ins_66 武装态(+0x2dc4 总位移/+0x2dd0 快照/+0x2ddc 计时器/flags 0x2000)
   的逐 tick 消费者仍未恢复——影响除机枪外的 ins_66 使用者与缺失弹幕。
4. rank 轨迹已对齐(survival 阶梯 lives=6 时 960 tick +1;炸弹 −200;
   miss 钳制到 8)。

验证:check/build/test(105/105)绿;replay:verify:th08 仍 DIVERGED
(f3952 首死;score 1048449/7376015、pointItems 27/61、graze 64/536、
lives 4/6)。

## 2026-08-19(四)——AddedCallback 层级定案;接触集收敛到 boss 环族

**+0x30 身份定案**(提交 14ad1c7):FUN_00433070 的 fnstsw 奇偶链
(0x43331d/0x433387)解码为对 VM+0x30 的**包含式层级**——该字段就是精灵
尺寸度量(FUN_0042fea0 用同样的 16/48 阈值选闪光时长表):v≤8→4(cat5);
8<v≤16→米弹族{2,4,5,6,106,107,108,111,112}→4、**默认 12**(cat3);
16<v≤48→{8,113-115}→5、{9,109,110}→8、默认 10;v>48→24(cat0)。
仅 type 1/3(16px 非米弹)实际变化(6→12)。

**接触集现状**:全部非 boss 接触已清,剩余两处均为 5746/15 boss 环族——
f3301(米弹,速 1.5,f3055 齐射,235 tick 长飞骑线)与 f3952(大弹,
速 2.396,f3836 齐射,114 tick)。boss 静止于 (192,144) 已验证(sub15
t=0 的 ins_64 插值入位);瞄准镜像/行速/mode-2 环角/rank 全部吻合;
全局相位 ±1 与瞄准滞后 2 帧实验均无效。两处同源,疑点集中在 boss 控制
sub 的 ins_105 装填 tick 或环的某参数细节——下一会话从 boss 控制器的
deadline 装填时序入手。

Verifier 终态(score 1,238,237、graze 159、pointItems 30、lives −1):
STAGE 1 仍 DIVERGED,如实。

## 2026-08-19(五)——f3301 族定性:EX 曲线弹

f3301 杀手(米弹,速 1.5,angle 1.3895,f3055 生,235 tick)来自 boss
5746/15 在 f3054 的 **mode-0 20×1 扇形**(s=0.644..1.844 五档、a1=1.4749、
a2=0.1963),每发带 **EX opcode 64(0x40 转向)**:arg3=40/50/60/70(转向
起始间隔)、arg4=1、f0=−π/2(目标角)、f1=2.2/2.1/2.0/1.9/1.7(角速率)。
即飞行 40-70 tick 后向 −90° 弯曲的曲线弹——f3301 接触是曲线轨迹的 grazing,
与 f3952(直线环、无 EX)是**两个不同子系统**。

下一会话:
1. f3952(直线环):boss 控制 sub 的 ins_105 装填 tick(与机枪共用 33
   cadence,疑 boss 段装填点差 1-2 tick);
2. f3301(EX 曲线):对照 TH07 已收敛的 op-0x40 转向语义(port 的
   advanceBulletExBehavior case 64)与 TH08 的 interval/速率单位——
   f1≈2.0 疑为 度/tick 而非 弧度/tick;
3. 然后 graze 步进与 ins_66 曲线弹(与 EX 曲线同属转向族)。

STAGE 1 仍 DIVERGED(score 1238237/graze 159/items 30/lives −1),如实。

## 2026-08-19(六)——重大结构发现:FUN_00422c40 运动消费者(修正此前误判)

**08f7169 的"ins_65/66 是记账不移动"结论是错的**(我的 grep 漏检):真正
的消费者是 **FUN_00422c40**(解释器尾部 0x41eca7 每 tick 调用),按
flags 位 12-13(+0x3324>>0xc & 3)分派:

- **case 1(0x1000,ins_65)**:angle(+0x2d94) += angVel(+0x2d98)·scale;
  speed(+0x2da8) += accel(+0x2dac)·scale;velocity=sincos;**无镜像翻转**;
  若停止计时器(+0x2de8)>0 则倒数,归零清位停 motion。
- **case 2(0x2000,ins_66 anmId≥1)**:计时器倒数, t = 1−elapsed/total
  (SetCurrent(anmId) 后 Subtract——elapsed 从 anmId 递减,t 从 0→1),
  经 spriteOffset&7(bits 14-16)选缓动公式(同 ANM formula 表),每 tick
  delta = (origin 快照+总位移·ease(t)) − pos(追踪式),到期落位
  origin+total、清 delta、清 motion 位。
- case 3(0x3000):+0x2d9c/2db0 速度系 + origin(+0x2dd0) 的轨道族。

实测:缓动落地实现仍带回 f828 族(机枪妖精下落+漂移期齐射仍接触);
镜像 X 翻转开/关两版都有早接触(f822/f828)——**缓动追踪的精确 f32 路径
或漂移镜像语义仍差一环**。已回退到提交态(静态妖精,f3301/f3952,
score 1238237)。下一会话从 case-2 的逐 tick delta 精确重建入手
(追踪式 delta 每帧全量施加=位置精确等于 origin+total·ease(t),与端口
mode-2 插值的 f32 累加路径不同!)。

另:runtime subId ↔ ECL 表索引非恒等(sub15↔表 idx21)——dump 时必须用
名字表映射;boss 环相位 sub = 表 idx21(t=200 首环+t=300 jump 循环)。
STAGE 1 仍 DIVERGED,如实。

## 2026-08-19(七)——追踪式缓动已核对,ins_66 仍差一环;会话收敛状态封存

核对:端口 mode-2 移动器(updateMovementController)本就是追踪式
(每 tick target=start+delta·ease(t),axisSpeed=target−pos,积分器
施加后位置精确等于 target,含 TH07 验证过的双镜像翻转与 f32 阶梯)。
因此(六)的缓动实现已是追踪语义,f828 族回归不是"累加 vs 追踪"的
差异——剩余缺口在 FUN_00420d10 的位 18 velX 取反条件、case-1 漂移的
镜像语义(两版实测 f828/f822 均脏)、或 +0x2ddc 计时器的分数
(FUN_00447421)路径。已回退;提交态(静态妖精,f3301/f3952,
score 1238237)仍为实证最优。

下一会话建议顺序(从最可判定处入手):
1. f3952 直线环:全参数已逐项吻合且对 aim/相位/尺寸均不敏感——
   考虑用"无敌直通+逐 volley 反解原生素集"做穷举判定(每个齐射的
   32 列×3 行弹的原生需要位置 vs 玩家路径全扫描,寻找系统性半像素级
   偏差源:如 f32 的 col·2π/32 累积)。
2. f3301:EX opcode-64(0x40)的 TH08 单位(f1≈2.0)对照 TH07
   FUN_004241c0 case 0x40。
3. ins_66:位 18/镜像/计时器分数三件事逐一定案后再实现。
4. graze 步进、物品级联(会随前两项自动收窄)。

STAGE 1 仍 DIVERGED(如实;score 1238237/graze 159/items 30/
lives −1/RNG DIFF)。

## 2026-08-19(八)——f3952 = f3301 级联(判定性);EX 机构核实正常

**无敌直通反解(判定性)**:在无敌玩家路径下,f3952 直线环的全部偏差
变体(列角加法序、2π 预乘、行除数 c2/c2−1、aim 滞后 ±1、开火 ±1、
角度 ±0.01)**零接触**——f3952 是 f3301 死亡后重生路径的级联!
真实首分歧仅剩 f3301 一处;清掉它,后续物品/分数/lives 应连锁收窄。

**f3301 完整取证**:杀手= f3054 第 6 组齐射(mode-0 20×1,s1 由 rank
lerp,f1=1.5、interval=70、f0=−π/2、maxTimes=1),spawn f3055;
减速段(speed·(1−elapsed/interval))、转向(angle+=f0, speed:=f1)、
一次性消费(dirTimes=1)全部按 FUN_00432460 工作——机构无误,
接触在转后直线段(speed 1.5, angle 1.3895, hit (168,385.6) f3301,
age 235)。剩余偏差源:转前 70 tick 减速段的 f32 累积路径
(native: elapsed 含分数 FUN_0040b8c0,商/积的 f32 阶梯次序)、
或第 6 组齐射的 rank-lerp 速度窗口(fireRankSpeed lo/hi 未对过表)。

下一会话(单一目标):对 f3054 第 6 组逐 tick 重建减速段
(native 公式 speed−(elapsed+frac)·speed/interval 的精确 f32 次序),
对照 TH08_BULLET_PROTOTYPES 与 ins_111/112/113 的 fireRank 窗口,
清除 f3301 → 重跑全量 verifier。

## 2026-08-19(九)——f3301 全参数自洽验证完成;剩余两候选

杀手全链路核对:第 6 组齐射(col 1,aim=1.5850[f3054 玩家静止,
mirror=live,无歧义],a1=1.47488,a2=0.19635,偶数 c1=20 的
colTerm=−0.5·a2 ✓),s1=1.8438(rank-lerp 后),EX f1=1.5/interval=70;
减速段非复合(基底速度不动)✓;一次性转向消费 ✓;公式与端口自洽。
接触 dx-limited:dx=1.839/dy=0.664 vs thr=2.825,需 +0.99px 横向分离
≈ 发射角 δ≈0.0033 rad 或等价路径差。

剩余两候选(下一会话按序):
1. **s1 的 rank-lerp 窗口**:f3054 时 rank=9(生存阶梯 f2927→9);
   端口 lerpF(−0.5,0.5)@9=+0.0625 ⇒ 基速=1.7813,而作者值疑为
   1.8/2.0 族——**ins_111/112/113 写入的 lo/hi 需对 sub 数据核表**
   (fireRankSpeedLow/High 的每个相位 sub 的设置指令)。
2. 减速段 70 tick 的 f32 积分次序(native:(elapsed+frac)·speed/interval
   的商/积阶梯;port 同式但 JS double 中间量)。

方法:对第 6 组 col-1 弹做解析路径(63.6px 减速段 + 165 tick·1.5),
在 ±0.03 速度/±0.004 rad 的参数网格上扫,找使 f3301-3304 全清的
参数组合,再回溯到 lo/hi 或积分次序。

## 2026-08-19（十）——独立发布 pass：静态 QA、advisory CI、Pages 上线

发布前静态审查（三个只读探查代理 + 人工复核）结论：**TH08 化是真实的，
无 TH07 活路径**。资产面（assets/th08-img 71 图 / audio 3 / sfx 39）、
bundle（dist/th08.js）、index.html 品牌、存储（无 localStorage，无
同源撞键风险）、运行时网络（仅本地资产 fetch）全部干净。修复清单：

- `src/game/eclvm.ts` effect-20：删除活的 `playBgmTrack('th07_13b')`
  Yuyuko 残留（Stage 1 数据不可达；TH08 原生行为未恢复 → flagged no-op）。
- `th07-latency-*` performance marks → `th08-latency-*`（latency.ts 与
  latency-probe.mjs 同步改，两侧必须一致）。
- 过时注释 ×2（audio.ts `__TH07_TEST__`、deploy-pages.mjs `dist/th07.js`）。
- favicon：复用 etama5.png（黑色圆月光球，已随 Pages 发布，无新素材）。
- package.json 补 description/homepage/repository/bugs。
- 公开前扫描：tracked 文件无密钥、无绝对宿主路径。
- 本地 24 文件 WIP（TH08 收尾锁定：eclvm 原生 dispatch、T8RP 字段面、
  ReplayTraceSink verifier）静态自洽后落盘（TH08_OP_REMAP 仅剩
  tests/.build 陈旧缓存；rpy 改名消费方全同步；cherry 全是注释）。

CI（deploy.yml）：新增 `replay` job 以 **continue-on-error** 跑
`replay:verify:th08`（advisory；输出 EARLIEST DIVERGENCE 作为收敛反馈
通道；收敛后去掉 continue-on-error 转正为 gate），pages 的 needs 含
core/browser/replay。README 补 Demo 链接/操作表/已知差距；AGENTS §0
标注独立仓库与 CI 形态。

发布：`AgentMystia/th08_web` 公开仓库，th08-vertical-slice 原样成为
main（保留全部 274 提交历史），push 触发 CI → Pages
（https://agentmystia.github.io/th08_web/）。本次会话宿主约束：
**本地零执行**（无 node/npm 验证、无浏览器、无 wine），全部动态验证
由 CI 承担——本地修改后推送，以 CI 结果为唯一动态 oracle。

收敛状态不变：f3301 首发散 + 级联，两候选（rank-lerp 窗口表
ins_111/112/113、减速段 f32 积分次序）见上条（九）；本条目后附
best-effort 静态推进的结论（若有）。

## 2026-08-19（十一）——发布收尾：收敛回归定位与回退、rank-lerp 全链取证

**移动引擎回归（已修复）**:CI advisory replay 的 A/B 归因证明 24 文件
锁定 pass 的 FUN_00422c40 移动重构（updateMovementController + ins_63-74
+ 变量 10069+ 映射整体替换）让首发散从 f3301 回退到 f998（f880 生成、
sub-3 弹；匹配帧 trace:f950 双方 87 vs 0 活弹、世界在 f850 前分岔，
玩家路径逐位一致）。处置：**只回退移动面**（mover + ins_64-74 恢复
b161dbf 行为；ins_68/69 恢复 no-op），锁定 pass 其余全部保留（raw
dispatch、T8RP 面、trace 事件、变量映射）；types.ts 补回 moveAux。
回退后 advisory 输出 **精确恢复 f3301**（ownerId 5746/sub 15/f3055
生成/speed 1.5/age 235，与条目九逐字段一致）。重构本体存档于
999b644，5 个按新引擎行为撰写的测试以 skip+指针停放（mode-1/mode-3
mover、ins_66 mode-2、ins_67 折叠、开场波 FIRE 签名基线）。

**spawn creep 误读（已修复）**:0x431240 的 (½,¼,⅛) 读法是位模式误读。
状态跳转表 @0x432156:state2→0x43176e(k=0x40000000=2.0f)、state3→
0x431880(k=0x40200000=2.5f)、state4→0x431991(k=0x40400000=3.0f)、
死亡 state5→0x431aa2(k=2.0f);FUN_0040c7d0 = pos += vel·(1.0f/k)，
1.0f @0x4b4338。正确因子 (½,0.4,⅓)。AGENTS §0 对应条目已更正。

**rank-lerp 全链取证（静态边界已到）**:
- 应用端 0x422a77-0x422b10:speed1 += lerp(lo,hi)、下限 0.3f(0x4b48d0)
  钳制;speed2 += lerp/2.0f(0x4b42ec)。端口公式/钳制/除数全部 exe 一致。
- lerp 本体 FUN_00422b80:`lo + (hi−lo)·rank/[0x4b42cc]`,rank 以整数
  从 manager(0x160f508)+0x3de2c 加载(fildl)——与端口 game.rank 同源
  假设成立。
- **op 113 全语义**(handler @0x41db0b,跳转表 entry[112]):复合开火
  配置——arg0≥0 → sfx(+0x3024)+flags 0x200(端口已实现 ✓);掩码位
  1/2 → fireRankSpeedLow/High(+0x2dec/+0x2df0 浮点写入);位 4/8/0x10
  → count1/2 lo/hi u16(+0x2df4..0x2dfa)。**Stage-1 ECL 零使用**
  (reference/ECL8/ecldata1.ecl.ecs 无 ins_113)——端口恒用默认窗口对
  Stage-1 无损。
- 双初值:±0.5(FUN_00415c80,调用点 0x415514[sub 入口族]/0x42b5fc/
  0x42bc17/0x42da6e) vs ±0.15(0x42a1b3,整池清零级初始化 0x429e00,
  同时写 sfx 默认 7)。早期几千帧收敛证明普通路径生效的是 ±0.5;
  ±0.15 存活条件未解。
- f3301 所需修正 ≈ +0.0625 速度差(HANDOFF 九:s1 1.8438 vs 1.78125),
  对应 ±0.5@rank18 或等价组合——**需要 native 在 f3054 的 rank 运行时
  值**,静态无法定夺。与"减速段 f32 积分次序"并列为剩余两候选。

下一会话:(1) 用 research 分支 × advisory replay 逐 op 二分 999b644 的
移动重构(本 pass 已验证该方法:research/pre-wip-verify 分支 +
workflow_dispatch);(2) 解 ±0.15 窗口的存活路径(0x429e00 的调用者
0x42a265/0x42c5a7 上下文);(3) 修好后删掉 eclvm 的移动面回退与 5 个
skip,重放开场波基线。

CI 状态:core(browser 前置)/browser/replay(advisory,f3301)/pages 全绿
于 https://github.com/AgentMystia/th08_web/actions;Demo =
https://agentmystia.github.io/th08_web/。

## 2026-08-19（十二）——更正（十一）的取舍：原生移动引擎恢复上线

**用户实测否决了移动面回退**:旧引擎的 ins_66 是 no-op("保持时间轴
生成位置"),而时间轴把 sub1/sub3(大蝴蝶族)生成在 **y=−32 屏幕外**,
原作正是靠 ins_65/66 的 armed 移动让它们飞进场。回退版里这批敌人
永远停在屏幕外开火、且可被玩家弹打到——可见的游戏性缺陷。
replay 的 f3301/f998 只是模拟保真度指标,不能压过用户可见行为。

处置:恢复 db058a0 的原生移动引擎(FUN_00422c40 mover + ins_63-74
native 消费者 + 变量 10069+ 映射);5 个停放测试全部恢复;moveAux
从 types 移除。**(十一)的"只回退移动面"结论作废**,其 A/B 方法与
creep/rank-lerp 取证仍然有效。当前 advisory 发散回到 **f998**
(f880 生成、sub-3 弹、速 1.1125;世界在 f850 前分岔,rngDraws +120)。

下一会话收敛入口不变,但对象改为 **WIP 引擎内部**:逐 tick 对照
native(重点 ins_66 armed 消费者的 bit-18/mirror/timer-frac 三候选,
以及 f880 附近 sub-3 齐射的 rank-lerp 窗口)——用 research 分支 ×
advisory replay 的并行二分,收敛到 ≥f3301 后再把新旧两套对齐结论
合并。

修复验证(research 分支 900 帧 browser-boot 快照,run 32254008827):
sub-1 大蝴蝶(hp 150,f500 于 (320,−32) mirrored 生成)在 f900 位于
**(177,159)** 场内——飞入恢复正常。main 全绿(run 32253759691),
Pages 已重部署为恢复版。

## 2026-08-20 —— 目标:Stage1+2 回放收敛 + Bomb/决死结界/使魔保真

**机制修复(全部 exe 证据,asm 偏移见 AGENTS.md §0 当日条目与内联注释)**:
1. **ins_2 = TH08 ECL 等待定时器**(纠正 2026-08-17 的"时钟 SetCurrent"
   误读):case 1 写 ctx+0x90 的第二个 ZunTimer,指令级 pass 头
   (0x418557-0x418598) 以它门控取指并把指令时钟净冻结。此前所有
   ins_2 等待循环首圈即死——Wriggle Sub42 使魔齐射循环
   (ins_96,ins_2,ins_96,ins_2,ins_4) 从不重发,使魔弹幕为零。
   ins_135 子上下文补上人/妖形态门禁(all.c:10801:Sub42 的 0x3f 人态
   限定 / 0x5f 妖态限定)与等待期时钟冻结。
2. **决死放雷的雷型缺 +2**(FUN_0044c650,all.c:37720-37742):type =
   形态字节,决死时先 `1-type` 再 `+2`。此前决死跑的是普通翻面雷
   (错误的机台/时长/gauge 分母/符卡宣言)。现为 `3-base`。
3. **死亡白闪归位**:决死窗口(state 2)原作无白屏;白屏属于 miss
   (FUN_0044d180 于 commit 充能 player+0xe2a70=60 并随 squish 每帧
   重置,FUN_0044d2c0 逐帧画 768x896 全白 quad)。此前 port 在窗口期
   以 50% 隔帧白闪——状态、节奏、alpha 全错。
4. **var 10096** = 使魔链主的存活子数(FUN_0041f000/41fd40 的 +8 链);
   **ins_145(n)** = 指令时钟 Add(n)(asm 0x41d5df);**ins_152** =
   舞台插值模板复位(数据全零,消费端未建模,§7 登记)。
5. **Bomb 宣言** 增加压暗背板(capture.anm '@' 运行时纹理不可复现,
   §7 登记为近似)。

**验证器与 Stage 2**:`replay-verify-th08.mjs --stage N` 支持任意关卡
(入口 score 同时落 scene.score 与 runState.score);Stage 2 数据
(ecldata2/stage2.std/stg2*/eff02/face_st02/msg2a) 已嵌入并直接运行,
最早发散 **f1168**(与 Stage 1 的 f997 同属 auto-fire 齐射族残差)。
夜钟推进改读 DAT_004c77f0 quota 表(FUN_0043c35f:+1 达标/+2 未达);
HUD Time 行同步换表;RunCarry 增加 runState 字段(clockTime/gauge/
pointItem 阶梯) 的跨关往返。

**Stage Intro 时刻牌**:times.anm script 0(开场模板 (256,268),t=240
淡出),sprite 槽 = runState.clockTime(T8RP +0x22;0=子の刻 pm11:00,
1=子の二つ pm11:30…12=夜明け),首个 stage tick 时按入场快照挂载。

**原生管线(本机 wine 10.0 + Xvfb,无浏览器)**:标题 demo 按 BASENAME
从 th08.dat 读 demorpyN(FUN_0043e660→FUN_00474c40),loose demo/ 完全
无效——自定义场景必须用 thtk `thdat -c 8` 重打包;T8RP 验收校验和
FUN_00451d90:u32@+0x10 = 0x3f000318 + sum(解密后 [0x15..rawFileSize)),
LZSS 需要零匹配终止符;demo 播放首个非零 stage 槽位。断点追踪在本机
不可行(winedbg 直接启动 OOM;attach 可成但软/硬断点都令游戏
0xC0000005 自毁——疑似 .text 完整性自检)。

**回放探针证实的残差**(f997/f1168):auto-fire 齐射族子弹,我方比原生
沿轨迹多飞约 2-4 帧(原生玩家下移 8px 仍存活,我方 1.3px 命中)。根因
(齐射相位/creep/模板原点) 无原生 slot trace 不可定,列为悬置残差。

**当前门禁**:npm run check/build/test 全绿(130 测试);replay:verify
Stage 1 最早发散 f997、Stage 2 f1168(均单个 phantom hit,diagnostic
各 7 个)。
