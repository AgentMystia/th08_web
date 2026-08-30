# AGENTS.md — operating rules for th08_web

Repository `AgentMystia/th08_web`: TypeScript/browser reimplementation of
Touhou 08, Stage 1+2, Reimu/Yukari Border Team, original menus/UI, and browser
replay load/play. Keep this file short: detailed pass history lives in git
history, code comments, `HANDOFF.md`, and `tmp/gx-findings.md`.

## 0. Identity and hard rules

Authority: user instruction > this file > Th08.exe v1.00d and the decompile at
`reference/re-specs/th08-re-tools-export/all.c` > existing code > external docs.
TH06/TH07 semantics are not TH08 semantics.

Convergence oracles:
- `tests/replays/th8_udLy01.rpy` — full-run regression oracle.
- `tests/replays/th8_udGx01.rpy` — native No-Miss Stage 1+2 oracle.
- Formal contact frames are telemetry, never the sole definition of progress;
  RNG values/order and state curves decide whether a change converged.

Hard rules:
- Wine/ptrace is CLOSED unless the user explicitly orders a trace round. Answer
  native questions from the executable, decompile, objdump, `.rdata`, and
  existing telemetry until then.
- Run Node/tests/build inside `th08dev` (`podman exec th08dev bash -lc ...`).
  Keep the host clean. Presentation checks use the podman Playwright image.
- Nothing under `reference/` or `replay/` ships or is committed.
- No isolation hacks: no debug early-return, disabled subsystem, hardcoded
  replay state, phase clamp, RNG special case, or visual approximation that
  masks simulation divergence. Any unavoidable hand-written behavior must be
  grep-able with `§7` and recorded as approximate.
- Approved modernizations only: focus-hitbox dot, dev tooling (`?test=1`),
  Web Audio BGM loops, plaintext menu hints, 60-frame fly-in, and
  desync-canvas presentation with kill switches. `index.html` remains a static
  esbuild IIFE bundle.

Useful executable mappings: `.text` RVA 0x2000 -> file 0x1e00; `.rdata` RVA
0xb4000 -> file 0xb3a00; PE section table at PE+24+optsize.

## 1. Verification loop

Every semantic commit: `npm run check`, `npm run build`, and `npm test` must
pass. Run the verifier and record movement honestly, including “no movement”.

```bash
npx tsx scripts/replay-verify-th08.mjs <rpy> [--stage N] [--clear-check]
```

- Formal mode is authoritative for unexpected player hits and stops at the
  first committed unexpected contact.
- `--clear-check` makes the player invulnerable and compares the end state to
  the next stage snapshot; it hides contacts by construction. Use it for
  carry/end-state work, not as a substitute for formal contact convergence.
- RNG budget oracles: udLy01 st1=32816, st2=63672; udGx01 st1=864, st2=22674
  (all mod 65536).
- Core gates for a source change:

```bash
podman exec th08dev bash -lc \
  'cd /work && npm run check && npm run build && npm test'
```

Then run all four formal verifiers (gx/ly, stage 1/2). Run gx st1
`--clear-check` for death/settle/carry changes. Keep ly regression-clean.

Native evidence:
- `tmp/fa-native-gx/{rng-curve,census,runstate}.jsonl` and
  `tmp/wine-out/*.jsonl` are the local ground-truth corpus.
- `runstate.jsonl` is more than score/gauge: its base64 run blob contains the
  two `FUN_00406e50` integrity words at +0x50/+0xb4 (`u32%100000+0x198f`),
  providing a native RNG-value/order oracle.
- Alignment: native counter f == port state after input f-1. Duplicate rows
  are slowdown/mid-pass telemetry; dedupe and keep the intended boundary.
- Census “bullets” covers only slots 0..95 and must not be used as a full
  bullet oracle. Wine bullet rows are full-pool but mid-pass samples.
- Sub-30-FPS telemetry is still simulated one update per counter; skipping it
  rerolls fire deadlines.

