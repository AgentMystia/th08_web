# AGENTS.md

Operating manual for AI agents and contributors. Every rule here was earned
by a real defect. Follow it exactly.

## 0. Project identity and hard rules

This repository is the standalone project **AgentMystia/th08_web**: a
TypeScript/browser reimplementation of **Touhou 08 ~ Imperishable Night**
driven by the original game data. Delivered scope: **Stage 1 + Stage 2 +
Reimu/Yukari Border Team** with the original menus/UI **and the browser
replay load & playback system** (title → Replay → .rpy picker; playback
runs the same engine path and T8RP entry restore as the Node verifier),
aligned to the committed replay fixture `tests/replays/th8_udLy01.rpy`
(a FULL Lunatic run: stages 1,2,3,5,6,8 — natively no-death through
stages 1-2, the single f676 contact deathbombed).

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
  not labels); op4 waits confirm on Z **held** once the wait counter passes
  the armed threshold (gui+0x21830: 6 at load, 30 after a timeout, 8 after
  a confirm — the th8_udLy01 fixture advances whole dialogues with Z held
  from before the box opens; a rising-edge rule stalls every wait for its
  authored 500-frame timeout, ~600 frames/line, and drags the mid-stage
  timeline); Ctrl skip bypasses wait bodies.
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

## 7b. udGx01 divergence-hunt round (2026-08-27 pass 3, IN PROGRESS)

Second oracle fixture `tests/replays/th8_udGx01.rpy` (Border Team Lunatic,
anonyymi; st1 11460f seed 0x28ac rank8, st2 14024f seed 0x2653 rank12, both
natively No-Miss with lives 4→4 bombs 3→3). Goal: formal No Miss on its
stages 1-2 without replay-specific tuning. Working ledger: `tmp/gx-findings.md`
(untracked). Verified facts so far:

