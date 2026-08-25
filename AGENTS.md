# AGENTS.md

Operating manual for AI agents and contributors. Every rule here was earned
by a real defect. Follow it exactly.

## 0. Project identity and hard rules

This repository is the standalone project **AgentMystia/th08_web**: a
TypeScript/browser reimplementation of **Touhou 08 ~ Imperishable Night**
driven by the original game data. Delivered scope: **Stage 1 + Stage 2 +
Reimu/Yukari Border Team** with the original menus/UI, aligned to the
committed replay fixture `tests/replays/th8_udLy01.rpy` (a FULL Lunatic
run: stages 1,2,3,5,6,8).

Authority order when sources conflict:
1. Current user instruction.
2. This file.
3. `reference/Th08.exe` (v1.00d) and the decompile
   `reference/re-specs/th08-re-tools-export/all.c` (cite addresses inline;
   `reference/th08-decomp/src/*.cpp` is an early stub recomp — NOT content).
4. Existing implementation. 5. External docs (cross-check only).
TH06/TH07 semantics are NOT TH08 semantics; several opcode tables differ.

Hard rules:
- **Wine/ptrace native tracing is CLOSED** (user decision 2026-08-24). All
  native questions are answered from the decompile + .rdata reads +
  objdump (`objdump -D -b binary -m i386`; .text RVA 0x2000 → file 0x1e00,
  so in .text VA = file offset + 0x200). Do not attempt to boot Th08.exe.
- **Host stays clean** (zero-local-execution policy): run node/tests via
  the podman runner `tmp/podman-node/run.sh <npm args...>` (image
  `localhost/th08node`, node:22, bind-mounted src/tests/scripts/assets,
  persistent `th08-nm` volume for node_modules). One-off scripts run the
  same image with `-e VAR=x` env passing. Clean up containers after use.
  Visual checks use the podman playwright image
  (`mcr.microsoft.com/playwright:v1.60.0-noble`, recipe in ignored
  `tmp/pw-driver/`).
- Nothing under `reference/` or `replay/` may ship or be committed; browser
  runtime fetches only repo-relative `assets/` paths.
- No isolation hacks: no debug early-returns, no commented-out subsystems,
  no hardcoded test state, no per-phase clamps or RNG special cases to
  "fix" replay divergence (forbidden by the task contract).
- `index.html` stays a static page (esbuild IIFE bundle).
- Default rule: reproduce the original exactly. Hand-written behavior is a
  last resort and must carry a comment flagging it. Approved
  modernizations are limited to: focus-hitbox dot rendering, dev/debug
  tooling (`?test=1`), Web Audio BGM loop points from `thbgm.fmt`,
  plain-text menu hints, the 60-frame stage-start fly-in (visual only),
  and the desynchronized-canvas low-latency presentation (kill switches
  `?desync=0` / `?backbuffer=1`).

CI (`.github/workflows/deploy.yml`): `core` (check/build/test) +
`browser` (playwright boot probes) gate `pages`; the `replay` job
(`replay:verify:th08 --stage 1` / `--stage 2`, two separate advisory
oracles, continue-on-error) does not block deploys. Local dev has no
browsers; all browser-pixel gates run on CI or the podman playwright image.

## 1. Verification loop

Every commit must satisfy:
1. `npm run check` — zero TS errors.
2. `npm run build` — clean esbuild bundle.
3. `npm test` — all unit tests green (browser-only suites skip locally).
4. For simulation changes, run the replay verifier (below) and record the
   movement honestly in §7.

Verifier: `npx tsx scripts/replay-verify-th08.mjs [--stage N] [--clear-check]`
- **Formal mode** (default): replays the fixture stage with the real death
  path, stops at the first unexpected player hit, prints
  `EARLIEST DIVERGENCE`. Stage-2 additionally carries a seed-scoped
  native-contact oracle (the f676 contact + deathbomb chain, checkpoints
  f696/697, traced natively via /proc before wine closed) that the run must
  match exactly — it is replay-mode-only by construction.