Report every task with files changed, evidence basis, exact vs approximate,
verification actually run, and remaining gaps. Unverified means unverified.

## 2. Format facts

- **T8RP**: 0x68 header; stage block `{0x24 metadata, N×u16 inputs}`. v6 has no
  per-frame auxiliary word. Seed is u16@+0x1a; rank is byte@+0x25.
- **ECL v8**: leading 0x800; instruction `{u32 time,u16 id,u16 size,u16
  rank/hi,u16 paramMask}`. Dispatcher exe case is on-disk id−1. Locals: int
  10000-03/10012-15, float 10004-11, rand 10029-36, shared float bank 10061-68.
  Spell text (op90) is XOR-0xAA Shift-JIS.
- **ANM v3**: 64-byte entries; `{u16 op,u16 len,i16 time,u16 paramMask}`;
  exe op is disk op+1. Only random ops 59/60 draw during ANM setup.
- **SHT**: 56-byte header and shooter records. Border deathbomb window is 18;
  shot cycle is 20; item move rate is header+0x34.
- **MSG**: body text XOR 0x77. op4 advances on shot-key rising edge once the
  armed counter passes its threshold; Ctrl bypasses bodies.
- Playfield is `(32,16,384×448)`. Convert HUD top-left coordinates to entity
  centers at the call site.

## 3. Engine essentials

Full provenance is in source comments; do not re-derive these from TH07.

**Scheduler/player**
- Native module order: player(8) -> enemies(10) -> effects(11) ->
  items/bullets/lasers(12) -> MSG(13). Player shots move before new FIRE
  allocation in the player callback.
- Player collision center is player+0x2b4; hitbox/graze AABBs are +0x38c/+0x3a4.
  Player shot pool is player+0xbe838: 128 records, stride 0x484; state +0x462
  (1=flying, 2=settled), type +0x464, hitbox +0x430.
- The player-shot collision scan is `FUN_00451670` (older notes’
  “FUN_0043a980” label was a parent-engine mislabel). It builds inclusive f32
  AABBs, scans all 128 shots then attack slots, accumulates damage, settles the
  shot, and arms effect 5.

**Bullets**
- Manager 0xf54e90: 1536 slots, stride 0x10b8; allocator scans 0,1535..1.
  State +0xdb8; position +0xd44; velocity +0xd50; hitbox +0xd34; timer +0xda8;
  FIRE/command flags +0xdb0/+0xdac.
- Spawn states 2/3/4 move at 1/2, 1/2.5, and 1/3, and latch death-quad contact
  every spawn tick. Payment is deferred until the transition VM completes
  (`FUN_004241c0` cases 2/3/4). State 5 is the removal animation.
- `FUN_00449ff0` scans persistent death-quad records at player+0xbb834.
  `FUN_00451670` scans ordinary attack slots at player+0xb8834. Do not conflate
  the two pools.

**ECL/enemies**
- Enemy manager 0x577f20: 480 slots, stride 0x53d0. Live position +0x2d88, HP
  +0x2dfc, flags +0x3324, flags2 +0x3328, parent +0x2da4, attach ledger +0x3380,
  context +0x2ca0.
- ins_2 waits gate the ECL clock; timeline holds net-freeze it. A phase jump
  frees ins_135 sub-contexts and resets FIRE templates. Sub-contexts carry
  private stacks/variables and share float bank 10061-68 through CALL.
- ins_75 arms an enemy rect clamp around movement and after ins_63 position
  writes. ins_127 registers boss slots and the death-tail gate. Death modes are
  flags bits 20-22.
- Familiar solidity follows form/side flags; death sweeps use the attach ledger
  and quad conversion law, not simply the current live-child count.

**Items/death**
- Item manager 0x1653648: 2096 slots, stride 0x2e4. The active list is
  tail-linked, so walk order is spawn order. State +0x2d7: 0 fall, 1 homing,
  2 tween, 3 toss, 5 point-toss.
