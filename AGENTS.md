# AGENTS.md

Operating manual for AI agents. Every rule was earned by a real defect.
Provenance lives in code comments, git history and `tmp/gx-findings.md` —
this file keeps only what changes decisions going forward.

## 0. Identity and hard rules

Repo **AgentMystia/th08_web**: TypeScript/browser reimplementation of
Touhou 08 ~ Imperishable Night driven by original data. Scope: Stage 1+2,
Reimu/Yukari Border Team, original menus/UI, browser replay load & play.
Convergence oracles: `tests/replays/th8_udLy01.rpy` (FULL run) and
`tests/replays/th8_udGx01.rpy` (both stages native No-Miss).

Authority: user instruction > this file > Th08.exe v1.00d + decompile
`reference/re-specs/th08-re-tools-export/all.c` > existing code > external
docs. TH06/TH07 semantics are NOT TH08 semantics.

- Wine/ptrace tracing is CLOSED by default (user decision 2026-08-24);
  reopened only by direct user order for a round. Until then answer native
  questions from decompile + .rdata + objdump. Section maps: .text RVA
  0x2000 → file 0x1e00 (in .text VA = file + 0x200); .rdata VA 0xb4000 →
  file 0xb3a00; PE section table at PE+24+optsize.
- Host stays clean: node/tests via `tmp/podman-node/run.sh <npm args>` or
  `podman exec th08dev`. Visual checks via podman playwright image.
- Nothing under `reference/` or `replay/` ships or is committed.
- No isolation hacks: no debug early-returns, no commented-out subsystems,
  no hardcoded test state, no per-phase clamps / RNG special cases to
  "fix" replay divergence. Hand-written behavior = last resort + §7 flag.
- Approved modernizations only: focus-hitbox dot, dev tooling (`?test=1`),
  Web Audio BGM loop points, plain-text menu hints, 60-frame fly-in,
  desync-canvas presentation (`?desync=0` / `?backbuffer=1` kill switches).
- `index.html` stays static (esbuild IIFE bundle).

CI: core (check/build/test) + browser gate Pages; replay job advisory.

## 1. Verification loop — the only definition of progress

Every commit: `npm run check` + `npm run build` clean, `npm test` green.
Simulation changes: run the verifier, record the movement honestly.

`npx tsx scripts/replay-verify-th08.mjs <rpy> [--stage N] [--clear-check]`
- **Formal** (default): real death path, stops at first unexpected hit →
  `EARLIEST DIVERGENCE`. THE metric; the only authoritative one
  (clear-check invulnerability hides contacts by construction).
- **--clear-check**: plays to clear, diffs end state vs next stage entry
  snapshot. End-state diffs downstream of the first phantom are cascade
  noise, not independent defects.
- RNG budget oracles (LFSR walk mod 65536 from fixture seeds): udLy01
  st1 ≡ 32816, st2 ≡ 63672; udGx01 st1 ≡ 864, st2 ≡ 22674.
- Native ground truth: `tmp/fa-native-gx/` (rng-curve / runstate / census
  jsonl, /proc census of udGx01 st1-2) + `tmp/wine-out/*.jsonl` (full-pool
  bullet/item telemetry; wine-bulcensus.mjs recipe). CAVEAT: census
  "bullets" counts only slots 0-95 (allocator-pointer artifact — never use
  as a bullet oracle); census/wine rows are mid-pass samples (±1-frame
  ambiguity on death/wipe rows). Alignment: **native counter f ==
  port state after input f−1**; duplicate census rows per frame = slowdown
  telemetry (dedupe, keep last). runstate blob +0x20 (i16) = gauge,
  RUN+0x0 = score (anchor-verified end 7,639,149).
- Colliders (keep them working): `tmp/parity*.mjs` draw counts,
  `tmp/goffset.mjs` gauge curve, `tmp/win*.mjs` window deltas.
- Sub-30-FPS slowdown records are still simulated one-per-counter —
  skipping them rerolls auto-fire deadlines (false divergence).
- Task report contract: files changed, evidence basis, exact-or-approximate,
  verification actually run, remaining gaps. Unverified = unverified.

## 2. Format facts (do not re-derive)

- **T8RP**: 0x68 header; stage block {0x24 metadata, N×u16 inputs}; v6 has
  NO per-frame aux word; playback strides 2 (FUN_00452550). Validator
  u32@+0x10 = 0x3f000318 + sum(decrypted[0x15..]). Seed u16@+0x1a, rank
  @+0x25 (FUN_00453be0).
