# AGENTS.md

## 0. TH08 fork overlay (authoritative while this branch exists)

This branch is the Touhou 08 / Imperishable Night vertical-slice port. Treat
the legacy TH07 text below as parent-engine history, not as format authority:

- Original authority is `reference/Th08.exe` v1.00d and the unpacked files in
  `reference/th08-original/`; use `reference/th08-decomp/` and
  `reference/re-specs/th08-*` as cross-validation.
- TH08 facts override TH07 facts: ECL has a leading `0x800` magic and v2
  timelines; ANM entries are version 3; MSG text payloads are XOR `0x77`;
  SHT uses 56-byte headers and records; replays are T8RP with a `0x68`
  header and stage blocks containing a `0x24`-byte metadata header followed
  by `N x u16` input records (v6 has NO per-frame aux word; the playback
  feed FUN_00452550 strides 2, the recorder FUN_00452310 writes one u16 per
  frame; the stride-6 feed FUN_004526c0 is for pre-v6 images only).
- The first deliverable is Stage 1 + Reimu/Yukari Border Team + the original
  menus/UI, aligned to `replay/th8_udLy01.rpy`. Do not spend time on TH07
  Extra/Phantasm/Cherry behavior except where shared engine code still needs
  to be excised safely.
- Runtime directories will move to `assets/th08-img`, `assets/audio/th08`,
  and `assets/sfx/th08`; nothing under `reference/` or `replay/` may ship.

### TH08 vertical-slice checkpoint (2026-08-15)

TH08 Stage 1 runs end-to-end: the title/difficulty/team menu flow, the
Border Team, dialogue, HUD, and the replay harness are all live. The
dispatch key is `character === 'reimuYukari'`; the TH07 engine path
(MenuFlow, CherrySystem, TH07_DATA stage tables, PLAYER_SPRITE_BASE shots)
is retained verbatim for every other character, keeping the TH07 sim
suite, golden digest, and `replay:verify` green as the shared-engine
regression net.

2026-08-17 decompile-fidelity pass (commits 9a5e7d3/86dc560/3737b2e):
the TH08 timeline v2 dispatch now mirrors FUN_0042a8a0 case-for-case
(spawn ops 0-5/11/12/15 with per-op layouts, mirror set {1,4,5,12},
dialogue/boss holds, the 13/14 timeline latch, per-difficulty rank byte);
enemy art resolves through the two-file rule (flags2 bit2 selects the
common enemy.anm vs the stage stgNenm.anm — asm 0x419850/0x419acc);
ins_127 registers the boss slot; ins_2/ins_160 are clock SetCurrents, not
blocking waits; player shots use sht.sprite+10 with the exe's init/tick
callback split (aim-at-spawn vs the 40-frame-gated seek) and TH08's
20-frame fire cycle; the bullet command queue runs 0x20000/0x4000/
0x80000/0x40000 with up to 16 ins_111 slots; all ANM v3 opcodes in the
embedded data are implemented.

2026-08-17 second convergence pass (commits 634704d/f106ff8/7dc4333) —
five more exe-proven root fixes, each against all.c:

1. **T8RP record format**: stage blocks are `{0x24 metadata, N×u16 inputs}`
   (stage 1 = 10504 frames, cross-validated by the 352-byte slowdown
   trailer = 1 + ceil(10504/30)). The earlier `0x40 + 4-byte {input,aux}`
   parse halved the stage and misaligned every input — every pre-fix
   "player path verified" claim was circular.
2. **Auto-fire capture replay** read the FIRE flags dword one slot past
   the 11-dword image (`gi(8)` → undefined → 0): every auto-fired volley
   lost its spawn-state slowdown/backup + sfx + fire gates. Fixed to
   `gi(7)`.
3. **Arith ops 10-19** are two-operand compound assigns (`dst op= src`;
   exe cases 9-0x12), not TH07's three-operand forms; the remap zeroed
   Sub0's chase-curve targets (`0.6*(player-enemy)+enemy`), so fairies
   never entered the shot column.
4. **Timeline holds NET-FREEZE the clock** (2026-08-19 correction of the
   2026-08-17 claim that they advance it): op 7/10/13 each call
   FUN_00418110 (ZunTimer::Subtract 1) *before* `goto LAB_0042ad52`
   (ZunTimer::Tick +1) — net zero while parked (asm 42abdc/42ac3d/42ac81).
   The dispatcher fires an op only when the clock equals its time exactly,
   so a parked-but-running clock would skip every op between two holds.
   Stage-1 proof: post-midboss waves sit at t=2935..3735 with the midboss
   hold parked at 2935 (they stream ~800 real frames after the midboss
   dies), and the pre-boss dialogue at t=4175 lands midboss-death + ~1240
   frames. The old "+1236 frames is wrong" reading had the polarity
   backwards.
5. **TH08 death mode** lives in flags bits 20-22 (ins_129; the switch at
   all.c:21639), not the TH07 deathMode field — reading the wrong field
   skipped every death callback, so the midboss never ran her phase-exit
   sub (end spell → unregister → boss-intro chain).