- **--clear-check**: forces player invulnerability so the run plays to the
  stage clear and compares the end state against the NEXT stage's recorded
  entry snapshot (score/power/graze/items/gauge/rng-residue). Contacts
  cannot be observed in this mode; read the end-of-stage diff, not the
  EARLIEST line. End-state diffs downstream of the first phantom death are
  cascade noise, not independent defects.
- RNG budget oracles (LFSR-walk, mod 65536, from the fixture's own seeds):
  stage-1 total draws ≡ 32816, stage-2 ≡ 63672. A count-exact run must hit
  these residues.
- The fixture's first ~30 stage-2 records include sub-30-FPS slowdown
  telemetry; the verifier simulates every record (native counter f ==
  port state after input f-1 even there — skipping them rerolls
  auto-fire deadlines).

Every task ends with: what changed (files), evidence basis (data/exe),
exact-or-approximate status, verification actually run, and remaining
gaps. An unverified change is reported as unverified, never as done.

## 2. TH08 format facts (do not re-derive)

- **T8RP replay**: 0x68 header; stage blocks are `{0x24 metadata, N×u16
  inputs}` — v6 has NO per-frame aux word. Playback feed strides 2
  (FUN_00452550); the recorder writes one u16/frame. The u32@+0x10
  validator = 0x3f000318 + sum(decrypted[0x15..]). RNG seed per stage at
  +0x1a (u16), rank at +0x25, restored by FUN_00453be0.
- **ECL v8**: leading 0x800 magic; sub instruction
  `{u32 time, u16 id, u16 size, u16 rank<<8|hi, u16 paramMask}`;
  time==0xffffffff sentinels. Exe dispatcher FUN_004184b0: **exe case =
  on-disk ins − 1** (hex case labels in all.c). Variables: locals
  10000–10015 (int 10000-03/10012-15, float 10004-11), extra floats
  10072/73, rand-int params 10029–10032, rand-float 10033–10036;
  run-global float bank 10061–10068 (DAT_004ece20..3c) — a real shared
  bus copied through CALL frames; var 10056 = derived random, 10060 =
  random angle. Spell names (op 90) XOR-0xAA Shift-JIS.
- **ANM v3**: 64-byte entries; instruction `{u16 op, u16 len, i16 time,
  u16 paramMask}`; exe case = on-disk op + 1 (FUN_0045ea00). Random ops
  are only on-disk 59/60 (2 u16 each at arm). Multi-entry files reuse
  on-disk ids across entries — always resolve through entry-scoped lookup.
- **SHT**: 56-byte header + records; per-form item movement rate (SHT+0x34);
  Border Team 18-frame deathbomb window.
- **MSG**: text XOR 0x77; op15 = active-slot workhorse (SetSprite ORDINALS,
  not labels); dialogue confirm needs Z RISING edges (held Z never
  confirms); Ctrl skip bypasses wait bodies.
- Geometry: playfield (32,16,384×448); ANM HUD coords are top-left (op22)
  vs entity-center — convert at the call site.

## 3. Engine facts index (exe-pinned; full provenance comments live in code)

**Bullet manager** (static 0xf54e90; 0x600 slots × 0x10b8; slot iteration
0,1535..1 backward):
- Slot fields: state u16 +0xdb8 (0 free, 1 normal, 2/3/4
  spawn-transition, 5 dying), pos +0xd44/48, hit size +0xd34, timer
  +0xda8, cmd flags +0xdac, vel +0xd50/54, heading +0xd74, speed base
  +0xd68, prototype +0x224, grazed latch +0xdbd.
- OnUpdate FUN_00431240 dispatches states via jump table @ 0x432156.
  **Spawn states 2/3/4 (0x43176e/0x431880/0x431991) perform only the
  fractional move (vel·½, ½/2.5, ⅓ via FUN_0040c7d0); when the spawn ANM
  reports done they write state=1 at 0x431106 and FALL THROUGH into the
  complete case-1 body on the SAME tick** — queue pass (FUN_0042ffc0 at
  0x431122), et_ex dispatch, full-velocity move, collision, ANM tick.
- **Construction (FUN_0042f5f0) zeroes the live cmd flags** (0xdac = 0,
  all.c:22843) after using template+0x1fc (the raw FIRE flags) for the
  spawn-state selection; behaviors arm ONLY through the ins_111 queue
  records copied to +0xdd0. FIRE flags' 0xe bits select the spawn state,
  0x200 the firing sfx — they do NOT arm behaviors.
- **et_ex dir-change mapping is machine-code-pinned** (2026-08-26):
  bit 0x40 → FUN_00432460 = RELATIVE `angle += f0` (flds/fadds/fstps at
  0x4322ef-0x4322fe); bit 0x100 → FUN_004325a0 = ABSOLUTE `angle = f0`;
  bit 0x80 → aimed (angle-to-player + f0, +π/2 for the zero vector). The
  fire action sets speed := f1 and each family clears its own bit at the
  maxTimes fire; while armed the waiting branch sawtooths
  `speed = 0xd68·(1 − t/interval)` EVERY tick (0xd68 init = spawn speed
  at construction, f1 after each fire).
- Speed ramp (bit 0x1, FUN_00432210): velocity = polar(angle,
  spawnSpeed + 5·(1 − t/16)) for 17 ticks (0x4b4304=5.0, 0x4b42d4=16.0);
  param-free, but arms only via a queue record.
- Graze (FUN_0044a470): per-bullet once (latch 0xdbd), age>15 gate, box =
  bullet AABB expanded size/2 + 20 (0x4b42ec=2.0, 0x4b6e98=20.0) vs the
  player graze rect +0x3a4..b4. Counter tiers +1/+2/+3 by human gauge
  depth (FUN_0044a930); gauge awards are form-gated.
- FIRE (ins 96-104 → FUN_00422720): count1=0 fires NOTHING (authored
  shutdown); rank-lerp speed bounds are ±0.15 at enemy spawn, reset to
  ±0.5 at every phase transition/spell arm/death-callback entry
  (FUN_00415c80). The native stage-1 midboss f2995 rain measured
  rankSpeed −0.0375 at rank 12 (±0.15 bounds) — the port matches exactly.

**ECL semantics**:
- ins_2 is the TH08 WAIT (gates the instruction clock via ctx+0x90).
- Timeline holds (ops 7/10/13) NET-FREEZE the clock (ZunTimer::Subtract
  before Tick); the dispatcher fires ops only on exact clock match.
- Death mode lives in flags bits 20-22 (ins_129; 0xff8fffff clears ONLY
  those — bit23 hide survives); mode-1 hide is DRAW-SIDE ONLY, damage
  still flows; the re-show is the next phase's ins_54/58 ANM re-arm.
- ins_131/133/134 = phase HP pool / thresholds / timer; a phase jump
  frees ALL ins_135 sub-contexts and resets the FIRE template.
- ins_135 sub-contexts carry PRIVATE call stacks, vars, and interp slots.
- The CALL channel copies the run-global float bank into the callee's
  frame (all.c:15505-15512) — dropping vars 10061-10068 starves authored
  parameters (the 2026-08-25 zero-danmaku root cause).
- Auto-fire (ins 105/106) deadline: value·rank-lerp; ins_106 draws a
  u32%deadline phase (2 u16); the chain runs on its own +0x3064 ZunTimer
  that advances through ins_2 waits, resolving vars through the
  CAPTURING context's bank.
- Familiars: human form MATERIALIZES (bit11=0 solid), youkai etherealizes;
  per-tick side sync FUN_0042c420; Reimu-side teams take no familiar body
  contact; master death sweeps children with time-orb showers + kill
  quads whose param6 converts swept bullets to items (9 → two orbs).
- var 10000/10016 = the stage-2 night-blindness intensity/radius bus,
  armed by ins_135 drivers, cleared ONLY by ins_123 or stage transition —
  Mystia's finale retains the dark natively.

**RNG**: u16 LFSR at 0x164d520 (seed restored per stage from T8RP);
u32 counter at 0x164d524. Draw prices: u16 calls 1; u32/rand01/signed/
u32%range 2. ANM random ops 2 each at arm. Effect spawn cost =
2×(script ins_59+60 count) + init callback draws (table in
EFFECT_DRAW_COST, stage-scene.ts). Effect-62 option afterimages (12 VMs
every 3rd player tick from counter>699, 0 draws) hold the 512-slot pool
at ~280 and throttle effect-51 firefly emission to ~66% — pool pressure
is load-bearing for the draw economy. Item spawn draws only for
param_4 ∈ {2,3,5}; time-orb type gives up after the FIRST occupied probe.

**Player/economy**: preDeadCount recomputed per hit (bombs·6, +7 with the
Time quota met, caps 15/30, team multipliers ×9/5); deathbomb = type
3−form; gauge clocks player+0xe2ad0 (shot-idle) and +0xe2ae8 (firing
ramp, trunc(t/15) cap 21, PRE-tick read); miss white-out = opaque
768×896 playfield fill while +0xe2a70 counts; death drops are pool
state-2 spawns with the 304-px scatter tween; time-orb collects pay 4 u16
each; point value above PoC is full, below degrades linearly; the
persistent enemy +0x2e10 accumulator emits state-3 time items on
threshold crossings.

**Native address map (essentials)**: player 0x17d5ef8 (collision center
+0x2b4/8, AABB +0x38c..9c, hitbox +0x3d4, graze rect +0x3a4..b4);
bullet mgr 0xf54e90; enemy mgr 0x577f20 (stride 0x53d0, live pos +0x2d88/8c
= origin +0x2d40 + logical +0x2d34, hp +0x2dfc, flags2 +0x3324, form-rank
+0x3330, parent +0x2da4, ECL ctx ptr +0x2ca0); RNG 0x164d520/4; sfx id
table 0x4c8040 (46 channels, stride 8) over the 36-file name table
0x4c81b0; effect map DAT_004c6d30 (ARCHIVE script indices, NOT on-disk
ids — resolve through the file-order enumeration); stage×difficulty time
quota DAT_004c77f0; per-stage clear base DAT_004c7158.

## 4. Workflow notes

- Fix roots, not symptoms: the worst regressions all shipped in changes
  that compiled fine. A change is done when the verifier/snapshot numbers
  moved (or provably could not) and the honest result is recorded.
- Rank masks gate spawns by difficulty — verify changes on Lunatic.
- The 2026-08-25 claim "stage-1 EARLIEST none observed" was a clear-check
  artifact (invulnerable mode logs no contacts); formal-mode numbers are
  the only authoritative ones. Do not re-chase ghosts from diagnostic runs.
- When a replay number "improves" after a semantics change, re-verify the
  semantics against the binary first — wrong semantics re-roll the contact
  lottery and can fake progress (the 2026-08-26 Cursor-PR revert case:
  both "improvements" in PR #1's behavioral half were exe-wrong).
- Presentation changes need a real-browser eyeball (podman playwright);
  headless screenshots cannot prove scanout behavior.

## 5. Assets

Runtime assets live under `assets/th08-img`, `assets/audio/th08`,
`assets/sfx/th08`. The extraction pipeline (scripts/extract-th08-assets.mjs,
split-th08-bgm.mjs) uses exact thbgm.fmt PCM parameters. A ship-safety test
fails if any slice track is missing from assets/audio/th08; another test
walks every embedded Stage 1/2 ANM entry and rejects textures absent from
the browser preload registry.

## 6. Test suite map

`tests/th08-*.test.mjs` + `tests/engine-*.test.mjs` (212+ tests). Key
regression surfaces: et_ex dir-change semantics (th08-ex-dirchange),
sub-context CALL channel (th08-subcontext), boss audits + presentation
(th08-boss-audit / th08-boss-presentation), item/damage economy
(th08-item-spawn / th08-death-white), familiar wait cadence
(th08-familiar), pacing hard checkpoints (tests/engine-pacing embeds
native seed values at st2 f1237/f1276 — gameplay changes must keep them
or consciously regenerate). The 6 skipped tests are browser-only.

## 7. Standing residuals (honest, 2026-08-26)

- **Formal verifier**: stage-1 earliest unexpected hit **f3192**
  (Sub16 midboss rain spoke, contact slack 1.44px), stage-2 **f3367**
  (Sub2 aimed fairy bullet, slack 2.95px, age 34). Every kinematic
  ingredient of both bullets is machine-code- or native-trace-pinned
  (dir-change family, spawn-state fallthrough, construction flags, graze
  box, ramp constants, rank-speed bounds — the f2995 volley speed matches
  the native 1.962 measurement). The residual class is sub-pixel
  kill-timing cascade (one fire-tick ≈ 2.1px along-track flips the
  contact); pinning it further needs a native per-frame profile — wine,
  closed. Do NOT paper over it.
- Stage-2 draw economy: +8 u16 by f1237 (family-audited exhaustive; opens
  on 2–4 contact-derived events — the same cascade class).
- Both stages CLEAR under --clear-check (st1 f13057, st2 f27784);
  end-state diffs (score/graze/items) are downstream of the first phantom
  death, not independent defects.
- Code-level approximations are flagged inline (grep `§7`); none are
  gameplay-clamped.

## 8. Historical pass log (details in git history; code carries provenance)

- 2026-08-17/19: TH08-ification complete (TH07 path removed); T8RP format
  fixed (0x24 header + N×u16); timeline hold semantics; arith ops are
  compound assigns; death modes in flags 20-22.
- 2026-08-20 (three passes): native /proc slot-trace breakthrough;
  familiar kill-quads, tangibility gates, orbit tracking; ins_63 teleport
  sync; rank-lerp bounds split; RNG draw counter + effect economy (option
  afterimages, familiar sparkles, master-death showers, collect payments);
  item-pool leak fix.
- 2026-08-22: boss visual audit (declaration layering, effect-39 ring, HP
  strip, preload registry); pre-release static audit clean.
- 2026-08-23: scheduler-boundary + item/damage/bomb economy pass;
  player-state machine, gauge clocks, collect checksum draws, 1536-slot
  bullet pool, stage-2 BGM, dialogue portraits, graze tiers.
- 2026-08-24: boss-fidelity (Mystia visibility, Last Spell quota, beam
  visuals, night blindness); draw-economy audit (+8 residual family
  audited); miss-drop state-2 tween; budget oracles recorded.
- 2026-08-25: boss-fidelity acceptance (CALL channel var-bank copy +
  int-write mapping — the zero-danmaku fix; marker-pool leak; AnmRunner
  entry-sprite-base crash; night-blindness persistence; sub-context interp
  isolation). The "stage-1 none observed" claim was later identified as a
  clear-check artifact.
- 2026-08-24 (Cursor cloud, PR #1): spell-ring settle/tracking, HUD label
  VMs ticked in update, phase HP strip, graze tier counter, opcode census
  — kept; its 0x40=SET and spawn-end et_ex skip were exe-wrong and
  reverted 2026-08-26 (machine-code proof in code comments).
- 2026-08-26 (this pass): audit + revert of the two wrong behavioral
  changes; dir-change family + construction + graze-box constants
  machine-code-pinned; verifier oracle gated to formal mode + clear-check
  honesty banner + label fix; AGENTS.md rewritten (141KB → this file).