- **ECL v8**: leading 0x800; instr {u32 time, u16 id, u16 size, u16
  rank<<8|hi, u16 paramMask}; dispatcher FUN_004184b0 with **exe case =
  on-disk id − 1**. Locals: int 10000-03/10012-15, float 10004-11; rand
  params 10029-10036; run-global float bank 10061-10068 (real shared bus
  copied through CALL frames); 10056 derived rand, 10060 random angle.
  Spell names (op 90) XOR-0xAA Shift-JIS.
- **ANM v3**: 64-byte entries; instr {u16 op, u16 len, i16 time, u16
  paramMask}; exe case = on-disk op + 1 (FUN_0045ea00). Random ops only
  59/60. Multi-entry files reuse on-disk ids — resolve entry-scoped.
- **SHT**: 56-byte header + records; per-form item move rate SHT+0x34;
  Border Team 18-frame deathbomb window; 20-frame shot cycle.
- **MSG**: text XOR 0x77; op15 SetSprite ORDINALS; op4 confirm is LEVEL
  (Z held) once gui+0x21830 arm passes (6 load / 30 timeout / 8 confirm);
  Ctrl skip bypasses bodies.
- Playfield (32,16,384×448); ANM HUD coords are top-left (op22) vs
  entity-center — convert at call site.

## 3. Engine facts (exe-pinned; full provenance in code comments)

**Bullets** (mgr 0xf54e90; 0x600 slots × 0x10b8; iterate 0,1535..1 —
native allocates from the TOP, count the whole pool in probes): state
+0xdb8 (0 free / 1 normal / 2-4 spawn-transition / 5 dying), pos +0xd44,
hit AABB +0xd34, timer +0xda8, cmd flags +0xdac, vel +0xd50, heading
+0xd74, base speed +0xd68, prototype +0x224, grazed latch +0xdbd.
Spawn states move fractionally (½, 0.4, ⅓ via FUN_0040c7d0) and on
spawn-ANM-done write state=1 at 0x431106 then FALL THROUGH the full
case-1 body SAME tick (queue pass 0x431122, et_ex, full move, collision).
Construction zeroes live cmd flags; behaviors arm ONLY via ins_111 queue
records (+0xdd0); FIRE flags select spawn state / sfx only. et_ex
dir-change (machine-pinned): 0x40 → angle += f0 relative, 0x100 →
angle = f0 absolute, 0x80 → aimed (+π/2 zero vector); waiting branch
sawtooths speed = base·(1 − t/interval) every tick; speed ramp bit 1 =
polar(angle, spawn + 5·(1 − t/16)) for 17 ticks. ins_111 opcode
0x20000 (FUN_0042ffc0) ORs into +0xdac and RETURNS — the walk must not
continue into 0x40000 fade-kill (state 5 at +0xdb8) on the construction
pass; the +0xdac handler XOR-clears the bit when the command timer
elapses. Graze: once per bullet,
age>15, box = AABB/2 + 20 vs player graze rect, tiers +1/+2/+3 by gauge
depth, form-gated. FIRE count1=0 fires NOTHING (authored shutdown);
ring speed(j) = speed1 − (speed1−speed2)·j/count2 (FUN_0042f5f0).
Fire-rank speed bounds (pass 20, exe-pinned): fresh enemy ±0.15
(FUN_00429e00, also run on the manager record); the 0x84-dword
default-template copy (DAT_0057ad44 = mgr 0x577f20+0x2e24 →
enemy+0x2e24) covers +0x2dec/+0x2df0, so FUN_00415c80's ±0.5 survives
ONLY where it runs after the copy — timeout phase (FUN_0042b930);
HP-threshold phase (FUN_0042b490) and death-callback (FUN_0042c660)
net ±0.15; the spell declare (FUN_004152a0, ecx=*(enemy+4) = manager
link @0x415511) flips the MANAGER DEFAULT to ±0.5 (later phase copies
restore ±0.5); ins_152 (exe 0x97) authors the pair directly (st2 uses
[0,0] 7x). Bullet AABB +0xd34 = the prototype tier value {4,5,6,8,10,24},
copied at spawn (all.c:22774) and swapped by the 0x4000 prototype
rewrite; size thresholds 8/16/32 (.rdata 0x4b4300/0x4b42d4/0x4b42cc).