- Formal baselines on the new file reproduce the SAME defect family:
  st1 earliest unexpected hit **f3184/85** (midboss t2995 rain spoke,
  ownerSub15 sprite2#13, speed 2.20 vs ly's 2.10 — rank-lerped speed),
  st2 **f2887/88** (aimed fairy Sub1 spawn f2779 speed 2.9625 == ly's).
- RNG budget distances (same engine walker): gx st1 ≡ 864, st2 ≡ 22674.
- Frame-exact A/B rebuilt on true replay path (old ?arcade=1 fa-port runs
  NEVER restored the per-stage rngSeed — their bullet-level conclusions are
  RETIRED): `tmp/pw-driver/frame-align-port-replay.mjs` boots through the
  picker → startReplayStage; native side uses a pre-baked PURE WIN32 wine
  prefix image (`localhost/th08winedop`, Containerfile.prefix in ignored
  tmp/podman-trace) — fresh wow64 prefixes boot-mangled Th08.exe
  (kernel32 c0000135) and win32 bakes in ~40 s. Boot now ~2 s.
- Packet-level parity PROVEN for stage-1 opening through f930: spawns, hp
  curves, kill frames, auto-fire volleys (sub3 template arm → 3 volleys at
  identical frames/magnitudes), effect draw packets and P-item counts all
  match native within a one-frame sampler phase. Port fires the same
  bullets the exe does; earlier "native never fired" reads were my sampler
  scanning bullet slots 0..95 while the exe allocates from index 1535 down.
- REAL divergence: score wedge inside (600,900] (+105 @600 → +13.7k @900)
  coincident with a net +290 u16 draw surplus concentrated around the
  full-power conversion avalanche (~f889-924, enterTh08FullPower bursts of
  hundreds of u32 draws). Prime suspect = economy-tier item/score path
  feeding rank evolution upstream of the phantom contacts. NOT yet root-
  caused; do not treat ±13k as harmless cascade noise until the native
  per-frame SCORE curve (next step: extend native census to read RUN-state
  score via run ptr 0x160f510) pins who pays what when.
- Replay UX gap recorded: port returns to title when one block's stream ends;
  the exe chains into the next block in-session (fa-native manifest shows
  continuous s1→s2). Browser-side playback chaining is a fidelity TODO.

## 7. Standing residuals (honest, 2026-08-27 pass 2)

- **Formal verifier**: stage-1 earliest unexpected hit **f3192**
  (midboss phase-1 rain spoke — sub16 fire body, contact slack 1.44px),
  stage-2 **f3367** (Sub2 aimed fairy bullet, slack 2.95px ≈ one speed
  step, age 34) — unchanged by the ReplayInputSource feed fix. Every
  kinematic ingredient of both bullets is machine-code- or
  native-trace-pinned. Working unification hypothesis (pass 2): a small
  RNG draw-count drift opening in (600,900] (score-only +1,334 by f900
  with graze/power/lives exact at every native checkpoint through f1500)
  shifts later random angle/speed draws (var 10060 etc.) by a few draws;
  visible symptoms are the graze field deltas (-5 by f1800, +9 in the
  (2400,3000] rain window) and the razor-edge phantom contacts. Pinning
  the exact draw site needs native per-frame counts (ptrace closed) or a
  full decompile audit of every consumer in the window. Do NOT paper over
  the contacts.
- **Stage-1 boss-fight pacing** (NEW, quantified pass 2): the stage
  timeline itself is aligned — midboss spawn = authored t2935 exactly,
  蛍符 spell f3413-4280, boss spawn f5617, pre-boss dialogue Ctrl-skip
  recorded f5607-5751 — but the boss fight runs ~2.5-3x native's
  duration: our nonspell phases settle ~8.3 dmg/frame sustained (avg 36
  on 23% of frames, distribution peaks 38/40/70 — the 70 cap, /7 spell
  tiering and score trickle all verified against all.c:21500) vs ~25/
  frame needed to fit native's card in the recording. Phase pools
  authored-verified (sub26: 131=13000/133→1500→sub38; 蠹符 1800; rank
  gate = mask bit 3 = Lunatic, filter verified), boss shot hitboxes
  authored (48x32 nonspell, 28x28 spell). Prime suspects: player shot
  layout (option spacing/spread → hit rate) or per-pellet damage vs SHT.
  Late spells time out instead of dying, stretching the fight past
  f12000 (clear-check clear f13057; graze 2144 vs native 536 is
  downstream field noise, not an independent defect).
- **clear-check tally artifact**: after the recording ends the harness
  idles Z held; the stage-tally confirm needs a RISING shoot edge
  (stageClearTimer>90 && pressed), so each confirm waits the >900-frame
  timeout — ~1800 of the +2553 "extra frames" are this, not pacing.
  Formal mode is unaffected (dies at the first phantom before the tally).
- **Stage background under fog** (unchanged; dominant visual residual):
  fog law unresolved; captures tmp/fa-native, tmp/fa-fogoff, fits in
  tmp/fa-diff. The port emits 2-4 fog cells at f600 where the exe draws
  the whole canopy.
- **Boss lifebar micro-details**: color-cycling dither trail, dithered
  empty section, fill-ratio law (native white-fill at f3300 ≈ 0.22 of
  strip vs port phase-ratio 0.72 — needs the ins_131/133 per-phase pool
  audit).
- Stage-2 draw economy: +8 u16 by f1237 (contact-derived events, same
  cascade class).
- Dialogue pacing: per-line timing approximate (±20 frames, §7-flagged
  1.5f/char floor in th08-dialogue.ts).
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
- 2026-08-27 (this pass): user-directed frame-vs-frame A/B against the
  original — Th08.exe v1.00d booted under Wine 10.0/Xvfb inside a podman
  container (the 2026-08-24 wine closure is superseded by direct user
  instruction for this pass; everything stays in-container, host clean).
  Frame-exact capture harness: native side polls the ReplayInf per-stage
  counter via /proc/pid/mem (0x18b8a28 → counter, 0x164d2cc stage) and
  screenshots every 300 frames through both stages of th8_udLy01; port side
  steps deterministically through `?test=1&paused=1` and screenshots the
  same checkpoints. 81 aligned pairs diffed (tmp/fa-diff*). Fixed: (1)
  dialogue op4 confirm is LEVEL-triggered with the gui+0x21830 arm
  thresholds (30 after timeout / 8 after confirm) plus a §7-flagged
  1.5f/char floor — the rising-edge rule had stalled every dialogue wait
  for its full 500-frame timeout (~600 real frames per line) and dragged
  the mid-stage timeline by thousands of frames; dialogue windows now match
  native at checkpoint granularity and stage-1 visual diff dropped 5.4%.
  (2) Boss lifebar geometry re-measured from the aligned captures (3px at
  y19, x48..368, white fill, near-black slot) — the old 2px/380px grey
  strip and its test replaced. Disproved en route: the §2 rising-edge
  dialogue note (fixture input histogram is the counter-evidence); the
  "night-blindness bus drives stage 1/2 opening darkness" implication (the
  DAT_004e3d24/28 veil only fires via ECL ins_136 — the fixture's stage-2
  Mystia-finale segment — while the opening darkness is the D3D fog, see
  §7). Formal baselines unchanged (st1 f3192 / st2 f3367); 212 unit tests
  green.

- 2026-08-27 (pass 2, user-directed: No-Miss 1-2面 + browser replay
  playback): the provided th8_udF112.rpy turned out to be a Border Team
  Lunatic STAGE-3 PRACTICE file (single block in slot 3, thprac-style 8
  lives/full power) — it cannot drive stages 1-2 and stage 3 is out of
  scope; committed as picker-behavior fixture. th8_udLy01 IS a native
  1-2面 no-death run (6→6 lives across blocks; the one f676 contact is
  deathbombed) and stays the convergence oracle. Shipped: browser replay
  load & playback (title Replay entry → Th08ReplayScene picker →
  startReplayStage with the verifier's exact T8RP entry restore;
  per-frame parity with the verifier proven through st1 f3300 including
  the f3192 phantom contact). Verifier feed switched to ReplayInputSource
  (edges + Z/X dual-map; the old pressed=null inputBits suppressed the
  tally shoot-confirm edge — see the clear-check artifact in §7).
  Findings recorded in §7: stage timeline structurally aligned (midboss
  t2935 exact, boss f5617, dialogue skip f5607); node harness ≡ browser
  per-frame (stub assets proved inert, draw() proved stateless); damage
  pipeline (70 cap, /7 spell tiering, /5*10 trickle) verified against
  all.c:21440-21560 with measured distributions; the /7 spell rule is
  TH08-native (gated by flags2 bit3 + the spell-manager bit0, NOT a TH07
  carry-over as the old comment claimed); NEW top residual = boss-fight
  DPS/pacing (~2.5-3x slow, pools/hitboxes/rank all authored-verified);
  unified phantom hypothesis = RNG draw drift opening in (600,900].
  Tooling lesson: the analyze_image MCP vision tool is STATEFUL across
  calls — it hallucinated HUD digits onto cropped playfield shots that
  contain no HUD, echoing numbers from earlier queries in the same
  conversation (a false "exact native match" that cost an investigation
  loop). Never read numbers from images it wasn't shown; crop-and-zoom
  the actual region or use pixel probes.
