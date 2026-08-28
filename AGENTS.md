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
  jsonl, /proc census of udGx01 st1-2). Alignment: **native counter f ==
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
polar(angle, spawn + 5·(1 − t/16)) for 17 ticks. Graze: once per bullet,
age>15, box = AABB/2 + 20 vs player graze rect, tiers +1/+2/+3 by gauge
depth, form-gated. FIRE count1=0 fires NOTHING (authored shutdown);
rank-lerp speed bounds ±0.15 at enemy spawn, reset ±0.5 at every phase
transition / spell arm / death-callback entry (FUN_00415c80).

**ECL**: ins_2 = TH08 wait (clock gate ctx+0x90); timeline holds (ops
7/10/13) net-freeze the clock, dispatcher fires on exact match. Death
mode = flags bits 20-22 (ins_129; 0xff8fffff clears only those). ins_127
registers the boss slot AND sets +0x3324 bit1 — that bit is the
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
0x4ea3e8 unit axis) ≥ 0.94 (fnstsw $5 — NaN releases), ~25% die at
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

`tests/th08-*.test.mjs` + `tests/engine-*.test.mjs` (213). Key surfaces:
et_ex dir semantics, sub-context CALL channel, boss audits/presentation,
item/damage economy, familiar cadence, pacing hard checkpoints (native
gauge/seed pins at st2 f1237/f1276 — keep or consciously regenerate).
6 browser-only skips. The boss-audit pre-seeds the Last-Spell orb quota
(structural assertion, decoupled from the razor-edge economy).

## 6. Standing residuals (honest, 2026-08-29 pass 9)

- CLOSED this pass (4096776): the gauge fire-drift law fully decoded — the
  0x44bdf0 block lives inside FUN_0044aec0 (gates: msg/0x4358bb, player+8>=30,
  bomb +0xfdc); e2ad0 SATURATES at 30 (the >=30 tier path skips its own
  advance at 0x44c007); the flip sites (0x44b1a5/0x44b3f8) write ONLY +8=0
  and e2ae8=0 — no park write exists anywhere in .text. The old youkai-flip
  park mis-fired on held presses (30 phantom countdown ticks) = the st1
  f3139 −221 gauge deficit root. Replaced by the five-way-pinned SHORT-TAP
  law (§7 in player.ts): a focus-OUT whose entire youkai visit fits inside
  the still-closed +8 window (held<30, form still 1) restarts the 30
  countdown. Gauge offset-curve changes 453→116 (residual = ±111
  collect-phase transients); returns to 0 at f3244.
- **Census tuple correction (pass 9)**: census enemies = [slot, hp, x, y,
  eclTime] — NOT [id,x,y,?,t]. Any probe reading e[1]/e[2] as x/y is wrong
  (verified: the three Sub24s' e[2] tracks port x frame-exact; e[1]=40 is
  HP; the midboss e[1]=1278 is HP).
- Formal baselines (pass 9): gx st1 **f3586** (Sub24 ring now 3 frames
  EARLY — the +8000 crossing moved; razor flipped sides); gx st2 **f4365**
  (+900; the old 4.5px fire-position defect was damage-phase downstream of
  the gauge); ly st1 f3176 / ly st2 **f4985** (+1277). 212 tests green.
- st2 field parity (post-correction): enemy positions <0.4px exact through
  f990; wave cadence exact through f1566. New measured defects: the port
  kills the s1 y=160 left-mover waves 12-13 frames early from f1558
  (shot-reach family, open); a sub12 enemy drifts 0.46→0.8px from f1787
  (movement-precision family, open). Stream: delta-exact to f695; f696 −4,
  then ±4 wander that does NOT repay (cum −124 @f4363, +200 @f4370).
- st1: midboss x drifts ~4.3px by f3548 (native 160.1 vs port 155.8) — the
  direct root of the f3586 ring razor (same movement-precision family).
- Next-target queue (leverage order): (1) the item-collect ±1-tick family
  — st2 f696's two unpaid collects and st1's ±111 gauge transients share
  it; the 0x440500 walk's type switch is located (type 7 → FUN_004412b0)
  but the motion integration is NOT in the walk — find the +0x2a4 writer;
  (2) the f1558 early kills (amulet reach/spread geometry); (3) the
  sub12/midboss 0.5-4.3px ECL float-path drifts.
- Boss-fight pacing ~2.5-3x native: HP buckets d=0 through f2500 —
  downstream of the wall, not the wall.
- Visual: stage background fog law unresolved (dominant); boss lifebar
  fill-ratio micro-details.
- Browser replay playback returns to title at a block's end; native
  chains blocks in-session (fidelity TODO).
- §7-flagged code approximations are grep-able (`§7`); none gameplay-
  clamped. Full per-pass history: git log + tmp/gx-findings.md + HANDOFF.