**ECL**: ins_2 = TH08 wait (clock gate ctx+0x90); timeline holds (ops
7/10/13) net-freeze the clock, dispatcher fires on exact match. Death
mode = flags bits 20-22 (ins_129; 0xff8fffff clears only those). ins_
127 registers the boss slot AND sets +0x3324 bit1 — that bit is the
death-wipe tail gate, NOT ins_83's +0x3328 bit1 (effect bit). ins_
131/133/134 = phase HP pool/thresholds/timer; a phase jump frees all
ins_135 sub-contexts and resets the FIRE template. ins_135 sub-contexts
carry private stacks/vars/interp slots. Auto-fire 105/106: value·rank-lerp
deadline, ins_106 draws u32%deadline, runs on own ZunTimer +0x3064 that
advances through ins_2 waits, resolving through the CAPTURING context.
Familiars: human form materializes (bit11=0 solid), youkai etherealizes;
per-tick side sync FUN_0042c420; ins_80/81 mask 0x20 writes +0x3328 bit6
(death exemption — controllers like Sub14 survive boss entries). Master
death sweep FUN_0042adb0(1): per-child kill quad (param6 = 7 if master
+0x3324 bit1 else 9) + tier orbs n<8 ? n*2+10 : 26 (state 3, radius
frand·2n), child drop = pointSmall; master tail = +0x3380 attach ledger
×2 orbs (state arg 1) + own quad. Ledger: +1 per child-spawn op
(12044/12075/12114), −1 per normal-path child death (21629). Quad
bullet→item conversion (all.c:23597-23651 and case-3/4 twins):
param6==9 → TWO type-7 items; other >−1 → ONE of that type; state arg 1
(FUN_004400a0 forces time items to their toss state internally; 7→state3,
10→state5; state 2 = 288×192 scatter tween — asm 0x440256 push $0x43900000=288.0f, the old 304 was a misread).
**op-75 rect clamp** (pinned 2026-08-29 pass 11): ins_75 writes the rect
+0x3340..+0x334c and arms flags bit 19; FUN_0042c180 then clamps the
enemy's OWN logical position (+0x2d34/+0x2d38 — FUN_0040b460 is an
identity accessor, NOT a player clamp) into the rect EVERY manager pass,
sandwiching the movement integrator (all.c:21347-21349), and again after
every ins_63 setPos (case 0x3e). The ins_64 displacement base (loopHead)
stays UNclamped, so a tween over the ceiling rides it: Sub22's
ins_64(90,4,192,144) pins the st1 midboss at exactly y=128.000 (census
f3352+) while x tweens free. All st1/st2 boss phases arm the same rect
(32,48,352,128); ins_76 clears only the bit.