Plus: the TH08 rank table (DAT_004c7880: E/N 10/8/16, H/L 8/8/12,
Ex 16/15/16 — not TH07's 16-start/[10,32]); MSG op13 skippable + Ctrl
fast-forward + op6 resume ticket releasing the op-7 dialogue hold
mid-conversation (gui-run-msg.c:33/116/228); item launch vy −2.1875 and
the y≥3.0 → vy=3.0 fall snap (all.c:31109-31121) replacing TH07's
gradual cap; and the run-global float bank vars 10061-10068
(DAT_004ece20..3c) backing the boss's shared pattern parameters.

Verifier state (replay:verify:th08): the full 10504-frame stage plays;
midboss engages/dies, boss spawns, intro+pre-battle chat chain runs, and
a dialogue-tapping playthrough CLEARS the stage. Residual divergence:
7 phantom deaths (f684/1011/1338/1779/2197/2664/3117 after the gauge/bomb
alignment), measured as AABB Y-axis contacts with 0.48-1.86px of slack —
the needed correction is uniformly "bullet ~0.5-1.9px higher in Y" with no
age/flight-length correlation. Every link (player path, volley phase,
fan/ring shape, speeds with the rank bump, spawn-state lifecycle incl. the
TH08 state machine 0x431240 case-2/3/4 half-move -> same-tick case-1
fallthrough, kill box 0x44a230 AABB with player sht.hitbox/2 and bullet
size +0xd34, graze order, scheduler order, slowdown cadence) is
decompile-verified; the residual is sub-frame and needs a native
per-frame trace to pin — wine still cannot boot Th08.exe in this
environment, so the trace procedure in scripts/native-trace.mjs stays for
a working host.

2026-08-18 presentation pass — five more systems from the v1.00d decompile
(src/game/th08-declaration.ts is new; face_cdbg.anm is now embedded):
- **Player spell-card declaration** (the bomb cut-in): FUN_0040be30 calls
  FUN_00415d60 on the declaration manager singleton (0x4ea670) for EVERY
  bomb. Names are rdata strings — 霊符「夢想妙珠」(0x4b43a0, type 0),
  境符「四重結界」(0x4b44f4, type 1), 神霊「夢想封印　瞬」(0x4b43bc,
  type 2), 境界「永夜四重結界」(0x4b4508, type 3); the selector (be30's
  EDX) picks the side's face file (rm00/yk00), and be30 param_6=1 (both
  deathbombs, like every enemy declaration) binds the RED banner sprite
  variant (face_cdbg sprite 1). FUN_004069f0 indexes the ARCHIVE's script
  table (file order) — player banners are face_cdbg scripts 0 (vertical
  strip) and 2 (the -pi/2 full-width band), the name is text.anm script 4
  (waits at ins_21(1); FUN_00416130's bomb-end interrupt releases it).
  Names are canvas-typeset (text.anm's '@' texture is exe-runtime).
- **TH08 sfx ids are a different table** (.data 0x4c81b0, 36 files, loader
  loop 0x45d45f; FUN_0045d550/FUN_0045d660 play by this index — the second
  arg is a pan/x position). Every id from 1 on is offset from TH07's;
  playSfx dispatches TH08_SFX_SLOTS when runState is TH08. Bomb start =
  id 13 (se_lazer00) + the declaration's id 14 (se_lazer01); shot fire =
  id 0 (se_plst00, identical file in both games); graze 24, player death
  2, item 18, impact damage 17, powerup chime 25, extend 22, pause 26.
- **Shot impact visuals**: the settle (all.c:40420-40438) re-arms the shot
  VM to script sprite+0xb (the odd-numbered 30-frame fade-out family in
  player00.anm entry 0) and spawns effect 5 — DAT_004c6d30 maps effect ids
  to etama ARCHIVE script indices (5→37, 6→38, 12→44) — so TH08 effects
  run on an etama-bound layer; the old host fed those indices to a
  player00-bound layer and every bomb/effect visual silently culled.
- **Bomb clocks split**: be30's param_4 (player+0xfe4) is the ACTIVE
  length 200/150/200/250 — the machine's end compare (0x44c667), the
  staggered-burst gate (param_4-0x28-i), the type-0 force-burst gate
  (param_4-0x1e, which must gate BOTH the seek and spiral phases), and the
  gauge denominator (±trunc(26000/param_4), 0x44c81b). param_5 arms the
  separate LONGER invuln clock at +0xe2af4 (260/200/260/300). The orb
  burst fires the orb VM's interrupt 1 (player00 script 19: 6x balloon,
  20-frame fade, delete); the orb seek's turn denominator is speed/8
  (_DAT_004b4300).
- **ANM interp channels run on a monotonic tick**, not the script clock
  (exe AnmVm::interpCurrentTimers advance per tick and ignore
  currentTimeInScript resets): op5 loop jumps and interrupt entries no
  longer freeze armed tweens (this made the banner fade-ins vanish).

2026-08-18 mechanics pass (commit cb42c0f) — four systems aligned from the
v1.00d decompilation, replacing inherited-TH07 or speculative behavior:
- Familiar lunge (0x44e3a0 sub-3 via 0x44e770's tail): the enemy manager's
  pointer cache (0x18b89b4, written at 0x42d4a6 through the ABSOLUTE
  address — greppable only as a raw address, not [reg+disp]) arms after 10
  firing-cycle frames; Ran's anchor becomes (enemy.x, max(32, enemy.y+32)).
  The primary cache (0x18b899c, max-y enemy) feeds the amulet seeker
  (0x450320) and the human bomb. ply00as needles (funcs[0]=1) spawn from
  the lunging option aimed at the pointer-cache enemy at speed x1.5
  (0x450240 + 0x4b4438).
- Youkai gauge (0x44bdf0 block + call sites): fire drift ±20/frame
  (focusTimer/15 past 300 frames since the last focus toggle) while the
  cycle is armed and focus stable >=30f; idle drift 2/3/5 by depth (tint
  ±2000, effects ±8000, limits ±10000 — 0x44d9ee config); kills ∓200,
  grazes +100, dialogue start −gauge/12, bombs ±26000/duration (bypass).
- Bombs: the real dispatch is ONE per-frame callback per bomb from the
  table at player+0x1000 = rdata 0x4c7ad0 team block {0x40c010 unfocused,
  0x410c40 focused, 0x40c910/0x410fe0 deathbombs, 0x40d100 last spell} —
  NOT the 0x40c820 youkai block (that table at +0x1014 is never
  dispatched). 0x40be30's param_4 (player+0xfe4) is the ACTIVE length
  200/150/200/250 (the end compare, the burst gates, and the ±26000 gauge
  denominator); param_5 (the +0xe2af4 clock) is the LONGER invulnerability
  260/200/260/300. Deathbomb inverts the side and costs 2 bombs when
  stocked. The old Th08BorderBombSim (null damage, invented geometry) is
  deleted.
- 決死結界: SHT 18-frame window; FUN_0044d2c0's white 768x896 flash draws
  while it runs.
player00.anm entry 1 (spriteBase 44, on-disk scripts 19-22) holds the bomb
art; PlayerEffects now resolves entry-scoped sprite tables for it.

2026-08-19 pacing/convergence pass (commits 7e142c6/c161589/7232e34) —
three more exe-proven roots, each reversing or extending a prior claim:
- **Timeline holds NET-FREEZE the clock** (corrects the 2026-08-17 bullet 4
  above): op 7/10/13 each call FUN_00418110 (ZunTimer::Subtract 1) BEFORE
  `goto LAB_0042ad52` (Tick +1) — net zero while parked (asm 42abdc/42ac3d/
  42ac81). The dispatcher fires ops only on exact clock match, so the old
  "advance" reading compacted every op between two holds: the post-midboss
  waves (t=2935..3735, timed FROM midboss death) all fired at once and the
  boss appeared immediately at midboss-death instead of ~1240 frames later.
- **Gui::StartMsg's field clears** (FUN_0043396d tail, all.c:24655-24657):
  FUN_00415c60 (bullets→time orbs + laser cancel), FUN_0042efb0(0,0)
  (ordinary-enemy sweep via the hp=0 death path, value cap 0, return
  discarded — the spare bits are flags1 bit1 / flags2 bit6), FUN_004413e0
  (live player shots flagged harmless drifting at (0,−0.5), re-asserted
  every MSG frame; reset only on death/last-spell, never after dialogue).
  NO force-collect: items keep falling; the player keeps moving; the STD
  background keeps scrolling. The port previously force-collected and
  skipped the sweep — that was the "shot mid-conversation" bug.
- **Bullet spawn-transition**: creep is vel·(½, ¼, ⅛) for states 2/3/4
  (0x431240 immediates 0x40000000/0x40200000/0x40400000 — TH07's ½, 1/2.5,
  ⅓ do not carry over), and the transition spans duration+2 manager ticks
  (FUN_0045e430 constructs the VM with no synchronous t0 pass; the
  finished-report lands a tick after the terminal op itself). The +2 parity
  is empirically pinned by the fixture (see below); the exact VM-internal
  reason is inferred, not single-stepped.
- The auto-fire re-execution (FUN_00423150 → FUN_00422720) builds its
  template origin from the loop-head position snapshot (+0x2d88 sync at
  0x418520) + muzzle offset, not the live post-move position.
- Corollary facts re-verified first-hand this pass: FIRE angle-mode 3 is
  `row·spread + base + col·2π/count1` (all.c:22727-22733, no π/count1
  phase, no aim); bullet hit sizes ARE prototype-derived with sprite-2
  rice = 4.0 (AddedCallback all.c:24344-24420 — the 0x40800000 case); the
  machine-gun capture/auto-fire deadline chain (ins_107/96/108 + ins_105
  reading timeline-spawned var 10000 = 30 → deadline 33 at rank 8) works
  and fires every 33 ticks; rank stays 8 through f545 (no adjustRank
  events), so rankSpeed −0.25 is correct for the early waves.
- Verifier state after this pass: the f685 phantom death (the f530 ring's
  crossing band) is GONE; the first divergence is now the f830 machine-gun
  family (row-3 speed-1.5667 bullet, player rides its line, dy 0.48 —
  ±1 tick of fire phase or transition parity both still contact; needs
  ~2 ticks of lead, and the machine-gun phase knob −2 only moves the
  contact to f829). The remaining deaths are cascade-dominated; the
  midboss dies at wall +1444 in our run, shifting all post-midboss
  content vs the recording. Item economy is thin (47 point spawns vs 61
  native collects with the player invulnerable). Next threads: item drop
  tables/counts per kill, and a per-frame native trace when a wine-capable
  host exists.

2026-08-19 familiar (使魔) system pass — the human/youkai tangibility
system decoded end-to-end from v1.00d (polarity NOTE: human form
MATERIALIZES familiars; youkai form etherealizes them — confirmed by the
collision gates AND by the sound names: the player→human transition plays
se_opshow, player→youkai plays se_ophide):
- Player form byte (player+5, FUN_0040bc40): teams follow the focus key
  through a stability gate — the native counter (player+8, reset each
  toggle) must exceed 6, i.e. the flip lands on the 8th frame counting the
  toggle (FUN_0044aec0 @ player-other.c:135-190; solos pin by char-index
  parity). Port: `player.th08Form` (1-based th08FocusFrames > 7). The
  toggle branch also plays the transition tints (effect 0x1c blue
  0x808080ff → human / 0x1d red 0x80ff8080 → youkai, only after the
  previous form held >= 5 frames) and arms the focus aura VM (effect 0x16
  = etama archive 54, interrupt 1 on release). Bomb side selection reads
  the FORM byte, not the raw key.
- Familiars = child spawns ops 90-93 (exe cases 0x59-0x5c, all.c:
  12020-12117): the child gets flags bit 8 (the side-sync marker), bit 11
  = the player's CURRENT form, manager list id (0 = player-youkai / 2 =
  player-human — `(-(form!=0)&0xfe)+2`), body contact cleared (bit 2),
  the marker VM (FUN_00425b70(0x20) → etama archive 48, interrupt label
  form?2:1), parent link +0x2da4, and sfx id 36 (se_option). Stage 1:
  Sub19/20 (Wriggle's familiars, ~f3600) and the boss's 6-familiar waves
  (~f4025+); the children's own FIRE(16) re-arms bit 6/bit 2.
- Per-tick side sync (FUN_0042c420 @ all.c:21146-21185, flags-bit-8
  enemies): on a form flip the familiar plays effect 0x1e (red
  0x80803030 → human) or 0x1f (blue 0x80303080 → youkai), marker
  interrupt 1/2, sfx 39 (se_opshow) / 40 (se_ophide), relinks the list,
  and re-syncs bit 11; +0x3330 = 0x40 youkai / 0x20 human.
- Tangibility gates: the manager's damage AND contact AND pointer-cache
  block all require bit11 == 0 (all.c:21448-21595) — an ethereal familiar
  (player youkai) is unshootable, contact-free, and graze-free. Lab_
  0042db0b (all.c:21731-21763): bit11==1 holds the enemy VM's color1 at
  R=G=0x20, B base, ALPHA HALVED (the ghost tint; color1 sits at
  enemy+0x200 — VM base +0x60, fields +0x1a0/+0x1a4); bit11==0 gives the
  1-frame damage flash (R=0xff, G=0x60) + hit sfx 20/37 by spell tier.
- Reimu's special skill (FUN_0042c290 @ all.c:21097-21111): Border Team
  and solo Reimu (DAT_0164d0b1 0/4) take NO body contact from familiars
  (FUN_0041fd20 = is-familiar, +0x2da4 != 0); other teams do while
  materialized. FUN_0041fd20 also decrements the parent's child count on
  the child's own death.
- ECL form-rank gate (all.c:10801): a FAMILIAR's instruction masks must
  additionally contain the form bit (0x20 human / 0x40 youkai) —
  enemy+0x3330 ORs into the difficulty bits. Stage-1 census: masks are
  0xff/0xf1-family plus ONE 0x5f row (Sub42's FIRE, youkai+Extra) — inert
  for non-familiars in the main game.
- Op 184's receiver is the GLOBAL side mirror (singleton 0x4ea670 dword
  bit 11, `mov ecx,0x4ea670` @ 0x41e7da) — NOT the running enemy. Every
  boss/midboss phase sub opens with ins_184(1). Known reader:
  FUN_00416b10 gates the spell-bonus accumulator on the bit being clear.
- Familiar death: killed-by-damage fires marker interrupt 3 (all.c:
  21643-6); a master's death sweeps its children (FUN_0042adb0(1) @
  20440-20544): pos-inherit children snapshot the master pos, flags bit
  10 set, parent links cleared, death mode 8 (silent pop, enep00), then
  the time-orb shower at the master pos — 2 per familiar scattered by
  (frand*128, frand*pi) draws, plus FUN_0044df00's 16-orb burst pool
  registration (pos, 32.0, 1.0, 0x10, 7).
- SFX table REBUILT (the old id==name-index table was wrong from id 2 on):
  the exe plays through a 46-channel id table (.data 0x4c8040, stride 8:
  {u32 srcBank, i16 volA@+4, i16 volB@+6}) over the 36-file name table at
  0x4c81b0; FUN_0045d3f0 preloads one channel per id cloning bank
  record.src with SetVolume(volA) (gain = 10^(volA/2000)). Key ids: 0/1
  plst00 (two volumes), 2/3 enep00 (-1200/-1500 — the kill alternation,
  resolving the old "+2 bank-site" flag), 4 pldead00 (miss), 13 gun00
  (bomb cast), 14 cat00 (declaration), 20 damage00, 21 item00, 28 extend,
  30/32 graze (two volumes), 31 powerup, 34 pause, 36 option (familiar
  spawn), 37 damage01, 39 opshow, 40 ophide, 44 item01, 45 ok00-loud.

Verification oracle for text-mode reviewers, measured on the TH08 build
(dev-shot, 640x480 regions, tolerances ±12 on color / ±10 on texture).
NOTE: the headless advance() batches skip per-frame draws, so the sidebar
label cascade (front.anm entry-0 scripts -27..-12) only completes under a
live rAF loop — headless `side` bands read dimmer/flatter than the live
game. Use an unpaused 3s capture for the settled-HUD truth.

| frame | play (32,16,384,448) | side (424,16,200,448) | lower (32,448,384,16) |
|---|---|---|---|
| 300 | bright ≈4, texture ≈4% | bright ≈18, texture ≈3% (headless cascade) | bright ≈21, texture ≈97% |
| 800 | bright ≈8, texture ≈5% (fairies live) | bright ≈19, texture ≈8% | bright ≈11, texture ≈7% |
| 2500 | bright ≈32, texture ≈26% (dense waves) | bright ≈24, texture ≈15% | bright ≈34, texture ≈99% |
| ~4600 (boss, setLives) | bright ≈19, texture ≈50% (spell danmaku) | bright ≈30, texture ≈39% | bright ≈25, texture ≈65% |

Native-playfield references live in `reference/native-shots/` (Wine +
Xvfb userdemo captures, play/side/lower bands in pixel-report.txt).


Operating manual for AI agents and contributors. It encodes the working
rules, the verification loop, the file-format facts, and the orchestration
protocol that produced the current codebase. Follow it exactly; nearly
every rule in it was earned by a real defect.

## 1. Mission

Reimplement **Touhou Youyoumu ~ Perfect Cherry Blossom (TH07)** in
TypeScript for the browser, driven by the original game data. Stages 1-8
are data-driven and playable; the current fidelity target is original-grade
Stage 1-6 behavior and presentation. Extra/Phantasm remain lower-confidence.

**Default rule: reproduce the original game exactly.** Do not simplify,
rebalance, redesign, modernize, or approximate original behavior unless it
is explicitly approved here or requested by the user. The engine is
*data-driven*: original `.ecl/.std/.anm/.msg/.sht` binaries are embedded
(`src/data/th07-data.ts`) and executed by our parsers and VMs. Hand-written
behavior is a last resort and must carry a comment flagging it.

## 2. Authority order

When sources conflict, higher wins:

1. Current user instruction.
2. Approved modernizations (§3).
3. Original data and executable in `reference/`: readable disassemblies in
   `reference/ECL7|DSTD7|MSG7|ANM7`, raw unpacked files in
   `reference/th07-original/`, `reference/Th07.exe` (v1.00b) for Ghidra.
4. Existing project implementation.
5. External docs (thtk source, PyTouhou, priw8's sht-webedit docs, wikis) —
   cross-validation only, never sole authority. TH06 semantics are NOT
   TH07 semantics; several opcode tables differ (§6).

`reference/` is git-ignored, local-only, read-only. Never commit, ship, or
serve it. Browser runtime code must never read from it.

**Current implementation is not proof of correctness.** If the data says
otherwise, the implementation is wrong.

## 3. Approved modernizations

- Focus hitbox dot rendering while focused (collision identical).
- Dev/debug tooling (`?test=1` hook, `dev-shot`/`dev-menu` scripts) — must
  not change shipped gameplay behavior.
- Web Audio BGM looping via `loopStart/loopEnd` sample frames from
  `thbgm.fmt` instead of whole-file loops.
- Plain-text control hints on menu screens.
- Stage-start player fly-in: the original places the player in-residence at
  the spawn point with a 240-frame invuln window and no entrance animation
  (its init preloads the materialize timer past its threshold). On stage
  start we instead fly the player up from below the playfield over 60
  frames (input/firing locked, invulnerable), then hand off to that
  240-frame invuln. Respawn after death is unchanged. Player-only visual;
  no gameplay, timing, or collision semantics change once landed.
- Low-latency canvas presentation, ON by default: the display context is
  requested with `desynchronized: true` (+ `alpha: false`). Browsers that
  grant it (Chromium) skip 1–2 compositor vsyncs; the renderer then draws
  every frame to an offscreen backbuffer and `present()` copies it in one
  op — a granted context is never drawn incrementally (that incremental
  front-buffer drawing was the 8552afe Stage-5 spell-card flicker, before
  the backbuffer existed). Non-granting browsers feature-detect (context
  attribute readback, no UA sniffing) to the direct path, byte-identical
  to the old behavior. Output pixels are identical either way; sim/replay
  untouched. Kill switches: `?desync=0` (player-facing), `?backbuffer=1`
  (test-only, forces the present() path on engines that never grant).
  Note: headless Chromium GRANTS desynchronized, so every headless harness
  exercises the backbuffer path; readback/screenshots cannot prove scanout
  flicker absent — a manual Stage-5 spell-card eyeball on real desktop
  Chrome stays part of acceptance for presentation-layer changes.

Nothing else. In particular: **no invented visual content**. If the data
has no moon, there is no moon. Absence of data gets a flagged fallback and
a report, not fabrication.

## 4. Non-negotiable invariants

Every commit must satisfy ALL of:

1. `npm run check` — zero TypeScript errors.
2. `npm run build` — clean esbuild bundle.
3. `npm test` — all unit tests pass.
4. Clean headless boot: `node scripts/dev-shot.mjs /tmp/s.png 300` prints a
   snapshot with enemies spawning and **no `PAGE ERRORS` line**.
5. No isolation hacks in the tree: no debugging early-`return`, no
   commented-out subsystems, no hardcoded test state. A crashed agent once
   left `return;` at the top of `drawBackground()` — it made all code after
   it unreachable, which disables TypeScript control-flow narrowing and
   produced seven phantom "possibly null" errors. Treat unreachable code as
   a build breaker.
6. Nothing from `reference/` committed — no bytes, no long decompiled
   listings. Recovered *constants* with a provenance comment
   (`// Th07.exe (v1.00b) @ 0x43cb30`) are fine and encouraged.
7. `index.html` keeps working as a static page (esbuild IIFE bundle, no
   ESM imports at runtime, no dev-server-only paths).

## 5. The verification loop (how quality actually happens)

Code that typechecks is not done. **Done means observed working.** The
protocol below is designed for **text-only models**: every check yields
machine-readable text (state snapshots and pixel statistics), and no step
requires viewing an image. If your model does have vision, viewing the
screenshots is a bonus check on top — never a substitute for the numbers.

For any gameplay or visual change:

1. `npm run check && npm run build && npm test`.
   `npm test` includes the **replay-golden digest lock**
   (tests/th07-replay-golden.test.mjs): the committed real-play replay
   (tests/replays/th7_udFe25.rpy) is re-simulated headlessly and sparse
   per-frame state digests are compared — any simulation-behavior change
   fails it at the exact frame the change first manifests. If YOUR change
   intentionally alters gameplay (an alignment fix), regenerate with
   `UPDATE_REPLAY_GOLDEN=1 npm test` and commit the digest diff with the fix.
2. For bullet/timing/aim fidelity questions, run
   **`npm run replay:verify`** — it replays the fixture stage-by-stage in
   pure Node and compares our end-of-stage state against the NEXT stage's
   recorded snapshot (ground truth written by the original engine), reporting
   per-field diffs plus every unexpected player death with the killing
   bullet's provenance (owner enemy, ECL sub, spawn frame, angle/speed).
   PASS additionally requires all **seven** AUX event streams (§6) to match
   frame for frame, and each stage prints one `EARLIEST DIVERGENCE` line —
   the minimum over the seven streams, which is the number to drive a
   convergence loop with. Flags: `--all` runs every local `replay/*.rpy`
   plus the fixture and prints a difficulty × stage matrix; `--replay a,b`
   takes an explicit list; `--trace A,B` dumps per-frame JSONL;
   `--trace-damage A,B` dumps every player-shot→enemy contact and the
   per-enemy damage settlement (use this when a boss/enemy dies N frames
   early or late); `--dump-frame F` dumps a full snapshot.
   Format + workflow spec: reference/re-specs/exe-replay.md.
3. Drive the affected states headlessly and read the **snapshot JSON**
   (entity counts, positions, boss/spell state, cherry, player) printed by
   the tools. Assert the fields your change should have moved — and that
   the ones it shouldn't have moved didn't.
4. For anything rendered, run **`node scripts/pixel-report.mjs <shot.png>`**
   and compare against the baseline table below. The report samples named
   regions (in 640×480 game coordinates) and prints average color,
   brightness, texture % (pixels far from the region mean — detail
   present), distinct-color count, and the center pixel. Custom regions:
   append `x,y,w,h:label` args.
5. Iterate until snapshot + probes match the criteria. A change verified
   only by "it compiles" is assumed broken — this project's worst
   regressions all shipped in changes that compiled fine.

Baseline probe values (measured on a healthy build, frame 800, Lunatic;
tolerances ±12 on color channels, ±10 on texture % unless noted):

| region | healthy reading | failure signature |
|---|---|---|
| `sky` | lavender-grey avg (≈`#acaacd`), texture ≤3% | high texture = geometry leaking above fog |
| `ground-left/center/right` | texture ≥6% all three (7–60%; ground-right runs 7–8% under the upright-billboard tree renderer — `pixel-gate.mjs` enforces ≥6) | any side flat at fog color (≈`#8080c0`, texture ≤3%) = missing geometry / instance-culling void |
| `frame-left/right` | avg ≈`#400e20`, texture 0% | near-black = frame tiles not drawn; shifted avg = wrong tile rect |
| `hud-labels` | texture ≈30–45%, ≥100 colors | texture ≤5% = labels missing/misanchored |
| `hud-digits` | texture ≥20% | 0% = digit font not rendering |
| `logo` | texture ≥80%, ≥200 colors, green channel present | flat maroon = logo missing |
| `cherry-banner` | texture ≥15% | flat = banner/value missing |
| `player-zone` | bright ≥140, texture ≥50% (at spawn, alive) | flat ground reading = player not drawn (or moved/dead — cross-check snapshot `player`) |

If a reading is out of band, the *pair* of snapshot JSON + probe row
usually identifies the subsystem before any code reading (e.g. snapshot
says `enemies:19` but playfield probes are all flat → rendering, not
simulation).

Tools (they serve the repo over a local static server and drive headless
Chromium at `/opt/pw-browsers/chromium-*/chrome-linux/chrome`; run
`npm run build` first — they load `dist/th07.js`):

- `node scripts/dev-shot.mjs <out.png> [frames] [query] [heldKeys]`
  Boots `index.html?test=1&<query>`, advances N frames (keys held per
  30-frame batch), screenshots 1280×960, prints a JSON snapshot (enemies,
  bullets, playerBullets + dump, boss, spellName, cherry, player) plus any
  page errors. Useful query params: `difficulty=0..3`, `shot=reimuA|…`,
  `power=0..128`, `menu=1`.
- `node scripts/dev-menu.mjs <outdir> "<step>;<step>;…"`
  Edge-triggered menu navigation (holding a key ≠ pressing it; menus need
  press edges). Step = `key@shotName` or `N*key@shotName`; keys:
  `up down left right confirm back`, plus `wait`. Screenshots and snapshot
  JSON per named step.
- `node scripts/pixel-report.mjs <shot.png> [x,y,w,h:label ...]`
  Region statistics for text-mode visual verification (see step 3 above).
- `node scripts/audit-th07-player.mjs`
  Dumps all 12 `.sht` files through the real parser (header + every
  shooter record per power bracket) for regression diffing.
- `node scripts/desync-stage5-probe.mjs --require-desync`
  Presentation gate for the default-on desynchronized canvas (also run by
  `verify:full`). Reaches a real Stage-5 spell card, resumes the live rAF
  loop, and samples the PRESENTED canvas (`displayPixelAt`) for 3s plus
  first/last screenshots. Pass = exit 0 with `granted:true`,
  `blackPresents:0`, spell held all samples. Exit 3 = grant lost in this
  environment (investigate before trusting other headless results).
- `node scripts/browser-matrix-smoke.mjs --browser firefox|webkit|chromium`
  Cross-engine boot smoke (local-only; `npx playwright install firefox
  webkit` once). Pass 1 asserts shipped defaults (Firefox/WebKit must
  read back `granted:false, backBuffered:false` — the unchanged direct
  path); pass 2 forces `&backbuffer=1` to prove `present()` parity on
  non-Chromium rasterizers.
- `npm run latency:trace` — Chrome event-to-present latency proxy
  (headed). A/B the low-latency canvas with the default arm vs
  `-- --no-desync` (`?desync=0` control); read the grant from the
  report's `canvas.actual.desynchronized` / `desynchronizedGranted`
  fields, never from the CLI flags. `--chrome-major` pins the expected
  browser (148); `--allow-invalid-refresh` for non-144Hz rigs/Xvfb.
  `npm run perf:smoke -- desync=0` is the matching throughput control arm.

Standard stage checkpoints (dev-shot frame → machine-checkable criteria):

| frame | snapshot must show | probes must show |
|---|---|---|
| 120 | enemies ≥1, no errors | `hud-labels` texture ≥30% (cascade done) |
| 800 | enemies >0, bullets >0 (Lunatic) | all three `ground-*` textured; `sky` flat |
| 2500 | score >0 when `shoot` held | `cherry-banner` texture ≥15% |
| 3400 | — | `sky`/`ground-*` avgs visibly darker than at 800 (dark-purple fog section) |
| 5600–6200 | `boss:true`, `spell` non-empty at spell phases | `ground-*` all textured (boss-loop background — no fog-colored void). While a spellcard is ACTIVE the playfield reads the scrolling eff01 sheet instead (dark purple, texture ≥10%) |

Menus (`dev-menu.mjs`): each step's snapshot must report the expected
`scene`/`cursor`/`difficultyName`/`character`/`shotType`; after the final
confirm, `scene:"stage"` with the chosen difficulty and character. Probe
any menu screenshot with custom regions when art placement is in doubt
(e.g. the title logo occupies roughly `64,64,320,176` and should read
texture ≥60%).

## 6. Format facts (do not re-derive; do not assume TH06)

Established by disassembly of this game's own data and, where noted, the
executable. If an implementation fights these facts, the implementation is
wrong.

**Geometry.** Screen 640×480; playfield rect (32,16,384×448). Sprite ids in
multi-entry ANM files are entry-scoped on disk and offset by an entry base
at parse time.

**ANM v2** (`src/formats/anm.ts`): 64-byte entry headers; instruction
encoding `{u16 op, u16 totalLen, i16 time, u16 paramMask}`. Key ops: 3 set
sprite, 6 set position, **22 corner-relative anchor (top-left)**, 8/15
alpha/fade, 9 color, 16 blend, 17/18/19 interp moves, 20 wait-forever,
21 interrupt label (−1 = fallback), 23 hide+wait, 26/27 UV scroll,
30/31 render flags (safe no-ops), 32–36 formula interps (formula 0/7/255
linear, 1=x², 2=x³, 3=x⁴, 4=2x−x², 5=2x−x³, 6=2x−x⁴). `interrupt(id)`
jumps past the matching `ins_21(id)` and forces visible. **Multi-entry
files reuse on-disk script ids across entries** (title01.anm has five
different scripts named id 0) — always resolve scripts and sprites through
an entry-scoped lookup, never a flat id map.

**Anchors.** `Renderer#drawSprite`/`drawAnmFrame` center on (x,y) — entity
semantics. HUD/menu layout coordinates from ANM scripts are top-left
(`ins_22`). Convert at the call site (see `StageScene#blit`). Two separate
HUD reworks shipped half-a-sprite off before this was written down.

**STD** (`src/formats/std.ts`): world axes x lateral, y forward depth,
z height with **negative z = up**. **Quad anchoring is per-script
(AnmManager::Draw3 anchor bits):** op22/anchorTL scripts extend from
their position CORNER by width/height (stage ground tiles, the stage-5
staircase treads/risers); unanchored scripts are CENTERED on position
(stage-5 balustrades, the billboards). autoRotate=2 (ANM op25 arg 2)
scripts are camera-facing billboards (Stage.cpp:1032-1103 →
DrawFacingCamera), not flat slabs. Script ops:
5 camera-position keyframe (args are float bit-patterns even when the
disassembly prints ints), 6 interpolate camera to next keyframe
(duration, easing mode — same formula table as ANM), 7 facing as a
camera-relative direction vector, 8 facing interp, 1 fog (packed ARGB int,
near, far), 2 fog interp duration, 4 jump (loops the script clock;
stage 1 loops frames 5510→6022, a one-tile-exact seamless dolly),
11 FOV (30°). The sky IS the current fog color; cells ≥98% fogged are
skipped (the slack-expanded texture edges otherwise peek past the fog
overlay as streaks). Roadside trees (stage 1/2) and stage-5/7/8 scenery
are autoRotate=2 billboards (see the anchor note above) — drawn
camera-facing with manual euclidean-distance fog, matching the exe.
**Draw order is NOT center-depth sorting**: the exe z-buffers every
background pixel (both zLevel chains share one depth buffer), which
`orderBgJobsByVisibility` emulates by ray-casting through each
screen-overlapping pair's overlap center and drawing the farther plane
first (fallbacks: center depth, then zLevel-chain order for ties).
Center-depth-only sorting tore stage 5 apart — its -45° slope wall
spans the whole staircase run, so its CENTER often sorts nearer than
individual treads while lying behind them.

**ECL** (`src/game/eclvm.ts`, `src/formats/ecl.ts`): header
`{u16 subCount, u16 timelineCount, u32 offsets[16+subs]}`; sub instruction
`{u32 time, u16 id, u16 size, u16 rankMask, u16 paramMask}`. Variables:
there is **NO register window** (an earlier model was disproven against
FUN_0040d750/df90/dda0/e560 + the op41/42 dispatcher cases). Each enemy
carries one 26-dword block (+0x6fc): locals 10000–10015 (ints
10000–10003/10012–10015, floats 10004–10011), two extra floats
10072/10073, rand-int params 10029–10032, rand-float params 10033–10036.
Eight RUN-GLOBALS 10037–10044 (DAT_0133da80..9c) are shared by every
enemy and act as **argument registers**: op41 CALL pushes the whole
0x218-byte frame (cursor + vars + wait timer + op27 interps) and copies
the globals into the callee's param slots; op42 RETURN restores the frame
(callee writes roll back). Interrupt entry pushes the same frame without
the copy; the op144 periodic sub runs on its own persistent stash
(+0x2ee8, exported back at its return via +0x8f4). Var 10056 reads a
random derived from the params (int: base+rng%range from 10029/10030;
float: base+rng01()*range from 10033/10034); 10055 is a raw rng draw;
10060 is a random angle in [−π, π). op92/93 children inherit a copy of
the parent's whole block (FUN_0041db60). Rank masks gate spawns by
difficulty — verify changes on Lunatic (`difficulty=3`), which exercises
paths lower ranks never touch. FIRE copies the enemy's five op79 entries into
each bullet; `FUN_004229f0` promotes at most one movement behavior per normal
bullet-manager tick (construction promotes the first, spawn states pause the
queue, their transition tick resumes it). Unselected and opcode-0x2000 grace
entries may be skipped in the same pass without consuming that one-slot
budget. Spell names (op 90) are XOR-0xAA-obscured Shift-JIS, terminated by a
0xAA byte.

**MSG** (`src/game/dialogue.ts`): ops 0 end, 1 portrait enter, 2 face,
3 text line, 4 wait, 5 portrait state, 6 ECL resume ticket, 7 BGM, 8 boss
intro, 11 hide portraits, 12 BGM fade, 13 skippability.

**SHT** (`src/formats/sht.ts`) — layout verified against priw8's
sht-webedit struct_07 and all 12 real files: 52-byte header
`{i16 ?, i16 levelCount, f32 bombsPerLife, i32 deathbombWindow(15/8/6 for
Reimu/Marisa/Sakuya), f32×8 hitbox/graze/autocollect/itemRadius/cherryLoss/
pocLine/speed/focusedSpeed/diag×2}` then `{u32 offset, u32 powerThreshold}`
pairs (brackets 8/16/32/48/64/80/96/128/999). Shooter record 52 bytes:
`{u16 interval, u16 delay, f32 x,y,hitboxW,hitboxH,angle,speed, i16 damage,
u8 orb, u8 shotType, i16 sprite, i16 sfxId, i32×4 funcs}`. **PCB's shot
timer runs a 30-frame cycle** (Th07.exe FUN_0043a820, counter capped at
0x1e and re-armed while held; external docs claiming 60 were overruled by
disassembly); a delay-0 shooter fires on the press frame itself. Player
sprite ids are SHT sprite + 1024 base.
Bullet hitboxW/H are full widths; enemy-vs-player-bullet AABB is
`(enemyW + bulletW)/2`.

**Exe-recovered constants** (Ghidra, Th07.exe v1.00b — keep provenance
comments): unfocused orb offsets (∓24, 0), focused (∓8, −32); SakuyaB-only
option orbit fully decoded (rate vx·π/200, clamp ±36°, focused cluster
±π/14 at r=24); focus-toggle glide is 8 frames (x lerp, y eased); cherry
border trigger 50000 (0xC350) on **cherryPlus** (not the displayed gauge
cap!), border duration 540 frames (0x21C) with 30-frame fades; initial
**cherryMax** is per difficulty — 200000 E/N, 250000 H, 300000 L
(FUN_0042cf2f @ 0x42cf2f); the bottom-left gauge displays
`cherry/cherryMax` plus a small purple cherryPlus; border-survive score
bonus is `cherry` (×1, not ×10 — the
exe's `bonus*10` immediately `/10` is a lossless compiler no-op); point
item score (case 1 of the item-collect switch) is `v = 50000 − 100·round(y
− pocLine)` (or flat 50000 at/above the line), `+= floor((cherry−50000)/5)`
once cherry exceeds 50000 (or capped down to `cherry` itself if `v`
would've been the flat 50000), floored to tens, **then `score += v/10`**
— the live in-game score field is added-to (and displayed) at ×1 with no
further scaling anywhere in the HUD digit path (confirmed via the raw
"%.8d"/"%.9d" format strings backing the score readout, no appended
digit); see reference/re-specs/exe-cherry-border.md §3c/§4.

**HUD layout**: front.png sprite rects and resting coordinates are decoded
in `src/game/stage-scene.ts` (`FRONT`, `drawSidebar`, `drawFrame`) — labels
column x=432, digit font = ascii.png 8×12 glyphs at texture y=208 (digit d
at x=8d, pitch 8, no comma glyph), 東方妖々夢 logo at (480,208), caption at
(448,336), frame tiled from the 32×32 maroon tile + 128×16 strip (exact
integer fit), boss nameplates are ename.png rows (row 0 Cirno, row 1 Letty)
composited at (32,26), cherry banner at (32,448) showing `cherry/cherryMax`
(cherry right-aligned into the blank slot ending at in-sprite x≈84,
cherryMax after the slash) with the small purple cherryPlus above the
blank (exe draw @ all.c:1760-1870).

**RPY (T7RP replays)**: full spec in reference/re-specs/exe-replay.md;
parser `src/formats/rpy.ts`. Load pipeline (FUN_004402d0): decrypt from
+0x10 with key byte +0x0D (`b -= key; key += 7`), additive checksum
`0x3F000318 + sum(bytes[0x0D..])` == u32@+0x08, then TH06-era bitstream LZSS
from +0x54 (0x2000 window, cursor starts 1, 13-bit absolute pos/4-bit
len−3). Decompressed image: 7+7 stage offset tables @+0x1C/+0x38 (inputs /
slowdown trailers), shot byte (char*2+type) + difficulty + date + name +
final score at body start, then per stage a 0x2C snapshot (score-at-END,
pointItems, cherry, cherryMax, cherryPlus≤50000, graze, extendLevel,
threshold, **u16 RNG seed @+0x20**, power/lives/bombs/rank bytes) followed
by fixed 4-byte frame records (u16 input word + u16 aux, no RLE). Input
bits: 0x1 Z, 0x2 X, 0x4 Shift, 0x8 Esc, 0x10-0x80 directions (numpad
diagonals OR pairs), 0x100 Ctrl-skip, 0x1000 Enter. **Direction chords
resolve by priority — up beats down, right beats left (FUN_0043be00), NOT
vector cancellation**; real replays contain such chords.

**AUX word (second u16 of each frame record, ctx+0x9e)** — the original
engine's own per-frame EVENT STREAM, and therefore the project's densest
frame-exact oracle. All seven bits are verified by `replay:verify`:
`0x1` bomb accepted (all.c:28486, FUN_0043d9a0's trigger branch),
`0x2` player contact registered before the state gate (27780/27914),
`0x4` player MISS — the frame the deathbomb meter reaches 0 and the death
commits, 30 squish frames before the life counter drops (28596),
`0x8` border start (28928), `0x10` border BREAK ONLY — the tail of
FUN_0043eb00; the natural expiry / cherry-full path FUN_0043e620 writes no
bit (28994), `0x20` enemy kill / slot vacate (13887/14351/14360),
`0x40` item collected (22016). `0x100` (29442) is still unidentified.
The pre-2026-07-25 mapping had `bomb` on 0x4 and called 0x1
"border-adjacent, PROBABLE"; both were wrong and both are now confirmed
against the decompile *and* against our own simulation on converged replays.
Rank
(DAT_00625884): recorded per stage; 16 at run start (= the neutral point of
every rank formula), 32 from stage 2 on; no per-frame increment exists in
the exe (machine-code scan) — constant within a stage.

### Native replay convergence checkpoint (2026-07-13)

Stage 1-6 now converge for two independent SakuyaA Lunatic replays. This is
an original-behavior checkpoint, not a golden-only assertion: both were run
without ghosting through the production replay harness, and PASS requires an
authored stage completion, exact next-stage/end fields, exact per-frame AUX
kill/collect/player-contact streams, and the original RNG draw residue. A PRE
row is still defined at the beginning of a replay frame; a mismatch at PRE N
was caused while processing N-1.

Committed fixture `tests/replays/th7_udFe25.rpy`:

| stage | frames run/available | kills | collects | player contacts | RNG |
|---|---:|---:|---:|---:|---|
| 1 | 10476/10477 | 684 exact | 382 exact | 0 exact | 163385, residue exact |
| 2 | 13705/13706 | 396 exact | 494 exact | 0 exact | 203224, residue exact |
| 3 | 15678/15679 | 410 exact | 635 exact | 0 exact | 258253, residue exact |
| 4 | 24445/24446 | 1050 exact | 1056 exact | 0 exact | 279512, residue exact |
| 5 | 19377/19378 | 412 exact | 545 exact | 1 exact | 379003, residue exact |
| 6 | 26434/26436 | 279 exact | 1095 exact | 0 exact | final-stage seed unavailable |

Stage 5's one contact is present in the original AUX stream and is not a
false death. Stage 6 has one recorder-metadata anomaly: the RPY stores score
116283035, while Th07.exe v1.00b's live field and the web engine both retain
116283036 (native PRE25779..26433, `DAT_0061c258+4`). `replay:verify`
reports this as an explicit advisory rather than treating the stale metadata
word as behavior truth.

Independent local LNNN replay `th7_ud8141.rpy` also passes all six stages:
kills are 695/390/351/919/397/279, collects are
408/490/493/491/372/1144, all six player-contact streams are zero, and every
available RNG residue is exact. The file is local evidence and must not be
committed.

The convergence came from shared engine roots, not replay-specific draw
tuning: fixed-capacity slot allocation and manager order; immediate
enemy-outer shot collision/death processing; native ECL variable typing and
call/return/periodic clocks; progressive bullet-EX promotion; raw FIRE
endpoints and float32 constructor staging; float32 enemy writes, mode-2/
mode-3 interpolation, op87 anchors, laser transitions and player-shot AABBs;
Border/invulnerability/slowmo split clocks; item/cancel/Cherry/clear-bonus
ordering; MSG op9/op11 settlement; and exact effect-pool pressure. The last
independent Stage-4 split was a mode-2 float64 residue at x=191.9997406 that
broke an original strict SakuyaA target tie; native f32 staging leaves both
targets at x=192 and retains the first fixed slot. Effects 7 and 8 also
perform the executable's template-5 ANM reset after a laser deflection.

These corrections are engine-wide, but two Lunatic replays do **not** prove
Easy/Normal/Hard convergence. Lower ranks select different ECL instructions,
formulas, bullet counts, and pool-pressure paths. Each difficulty still needs
its own native replay PRE trace plus full event/end-state verification.

### All-difficulty baseline (2026-07-25)

Five further native replays cover every remaining difficulty. They are
third-party recordings and stay **local evidence** under the git-ignored
`replay/` directory — never commit them; `tests/replays/th7_udFe25.rpy`
remains the only fixture and the only CI gate. Run the whole set with
`node scripts/replay-verify.mjs --all`, which prints a difficulty × stage
matrix of PASS / earliest-diverging-frame:

| replay | char | difficulty | st1 | st2 | st3 | st4 | st5 | st6 | st7 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| th7_udFe25 | sakuyaA | Lunatic | PASS | PASS | PASS | PASS | PASS | PASS | — |
| th7_udHm54 | marisaB | **Extra** | — | — | — | — | — | — | **PASS** |
| th7_udSg10 | reimuA | Phantasm | — | — | — | — | — | — | 51989 |
| th7_udMt01 | sakuyaB | Easy | PASS | PASS | PASS | 4536 | 7290 | 1628 |— |
| th7_udYo01 | sakuyaA | Normal | PASS | 8747 | 11863 | 18596 | 2280 | 2727 | — |
| th7_udFi03 | reimuB | Hard | 5440 | 2165 | 537 | 2360 | 617 | 1330 | — |

Extra is fully converged (467 kills, 2064 collects, 4 contacts, 2 bombs,
20 border starts, 2 border breaks — all frame-exact — plus an exact final
score). Phantasm is exact for 51989 of 57876 frames; its boss spell (sub 127)
dies two frames early, i.e. we are ~2 HP ahead over a long spellcard.

Two structural facts to carry into any continuation:

- **`wine`/`winedbg` is not installed in the current environment**, so the
  native PRE-trace procedure below cannot be run here. The AUX streams are
  the substitute oracle. They are dense and frame-exact, but they are not
  complete: an RNG or position divergence that happens to produce no AUX
  event stays invisible until it changes one. Do not read "exact through
  frame N" as "identical through frame N".
- **ReimuB is the only shot type with no passing stage in any replay**, and
  it is the only one that saturates the 96-slot player-shot pool: measured
  at Hard stage 3, the pool is full on 28 of 140 sampled frames with 12-33
  slots held by spent (post-impact) sprites. Every ReimuB divergence
  measured so far is a kill landing a few frames LATE, never early, i.e. we
  deal slightly less damage. Under saturation the impact-sprite lifetime and
  the offscreen cull directly set live-shot count and therefore DPS, so an
  error there that is invisible for Sakuya/Marisa/ReimuA becomes a DPS error
  for ReimuB. Investigate that before anything else on Hard.

### Next-session fidelity workflow

1. Preserve unrelated worktree state and all local evidence. Never commit
   `reference/`, native traces, screenshots, local replays, `tmp/`, `issues/`,
   or `output/`.
2. Re-establish this checkpoint with `npm run replay:verify`, then run the
   replay under investigation without ghosting. Ghost is diagnostic only.
3. At the earliest PRE mismatch, trace native and web fixed enemy,
   player-shot, attack, effect, laser, and enemy-bullet slots plus the exact
   caller/event order. Fix the deterministic upstream root; never compensate
   with an invented RNG draw, count, position epsilon, or replay special case.
4. Add an exe/data-proven focused regression, immediately rerun every already
   converged replay, and regenerate a replay golden only after the original
   behavior change is demonstrated independently.
5. Before a checkpoint commit, run §4/§5 in full: check, build, tests,
   `replay:verify`, clean boot, browser replay, standard Stage-1 snapshots,
   and pixel reports. See `HANDOFF.md` for the concise command list.

**Browser Replay preview status:** implemented and browser-verified. The title
Replay entry opens a browser-local `.rpy` picker (no upload), then uses the
authored `replay00.png` layer for replay metadata, present-stage selection,
and the original three-mode confirmation (normal, recorded-slowdown, and
boss-only). Playback uses the production `Rpy`/`ReplayInputSource`, restores
the native stage snapshot after seed/bootstrap initialization, continues only
through physically adjacent stage slots, and maps the shared seventh slot to
Extra or Phantasm as the difficulty requires. Live ESC owns the two-row replay
pause menu and never consumes a recorded frame. Slowdown trailers preserve
the native leading-byte offset and discrete cadence buckets; skippable-dialogue
and boss-only fast-forward repeat the manager chain to their native modulo
boundaries. Files and decompressed bodies are capped at 16 MiB. Verify the
real browser path with `npm run replay:browser -- <file.rpy> [stage] [frames] [shot.png] [mode]`;
Stage 1 frame 300 and Stage 5 frame 4881 (Youmu portrait plus
`あなた、人間ね`) were observed through this path without page errors, and
all three modes plus pause cursor ownership were exercised. CI runs
`npm run replay:verify` before the Pages build, so Stage 1-6 convergence is a
deployment gate rather than a manual-only checkpoint.


## 7. Approximations registry (known, flagged, improvable)

TH08-slice additions (2026-08-18 second presentation pass, inline comments at the sites):
- FUN_0045d660's second argument tunes playback FREQUENCY (the consumer's
  vtable+0x40 call receives the channel's queued-value average); the port's
  audio bus has no per-request pitch control and ignores it.

TH08-slice additions (2026-08-19 familiar-system pass, inline comments at
the sites):
- The ghost tint's exact channel mapping reads B-base/R=G=0x20/alpha-half
  from the color1 byte writes (enemy+0x200..+0x203 as B,G,R,A); drawn as
  the rgb multiplier 0x2020ff at alpha 0.5. If a native capture later
  shows a red-dimmed ghost instead, swap the channel order at the draw
  site (stage-scene.ts's ghostOpts).
- The master-death time-orb burst: the 2-per-familiar scattered ring is
  draw-order exact ((frand*128, frand*pi) per orb); FUN_0044df00's pool
  registration (pos, 32.0, 1.0, 0x10, 7) is spawned directly as 16 time
  orbs at the master position — the native burst is pool-deferred and its
  release draws are not traced.
- CreateFamiliarPopup (AsciiManager.cpp:522, the time-orb-style kill
  popup for destroyed familiars) is not implemented.
- The familiar-kill gauge settle reuses the shared death-path ±200
  (form-relative); the wiki's "destroying familiars pulls the gauge
  toward 0" was NOT found as a separate exe site.
- op 184's global side mirror (0x4ea670 bit 11) is recorded on
  Th08RunState.th08SideMirror; its consumers (FUN_00416b10's spell-bonus
  accumulator gate) are not wired.
- FUN_0042c420's extra branch (flags2 bit 1 + FUN_0040ebc0(2) → effect
  0x26 white at the familiar) is skipped — the condition is unrecovered.

TH08-slice additions (2026-08-18 presentation pass, inline comments at the sites):
- Declaration banner hold is bounded: face_cdbg's authored hold loops (op5
  JmpDec on var 10008) reset the counter INSIDE the loop body, so they
  never fall through; the native manager force-releases the VMs (site not
  recovered). The port releases at 100f with the authored 50f alpha-out.
- The declaration's fourth native VM (capture.anm flash) reads the
  runtime-generated 'capture:@' surface — not recoverable from data, so
  the cut-in is carried by portrait + banners + typeset name.

TH08-slice additions (2026-08-17, all with inline comments at the site):
- Border Team option-sourced shots spawn at the player center: the exe
  reads the live option-trail struct (player+0x6b0+(src-1)*0x2f4) — the
  trail model is unimplemented.
- TH08 graze award is 2000, doubling to 4000 under a gauge-extreme
  condition (FUN_00406da0's compare reads an unrecovered threshold pair;
  mapped to the ±8000 extremes as PROBABLE).
- The graze COUNTER steps +1..+3 per event in the native (FUN_00406d10/40
  reads on manager threshold u16s at +0x3ddfc..0x3de02); ours steps +1.
  Field 536 vs 270 in the verifier is the counting convention, not a
  geometry gap (event counts match).
- Night-clock stage-tally quota: stage-1 shows /3000 (DAT_004c77f0 row
  confirmed); the exact +1/+2 branch threshold read is unrecovered.
- TH08 bullet-command queue: 0x400000/0x800000/0x1000000 (timer-arm /
  homing-ish / child-spawn) are unused by stage 1 and warn-only.
- Effect-51 visuals use the generic spark fallback; only its lifetime
  (241f) and draw cost (10 u16) are modeled. UV-scroll ops 80/81 record
  but do not scroll (canvas renderer).

## 7. Approximations registry (known, flagged, improvable)

Each also has an inline comment at its code site. Do not silently "fix"
gameplay to taste — improve these only with better evidence (Ghidra, frame
comparisons against real play).

- Frame tiling positions (exact-fit math, engine placement not literal).
- HUD star icon x positions; spell-timer and fps exact placement.
- Cherry+ banner interrupt→state mapping (dim=charging, bright=border).
- Bomb mechanics: the twelve focus-latched forms now run decoded per-form
  state machines (`src/game/player-bombs.ts`) writing the exe's moving
  attack-slot pool (player+0x9dc, consumed by FUN_0043a980). Damage/cancel
  use the slot AABBs (no full-screen sweep). SakuyaB's time-stop freeze
  pulses (FUN_00425f10) are implemented. The shared 60-frame screen tint
  (FUN_00407520) and reserved-slot activation VM (FUN_00407620) are
  represented by the character bomb ANM scripts + the runner, not byte-
  exact VM spawns. Per-form spawn cadence/orb motion are from specs
  spec-bombs-{shared,reimu,marisa,sakuya}.md.
- Player shots run per-shot ANM VMs (SHT `sprite` = global script id; impact
  re-arms `sprite+0x20`; bullet dies when its script ends). MarisaB's two
  persistent-laser forms (3-slot tracker, beam-history ring, helper boxes)
  and MarisaA's repeat-hit missile explosion are implemented. See
  spec-marisab-beams.md / exe-player-funcs1.md.
- Floating score/Cherry popups implemented (spec-popups.md): two ring pools,
  distance-from-player alpha pulse, full color/value rules incl. the
  phase-end escalating sweeps and the red cherry-gain popups.
- Spell-bonus decay rounding: exe writes `floor10(ftol(<register-arg float
  expr>))` per frame (0x41f8a8 region); the port computes
  `floor10(base − decayPerSec·elapsed/60)`. Sub-10-point drift only.
  (The damage cap 70 and op 142 are no longer approximations: cap
  confirmed at all.c:14226; op 142 = N-frame damage shield, boss /9 /
  non-boss 0, countdown at all.c:14440.)
- `ins_30/31` render flags unknown (no-op everywhere, matches PyTouhou).
- Spell declaration presentation: the simple scrolling/static stage sheets
  remain open-coded where their op-4 loops defeat AnmRunner's frame-keyed
  fades. Stage 5 is data-driven through both real `eff05.anm` entry VMs:
  bullet-time effect 10 interrupts both with label 2 (base alpha 64/red;
  `eff05b` purple additive scale/rotation), and effect 11 restores label 1.
  This is the meaning of the writes to ANM VM `+0x1c6` at
  `0x0133e1ce/0x0133e41a`; the old `spec-slowmo.md` “dead write” conclusion
  is overruled by the VM layout and the original visual trace. The
  capture.anm flash draws as a flat teal tint (its runtime `'@'` texture is
  not extractable); the face_01_00 cutin sweep path/timing and the red
  name-banner gradient (text.anm textures not extractable) are hand-tuned;
  spell history is session-scoped (original persists in score.dat).
- Boss X-position marker: exact sprite not recovered from front.anm
  (spec-ui-stageclear.md §3); drawn as a small ~60% alpha "Enemy" label at
  the playfield bottom edge tracking boss.x.
- Bullet-effect ids 1/2/4/6/9/12-15/19/21-23 ported. Caution:
  `spec-effects-misc.md`'s old “sparkles” description for ids 12/21 is
  overruled by FUN_00423480/FUN_00421e90: these handlers replace qualifying
  big bullets with real enemy-bullet volleys before deleting the parents.
  Id12 emits 10/18/22/25 children by difficulty inside its ±64/±48 Y band;
  id21 emits 15 inside ±128(H)/±180(other) and is rank-gated by ECL. Each
  child performs x/y frand, kind u16, angle frand and EX-rate frand in that
  order (nine raw draws), starts at speed 0.1, and carries opcode-0x20 for
  100 ticks. Parent qualification uses sprite height >48, not width. Id2
  converts each nearby offset-2 parent into two real
  sprite0/offset6 accelerating bullets (six raw draws total per parent);
  id6 converts its selected offset family into 3 native rings (Lunatic
  param0 = 2+2+1 bullets, zero RNG). Both delete the parent only after child
  construction. Id4 alone remains a visual-particle replacement. Id1
  "declaws" matched bullets (filter =
  spriteOffset, the FIRE 2nd i16 / exe bullet+0xbf8 — same field ids 2/6
  filter on) to nominal 0.3 and installs a fresh opcode-0x20 slow-turn with
  its own elapsed counter (E/N/H 60 ticks @ +1/60, Lunatic/Extra 240 @
  +0.005263158, turn ±π/(rng01*60+180)/tick; FUN_00416da0 @ 0x416da0); ids
  9/15 are screen shake/flash, id 19 is the 3-second BGM fade. Ids 22/23
  (cosmetic auras) are intentional no-ops. ECL op149 (spell-presentation
  origin, 1 use) and op150 (enemy ANM Z-rotation) are handled.
- Slowmo clock (op121 ids 10/11): the executable scales STD, ANM, ECL,
  player, enemies, lasers, items, bombs, and timers while collision remains
  wall-clock. The port now drives all of these from one global `slowRate`
  (effect 10 = 1/param + retroactive bullet-vector rescale + shape
  0x260..0x26f -> 0x26f + spell-background interrupt 2; effect 11 = inverse
  + shape restore + background interrupt 1 + rate reset; split-counter
  timers accumulate fractionally). See `spec-slowmo.md`, with its old claim
  that the two background writes are dead explicitly overruled above.
- ~~Extra/Phantasm starting bombs/power PROBABLE~~ — **resolved 2026-07-25,
  against the community convention.** Extra and Phantasm start at **power 0**
  (not full power) with the character's ordinary SHT bomb stock and lives
  forced to 2. Evidence: the stage-7 entry snapshots two native replays'
  recorders wrote — th7_udHm54 (marisaB, Extra) `power=0 lives=2 bombs=2`
  and th7_udSg10 (reimuA, Phantasm) `power=0 lives=2 bombs=3`, the bomb
  values being exactly ply01b/ply00b's `bomb_per_life`. `FUN_0042cf2f`
  (all.c:19715-19717) only forces lives; it never writes power, which is why
  spec-extra-phantasm.md §2 could not find a write site. The route keeps its
  top-of-screen auto-collect regardless, since the PoC predicate is
  difficulty-gated (`power >= 128 || difficulty > 3`, ItemManager.cpp:195).
  Pinned by tests/th07-extra-phantasm-init.test.mjs.
- ESC pause menu: presentation is the authored ascii.anm entry-2
  (pause.png) scripts verbatim, but the exe's trigger/menu logic was not
  statically recoverable — BGM-keeps-playing and the confirm default
  (いいえ) are PROBABLE; the cursor highlight tints unselected rows (no
  authored variant exists). Pause-menu Retry restarts the run (story:
  stage 1; practice: the practiced stage) — label semantics, PROBABLE.
- Practice Start: flow/init are exe-cited (8 lives, full reset, stage
  select after shot select, clear→title with the cursor re-parked), but
  all six stages are selectable — the original gates by score.dat "CLRD"
  cleared-stage data this port doesn't persist (approved modernization:
  the stage list exists for testing). The stage list renders as plain
  text (original uses its ascii font + per-stage practice scores).
- Supernatural Border visuals are now native-faithful: the stage background
  is multiply-darkened through the exe's 128→48→128 grey envelope with
  SmoothBlendColor averaging (Player.cpp:1975-1995 + Stage.cpp:512-573),
  the ring is the real etama.anm script-219 magic circle (scale 1→0.25,
  spin negated on activation; break spawns the 0.0625→1.3 expanding copy
  fading out over 30f plus the 32 fixed-angle petal burst), the player
  sprite flashes red every 4 frames, and the HUD shows the pulsing gauge
  badge + recolored cherryPlus digits (AsciiManager.cpp:1256-1308).
- Decorative ambient particles (ECL op117/118 → `spawnEffectParticles`) keep
  approximate raster presentation, but their allocation, fixed 400-slot
  pressure, release clocks, and RNG consumption are executable-derived for
  every Stage-1..6 family exercised by the converged replays. Representative
  veto costs from `DAT_00494fb0`: effect 17→2 raw draws, 20→22, and 22→2 or
  4 (the four-draw branch is only the ≤−990 sentinel). World families 26/27
  use `frand*100-50` Z spread and share FUN_0041a050 release semantics.
- Enemy death/drop effects are no longer an aggregate approximation. The
  enemy manager performs fire → player-shot/attack collision → immediate
  damage → death in fixed slot order. FUN_0041ed50's itemDrop branch, global
  1-in-3 random-drop counter, preburst, item construction, boss sweep, common
  effects, and id5 impact cadence run in their executable order. Preserve this
  shape; changing a draw total in isolation will desynchronize item→power→DPS
  and later fixed slots even if an aggregate residue happens to match.
- Ghost runs remain diagnostic-only. Dialogue, death consequences and manager
  lifetime can change how long ambient generators run, so only a no-ghost
  original replay establishes acceptance. `replay:verify` enforces this.

## 8. Pitfall catalog (check these FIRST when something looks wrong)

- **Half the geometry missing / one-sided rendering** → anchor or extent
  convention (corner vs center). §6 Anchors/STD.
- **HUD/menu elements uniformly shifted** → top-left vs centered blit.
- **Streaks or blocks near the horizon** → fog metric or fully-fogged
  cells being drawn; sky must equal fog color.
- **Everything animates from wrong positions after a script change** →
  entry-scoped script/sprite id collision (multi-entry ANM).
- **Phantom TypeScript null errors in one function** → unreachable code
  above (leftover debug `return`), which kills narrowing.
- **Shots fire late / wrong cadence** → 30-frame cycle, delay-0 fires on
  press frame, focused/unfocused table switch.
- **Boss fight background/state weirdness** → the STD clock *loops* via
  op 4; anything keyed to raw stage frame instead of the STD clock drifts.
- **Menu navigation skipping steps** → held-vs-pressed key edges; menus
  are edge-triggered with 20-frame delay/6-frame repeat.
- **Draw cost ring suddenly ~10ms fatter (p50 1→6.6ms) with no code
  change** → the backbuffered (desync-granted) canvas. present()'s
  drawImage uses the backbuffer as a source, which forces the scene's
  batched raster to FLUSH synchronously inside the timed draw callback —
  work that on the direct path runs after the callback, invisible to the
  ring. Real frame delivery is unchanged (rAF cadence flat 16.7ms,
  measured). Do NOT "optimize" the number away: profile game-code cost on
  the `desync=0` arm (perf-probe does this; perf-smoke gates cadence on
  the default arm and cost on the control arm).
- **A magic constant "fixes" positioning** → your decode is wrong. Delete
  the constant, re-read the disassembly. Every compensating hack we ever
  added (scroll speed, camera lift, ground mirroring, procedural moon) was
  masking a misread and got replaced by the real semantics.
- **RNG-budget "matches" but bullets still desync** → the total can be right
  by cancellation. Profile per-effectId draws (`opts.profileRng` in
  replay-harness) and match each event's count, not just the sum. A single
  mis-resolved ECL operand (op117/118 count read raw instead of gi()) once
  hid a 100k-draw error that summed near budget.
- **Ambient effect / invisible controller vanishes mid-stage** → field sweeps
  (op94/op91/boss non-spell death) must only set HP=0, not delete;
  non-interactable enemies (op116(0)) are spared by the exe (removal is the
  interactable-gated death switch). Deleting them kills ambient emitters.
- **An exe-verified effect cost moves a proven PRE boundary earlier** → do not
  keep it in isolation merely because its aggregate draw count is plausible.
  Kill timing changes item/power/DPS and later event order, so false-death and
  full-stage budgets are hypersensitive, non-monotonic proxies. Identify the
  exact native caller, fixed slot, and stream position at the current earliest
  mismatch, then land all causally coupled cadence/order changes together.
- **A ghost full-stage RNG budget disagrees with a no-ghost PRE trace** → trust
  the no-ghost PRE trace. Ghosting changes death consequences and post-boss
  dialogue timing, which changes how long ambient generators run. Acceptance
  is the original replay without ghosting; use ghost only to inspect otherwise
  unreachable later state.
- **Probe reads flat where content belongs** → check the snapshot first:
  if the simulation state is right (entities exist), the defect is in
  rendering (anchor, entry-scoped ids, clip, alpha); if the state is wrong
  too, it's simulation (ECL/rank/timing) — don't debug the renderer.

## 9. Orchestration protocol (multi-agent work)

The pattern that works: a **strong orchestrator** (planning, review,
integration) drives **executor agents** (Sonnet-class) with precise briefs.
Executors are excellent when the brief removes ambiguity and mandates the
verification loop; they fail when asked to "make it good" without
acceptance criteria, or when two of them share a file.

### Brief template (give every executor ALL of this)

1. **Context**: repo path, branch (never switch), build/test commands, and
   the §6 facts relevant to the task — paste them, don't cite them.
2. **File ownership**: exact list of files the agent may modify. Everything
   else is read-only. Two agents must never own the same file
   concurrently; sequence them instead. (`stage-scene.ts` is the usual
   contention point — background, HUD, and gameplay all live there.)
3. **Steps**: concrete, ordered, with tool paths (thanm/thstd/thecl if
   needed) and disassembly locations.
4. **Acceptance criteria**: the exact dev-shot/dev-menu invocations, the
   checkpoint frames, and the snapshot fields + pixel-report readings each
   must produce (paste the §5 baseline rows that apply). Require the agent
   to run the probes and iterate until the numbers are in band — the
   numbers are the deliverable, and they work for text-only agents.
5. **Constraints**: no new dependencies, no commits (orchestrator commits),
   match code style, comment only approximations/provenance, keep the tree
   compiling at every stop point.
6. **Report format**: what changed (file:line), what was verified and how,
   approximations made, anything unresolved. Findings the orchestrator
   must act on go at the top.

### Orchestrator duties

- Gather the decisive facts *before* delegating (read the disassembly
  yourself; a mis-briefed executor produces confident garbage — the
  "camera never moves" hack chain came from briefing TH06 op semantics
  for TH07 data).
- Review the executor's evidence yourself: re-run its dev-shot/pixel-report
  invocations (or demand the raw outputs) and check the numbers against
  §5. Never accept an unquantified "it looks right". Viewing screenshots
  is an optional extra for vision-capable reviewers, not part of the
  contract.
- Commit in reviewed checkpoints, one concern per commit, so a crashed or
  runaway agent can be rolled back cleanly.
- Assume agents can die mid-edit (session limits). After any crash:
  `git status` + `npm run check` before anything else; hunt for leftover
  isolation hacks (§4.5); decide keep/revert per file.
- Have executors write large findings to files (specs, dumps) rather than
  only their final message — a crashed agent's message is lost, its files
  survive.
- RE analysis agents (Ghidra, format decoding) should be read-only on
  `src/` where possible: deliver a spec file; a separate implementation
  pass applies it. The hud-spec.md → HUD rebuild flow worked exactly this
  way.

### Ghidra RE workflow (repeatable)

1. `reference/Th07.exe` (PE32, v1.00b). Install headless Ghidra (JDK 17+,
   `analyzeHeadless <proj> th07 -import Th07.exe`), or radare2 as
   fallback.
2. Anchor by immediates (e.g. 0xC350=50000, 0x21C=540) or IEEE-754 float
   bit patterns in `.data`/`.rdata` for coordinate tables; xref into
   functions; decompile; record address + one-line pseudo-C + constant +
   confidence (confirmed/probable/weak) in a scratch notes file.
3. Only **confirmed** values land in code, each with an address comment.
   Probable/weak go to §7 as flagged approximations.

## 10. Repo hygiene

- Runtime surface: `index.html`, `dist/` (generated — never hand-edit),
  `src/`, `assets/th07-img|audio/th07|sfx/th07`. Browser code must not
  read `reference/`, `tests/`, `scripts/`, `docs/`, `node_modules/`.
- Never commit: `reference/`, secrets, screenshots, logs, scratch scripts,
  `test-results/`, `dist/`.
- Keep diffs focused; no drive-by refactors. New scripts/tests only as
  intentional project files.
- The legacy TH06 app never lived in this repository; it is preserved in
  full on the `legacy-vanilla` branch of
  [th6_web](https://github.com/AgentMystia/th6_web). Do not resurrect
  TH06 files here, and do not consult the TH06 implementation as
  behavioral authority for TH07 (§2, §6: several formats and constants
  genuinely differ).
- Commit messages: what + why, present tense; mention the evidence
  (disassembly, exe address, screenshot checkpoint) that justified the
  change.

## 11. Handoff format

Every task ends with: what changed (files), evidence basis (data/exe/doc),
exact-or-approximate status per §7, verification actually run (commands +
checkpoints + whether screenshots were reviewed), and remaining gaps. If
validation was skipped anywhere, say so explicitly — an unverified change
is reported as unverified, never as done.