- `FUN_00440500` is the full walk law. Homing state 1 bypasses the ordinary
  bottom cull. States 3 and 5 are distinct integration/gravity laws. Collect
  boxes use live item and player AABB halves inclusively.
- Item spawn draws only for requested states 2/3/5; time items force the toss
  state. Type-9 quad conversion pays two time items; other nonnegative types
  pay one.
- Death settle (`FUN_0041ed50`/`FUN_004161b0` order) performs scored sweep,
  non-boss sweep, score bank, then captured-card checksum/tail. Equal draw
  counts do not prove equal RNG values or ordering.

**RNG/effects/economy**
- Shared LFSR: state 0x164d520, draw counter 0x164d524. u16=1 draw;
  u32/rand01/%range=2. Effect spawn cost is script random ops plus init callback.
- The effect allocator performs partial allocation over its rolling pool;
  occupancy changes gameplay RNG by throttling later effects.
- Run state is 0x160f510: score +0x0, gauge +0x20, power +0x98, integrity words
  +0x50/+0xb4. Time-orb and protected-value writes can consume four u16 each.

## 4. Workflow discipline

1. Rebuild the current baseline and identify the earliest permanent value/count
   fork, not merely the largest downstream symptom.
2. Binary-pin a hypothesis before editing. Use call order, fields, constants,
   and float-rounding sites. Record falsifications rather than hiding them.
3. Make the smallest semantic fix and add a focused regression for the native
   law. No replay-specific behavior.
4. Run full gates and relevant verifiers. If an “improvement” moves a contact
   frame, first prove the semantics; wrong laws can fake progress by rerolling
   the contact lottery.
5. Update `HANDOFF.md` and `tmp/gx-findings.md` with exact evidence, commands,
   results, and the next frontier.

## 5. Tests

`tests/th08-*.test.mjs` and `tests/engine-*.test.mjs` cover ECL semantics,
bullets, items/economy, familiars, pacing checkpoints, presentation, and
browser surfaces. Preserve native pins unless new binary evidence consciously
supersedes them. Six browser-only checks may skip outside the browser gate.

## 6. Current state and frontiers (pass 35)

The convergence goal is not complete. Latest source state is pass-35 commit
`86dd940`.

Latest complete source verification:
- check/build/test: PASS, 231/231.
- Formal: gx st1 f7518; gx st2 f6475 (contact re-roll); ly st1 f3237; ly st2
  f3471.
- gx st1 clear-check clears at replay frame 11891; its end state remains a
  downstream cascade, not native-exact.

Pass-35 closed the st2 f4909 fork: the spawn-state quad latch (+0xdbe) is a
boolean and the VM-end payment reads the LIVE global DAT_018b8988
(player+0xe2a90), republished by FUN_00449ff0 on each quad contact and reset
to 6 by every FUN_0044a230/FUN_0044a470 hit/graze probe entry. Latched
bullets whose quad expired before VM end pay the stale 6 (pointStar, zero
draws). f4909 now exact at 150 draws; the first permanent count fork moved
f4909 -> f6330; checksum values hold through f5500 modulo known mid-pass
sampling bands.

Current st1 frontier:
- f4228 is native 60 draws vs port 56: exactly one missing four-draw effect-5
  allocation after the third impact and before the eleven collects. Forcing
  nearby shots to collide is falsified; the native shot-pool identity/call
  site remains open (Wine is closed).

Current st2 frontier (f6330, +12):
- Scene is the lone boss (hp ~1476->1408) drifting (192,128)->(248,108) with a
  4-frame fire cadence; native volley sizes vary per shot (104/122/116/...)
  while the port is nearly constant 104, and an irregular 12-draw event family
  is phase-offset by about a frame. First permanent count fork f6330.
- This is the pass-23 auto-fire timer primitive order + aim-tracking wrap
  family (FUN_00406610/660/40, b8e0, e390).

Historical audit and full pass detail: `HANDOFF.md`, `tmp/gx-findings.md`, and
git history.