**Items** (mgr global 0x1653648; pool 0x831 slots × stride 0x2e4, scan
0..0x82f rotating next-fit; struct = embedded ANM VM in the first 0x2a4
bytes — hence the binary-wide 0x2a4 VM stride — then pos +0x2a4, vel
+0x2b0, type +0x2d4, state +0x2d7 (0 fall / 1 seek / 2 tween / 3 toss /
5 point-toss), timer +0x2c8, next +0x2dc; active list is TAIL-linked at
spawn → walk iteration is SPAWN order, not slot order). Walk FUN_00440500
(pinned 2026-08-29 pass 10): integration pos += vel×(SHT@0x34·rate) via
dropped-this vector helpers at 0x440936 (the "+0x2a4 writer" hunt is
closed — it is the walk itself). Collect box: item pos ± SHT@0x18/2 vs
player grab AABB (init all.c:38182: +0x3f0 = SHT@0x18/2) — both halves
itemRadius/2 (Border 24.0, ply00a.sht @24), inclusive, z ignored; gate =
player state ∈ {0,3,4} (FUN_0044a5a0). PoC arm: player above line AND
(power ≥ 128 [0x4b5b30 is a DOUBLE 128.0, fild+fcomp QWORD] OR player+3
raw-focus ≠ 0 OR mode 1/6). Cull: strictly beyond camera+16 (equality
frame survives + gravity), rank −3. Gravity 0.03×moveRate (0x4b44c0),
terminal vy 3.0 (0x4b42dc), rise clamp −2.2 (0x4b5b2c). State 3 vs 5 are
TWO laws: 3 = 0.05×global + single moveRate integration + 0.03 tail +
no-collect while state==3; 5 = integrate BEFORE the crest test, non-crest
frames NO tail and NO collect test, crest frame double-integrates then
pays the tail (state 3's `FUN_004066a0(0)` timer flip is dead — acc<0).
Dead-player override (state 2 = hitState or squish, NOT materialize):
state 3 every frame, state 5 only inside the crest arm; vel (0,−0.7,0).

**Death settle** (FUN_0041ed50 shared tail, all.c:21659-21668): a dying
enemy with +0x3324 bit1 set and bit0 clear converts every live bullet to
a point item (chip 2000, +20 each, cap 8000) then surviving non-exempt
enemies (+30) — FUN_00430aa0/0042efb0, ZERO RNG. BONUS floater shows the
raw pre-division total.

**Gauge** (player update 0x44bdf0 block, objdump-pinned 2026-08-28):
fire drift = trunc(timer/15) while timer ≤ 300 (fnstsw test 0x41 covers
C0|C3 — equality divides), cap 21 above; direction = RAW focus byte
(player+3), not the form byte. Idle drift (cycle disarmed ≥30): youkai
≥+8000→−5, ≥+2000→−3, ≥1→−2; human mirror +5/+3/+2. A youkai-ward form
flip parks the shot-idle timer at 30 through the +0xfdc bomb gate —
mid-bomb flips never park (the park write itself sits in the
un-decompiled 0x4E4xx shot-cycle region; §7-flagged model, dual-oracle
verified). Hard checkpoints: ly st2 f1237 ≡ −1002, f1276 ≡ −2513.

**RNG**: u16 LFSR 0x164d520, u32 counter 0x164d524. Prices: u16 1;
u32/rand01/signed/%range 2. ANM random ops 2 each at arm. Effect spawn
costs = EFFECT_DRAW_COST table (2×(59+60 ops) + init callback draws).
Effect-62 option afterimages (12 VMs every 3rd tick past counter 699)
hold the 512-slot pool at ~280 and throttle effect-51 fireflies — pool
pressure is load-bearing. Effect-51 firefly (0x426295-0x426366, pinned
2026-08-28 pass 5): spawn center = camera + facing/2 + (signed60,
signed100−50, rand100−100) — the view-ray midpoint (A = vec 0x4ea3d0 =
raw facing track, B = 0x4ea3c4 = eye; divisor 2.0 @ 0x4b42ec, −50 @
0x4b4530, −100 @ 0x4b4980, all .rdata); cone test dot(normalize(pos−B),
0x4ea3e8 unit axis) ≥ 0.94 — exe-exact chain (pass 11): D3DX normalize
(length ONE f32 round, per-component f32 divide), dot = single fround of
the exact product sum; fcomp 0x3f70a3d7 + fnstsw/test $5 + **jp (PF)**:
only the ORDERED below-threshold result releases — equality keeps and
**NaN KEEPS** (C2=1 → PF=1 → keep path; the old "NaN releases" was
backwards), ~25% die at
spawn, rest reach the authored 241. Allocator FUN_00425430 = PARTIAL
allocation over a 0x200 rolling scan; an init callback returning
nonzero frees the slot same-frame (only FUN_004272e0 returns a
condition — ids 35+, unused in stages 1-2). Item spawns draw only for
param_4 ∈ {2,3,5}; time-orb type gives up after the FIRST occupied
probe. time-orb collect pays a 4-u16 integrity checksum (FUN_00418220
→ FUN_00406e50). Player shot-cycle ARM (FUN_0043a930) runs in the
player's MAIN callback BEFORE the option actor's FUN_0044e770: on arm
ticks the option must see the armed fireFrame, or its fall-through
clear of DAT_018b89b4 eats the same tick's beh1 SHT aim target.

**Player/economy**: per-enemy timeOrb accumulator inits at 40
(DAT_018b8a24) — same value is the threshold; FUN_00451670 repays before
adding min(raw,50). preDeadCount = bombs·6 (+7 with quota), caps 15/30,
team ×9/5; deathbomb type = 3−form. Miss white-out = opaque 768×896 fill
during +0xe2a70; death drops = state-2 tween spawns. Point value full
above PoC, linear decay below. Gauge clocks +0xe2ad0 (idle) / +0xe2ae8
(fire ramp, PRE-tick read).

**Addresses**: player 0x17d5ef8 (collision center +0x2b4, AABB +0x38c,
hitbox +0x3d4, graze +0x3a4); enemy mgr 0x577f20 (stride 0x53d0, live pos
+0x2d88 = origin +0x2d40 + logical +0x2d34, hp +0x2dfc, flags +0x3324,
flags2 +0x3328, parent +0x2da4, attach ledger +0x3380, ECL ctx +0x2ca0);
RNG 0x164d520/4; RUN 0x160f510 (score +0x0, gauge +0x20 i16); sfx id
table 0x4c8040 (46ch) over name table 0x4c81b0; stage×difficulty time
quota DAT_004c77f0; effect map DAT_004c6d30 (ARCHIVE script indices,
resolve through file-order enumeration).

## 4. Workflow discipline

- Fix roots, not symptoms — the worst regressions shipped in changes that
  compiled fine. Done = a verifier/census number moved (or provably could
  not) AND the honest result is recorded.
- When a replay number "improves" after a semantics change, re-verify the
  SEMANTICS against the binary first — wrong semantics re-roll the contact
  lottery and fake progress (2026-08-26 Cursor-PR case; 2026-08-28 WIP
  audit case: seven uncommitted "improvements" were exe-wrong).
- Verify on Lunatic (rank masks gate spawns).
- Presentation changes need a real-browser eyeball (podman playwright);
  headless screenshots cannot prove scanout behavior.
- Effect-pool pressure changes re-roll gameplay RNG — treat particle
  lifetime/allocation edits as simulation changes.
- Clear-check tally confirm needs a rising shoot edge; post-recording
  idling inflates frame counts there (~1800f) — pacing conclusions only
  from formal mode.

## 5. Tests

`tests/th08-*.test.mjs` + `tests/engine-*.test.mjs` (225). Key surfaces:
et_ex dir semantics, sub-context CALL channel, boss audits/presentation,
item/damage economy, familiar cadence, pacing hard checkpoints (native
gauge/seed pins at st2 f1237/f1276 — keep or consciously regenerate).
6 browser-only skips. The boss-audit pre-seeds the Last-Spell orb quota
(structural assertion, decoupled from the razor-edge economy).

## 6. Standing residuals (honest, 2026-08-30 pass 28)

- CLOSED pass 20: **the pass-19 "op-158 attack-controller" wall was a
  triple misattribution** — op-158 is the LASER-slot instruction (exe
  case 0x9d, FUN_004230e0/110; the port's case 158 was already right);
  the toggle callbacks FUN_00424a20/00424c40 live in the PTR_FUN_004c6cb0
  tick table reachable only via ins 136/137 (exe 0x87/0x88) or effects
  12/14 — NONE used in st1/st2; live +0xd34 ∈ {4,5,6,8,10,24} always
  (spawn copy all.c:22774; the 0x4000 prototype swap replaces it
  wholesale; FUN_00462ff0 is the sprite-quad DRAW, not an AABB writer —
  the "32px/16.1px witness" was inference, not observation).
- CLOSED pass 20: **the fire-rank speed-bounds law (THE real f3731
  wall)** — FUN_00415c80 (±0.5) has four callers whose ORDER decides
  survival against the 0x84-dword default-template copy
  DAT_0057ad44→enemy+0x2e24 (covers +0x2dec/+0x2df0): HP-threshold
  phase jump FUN_0042b490 re-arms then copies → ±0.15; timeout
  FUN_0042b930 copies then re-arms → ±0.5; death-callback FUN_0042c660
  re-arms then copies → ±0.15; spell declare FUN_004152a0 re-arms with
  ecx = *(enemy+4) = the MANAGER link (asm 0x415511) — it flips the
  manager default record itself (0x577f20+0x2e24 = DAT_0057ad44,
  initialized ±0.15 by FUN_00429e00 at all.c:21200), so every LATER
  phase copy restores ±0.5 while the declaring enemy keeps its current
  bounds. Port now models managerFireRankSpeed{Low,High} + per-path
  order. Lattice proof: the gx st1 midboss ring volley fires at
  3.0+lerpF(±0.15, rank 12)=2.9625 — unreachable on the ±0.5 lattice.
  Also fixed the tier misread: size thresholds are 8/16/32 (.rdata
  0x4b4300/0x4b42d4/0x4b42cc), not 16/48 → h>32→24.
  **gx st1 graze events f3731-class now 1-frame-late instead of 4-7;
  gx st2 f8057→f8061; st1 frontier f6350→f6348 (same wall, re-rolled).**
- **THE next wall (pass 21, narrowed by three falsifications): the sub21
  one-step residual is NOT a clock law** — three controlled experiments
  (round-robin advance-then-fetch pending; advance-then-fetch exact;
  phase-entry double tick) ALL break the stream at f1754: the wave-enemy
  sub-context t=1 rows (sub8/9) must fire at creation+1 (tick-after-fetch),
  while the Sub21 t=200 ring volley must fire one bullet-step early
  (tick-before-fetch) — algebraically incompatible for any single
  per-context clock, and the fire-frame accounting (creation f3426, volley
  f3626) matches the census eclT and the constructor's no-integration asm.
  The extra step must be BULLET-PASS-MECHANICAL (fresh volley bullets get
  one extra manager step natively). Note: FUN_00431240's 0x1a880 offset =
  160×0x2a4 points at the EFFECT-VM pool — the port's "BulletManager::
  OnUpdate" label on it is suspect (its spawn-state constants were verified
  empirically and stand). Probes: probe-spawstep (the +1-step alignment),
  probe-pair2/3.
- **THE st2 wall (pass 21, anchored): the f7869 auto-fire volley regime** —
  gx st2's f8061 contact is downstream re-roll: the stream wobbles ±1
  volley-frame (repaying) until f7869, where Mystia's ins_105/106 periodic
  emitter (12 rice bullets/round, flags 0x2252 spawn-state ≈10 draws/
  bullet) lands with aim var a1≈−0.008 (the aim-tracking variable wrapping
  through zero) and the offsets stop repaying (−18 → +90 by f7950). Two
  laws to decode: the auto-fire timer's advance/check order (the ±1
  wobble source) and the aim-tracking variable's wrap/accumulation.
  Probes: probe-st2wall2 (offset trajectory), probe-st2draw (per-frame
  consumption), probe-st2trace (fire-event hook).
- CLOSED pass 19: **the f3582 stream wall** — the native graze orb law
  (FUN_004930 tail, all.c:36844-36862): up to THREE time-orb drops per
  bullet graze — orb 1: stage gate + any live boss slot + gauge >= +8000
  (run-init constant 0x164d306, asm 0x44d9f7); orb 2: bullet graze only
  (param_2==0) while a spell is up (0x4ea670 bit 0, set by the spell
  declare FUN_004152a0); orb 3: stages 1-3 always. The port dropped one
  unconditionally → −8 draws per extreme-gauge spell graze from f3582
  (−9696 by f6352). Also pinned: the graze score doubling gate is gauge
  >= +2000 (0x164d30a, youkai side only — the ±8000 pair is the effects
  band); the threshold table 0x164d300-30a read in full at 0x44d9ee.
  **gx st2 f5853 → f8057 (+2204). gx st1 stream true f3582→f3730
  (+650 draws).**
- CLOSED pass 17 (audit): **pass-16's WIP is root-cause-correct 7/8
  against the binary**; the eighth (et_ex 0x20000 wait gate) cleared
  its bit one handler-pass early (native checks FUN_0040e390
  remaining<=0 BEFORE FUN_00418110 decrements — the clear pass burns
  no decrement, bit lives arg3+1 passes). Fixed to check-first; test
  re-pinned to native timing. Also asm-pinned: the 0x40/0x80/0x100 arm
  block @0x430380, the 0x10 arm @0x4301db (f1<=−990 fallback = +0xd74
  CURRENT HEADING — the decompile's [0x35a] is wrong), FUN_004322b0's
  tick — the Sub25 bullet's motion law is binary-exact; f6352 was
  never a movement defect.

- CLOSED this pass (15): **the st2 wave-mouth 12.5-frame-early kill** —
  root was lunge-pointer ADOPTION, not volley timing or a damage veto
  (the +104 draw bumps are option-firefly cadence, not hit sparks). The
  retained-corpse teardown must identity-clear DAT_018b89b4
  (FUN_0042bcf0 @0x42be88 via dispatcher −1 @0x42c9ba); mode-0 deaths
  (FUN_0042bea0, no pointer write) and culls stay pointer-blind, and the
  scan head (0x42c88f) clears only an inactive pointed slot — ins_129
  mode bits discriminate. Post-fix: all four y=160 fairy kills
  census-exact (port f1570/1578/1584/1585 ≡ native f1570.5/f1579/f1585/
  f1586), census-clean window f1571-1806. Landed 4933480; 214 tests
  green.
- CLOSED pass 11: **the st1 midboss movement defect family root** —
  the op-75 rect clamp (§3 ECL block) plus the exe-exact firefly cone
  decision (§3 effect-51 note).
- Pass-10 CLOSED: **the item side of the collect ±1-tick family**. The
  FUN_00440500 walk is fully decoded (§3 Items block): the +0x2a4 writer
  hunt closed (the walk integrates via dropped-this vector helpers), box
  = itemRadius/2 both sides (ply00a @24 = 24.0; the old "26.0" was a
  misread — the hardcoded ±12 was numerically right), PoC arm uses the
  RAW focus byte and a DOUBLE 128.0 power threshold, cull is strict
  beyond the line, state-5 is its own law (double integration on crest,
  no tail before it), iteration is spawn-order. Four fixes landed +
  7 tests (219 green); frontiers all held. The old "8 vs 10 items" at
  N696 was a unit error: a collect pays 4 u16 draws → native 5 vs port 4,
  ONE item (slot8) short. slot8's whole orbit re-verified law-exact; the
  nearby time-orb collects match frame-exact — the surviving ~6px gap at
  the box edge comes from the long-arc homing TARGET = player
  micro-position f661+ (never natively verified). **f696 −4, st1's ±111
  transients and the ±4 wander all collapse into the movement-precision
  family** (needs a user-ordered wine round for native player f660-700).
- Pass-9 CLOSED (4096776): gauge fire-drift law — short-tap park model;
  offset curve 453→116 (pass 10: 113, same f3244 zero).
- **Census tuple correction (pass 9)**: census enemies = [slot, hp, x, y,
  eclTime] — NOT [id,x,y,?,t]. Any probe reading e[1]/e[2] as x/y is wrong
  (verified: the three Sub24s' e[2] tracks port x frame-exact; e[1]=40 is
  HP; the midboss e[1]=1278 is HP).
- Formal baselines (pass 28): **gx st1 f7531**, **gx st2
  f9253** (post-fire-gate legit re-roll), ly st1 f3177, ly st2 f3471. Pass-27
  closed the first half of the st1 f4122 settle fork: master-tail orbs read
  the +0x3380 LEDGER ×2 (all.c:20533; was live-children ×2) and the wipe
  sweep leaves quad-zone-covered bullets to the zone path (pointStar count
  native-exact 209). f4122 draw deficit −828→−4. Pass-28 implemented the
  FUN_004161b0/00416b90 captured-card tail: native budget formula, 9-tick
  warm-up, opposite 128px type-10 bursts, partial debit and the reconstructed
  1/16 player easing; f4132 positions are wine-exact. Residuals: the asm
  442-budget/14-debit cadence yields 416 calls while wine observes 442 items
  (clock writer unresolved), the presentation actor transform is §7, plus
  quad conversion and the ins_92 ledger cadence — until those land, gx st1
  frontier numbers
  are re-roll noise on a still-forked stream. The f5911 fan-aim story is
  SUPERSEDED: the var chain is fully decoded (var10016 = rand10082×0.04 +
  π/3-family constants; native drew rand≈0, port −2.29) — pure downstream of
  the f4122 stream fork, NOT a var-semantics defect. The
  pass-20 fire-rank speed-bounds story is SUPERSEDED: the whole rank-lerp
  block is gated on the spell-declare singleton (0x4ea670 bit0, asm
  0x4229b7) — during spells fires pay authored values FLAT (wine-pinned:
  sub24's 123-bullet volley = exactly 3.0 native). The st1 stream is draw-true f3582→f3730;
  the sprite-7 graze family now runs 0-2 frames late with one event
  missing (the sub21 one-step wall above) — it re-rolls the
  Wriggle-fight fan angles and the f6348 contact is that noise, not a
  movement defect. The old "parked speed=0" reading of the f6352 bullet
  was wrong — 0x40 newSpeed=0 with a live 0x10 accel (|v|=2.70 at
  contact), asm-verified exact.
- CLOSED pass 16: **gx st2 f3019** — `FUN_00440cf0` on power 127→128
  pays `FUN_00406fa0(0x80)` (4 extra u16) on top of `FUN_00441850(1)`.
  Missing that checksum shifted the whole st2 stream (the "sub12 mirror"
  was a symptom).
- CLOSED pass 16: **st1 f2965 effect-pool 3-slot gap** — ins_128 was a
  no-op; native `FUN_00425430(0xd)` allocates a zero-draw effect-13
  cloud (Sub15 six arms at t0..50). C-curve vs rng-curve.jsonl is 0
  through f3581 after the port.
- CLOSED pass 16: **st1 f4013 Sub24 leftovers** — ins_111 0x20000 wait
  `continue`'d into 0x40000 fade-kill at construction; `dead=true` leaked
  fixed-pool slots (`if (b.dead) return` never compacted). Native ORs
  the bit into +0xdac and RETURNS. Midboss now death-wipes ~f4140
  (bullets 409→0) instead of parking speed-0 rice onto the replay path.
- Pass-11 CLOSED: the st1 midboss "4.3px drift" — root was the unported
  op-75 rect clamp (see §3), NOT slow float drift; post-fix the midboss
  trajectory is census-exact f3351-3524.
- CLOSED pass 24 (3f1560f): **the st2 dialogue confirm law** — native
  confirms on the SHOT-KEY RISING EDGE + armed counter (all.c:24781-24793;
  0x164d534 = the previous frame's input word), not the level rule; the
  replay taps Z, so the level rule ate 1-4f per op4 wait → Mystia's entry
  79 ticks late → the whole stationary-seed lattice re-rolled. Fix: edge
  confirm. **gx st2 f8252→f10043 (+1791), gx st1 f6013→f6021, ly flat,
  216 green.** The 2026-08-27 A/B's "level confirm" reading is falsified
  — its ly dialogue speed came from short-dur waits TIMING OUT (held keys
  never edge). Lesson: re-audit any A/B that inferred confirm semantics
  from "input words all odd" against all.c:24781-24793.
- Next-target queue (pass 28): (1) **f4123 quad-settle timing**: FUN_00430aa0
  probes FUN_00449ff0 per bullet; zone hits consume player+0xe2a90's per-quad
  type. Split the immediate sweep payment from state5/normal deferred payment
  per bullet — the pass-28 all-immediate and skip-second experiments are
  falsified. (2) **orbit emitter call-count contradiction**: asm budget442
  with 14 debit/full tick yields 416 calls, wine observes 442 type-10 items;
  decode the presentation clock/writer and effect-39 actor transform. (3)
  ins_92 ledger cadence 46-vs-68 (22 missing attaches → 44 tail orbs). (1b)
  **st2 bisection**: port field
  empty (enemies not firing) by f8950 vs native 511 — wine-window bisect
  st2 from f3500 (first spell segment); st2's own settle sweeps share the
  pass-27 fix family. (2) the st2 f9253 contact (sub17 rice, spawnF
  9025, bottom edge) — downstream of (1b); (3) the
  dialogue's residual ~13f (17-wait arm granularity/row pacing);
  (4) the MOVEMENT-PRECISION family — player micro-position f661+
  (wine-gated); (5) visual: fog law, boss name plate, ring-bullet
  render scale, HP-bar inset, timer tint (pass-21/22 acceptance list).
- **Falsified pass 23 (audit trail)**: "op90-93 children run eclT −1"
  (census row f3626 e[4]=1 read as the child's ECL clock; allocator
  core leaves ctx.time at 0) — implemented on the th08Familiar path
  only, formal gx st1 regressed f6013 → f2919 (the children's sub23
  per-tick effect spawns shift effect-pool pressure → RNG re-roll),
  reverted. The port's current "sync t0 advances + same-pass visit
  advances" is the stream-aligned behavior; e[4] for freshly-spawned
  children is NOT settled as the ECL clock (row may be mid-pass; the
  counter's identity is unresolved). Also falsified this pass: any
  second bullet movement pass (module table) and a 0x40/0x10
  handler-order defect (the orders match). Probe-label law: port
  scene.frame == input+1 during the pass; native census row f ≡ port
  input f−1 ≡ port scene.frame f — historical row-vs-row graze
  comparisons were correctly aligned.
- **Pass-22 headline**: the dialogue reveal-floor removal (c22b8a1) put
  the boss-fight entries ~24f from native (was 182) and moved gx st2 to
  f8252. The old gx st1 f6348 was a phantom of the shifted timeline —
  frontiers measured across a pacing defect measure nothing.
- Boss-fight pacing ~2.5-3x native: HP buckets d=0 through f2500 —
  downstream of the wall, not the wall.
- Visual: stage background fog law unresolved (dominant); boss lifebar
  fill-ratio micro-details. Pass-20 visual acceptance (multimodal
  subagent, s1-f03900 port-vs-native): scene/midboss/bullet field
  aligned (orbs Δy −3..−5px = the sub21 residual; rice ≤2.5px); one
  artifact to watch — a pale lavender double-ring blob drawn OVER a
  rice bullet at ~(87,165), single occurrence.
- Browser replay playback returns to title at a block's end; native
  chains blocks in-session (fidelity TODO).
- §7-flagged code approximations are grep-able (`§7`); none gameplay-
  clamped. Full per-pass history: git log + tmp/gx-findings.md + HANDOFF.
