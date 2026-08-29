import { advanceBulletExBehavior, StageRuntime, type StageData } from './eclvm';
import {
  TH08_STAGE_ORB_QUOTAS, GameHost, Enemy, EnemyBullet, EnemyLaser, ItemEntity, ItemType,
  EffectParticle, ReplayTraceSink
} from './types';
import { Rng } from '../core/rng';
import {
  normalizeAngle, normalizeNativeAngleF32, clamp, NATIVE_PI_F32, NATIVE_HALF_PI_F32
} from '../core/util';
import type { InputFrame } from '../core/input';
import { Renderer, PLAYFIELD, SCREEN_W } from '../gfx/renderer';
import type { GameAssets } from './assets';
import { Anm, AnmRunner, warnUnhandledOp, type AnmFrame } from '../formats/anm';
import { bgQuadCorner, orderBgJobsByVisibility, type Vec3 } from '../formats/std';
import { TH08_DATA } from '../data/th08-data';
import type { AudioBus } from '../audio/audio';
import {
  Player, type Th08TeamId, type PlayerBullet
} from './player';
import { PlayerEffects, type PlayerEffectHandle } from './player-effects';
import { Th08RunState } from './th08-state';
import { updateTh08SeekingOptionShot } from './th08-option-shot';
import { Th08BorderBomb, TH08_BOMB_INVULN, type Th08BombHost } from './th08-border-bombs';
import {
  Th08SpellDeclaration,
  th08BombSpellName,
  archiveScript,
  archiveScriptRunner
} from './th08-declaration';
import { Th08ItemSpawnPool } from './th08-item-spawn';
import { Th08DialogueMachine, TH08_DIALOGUE_INPUT_BITS } from './th08-dialogue';
import {
  TH08_DIFFICULTY_TAG,
  TH08_FORM_GAUGE,
  TH08_HUD,
  bossLifebarFillRatio,
  formGaugeCursorX,
  formGaugePercentX
} from './th08-hud-layout';
import { BombEngine, type AttackSlot } from './player-bombs';
import { stageBgmTrack } from './bgm';

// Stage host for the TH08 (Imperishable Night) vertical slice. Runs the
// stage timelines with the embedded TH08 ECL/STD/MSG/ANM data through the
// committed Th08RunState (time orbs, night clock, human/youkai gauge) in
// place of the parent engine's Supernatural Border cherry system. The
// The Border Team is the only constructible team in this vertical slice.

// Everything that survives a stage transition within one credit.
export interface RunCarry {
  score: number;
  hiScore: number;
  graze: number;
  pointItems: number;
  lives: number;
  bombs: number;
  power: number;
  rank: number;
  rankAccumulator?: number;
  powerItemCountForScore?: number;
  // TH08 run-state fields persisting across stages (T8RP stage blocks):
  // the night clock (post-tally advance), the human/youkai gauge, and the
  // point-item ladder. currentTimeOrbs is per-stage and does not carry.
  clockTime?: number;
  youkaiGauge?: number;
  pointItemValue?: number;
  pointItemExtends?: number;
  nextPointItemExtendThreshold?: number;
}


// TH08 ItemType enum (ItemManager.hpp:9-21) in declaration order; the item's
// etama.anm visual script is 61 + id (ItemManager.cpp:112).
const TH08_ITEM_TYPE_IDS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TH08_ITEM_TYPE_SLOT: Partial<Record<ItemType, number>> = {
  powerSmall: 0, point: 1, powerBig: 2, bomb: 3, powerFull: 4, extend: 5,
  pointStar: 6, time: 7, pointSmall: 8, unknown9: 9, time2: 10
};
// Inverse of TH08_ITEM_TYPE_SLOT: native item type id -> ItemType, for the
// kill-quad bullet conversions (FUN_004400a0 takes the raw id).
const TH08_ITEM_TYPE_BY_ID: readonly ItemType[] = [
  'powerSmall', 'point', 'powerBig', 'bomb', 'powerFull',
  'extend', 'pointStar', 'time', 'pointSmall', 'unknown9', 'time2'
];
// DAT_018b8a24, native-read as 40 in both Stage 1/2 replay runs. Every
// enemy initializes +0x2e10 to this value; FUN_00451670 subtracts it before
// adding the current collision call's capped raw damage.
const TH08_SHOT_TIME_ORB_THRESHOLD = 40;

// FUN_00451670's nonzero-angle rectangle branch rotates the target into the
// attack record's local space, then performs the same inclusive half-extent
// comparisons as its axis-aligned fast path. `width`/`height` are full sizes
// already expanded by the target hitbox at the call site.
function orientedBoxHitsPoint(
  px: number,
  py: number,
  boxX: number,
  boxY: number,
  width: number,
  height: number,
  angle: number
): boolean {
  const dx = px - boxX;
  const dy = py - boxY;
  if (angle === 0) {
    return Math.abs(dx) <= width / 2 && Math.abs(dy) <= height / 2;
  }
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const localX = c * dx + s * dy;
  const localY = -s * dx + c * dy;
  return Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2;
}
// exe-exact RNG draw cost (raw u16) per particle for the ambient effect types
// ECL op117/118 spawn, = the DAT_00494fb0 spawnVetoFn's draw count (binary-read
// confirmed; the paired perFrameGateFns draw ZERO). Only the effectIds stage 1
// actually uses are listed; id22's real cost branches only on the authored
// random-angle sentinel (handled at the call site). Effect draws share the
// gameplay RNG stream, so
// these counts are load-bearing for bullet/fire alignment, not cosmetic.
// Total per-particle raw-u16 costs combine two original paths:
//   1. the effect table's DAT_00494fb0 spawnVetoFn (file offset 0x933b0), and
//   2. the authored effect ANM's time-0 op59/op60 executed synchronously by
//      FUN_004486e0 during allocation.
// Ignoring (2) undercounted ambient families shared by stages 2-6 even when
// the veto function itself was modeled exactly.
// TH08 (v1.00d) per-effect spawn-time RNG cost in u16 draws, measured
// exhaustively from the binary:
//   cost = 2 * (ins_59 + ins_60 ops in the effect's etama script)
//        + draws in the effect's DAT_004c6d38 init callback.
// The ANM VM has exactly two random ops (Th08.exe FUN_0045ea00 cases
// 0x3c/0x3d = disk ops 59/60, one u32 each = 2 u16); the script cost runs on
// the VM's first tick and the callback cost runs inside FUN_00425430, both
// in the spawn frame. Init-callback costs measured from the binary:
// FUN_00426280=16 (id 51), FUN_00426720=16 (id 63), FUN_00426e70=20 (id 19),
// FUN_00425d70=4 (ids 4-11), FUN_00425ea0=4 (id 3), FUN_004270c0=4 (ids
// 21/26), FUN_00426b20=2 (ids 17/18/27); every other callback draws 0
// (verified: FUN_00425fe0/4272e0/427260/411720/411a80 and the d2 per-frame
// updaters FUN_004264f0 et al. are all draw-free). Native /proc/pid/mem
// draw-counter (0x164d524) cross-check f2600-2915: firefly emissions land
// ~26/arm, shot-impact effects ~4/arm.
const EFFECT_DRAW_COST: Record<number, number> = {
  0: 0, 1: 0, 2: 0, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4, 11: 4,
  12: 0, 13: 0, 14: 0, 15: 0,
  17: 6, 18: 6, 19: 20, 20: 0, 21: 8, 22: 2, 23: 0, 24: 0, 25: 0,
  26: 10, 27: 6, 28: 0, 29: 0, 30: 0, 31: 0, 32: 0, 33: 0, 34: 0,
  35: 0, 36: 0, 37: 0, 38: 10, 39: 0, 40: 4, 41: 0, 42: 0, 43: 0, 44: 0,
  45: 0, 46: 0, 47: 8, 48: 0, 49: 0, 50: 0, 51: 26, 52: 0, 53: 0, 54: 0,
  55: 0, 56: 0, 57: 0, 58: 0, 59: 0, 60: 0, 61: 0, 62: 0, 63: 26, 64: 0,
  65: 0
};
const ENEMY_POOL_CAP = 0x1e0;
// Th08.exe player+0xbe838: 0x80 records at stride 0x484. TH07 used the
// smaller 0x60 pool; retaining that parent-engine limit made long-lived
// impact VMs reject valid Border-Team volleys and under-damage midbosses.
const PLAYER_BULLET_POOL_CAP = 0x80;
// Th08.exe bullet manager @ 0xf54e90: 1536 slots (0x600) at stride 0x10b8
// (asm 0x431254/0x4312b7 — native slot trace). The TH07-era 0x400 pool
// saturated during Wriggle's final card and silently vetoed the familiars'
// volleys.
const ENEMY_BULLET_POOL_CAP = 0x600;
// Effect 39's settled ring radius: the authored scale interp ends at 15
// (etama archive script 76, 192->15 over 120 frames) and the declaration-
// time 600px screen radius fixes the strip's px-per-scale at 3.125.
const SPELL_RING_SETTLED_RADIUS = 15 * 3.125;
const BOMB_CLEAR_REGION_CAP = 0x60;
const EFFECT_POOL_CAP = 400;
// TH08's effect pool is 512 slots (FUN_00425430's 0x200-slot scan with 0xd8
// strides), TH07's 400. The slot array sizes to the superset; the cursor
// loops below cap at this field.
const EFFECT_POOL_CAP_TH08 = 512;
// TH08 effect 51 (the ambient firefly spark) is a world-space particle.
// FUN_00426280 initializes it around the live STD camera using eight u32
// random values, then FUN_004264f0 integrates it and releases the VM once
// dot(normalize(pos-camera), normalizedFacing) falls below 0.94. The exact
// construction is wired in spawnEffectParticles below; this matters to the
// shared 512-slot effect pool, not just rendering. In Stage 2 most fireflies
// leave the steeper camera cone in a handful of frames (native occupancy
// ~12-23), whereas the old Stage-1 lifetime histogram retained ~160 and
// changed which later RNG-consuming effects could allocate.
// Th07.exe v1.00b _DAT_0048eb98 (file value 0x38d1b717), used by
// FUN_00423910 @ 0x4239e4/0x423a05 before recomputing an accel heading.
const NATIVE_VELOCITY_EPSILON_F32 = 9.999999747378752e-5;
// DAT_00494fb0 maps the small effect id to a master ANM script. These are
// the authored removal times of the corresponding etama scripts; Infinity
// denotes an interrupt/gate-owned persistent VM. The optional per-frame
// callbacks can still release a slot earlier (notably id20 below).
const EFFECT_SCRIPT_LIFE: Record<number, number> = {
  0: 20, 1: 20, 2: 40, 3: 40,
  4: 30, 5: 30, 6: 30, 7: 30, 8: 30, 9: 30, 10: 30, 11: 30,
  12: 40, 13: Infinity, 14: Infinity, 15: Infinity,
  17: 60, 18: 240, 19: 120, 20: 300, 21: 40, 22: 90,
  24: Infinity, 26: 300, 27: 300,
  // TH08 form/focus tints (28/29, player) + familiar materialize flashes
  // (30/31): on-disk scripts -93..-90 all remove at frame 10.
  28: 10, 29: 10, 30: 10, 31: 10,
  32: 90, 33: 120,
  // TH08 effect 51: etama script 73 removes at frame 241.
  51: 241,
  // TH08 effect 62: etama script 75 removes at frame 72 (1+1+70).
  62: 72,
  // TH08 effect 38 (familiar white sparkle): on-disk script -79 removes at
  // frame 20 (its +20 ins_1).
  38: 20
};
// Script-lifetime law (exe-pinned 2026-08-30 pass 12): the values above are
// the AUTHORED ins_1 time T, and a VM dies on manager pass T after spawn.
// FUN_0045e580 (VM init) already runs one dispatcher step at spawn time
// (tick 0->1, executing the t=0 block), the spawn frame's manager pass
// (FUN_00427bf0 @ priority 11) is step 2 (tick 1), and op1@t=T executes when
// the timer tick first equals T — pass T. Spawns after the pass (priority
// 12) shift one frame, which `age >= life` on the first-pass-relative age
// also expresses. A +1 experiment (age > life) overshot the pool at the
// f859 razor and was reverted against this chain.

// TH08 sfx ids: .data 0x4c81b0 (36 filename pointers, loaded by the loop at
// Th08.exe 0x45d45f; FUN_0045d550/FUN_0045d660 play by this index). Gains
// reuse the TH07-measured gain for the same file; files TH07 never plays
// carry a neutral placeholder gain.
export const TH08_SFX_SLOTS: [string, number][] = [
  // The exe's 46-channel id table (.data 0x4c8040, stride 8: {u32 srcBank,
  // i16 volA@+4, i16 volB@+6}) over the 36-file name table at 0x4c81b0 —
  // FUN_0045d3f0's preload clones bank record.src per id with SetVolume
  // (volA, centibels; gain = 10^(volA/2000)). Duplicated ids are volume
  // variants (2/3 = the two enep00 kill slots, 30/32 graze, 42/43 slash).
  ['se_plst00', 0.112], ['se_plst00', 0.089], ['se_enep00', 0.251], ['se_enep00', 0.178],
  ['se_pldead00', 0.282], ['se_power0', 0.447], ['se_power1', 0.447], ['se_tan00', 0.112],
  ['se_tan01', 0.079], ['se_tan02', 0.063], ['se_ok00', 0.282], ['se_cancel00', 0.282],
  ['se_select00', 0.178], ['se_gun00', 0.178], ['se_cat00', 0.316], ['se_tan00', 0.282],
  ['se_lazer00', 0.224], ['se_lazer01', 0.2], ['se_enep01', 0.355], ['se_nep00', 0.631],
  ['se_damage00', 0.363], ['se_item00', 0.178], ['se_tan00', 0.708], ['se_tan01', 0.126],
  ['se_tan02', 0.126], ['se_kira00', 0.282], ['se_kira01', 0.224], ['se_kira02', 0.178],
  ['se_extend', 0.562], ['se_timeout', 0.562], ['se_graze', 0.282], ['se_powerup', 0.398],
  ['se_graze', 0.251], ['se_kira00', 0.562], ['se_pause', 0.398], ['se_cardget', 0.398],
  ['se_option', 0.398], ['se_damage01', 0.447], ['se_timeout2', 0.708], ['se_opshow', 0.398],
  ['se_ophide', 0.398], ['se_invalid', 0.794], ['se_slash', 1.0], ['se_slash', 0.501],
  ['se_item01', 0.398], ['se_ok00', 0.891]
];

// ascii.png HUD numeral font: 8x12 digit glyphs in a row at texture y=208,
// digit d at x=8*d (front.anm/ascii.anm spec §5.1). The sole HUD digit font.
const DIGIT_W = 8;
// TH08 HUD: 13px digit advance (TH08_HUD.digitAdvance) and the front.png
// 16x16 life/bomb icon pair at (64,80)/(80,80).
const TH08_ADV = 13;
const TH08_ICON_LIFE: readonly number[] = [64, 80, 16, 16];
const TH08_ICON_BOMB: readonly number[] = [80, 80, 16, 16];
const DIGIT_H = 12;
const DIGIT_Y = 208;

interface ScorePopup {
  digits: number[];
  color: number;
  x: number;
  y: number;
  timer: number;
  timerFrac: number;
  active: boolean;
}

interface StageTransitionTile {
  runner: AnmRunner;
  row: number;
  column: number;
  delay: number;
  x: number;
  y: number;
  sourceX: number;
  sourceY: number;
}

const makeScorePopup = (): ScorePopup => ({
  digits: [0], color: 0, x: 0, y: 0, timer: 0, timerFrac: 0, active: false
});

// Per-quad cap on subdivided cells for perspective-correct-enough texture
// mapping (see drawBackground); not a shared budget — stage 1 only has ~31
// ground instances and 18 tree quads per tree instance, so every visible
// quad is drawn in full every frame with plenty of headroom to spare.
const BG_MAX_CELL_STEPS = 24;

export class StageScene implements GameHost {
  // Installed only by replay-verification tooling.
  traceReplayEvent?: ReplayTraceSink;
  // Forensics gate for the per-item kinematics trace (window-scoped).
  traceItemTick = false;
  rng = new Rng();
  difficulty = 1;
  // T8RP stage metadata stores the integer rank byte. The live accumulator is
  // separate: TH08 FUN_0043bfc3/FUN_0043c03f add/subtract event points and
  // cross one integer rank per 100, clamped by DAT_004c7880.
  rank = 16;
  rankAccumulator = 0;
  private rankSurvivalTicks = 0;
  private rankSurvivalFraction = 0;
  private rankSurvivalAdvanced = false;
  // TH08 Border Team selector exposed to ECL var 10050.
  get shotIndex(): number {
    return 0;
  }
  // Global slow-motion rate (exe DAT_0056baa8; spec-slowmo.md). Bullet-effect
  // 10 sets 1/param, 11 restores 1.0; reset at stage init by construction.
  slowRate = 1;
  frame = 0;
  id = 1;
  player = { x: 192, y: 384 };
  enemies: Enemy[] = [];
  private readonly enemySlots: (Enemy | null)[] = new Array(ENEMY_POOL_CAP).fill(null);
  enemyBullets: EnemyBullet[] = [];
  private readonly enemyBulletSlots: (EnemyBullet | null)[] = new Array(ENEMY_BULLET_POOL_CAP).fill(null);
  // Th07.exe DAT_0099fa60 (bullet manager +0x37a128) is a manager-entry
  // census, not a continuously maintained live count. It intentionally
  // remains stale after this pass culls bullets, and next frame's enemy FIRE
  // uses that snapshot as FUN_00423480's whole-volley capacity gate.
  enemyBulletManagerEntryCount = 0;
  // Th07.exe bullet+0xbfe is NOT initialized by FUN_00421e90 and NOT cleared
  // by FUN_00416c90. It is stale storage owned by the fixed slot: a special
  // bullet that dies after 128 off-screen ticks can lend that value to the
  // next ordinary bullet allocated in the same slot, delaying its cull.
  private readonly enemyBulletOffscreenCounters = new Uint16Array(ENEMY_BULLET_POOL_CAP);
  enemyLasers: EnemyLaser[] = [];
  postBombLaserCounter = 0;
  items: ItemEntity[] = [];
  particles: EffectParticle[] = [];
  private readonly effectSlots: (EffectParticle | null)[] = new Array(EFFECT_POOL_CAP_TH08).fill(null);
  private effectPoolCap = EFFECT_POOL_CAP;
  private effectPoolCursor = 0;
  // TH08 player-manager tick counter (exe DAT_004e4030 + 0x81c, zeroed by the
  // per-stage memset of the player-manager struct at FUN_00409b20). Drives the
  // option-afterimage spawn gate below; read-then-increment order matches the
  // exe (all.c:2997-3009).
  private th08AfterimageClock = 0;
  // GameHost's power view must be the live run-global player field. Keeping a
  // second numeric copy here made ECL op119 see zero after replay snapshots,
  // so its full-power branch emitted power drops that spawnItem then converted
  // to bigCherry instead of the exe's point items (Stage 3, frame 2096).
  get power(): number {
    return this.playerObj?.power ?? 0;
  }
  score = 0;
  focusHeld = false;
  runtime: StageRuntime;
  playerObj: Player;
  // The aim mirror the enemy FIRE pass reads (see GameHost.playerPosAtFrameStart).
  playerPosAtFrameStart: { x: number; y: number } = { x: 0, y: 0 };
  playerBullets: PlayerBullet[] = [];
  private readonly playerBulletSlots: (PlayerBullet | null)[] = new Array(PLAYER_BULLET_POOL_CAP).fill(null);
  graze = 0;
  pointItems = 0;
  // Native GameManager.powerItemCountForScore (GameManager.hpp:223; i8, replay
  // stage data +0x26 u8): index into g_FullPowerScoreBonus advanced by each
  // power item collected at full power. Reset at run start, on the miss
  // commit (Player.cpp:1781), and by every below-cap SMALL-power pickup
  // (ItemManager.cpp:264 — bigPower does NOT reset it). Persisted across
  // stages via RunCarry; seeded from the replay snapshot on playback.
  powerItemCountForScore = 0;
  // The run-global counters persist across stages, but FUN_00427269 captures
  // stage-clear Point/Graze as per-stage deltas. Replay snapshots restore the
  // cumulative totals, so retain the entry baselines separately.
  private stageEntryGraze = 0;
  private stageEntryPointItems = 0;
  // Th07.exe DAT_012f40bc: latched to the spell-active state at each bomb
  // trigger — bomb damage during a spell card is 0 until a bomb has been
  // triggered during that spell (anti pre-bomb rule, disasm @ 0x41faeb).
  private bombDuringSpell = false;
  // Th07.exe FUN_00446970: the 5-slot SE queue drops a request whose id is
  // already queued this service cycle — net effect, any SE id plays at most
  // once per frame no matter how many requests (bug 2: se_damage00 spam).
  private sfxPlayedThisFrame = new Set<number>();
  // Th07.exe FUN_0041ebc0: enemy-body graze re-arms every 6 frames while touched.
  // One cached AnmRunner per stg1bg script id, stepped forward to the
  // current STD frame; shared by every quad instance that references it
  // (see drawBackground / bgAnmFrame).
  private bgAnmCache = new Map<number, { runner: AnmRunner; frame: number }>();
  // STD ops 29/30 own two standalone ANM VMs, separate from the per-quad
  // runners and from each other (Th07.exe FUN_004046f0 @ 0x40516d-0x4051e8).
  private specialBgAnmCache: ({ script: number; runner: AnmRunner; age: number } | null)[] = [null, null];
  gameOver = false;
  // Runtime flow. 'test' keeps headless-probe semantics (no freeze or scene
  // exit); 'arcade' is the playable TH08 Stage-1 slice.
  // 'practice' = the vanilla Practice Start flavor: one stage, 8 lives, no
  // continues, straight back to the title on clear or game over. 'replay'
  // likewise has no continues and returns to the replay selector; unlike
  // practice it keeps the ordinary HUD and all state comes from T8RP.
  mode: 'arcade' | 'practice' | 'replay' | 'test' = 'arcade';
  onExitToTitle: (() => void) | null = null;
  // Fired (arcade mode, stages 1-5) when the player advances past the
  // stage-clear tally; the host tears this scene down and starts stage+1
  // with carryState(). Null/unset → fall back to exitToTitle.
  onStageComplete: ((carry: RunCarry) => void) | null = null;
  continueScreen: { cursor: number } | null = null;
  continuesUsed = 0;
  // Config starting-lives (run-state byte DAT_0061c254+0x1c, replay header
  // +0x38). FUN_00429446 scales every stage-clear bonus by the "Player
  // Penalty" tier: 3 -> x0.5, 4 -> x0.2 (results text @ all.c:17114-17123).
  // Default config records 2; replays carry the recorder's value.
  startingLives = 2;
  private gameOverTimer = 0;
  // Post-respawn continuous silent field clear (exe player+0x2400, 60f).
  private respawnClearFrames = 0;
  // ESC pause. Menu rows: 0 再開, 1 タイトルに戻る, 2 最初からやり直す;
  // the destructive rows detour through the 本当に？ はい/いいえ confirm.
  // The in-exe trigger logic is not statically recoverable (recon NOT
  // FOUND); behavior follows the shipped pause.png assets + vanilla
  // convention — BGM keeps playing (PROBABLE).
  pauseState: {
    cursor: number;
    confirm: boolean;
    confirmCursor: number;
    closing: number;
    action: 'resume' | 'title' | 'retry' | null;
    runners: AnmRunner[];
  } | null = null;
  // Set by main.ts: restart the run from its beginning (story: stage 1;
  // practice: the practiced stage).
  onRetryRun?: () => void;
  stageClearTimer = 0;
  private exitFired = false;
  private stageCompleteFired = false;
  runState: Th08RunState;
  hiScore = 100000;
  // TH08 dialogue (timeline ins_6): the committed Th08DialogueMachine plus
  // four portrait-slot AnmRunners.
  th08Dialogue: {
    machine: Th08DialogueMachine;
    runners: (AnmRunner | null)[];
    // Per-slot draw Y offsets stored by MSG ops 1/2 (gui+0x21abc family)
    // and the last applied position code per slot (see updateTh08Dialogue).
    portraitOffsets: number[];
    lastPositions: number[];
  } | null = null;
  private dialogueResume = false;
  stageFrame = 0;
  stageClear = false;
  // MSG op9 exposes the results tally and snapshots/credits its values well
  // before op11 actually leaves the stage. Keep presentation distinct from
  // the final stage-transition latch so the post-boss MSG can keep ticking.
  stageResultsActive = false;
  private clearTimer = 0;
  clearLoadingRunner: AnmRunner | null = null;
  clearCaptureRunner: AnmRunner | null = null;
  // The tally's night-clock plates (times.anm): the current-时刻 plate
  // (script 1) and the advanced plate (script 2) spawned at the advance.
  clearTimeRunner: AnmRunner | null = null;
  clearTimeAdvancedRunner: AnmRunner | null = null;
  clearLoadingKey: string | null = null;
  private clearCaptureArmed = false;
  stageTransitionTimer = 0;
  stageTransitionTiles: StageTransitionTile[] = [];
  private stageTransitionCaptureArmed = false;
  readonly stageNumber: number;
  private stageIntroRunners: AnmRunner[] = [];
  // MSG op7 reuses stgNtxt script 3 and replaces its sprite with slot+3,
  // yielding the stage/boss BGM title strip. It is a separate GUI VM from
  // the opening title runners, so the boss cue can play after those retire.
  private dialogueBgmRunner: { runner: AnmRunner; spriteIndex: number } | null = null;
  // MSG op8's text payload is typeset into a dedicated text.anm VM. The
  // browser renderer keeps the exact decoded string while the dialogue is
  // active rather than silently dropping the transition caption.
  private dialogueBossIntroLine: string | null = null;
  private readonly bgScripts = new Map<number, { anm: Anm; entryIndex: number; localId: number; spriteBase: number }>();
  private readonly enemyAnm: Anm;
  private readonly bgAnm: Anm;
  private readonly effectAnm: Anm;
  private readonly stdTxtAnm: Anm;
  private readonly faceAnm: Anm;
  // Stage-clear bonus tally, computed once when the stage ends.
  clearBonus: {
    clear: number; point: number; graze: number; time: number;
    player: number; bomb: number; mult: number; total: number;
  } | null = null;
  // Tally night-clock count-up (all.c:25480-25503): the advanced-time text
  // row counts minute-by-minute from the entry clock (gui+0x22e0c) to the
  // post-advance clock (gui+0x22e08), after a 60-frame beat (gui+0x22e10),
  // +1 per frame or +4 with Z/Ctrl held. Values are minutes on the native
  // 12-hour display clock: slot*30 + 660 (all.c:24838, 0x294 = 660).
  tallyClockEntry = 660;
  tallyClockShown = 660;
  tallyClockTarget = 660;
  private tallyClockBeat = 0;
  spellcard: {
    name: string;
    id: number;
    capturing: boolean;
    // TH08 ins_122 supplies both the authored base and the native decay.
    bonus: number;
    bonusLimit: number;
    bonusAnchor: number;
    bonusAnchorElapsed: number;
    decayPerSec: number;
    elapsed: number;
    elapsedFrac: number;
    declAge: number;
  } | null = null;
  // Spell-card playfield background: two VMs from the stage's eff0N.anm
  // (archive scripts 0/1), armed at every spell start (FUN_004152a0,
  // all.c:9093-9095) and deleted outright at spell end.
  private spellBackgroundRunners: AnmRunner[] = [];
  // The declaration portrait runner (face_stNN entry 0, armed at spell
  // start; see startBossSpell).
  private spellDeclPortraitRunner: AnmRunner | null = null;
  // Effect 39's declaration ring. Its etama script 76 supplies a 16x768
  // repeated strip, while FUN_004272e0 bends the strip into the native 3D
  // ring; Canvas needs a dedicated segmented draw (drawSpellRing).
  private spellRing: { x: number; y: number } | null = null;
  private spellBanner = 0;
  // Spell-card capture popup (spec-ui-stageclear.md §4): label + value on
  // success only. Failure draws nothing (exe skips FUN_004264e3 entirely).
  private bonusPopup: { bonus: number; timer: number } | null = null;
  // Mirrors Th07.exe DAT_012f40a8's 1 -> 2 "phase failed by timeout" bump:
  // set by the timer-callback path, consumed by endBossSpell to skip the
  // scored field sweep, cleared by the next declare.
  private phaseTimedOut = false;
  bossActive: Enemy | null = null;
  bossLifeCount = 0;
  spellName = '';
  // Session-scoped per-spell attempt/capture tally for the "History n/m"
  // line of the declaration banner. The original persists this in
  // score.dat across runs — out of scope here (AGENTS.md §7).
  private spellHistory = new Map<number, { seen: number; got: number }>();
  // Test-only damage observability for the replay harness.
  settledDamageThisFrame = 0;
  // DAT_004ca4d8 as observed by the whole scheduler pass. Player.update()
  // may consume timer=1 before enemies/items run, but the native bomb flag
  // remains set through that final pass and is cleared at the next player
  // callback.
  private bombActiveThisFrame = false;
  // When the local remaining timer reaches zero, native player+0x16a20 is
  // still set until the next player callback enters the form at
  // counter==duration. That cleanup callback performs one final Cherry drain
  // before clearing the flag, but publishes no attack slots.
  private bombCleanupPending = false;
  // True only on the one player tick after bombTimer reaches 0. Native keeps
  // player+0x16a20 set for that cleanup callback; border start must defer.
  private bombCleanupDefersBorder = false;
  playerShotSerial = 0;
  private observePlayerShotSerial = false;
  // Test-only per-pass draw costs in ms (PERF-001 breakdown); rebuilt each
  // draw() and read via the ?test=1 hook. Gameplay never consults it.
  drawPassCosts: Record<string, number> = {};
  private passT0 = 0;
  private measureDrawPasses = false;

  private markPass(label: string): void {
    if (!this.measureDrawPasses) return;
    const now = performance.now();
    this.drawPassCosts[label] = (this.drawPassCosts[label] ?? 0) + (now - this.passT0);
    this.passT0 = now;
  }

  // Host callbacks for TH08 bullet queue commands (0x4000 transform needs the
  // runtime's prototype tables; 0x80000 plays a sound).
  private readonly th08BulletExHost = {
    playSfx: (id: number) => this.playSfx(id),
    transformPrototype: (b: EnemyBullet, proto: number, spriteShift: number) =>
      this.runtime.th08BulletTransform(b, proto, spriteShift)
  };
  private readonly th08ItemRunners: (AnmRunner | null)[];
  // Script-driven bomb visuals (see the TH08 bomb machine's orb/effect VMs).
  private readonly playerEffects: PlayerEffects;
  // TH08 effect layer bound to etama.anm (FUN_00425430's effect VMs).
  private readonly th08Effects: PlayerEffects;
  private prevBombTimer = 0;
  // Moving bomb attack hitboxes (exe player+0x9dc pool; see player-bombs.ts).
  private readonly bombEngine = new BombEngine();
  private readonly activeBombSlots: AttackSlot[] = [];
  // Th07.exe bomb bullet-CLEAR regions (exe player+0x17dc pool, 96 circle slots,
  // allocated by FUN_0043e7e0/FUN_0043e730 and scanned by FUN_0043b040 during the
  // per-bullet graze/hit check — BEFORE the graze box). The spec mislabeled this
  // pool "cosmetic"; it is the bomb's bullet cancellation. ReimuA activation writes
  // a fixed-center expanding-circle blast (r = 32 + 8·age, 17 frames).
  private readonly bombClearRegions: {
    x: number; y: number; radius: number; growth: number; framesLeft: number
  }[] = Array.from({ length: BOMB_CLEAR_REGION_CAP }, () => ({
    x: 0, y: 0, radius: 0, growth: 0, framesLeft: 0
  }));
  // Oriented FUN_0044de60 records published by the type-1/3 boundary beams.
  // They are consumed in the same enemy-bullet manager phase as the circle
  // pool; geometry is kept separately because the legacy record above is a
  // compact circle-only representation.
  private readonly bombClearBoxes: {
    x: number; y: number; width: number; height: number; angle: number; framesLeft: number
  }[] = [];
  // Th08.exe's FUN_0044df00 pool (player+0xbb834, circle entries): pure
  // bullet-kill regions — the enemy-bullet tick's FUN_00449ff0 probe sets
  // state 5 on any live bullet inside the radius (0x1000-flagged bullets are
  // immune), awarding NO item outside bomb/spell context (the item-id global
  // DAT_018b8988 reads -1 there; measured on the native master death at
  // replay f922: child quads (r32, +2/frame, 8 frames, param6 7/9) plus the
  // master quad (r32, +1/frame, 16 frames, param6 7) swept ~85 bullets —
  // scripts/native-memtrace.mjs pool dump). Populated by the familiar
  // master-death sweep (settleTh08FamiliarDeath, all.c:20497/20542). Bomb
  // orb quads (r24, param5 500, param6 6) share the native pool but ride
  // bombClearRegions above.
  private readonly th08DeathClearZones: {
    x: number; y: number; radius: number; growth: number; framesLeft: number;
    // Quad param6 (all.c FUN_0044df00's 6th arg): the bullet->item
    // conversion type. A quad-probe hit writes it into player+0xe2a90
    // (FUN_00449ff0 @ all.c:36505); the bullet's state-5 entry then converts
    // it — type 9 pays TWO time orbs, any other type > -1 pays one item of
    // that type (all.c:23597-23651, each FUN_004400a0(.,7,1) forced to the
    // state-3 velocity draws). The familiar sweep arms 9 (child quads, the
    // stage-1 masters all hold +0x3324 bit1 clear) and 7 (master quad).
    convertType: number
  }[] = Array.from({ length: 16 }, () => ({
    x: 0, y: 0, radius: 0, growth: 0, framesLeft: 0, convertType: -1
  }));
  // The active bomb form's decoded state machine (12 forms, player-bombs.ts).
  private th08Bomb: Th08BorderBomb | null = null;
  // FUN_0044c650 invokes the selected callback in the trigger player pass.
  // That pass is later than the priority-12 item/bullet manager in the
  // native scheduler, so its cast-time records are published at the replay
  // boundary and become ordinary collision inputs on the following pass.
  private th08BombPendingStart = false;
  // Trigger-frame state-2 boundary defers the priority-8 shot-manager pass.
  // Native executes that queued pass before the ordinary current-frame
  // shot pass on the callback-start tick (Stage-2 f698: wave f696->f698).
  // Enemy-manager target caches (Th08.exe writes them through the absolute
  // globals 0x18b899c/0x18b89a8/0x18b89b4 in the per-enemy pass at
  // 0x42d3d3-0x42d4df): the primary position cache prefers the LOWEST
  // enemy (max y, first-slot tiebreak) and feeds the seeker tick
  // (FUN_00450320) and the human bomb's orb seek; the pointer-cache pick
  // (|x-player.x| < 64, upper-most/first) feeds the familiar's lunge anchor and
  // the needle shots' spawn aim (FUN_00450240 reads enemy+0x2d34/+0x2d38).
  private th08TargetPos: { x: number; y: number } | null = null;
  // Unlike the two position caches, DAT_018b89b4 is a persistent Enemy*
  // rather than a frame-local value. It is cleared by Ran's callback or
  // when the pointed pool slot is observed inactive; rebuilding it from
  // scratch skips the native one-frame stale-pointer handoff.
  private th08LungeEnemy: Enemy | null = null;
  // Bomb-orb visual follows for the PlayerEffects entries; each actor
  // keeps its VM handle so the burst transition can fire the authored
  // label-1 balloon/fade interrupt (player00 script 19).
  private th08BombOrbActors: { x: number; y: number; angle: number; state: number; handle?: PlayerEffectHandle }[] = [];
  // Live player spell-card declaration (bomb cut-in), FUN_00415d60's four
  // VMs; retires itself once every script has removed.
  private th08Declaration: Th08SpellDeclaration | null = null;
  // TH08 miss white-out countdown (player+0xe2a70): armed at 60 on the miss
  // commit and re-armed every squish frame (FUN_0044d180), drawn as a full
  // white playfield quad while nonzero (FUN_0044d2c0). NOT the deathbomb
  // window — the window itself has no white flash in the native.
  private th08DeathWhiteFrames = 0;
  // The night-time intro plate (times.anm script 0) arms on the first
  // stage-frame tick, after the stage-entry run state is in place.
  private th08IntroTimeArmed = false;
  // Focus aura (FUN_00425870(0x16) on focus-in, interrupt 1 out): the
  // follow-actor + handle pair so the aura tracks the player.
  private th08AuraActor: { x: number; y: number; angle: number; state: number } | null = null;
  private th08AuraHandle: PlayerEffectHandle | null = null;
  // Player-wide hit tally (exe player+0x240c): beams/attack slots pop a
  // spark on every 8th (lasers) / 4th (bomb slots) accumulated hit.
  private playerHitTally = 0;
  // Compatibility gate used by focused tests which tick the shot manager
  // without enabling collisions.
  private shotCollisionEnabled = true;
  // FUN_0043a980 @ all.c:27626 rejects the whole 96-shot/112-attack scan
  // when player+0x16a08 equals its previous integer value at +0x16a00.
  // In the normal player state FUN_0043e2e0 snapshots current->previous,
  // then advances the shared split counter with DAT_0056baa8. Consequently
  // enemy collision runs only on integer-advance frames during slow motion
  // (native Stage 5: rate 1/3, processing 6774/6775 skip, 6776 scans).
  // State 3 invulnerability and state 4 Border countdown retreat the same
  // split pair through FUN_00436a06. At normal speed its fast path leaves
  // +0x16a00 at the -999 sentinel, so collision remains wall-clock active;
  // under slow motion the helper publishes current->previous and collision
  // runs only on integer-retreat frames (Stage 5 processing 11415/11418).
  private playerShotCollisionClockFrac = 0;
  private playerShotCollisionClockSpecial = false;
  private playerShotCollisionClockAdvanced = true;
  // Committed player hits with the striking entity's provenance — the primary
  // localization signal for replay-golden divergences (a replayed player only
  // dies where our simulation disagrees with the original). Ring-capped at 64.
  hitLog: Array<{
    frame: number;
    stageFrame: number;
    kind: 'bullet' | 'laser' | 'body';
    playerX: number;
    playerY: number;
    bullet: {
      ownerId: number;
      ownerSub: number;
      spawnFrame: number;
      sprite: number;
      spriteOffset: number;
      x: number;
      y: number;
      angle: number;
      speed: number;
      age: number;
    } | null;
  }> = [];
  // Diagnostic seam for geometric contact before the invulnerability and
  // deathbomb outcome gate. Production leaves it unset.
  onPlayerContact?: (kind: 'bullet' | 'laser' | 'body') => void;
  // Floating number popups: two contiguous ring pools (720 large, 3 small).
  // All slots rise 0.5 px per rate-scaled frame and retire after 60.
  private popupsLarge: ScorePopup[] = Array.from({ length: 720 }, makeScorePopup);
  private popupsSmall: ScorePopup[] = Array.from({ length: 3 }, makeScorePopup);
  private popupCursorLarge = 0;
  private popupCursorSmall = 0;
  private readonly cancelItemType: ItemType = 'time';
  constructor(
    private assets: GameAssets,
    private audio: AudioBus,
    difficulty = 1,
    team: Th08TeamId = 'reimuYukari',
    stageNumber = 1,
    carry: RunCarry | null = null,
    initialRngSeed?: number
  ) {
    // The native game loads every SE buffer before play. Web Audio otherwise
    // drops the first request while fetching it.
    this.audio.preloadSfx([...new Set(TH08_SFX_SLOTS.map(([file]) => file))]);
    if (initialRngSeed != null) this.rng.seed = initialRngSeed & 0xffff;
    this.difficulty = difficulty;
    this.stageNumber = stageNumber;
    const stageData = (TH08_DATA.stages as unknown as Record<number, StageData>)[stageNumber];
    if (!stageData) throw new Error(`no data for stage ${stageNumber}`);
    const anms = assets.anms as Record<string, Anm>;
    this.enemyAnm = anms[stageData.enemyAnm];
    this.bgAnm = anms[stageData.bgAnm];
    this.effectAnm = anms[stageData.effectAnm];
    this.stdTxtAnm = anms[stageData.stdTxtAnm];
    this.faceAnm = anms[stageData.faceAnm];
    // STD quad script indices are virtual ids over the stage's bg ANM
    // files: Th07.exe loads them via FUN_00447c50 at bases 0x300 + 16 per
    // file (stg4bg=0x300, stg4bg2=0x310 ... stg4bg5=0x340, all.c:2909-2943)
    // and registers each file's scripts sequentially, so
    // vid = fileIndex*16 + positionInFile (stage 4's STD really references
    // 32=stg4bg3, 48..52=stg4bg4, 64=stg4bg5; stage 6's second entry gets
    // positions 5..9 despite its duplicate stored ids).
    const bgFiles = [this.bgAnm, ...((stageData.extraBgAnms ?? []).map((n) => anms[n]))];
    bgFiles.forEach((anm, fi) => {
      let pos = 0;
      anm.entries.forEach((entry, entryIndex) => {
        for (const localId of entry.scriptIds) {
          this.bgScripts.set(fi * 16 + pos, { anm, entryIndex, localId, spriteBase: entry.spriteBase });
          pos++;
        }
      });
    });
    // Stage-intro title: the native stage-load GUI init arms the stage's
    // stdNtxt.anm scripts 0-3 verbatim (Th08.exe v1.00d all.c:26963-26964 →
    // FUN_00462360(gui+0x2a44, 0, 4)); positions/slides/fades are baked into
    // the scripts, in 640x480 SCREEN coordinates (the playfield sits at
    // +32,+16 like the original). stgNtxt.anm script roles: 0 = "Stage N"
    // label (sprite1 @ (128,176)), 1 = the big stage title (sprite0 @
    // (224,208)), 2 = the flavor strip (sprite2 @ (224,268), fades out at
    // t=370-430), 3 = the stage-theme BGM credit (sprite3, slides
    // (544,456)->(288,456) at t=200, gone by 460 — userdemo-t20's
    // "BGM: 幻視の夜 ～ Ghostly Eyes"). MSG op7 later re-arms script 3 with
    // sprite base+slot+3 for the boss-theme credit (dialogueBgmRunner).
    // The demo branch instead arms script 3 alone with sprite base+3 =
    // "Demonstration" (all.c:26966-26972) — demo-only, never normal play.
    // All scripts finish and self-remove by ~frame 550.
    const introEntry = this.stdTxtAnm.entries[0];
    this.stageIntroRunners = (introEntry?.scriptIds ?? []).map(
      (id) =>
        new AnmRunner(this.stdTxtAnm, id, { entryIndex: 0, spriteIndexOffset: introEntry.spriteBase })
    );
    // TH08 runs the committed run-state (time orbs, night clock, human/
    // youkai gauge) in place of TH07's Supernatural Border cherry system.
    this.runState = new Th08RunState(difficulty);
    this.effectPoolCap = EFFECT_POOL_CAP_TH08;
    // Th08.exe rank table @ DAT_004c7880 ({init, min, max} per difficulty,
    // read from the binary): E/N 10/8/16, H/L 8/8/12, Extra 16/15/16.
    // TH07's 16-start + Lunatic [10,32] bounds do not apply.
    this.rank = difficulty <= 1 ? 10 : difficulty <= 3 ? 8 : 16;
    this.runtime = new StageRuntime(stageData, {
      // TH08 two-file enemy ANM (Th08.exe 0x42ebf0): the common
      // enemy.anm is file A, the stage's stgNenm.anm file B; the
      // dispatcher picks per enemy via flags2 bit 2.
      etama: assets.anms.etama,
      enemy: anms['enemy'],
      effect: this.effectAnm,
      enemyStage: this.enemyAnm
    });
    this.runtime.reset();
    this.runtime.initializeRandomCounters(this.rng);
    // TH08 item visuals are ANM VMs in etama.anm: ItemManager::SpawnItem runs
    // the global script (itemType + 61) per item (ItemManager.cpp:112). One
    // cached runner per type stands in for the per-item VMs — APPROXIMATION:
    // same-type items pulse in phase-locked sync. These render-only runners
    // must not touch the live gameplay RNG: constructing the type-10 runner
    // used to execute five random t0 ANM ops and advance every replay seed
    // by ten draws before frame zero. Per-item spawn draws belong to the
    // actual item allocation path, not this visual cache.
    this.th08ItemRunners = TH08_ITEM_TYPE_IDS.map((typeId) => {
      // The exe's etama global script index is (itemType + 61); on disk
      // etama.anm's script ids run -150..-35 (global = id + 150).
      const anm = assets.anms.etama;
      const targetId = 61 + typeId - 150;
      for (let entryIndex = 0; entryIndex < anm.entries.length; entryIndex++) {
        const entry = anm.entries[entryIndex];
        if (!entry.scriptIds.includes(targetId)) continue;
        return new AnmRunner(anm, targetId, {
          entryIndex,
          spriteIndexOffset: entry.spriteBase
        });
      }
      return null;
    });
    this.playerObj = new Player(team, assets.anms);
    this.playerEffects = new PlayerEffects(this.playerObj.anm);
    // FUN_00425430's effect VMs run in the effect manager's etama.anm (the
    // DAT_004c6d30 table maps effect id → archive script index: 5→37, 6→38,
    // 12→44); the bomb callbacks reference those archive indices directly.
    this.th08Effects = new PlayerEffects(assets.anms.etama);
    this.player = this.playerObj;
    // Mid-run stage entry: score/lives/power/graze persist across
    // stages within one credit (the exe keeps them in the run-global stats
    // block; only per-stage state — enemies, items, spell state — resets).
    if (carry) {
      this.score = carry.score;
      this.hiScore = carry.hiScore;
      this.graze = carry.graze;
      this.pointItems = carry.pointItems;
      this.playerObj.lives = carry.lives;
      this.playerObj.bombs = carry.bombs;
      this.playerObj.power = carry.power;
      this.rank = carry.rank;
      this.rankAccumulator = carry.rankAccumulator ?? 0;
      this.powerItemCountForScore = carry.powerItemCountForScore ?? 0;
      // The TH08 run state carries the night clock / gauge / item ladder
      // across stages (T8RP stage-entry snapshots mirror these fields).
      // score also needs the runState mirror (addScore routes through it).
      this.runState.score = carry.score;
      // run+0x30, the cumulative point-item counter: the extend-threshold
      // loop compares against it and the time-orb award scales with it, so
      // the carry must reach the run state, not just the HUD counter.
      this.runState.pointItemsCollected = carry.pointItems;
      if (carry.clockTime != null) this.runState.clockTime = carry.clockTime;
      if (carry.youkaiGauge != null) this.runState.youkaiGauge = carry.youkaiGauge;
      if (carry.pointItemValue != null) this.runState.pointItemValue = carry.pointItemValue;
      if (carry.pointItemExtends != null) this.runState.pointItemExtends = carry.pointItemExtends;
      if (carry.nextPointItemExtendThreshold != null) {
        this.runState.nextPointItemExtendThreshold = carry.nextPointItemExtendThreshold;
      }
      this.startStageTransition();
    }
    this.captureStageEntryTotals();
  }

  // Called after a replay stage snapshot overwrites the constructor defaults.
  // Browser playback and the Node verifier share this seam so clear-bonus
  // deltas use the original stage-entry cumulative counters.
  captureStageEntryTotals(): void {
    this.stageEntryGraze = this.graze;
    this.stageEntryPointItems = this.pointItems;
  }

  // -- native fixed-slot pools ---------------------------------------------

  private insertByPoolSlot<T extends { poolSlot: number }>(dense: T[], value: T): void {
    let lo = 0;
    let hi = dense.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (dense[mid].poolSlot <= value.poolSlot) lo = mid + 1;
      else hi = mid;
    }
    dense.splice(lo, 0, value);
  }

  addEnemy(enemy: Enemy): boolean {
    let slot = enemy.poolSlot;
    if (slot < 0 || slot >= ENEMY_POOL_CAP || this.enemySlots[slot] !== null) {
      slot = this.enemySlots.indexOf(null);
    }
    if (slot < 0) return false;
    enemy.poolSlot = slot;
    this.enemySlots[slot] = enemy;
    this.insertByPoolSlot(this.enemies, enemy);
    return true;
  }

  discardAllocatedEnemy(enemy: Enemy): void {
    const slot = enemy.poolSlot;
    if (slot >= 0 && slot < ENEMY_POOL_CAP && this.enemySlots[slot] === enemy) {
      this.enemySlots[slot] = null;
    }
    const dense = this.enemies.indexOf(enemy);
    if (dense >= 0) this.enemies.splice(dense, 1);
  }

  addEnemyBullet(bullet: EnemyBullet): boolean {
    const slot = bullet.poolSlot;
    if (slot < 0 || slot >= ENEMY_BULLET_POOL_CAP) return false;
    if (this.enemyBulletSlots[slot]?.dead) this.enemyBulletSlots[slot] = null;
    if (this.enemyBulletSlots[slot] !== null) return false;
    bullet.offscreenFrames = this.enemyBulletOffscreenCounters[slot];
    this.enemyBulletSlots[slot] = bullet;
    this.insertByPoolSlot(this.enemyBullets, bullet);
    return true;
  }

  clearEnemyBullets(resetFixedSlotStorage = false): void {
    this.enemyBullets.length = 0;
    this.enemyBulletSlots?.fill(null);
    if (resetFixedSlotStorage) {
      // Th07.exe (v1.00b) FUN_00422ea0 @ 0x422f48: item-producing clear
      // modes 1..8 `rep stos` the whole 0xd68-byte bullet slot after the
      // item spawn. This clears the slot-local +0xbfe off-screen counter.
      // Silent mode 0/10 and FUN_00423100 only enter state 5 and preserve
      // that field, so callers must request the hard reset explicitly.
      this.enemyBulletOffscreenCounters?.fill(0);
    }
  }

  removeEnemyBullet(bullet: EnemyBullet): void {
    bullet.dead = true;
    const slot = bullet.poolSlot;
    if (this.enemyBulletSlots && slot >= 0 && slot < ENEMY_BULLET_POOL_CAP && this.enemyBulletSlots[slot] === bullet) {
      this.enemyBulletSlots[slot] = null;
    }
  }

  private addPlayerBullet(bullet: PlayerBullet): boolean {
    const slot = this.playerBulletSlots.indexOf(null);
    if (slot < 0) return false;
    bullet.poolSlot = slot;
    this.playerBulletSlots[slot] = bullet;
    this.insertByPoolSlot(this.playerBullets, bullet);
    if (this.observePlayerShotSerial) this.playerShotSerial++;
    return true;
  }

  private syncEnemySlots(): void {
    if (this.slotsConsistent(this.enemies, this.enemySlots, ENEMY_POOL_CAP, (e) => !e.dead)) return;
    this.enemySlots.fill(null);
    const live = this.enemies.filter((enemy) => enemy && !enemy.dead);
    const rebuilt: Enemy[] = [];
    for (const enemy of live) {
      let slot = Number.isInteger(enemy.poolSlot) ? enemy.poolSlot : -1;
      if (slot < 0 || slot >= ENEMY_POOL_CAP || this.enemySlots[slot] !== null) slot = this.enemySlots.indexOf(null);
      if (slot < 0) { enemy.dead = true; continue; }
      enemy.poolSlot = slot;
      this.enemySlots[slot] = enemy;
      rebuilt.push(enemy);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.enemies = rebuilt;
  }

  private syncPlayerBulletSlots(): void {
    if (this.slotsConsistent(this.playerBullets, this.playerBulletSlots, PLAYER_BULLET_POOL_CAP, (e) => !e.dead)) return;
    this.playerBulletSlots.fill(null);
    const live = this.playerBullets.filter((bullet) => bullet && !bullet.dead);
    const rebuilt: PlayerBullet[] = [];
    for (const bullet of live) {
      let slot = Number.isInteger(bullet.poolSlot) ? bullet.poolSlot : -1;
      if (slot < 0 || slot >= PLAYER_BULLET_POOL_CAP || this.playerBulletSlots[slot] !== null) slot = this.playerBulletSlots.indexOf(null);
      if (slot < 0) { bullet.dead = true; continue; }
      bullet.poolSlot = slot;
      this.playerBulletSlots[slot] = bullet;
      rebuilt.push(bullet);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.playerBullets = rebuilt;
  }

  private syncEnemyBulletSlots(): void {
    if (this.slotsConsistent(this.enemyBullets, this.enemyBulletSlots, ENEMY_BULLET_POOL_CAP, (e) => !e.dead)) return;
    this.enemyBulletSlots.fill(null);
    const live = this.enemyBullets.filter((bullet) => bullet && !bullet.dead);
    const rebuilt: EnemyBullet[] = [];
    for (const bullet of live) {
      let slot = Number.isInteger(bullet.poolSlot) ? bullet.poolSlot : -1;
      if (slot < 0 || slot >= ENEMY_BULLET_POOL_CAP || this.enemyBulletSlots[slot] !== null) slot = this.enemyBulletSlots.indexOf(null);
      if (slot < 0) { bullet.dead = true; continue; }
      bullet.poolSlot = slot;
      this.enemyBulletOffscreenCounters[slot] = bullet.offscreenFrames ?? this.enemyBulletOffscreenCounters[slot];
      bullet.offscreenFrames = this.enemyBulletOffscreenCounters[slot];
      this.enemyBulletSlots[slot] = bullet;
      rebuilt.push(bullet);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.enemyBullets = rebuilt;
  }

  private syncItemSlots(): void {
    // TH08: the spawn pool's `active` flags track the live ItemEntities by
    // poolSlot; a dead entity releases its pool slot.
    if (this.th08ItemPool) {
      for (const item of this.items) {
        if (item.dead) {
          const slot = this.th08ItemPool.items[item.poolSlot];
          if (slot && slot.poolSlot === item.poolSlot) slot.active = false;
        }
      }
    }
  }

  private syncFixedPools(): void {
    this.syncEnemySlots();
    this.syncPlayerBulletSlots();
    this.syncEnemyBulletSlots();
    this.syncItemSlots();
    this.syncEffectSlots();
  }

  // Allocation-free validity check shared by the five sync*Slots methods. Returns
  // true when the dense iteration array and the fixed-slot array are mutually
  // consistent (same live set, each live entity's poolSlot points back at it, and
  // the live count equals the non-null slot count), so the caller can skip the
  // (allocating) rebuild. The decision is byte-identical to the old
  // `.filter()` + `.reduce()` + back-pointer check — it just allocates nothing.
  // This removes 5 fresh arrays + 5 reduce closures from every 60 Hz tick.
  private slotsConsistent<T extends { poolSlot: number }>(
    dense: T[], slots: (T | null)[], cap: number, isLive: (e: T) => boolean
  ): boolean {
    let live = 0;
    for (let i = 0; i < dense.length; i++) {
      const e = dense[i];
      if (e && isLive(e)) {
        live++;
        const ps = e.poolSlot;
        if (ps < 0 || ps >= cap || slots[ps] !== e) return false;
      }
    }
    let slotCount = 0;
    for (let s = 0; s < cap; s++) if (slots[s]) slotCount++;
    return live === slotCount;
  }

  // Order-preserving in-place compaction — replaces `this.x = this.x.filter(e => !e.dead)`
  // at three mid-update sites. A stable partition on !dead keeps the poolSlot-sorted
  // dense order intact and allocates nothing (the .filter allocated a fresh array each
  // tick, the dominant steady-state GC pressure). Result is byte-identical to the filter.
  private compactLive<T extends { dead?: boolean }>(arr: T[]): void {
    let w = 0;
    for (let r = 0; r < arr.length; r++) {
      const e = arr[r];
      if (e && !e.dead) arr[w++] = e;
    }
    arr.length = w;
  }

  private syncEffectSlots(): void {
    if (this.slotsConsistent(this.particles, this.effectSlots, this.effectPoolCap, (e) => e.age < e.life)) return;
    this.effectSlots.fill(null);
    const live = this.particles.filter((particle) => particle && particle.age < particle.life);
    const rebuilt: EffectParticle[] = [];
    for (const particle of live) {
      let slot = Number.isInteger(particle.poolSlot) ? particle.poolSlot : -1;
      if (slot < 0 || slot >= this.effectPoolCap || this.effectSlots[slot] !== null) {
        slot = this.effectSlots.indexOf(null);
      }
      if (slot < 0) continue;
      particle.poolSlot = slot;
      this.effectSlots[slot] = particle;
      rebuilt.push(particle);
    }
    rebuilt.sort((a, b) => a.poolSlot - b.poolSlot);
    this.particles = rebuilt;
  }

  private adjustRank(delta: number): void {
    // TH08 (FUN_0043bfc3/FUN_0043c03f, /100 accumulator) clamps to its own
    // table @ DAT_004c7880: E/N min 8 max 16, H/L min 8 max 12, Extra 15/16.
    const bounds = this.difficulty <= 1 ? { min: 8, max: 16 }
      : this.difficulty <= 3 ? { min: 8, max: 12 }
        : { min: 15, max: 16 };
    const before = this.rank;
    const beforeAccumulator = this.rankAccumulator;
    this.rankAccumulator += Math.trunc(delta);
    while (this.rankAccumulator >= 100) {
      this.rank++;
      this.rankAccumulator -= 100;
    }
    while (this.rankAccumulator < 0) {
      this.rank--;
      this.rankAccumulator += 100;
    }
    this.rank = Math.min(bounds.max, Math.max(bounds.min, this.rank));
    this.traceReplayEvent?.({
      kind: 'rank', frame: this.frame,
      data: {
        delta: Math.trunc(delta), before, beforeAccumulator,
        after: this.rank, afterAccumulator: this.rankAccumulator
      }
    });
  }

  private tickRankSurvival(): void {
    // FUN_0041ed50 @ 0x41eda5-0x41ee20 checks the enemy-manager split
    // counter before its per-frame tail advances it. A newly reached integer
    // tick is rewarded when divisible by 2400-lives*240. The source operand
    // is run stats +0x5c (the same lives float read by FUN_0042bf29), not the
    // difficulty byte. Dialogue/time freeze skips updateEnemies entirely;
    // slowmo advances the fraction only.
    if (this.rankSurvivalAdvanced) {
      const interval = 2400 - Math.trunc(this.playerObj.lives) * 240;
      // Native EnemyManager.cpp:734 gates the whole survival-rank block
      // (including IncreaseSubrank(100)) on !g_Gui.HasCurrentMsgIdx(). A boundary
      // that falls inside a dialogue window is simply missed, not deferred.
      if (this.rankSurvivalTicks > 0 && this.rankSurvivalTicks % interval === 0 &&
          !this.isDialogueActive()) {
        this.adjustRank(100);
      }
    }
    this.rankSurvivalAdvanced = false;
    this.rankSurvivalFraction += this.slowRate;
    while (this.rankSurvivalFraction >= 1) {
      this.rankSurvivalFraction -= 1;
      this.rankSurvivalTicks++;
      this.rankSurvivalAdvanced = true;
    }
  }

  // TH08 stage-clear bonus (MSG op9 snapshot all.c:24830-24847 + the tally
  // credit at all.c:25435-25478):
  //   award = CLEAR_BONUS_BY_STAGE[stage] + stageGraze*50
  //           + stagePointItems*5000 + currentTimeOrbs*100
  // The clear base is the per-stage .data table DAT_004c7158 (1M/1.5M/2M/
  // 2.5M/2.5M/3M/4M/6M/6.66M), NOT a flat 1M. Difficulty multipliers apply
  // in the exe's integer order: Easy /2, Hard *12/10, Lunatic *15/10,
  // Extra <<1; Phantasm has NO multiplier arm (all.c:25449-25460) even
  // though its tally rank line prints "*2.0" — a native display quirk,
  // reproduced. The configured-lives penalty follows (3/4/5/6 →
  // *5/10, *2/10, /10, /20). The original credits the award in ten
  // FUN_004181f0 slices; each adds floor(award/10) to the stored score.
  private static readonly CLEAR_BONUS_BY_STAGE = // DAT_004c7158
    [1000000, 1500000, 2000000, 2500000, 2500000, 3000000, 4000000, 6000000, 6660000];

  private computeClearBonus(): void {
    const stageGraze = this.graze - this.stageEntryGraze;
    const stagePointItems = this.pointItems - this.stageEntryPointItems;
    const timeOrbs = this.runState.currentTimeOrbs;
    const clearAward =
      StageScene.CLEAR_BONUS_BY_STAGE[this.stageNumber - 1] ?? StageScene.CLEAR_BONUS_BY_STAGE[0];
    const pointAward = stagePointItems * 5000;
    const grazeAward = stageGraze * 50;
    const timeAward = timeOrbs * 100;
    let award = clearAward + pointAward + grazeAward + timeAward;
    let mult = 1.0;
    switch (this.difficulty) {
      case 0: award = Math.trunc(award / 2); mult = 0.5; break;
      case 1: break;
      case 2: award = Math.trunc((award * 12) / 10); mult = 1.2; break;
      case 3: award = Math.trunc((award * 15) / 10); mult = 1.5; break;
      case 4: award *= 2; mult = 2.0; break;
      // Phantasm: the rank line prints *2.0 but no multiplier arm exists.
      case 5: mult = 2.0; break;
    }
    if (this.startingLives === 3) award = Math.trunc((award * 5) / 10);
    else if (this.startingLives === 4) award = Math.trunc((award * 2) / 10);
    else if (this.startingLives === 5) award = Math.trunc(award / 10);
    else if (this.startingLives === 6) award = Math.trunc(award / 20);
    this.clearBonus = {
      clear: clearAward * 10,
      point: pointAward * 10,
      graze: grazeAward * 10,
      time: timeAward * 10,
      player: 0,
      bomb: 0,
      mult,
      total: award * 10
    };
    for (let i = 0; i < 10; i++) this.addScore(award);
  }

  // Snapshot of everything that persists across a stage transition.
  carryState(): RunCarry {
    return {
      score: this.score,
      hiScore: Math.max(this.hiScore, this.score),
      graze: this.graze,
      pointItems: this.pointItems,
      lives: this.playerObj.lives,
      bombs: this.playerObj.bombs,
      power: this.playerObj.power,
      rank: this.rank,
      rankAccumulator: this.rankAccumulator,
      powerItemCountForScore: this.powerItemCountForScore,
      clockTime: this.runState.clockTime,
      youkaiGauge: this.runState.youkaiGauge,
      pointItemValue: this.runState.pointItemValue,
      pointItemExtends: this.runState.pointItemExtends,
      nextPointItemExtendThreshold: this.runState.nextPointItemExtendThreshold
    };
  }

  // -- GameHost --------------------------------------------------------------

  addScore(v: number): void {
    // TH08 credits score at award/10 (FUN_004181f0 @ 0x4181f0); the live
    // field is display/10-scale and the HUD shows it verbatim. Route through
    // the run state so score and the gauge/ladder consumers share one
    // accumulator.
    this.runState.addScore(v);
    this.score = this.runState.score;
  }

  setLatencyObservationEnabled(enabled: boolean): void {
    this.observePlayerShotSerial = enabled;
  }

  resetBombForLatencyProbe(): void {
    if (!this.observePlayerShotSerial) return;
    this.playerObj.bombTimer = 0;
    this.playerObj.bombCooldown = 0;
    this.playerObj.bombInvuln = 0;
    this.playerObj.bombs = Math.max(1, this.playerObj.bombs);
    this.prevBombTimer = 0;
    this.bombActiveThisFrame = false;
    this.bombCleanupDefersBorder = false;
    this.bombCleanupPending = false;
    this.bombEngine.reset();
    this.activeBombSlots.length = 0;
    for (const region of this.bombClearRegions) region.framesLeft = 0;
    this.bombClearBoxes.length = 0;
    for (const zone of this.th08DeathClearZones) zone.framesLeft = 0;
    this.playerEffects.clear();
    this.th08Effects.clear();
    this.screenShakes.length = 0;
    this.screenFlash = null;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  setSlowRate(rate: number): void {
    this.slowRate = rate;
  }

  setBulletTimeVisual(active: boolean): void {
    // Th07.exe v1.00b @ 0x418020/0x418130 writes 2/1 to the +0x1c6 interrupt
    // field of both global spell-background VMs. The writes occur even for
    // effect-10 param=1 (rate remains 1): this is an authored visual state,
    // not a color inferred from slowRate.
    const label = active ? 2 : 1;
    for (const runner of this.spellBackgroundRunners) runner.interrupt(label);
  }

  // Screen FX scheduler (Th08.exe FUN_0045b8b0). Type 1 shake: each frame both
  // camera axes independently pick {0, +mag, -mag}, mag ramping from->to
  // over the duration. Type 3 flash: a full-screen tint held `duration`
  // frames, repeated `repeats` times, alpha from the ARGB high byte.
  private readonly screenShakes: {
    duration: number;
    elapsed: number;
    from: number;
    to: number;
  }[] = [];
  private screenFlash: {
    duration: number;
    timer: number;
    repeats: number;
    color: number;
  } | null = null;
  private shakeX = 0;
  private shakeY = 0;
  private lastFogCells: { x: number; y: number; depth: number; fog: number }[] | null = null;

  // TH08 night blindness (DAT_004e3d24/28): the lit-circle radius and cover
  // intensity exported by ins_136 builtin 0; rendered by draw()'s nightBlind
  // pass. Fresh per stage — StageScene is constructed per stage start.
  private nightBlindIntensity = 0;
  private nightBlindRadius = 128;
  private th08NightBlindFrame: AnmFrame | null | undefined;

  setNightBlindness(intensity: number, radius: number): void {
    // FUN_00423390 exports the raw ECL locals. Intensity 0 (ins_123's clear,
    // all.c:9422) switches the effect off regardless of the radius word.
    this.nightBlindIntensity = intensity;
    if (intensity > 0 && Number.isFinite(radius) && radius > 0) {
      this.nightBlindRadius = radius;
    }
  }

  // Test-only probe (?test=1): the raw driver words behind drawNightBlindness,
  // so capture harnesses can log the veil timeline without touching privates.
  nightBlindState(): { intensity: number; radius: number } {
    return { intensity: this.nightBlindIntensity, radius: this.nightBlindRadius };
  }

  // Test-only probe: dialogue machine state for pacing comparisons.
  dialogueState(): { active: boolean; clock: number; done: boolean } | null {
    const d = this.th08Dialogue;
    if (!d) return null;
    const s = d.machine.state;
    return { active: !s.done, clock: s.clock, done: s.done };
  }

  // Test-only probe: per-cell fog telemetry from the last drawBackground pass
  // (screenX, screenY, viewDepth, fogAlpha) for aligning the port's fog
  // metric against native A/B captures. Collection stays off (and free)
  // until enabled once.
  fogCellTelemetry(): { x: number; y: number; depth: number; fog: number }[] {
    return this.lastFogCells ?? [];
  }
  enableFogCellTelemetry(): void {
    this.lastFogCells = [];
  }

  // TH08 night blindness (FUN_00405420, all.c:1583-1609): four black quads
  // close the playfield down to a square around the player, then etama
  // archive script 105 (entry 4's radial gradient, etama5.png sprite 229)
  // draws scaled radius/63 centered on the player with alpha = intensity —
  // its opaque rim meets the rects and its transparent middle keeps the lit
  // hole. Everything world-side drawn before this pass darkens; the
  // HUD/frame/sidebar do not. The shrinking radius (320→192→128) and fade
  // variants are ECL-authored via sub56/50/57/60 re-exports; ins_123 zeroes
  // the intensity.
  private drawNightBlindness(r: Renderer, ox: number, oy: number): void {
    const p = this.playerObj;
    const alpha = Math.min(1, this.nightBlindIntensity / 255);
    const scale = this.nightBlindRadius / 63;
    const half = 64 * scale;
    const cx = ox + p.x;
    const cy = oy + p.y;
    const left = PLAYFIELD.x;
    const top = PLAYFIELD.y;
    const right = left + PLAYFIELD.width;
    const bottom = top + PLAYFIELD.height;
    r.ctx.save();
    r.ctx.globalAlpha = alpha;
    r.ctx.fillStyle = '#000';
    const mx0 = Math.max(left, cx - half);
    const mx1 = Math.min(right, cx + half);
    if (mx0 > left) r.ctx.fillRect(left, top, mx0 - left, bottom - top);
    if (mx1 < right) r.ctx.fillRect(mx1, top, right - mx1, bottom - top);
    if (cy - half > top) r.ctx.fillRect(mx0, top, mx1 - mx0, cy - half - top);
    if (cy + half < bottom) r.ctx.fillRect(mx0, cy + half, mx1 - mx0, bottom - cy - half);
    r.ctx.restore();
    if (this.th08NightBlindFrame === undefined) {
      const runner = archiveScriptRunner(this.assets.anms.etama, 105);
      this.th08NightBlindFrame = runner ? runner.spriteFrame() : null;
    }
    r.drawAnmFrame(this.th08NightBlindFrame, cx, cy, { scaleX: scale, scaleY: scale, alpha });
  }

  startScreenShake(duration: number, from: number, to: number): void {
    // FUN_004459c0 allocates one scheduler object per request. Concurrent
    // shakes therefore retain independent clocks/RNG draws instead of a new
    // request replacing the previous one (native Phantasm PRE10485/10486).
    this.screenShakes.push({ duration: Math.max(1, duration), elapsed: 0, from, to });
  }

  startScreenFlash(duration: number, repeats: number, argb: number): void {
    this.screenFlash = {
      duration: Math.max(1, duration), timer: 0, repeats,
      color: argb >>> 0
    };
  }

  fadeBgm(seconds: number): void {
    this.audio.fadeOutBgm(seconds);
  }

  private tickScreenFx(): void {
    this.shakeX = 0;
    this.shakeY = 0;
    for (let i = 0; i < this.screenShakes.length;) {
      const shake = this.screenShakes[i];
      // Th07.exe (v1.00b) FUN_00445790 @ 0x4457c4-0x4457e6 advances
      // the split counter BEFORE testing it against the duration. Thus a
      // duration-N shake draws on counter values 1..N-1 (N-1 ticks), not
      // 0..N-1. Drawing before the advance kept effect 9 alive one extra
      // frame and consumed a spurious u32 pair (Stage 5 replay PRE5280).
      shake.elapsed += this.slowRate;
      if (shake.elapsed >= shake.duration) {
        this.screenShakes.splice(i, 1);
        continue;
      }
      const mag = shake.from + (shake.elapsed / shake.duration) * (shake.to - shake.from);
      // Scheduler order is allocation order and every instance writes the
      // shared camera fields. The last surviving instance therefore owns
      // the visible offset while all earlier instances still consume RNG.
      const xPick = this.rng.u32InRange(3);
      const yPick = this.rng.u32InRange(3);
      this.shakeX = xPick === 0 ? 0 : xPick === 1 ? mag : -mag;
      this.shakeY = yPick === 0 ? 0 : yPick === 1 ? mag : -mag;
      i++;
    }
    const flash = this.screenFlash;
    if (flash && ++flash.timer >= flash.duration) {
      flash.timer = 0;
      if (--flash.repeats <= 0) this.screenFlash = null;
    }
  }

  // FUN_00402260 (large pool) / FUN_00402310 (3-slot pool): digits stored
  // least-significant-first; value < 0 stores the single sentinel glyph 10;
  // value 0 stores one zero digit.
  spawnScorePopup(value: number, x: number, y: number, color: number, small = false): void {
    const pool = small ? this.popupsSmall : this.popupsLarge;
    const cursor = small ? this.popupCursorSmall : this.popupCursorLarge;
    const entry = pool[cursor % pool.length];
    if (small) this.popupCursorSmall = (cursor + 1) % pool.length;
    else this.popupCursorLarge = (cursor + 1) % pool.length;
    entry.active = true;
    entry.x = x;
    entry.y = y;
    entry.color = color >>> 0;
    entry.timer = 0;
    entry.timerFrac = 0;
    entry.digits.length = 0;
    let v = Math.trunc(value);
    if (v < 0) {
      entry.digits.push(10);
    } else if (v === 0) {
      entry.digits.push(0);
    } else {
      while (v !== 0) {
        entry.digits.push(v % 10);
        v = Math.trunc(v / 10);
      }
    }
  }

  // Th07.exe (v1.00b) FUN_00401ad0 @ 0x401ad0: the loop starts from each
  // entry's timer sub-structure (which hid it from the earlier pool-base
  // search), moves y by -0.5*slowRate, advances the standard split counter,
  // and clears active once its integer part is > 60.
  private updatePopups(): void {
    const updatePool = (pool: ScorePopup[]) => {
      for (const pop of pool) {
        if (!pop.active) continue;
        pop.y -= 0.5 * this.slowRate;
        if (this.slowRate > 0.99) {
          pop.timer++;
        } else {
          pop.timerFrac += this.slowRate;
          if (pop.timerFrac >= 1) {
            pop.timer++;
            pop.timerFrac -= 1;
          }
        }
        if (pop.timer > 60) pop.active = false;
      }
    };
    updatePool(this.popupsLarge);
    updatePool(this.popupsSmall);
  }

  // Draw pass (exe FUN_00403770 @ all.c:1684-1758): 8px-pitch glyphs, with
  // the first glyph center at x-digitCount*4. The popup
  // renderer indexes ascii.anm sprites 0..30 — the dedicated 8x8 Japanese-
  // styled number row, NOT the HUD's 8x12 sprites 132..141. At timer 52/56
  // it switches to the two authored decay rows. Script 3 has no ins_22, so
  // these VM coordinates retain center anchoring. Alpha is a squared-
  // distance-from-player pulse — 80/255 within 32px, an integer ramp to
  // 208/255 at 64px, flat beyond.
  private drawPopups(r: Renderer, ox: number, oy: number): void {
    const p = this.playerObj;
    const drawPool = (pool: ScorePopup[]) => {
      for (const pop of pool) {
        if (!pop.active) continue;
        const dx = pop.x - p.x;
        const dy = pop.y - p.y;
        const distSq = Math.round(dx * dx + dy * dy);
        const alphaByte = distSq <= 1024 ? 80
          : distSq >= 4096 ? 208
            : 80 + Math.trunc(((distSq - 1024) * 128) / 3072);
        const n = pop.digits.length;
        const startX = pop.x - n * 4;
        for (let i = 0; i < n; i++) {
          const glyph = pop.digits[n - 1 - i];
          // Th07.exe FUN_00403770 @ 0x40387b: the 48x8 PowerUp sentinel
          // (sprite 10) never changes bank; numeric glyphs use sprites
          // 11..20 at timer 52 and 21..30 at timer 56.
          const sprite = glyph === 10 ? 10
            : pop.timer >= 56 ? glyph + 21
              : pop.timer >= 52 ? glyph + 11 : glyph;
          const sx = sprite <= 9 ? sprite * 8
            : sprite === 10 ? 80 : 128 + ((sprite - 11) % 10) * 8;
          const sy = sprite >= 21 ? 8 : 0;
          const sw = sprite === 10 ? 48 : 8;
          r.drawSpriteInBatch('ascii', sx, sy, sw, 8,
            ox + startX + i * 8, oy + pop.y,
            0, 1, alphaByte / 255, 'source-over', pop.color);
        }
      }
    };
    // A full-field sweep legitimately activates the whole 720-slot large
    // pool at once (~4000 glyphs/frame for 60 frames) — bracketed batch
    // drawing keeps that survivable; the per-glyph save/restore path froze
    // Lunatic phase ends.
    r.ctx.save();
    drawPool(this.popupsLarge);
    drawPool(this.popupsSmall);
    r.ctx.restore();
  }

  private th08ItemPool: Th08ItemSpawnPool | null = null;

  // TH08 item spawn: the pool decides slot + type + state + velocity with the
  // native RNG draw order; the resulting ItemEntity joins the same list the
  // renderer/updater already walks, linked by poolSlot so the pool's `active`
  // flag tracks the entity's life.
  private spawnItemTh08(type: ItemType, x: number, y: number, options: { state?: number }): void {
    this.th08ItemPool ??= new Th08ItemSpawnPool();
    const pool = this.th08ItemPool;
    const spawned = pool.spawn({
      x, y,
      type: type as import('./th08-item-spawn').Th08ItemType,
      state: options.state,
      rng: this.rng,
      playerDead: !this.playerObj.alive,
      power: this.playerObj.power
    });
    if (!spawned) return;
    const item: ItemEntity = {
      id: this.id++,
      poolSlot: spawned.poolSlot,
      x: spawned.x,
      y: spawned.y,
      vx: spawned.vx,
      vy: spawned.vy,
      type: spawned.type,
      age: 0,
      state: spawned.state,
      ...(spawned.targetX !== undefined
        ? { tween: { sx: spawned.x, sy: spawned.y, tx: spawned.targetX, ty: spawned.targetY ?? 0, elapsed: 0, frac: 0 } }
        : {})
    };
    // FUN_004400a0 links every spawn at the TAIL of the item manager's
    // active list (+0x2dc/+0x2e0), and FUN_00440500 walks that list head to
    // tail — iteration order is SPAWN order, not pool-slot order. The two
    // diverge once the 2096-slot rotating cursor wraps or reuses freed
    // slots, which reorders same-frame collects and with them the RNG draw
    // sequence. Append keeps the dense array in spawn order (the compact in
    // updateItems preserves relative order).
    this.items.push(item);
    this.traceReplayEvent?.({
      kind: 'item-spawn', frame: this.frame,
      data: { type: item.type, slot: item.poolSlot, x: item.x, y: item.y, state: item.state }
    });
  }

  spawnItem(type: ItemType, x: number, y: number, options: { state?: number } = {}): void {
    // TH08: allocate through the committed Th08ItemSpawnPool, which encodes
    // ItemManager::SpawnItem's exact decisions (2096-slot rotating cursor,
    // out-of-bounds x reject, full-power power→pointSmall, time/time2 state
    // forcing, state-2 tween target + state-3/5 velocity RNG draw order).
    this.spawnItemTh08(type, x, y, options);
  }

  spawnEffectParticles(
    effectId: number,
    x: number,
    y: number,
    count: number,
    color: number,
    seed?: { x: number; y: number; z: number },
    ownerEnemyId?: number,
    // Border break only: the 32 fixed petal directions, assigned to the 32
    // BreakBorder SpawnEffect calls in order. Native loops 32× unconditionally
    // and each SpawnEffect always allocates (a full pool writes dummy slot
    // 408 rather than returning null), so allocation index == call index is
    // 1:1 with these directions. Indexed by (requested - remaining), the
    // successful-allocation count. Never feeds back into spawn order or RNG.
    burstDirs?: readonly { x: number; y: number }[]
  ): void {
    // The whole engine draws from ONE RNG stream (all 147 exe call sites share
    // state 0x495e00), so a decorative effect that consumes the wrong number of
    // draws desyncs every later GAMEPLAY draw that frame. FUN_0041b320 scans a
    // rolling, fixed 400-slot pool and only initializes (therefore only draws
    // RNG for) a particle after it finds a free slot. A full scan stops the
    // entire request. This capacity/order contract is observable in Stage 3,
    // where a four-snow request at processing frame 939 finds only two slots.
    const requested = Math.max(0, count | 0);
    const spec = EFFECT_DRAW_COST[effectId];
    let remaining = requested;
    for (let tries = 0; tries < this.effectPoolCap && remaining > 0; tries++) {
      const slot = this.effectPoolCursor;
      this.effectPoolCursor = (this.effectPoolCursor + 1) % this.effectPoolCap;
      if (this.effectSlots[slot] !== null) continue;

      let particle: EffectParticle;
      if (spec !== undefined) {
        // TH08 single-path: every effect id draws EXACTLY its measured
        // spawn-time cost (script random ops + init callback, see the table).
        // The first pair of raw u16s only drives the port's fallback visual;
        // authored lifetime/capacity remains exact. TH08 stages 1-2 never
        // exercise ids outside the measured table; warn once if one appears.
        const perParticle = spec;
        // Draw EXACTLY `perParticle` raw u16. The first pair only drives the
        // port's fallback visual; authored lifetime/capacity remains exact.
        let vx = 0;
        let vy = 0;
        // Retain effect-51's raw values: FUN_004069f0 first executes the five
        // ANM random ops (10 u16), then FUN_00426280 consumes eight u32
        // values (16 u16) for its world position/velocity/acceleration.
        const fireflyRaw: number[] | null = effectId === 51 ? [] : null;
        for (let d = 0; d < perParticle; d++) {
          const raw = this.rng.u16();
          fireflyRaw?.push(raw);
          if (d === 0) {
            const ang = (raw / 65536) * Math.PI * 2;
            vx = Math.cos(ang);
            vy = Math.sin(ang);
          } else if (d === 1) {
            const speed = (0.3 + (raw / 65536) * 0.9) * this.slowRate;
            vx *= speed;
            vy *= speed;
          }
        }
        if (seed) {
          vx += seed.x * 0.02;
          vy += seed.y * 0.02;
        }
        let world: EffectParticle['world'] | undefined;
        if (fireflyRaw && fireflyRaw.length >= 26) {
          const random01 = (at: number): number =>
            (((fireflyRaw[at] << 16) | fireflyRaw[at + 1]) >>> 0) / 0x100000000;
          const randomSigned = (at: number, amplitude: number): number =>
            (random01(at) * 2 - 1) * amplitude;
          const camera = this.runtime.std.camera();
          const facing = this.runtime.std.facing();
          const rate = Math.fround(this.slowRate);
          // FUN_00426280 @ 0x426295-0x426366: the spawn base is vec(0x4ea3d0)
          // (= A, the live RAW facing vector, |A|~680 in Stage 1) + vec
          // (0x4ea3c4) (= B, the camera eye) via FUN_00409080, then each axis
          // adds (rand − A/2) with divisor _DAT_004b42ec = 2.0: x = signed(60),
          // y = signed(100) − _DAT_004b4530(50.0), z = rand(100) − _DAT_004b4980
          // (100.0) — net center = B + A/2 + (0, −50, −100), the midpoint of
          // the view ray. The old model pinned camera + (0, +100, +30), which
          // coincides only at one facing pose; as the Stage-1 facing track
          // lerps to (0,500,460) the native center walks to camera +
          // (0,200,130) while the port stayed ~100 units behind along the view
          // axis, spawning inside/behind the 0.94 cone edge (center dot ≈0.90
          // vs native ≈0.99). Port fireflies died at spawn, kept ~2 effect-
          // pool slots free, and let extra effect-51 arms allocate — the gx
          // st1 f861 +52 draw event. Float ops follow the native f32 chain:
          // per axis pos = f32(randTerm + f32(−A/2)) + f32(A + B), each store
          // rounded like the fstp at 0x426302/0x426334/0x426366.
          const ax = Math.fround(facing.x);
          const ay = Math.fround(facing.y);
          const az = Math.fround(facing.z);
          const addAxis = (
            base: number, randTerm: number, aComp: number
          ): number => Math.fround(
            Math.fround(base + aComp) + Math.fround(randTerm + Math.fround(-aComp / 2))
          );
          world = {
            x: addAxis(Math.fround(camera.x), Math.fround(randomSigned(10, 60)), ax),
            y: addAxis(Math.fround(camera.y), Math.fround(randomSigned(12, 100) - 50), ay),
            z: addAxis(Math.fround(camera.z), Math.fround(random01(14) * 100 - 100), az),
            // FUN_00426280 tail (asm 0x42636c-0x426407): vel/accel are
            // drawn amplitudes — vel.x = ±0x3a83126f (f32 0.001), vel.y =
            // ±0x03, vel.z = −rand(0.1)−0.3, acc = (±0x38d1b717, ±0x38d1b717,
            // −0.0003) (f32 0.0001 each) — each ×slowRate ONCE here
            // (FUN_00409120 with DAT_017ce8e0); the tick never re-scales.
            // Verified per-constant against the disassembly 2026-08-30.
            vx: Math.fround(Math.fround(randomSigned(16, 0.001)) * rate),
            vy: Math.fround(Math.fround(randomSigned(18, 0.03)) * rate),
            vz: Math.fround(Math.fround(-random01(20) * 0.1 - 0.3) * rate),
            ax: Math.fround(Math.fround(randomSigned(22, 0.0001)) * rate),
            ay: Math.fround(Math.fround(randomSigned(24, 0.0001)) * rate),
            az: Math.fround(-0.0003 * rate),
            angle: 0,
            angularVelocity: 0
          };
        }
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x, y, vx, vy, age: 0,
          life: EFFECT_SCRIPT_LIFE[effectId] ?? 24,
          color, size: 2, kind: 'spark',
          ...(world ? { world } : {}),
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      } else {
        // TH08: every id used by stages 1-2 is in the measured table. An
        // unknown id draws 0 (the table's explicit 0 entries are measured,
        // not defaults) and warns once so new information gets modeled.
        warnUnhandledOp(`effect ${effectId}: no measured TH08 draw cost, treating as 0`);
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x, y, vx: 0, vy: 0, age: 0,
          life: EFFECT_SCRIPT_LIFE[effectId] ?? 24,
          color, size: 2, kind: 'spark',
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      }
      this.effectSlots[slot] = particle;
      this.insertByPoolSlot(this.particles, particle);
      const burstDir = burstDirs?.[requested - remaining];
      if (burstDir) particle.burstDir = burstDir;
      remaining--;
    }
    // Forensics for the shared 512-slot pool's pressure phase (native /proc
    // census collides against these allocations): what was requested, how
    // many actually allocated, and the per-id occupancy after the call.
    if (this.traceReplayEvent) {
      let live = 0, n51 = 0, n62 = 0;
      const byId: number[] = new Array(66).fill(0);
      for (const s of this.effectSlots) {
        if (s == null) continue;
        live++;
        byId[s.effectId] = (byId[s.effectId] ?? 0) + 1;
        if (s.effectId === 51) n51++;
        else if (s.effectId === 62) n62++;
      }
      this.traceReplayEvent?.({
        kind: 'effect-spawn', frame: this.frame,
        data: {
          effectId, requested, allocated: requested - remaining,
          live, n51, n62, byId: byId.join(','),
          ...(effectId === 0 ? {
            src: new Error().stack?.split('\n').slice(2, 5).map((s) => s.trim().replace(/^at\s+/, '')).join(' <- ')
          } : {})
        }
      });
    }
  }

  releaseEnemyEffects(ownerEnemyId: number): void {
    // FUN_0041dda0 sets the six op100 aura handles' +0x2ce release byte.
    // FUN_004198b0 then fades them for 16 effect-manager ticks before freeing
    // their general-pool slots; release happens ahead of priority-11 effects,
    // so the first fade tick is the same frame as enemy removal.
    for (const particle of this.particles) {
      if (particle.ownerEnemyId === ownerEnemyId && particle.releaseFrames == null) {
        particle.releaseFrames = 16;
      }
    }
  }

  playSfx(id: number): void {
    // Th07.exe FUN_00446970 @ 0x446970: the 5-slot SE queue drops a request
    // whose id is already queued this service cycle — net effect, any SE id
    // plays at most once per frame no matter how many requests (bug 2: the
    // per-bullet se_damage00 spam).
    if (this.sfxPlayedThisFrame.has(id)) return;
    this.sfxPlayedThisFrame.add(id);
    // TH08 plays through its own 46-channel id table (.data 0x4c8040 —
    // ids resolve to different FILES than TH07's table for the same id).
    const slot = TH08_SFX_SLOTS[id];
    if (slot) this.audio.sfx(slot[0], slot[1], id);
  }

  // TH08 form byte (exe player+5 / FUN_0040bc40) for the ECL VM's familiar
  // spawn marking and form-rank gate.
  th08PlayerForm(): 0 | 1 {
    return this.playerObj.th08Form;
  }

  th08GaugeExtreme(): boolean {
    return this.runState.gaugeIsExtremelyHuman() || this.runState.gaugeIsExtremelyYoukai();
  }

  // TH08 op 184 receiver: the global side mirror on singleton 0x4ea670
  // (bit 11). Consumers outside the slice: FUN_00416b10's spell-bonus
  // accumulator gate — kept on the run state for later wiring.
  th08SetSideMirror(value: 0 | 1): void {
    this.runState.th08SideMirror = value;
  }

  // TH08 pre-boss/post-boss conversation (timeline ins_6 -> FUN_0043396d
  // "msg start %d"). The committed Th08DialogueMachine drives the original
  // four-portrait MSG semantics (ops 15/16/17/21/22); the entry index maps
  // directly into the msg blob's entry table (TH08 keeps per-phase entries
  // rather than TH07's character*10+phase addressing).
  private startDialogueTh08(index: number): void {
    const raw = this.runtime.msg.messages[index];
    if (!raw || raw.length === 0) return;
    // Gui::StartMsg's tail (FUN_0043396d @ all.c:24655-24657) performs
    // exactly three field clears before the conversation runs:
    //   FUN_00415c60()  — cancel every enemy bullet to items (+ lasers);
    //   FUN_0042efb0(0,0) — sweep ordinary enemies (HP=0 via the death
    //                      path; value cap 0, return discarded);
    //   FUN_004413e0()  — force every live item into homing state 1 and
    //                      write velocity (0,-0.5,0).
    // The
    // player, background scroll, effects, and BGM keep running natively;
    // only the field is emptied, which is why the input-locked player
    // cannot be shot mid-conversation.
    this.cancelBulletsToItems();
    this.runtime.killNonBossEnemies(this, null, 0, 0);
    this.homeAllItemsTh08();
    // Bridge the Msg parser's decoded instructions into the machine's
    // {time, op, args, text} shape. The parser has already split TH08's
    // packed op1/op15/op17 payloads (portrait = low i16, script = high).
    const instructions = raw.map((ins) => ({
      time: ins.time,
      op: ins.op,
      // Ops 1/2/5 all carry the packed i16 pair (slot low, script/expression
      // high) — the parser splits them into portrait/script. Passing the
      // generic i32 args for op 5 handed the machine a packed 0x50000-style
      // dword as the slot and crashed the intro conversation's tail.
      args: ins.op === 1 || ins.op === 2 || ins.op === 5
        ? [ins.portrait ?? 0, ins.script ?? 0]
        : ins.op === 8
          ? [ins.color ?? 0, ins.line ?? 0]
        : ins.op === 15
          ? [ins.slot ?? 0, ...(ins.interrupts ?? [-1, -1, -1, -1])]
          : ins.op === 17
            ? [ins.slot ?? 0, ins.interrupt ?? 0]
            : ins.args,
      text: ins.text
    }));
    this.th08Dialogue = {
      machine: new Th08DialogueMachine(instructions, { ownershipSide: 0 }),
      runners: [null, null, null, null],
      portraitOffsets: [0, 0, 0, 0],
      lastPositions: [4, 4, 4, 4]
    };
    this.dialogueBossIntroLine = null;
    // The enemy-death -> dialogue path (0x42b1e5) pulls the gauge one
    // twelfth of the way back toward neutral when a conversation starts.
    this.runState.addYoukaiGauge(this.runState.gaugeDialoguePull());
  }

  // ItemManager::FUN_004413e0 (all.c:31356, called at message start, every
  // live MSG frame, and FUN_0040be30's bomb-trigger tail): walk the linked
  // 0x2dc-byte ITEM records, set +0x2d7 to homing state 1 and overwrite the
  // velocity vector at +0x2b0 with (0,-0.5,0). It does not touch player
  // shots, consume RNG, or advance the fixed-item allocation cursor.
  private homeAllItemsTh08(): void {
    for (const it of this.items) {
      if (it.dead) continue;
      it.state = 1;
      it.vx = 0;
      it.vy = Math.fround(-0.5);
    }
  }

  // Publish one enemy into the caches reset at the head of updateEnemies.
  // Native does this INSIDE each slot's collision block (0x42d3d3-42d4df),
  // before damage/death settlement. A shot-killed enemy therefore remains
  // the next player tick's target when it wins the strict first-slot tie;
  // rebuilding from the compacted live list bent Yukari's seekers toward a
  // different fairy one frame early and shifted every later impact/RNG arm.
  private publishTh08TargetCandidate(e: Enemy): void {
    if (!e.ecl.interactable) return;
    // all.c:21448-21450 puts collision and BOTH cache publications behind
    // raw flags bits 4/5/11 all being clear. The invisible stage controller
    // and ethereal familiars must never become targets.
    if (((e.ecl.th08?.flags ?? 0) & (0x10 | 0x20 | 0x800)) !== 0) return;
    if (!this.th08TargetPos || e.y > this.th08TargetPos.y) {
      this.th08TargetPos = { x: e.x, y: e.y };
    }
    // DAT_018b89b4 (the Border Team option-lunge / focused-shot target)
    // uses abs(enemy.x - player.x) < 64, not distance from the playfield
    // centre.  At replay stage 2 f727 the player is at x=172 and the nearest
    // fairy is at x=280.806: native leaves the cache null, keeping Yukari's
    // option at (172,32) and the three type-1 shots on their authored upward
    // headings.  Using 224 here selected that fairy and sent all three shots
    // down-right instead.
    // FUN_0041fd20 tests enemy+0x2da4 and excludes child-spawned actors
    // from this cache. They remain valid for the ordinary homing cache
    // above, but Ran must not retarget from a dying wave master onto one of
    // its children (native Stage-2 f922 leaves DAT_018b89b4 null).
    if (!e.ecl.parent && Math.abs(e.x - this.playerObj.x) < 64 &&
        (!this.th08LungeEnemy || e.y < this.th08LungeEnemy.y)) {
      this.th08LungeEnemy = e;
    }
  }

  // The player update's gauge block (0x44bdf0-0x44c012): fire drift while
  // the shot cycle is armed and the focus state has been stable >= 30
  // frames; idle drift back toward neutral once player+0xe2ad0 reaches 30.
  // This is called before firePlayerBullets so the cycle's frame-19 tick is
  // still armed, matching FUN_0044aec0 -> FUN_00451500 native order.
  private tickTh08Gauge(): void {
    const run = this.runState;
    const p = this.playerObj;
    // Player-tick tail (all.c:37597-37614): gated only on IsDialogPresent,
    // NOT on bombs — every non-dialogue tick counts the tally denominator,
    // and each frame past either effects threshold (±8000) trickles a +100
    // award (addScore applies the native /10 → +10 live score).
    if (!this.isDialogueActive()) {
      const trickle = run.tickGaugeTrickle();
      if (trickle) this.addScore(trickle);
    }
    // Player::OnUpdate dispatches the deathbomb-window state (2) and death
    // squish state (1), then explicitly skips FUN_0044aec0. Its later tally
    // counters still run, so this gate belongs after tickGaugeTrickle().
    // Materialize state 3 is not excluded by the native dispatcher.
    if (p.hitState || p.dyingFrame >= 0 || this.th08Bomb || this.isDialogueActive()) {
      return;
    }
    // player+8 is 0-based (the initial normal-form callback begins at zero),
    // whereas Player.th08FocusFrames is incremented at this port's callback
    // head. Native Compare(30) therefore opens when our mirror has passed 30.
    if (p.th08FocusFrames <= 30) return;
    const clock = p.tickTh08GaugeTimers(p.fireFrame >= 0, this.slowRate);
    if (clock.fireTimer !== null) {
      run.addYoukaiGauge(run.gaugeFireDrift(p.th08Form === 1, clock.fireTimer));
    } else if (clock.idleReady && run.youkaiGauge !== 0) {
      run.addYoukaiGauge(run.gaugeIdleDrift());
    }
  }

  private updateTh08Dialogue(input: InputFrame): void {
    const dlg = this.th08Dialogue;
    if (!dlg) return;
    // Native order: ItemManager (priority 12) ... GUI (priority 15) re-runs
    // FUN_004413e0 every MSG frame, so the boundary publishes every surviving
    // item in state 1 with the authored (0,-0.5) velocity.
    if (!dlg.machine.state.done) this.homeAllItemsTh08();
    let bits = 0;
    if (input.held.has('shoot') || input.held.has('confirm')) bits |= TH08_DIALOGUE_INPUT_BITS.confirm;
    if (input.held.has('up')) bits |= TH08_DIALOGUE_INPUT_BITS.humanDirection;
    if (input.held.has('down')) bits |= TH08_DIALOGUE_INPUT_BITS.youkaiDirection;
    if (input.held.has('skip')) bits |= TH08_DIALOGUE_INPUT_BITS.fastForward;
    const events = dlg.machine.update(bits);
    for (const event of events) {
      switch (event.type) {
        case 'portrait-init': {
          // op1 = SetScript on the slot's portrait VM (gui-run-msg.c case 1
          // -> FUN_004069f0): the expression script begins parked hidden at
          // (-224,128) alpha 0. The enter label (1) releases the authored
          // 30-frame slide-in + alpha ramp; RunMsg itself never touches the
          // VM interrupt, so the engine site that fires label 1 sits outside
          // the exported Gui functions — firing it at init reproduces the
          // native portrait entrance (§7 approximation for the trigger
          // site). Slot-to-face mapping: 0 = human side (face_rm00), 1 =
          // youkai side (face_yk00), 2/3 = the stage NPC (face_stNN).
          const slot = event.slot;
          if (slot < 0 || slot > 3) break;
          const faceKey = slot === 0 ? 'face_rm00'
            : slot === 1 ? 'face_yk00'
              : this.stageDataFaceKey();
          const faceAnm = (this.assets.anms as Record<string, Anm>)[faceKey];
          if (!faceAnm) break;
          const entryIndex = Math.max(0, Math.min(faceAnm.entries.length - 1, event.script));
          const entry = faceAnm.entries[entryIndex];
          const scriptId = entry?.scriptIds[0];
          if (scriptId == null) break;
          const runner = new AnmRunner(faceAnm, scriptId, {
            entryIndex,
            spriteIndexOffset: entry?.spriteBase ?? 0
          });
          dlg.runners[slot] = runner;
          // The op1 tail stores a per-slot draw offset from the face's
          // texture height (gui-run-msg.c:61-66): <=128px -> 0, taller ->
          // -112. The script's synchronous first tick has already set the
          // sprite when the native reads the height; read the entry's
          // first sprite directly for the same value.
          const faceHeight = faceAnm.sprites.get(entry.spriteIds[0])?.h ?? 0;
          dlg.portraitOffsets[slot] = faceHeight <= 128 ? 0 : -112;
          runner.interrupt(1);
          break;
        }
        case 'portrait-interrupt': {
          // op2 = SetSprite(vm, ordinal) (gui-run-msg.c case 2 ->
          // FUN_0045e430): swap the displayed expression sprite; no
          // script-flow change. The tail refreshes the per-slot offset from
          // the NEW sprite's height (<=128 -> 0, <=256 -> -80, else -208).
          const runner = dlg.runners[event.slot];
          if (runner && event.interrupt >= 0 && runner.setSpriteOrdinal(event.interrupt)) {
            const h = runner.spriteSize()?.h ?? 0;
            dlg.portraitOffsets[event.slot] = h <= 128 ? 0 : h <= 256 ? -80 : -208;
          }
          break;
        }
        case 'active-slot': {
          // op15 = the active-speaker switch: position codes 3/4/6 land on
          // every slot (consumed by the position sync below) and each >=0
          // int is a SetSprite ordinal for that slot (gui-run-msg.c:254-265
          // — the same FUN_0045e430 as op2, applied slot-by-slot).
          for (let i = 0; i < 4; i++) {
            const ordinal = event.interrupts[i];
            if (ordinal >= 0) dlg.runners[i]?.setSpriteOrdinal(ordinal);
          }
          break;
        }
        case 'slot-update': {
          // op17 = SetSprite on the new active slot only
          // (gui-run-msg.c:295-326).
          if (event.interrupt >= 0) dlg.runners[event.slot]?.setSpriteOrdinal(event.interrupt);
          break;
        }
        case 'sound':
          // RunMsg sound ids: 12 = ownership swap tick (case 0x15 edge),
          // 10 = the denial tick on a late confirm edge (all.c:25049).
          this.playSfx(event.id);
          break;
        case 'music-change': {
          if (event.slot < 0) {
            this.audio.stopBgm();
            this.dialogueBgmRunner = null;
            break;
          }
          const track = stageBgmTrack(this.stageNumber, event.slot);
          if (track) this.audio.playBgm(track);
          // FUN_004069f0(gui+0x3230, 3), followed by SetSprite(slot+3).
          const entry = this.stdTxtAnm.entries[0];
          if (entry && this.stdTxtAnm.hasScriptInEntry(0, 3)) {
            this.dialogueBgmRunner = {
              runner: new AnmRunner(this.stdTxtAnm, 3, {
                entryIndex: 0,
                spriteIndexOffset: entry.spriteBase
              }),
              spriteIndex: entry.spriteBase + event.slot + 3
            };
          }
          break;
        }
        case 'boss-intro-line':
          this.dialogueBossIntroLine = event.text;
          break;
        case 'game-mode':
          // op22 restarts the entry with the new ownership side.
          break;
        case 'resume-ticket':
          // op6: releases the timeline's op-7 dialogue hold for one pass
          // (RunMsg msg+0x22d78; the boss-entry ECL resumes mid-conversation).
          this.dialogueResume = true;
          break;
        case 'done':
          this.th08Dialogue = null;
          this.dialogueBossIntroLine = null;
          this.dialogueResume = true;
          break;
      }
    }
    // Position codes drive the emphasis labels: 3 = active (full color,
    // centered at (48,128)), 4 = same-side rest (dim, shrunk toward
    // (24,136)), 6 = far-side rest (color-dimmed), 5 = the exit slide that
    // fades the portrait out and ends its script. The face scripts' label
    // bodies match the codes one-to-one (face_rm00.anm entry scripts,
    // labels 1..6), and the msg streams close with op5(slot,5) rows. The
    // engine consumer of the position codes sits outside the exported Gui
    // functions (RunMsg only writes them) — mapping a code to its label
    // interrupt here reproduces the native presentation (§7).
    const portraitState = dlg.machine.state;
    for (let slot = 0; slot < 4; slot++) {
      const runner = dlg.runners[slot];
      const position = portraitState.portraits[slot].position;
      if (runner && position !== dlg.lastPositions[slot] && position >= 3 && position <= 6) {
        runner.interrupt(position);
      }
      dlg.lastPositions[slot] = position;
    }
    for (const runner of dlg.runners) runner?.update();
    if (dlg.machine.state.done) {
      this.th08Dialogue = null;
      this.dialogueBossIntroLine = null;
      this.dialogueResume = true;
    }
  }

  private stageDataFaceKey(): string {
    const stages = TH08_DATA.stages as unknown as Record<number, { faceAnms?: readonly string[] }>;
    const faceAnms = stages[this.stageNumber]?.faceAnms;
    return faceAnms?.[2] ?? 'face_st01';
  }

  startDialogue(index: number): void {
    this.startDialogueTh08(index);
  }

  // FUN_0043c35f (all.c:28503-28569): the tally's night-clock advance pays
  // +1 when the stage's time-orb quota (DAT_004c77f0 stage×difficulty
  // table) is met, +2 when missed; stages 6/7/Extra pay 0.
  private th08ClockAdvance(): number {
    if (this.stageNumber >= 6) return 0;
    const quota = TH08_STAGE_ORB_QUOTAS[this.stageNumber - 1]?.[this.difficulty] ?? 0;
    return this.runState.currentTimeOrbs >= quota ? 1 : 2;
  }

  private activateStageResults(): void {
    if (this.stageResultsActive) return;
    this.stageResultsActive = true;
    this.stageClearTimer = 0;
    this.computeClearBonus();
    // MSG op9 snapshots the night clock onto the tally (all.c:24837-24845):
    // the current row holds the entry minutes; the advanced row counts up
    // from the same value toward entry + advance*30 during the tally.
    this.tallyClockEntry = this.runState.clockTime * 30 + 660;
    this.tallyClockShown = this.tallyClockEntry;
    this.tallyClockTarget =
      Math.min(Math.max(this.runState.clockTime + this.th08ClockAdvance(), 0), 12) * 30 + 660;
    this.tallyClockBeat = 0;
    this.startStageClearPresentation();
  }

  private finishStageResults(): void {
    // Every authored post-boss flow reaches the timeline-completion latch.
    if (!this.stageResultsActive) this.activateStageResults();
    if (this.stageClear) return;
    this.stageClear = true;
    // TH08: the night clock advance was already computed for the tally
    // display; the run-state commit lands here with the transition latch.
    this.runState.addClockTime(this.th08ClockAdvance());
    // The night-clock advance lands in the tally's plate: the current plate
    // (script 1, holding at label 1) releases, and the advanced plate
    // (script 2) spawns with the NEW slot.
    this.clearTimeRunner?.interrupt(1);
    const times = this.assets.anms.times;
    if (times?.hasScriptInEntry(0, 2)) {
      const entry = times.entries[0];
      const slot = Math.min(Math.max(this.runState.clockTime, 0), 12);
      this.clearTimeAdvancedRunner = new AnmRunner(times, 2, {
        entryIndex: 0,
        spriteIndexOffset: entry.spriteBase + slot
      });
    }
    this.clearTimer = 1;
  }

  isDialogueActive(): boolean {
    if (this.th08Dialogue && !this.th08Dialogue.machine.state.done) return true;
    return false;
  }

  isBombActive(): boolean {
    return this.bombActiveThisFrame;
  }

  consumeDialogueResume(): boolean {
    if (this.dialogueResume) {
      this.dialogueResume = false;
      return true;
    }
    return false;
  }

  startBossSpell(spellId: number, bonus: number, decayPerSecond: number, name: string): void {
    this.spellName = name;
    this.phaseTimedOut = false;
    this.spellcard = {
      name,
      id: spellId,
      capturing: true,
      bonus,
      bonusLimit: bonus,
      bonusAnchor: bonus,
      bonusAnchorElapsed: 0,
      decayPerSec: decayPerSecond,
      elapsed: 0,
      elapsedFrac: 0,
      declAge: 0
    };
    // Native spell start (FUN_004152a0, all.c:9093-9095): the effect manager
    // arms TWO full-playfield VMs from the stage's eff0N.anm — archive
    // script indices 0 and 1. eff01.anm: entry 0 (eff01b.png, +0.008333
    // v-scroll/frame) and entry 1 (eff01.png, -0.002083 v-scroll/frame),
    // both 384x448 corner-anchored at (32,16) fading in over 60 frames.
    // No interrupt labels exist in these scripts (bullet-time interrupts
    // no-op on them); at spell end the manager deletes them outright
    // (endBossSpell clears the list — the scripts carry no fade-out).
    this.spellBackgroundRunners = [0, 1]
      .map((index) => {
        const ref = archiveScript(this.effectAnm, index);
        return new AnmRunner(this.effectAnm, ref.localId, {
          entryIndex: ref.entryIndex,
          spriteIndexOffset: this.effectAnm.entries[ref.entryIndex].spriteBase,
          rng: this.rng
        });
      });
    this.spellBanner = 150;
    // The declaration ring: effect 39 (etama archive script 76) — a big
    // additive-blend rune circle that fades in over 70 frames and spins for
    // the spell's duration. FUN_004152a0 arms it at the boss's position
    // (all.c:9110-9126); released at spell end. Zero RNG cost (the script
    // carries no ins_59/60 ops — EFFECT_DRAW_COST[39] = 0).
    this.spellRing = null;
    const boss = this.bossActive;
    if (boss) this.spellRing = { x: boss.x, y: boss.y };
    // The declaration portrait runs the stage face file's entry-0 script
    // verbatim (face_st01/face_st02 entry 0: the 254x510 portrait slides
    // (160,-112)->(160,144) over 180 frames at alpha 192, holds 90, fades
    // out 60, ends at 150 — face_st01.anm dump). Replaces the hand-rolled
    // sweep (the §7 approximation).
    const faceEntry = this.faceAnm.entries[0];
    const declScript = faceEntry?.scriptIds[0];
    this.spellDeclPortraitRunner = declScript == null ? null
      : new AnmRunner(this.faceAnm, declScript, { entryIndex: 0, spriteIndexOffset: faceEntry.spriteBase });
    // The native history row excludes the attempt currently in progress
    // (first-attempt native demo reads 0/0 through the whole card).
    if (!this.spellHistory.has(spellId)) this.spellHistory.set(spellId, { seen: 0, got: 0 });
    this.playSfx(14);
    // Th07.exe (v1.00b) FUN_0040ee30 @ 0x40ee30 allocates one template-0x19
    // spell-presentation entity here. It does not request the generic id-3
    // particle family (and therefore consumes no gameplay RNG at declaration).
    // The authored presentation is represented by `spellcard`/`spellBanner`.
  }

  endBossSpell(): boolean {
    // Th07.exe FUN_0040f340 @ 0x40f340 gates the entire phase-end path on
    // DAT_012f40a8 != 0. Boss death callbacks reuse op91 after nonspells too;
    // in that case the native function is a no-op and must not sweep helper
    // enemies a second time. Stage 4 PRE16236 is the fixed-slot witness: the
    // false sweep duplicated two Sub77 trails into 14 extra cherry items.
    const hadActiveSpell = this.spellcard !== null;
    const tally = this.spellcard ? this.spellHistory.get(this.spellcard.id) : undefined;
    if (tally) tally.seen++;
    if (this.spellcard?.capturing) {
      // Th07.exe FUN_0040f340 @ 0x40f340: award = decayed base + graze
      // additions; the banner shows the full value while the score field
      // gains value/10 (same 10:1 display convention as point items —
      // score += uVar6/10 at all.c:6644).
      const bonus = this.spellcard.bonus;
      this.addScore(bonus);
      this.runState.spellcardsCaptured++;
      // TH08 spell end FUN_004161b0 capture arm (all.c:9546-9548): after the
      // bonus/history bookkeeping the protected captured-cards counter
      // (run+0x1c) increments and re-arms its checksum — 4 raw u16 draws on
      // every capture, replay playback included (the draw sits OUTSIDE the
      // FUN_00406c90 history gate). Failed cards skip the whole arm.
      this.payTh08ProtectedChecksum();
      if (tally) tally.got++;
      // Duration 280 frames (0x117+1 @ all.c:18302-18304). Failure path
      // arms nothing — no banner, no score credit (all.c:6639-6692).
      this.bonusPopup = { bonus, timer: 280 };
      this.playSfx(33);
    }
    this.spellName = '';
    this.spellcard = null;
    this.spellBackgroundRunners = [];
    this.spellDeclPortraitRunner = null;
    this.spellRing = null;
    // Exe FUN_0040f340: the scored phase-end field sweep only runs when the
    // spell did not time out (DAT_012f40a8 still 1). Getting HIT during the
    // spell voids the bonus but NOT the sweep.
    const sweep = hadActiveSpell && !this.phaseTimedOut;
    this.phaseTimedOut = false;
    return sweep;
  }

  voidSpellCapture(): void {
    if (this.spellcard) this.spellcard.capturing = false;
  }

  onBossPhaseTimeout(): void {
    // Exe timeout path (all.c:13831): FUN_00422ea0(10) — every bullet fades
    // out with NO item conversion, lasers clear unconditionally (bombType
    // 10 ignores the immunity bit) — and the spell is marked failed
    // (DAT_012f40a8 -> 2) so the op91 that follows skips the scored sweep.
    this.phaseTimedOut = true;
    this.clearEnemyBullets();
    this.cancelLasers(true);
  }

  setBossPresent(present: boolean, enemy: Enemy | null): void {
    this.bossActive = present ? enemy : null;
  }

  setBossLifeCount(count: number): void {
    this.bossLifeCount = count;
  }

  spawnEnemyDeathEffect(e: Enemy, deathMode = e.ecl.deathMode & 7): void {
    // StageRuntime owns the executable's complete preburst -> item -> common
    // effect order. This optional hook remains as a test-observation seam.
    void e;
    void deathMode;
  }

  // TH08 FUN_00415c60 -> FUN_00430830(1): the shared declaration/dialogue/
  // ins_112/full-power field clear. Every live bullet becomes ONE homing
  // point-star (item type 6, state 1), then its fixed bullet slot is zeroed.
  // This is distinct from FUN_00423100's scored phase-end sweep below, which
  // converts through the live type-9 global and pays two time orbs per bullet.
  cancelBulletsToItems(): void {
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      this.spawnItem('pointStar', b.x, b.y, { state: 1 });
    }
    this.clearEnemyBullets(true);
    // The laser half uses that same mode-1 item mapping at its origin and
    // every 32 px along [nearDist, farDist).
    this.cancelLaserField(false, true, false, 'pointStar');
  }

  // Th07.exe FUN_00423100(8000,1) (op91 spell end, boss nonspell death):
  // same conversion, but each bullet also pops an escalating score value —
  // 2000, +20 per bullet, capped at 8000 — summed and returned for the
  // caller to bank as total/10 (all.c:6632-6645 / 14343-14349).
  sweepBulletsToItems(): number {
    let total = 0;
    let value = 2000;
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      this.spawnItem(this.cancelItemType, b.x, b.y, { state: 1 });
      // TH08 pays a second time orb per cancelled bullet (all.c:23531-23533).
      this.spawnItem(this.cancelItemType, b.x, b.y, { state: 1 });
      // FUN_00423100 @ all.c:15624: escalating popup per bullet — white
      // while ramping, yellow once the 8000 cap is reached.
      this.spawnScorePopup(value, b.x, b.y, value < 8000 ? 0xffffffff : 0xffffff00);
      total += value;
      value = Math.min(8000, value + 20);
    }
    this.clearEnemyBullets();
    // FUN_00423100 does not apply the bomb-immunity flag to lasers. Their
    // converted items do not contribute to the escalating score total.
    this.cancelLaserField(true, true, true);
    return total;
  }

  // TH08 death-settle shared tail (all.c:21659-21668): a dying enemy that
  // carries flags2 bit1 with bit0 clear converts every still-live enemy
  // bullet into a point item carrying an escalating chip — start 2000, +20
  // per bullet, capped at 8000 (FUN_00430aa0) — then chips the remaining
  // live enemies at +30 per head (FUN_0042efb0), banks the grand total
  // through one addScore, and pops the RAW value as the BONUS floater
  // (FUN_00437ddd displays the pre-division number; addScore credits /10).
  // Zero RNG on this path: FUN_004400a0 is the item allocator and
  // FUN_00403200 a plain field store, so seed oracles are untouched.
  th08DeathWipeBonus(dead: Enemy): void {
    const t = dead.ecl.th08;
    // The tail gate (all.c:21659) reads the +0x3324 word: bit1 is the
    // boss-slot REGISTRATION flag written by ins_127 (all.c:12700), not
    // the ins_83(1) effect bit at +0x3328. Gating on the ins_83 bit fired
    // the full-field wipe for ordinary enemies that author it (the Stage-1
    // Sub1 familiar master converted all 80 live bullets at f585 where the
    // native quad sweep converted only the seven inside its r32 quads —
    // a 56-draw single-frame deficit, gx-st1 census 2026-08-28).
    if (!t || (t.flags & 2) === 0 || (t.flags & 1) !== 0) return;
    let total = 0;
    let chip = 2000;
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      this.spawnItem('pointStar', b.x, b.y, { state: 1 });
      total += chip;
      chip = Math.min(8000, chip + 20);
    }
    this.clearEnemyBullets(true);
    chip = 2000;
    for (const other of this.enemies) {
      if (other === dead || other.dead) continue;
      const ot = other.ecl.th08;
      // FUN_0042efb0's sweep gate (all.c:22367, same as
      // killNonBossEnemies): registered/intangible (+0x3324 bit1) and
      // exempt (+0x3328 bit6, e.g. the Sub14 controller) enemies survive.
      if (!ot || (ot.flags & 2) !== 0 || (ot.flags2 & 0x40) !== 0) continue;
      this.spawnItem('pointStar', other.x, other.y, { state: 1 });
      total += chip;
      chip = Math.min(8000, chip + 30);
    }
    if (total <= 0) return;
    this.addScore(total);
    this.bonusPopup = { bonus: total, timer: 280 };
  }

  // Laser half of every FUN_00422ea0 field clear: non-bomb-immune lasers
  // (flags bit 2 clear) get the op-89-style graceful shrink and stop
  // hit-testing immediately (shrinkCutoff=0); `unconditional` mirrors
  // bombType 10 (spell timeout) which ignores the immunity bit. Every
  // clear also arms the exe's 10-frame new-laser suppression counter
  // (gamestate+0x37a12c).
  cancelLasers(unconditional: boolean): void {
    this.cancelLaserField(unconditional, false);
  }

  private cancelLaserField(
    unconditional: boolean,
    spawnItems: boolean,
    includeOrigin = false,
    itemType: ItemType = this.cancelItemType
  ): void {
    for (const l of this.enemyLasers) {
      if (!l.inUse) continue;
      if ((l.flags & 4) !== 0 && !unconditional) continue;
      if (l.state < 2) {
        l.state = 2;
        l.phaseFrame = 0;
        l.width = l.displayWidth;
        if (spawnItems) {
          // FUN_00423100 emits an explicit origin item before sampling the
          // beam, but FUN_00422ea0 does not. When nearDist is zero the former
          // intentionally duplicates the origin; sharing that behavior made
          // every spell declaration add one spurious item per live laser.
          if (includeOrigin) this.spawnItem(itemType, l.x, l.y, { state: 1 });
          const cos = Math.cos(l.angle);
          const sin = Math.sin(l.angle);
          // Th07.exe (v1.00b) FUN_00422ea0 @ 0x422ea0 and
          // FUN_00423100 @ 0x423100; DAT_0048ead4 = 32.0f.
          for (let d = l.nearDist; d < l.farDist; d += 32) {
            this.spawnItem(itemType, l.x + cos * d, l.y + sin * d, { state: 1 });
          }
        }
      }
      l.shrinkCutoff = 0;
    }
    this.postBombLaserCounter = 10;
  }


  // Test/debug-only: replace the live field with a deterministic three-shot
  // border-break fixture, reusing a real parsed bullet frame. The production
  // game never calls this; it gives the text-mode probe one direct hit, one
  // wave-cancellable bullet at 160px, and one 0x1000-immune bullet beside it.
  debugPrimeBorderCollision(): boolean {
    const source = this.enemyBullets.find((b) => !b.dead);
    if (!source) return false;
    const p = this.playerObj;
    const make = (x: number, flags: number): EnemyBullet => ({
      ...source,
      id: this.id++,
      x,
      y: p.y,
      vx: 0,
      vy: 0,
      speed: 0,
      angle: 0,
      age: 16,
      flags,
      grazed: false,
      spawnDuration: 0,
      spawnMoveScale: 1,
      exFlags: 0,
      exSlots: [null, null, null, null, null],
      exFireFlags: flags,
      exBehaviorIndex: 0,
      exRampElapsed: 0,
      exRampFrac: 0,
      exAccel: null,
      exAccelElapsed: 0,
      exAccelFrac: 0,
      exAngle: null,
      exAngleElapsed: 0,
      exAngleFrac: 0,
      exDir: null,
      exDirElapsed: 0,
      exDirFrac: 0,
      exBounce: null,
      dirTimes: 0,
      exBounceTimes: 0,
      dead: false
    });
    this.clearEnemyBullets();
    const bullets = [make(p.x, 0), make(p.x + 160, 0), make(p.x + 160, 0x1000)];
    bullets.forEach((bullet, poolSlot) => {
      bullet.poolSlot = poolSlot;
      this.addEnemyBullet(bullet);
    });
    return true;
  }

  playBgmTrack(name: string): void {
    this.audio.playBgm(name);
  }

  unpauseStd(label: number): void {
    this.runtime.std.requestResume(label);
  }

  // -- update ----------------------------------------------------------------

  update(input: InputFrame): void {
    this.playerPosAtFrameStart = { x: this.playerObj.x, y: this.playerObj.y };
    this.frame++;
    this.syncFixedPools();
    // The continue screen freezes gameplay entirely, like the original.
    if (this.continueScreen) {
      this.updateContinueScreen(input);
      return;
    }
    // Vanilla ESC pause: a full freeze with its own menu, drawn over the
    // dimmed frame. Presentation comes verbatim from the authored
    // pause.png scripts in ascii.anm entry 2 (title + three rows + the
    // 本当に？ confirm set, each with show/hide interrupts 1/2).
    if (this.pauseState) {
      this.updatePause(input);
      return;
    }
    if (input.pressed.has('pause') && !this.gameOver && !this.stageClear) {
      this.openPause();
      return;
    }
    // ScreenInf calc jobs are registered at priority 3, BELOW the replay
    // input feed at priority 6. A native replay counter boundary therefore
    // observes the high-priority managers first; these screen jobs run after
    // that boundary and before the following frame's player/enemy callbacks.
    // StageScene.update represents one feed-to-feed interval, so execute the
    // carried low-priority jobs at its head. Keeping them at the tail gave
    // the same cumulative draw count but assigned the shake's u32 values to
    // time-item scatter first (Stage-2 native f781 -> premature f828 collect).
    this.tickScreenFx();
    // Declined / exhausted continues: linger on GAME OVER, then leave.
    // Practice has no continues and leaves the same way.
    if (this.gameOver && this.mode !== 'test') {
      if (++this.gameOverTimer > 240) this.exitToTitle();
    }
    if (this.stageResultsActive) {
      this.stageClearTimer++;
      this.clearLoadingRunner?.update(this.slowRate);
      this.clearCaptureRunner?.update(this.slowRate);
      this.clearTimeRunner?.update(this.slowRate);
      this.clearTimeAdvancedRunner?.update(this.slowRate);
      // Tally night-clock count-up (all.c:25485-25503): a 60-frame beat,
      // then the shown advanced time ticks +1 minute/frame toward the
      // target, +4 with Z or Ctrl held, clamped at the target.
      if (this.tallyClockShown < this.tallyClockTarget) {
        if (this.tallyClockBeat < 60) {
          this.tallyClockBeat++;
        } else {
          this.tallyClockShown++;
          if (input.held.has('shoot') || input.held.has('skip')) this.tallyClockShown += 3;
          if (this.tallyClockShown > this.tallyClockTarget) this.tallyClockShown = this.tallyClockTarget;
        }
      }
    }
    if (this.stageClear) {
      // Advance on Z once the tally has been visible for a beat, or after
      // the timeout. Stages 1-5 hand the run to the next stage; stage 6 /
      // Extra / Phantasm end the credit back at the title.
      const advance =
        (this.stageClearTimer > 90 && input.pressed.has('shoot')) || this.stageClearTimer > 900;
      if (this.mode !== 'test' && advance && !this.stageCompleteFired) {
        this.stageCompleteFired = true;
        if (((this.mode === 'arcade' && this.stageNumber < 6) || this.mode === 'replay') && this.onStageComplete) {
          this.onStageComplete(this.carryState());
        } else {
          // Stage 6 / Extra / Phantasm end the credit; practice always
          // returns to the title after its single stage (exe FUN_00428392
          // case 0xb, all.c:17980-17982).
          this.exitToTitle();
        }
      }
    }
    const p = this.playerObj;
    this.sfxPlayedThisFrame.clear();
    this.settledDamageThisFrame = 0;
    // TH08 dialogue (Gui::RunMsg) does not latch the global gameplay freeze:
    // player, enemies, items and background keep running; the timeline's
    // op-7 hold parks the script clock instead. FUN_00429483 is the narrower
    // MSG-active predicate used by input-triggered actions such as bomb
    // activation and the shot-cycle re-arm.
    const messageActive = this.isDialogueActive();
    const bombCleanupThisTick = this.bombCleanupPending;
    this.bombCleanupPending = false;
    this.bombCleanupDefersBorder = bombCleanupThisTick;
    this.bombActiveThisFrame = p.bombTimer > 0;
    // Th07.exe (v1.00b) FUN_0043eef0 @ 0x43eefb-0x43ef05 starts with
    // FUN_0043d8f0 (clear the shared 112 attack slots), then FUN_0043d9a0
    // (bomb trigger + active bomb VM), before FUN_0043be00 moves the player
    // and before FUN_0043a290 republishes player-shot helper slots.
    const bombActiveAtFrameStart = p.bombTimer > 0;
    this.bombEngine.beginFrame();
    // The exe reads the bomb button as a raw HELD bit (DAT_004afe30 bit 2 @
    // 0x43d9c3/0x43db3b — gameplay buttons have no edge detection at all),
    // so a bomb held across a dialogue unblock or across the cooldown fires
    // on the first frame the gates open. Bombing during the deathbomb
    // window (p.hitState) still rescues; the squish/materialize are closed
    // by the meter gate inside tryBomb().
    // +0x23fc is decremented first and held X may trigger as soon as it
    // reaches zero.
    if (p.bombCooldown > 0) p.bombCooldown--;
    let bombTriggeredThisFrame = false;
    if (!bombCleanupThisTick && !messageActive && input.held.has('bomb') &&
        (p.controllable || p.hitState) && !this.gameOver && p.tryBomb()) {
      this.voidSpellCapture();
      // Th07.exe bomb trigger @ all.c:28503-28506: zeroes the pending
      // spell bonus and latches DAT_012f40bc = spell-active state.
      this.bombDuringSpell = this.spellcard !== null;
      this.onBombUsed();
      bombTriggeredThisFrame = true;
    }
    // Existing bombs publish their current records before the Web's manager
    // passes.  A newly-triggered bomb is started at the manager tail below,
    // matching the native player(9) / item+bullet(14) scheduler boundary.
    if (p.bombTimer > 0 && !bombTriggeredThisFrame) this.prepareBombEffects();
    // FUN_0043a820's compound gate is bomb-active && Marisa family && B shot
    // (DAT_004ca4d8 / DAT_00625625 / DAT_00625626), not a global bomb gate.
    // Snapshot the frame-entry bomb state because Player.update() consumes
    // the remaining timer later in this callback: MarisaB's timer=1 tick is
    // still blocked, while Reimu/MarisaA/Sakuya continue firing throughout.
    const allowShotSpawnThisTick = true;
    // FUN_0043e2e0 precedes movement, shot MOVE/FIRE, and the priority-10
    // enemy manager. Snapshot the state before Player.update consumes the
    // last invulnerability tick, matching the native state dispatcher.
    this.tickPlayerShotCollisionClock(p.invulnFrames > 0);
    p.update(input, this.slowRate, !messageActive);
    // Player+0xe2abc and DAT_018b89b4 are the same absolute pointer. Ran's
    // callback can clear it before the priority-10 enemy scan republishes a
    // candidate, so reflect that mutation back into the persistent cache.
    if (p.th08LungeTarget == null) this.th08LungeEnemy = null;
    if (bombActiveAtFrameStart && p.bombTimer === 0) {
      this.bombCleanupPending = true;
    }
    this.focusHeld = p.focusHeld;
    // TH08 form-transition presentation (FUN_0044aec0's toggle branch):
    // the to-human/to-youkai tint (effects 28/29 = etama archive 57/58)
    // after >= 5 held frames, and the focus aura (effect 22 = archive 54,
    // handle player+0xbe834) armed on every focus-in and released by
    // interrupt 1 on the way out.
    const fx = p.pendingTh08FormEffect;
    p.pendingTh08FormEffect = 0;
    if (fx === 28) {
      this.spawnEffectParticles(28, p.x, p.y, 1, 0x808080ff);
    } else if (fx === 29) {
      this.spawnEffectParticles(29, p.x, p.y, 1, 0x80ff8080);
    }
    const aura = p.pendingTh08Aura;
    p.pendingTh08Aura = null;
    if (aura === 'in') {
      this.th08AuraHandle?.release();
      // FUN_00425870 arms the aura into the effect manager's dedicated
      // (non-rotating) slot 0x282: FUN_004069f0 runs the script's t0 pass —
      // etama archive 54 (on-disk -96) holds ONE random op (ins_60 = 2 u16
      // draws, the arm-time scale roll). Consume the same 2 draws here.
      this.rng.f();
      const actor = { x: p.x, y: p.y, angle: 0, state: 1 };
      this.th08AuraActor = actor;
      this.th08AuraHandle = this.th08Effects.spawnHandle({
        scriptId: archiveScript(this.assets.anms.etama, 54).localId,
        x: p.x, y: p.y, follow: actor
      });
    } else if (aura === 'out') {
      this.th08AuraHandle?.interrupt(1);
      this.th08AuraHandle = null;
      this.th08AuraActor = null;
    }
    if (this.th08AuraActor) {
      this.th08AuraActor.x = p.x;
      this.th08AuraActor.y = p.y;
    }
    // FUN_0044aec0 updates the human/youkai gauge before the player-shot
    // callback FUN_00451500 advances/expires the 20-frame fire cycle and
    // before the priority-10 enemy manager applies kill gauge deltas.
    this.tickTh08Gauge();
    // The popup/ascii manager is priority 1, ahead of every gameplay
    // manager. Existing popups age now; item pickups later this frame create
    // fresh entries that do not tick until the next scheduler pass.
    this.updatePopups();
    if (p.hitState && !bombTriggeredThisFrame) {
      // FUN_0044cbf0 calls GameManager::AddTimeOrbs(-15) on every live
      // deathbomb-window tick, before decrementing preDeadCount. When at
      // least 15 current-stage orbs remain, FUN_00418220 subtracts from the
      // current/total/stage counters and regenerates the two-field integrity
      // checksum (two u32 draws = four raw u16). If 15 would underflow, only
      // the current counter is zeroed and there are NO draws. Stage-2's
      // replay enters with 38: its first two window ticks are therefore
      // 38 -> 23 -> 8 (+4 draws each), then 8 -> 0 (zero draws).
      const fullDebit = this.runState.currentTimeOrbs >= 15;
      this.runState.addTimeOrbs(-15);
      if (fullDebit) {
        this.rng.u32InRange(100000);
        this.rng.u32InRange(100000);
      }
    }
    const death = bombTriggeredThisFrame ? 'none' : p.tickDeath(this.slowRate);
    if (death === 'effects') this.onPlayerDeath();
    else if (death === 'respawn') this.onPlayerRespawn();
    // TH08 death white-out (FUN_0044d180 arms player+0xe2a70 = 60 on the miss
    // commit and RE-ARMS it every squish frame; FUN_0044d2c0 decrements and
    // draws FUN_0044de60(player, 768, 896, 0xffffffff) while nonzero): the
    // white playfield quad runs through the death squish and 60 frames past
    // it. There is NO white flash during the deathbomb window itself.
    if (p.dyingFrame >= 0) this.th08DeathWhiteFrames = 60;
    else if (this.th08DeathWhiteFrames > 0) this.th08DeathWhiteFrames--;
    if (this.respawnClearFrames > 0) {
      // Exe FUN_0043e2e0 top (all.c:28692-28695): while player+0x2400
      // counts down, FUN_00422ea0(0) runs every frame — silent, itemless,
      // skips bomb-immune lasers.
      this.respawnClearFrames--;
      this.clearEnemyBullets();
      this.cancelLasers(false);
    }
    this.stageFrame++;
    // The night-time plate (times.anm) joins the intro runners on the first
    // tick, once the stage-entry run state (clockTime, T8RP +0x22) has been
    // restored: the native intro shows the current 时刻 below the title
    // (userdemo-t22: 子の刻 pm11:00 for stage 1). times.anm script 0 is the
    // intro template (256,268, fades at t=240); its t0 setSprite(0)
    // composes with the sprite index offset, so the slot selects the plate
    // (0=子の刻, 1=子の二つ, …, 12=夜明け).
    if (this.stageFrame === 1 && !this.th08IntroTimeArmed) {
      this.th08IntroTimeArmed = true;
      const timesAnm = this.assets.anms.times;
      if (timesAnm?.hasScriptInEntry(0, 0)) {
        const timesEntry = timesAnm.entries[0];
        const slot = Math.min(Math.max(this.runState?.clockTime ?? 0, 0), 12);
        this.stageIntroRunners.push(
          new AnmRunner(timesAnm, 0, {
            entryIndex: 0,
            spriteIndexOffset: timesEntry.spriteBase + slot
          })
        );
      }
    }
    for (const runner of this.stageIntroRunners) {
      if (!runner.removed) runner.update(this.slowRate);
    }
    // Native Gui ticks the front.anm sidebar label VMs every sim frame
    // (FUN_0043625d's callers). Headless update() never reaches draw(), so
    // these must advance here — otherwise the fade-in scripts stay parked
    // at t0 and bomb/replay screenshots stack Player/Spell over missing
    // Graze/Point/Time.
    this.tickTh08HudRunners();
    if (this.dialogueBgmRunner && !this.dialogueBgmRunner.runner.removed) {
      this.dialogueBgmRunner.runner.update(this.slowRate);
    }
    if (this.stageTransitionTiles.some((tile) => !tile.runner.removed)) {
      this.stageTransitionTimer++;
      for (const tile of this.stageTransitionTiles) tile.runner.update(this.slowRate);
    }
    if (this.spellBanner > 0) this.spellBanner--;
    if (this.spellcard) {
      this.spellcard.declAge++;
      for (const runner of this.spellBackgroundRunners) runner.update(this.slowRate);
      if (this.spellDeclPortraitRunner && !this.spellDeclPortraitRunner.removed) {
        this.spellDeclPortraitRunner.update(this.slowRate);
      }
    }
    if (this.bonusPopup && --this.bonusPopup.timer <= 0) this.bonusPopup = null;
    // Native scheduler order (FUN_0042e420 + priority registrations):
    // player(8) -> enemies(10) -> effects(11) -> item+bullets/lasers(12).
    // Inside the player callback, existing shots move before the firing
    // pass allocates new shots (FUN_0043eef0 @ all.c:29061-29063).
    // FUN_0043eef0 keeps calling MOVE/ANM -> FIRE -> aim-cache reset while
    // a timestamp-only MSG is active. Player update above prevents a
    // disarmed cycle from re-arming; fire() still drains any cycle that was
    // already armed when the message began.
    this.updatePlayerBullets();
    this.firePlayerBullets(allowShotSpawnThisTick);
    // TH08 option afterimages (exe FUN_00407400 @ all.c:2997-3004): while the
    // player-manager tick counter satisfies counter%3==0 && counter>699, the
    // player tick spawns 12 effect-62 VMs, one per option-trail point
    // (player-manager +0x6480), with color 0x20ffffff. Scheduler position
    // matters: the player callback (priority 8) runs BEFORE the enemy manager
    // (priority 10, whose ins_139 emissions request effect-51) and the effect
    // manager (priority 11, which frees dead slots), so the afterimages get
    // first pick of each frame's freed slots — that ordering is what
    // throttles effect-51 to the native ~0.76/frame (measured via
    // /proc/pid/mem: native n62 steadies 276-288, n51 ~180).
    // The trail is written only while the option-formation radius gate
    // (+0xaec) is active — never in replay/demo play, where every afterimage
    // piles at (0,0,0) — so the port spawns at the origin and leaves the
    // trail-write semantics unmodeled (visual-only; the script draws 0 RNG
    // either way). The +0xb24<2 gate pauses spawning from 60 frames into an
    // ENEMY spell declaration (FUN_00415ce0/00416ad0; player bombs never arm
    // +0xb24) until the banner releases (~frame 100).
      {
        const clock = this.th08AfterimageClock++;
        if (clock % 3 === 0 && clock > 699) {
          const declAge = this.spellcard?.declAge ?? -1;
          const declSuppress = declAge >= 60 && declAge < 100;
          if (!declSuppress) {
            this.spawnEffectParticles(62, 0, 0, 12, 0x20ffffff);
          }
        }
      }
    // FUN_0041ed50 (priority 10) and the generic effect manager (priority
    // 11) do NOT honor the TH07 dialogue freeze: invisible ECL controllers,
    // enemies, movement/collision and ambient effects continue. The only
    // enemy-tail exception is the boss timer, gated in tickEnemyManagerTail.
      this.updateEnemies();
      this.updateParticles();
    // FUN_004241c0 calls the item manager at the head of the priority-12
    // bullet callback (all.c:16039-16042). Items therefore update after
    // effects, before bullets/lasers, and freeze with dialogue gameplay.
    // Cancellation items created later in this callback wait until the
    // next frame for their first update.
      // FUN_0040be30 calls FUN_004413e0 at the trigger tail.  The current
      // item pass has already happened natively; the live items therefore
      // retain their exact positions for this replay boundary and begin
      // homing on the next pass.  Running updateItems here collected one
      // extra time orb (four RNG draws) and shifted every later fixed slot.
      if (!bombTriggeredThisFrame) this.updateItems();
      this.updateBullets();
      this.updateLasers();
      if (this.postBombLaserCounter > 0) this.postBombLaserCounter--;
      if (bombTriggeredThisFrame) this.startPendingBombAfterManagers();
    // The MSG manager is registered at priority 13 (FUN_00426656 via
    // FUN_0042e290(..., 0xd), all.c:18954), after enemies/effects and the
    // item+bullet+laser priority-12 callback. A timeline op6 created inside
    // this frame's enemy manager therefore gets its first interpreter tick
    // at this tail, not at the start of the next frame.
    if (this.th08Dialogue) {
      this.updateTh08Dialogue(input);
    }
    // Bomb over: release the interrupt-gated bomb visuals (label 1 is the
    // fade-out path in the player bomb scripts) and tear down the form runner.
    if (this.prevBombTimer > 0 && p.bombTimer === 0) {
      this.finishBombPresentation();
    }
    this.prevBombTimer = p.bombTimer;
    this.playerEffects.update(this.slowRate);
    this.th08Effects.update(this.slowRate);
    this.tickRetiredBombVisuals();
    if (this.th08Declaration) {
      this.th08Declaration.update(this.slowRate);
      if (this.th08Declaration.done) this.th08Declaration = null;
    }
    // The stage object arms its results screen on the same scheduler tick
    // that the last authored timeline wait is consumed. Native Stage 1 has
    // PRE10475 and then leaves gameplay; there is no PRE10476 player tick.
    // The former synthetic 180-frame grace let the ambient Sub1 manager run
    // one extra snow tick in the recorded stream and delayed the clear bonus
    // beyond the replay boundary.
    if (!this.stageClear && this.runtime.isTimelineComplete() && !this.bossActive && this.enemies.length <= 1) {
      if (!this.stageResultsActive) this.activateStageResults();
      this.finishStageResults();
      this.audio.fadeOutBgm(4);
    }
    if (this.score > this.hiScore) this.hiScore = this.score;
  }

  private finishBombPresentation(): void {
    this.playerEffects.interruptAll(1);
    this.bombEngine.reset();
    this.activeBombSlots.length = 0;
    this.th08BombPendingStart = false;
    this.runState.gaugeLocked = false;
    this.playerObj.th08BombFocusOverride = null;
  }

  private onBombUsed(): void {
    const p = this.playerObj;
    this.bombActiveThisFrame = true;
    this.runState.gaugeLocked = true;
    // Bomb stock mutation (FUN_00439883) and the per-run bomb counter
    // mutation (FUN_0044e2e0) each finish with FUN_00406e50: two ranged
    // u32 integrity values apiece, eight raw-u16 draws total. Native Stage-2
    // f697 consists of exactly these draws at the trigger boundary.
    for (let i = 0; i < 4; i++) this.rng.u32InRange(100000);
    // TH08 Border Team: the bomb machine (0x44c650) dispatches ONE per-frame
    // callback for the whole bomb from the table at player+0x1000 (rdata
    // 0x4c7ad0 team block 0): 0x40c010 unfocused / 0x410c40 focused /
    // 0x40c910+0x410fe0 the side-inverted deathbombs. Durations come from
    // the shared cast helper 0x40be30 (260/200/260/300).
    this.th08Bomb = null;
    this.resetTh08BeamVisualState();
    this.th08BombPendingStart = true;
    this.th08BombOrbActors = [];
    // FUN_0044c650 completes a deathbomb rescue and selects the inverted form
    // immediately, so the remainder of this player pass already fires the
    // Type-3 SHT table. Store duration+1 because Player.update's common tail
    // consumes one before the replay boundary (native Stage-2 f697 exposes
    // the authored 250 count).
    const pendingBomb = new Th08BorderBomb(p.th08BombType, p.x, p.y);
    p.completePendingDeathbombRescue();
    p.th08BombFocusOverride = (p.th08BombType & 1) !== 0;
    p.bombTimer = pendingBomb.duration + 1;
    p.bombInvuln = TH08_BOMB_INVULN[p.th08BombType];
    // FUN_0040be30 → FUN_00415d60: every bomb declares its spell card
    // (portrait + banner VMs + the rdata name, sfx id 14 se_cat00);
    // the bomb callback then queues sfx id 13 (se_gun00) itself
    // (0x40c067-0x40c07f pushes 0x4b43a0's declaration first).
    this.startTh08Declaration(p.th08BombType);
    this.playSfx(13);
    // 0x44c773 FUN_0043c03f(200): every bomb cast lowers the rank by 200
    // subrank points.
    this.adjustRank(-200);
  }

  private allocateBombClearRegion(
    x: number,
    y: number,
    radius: number,
    growth: number,
    framesLeft: number
  ): boolean {
    // Th07.exe FUN_0043e7e0 scans player+0x17dc from slot zero and writes
    // the first free entry. Full pools reject the request without allocating.
    for (const region of this.bombClearRegions) {
      if (region.framesLeft > 0) continue;
      region.x = Math.fround(x);
      region.y = Math.fround(y);
      region.radius = Math.fround(radius);
      region.growth = Math.fround(growth);
      region.framesLeft = framesLeft;
      return true;
    }
    return false;
  }

  // Per-frame bomb choreography: the TH08 border-bomb simulation runs its
  // own tick and applies its bullet-clear events against the live
  // enemy-bullet list; damage settles immediately through the host's
  // addAttackSlot.
  private tickBombChoreography(): void {
    if (this.th08Bomb) {
      this.tickTh08Bomb();
    }
  }

  // The wave visuals outlive the active machine (authored 140-frame scripts
  // vs the 150-frame type-1 bomb): keep spinning the retired sim's groups
  // until they age out. Driven from the per-frame effect tail — the bomb
  // choreography itself only runs while p.bombTimer is live.
  private tickRetiredBombVisuals(): void {
    if (this.th08Bomb || !this.th08RetiredBombVisual) return;
    this.th08RetiredBombVisual.tickVisualsOnly();
    if (!this.th08RetiredBombVisual.hasLiveBeamGroups()) this.resetTh08BeamVisualState();
  }

  private tickTh08Bomb(): void {
    const sim = this.th08Bomb;
    if (!sim) return;
    const p = this.playerObj;
    sim.tick(this.th08BombHost(), p.x, p.y, p.shooting);
    // Keep the orb visual actors on their simulation state; the 1->2
    // transition fires the orb VM's label-1 interrupt (the authored 6x
    // balloon + 20-frame fade, FUN_00407120's VM+0x1fe write at 0x40c640).
    // The loop covers the bombardment slots 16/17 too (they have no sim
    // orb — they park at their spawn target until the ttl lapses).
    for (let i = 0; i < this.th08BombOrbActors.length; i++) {
      const orb = sim.orbAt(i);
      const actor = this.th08BombOrbActors[i];
      if (orb && actor) {
        if (actor.state === 1 && orb.state === 2) actor.handle?.interrupt(1);
        actor.x = orb.x;
        actor.y = orb.y;
        actor.angle = orb.angle;
        actor.state = orb.state;
      }
    }
    // The machine pays ±26000/gaugeDuration into the gauge every frame of
    // the bomb, bypassing the lock (0x44c81b-0x44c850); the denominator is
    // be30's param_4 (200/150/200/250), NOT the bomb duration.
    this.runState.addYoukaiGauge(sim.gaugeDeltaThisFrame(), true);
    if (!sim.active) {
      // The wave visuals outlive the active machine — hand the sim to the
      // visual-only ticker until its groups age out (orb bombs have none).
      if (sim.hasLiveBeamGroups()) this.th08RetiredBombVisual = sim;
      this.th08Bomb = null;
      this.th08BombOrbActors = [];
      // FUN_0044c650 dispatches the selected callback before the ordinary
      // focus/movement/shooter block. When that callback reaches its final
      // authored tick, FUN_00416130 tears the bomb down immediately: the
      // SAME player pass already reads the raw focus key and the opposite
      // SHT table. Leaving this facade timer at one kept the forced bomb
      // side for an extra pass. Stage-2 replay f947 then moved only 2px and
      // fired Yukari's needles from Ran instead of moving 4px and firing
      // Reimu's table from the player, starting the f949 kill/RNG cascade.
      p.bombTimer = 0;
      p.th08BombFocusOverride = null;
      this.bombActiveThisFrame = false;
      // FUN_00416130 (bomb end): interrupt 1 releases the name VM's
      // label-1 wait into its exit; the portrait/banners are self-timed.
      this.th08Declaration?.end();
    }
  }

  // Spawn an etama.anm VM by ARCHIVE script index (Th08.exe FUN_004069f0
  // indexes the archive's script table, so index 37 = entry 1's 13th script
  // regardless of its negative on-disk id). color/scale carry the
  // FUN_00425430 host params (VM color / burst magnitude).
  // The 四重結界 boundary frames: etama sprite 225 (entry 2) drawn as four
  // rotating additive quads per live beam group, geometry from
  // Th08BorderBomb#beamVisualFrames (FUN_004117b0's engine-driven VM state —
  // the authored scripts only carry sprite/color/fade, so a plain effect entry sat
  // frozen at identity rotation/scale). §7: FUN_00464b00's native instance
  // fan-out topology is unrecoverable; the four proven beam quads per group
  // are the approximation. FUN_004117b0 also runs one authored VM PER GROUP
  // — the cast VM (script 0x58, deathbomb 0x5c) plus three wave VMs
  // (0x59-0x5b / 0x5d-0x5f) — so each group renders through its own runner:
  // the script supplies sprite/authored fade/color, beamVisualFrames()
  // supplies position/rotation/size.
  private readonly th08BeamRunners = new Map<number, AnmRunner>();
  // A bomb whose active machine ended keeps spinning its groups for their
  // authored 140-frame life (tickBombChoreography advances it visual-only).
  private th08RetiredBombVisual: Th08BorderBomb | null = null;

  private resetTh08BeamVisualState(): void {
    this.th08RetiredBombVisual = null;
    this.th08BeamRunners.clear();
  }

  private drawTh08BeamVisuals(r: Renderer, ox: number, oy: number): void {
    const bomb = this.th08Bomb ?? this.th08RetiredBombVisual;
    if (!bomb) return;
    const beams = bomb.beamVisualFrames();
    if (beams.length === 0) {
      if (!this.th08Bomb) this.resetTh08BeamVisualState();
      return;
    }
    const scripts = bomb.type === 3 ? [0x5c, 0x5d, 0x5e, 0x5f] : [0x58, 0x59, 0x5a, 0x5b];
    for (const beam of beams) {
      let runner = this.th08BeamRunners.get(beam.group);
      if (!runner) {
        const built = archiveScriptRunner(this.assets.anms.etama, scripts[beam.group] ?? scripts[0]);
        if (!built) continue;
        runner = built;
        this.th08BeamRunners.set(beam.group, built);
      }
      // One update per drawn frame mirrors the native per-tick VM advance at
      // full rate; headless batch-skip frames simply don't age the visuals.
      runner.update(1);
      const frame = runner.spriteFrame();
      if (!frame) continue;
      r.drawAnmFrame(frame, ox + beam.x, oy + beam.y, {
        rotation: beam.angle,
        scaleX: beam.width / Math.max(1, frame.w),
        scaleY: beam.height / Math.max(1, frame.h),
        blend: 'lighter'
      });
    }
  }

  private spawnTh08Effect(
    archiveIndex: number, x: number, y: number, ttl = 240,
    opts: { color?: number; scale?: number; alpha?: number } = {}
  ): void {
    const etama = this.assets.anms.etama;
    const ref = archiveScript(etama, archiveIndex);
    if (!etama.hasScriptInEntry(ref.entryIndex, ref.localId)) return;
    this.th08Effects.spawn({
      scriptId: ref.localId,
      x,
      y,
      ttl,
      color: opts.color,
      scale: opts.scale,
      alpha: opts.alpha
    });
  }

  // FUN_00415d60 on the declaration manager (0x4ea670): selector picks the
  // side's face file (0x2624 human / 0x2628 youkai), banners come from
  // face_cdbg.anm (archive 0xf) with the deathbomb's red sprite variant,
  // and the name string is the rdata table at 0x4b43a0.
  private startTh08Declaration(type: 0 | 1 | 2 | 3): void {
    const anms = this.assets.anms;
    const face = (type & 1) === 0 ? anms.face_rm00 : anms.face_yk00;
    this.th08Declaration = new Th08SpellDeclaration(
      { face, cdbg: anms.face_cdbg, text: anms.text },
      (type & 1) as 0 | 1,
      th08BombSpellName(type),
      type >= 2
    );
    this.playSfx(14);
  }

  // The Th08BombHost adapter: attack slots settle damage/clears against the
  // live pools; effect/orb requests ride the PlayerEffects layer.
  private th08BombHost(): Th08BombHost {
    const scene = this;
    return {
      get targetPos() {
        return scene.th08TargetPos;
      },
      addAttackSlot(x, y, radius, damage, cadenceCounter = 0, cadenceDivisor = 1) {
        // Publish in the player pass; each enemy consumes the record later
        // from collideBombSlots after its movement/ECL tick. Applying damage
        // here skipped FUN_00451670's global fourth-contact effect-3 path
        // and paid gameplay RNG in the wrong scheduler phase.
        scene.bombEngine.allocateCircle(
          x,
          y,
          radius,
          damage,
          'bomb',
          cadenceCounter,
          cadenceDivisor
        );
        // The orb VM reads the slot's accumulated contact damage to decide
        // whether to burst. Predict that total for the VM only; actual HP
        // settlement remains deferred to the enemy pass above.
        let settled = 0;
        const r2 = radius * radius;
        for (const e of scene.enemies) {
          if (e.dead || !e.ecl.interactable) continue;
          const dx = e.x - x;
          const dy = e.y - y;
          if (dx * dx + dy * dy <= r2) {
            settled += damage;
          }
        }
        // The slot consumer compares settled damage (slot +0x30) against the
        // aura's threshold (+0x34) — return the settled total so the orb
        // state machine can burst on time.
        return settled;
      },
      addBoxAttackSlot(
        x, y, width, height, angle, damage,
        cadenceCounter = 0, cadenceDivisor = 1
      ) {
        scene.bombEngine.allocateBox(
          x, y, width, height, angle, damage, 'bomb',
          cadenceCounter, cadenceDivisor
        );
        // The boundary beams do not consume the return value, but mirror the
        // circular host contract for direct unit probes.
        let settled = 0;
        for (const e of scene.enemies) {
          if (e.dead || !e.ecl.interactable) continue;
          if (orientedBoxHitsPoint(
            e.x, e.y, x, y, width + e.ecl.hitbox.x,
            height + e.ecl.hitbox.y, angle
          )) settled += damage;
        }
        return settled;
      },
      clearBullets(x, y, radius) {
        // FUN_0044df00 only publishes the player-quad record here. The
        // enemy-bullet manager moves each normal bullet first and probes the
        // quad later in that bullet's own pass (all.c:23510-23548). Clearing
        // immediately from the player callback tested the previous-frame
        // position and cancelled several Stage-2 bullets 1-9 frames early.
        scene.allocateBombClearRegion(x, y, radius, 0, 1);
      },
      clearBulletsBox(x, y, width, height, angle) {
        scene.bombClearBoxes.push({
          x: Math.fround(x), y: Math.fround(y),
          width: Math.fround(width), height: Math.fround(height),
          angle: Math.fround(angle), framesLeft: 1
        });
      },
      randomFloat() {
        return scene.rng.f();
      },
      effectVm(script, x, y, scale, color) {
        // FUN_00425430's effect pool draws from etama.anm; `script` is the
        // archive script index (DAT_004c6d30's second word for effect ids).
        // scale/color are the host params (the burst magnitudes — e.g. the
        // orb-release flash at 8x — and the VM color word at +0x7c). Color
        // 0xffffffff is neutral; a literal 0 marks an unread transcription
        // (the bombardment effects) — both draw unmodulated.
        scene.spawnTh08Effect(script, x, y, 240, {
          scale: scale === 1 ? undefined : scale,
          color: color === 0xffffffff || color === 0 ? undefined : (color & 0xffffff)
        });
      },
      effectParticles(effectId, x, y, count, color) {
        scene.spawnEffectParticles(effectId, x, y, count, color);
      },
      startScreenShake(duration, from, to) {
        scene.startScreenShake(duration, from, to);
      },
      startScreenFlash(duration, repeats, argb) {
        scene.startScreenFlash(duration, repeats, argb);
      },
      orbVm(index, script, x, y) {
        // The bombardment slots (16/17) spawn AT THE TARGET; the orb ring
        // slots (0-15) follow the sim actors from the cast point.
        const actor = scene.th08BombOrbActors[index] ?? (scene.th08BombOrbActors[index] = {
          x: x ?? scene.playerObj.x, y: y ?? scene.playerObj.y, angle: 0, state: 1
        });
        if (x !== undefined) {
          actor.x = x;
          actor.y = y!;
        }
        actor.state = 1;
        actor.handle = scene.playerEffects.spawnHandle({
          scriptId: script, x: actor.x, y: actor.y, follow: actor, ttl: 300
        });
      },
      playSfx(id, arg) {
        // FUN_0045d660's second arg tunes the playback frequency (the orb x
        // position); the port's audio bus has no per-request pitch control.
        void arg;
        scene.playSfx(id);
      }
    };
  }

  private prepareBombEffects(): void {
    if (this.th08BombPendingStart) {
      this.th08BombPendingStart = false;
      const p = this.playerObj;
      p.completePendingDeathbombRescue();
      p.th08BombFocusOverride = (p.th08BombType & 1) !== 0;
      this.resetTh08BeamVisualState();
      this.th08Bomb = new Th08BorderBomb(p.th08BombType, p.x, p.y);
      this.th08Bomb.cast(this.th08BombHost(), p.x, p.y);
      // The callback writes param_4 on this second tick. Add one because the
      // player tail decrements the facade after choreography; the boundary
      // then reads the authored 200/150/200/250 count.
      p.bombTimer = this.th08Bomb.duration + 1;
    }
    // The bomb tick runs before this frame's enemy/bullet passes so the
    // choreography state is fixed for the rest of the frame.
    this.tickBombChoreography();
    // Cache the ordered object references instead of restarting the 112-slot
    // generator for every enemy and every bullet in a dense field.
    this.refreshActiveAttackSlots();
  }

  private startPendingBombAfterManagers(): void {
    if (!this.th08BombPendingStart) return;
    this.th08BombPendingStart = false;
    const p = this.playerObj;
    this.resetTh08BeamVisualState();
    this.th08Bomb = new Th08BorderBomb(p.th08BombType, p.x, p.y);
    this.th08Bomb.cast(this.th08BombHost(), p.x, p.y);
    this.homeAllItemsTh08();
    // The native rotating cursor is already one probe past Web's last live
    // slot at this boundary: Stage-2 f698 allocates the first cancel item in
    // slot 86 while the visible survivors end at 84. This is fixed-pool
    // cursor state only; unlike the old attribution, FUN_004413e0 itself
    // neither scans allocation slots nor consumes RNG.
    if (this.th08ItemPool) {
      this.th08ItemPool.nextIndex =
        (this.th08ItemPool.nextIndex + 1) % this.th08ItemPool.items.length;
    }

    // The cast-time r100 record is created after this frame's ordinary
    // bullet scan.  Native nevertheless exposes bullets already inside the
    // newly-published field as state 5 at the same replay boundary, without
    // paying the type-6 item; the next manager pass performs normal quad
    // conversion.  Stage-2 f697/f698 is the concrete witness: slot 15 is
    // silently retired at r100, then slot 16 pays the sole point-star at
    // its post-move x=268.579 under r101.
    if (p.th08BombType === 1 || p.th08BombType === 3) {
      const radius2 = 100 * 100;
      for (const b of this.enemyBullets) {
        if (b.dead || b.clearFadeFrames != null || (b.flags & 0x1000) !== 0) continue;
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        if (dx * dx + dy * dy < radius2) this.beginBulletClearFade(b);
      }
    }
    this.refreshActiveAttackSlots();
  }

  private refreshActiveAttackSlots(): void {
    this.activeBombSlots.length = 0;
    for (const slot of this.bombEngine.activeSlots()) this.activeBombSlots.push(slot);
  }

  private collideBombSlots(e: Enemy, hitbox = e.ecl.hitbox): number {
    // FUN_0043a980 is entered for interactable shot-collision actors even
    // while ECL op103 has cleared canTakeDamage. Contacts still accumulate
    // raw damage, Cherry/score, the global hit tally, and impact effects;
    // only settlePendingDamage's final HP subtraction is bit2-gated
    // (Th07.exe v1.00b FUN_0041ed50 @ 0x41fa76). Extra PRE7692 is the
    // concrete witness: an op103(0) actor receives all 16 focused-beam
    // history-helper contacts and four id5 effects without losing HP.
    if (!e.ecl.interactable || !e.ecl.shotCollision) return 0;
    let rawDamage = 0;
    // TH08 FUN_00451670 scans all 0xc0 attack slots after the 0x80 shots.
    for (const s of this.activeBombSlots) {
      if (s.cadenceCounter % s.cadenceDivisor !== 0) continue;
      if (s.shape === 'circle') {
        // Circle records test the enemy's live origin directly, without
        // expanding the radius by the enemy hitbox.
        const dx = e.x - s.x;
        const dy = e.y - s.y;
        if (dx * dx + dy * dy > s.radiusX * s.radiusX) continue;
      } else {
        if (!orientedBoxHitsPoint(
          e.x, e.y, s.x, s.y,
          hitbox.x + s.radiusX, hitbox.y + s.radiusY, s.angle
        )) continue;
      }
      this.damageEnemy(
        e,
        s.damage,
        s.source === 'shot' && !this.bombActiveThisFrame ? 'shot' : 'bomb'
      );
      rawDamage += Math.trunc(s.damage);
      s.hitTally += s.damage;
      // Player+0xe2a94 is one global hit counter. Every fourth TH08 attack-
      // slot contact emits effect 3. Effect 5 is the ordinary shot-impact
      // path, not a high-slot branch (all.c:40459-40475).
      if ((++this.playerHitTally & 3) === 0) {
        this.spawnEffectParticles(3, e.x, e.y, 1, 0xffffffff);
      }
    }
    return rawDamage;
  }

  private beginBulletClearFade(
    b: EnemyBullet,
    itemType?: ItemType,
    ignoreClearImmunity = false
  ): boolean {
    if (b.clearFadeFrames != null || b.dead || (!ignoreClearImmunity && (b.flags & 0x1000) !== 0)) return false;
    if (itemType) this.spawnItem(itemType, b.x, b.y, { state: 1 });
    // Th07.exe (v1.00b) FUN_004241c0 @ 0x424633 enters state 5. The
    // authored removal ANM keeps the fixed slot occupied for 12 following
    // manager ticks (Phantasm native slot 666: PRE10463..PRE10474), moving
    // at half velocity before FUN_00416c90 releases it.
    b.clearFadeFrames = 12;
    b.clearRunner = this.runtime?.createBulletClearRunner(b.sprite) ?? undefined;
    return true;
  }

  private beginBombClearFade(b: EnemyBullet): boolean {
    // Every Border-Team FUN_0044df00 bomb-clear quad carries param6=6.
    // Bullet state-5 settlement therefore creates item type 6 (pointStar),
    // not a time orb. Native Stage-2 f698 exposes the first conversion as
    // item slot 86/type6/state1 with zero spawn RNG.
    return this.beginBulletClearFade(b, 'pointStar');
  }

  private cancelBulletWithBombSlots(b: EnemyBullet): boolean {
    if (b.dead || b.clearFadeFrames != null || (b.flags & 0x1000) !== 0) return false;
    // FUN_0043b040 (all.c:27726): the +0x17dc clear-region pool — the activation
    // expanding blast plus the moving seal orbs — is scanned BEFORE the graze box.
    // Both FUN_0043b350 (clear/graze, age > 15) and FUN_0043b200 (clear/hit,
    // every other normal bullet) call it first. Clear regions therefore also
    // consume young or already-grazed bullets; the 16-frame gate is graze-only.
    for (const r of this.bombClearRegions) {
      if (r.framesLeft <= 0) continue;
      const dx = b.x - r.x;
      const dy = b.y - r.y;
      if (dx * dx + dy * dy < r.radius * r.radius) {
        return this.beginBombClearFade(b);
      }
    }
    for (const box of this.bombClearBoxes) {
      if (box.framesLeft <= 0) continue;
      // FUN_00449ff0 tests the bullet POSITION only. The quad stores full
      // width/height and halves them internally; bullet hitbox/graze size is
      // not added to either extent.
      if (orientedBoxHitsPoint(
        b.x, b.y, box.x, box.y, box.width, box.height, box.angle
      )) return this.beginBombClearFade(b);
    }
    // Th08.exe FUN_00449ff0's pool probe (player+0xbb834): the familiar
    // master-death quads. Same contact shape as the bomb regions above, but
    // the kill enters state 5 directly — no time-orb award (DAT_018b8988 is
    // -1 outside bomb/spell context, all.c:23535-23552). Spawn-state bullets
    // never reach this probe: updateBullets returns them into the deferred
    // quadKillType latch (below), which pays the conversion on the
    // transition-VM's ending tick exactly as the exe does (all.c:23589-23644).
    for (const z of this.th08DeathClearZones) {
      if (z.framesLeft <= 0) continue;
      const dx = b.x - z.x;
      const dy = b.y - z.y;
      if (dx * dx + dy * dy < z.radius * z.radius) {
        // Bullet->item conversion on the quad kill (all.c:23597-23651,
        // DAT_018b8988 = the quad's param6): 9 pays TWO type-7 items, any
        // other type > -1 pays one item of exactly that type (state arg 1;
        // FUN_004400a0 still forces time items to their toss-arc state).
        this.th08PayQuadConversion(z.convertType, b.x, b.y);
        return this.beginBulletClearFade(b);
      }
    }
    // ReimuA's moving r128 circles are published explicitly by its state-1
    // bomb VM into bombClearRegions above. Do not infer them from attack
    // slots: the state-2/landmine r256 damage slots have no matching
    // FUN_0043e7e0 call and must not clear bullets (Phantasm PRE10470).
    // SakuyaB likewise: the focused cast publishes its own r96 one-pass
    // circle each frame (FUN_0040cbf0 -> FUN_0043e7e0) and the unfocused
    // cast clears no bullets at all (freeze-only), so neither may fall
    // back to the damage-slot boxes.
    return false;
  }

  // Fires once when the deathbomb window lapses (tickDeath 'effects'): the
  // death explosion, power drops, bullet clear. The respawn itself (teleport +
  // materialize) is deferred to onPlayerRespawn() after the 30-frame death
  // squish, matching Th07.exe fcn.0043dca0.
  private onPlayerDeath(): void {
    const p = this.playerObj;
    this.voidSpellCapture();
    // No SE/effects here: the exe front-loads the death SE and both hit
    // bursts onto the hit frame itself (FUN_0043bd60, see onPlayerHit); the
    // meter-zero commit only runs the drop/penalty bookkeeping + squish.
    // Th07.exe FUN_0043dca0 @ all.c:28601-28641: the power penalty applies
    // BEFORE the drops, so death drops can never hit the >=128 spawn-time
    // bigCherry conversion, and the branch picks the drop set:
    //  - power < 1: 5x fullPower (a pity refund), cherry penalty skipped;
    //  - else: power = 0 if < 17, otherwise -16, then 1x bigPower +
    //    5x power, then the cherry penalty.
    // (An earlier port spawned 5x power before the -16 landed 30 frames
    // later in the respawn — at max power those converted to bigCherry,
    // the tester's inconsistent miss-drop report.)
    if (p.power < 1) {
      for (let i = 0; i < 5; i++) this.spawnDeathDrop('powerFull', p.x, p.y);
    } else {
      p.power = p.power < 17 ? 0 : p.power - 16;
      this.spawnDeathDrop('powerBig', p.x, p.y);
      for (let i = 0; i < 5; i++) this.spawnDeathDrop('powerSmall', p.x, p.y);
    }
    // FUN_0043dca0 @ 0x43df6a-0x43df79: the miss penalty lands after the
    // power/cherry/drop bookkeeping, on the death-commit frame.
    this.adjustRank(-0x640);
    // Native Player.cpp:1781: the miss commit also zeroes the full-power
    // P-item score-ladder counter (redundant with the below-cap pickup reset
    // after the power penalty, but written there by the exe).
    this.powerItemCountForScore = 0;
    // The exe does NOT clear the field at the miss — the respawn arms a
    // 60-frame continuous silent cancel instead (see onPlayerRespawn).
    this.playerEffects.clear();
  }

  // TH08 death drops are pool state-2 spawns: FUN_0043dca0's miss block calls
  // FUN_004400a0(pos, type, 2) per item (all.c:37886-37909), and param_4==2
  // pays its two draws inside the found-slot block — target = rand01*304+48 /
  // rand01*192-64 — with the velocity fields reused as the tween origin. The
  // former caller-side `rng.f()*288+48` pre-draw kept the draw count aligned
  // by accident but discarded the tween, so every miss drop fell straight
  // down instead of lerping to its scattered target over 60 frames.
  private spawnDeathDrop(type: ItemType, x: number, y: number): void {
    this.spawnItem(type, x, y, { state: 2 });
  }

  // Fires once when the death squish finishes (tickDeath 'respawn'): teleport
  // to the spawn point and enter the materialize state. fcn.0043dca0 loses the
  // life at this teleport, not at the hit.
  private onPlayerRespawn(): void {
    const p = this.playerObj;
    p.die();
    // Th07.exe FUN_0043e170 (respawn/materialize init, all.c:28657) arms
    // player+0x2400 = 60; while it counts down, FUN_0043e2e0 runs
    // FUN_00422ea0(0) every frame — a silent, itemless field clear that
    // gives the respawned player a bullet-free bubble.
    this.respawnClearFrames = 60;
    if (p.lives < 0) {
      this.gameOver = true;
      // PCB offers 3 continues per game; past that it's a straight game over.
      if (this.mode === 'arcade' && this.continuesUsed < 3) {
        this.continueScreen = { cursor: 0 };
      }
    }
  }

  // -- pause menu -------------------------------------------------------------

  private openPause(): void {
    const ascii = this.assets.anms.ascii;
    const entryIndex = 2; // data/ascii/pause.png
    const entry = ascii.entries[entryIndex];
    if (!entry) return;
    const runners: AnmRunner[] = [];
    for (let id = 0; id <= 6; id++) {
      if (!ascii.hasScriptInEntry(entryIndex, id)) return;
      runners.push(new AnmRunner(ascii, id, { entryIndex, spriteIndexOffset: entry.spriteBase }));
    }
    // Scripts 0-3 = 一時停止 + the three menu rows; 4-6 = the confirm set.
    for (let i = 0; i <= 3; i++) runners[i].interrupt(1);
    this.pauseState = { cursor: 0, confirm: false, confirmCursor: 1, closing: 0, action: null, runners };
    this.playSfx(34); // se_pause (TH08 id 34)
  }

  private updatePause(input: InputFrame): void {
    const ps = this.pauseState!;
    for (const runner of ps.runners) runner.update(1);
    if (ps.closing > 0) {
      if (--ps.closing === 0) {
        const action = ps.action;
        this.pauseState = null;
        if (action === 'title') this.exitToTitle();
        else if (action === 'retry') this.onRetryRun?.();
      }
      return;
    }
    const select = () => this.audio.sfx('se_select00', 0.141, 12);
    if (ps.confirm) {
      if (input.pressed.has('up') || input.pressed.has('down')) {
        ps.confirmCursor ^= 1;
        select();
      }
      if (input.pressed.has('shoot') || input.pressed.has('confirm')) {
        if (ps.confirmCursor === 0) {
          this.audio.sfx('se_ok00', 0.316, 10);
          this.beginPauseClose(ps.cursor === 1 ? 'title' : 'retry');
        } else {
          this.pauseConfirmBack(ps);
        }
      } else if (input.pressed.has('back') || input.pressed.has('bomb')) {
        this.pauseConfirmBack(ps);
      }
      return;
    }
    if (input.pressed.has('up')) {
      // Replay playback exposes only Resume / Return to Title; the native
      // replay-bit branch never lets the cursor reach Retry (FUN_004023c0).
      ps.cursor = this.mode === 'replay' ? ps.cursor ^ 1 : (ps.cursor + 2) % 3;
      select();
    } else if (input.pressed.has('down')) {
      ps.cursor = this.mode === 'replay' ? ps.cursor ^ 1 : (ps.cursor + 1) % 3;
      select();
    }
    if (input.pressed.has('shoot') || input.pressed.has('confirm')) {
      if (ps.cursor === 0) {
        this.audio.sfx('se_ok00', 0.316, 10);
        this.beginPauseClose('resume');
      } else {
        // Both destructive rows confirm through 本当に？ (default いいえ).
        this.audio.sfx('se_ok00', 0.316, 10);
        ps.confirm = true;
        ps.confirmCursor = 1;
        for (let i = 0; i <= 3; i++) ps.runners[i].interrupt(2);
        for (let i = 4; i <= 6; i++) ps.runners[i].interrupt(1);
      }
    } else if (input.pressed.has('back') || input.pressed.has('bomb') || input.pressed.has('pause')) {
      this.audio.sfx('se_cancel00', 0.316, 11);
      this.beginPauseClose('resume');
    }
  }

  private pauseConfirmBack(ps: NonNullable<typeof this.pauseState>): void {
    this.audio.sfx('se_cancel00', 0.316, 11);
    ps.confirm = false;
    for (let i = 4; i <= 6; i++) ps.runners[i].interrupt(2);
    for (let i = 0; i <= 3; i++) ps.runners[i].interrupt(1);
  }

  private beginPauseClose(action: 'resume' | 'title' | 'retry'): void {
    const ps = this.pauseState!;
    ps.action = action;
    ps.closing = 20; // the authored hide interrupt fades over 20 frames
    for (const runner of ps.runners) runner.interrupt(2);
  }

  private drawPause(r: Renderer): void {
    const ps = this.pauseState!;
    const ctx = r.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, 640, 480);
    ctx.restore();
    ps.runners.forEach((runner, i) => {
      if (this.mode === 'replay' && i === 3) return;
      const frame = runner.spriteFrame();
      if (!frame) return;
      // Cursor highlight: unselected rows draw tinted down (the authored
      // scripts carry no selected/unselected variants — approximation).
      const selected = ps.confirm
        ? (i === 5 && ps.confirmCursor === 0) || (i === 6 && ps.confirmCursor === 1)
        : i === ps.cursor + 1;
      const isRow = ps.confirm ? i >= 5 : i >= 1 && i <= 3;
      r.drawAnmFrame(frame, 0, 0, isRow && !selected ? { color: 0xff707070 } : {});
    });
  }

  // -- arcade flow (continue screen / scene exit) ----------------------------

  private updateContinueScreen(input: InputFrame): void {
    const cs = this.continueScreen!;
    if (input.pressed.has('up') || input.pressed.has('down') || input.pressed.has('left') || input.pressed.has('right')) cs.cursor ^= 1;
    if (input.pressed.has('shoot') || input.pressed.has('confirm')) {
      if (cs.cursor === 0) this.doContinue();
      else this.declineContinue();
      return;
    }
    if (input.pressed.has('bomb') || input.pressed.has('back')) {
      if (cs.cursor === 1) this.declineContinue();
      else cs.cursor = 1;
    }
  }

  private doContinue(): void {
    const p = this.playerObj;
    this.continuesUsed++;
    // The original's famous continue penalty: the score is wiped and becomes
    // the number of continues used.
    this.score = this.continuesUsed;
    p.lives = 2;
    p.bombs = Math.trunc(p.unfocused.bombsPerLife);
    this.gameOver = false;
    this.gameOverTimer = 0;
    this.continueScreen = null;
    this.playSfx(10); // se_ok00 (TH08 id 10, TH07 id 10)
  }

  private declineContinue(): void {
    this.continueScreen = null;
    this.gameOverTimer = 0; // gameOver stays set; update() exits after the linger
  }

  private exitToTitle(): void {
    if (this.exitFired) return;
    this.exitFired = true;
    this.audio.fadeOutBgm(1);
    this.onExitToTitle?.();
  }

  // Accumulates a hit into the enemy's per-frame damage pool; the pool is
  // settled once per frame by settlePendingDamage() through the exe's exact
  // pipeline (Th07.exe FUN_0041ed50). NOT gated on canTakeDamage — in the
  // exe, hits on an invulnerable boss still award score and cherry (the
  // bit2 check only guards the HP subtraction).
  damageEnemy(e: Enemy, damage: number, kind: 'shot' | 'bomb' = 'shot'): void {
    if (!e.ecl.interactable) return;
    // TH08 death-switch case 1's bit23 (0x800000) hides the enemy SPRITE
    // only (all.c:21649-21652); the native damage settlement (all.c:21449+)
    // gates on flags bits 4/5/11 and the shot/body/damage semantic bits —
    // never on the hide flag. Gating here made Mystia permanently
    // shot-immune after her mid-fight mode-1 death until ins_129 cleared it.
    // TH08 familiar side gate (all.c:21448, flags bit 11): an ETHEREAL
    // familiar (player in youkai form) takes no player-shot or attack-slot
    // damage at all — the whole settlement block is behind bit11==0.
    if (e.ecl.th08?.familiar && e.ecl.th08.sideBit === 1) return;
    // TH08 FUN_00451670 @ 0x4517e1-0x451815: while the player's own bomb is
    // active (player+0xfdc), scale EACH colliding shot's SHT damage by /5,
    // with a minimum of 1, before adding it to the per-enemy frame total.
    // This is deliberately per shot: 12+20 becomes 2+4, not (12+20)/5.
    if (kind === 'shot' && this.bombActiveThisFrame) {
      damage = Math.max(1, Math.trunc(damage / 5));
    }
    if (kind === 'shot') e.pendingShotDmg += damage;
    else e.pendingBombDmg += damage;
  }

  // Th07.exe FUN_0041ed50 damage pipeline (all.c:14174-14253), run once per
  // enemy per frame:
  //   raw = this frame's shot+bomb sum (shots pre-scaled /5 during a bomb)
  //   cherry gain from the PRE-cap raw sum (its own internal 70 cap)
  //   raw capped at 70 (0x46 @ all.c:14226 — TH07-confirmed, not TH06 lore)
  //   score += capped/5
  //   if canTakeDamage:
  //     spell card active (DAT_012f40a8): shots-only → /7 (min 1);
  //       any bomb contribution → 0 unless a bomb was triggered during this
  //       spell (DAT_012f40bc latch), then /2.5 (min 1; DAT_0048eda8=2.5,
  //       disasm @ 0x41fafa-0x41fb0e)
  //     op-142 shield active: boss → /9, non-boss → 0
  //     hp -= result
  private settlePendingDamage(e: Enemy): boolean {
    let shotRaw = e.pendingShotDmg;
    const bombRaw = e.pendingBombDmg;
    const hadBomb = bombRaw > 0;
    // FUN_00451670's return tail (all.c:40497-40499): while the live gauge
    // is past the youkai effects threshold (FUN_00406d70), the frame's
    // complete raw contact damage — shots plus attack slots, before the
    // 70 cap, spell tiering and shields — is scaled by 106/100. Keep the
    // bomb part intact so the spell branch's bomb flag stays native.
    if (this.runState.gaugeIsExtremelyYoukai()) {
      shotRaw = Math.trunc((shotRaw + bombRaw) * 106 / 100) - bombRaw;
    }
    const raw = shotRaw + bombRaw;
    e.pendingShotDmg = 0;
    e.pendingBombDmg = 0;
    // TH08 enemy+0x3354 (ECL var 10083): HP actually removed by this
    // settlement.  Do not reuse the TH07 var-10061 mapping here: in TH08
    // vars 10061-10068 are the eight run-global float defaults.
    e.damageThisFrame = 0;
    if (raw <= 0) return hadBomb;
    // Replay load writes DAT_00625627 as the complete shot byte
    // character*2+type (0 ReimuA .. 5 SakuyaB), not merely the A/B bit.
    // The quirks below compare it to zero and therefore apply to ReimuA only.
    const shotIndex = this.shotIndex;
    // Per-stage ReimuA shot-damage reduction vs NON-boss enemies
    // (all.c:14198-14209, gated on DAT_00625627=='\0' and bit6 clear):
    // stage 4 -> dmg - dmg/4 - dmg/16 (11/16), stages 5-6 -> dmg/2.
    if (shotIndex === 0 && !e.ecl.isBoss && shotRaw > 0) {
      if (this.stageNumber === 4) {
        shotRaw = shotRaw - Math.trunc(shotRaw / 4) - Math.trunc(shotRaw / 16);
      } else if (this.stageNumber === 5 || this.stageNumber === 6) {
        shotRaw = Math.trunc(shotRaw / 2);
      }
    }
    let dmg = Math.min(70, shotRaw + bombRaw);
    this.addScore(Math.trunc(dmg / 5) * 10);
    if (!e.ecl.canTakeDamage) return hadBomb;
    if (this.spellcard) {
      if (!hadBomb) dmg = dmg >= 8 ? Math.trunc(dmg / 7) : dmg > 0 ? 1 : 0;
      else if (!this.bombDuringSpell) dmg = 0;
      else dmg = dmg > 2 ? Math.trunc(dmg / 2.5) : dmg > 0 ? 1 : 0;
    }
    if (e.ecl.damageShield > 0) dmg = e.ecl.isBoss ? Math.trunc(dmg / 9) : 0;
    e.hp -= dmg;
    e.damageThisFrame = dmg;
    this.settledDamageThisFrame += dmg;
    // FUN_0042b370 @ 0x42b370 runs immediately after every native damage
    // settlement.  A child passes half of the HP it actually lost to its
    // parent.  This is load-bearing in Stage 2: Sub12's 64-damage contact at
    // replay f1805 removes 32 HP from its Sub11 master in the SAME manager
    // pass.  The parent's ins_160 shield uses the same rules as a direct hit
    // (non-boss: zero; boss: /9), and the indirect damage may not cross the
    // largest still-armed life threshold.  The helper deliberately does not
    // write the parent's +0x3354 damage field or award score a second time.
    const parent = e.ecl.parent;
    if (parent && dmg !== 0) {
      let shared = Math.trunc(dmg / 2);
      if (parent.ecl.damageShield > 0) {
        shared = parent.ecl.isBoss ? Math.trunc(shared / 9) : 0;
      }
      if (shared !== 0) {
        let floor = 0;
        for (const phase of parent.ecl.lifeThresholds) {
          if (phase.threshold > floor) floor = phase.threshold;
        }
        parent.hp -= shared;
        if (parent.hp <= floor) parent.hp = floor;
      }
    }
    return hadBomb;
  }

  private updatePlayerBullets(collide = true): void {
    this.syncPlayerBulletSlots();
    const rate = this.slowRate;
    this.shotCollisionEnabled = collide;
    for (let slot = 0; slot < PLAYER_BULLET_POOL_CAP; slot++) {
      const b = this.playerBulletSlots[slot];
      if (!b) continue;
      if (b.dead) {
        this.playerBulletSlots[slot] = null;
        continue;
      }
      if (b.state === 'fired') {
        if (b.tickFunc === 1) {
          // TH08 SHT tick callback 1 (FUN_00450320): the unfocused Border
          // pair's per-frame seek against the PRIMARY position cache
          // (player+0xe2aa4, the max-y enemy). Gates on the shot's own age:
          // past frame 39 (0x27) the exe falls to the targetless branch
          // (accelerate 1/3, clamp 10) even while a target is fresh.
          updateTh08SeekingOptionShot(b, b.age < 40 ? this.th08TargetPos : null);
        }
      }
      // Both fired and collided slots keep integrating velocity at the
      // current rate; the per-shot ANM VM ticks
      // alongside and the bullet dies when its script removes itself (impact
      // scripts end in remove(); flight scripts end in static and never do).
      // FUN_0043a290 @ all.c:27472-27475 stores each rate-scaled add back
      // into the slot's float32 position fields. Per-tick f32 rounding is
      // observable at long-window id5 collision boundaries (Stages 2/3).
      b.x = Math.fround(b.x + b.vx * rate);
      b.y = Math.fround(b.y + b.vy * rate);
      b.runner.update(rate);
      if (b.runner.removed) {
        b.dead = true;
      } else {
        // Player::UpdateShots (0x0043d2f0) culls with the shot VM's LIVE
        // sprite pointer (vm.sprite->widthPx/heightPx into
        // GameManager::IsInBounds @ 0x42bdc7); render visibility is never
        // consulted. ReimuB's orb bullet script (0x442) selects its real
        // 14x46 sprite at time zero, so the engine's 32x32 spawn-template
        // rect culled it above the field one frame before a native f2131
        // hit. spriteSize() exposes the wrapper's current pointer.
        const size = b.runner.spriteSize?.() ?? b.rect;
        const halfW = size.w / 2;
        const halfH = size.h / 2;
        const onscreen = b.x + halfW >= 0 && b.x - halfW <= 384 &&
          b.y + halfH >= 0 && b.y - halfH <= 448;
        if (!onscreen) b.dead = true;
      }
      // FUN_0043a290 advances the split age counter at the tail, after the
      // behavior callback, position integration, cull, and ANM tick.
      b.age += rate;
      if (b.dead && this.playerBulletSlots[slot] === b) {
        this.playerBulletSlots[slot] = null;
      }
    }
    this.compactLive(this.playerBullets);
    this.refreshActiveAttackSlots();
  }

  private firePlayerBullets(allowSpawn: boolean): void {
    if (this.gameOver) return;
    const volley = this.playerObj.fire(this.slowRate, allowSpawn);
    let playedShotSfx = false;
    for (const b of volley) {
      if (b.behaviorFunc === 1) {
        // TH08 SHT init callback 1 (FUN_00450240): with the pointer-cache
        // target, the fresh shot's velocity rotates onto the target bearing
        // plus the record's split offset — normalize(atan2 + rec.angle +
        // pi/2) — AND its speed scales x1.5 (FUN_004286e0's second arg reads
        // record.speed * 0x4b4438). Without a target the record's plain
        // velocity stands.
        const target = this.th08LungeEnemy;
        if (target) {
          const spread = Math.fround(b.angle + NATIVE_HALF_PI_F32);
          const targetAngle = Math.fround(Math.atan2(target.y - b.y, target.x - b.x));
          const aim = normalizeNativeAngleF32(targetAngle, spread);
          const speed = Math.fround(b.speed * 1.5);
          b.angle = aim;
          b.speed = speed;
          b.vx = Math.fround(Math.cos(aim) * speed);
          b.vy = Math.fround(Math.sin(aim) * speed);
        }
      }
      if (!this.addPlayerBullet(b)) {
        b.dead = true;
        continue;
      }
      if (b.sfxId >= 0) playedShotSfx = true;
    }
    // FUN_00438b70: the shot SE is tied to the accepted spawn event of the
    // one shooter whose SHT record carries sfxId>=0.
    if (playedShotSfx) this.playSfx(0);
  }

  // VALIDATION-EXPERIMENT: exe FUN_0043a980 (all.c:14176), called PER ENEMY
  // inside the enemy manager. Tests every player bullet against ONE enemy,
  // deals IMMEDIATE damage (accumulated into pending, settled this same frame
  // before the death check) and spawns the id5 impact spark — so id5/death
  // draws land in the exe's per-enemy stream order (vs our old bullet-outer
  // pass). A single-hit bullet becomes 'collided' on its first enemy and is
  // then skipped by later enemies (replacing the old inner-loop `break`).
  private collidePlayerShots(e: Enemy): void {
    if (!this.shotCollisionEnabled || !this.playerShotCollisionClockAdvanced) return;
    // TH08: enemy flags bit 4 (set/cleared by ins_80/81) disables the whole
    // contact block — collision, damage, and homing-target publication
    // (all.c:21448 gates the scan on it clear). Controllers like stage-1's
    // ambient Sub14 hold it set permanently.
    if (e.ecl.th08 && (e.ecl.th08.flags & 0x10) !== 0) return;
    // Same all.c:21448 block: flags bit 11 (ethereal familiar, player in
    // youkai form) skips the shot scan entirely — shots fly THROUGH to the
    // enemies behind. Without this gate our shots die on the ghost with the
    // damage merely vetoed, starving the master (native replay f1680-1698:
    // the master took ~280 damage through the ethereal familiars).
    if (e.ecl.th08?.familiar && e.ecl.th08.sideBit === 1) return;
    if (!e.ecl.shotCollision || !e.ecl.interactable || e.dead) return;
    this.collidePlayerShotsInBox(e, e.ecl.hitbox);
    const second = e.ecl.hitbox2;
    if (!second || second.x <= 0) return;
    const shotBefore = e.pendingShotDmg;
    const bombBefore = e.pendingBombDmg;
    this.collidePlayerShotsInBox(e, second);
    const secondaryShot = e.pendingShotDmg - shotBefore;
    const secondaryBomb = e.pendingBombDmg - bombBefore;
    // FUN_0041ed50's second FUN_0043a980 scan is always mutating (shots can
    // impact and effects spawn), but its damage contributes only when no
    // attack slot set local_18; then the aggregate is truncated /2.5.
    if (secondaryBomb === 0) {
      e.pendingShotDmg = shotBefore + Math.trunc(secondaryShot / 2.5);
      e.pendingBombDmg = bombBefore;
    } else {
      e.pendingShotDmg = shotBefore;
      e.pendingBombDmg = bombBefore;
    }
  }

  private tickPlayerShotCollisionClock(specialState: boolean): void {
    const rate = Math.fround(this.slowRate);
    if (specialState) {
      // Both state-3 invulnerability and state-4 Border setup initialize the
      // timer fraction to zero. FUN_00436a06's <=0.99 slow path then stores
      // current->previous, subtracts the float32 rate, and retreats the
      // integer only when the fraction crosses below zero. This makes the
      // first special-state tick scan, followed by the authored slow cadence.
      if (!this.playerShotCollisionClockSpecial) this.playerShotCollisionClockFrac = 0;
      this.playerShotCollisionClockSpecial = true;
      if (rate > 0.99) {
        // Fast path decrements the current integer without overwriting the
        // -999 previous-value sentinel, so every wall frame scans.
        this.playerShotCollisionClockAdvanced = true;
      } else {
        this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac - rate);
        if (this.playerShotCollisionClockFrac < 0) {
          this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac + 1);
          this.playerShotCollisionClockAdvanced = true;
        } else {
          this.playerShotCollisionClockAdvanced = false;
        }
      }
      return;
    }
    if (this.playerShotCollisionClockSpecial) {
      // Both state exits reset the timer's fractional word to zero before
      // returning to the normal incrementing branch.
      this.playerShotCollisionClockFrac = 0;
      this.playerShotCollisionClockSpecial = false;
    }
    if (rate > 0.99) {
      // FUN_00436acc's fast path increments the integer directly and leaves
      // any pre-existing fractional residue untouched.
      this.playerShotCollisionClockAdvanced = true;
      return;
    }
    this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac + rate);
    if (this.playerShotCollisionClockFrac >= 1) {
      this.playerShotCollisionClockFrac = Math.fround(this.playerShotCollisionClockFrac - 1);
      this.playerShotCollisionClockAdvanced = true;
    } else {
      this.playerShotCollisionClockAdvanced = false;
    }
  }

  private collidePlayerShotsInBox(e: Enemy, hitbox: { x: number; y: number; z: number }): void {
    const anm = this.playerObj.anm;
    // Th07.exe (v1.00b) FUN_0043a980 @ 0x43a9e6-0x43aa13 builds the four
    // ENEMY edges first and fstp-stores each as f32. Bullet edges stay in
    // x87 until the inclusive comparisons. The algebraically equivalent
    // center-distance test rounds at different places; one SakuyaA knife
    // can then move across an edge by a frame and change the aggregated
    // focused-boss Cherry+ award without changing kill/RNG event streams.
    const enemyMinX = Math.fround(Math.fround(e.x) - Math.fround(hitbox.x) * 0.5);
    const enemyMinY = Math.fround(Math.fround(e.y) - Math.fround(hitbox.y) * 0.5);
    const enemyMaxX = Math.fround(Math.fround(e.x) + Math.fround(hitbox.x) * 0.5);
    const enemyMaxY = Math.fround(Math.fround(e.y) + Math.fround(hitbox.y) * 0.5);
    let rawDamage = 0;
    for (let slot = 0; slot < PLAYER_BULLET_POOL_CAP; slot++) {
      const b = this.playerBulletSlots[slot];
      if (!b) continue;
      if (b.dead) continue;
      if (b.driftHarmless) continue;
      if (b.state !== 'fired') continue;
      const bulletMinX = Math.fround(b.x) - Math.fround(b.hitboxW) * 0.5;
      const bulletMinY = Math.fround(b.y) - Math.fround(b.hitboxH) * 0.5;
      const bulletMaxX = Math.fround(b.x) + Math.fround(b.hitboxW) * 0.5;
      const bulletMaxY = Math.fround(b.y) + Math.fround(b.hitboxH) * 0.5;
      if (bulletMinY <= enemyMaxY && bulletMinX <= enemyMaxX &&
          enemyMinY <= bulletMaxY && enemyMinX <= bulletMaxX) {
        // FUN_00451670 checks the PERSISTENT accumulator before adding any
        // damage from this collision call. Crossing consumes the threshold
        // even for a non-eligible/focused shot; only an extremely-human
        // eligible shot turns that crossing into a state-3 time item.
        while (e.timeOrbDamageAccumulator >= TH08_SHOT_TIME_ORB_THRESHOLD) {
          if (this.runState.gaugeIsExtremelyHuman() && b.timeOrbEligible) {
            this.spawnItem('time', b.x, b.y, { state: 3 });
          }
          e.timeOrbDamageAccumulator -= TH08_SHOT_TIME_ORB_THRESHOLD;
        }
        rawDamage += Math.trunc(b.damage);
          this.traceReplayEvent?.({
            kind: 'damage', frame: this.frame,
            data: { slot: e.poolSlot, sub: e.ecl.subId, dmg: b.damage, hp: e.hp }
          });
          this.damageEnemy(e, b.damage);
          b.state = 'collided';
          if (anm.hasScript(b.impactScript)) {
            b.runner = new AnmRunner(anm, b.impactScript);
            // FUN_0043a980 re-arms the slot through FUN_004486e0 after the
            // player's ANM pass has already run. Its split clock has consumed
            // the synchronous t=0 init, so the first following player tick is
            // t=1; a remove authored at t=20 therefore frees the slot on the
            // twentieth following tick. Starting AnmRunner at zero kept every
            // impact alive one extra frame and changed which SHT record won a
            // full 128-slot pool (native Stage 3 processing frame 2811).
            b.runner.frame = 1;
          }
          // TH08 settle (all.c:40425-40438): while the shot is still in its
          // flying state the VM re-arms to sprite+0xb and FUN_00425430(5)
          // arms the impact burst in the MAIN effect pool — etama archive
          // script 37, 30-frame life, 4 draws (init callback FUN_00425d70).
          // Routing through the pool (not the scripted side layer) is what
          // feeds the native draw economy + pool pressure; the particle
          // renders as the spark fallback (§7).
          this.spawnEffectParticles(5, b.x, b.y, 1, 0xffffffff);
          b.vx /= 8;
          b.vy /= 8;
          this.playSfx(20);
      }
    }
    rawDamage += this.collideBombSlots(e, hitbox);
    // The native call adds min(total raw shot/attack-slot damage, 50) only
    // after the complete slot scan. Hitbox2 invokes this function again with
    // the same accumulator, which can therefore emit a second item in-frame.
    e.timeOrbDamageAccumulator += Math.min(rawDamage, 50);
  }


  private checkEnemyBulletCollision(b: EnemyBullet): void {
    const p = this.playerObj;
    if (b.dead || this.gameOver) return;
    const dx = Math.abs(b.x - p.x);
    const dy = Math.abs(b.y - p.y);
    if (!p.alive) {
      // Native Player.cpp:1032 CalcKillboxCollision: playerState != ALIVE
      // (deathbomb window, death squish, or respawn materialize) returns 1 —
      // a SILENT despawn: no RerollRng, no Die. CheckGraze (Player.cpp:1061)
      // returns 0 for DEAD/SPAWNING, and an ungrazed bullet old enough to
      // graze-test takes that result-0 branch and never reaches the killbox
      // (BulletManager.cpp:995-1016 call flow) — only already-grazed or
      // young bullets despawn. The despawn is NOT a contact event: firing
      // onPlayerContact here inflated Mt01 playerHits 18 -> 58 in the
      // reverted first attempt at this fix.
      if (!b.grazed && b.age > 15) return;
      if (dx > b.grazeW / 2 + p.hitboxHalf || dy > b.grazeH / 2 + p.hitboxHalf) return;
      this.removeEnemyBullet(b);
      return;
    }
    if (!b.grazed && b.age > 15 &&
        dx <= b.grazeW / 2 + p.grazeboxHalf + 20 &&
        dy <= b.grazeH / 2 + p.grazeboxHalf + 20) {
      b.grazed = true;
      this.onGrazeAward(b.x, b.y);
    }
    if (dx > b.grazeW / 2 + p.hitboxHalf || dy > b.grazeH / 2 + p.hitboxHalf) return;
    this.onPlayerContact?.('bullet');
    // FUN_0043b200 result 1 consumes the touching bullet while the player is
    // invulnerable, bombing, or already in the deathbomb state.
    if (p.invulnFrames > 0 || p.bombInvuln > 0 || p.hitState) {
      this.removeEnemyBullet(b);
      return;
    }
    this.onPlayerHit(b);
  }

  // TH08 familiar (使魔) per-tick side sync — FUN_0042c420 @ all.c:
  // 21146-21185, run for every flags-bit-8 child before the collision
  // block. On a player form flip the familiar plays the materialize/
  // dematerialize transition — effect 0x1e (etama 59, red 0x80803030)
  // when the player becomes HUMAN (materialize, se_opshow), effect 0x1f
  // (etama 60, blue 0x80303080) when the player becomes YOUKAI
  // (etherealize, se_ophide) — fires interrupt 2/1 on the marker VM,
  // relinks the manager list (0 = player-youkai / 2 = player-human) and
  // re-syncs bit 11 to the form. The marker VM itself (FUN_00425b70(0x20)
  // at spawn — etama archive 48) is attached lazily here.
  private tickTh08FamiliarSync(e: Enemy): void {
    const t8 = e.ecl.th08;
    if (!t8?.familiar || e.dead) return;
    const form = this.playerObj.th08Form;
    const wasMaterialized = t8.sideBit === 0; // bit 11 BEFORE this tick's re-sync
    if (t8.sideBit !== form) {
      const toYoukai = form === 1;
      // FUN_0042c420's transition colors as ARGB -> our rgb multiplier +
      // alpha: 0x80303080 (blue, player -> youkai) / 0x80803030 (red,
      // player -> human).
      this.spawnEffectParticles(
        toYoukai ? 31 : 30, e.x, e.y, 1, toYoukai ? 0x80303080 : 0x80803030
      );
      t8.markerHandle?.interrupt(toYoukai ? 2 : 1);
      this.playSfx(toYoukai ? 40 : 39); // se_ophide / se_opshow
      t8.managerList = toYoukai ? 0 : 2;
      t8.sideBit = form;
      t8.flags = (t8.flags & ~0x800) | (form << 11);
    }
    // all.c:21164-21166: while materialized (flags bit 11 clear), familiars
    // flagged by ins_83(1) (+0x3328 bit 1, our flags2 bit 1) emit effect 0x26
    // (etama archive script 71, on-disk id -79) at the familiar's live
    // position every second tick of the enemy+0x2e14 timer
    // (FUN_0040ebc0(2): current changed && current % 2 == 0; the timer ticks
    // once per enemy tick from 0 at construction and the gate reads it
    // PRE-tick, so the native fires on the familiar's 1st, 3rd, 5th... tick —
    // measured: cur=0 on the first-alive tick, then cur=2, 4. Our e.frame
    // counts 1 on the first tick, so the gate lands on ODD e.frame).
    // Measured against the native draw counter: 5 random ops x 2 u16 = 10
    // draws per arm, 4-6 arms per second frame from the six Sub12 orbiters
    // at stage-1 f1590+. The bit-11 read uses the PRE-flip state:
    // FUN_0042c420 re-syncs bit 11 only at the function's END
    // (all.c:21179-21180), so on a flip frame the materialized branch
    // still runs.
    if (wasMaterialized && (t8.flags2 & 2) !== 0 && e.frame % 2 === 1) {
      this.spawnEffectParticles(38, e.x, e.y, 1, 0xffffffff);
    }
    if (!t8.markerHandle) {
      const etama = this.assets.anms.etama;
      const ref = archiveScript(etama, 48);
      const actor = { x: e.x, y: e.y, angle: 0, state: 1 };
      t8.markerActor = actor;
      t8.markerHandle = this.th08Effects.spawnHandle({
        scriptId: ref.localId, x: e.x, y: e.y, follow: actor, ttl: Infinity
      });
      t8.markerHandle.interrupt(form === 1 ? 2 : 1);
    }
    if (t8.markerActor) {
      t8.markerActor.x = e.x;
      t8.markerActor.y = e.y;
    }
  }

  // TH08 familiar death settlement:
  // - A familiar killed by damage (only possible while materialized) fires
  //   interrupt 3 on its marker VM — the death-mode-0 path at all.c:
  //   21643-21646 (FUN_00407120(3) when +0x14f2 is armed) — then releases.
  // - A master's death sweeps its familiars (FUN_0042adb0(1) from the
  //   settlement at all.c:21631): pos-inherit children (flags bit 9)
  //   snapshot the master's position into their origin, every child gets
  //   flags bit 10 (0x400), its parent link cleared, and death mode 8 —
  //   the silent auto-despawn with the enep00 pop per child (all.c:
  //   20445-20528). Then the time-orb shower at the master's position:
  //   two per familiar, each scattered by (frand*128, frand*pi) in that
  //   draw order (all.c:20533-20541). Finally the FUN_0044df00 kill quads:
  //   one per swept child (r32, +2/frame, 8 frames, param6 = 7|9 by flags2
  //   bit1) and one at the master (r32, +1/frame, 16 frames, param6 7) —
  //   modeled by th08DeathClearZones (the per-child local_30 orb burst
  //   with its FUN_0042f270/2f230 count tiers is not yet modeled, §7).
  private settleTh08FamiliarDeath(e: Enemy): number {
    const t8 = e.ecl.th08;
    if (t8?.familiar) {
      // FUN_0042adb0's direct-familiar tail runs while the parent link is
      // still live: pull the gauge one twelfth toward neutral BEFORE the
      // common enemy-death form delta at 0x42d65c. A master sweep clears
      // that link first, so swept familiars deliberately skip this pull.
      this.runState.addYoukaiGauge(this.runState.gaugeDialoguePull());
      // FUN_004412b0: a directly destroyed familiar pays a point popup,
      // one immediate time orb, and asks FUN_00416b10 to restore 8000 of
      // the live spell bonus. The latter is suppressed while op 184's
      // global side-mirror bit is set.
      const popupValue = this.runState.pointItemsCollectedInStage < 2000
        ? Math.max(100, Math.trunc(this.runState.pointItemsCollected / 2) * 10)
        : 10000;
      this.spawnScorePopup(popupValue, e.x, e.y, 0xdfffef80);
      this.addScore(popupValue);
      // FUN_0042adb0's familiar direct-kill tail (all.c:20546-20566): the
      // payout is a REAL time-orb item spawn (FUN_004400a0(pos,7,1) = the
      // state-3 draw pair), which then homes and is collected like any orb —
      // NOT a direct counter increment. This feeds the orb's 4-draw spawn
      // AND the 4-draw collect into the stream at the native times.
      this.spawnItem('time', e.x, e.y, {});
      // The same tail clears +0x330c/+0x3308 and writes +0x3304 = -2 before
      // returning to the common death switch. That suppresses the ordinary
      // drop/preburst arm: native Stage-2 f1809 creates the familiar time
      // orb plus the common extreme-gauge orb, but no point item and only
      // the four common effect-4 particles. Leaving the authored point drop
      // live added three preburst particles (12 RNG draws) and one item.
      e.ecl.itemDrop = -2;
      t8.deathDropA = 0;
      t8.deathDropB = 0;
      const sc = this.spellcard;
      if (sc?.capturing && this.runState.th08SideMirror === 0) {
        const elapsed = sc.elapsed + sc.elapsedFrac;
        const restored = sc.bonus + 8000;
        if (restored < sc.bonusLimit) {
          sc.bonus = restored;
          sc.decayPerSec += Math.trunc(8000 / 120);
        } else {
          sc.bonus = sc.bonusLimit;
        }
        sc.bonusAnchor = sc.bonus;
        sc.bonusAnchorElapsed = elapsed;
      }
      t8.markerHandle?.interrupt(3);
      t8.markerHandle?.release();
      t8.markerHandle = null;
      t8.markerActor = null;
      // FUN_0042adb0's parented tail (all.c:20552-20554, gated on
      // FUN_0041fd20 = a live parent link): a familiar's death sets the
      // 0x18b89d4 time-orb-gauge lockout to 50 — CollectTimeOrb's ±111 gauge
      // step is suppressed until the item-manager tail counts it down.
      this.runState.timeOrbGaugeLockout = 50;
      return 0;
    }
    const children = this.enemies.filter(
      c => !c.dead && c.ecl.parent === e && c.ecl.th08?.familiar
    );
    if (children.length === 0) return 0;
    // FUN_0041fd40 counts the FULL live chain at sweep entry (all.c:20428+
    // walks +8 links from the master); every swept child uses that one
    // snapshot for its tier: count < 8 ? count*2+10 : 26 (all.c:20456-20461,
    // stage-1/2 difficulty branch). Then the child's own drop runs
    // FUN_0042bea0(0) with +0x3304 = 8 (pointSmall, param_4=0) plus its
    // (dropEffectId+4) effect burst, and the alternating enep pop.
    const childCount = children.length;
    const orbTier = childCount < 8 ? childCount * 2 + 10 : 26;
    for (const c of children) {
      const ct8 = c.ecl.th08!;
      // FUN_0042adb0 snapshots a pos-inherit child's origin from the master
      // before severing the parent link. The master has already completed
      // this manager tick's movement, while later child slots have not run
      // yet, so preserving the child's logical/orbit offset also carries the
      // master's current-frame displacement into the swept live position.
      // Stage-2's Sub7 death is the exact witness: the master moves from
      // y=121.00 to 121.25 on the settlement tick and all four child-centred
      // drops spawn 0.25px lower in the native trace.
      if ((ct8.flags & 0x200) !== 0) {
        const origin = ct8.movement.origin;
        c.x = Math.fround(c.x + Math.fround(e.x - origin.x));
        c.y = Math.fround(c.y + Math.fround(e.y - origin.y));
        c.z = Math.fround(c.z + Math.fround(e.z - origin.z));
        origin.x = Math.fround(e.x);
        origin.y = Math.fround(e.y);
        origin.z = Math.fround(e.z);
      }
      ct8.flags |= 0x400;
      c.ecl.parent = null;
      c.dead = true;
      ct8.markerHandle?.release();
      ct8.markerHandle = null;
      ct8.markerActor = null;
      // FUN_0044df00 per child (all.c:20497): r32/+2/8 quad; param6 = 7
      // when the master's +0x3324 bit1 is set, 9 otherwise (the stage-1
      // masters all run bit1 clear -> 9, paying two time orbs per converted
      // bullet).
      this.armTh08DeathClearZone(c.x, c.y, 32, 2, 8, (t8!.flags & 2) !== 0 ? 7 : 9);
      for (let i = 0; i < orbTier; i++) {
        const radius = this.rng.f() * (orbTier * 2);
        const angle = (this.rng.f() * 2 - 1) * Math.PI;
        this.spawnItem(
          'time',
          Math.fround(c.x + Math.cos(angle) * radius),
          Math.fround(c.y + Math.sin(angle) * radius),
          {}
        );
      }
      this.spawnEffectParticles((ct8.dropEffectId ?? 0) + 4, c.x, c.y, 3, 0xffffffff);
      this.spawnItem('pointSmall', c.x, c.y, {});
      this.playSfx(2 + (c.id & 1));
    }
    // Master tail (all.c:20530-20544): one time orb per +0x3380 attach-ledger
    // entry times two around the MASTER (frand01*128, frandSigned*pi, state
    // arg 1 — FUN_004400a0 forces the toss arc), then the master's own
    // (r32, +1/frame, 16-frame) kill quad. The ledger counts every attach
    // minus children that already died through the normal death path — it
    // diverges from the live chain length exactly when some children died
    // before the master.
    const tailOrbs = childCount * 2;
    for (let i = 0; i < tailOrbs; i++) {
      const radius = this.rng.f() * 128;
      const angle = (this.rng.f() * 2 - 1) * Math.PI;
      this.spawnItem(
        'time',
        Math.fround(e.x + Math.cos(angle) * radius),
        Math.fround(e.y + Math.sin(angle) * radius),
        { state: 1 }
      );
    }
    this.armTh08DeathClearZone(e.x, e.y, 32, 1, 16, 7);
    // FUN_0042adb0's param_2!=0 block (all.c:20542) rewrites the 0x18b89d4
    // lockout to 0 on every sweep whose dying enemy had a live child chain —
    // a master's death re-opens the orb-gauge gate (the familiar-death 50
    // above then wins the ordering when both apply, matching the binary's
    // block A -> block B sequence).
    this.runState.timeOrbGaugeLockout = 0;
    return childCount;
  }

  // Kill-quad bullet->item conversion (all.c:23597-23651 and its case-3/4
  // twins): DAT_018b8988 == 9 pays TWO type-7 (time) items; any other id
  // > -1 pays ONE item of exactly that native type. The state argument is
  // 1; FUN_004400a0 internally forces time items to the toss-arc state
  // regardless (all.c:30794-30796), which Th08ItemSpawnPool models.
  private th08PayQuadConversion(t: number, x: number, y: number): void {
    if (t === 9) {
      this.spawnItem('time', x, y, { state: 1 });
      this.spawnItem('time', x, y, { state: 1 });
    } else if (t > -1) {
      this.spawnItem(TH08_ITEM_TYPE_BY_ID[t] ?? 'pointSmall', x, y, { state: 1 });
    }
  }

  private armTh08DeathClearZone(x: number, y: number, radius: number, growth: number, frames: number, convertType = -1): void {
    let zone = this.th08DeathClearZones.find(z => z.framesLeft <= 0)
      ?? this.th08DeathClearZones.reduce((a, b) => (a.framesLeft <= b.framesLeft ? a : b));
    zone.x = x;
    zone.y = y;
    zone.radius = radius;
    zone.growth = growth;
    zone.framesLeft = frames;
    zone.convertType = convertType;
  }

  private collideEnemyBody(e: Enemy): void {
    const p = this.playerObj;
    if (this.gameOver || !p.alive || !e.ecl.collisionEnabled ||
        (e.ecl.th08 && (e.ecl.th08.flags & 0x10) !== 0) ||
        !e.ecl.interactable || e.dead) return;
    // TH08 familiar body contact — two stacked gates:
    // 1. Ethereal familiars (bit 11, player in youkai form) never contact
    //    (the all.c:21448 bit11==0 gate ahead of the contact block).
    // 2. Reimu's special skill (FUN_0042c290 @ all.c:21101): the Border
    //    Team and solo Reimu (DAT_0164d0b1 == 0/4) require
    //    FUN_0041fd20()==0 — i.e. familiars NEVER contact them; every
    //    other team takes familiar body contact while materialized.
    //    The vertical slice is Border Team only, so familiars never
    //    body-contact here.
    if (e.ecl.th08?.familiar) return;
    // FUN_0041ebc0 runs first at the live head, then at position-history
    // indices 1,7,13,... below. Each call performs graze before body hit.
    this.collideEnemyBodyAt(e, e.x, e.y, e.ecl.hitbox);

    // op138's +0x4f30/+0x4f34 history contract. FUN_0041ed50 samples every
    // sixth record starting at one, stopping before trailStart (all.c:
    // 14154-14171). Bit 1 tapers the hitbox against that same denominator.
    const s = e.ecl;
    if (s.trailFlags === 0 || s.trailStart <= 1) return;
    const limit = Math.min(s.trailStart, s.trailHistory.length);
    for (let i = 1; i < limit; i += 6) {
      const point = s.trailHistory[i];
      const scale = (s.trailFlags & 2) !== 0 ? 1 - i / s.trailStart : 1;
      this.collideEnemyBodyAt(e, point.x, point.y, {
        x: e.ecl.hitbox.x * scale,
        y: e.ecl.hitbox.y * scale,
        z: e.ecl.hitbox.z * scale
      });
    }
  }

  private collideEnemyBodyAt(
    e: Enemy,
    x: number,
    y: number,
    hitbox: { x: number; y: number; z: number }
  ): void {
    const p = this.playerObj;
    const px = p.x;
    const py = p.y;
    // Th07.exe FUN_0041ebc0: enemy bodies are grazable, region hitbox/1.4
    // (= *(1/0.7)/2), only when op136 armed +0x2e29 bit5 and the per-enemy
    // +0x2bcc clock advanced this manager pass to a multiple of six. The
    // +0x2bc4 comparison prevents repeat awards while slowmo holds a tick.
    const timer = Math.trunc(e.ecl.bossTimer);
    if (e.ecl.sweepItemFlag && timer !== (e.ecl.bossTimerPrevious ?? -999) && timer % 6 === 0 &&
        Math.abs(x - px) <= hitbox.x / 1.4 + p.grazeboxHalf + 20 &&
        Math.abs(y - py) <= hitbox.y / 1.4 + p.grazeboxHalf + 20) {
      this.onGrazeAward(x, y);
    }
    if (Math.abs(x - px) <= hitbox.x / 3 + p.hitboxHalf &&
        Math.abs(y - py) <= hitbox.y / 3 + p.hitboxHalf) {
      this.onPlayerContact?.('body');
      this.onPlayerHit(null, 'body');
    }
  }

  // Th07.exe FUN_0043bb30 (shared graze routine): +200 score, cherry/
  // cherryMax gain, and — while a spell card is up — the pending capture
  // bonus grows by 2500 + floor(cherry/1500)*20 (all.c:27969; the exe
  // accumulator DAT_012f40b0 is reset at each declare, so accumulating
  // only while a card is active is equivalent).
  private onGrazeAward(sourceX = this.playerObj.x, sourceY = this.playerObj.y): void {
    const p = this.playerObj;
    // Th07.exe (v1.00b) FUN_0043bb30 @ 0x43bc2f-0x43bc81: every graze
    // spawns generic effect id 8 at the midpoint between player and contact,
    // one white particle. DAT_00494fb0 maps id8 to FUN_004194d0, four raw
    // RNG draws per particle, so this cosmetic branch is
    // gameplay-stream-visible.
    this.spawnEffectParticles(
      8,
      (p.x + sourceX) / 2,
      (p.y + sourceY) / 2,
      1,
      0xffffffff
    );
    // FUN_0043bb30 @ 0x43bc81-8d: effect allocation precedes the
    // rank award; every bullet/laser/body graze contributes six points.
    this.adjustRank(6);
    // TH08 graze (FUN_0044a930): the award is FUN_004181f0(2000), doubling
    // to 4000 under the gauge-extreme condition (the exe's compare reads
    // FUN_00406da0 — PROBABLE mapping to the ±8000 extremes, flagged).
    // While any boss slot is registered, the graze also drops a time orb
    // (item type 10 -> time/state-5) at the contact — the native orb
    // income stream (all.c:36844-36862).
    const extreme = this.runState.gaugeIsExtremelyHuman() || this.runState.gaugeIsExtremelyYoukai();
    // FUN_0044a930 head: the displayed graze counter is +1, +2 past the
    // human tint (−2000), +3 past the human effects threshold (−8000).
    // Score/rank/time-orb awards stay per-event; only the counter steps.
    if (!this.bombActiveThisFrame) this.graze += this.runState.grazeCounterIncrement();
    this.traceReplayEvent?.({
      kind: 'graze', frame: this.frame,
      data: { x: sourceX, y: sourceY, total: this.graze }
    });
    // 0x44aa6d-0x44aa78: the +100 gauge push is conditional on the live
    // player FORM byte at player+5. Human-form grazes still award graze,
    // score, rank and effects, but leave the gauge alone; native Stage-2
    // f1238 is the concrete witness (form 0, gauge only takes fire drift).
    if (p.th08Form === 1) {
      this.runState.addYoukaiGauge(this.runState.gaugeGrazeDelta());
    }
    this.addScore(extreme ? 4000 : 2000);
    if (this.runtime.bossSlots.some((b) => b && !b.dead)) {
      this.spawnItem('time2', sourceX, sourceY, {});
    }
    this.playSfx(30); // graze: TH08 id 30
  }

  private onPlayerHit(sourceBullet: EnemyBullet | null, kind: 'bullet' | 'laser' | 'body' = 'bullet'): void {
    const p = this.playerObj;
    // An invulnerable player (spawn/bomb invuln, or already in the
    // deathbomb window) takes no hit outcome at all in the exe — in
    // particular a contact during invuln must NOT break the border.
    // (Breaking it before this check let one absorbed hit's invulnerability
    // frames chain-eat every subsequent border the instant it started.)
    if (!p.alive || p.invulnFrames > 0 || p.bombInvuln > 0) return;
    // Replay-divergence forensics: every committed hit records what struck
    // the player and, for bullets, its spawn provenance. Ring-capped.
    this.hitLog.push({
      frame: this.frame,
      stageFrame: this.stageFrame,
      kind,
      playerX: p.x,
      playerY: p.y,
      bullet: sourceBullet
        ? {
            ownerId: sourceBullet.ownerId,
            ownerSub: sourceBullet.ownerSub,
            spawnFrame: sourceBullet.spawnFrame,
            sprite: sourceBullet.sprite,
            spriteOffset: sourceBullet.spriteOffset,
            x: sourceBullet.x,
            y: sourceBullet.y,
            angle: sourceBullet.angle,
            speed: sourceBullet.speed,
            age: sourceBullet.age
          }
        : null
    });
    this.traceReplayEvent?.({
      kind: 'bullet-contact', frame: this.frame,
      enemyId: sourceBullet?.ownerId,
      sub: sourceBullet?.ownerSub,
      bulletSlot: sourceBullet?.poolSlot,
      data: {
        outcome: 'hit', contactKind: kind, playerX: p.x, playerY: p.y,
        bulletX: sourceBullet?.x ?? null, bulletY: sourceBullet?.y ?? null,
        angle: sourceBullet?.angle ?? null, speed: sourceBullet?.speed ?? null,
        age: sourceBullet?.age ?? null, spawnFrame: sourceBullet?.spawnFrame ?? null
      }
    });
    if (this.hitLog.length > 64) this.hitLog.shift();
    // Player::CalcKillboxCollision / CalcLaserCollision call
    // GameManager::RerollRng immediately before Die(): five ranged u32 values
    // followed by three ranged f32 values. They feed integrity-only fields in
    // retail, but still advance the shared gameplay RNG by sixteen raw u16s.
    for (let i = 0; i < 5; i++) this.rng.u32InRange(100000);
    for (let i = 0; i < 3; i++) this.rng.range(100000);
    const quota = TH08_STAGE_ORB_QUOTAS[this.stageNumber - 1]?.[this.difficulty] ?? 0;
    const result = p.hit({
      timeQuotaMet: this.runState.currentTimeOrbs >= quota,
      bossActive: this.runtime.bossSlots.some((boss) => boss && !boss.dead)
    });
    if (result === 'deathbomb-window') {
      // Player::Die (FUN_0044ab40) calls FUN_0044e140(0) as soon as the
      // contact commits state 2. That helper writes ONLY the live gauge
      // short (RunState+0x22), leaving its +0x20 display/copy field alone.
      // Native Stage-2 f677 therefore jumps -10000 -> 0 on the hit frame;
      // without this reset, the two f683 extreme-human time-item arms both
      // succeeded and advanced the gameplay RNG by eight u16 draws.
      this.runState.youkaiGauge = 0;
      // Player::Die walks the item pool on the contact tick. Ordinary and
      // already-homing items are detached immediately (state 0, vx 0,
      // vy -0.9); tossed state-3/5 items are left alone until their next
      // ItemManager pass, where the player-state branch converts them to the
      // -0.7 dead-player fall. Native Stage-2 f677/f678 makes this split
      // directly observable.
      for (const it of this.items) {
        if (it.state !== 0 && it.state !== 1) continue;
        it.state = 0;
        it.vx = 0;
        it.vy = Math.fround(-0.9);
      }
      // Player::Die (0x0043edc0) — the hit frame itself runs the whole death
      // entry: RegenerateGameIntegrityCsum, then both hit-effect groups (a
      // dedicated-slot flash type 0xc color 0xff4040ff and a 16-particle
      // white scattering burst type 6), then the death SE. The later miss
      // commit spawns nothing new.
      // GameManager::RegenerateGameIntegrityCsum (0x004012b0): two ranged
      // u32 draws feeding integrity-only fields — four raw u16s.
      this.rng.u32InRange(100000);
      this.rng.u32InRange(100000);
      // se_pldead00: TH07 id 4, TH08 id 2.
      this.playSfx(4); // player death: TH08 id 4 (pldead00), TH07 id 4
      this.spawnEffectParticles(12, p.x, p.y, 1, 0xff4040ff);
      this.spawnEffectParticles(6, p.x, p.y, 16, 0xffffffff);
    }
  }

  private updateEnemies(): void {
    this.tickRankSurvival();
    // FUN_0044d420 resets the position caches during the player pass; the
    // following priority-10 enemy scan republishes them for NEXT frame.
    // DAT_018b89b4 is different: it is a persistent Enemy* cleared by Ran's
    // callback or by the pointed enemy's inactive-slot branch.
    this.th08TargetPos = null;
    this.playerObj.th08LungeTarget = null;
    // FUN_0041ed50 processes authored timeline entries before scanning the
    // native 480-slot enemy pool (all.c:14016-14039). Timeline spawns are
    // therefore eligible later in this same pass.
    this.runtime.update(this);
    for (let slot = 0; slot < ENEMY_POOL_CAP; slot++) {
      // PASS-15 RESOLVED: the removal-path discriminator is the death mode,
      // pinned in the tickEnemyCore removal block below (FUN_0042bcf0's
      // 0x42be88 identity clear runs for dispatcher-end teardowns only;
      // mode-0 deaths and culls free the slot pointer-blind). This hook now
      // only serves mode-0 aliasing: a dead mode-0 occupant whose slot was
      // already reused adopts the replacement (the f2925 Sub4->Sub5 alias,
      // gx st2 census), and an empty slot retires the pointer (the scan-side
      // 0x42c88f inactive-slot clear). Retained corpses never reach it —
      // their teardown clears the pointer first, which is what keeps the
      // slot-1 fairy at f1546 from inheriting the midboss's lunge.
      // FUN_0042c660 clears DAT_018b89b4 when it reaches the pointed MEMORY
      // SLOT and finds its active bit gone. The native value is an Enemy*,
      // not an entity identity: if the allocator has already reused that
      // slot before the next scan, the pointer now aliases the replacement
      // and is deliberately retained. Stage-2 makes this combat-significant:
      // the pointer acquired from the x=96 Sub4 master later aliases its
      // slot-5 Sub5 replacement, so Ran pursues the replacement and her
      // focused needles kill the x=288 master at native f2925. Treating the
      // cache as a JS object reference left the old object dead, cleared the
      // pointer, and preserved the master's entire f2920 bullet family.
      // Earlier slots have already compared against the stale pointer, while
      // later slots may claim a genuinely empty cache — the order is also
      // observable at Stage-2 native f921-923.
      if (this.th08LungeEnemy?.dead && this.th08LungeEnemy.poolSlot === slot) {
        const replacement = this.enemySlots[slot];
        this.th08LungeEnemy = replacement && !replacement.dead ? replacement : null;
      }
      const e = this.enemySlots[slot];
      if (!e || e.dead) continue;
      // Th07.exe FUN_0041ed50 @ 0x41ef55-0x41ef8f: op161 bit3 is tested
      // before FUN_0040f6c0 and every other per-enemy manager phase. During
      // either a bomb (DAT_004ca4d8) or Supernatural Border
      // (player+0x2408), the enemy is wholly frozen for this pass except for
      // one reverse tick of its +0x2bc4 boss-timer triple. In particular it
      // publishes no homing target and absorbs no player shot this frame.
      // Native EnemyManager.cpp:767-773 + 1204-1206: during op161 + (bomb OR
      // playerState != PLAYER_STATE_ALIVE) the enemy is frozen and the boss/spell
      // timer is NET-ZERO — `timer--` at :771 then the shared `timer++` at :1206
      // ⇒ the spell timer FREEZES (not retreats). The engine's per-enemy advance
      // (tickEnemyManagerTail below) is skipped by this `continue`, so we simply
      // must not retreat either. Condition widened from bomb/border to also cover
      // miss/invuln/respawn — native `playerState != ALIVE` includes INVULNERABLE,
      // BORDER, DEAD, SPAWNING (紫's 「弾幕結界」 etc.).
      if (e.ecl.pauseDuringBombOrBorder &&
          (this.bombActiveThisFrame ||
           !this.playerObj.alive || this.playerObj.invulnFrames > 0)) {
        continue;
      }
      e.frame++;
      // FUN_0042bcf0's pointer clear fires only for dispatcher-end teardowns
      // (script end / ins_1 -> -1 return at 0x42c99d). An off-screen cull
      // frees the slot through a different, pointer-blind path — the st2
      // Sub4 master's cull must NOT clear it, or the f2925 slot-5 alias
      // (Ran pursuing the Sub5 replacement, census-pinned) breaks.
      let deathViaCull = false;
      let transitioned: boolean;
      do {
        this.runtime.tickEnemyCore(this, e);
        if (e.dead) break;
        // FUN_0042c180 clamps the op-75 rect on BOTH sides of the movement
        // integrator FUN_0042deb0 (all.c:21347-21349) — an armed enemy can
        // never render or collide outside its rect, no matter what the
        // interp/polar displacement computes mid-curve.
        this.runtime.applyTh08RectClamp(e);
        this.runtime.integrateEnemyPosition(e, this.slowRate);
        this.runtime.applyTh08RectClamp(e);
        this.tickSpellBonusDecay(e);
        this.updateEnemyTrailHistory(e);
        this.updateEnemyCull(e);
        if (e.dead) {
          deathViaCull = true;
          break;
        }
        transitioned = this.runtime.processEnemyCallbacks(this, e);
      } while (transitioned);
      if (e.dead) {
        if (this.enemySlots[slot] === e) {
          // Deaths inside tickEnemyCore (ins_1 self-deletes, offscreen culls)
          // bypass the killEnemy/settle chokepoints below, so release the
          // familiar marker VMs here — the slot null below ends the post-loop
          // sweep's ability to find this enemy (the 道中魔法阵残留 leak).
          this.releaseTh08EnemyVisuals(e);
          // FUN_0042bcf0 @ 0x42be88: the dispatcher-end teardown
          // identity-clears the Border option lunge pointer BEFORE the slot
          // can be reused (census-pinned at gx st2 f1544: the mode-1 midboss
          // tears down with the clear, so the slot-1 fairy entering f1546
          // never inherits it — native holds the fairy at hp10 until
          // f1570.5). Cull-path frees stay pointer-blind.
          if (!deathViaCull && this.th08LungeEnemy === e &&
              (((e.ecl.th08?.flags ?? 0) >> 20) & 7) !== 0) {
            this.th08LungeEnemy = null;
          }
          this.enemySlots[slot] = null;
          this.runtime.releaseEnemy(this, e);
        }
        continue;
      }
      // Regular ANM VM ticking occurs after cull/callbacks and before every
      // collision scan (all.c:14139-14147).
      this.runtime.updateEnemyAnm(e, this.slowRate);
      // FUN_0040f6c0 may have armed enemy+0x2e2b bit2 in this same core
      // tick for Extra/Phantasm spell ids >=118 while bombing. Native skips
      // the complete collision block in that state: no body contact, no
      // shot/attack absorption, no damage settlement and no homing target.
      let bombContactThisFrame = false;
      if (!e.ecl.bombCollisionSuppressed) {
        this.tickTh08FamiliarSync(e);
        this.collideEnemyBody(e);
        this.collidePlayerShots(e);
        this.publishTh08TargetCandidate(e);
        // FUN_0041ed50 keeps FUN_0043a980's local_18 bomb-contact flag
        // through damage settlement and passes it as FUN_00430970's spawn
        // mode when this same manager pass kills the enemy. Bomb-contact
        // drops therefore start homing immediately even when their power
        // type is converted to big Cherry at full power.
        bombContactThisFrame = this.settlePendingDamage(e);
      }
      // TH08 enemy+0x3328 bit 3 is latched at the head of the native death
      // switch (all.c:21620), then cleared once a retained callback restores
      // positive HP (all.c:21613-21616). That clear is what lets the next
      // nonspell/spell phase die normally instead of freezing at 0 HP.
      if (this.runtime.shouldSettleEnemyDeath(e)) {
        // LAB_0042d551 opens by decrementing the linked parent's +0x3380
        // attach ledger (all.c:21627-21630) — before the sweep, the gauge
        // delta and the death-mode switch. The sweep severs the parent link
        // of every child it processes, so only children dying through this
        // normal path reach the decrement.
        if (e.ecl.parent?.ecl.th08) e.ecl.parent.ecl.th08.attachCount--;
        // FUN_0042d551 calls FUN_0042adb0(1) before the form-side gauge delta
        // and before entering the death-mode
        // switch, whose mode-0/1/2 path then calls FUN_0042bea0 for the
        // master's ordinary drops (all.c:21631, 21647-21658). Reversing that
        // order consumes the same RNG count but assigns the stream to the
        // wrong items: Stage-2 Sub7's last six orbs per familiar and all five
        // master point drops consequently land at different coordinates.
        const sweptFamiliars = this.settleTh08FamiliarDeath(e);
        // The common form delta at 0x42d65c follows FUN_0042adb0. A master
        // sweep does not immediately free its children: each severed child
        // subsequently enters death mode 8 and pays the same +/-200 delta,
        // but its cleared parent link suppresses the direct-familiar gauge
        // pull and item tail. Native Stage-2 f1553 exposes +200 for the
        // master followed by +800 for its four swept Sub10 familiars.
        // The kill delta's sign byte is the RAW focus key (player+3), read
        // at 0x42d65c (`movzbl 0x17d5efb; test; jne` -> +200 else -200) —
        // NOT the form byte. Form follows focus only after the 8-frame
        // flip settle, so kills inside that window (youkai form, focus
        // released — e.g. gx st1 f2231's triple kill) flipped the sign,
        // drifting the gauge +1200 vs native, keeping it short of the
        // -8000 human-extreme threshold and silently disarming the
        // per-death bonus time orb (4 draws each) from f2235 on.
        const gaugeKillDelta = this.runState.gaugeKillDelta(this.playerObj.focusHeld);
        this.runState.addYoukaiGauge(gaugeKillDelta);
        const keep = this.runtime.killEnemy(this, e, bombContactThisFrame);
        // A swept familiar's own ±200 lands on its OWN manager pass later in
        // the same tick — AFTER the master's death tail, which hosts the
        // extreme-gauge orb gate (all.c:21705-21710). Batching the children's
        // deltas before killEnemy let the master read a post-cascade gauge:
        // gx st1 f2231's sweep (gauge −7681, two severed Sub10 familiars)
        // paid a phantom extreme orb (33 orbs/272 draws vs native 32/268);
        // native's check at −7881 skips it, then the children's −200s land.
        for (let i = 0; i < sweptFamiliars; i++) {
          this.runState.addYoukaiGauge(gaugeKillDelta);
        }
        if (!keep) e.dead = true;
      }
      this.runtime.tickEnemyManagerTail(this, e);
      if (e.dead && this.enemySlots[slot] === e) {
        // FUN_0042bcf0 @ 0x42be88: a retained corpse's ECL-script-end
        // teardown (dispatcher -1 -> 0x42c9ba) identity-clears the Border
        // option lunge pointer BEFORE its slot can be reused. A mode-0
        // death instead frees the slot through FUN_0042bea0, which has no
        // pointer write — there the pointer is retired only by the
        // scan-side inactive-slot check (0x42c88f) or aliased by a
        // same-pass slot reuse. The ins_129 mode bits are the
        // discriminator, exactly as the native jump table left them.
        // st2 wave mouth (census-pinned): the mode-1 midboss (sub7) tears
        // down f1544 with the pointer clear, so the slot-1 fairy entering
        // at f1546 must NOT inherit it (|395.5-player.x| >= 64 fails every
        // publish gate) and survives at hp10 until f1570.5.
        if (this.th08LungeEnemy === e && (((e.ecl.th08?.flags ?? 0) >> 20) & 7) !== 0) {
          this.th08LungeEnemy = null;
        }
        this.enemySlots[slot] = null;
        this.releaseTh08EnemyVisuals(e);
        this.runtime.releaseEnemy(this, e);
      }
    }
    this.playerObj.th08LungeTarget = this.th08LungeEnemy;
    for (const e of this.enemies) {
      if (!e.dead) continue;
      const slot = e.poolSlot;
      if (slot >= 0 && slot < ENEMY_POOL_CAP && this.enemySlots[slot] === e) {
        if (this.th08LungeEnemy === e && (((e.ecl.th08?.flags ?? 0) >> 20) & 7) !== 0) {
          this.th08LungeEnemy = null;
        }
        this.enemySlots[slot] = null;
        this.releaseTh08EnemyVisuals(e);
        this.runtime.releaseEnemy(this, e);
      }
    }
    this.compactLive(this.enemies);
  }

  // Native slot teardown (FUN_0042bcf0 -> FUN_0042a820, all.c:20203-20216)
  // destroys every effect VM a removed enemy owns — the familiar marker
  // (FUN_00425b70's etama-48 VM, armed with ttl Infinity by the familiar
  // sync) included, fading it out over <=15 manager ticks. Self-deleting
  // familiars (stage-1 Sub10/Sub12/Sub46 all end with ins_1) bypass the
  // damage-death settlement, so their markers must be released here at the
  // removal chokepoint — otherwise every timed-out familiar leaves an
  // immortal rune circle at its last position (the midboss 魔法阵残留 and
  // part of the boss-fight draw load). Instant cull; the native <=15-frame
  // destroy fade is the only difference.
  private releaseTh08EnemyVisuals(e: Enemy): void {
    const t8 = e.ecl.th08;
    if (!t8?.markerHandle) return;
    t8.markerHandle.release();
    t8.markerHandle = null;
    t8.markerActor = null;
  }

  private tickSpellBonusDecay(e: Enemy): void {
    // FUN_0041d050's spell block runs inside the main boss's enemy-manager
    // pass, after ECL execution/movement and before player-shot collision.
    // Thus an ECL op91 skips this tick, while a shot-killed card later in the
    // same pass includes it before endBossSpell banks the bonus.
    if (!e.ecl.isBoss || e.ecl.bossSlot !== 0) return;
    const sc = this.spellcard;
    if (!sc?.capturing) return;
    // Th07.exe FUN_0041d050 @ all.c:7328-7338: op135's enemy+0x2e2a
    // bit 6 suppresses the DAT_012f40ac decay write, while the shared spell
    // clock below keeps advancing. Yuyuko's final 反魂蝶 branch executes
    // op135(1) immediately after declaring spells 112-115, so their authored
    // base bonus remains frozen. Decaying spell 115 for its full 4081 ticks
    // under-awarded the native capture by 264,968 live score units.
    if (!e.ecl.spellTimeoutFlag) {
      // Native x87 order @ 0x4168c8-0x41690e is
      // ftol(base - decayPerSec * (elapsed + frac) / 60), followed by the
      // floor-to-10. Truncating the decay term before subtracting rounds the
      // opposite way and over-awards one live score unit on some captures.
      const elapsed = sc.elapsed + sc.elapsedFrac;
      const decayed = Math.trunc(
        sc.bonusAnchor - (sc.decayPerSec * (elapsed - sc.bonusAnchorElapsed)) / 60
      );
      sc.bonus = Math.max(0, decayed - (decayed % 10));
    }
    const rate = Math.fround(this.slowRate);
    if (rate > 0.99) {
      sc.elapsed++;
    } else {
      sc.elapsedFrac = Math.fround(sc.elapsedFrac + rate);
      if (sc.elapsedFrac >= 1) {
        sc.elapsed++;
        sc.elapsedFrac = Math.fround(sc.elapsedFrac - 1);
      }
    }
  }

  private updateEnemyTrailHistory(e: Enemy): void {
    const s = e.ecl;
    if (s.trailFlags === 0 || s.trailCount <= 0) return;
    // Th07.exe FUN_0041ed50 @ all.c:14075-14100: after the movement
    // integrator and before culling, shift the configured history toward
    // the oldest slot and write the current position at index zero. The
    // native enemy object has exactly 96 entries; op138 never clears them.
    const count = Math.min(96, s.trailCount, s.trailHistory.length);
    for (let i = count - 1; i > 0; i--) {
      const dst = s.trailHistory[i];
      const src = s.trailHistory[i - 1];
      dst.x = src.x;
      dst.y = src.y;
      dst.z = src.z;
    }
    const head = s.trailHistory[0];
    head.x = e.x;
    head.y = e.y;
    head.z = e.z;
  }

  private updateEnemyCull(e: Enemy): void {
    // ECL op132 writes enemy+0x2e29 bit 3. FUN_0041ed50 @ 0x41f30d
    // short-circuits the entire seen/off-screen cull while that bit is set;
    // invisible controller enemies such as Stage-1 Sub43 must therefore
    // retain their fixed slots even after their paths leave the playfield.
    if (e.ecl.invisible) return;
    // FUN_0041ed50 reads the ANM wrapper's current sprite pointer at +0x1e4,
    // not its render-visible result. Alpha-zero/hidden/waiting scripts still
    // participate in FUN_0042bdc7 culling as long as a sprite was selected;
    // only a genuinely null pointer skips the seen/offscreen latch.
    const size = e.ecl.anmRunner?.spriteSize();
    if (!size) return;
    const halfW = size.w / 2;
    const halfH = size.h / 2;
    const onscreenAt = (x: number, y: number): boolean =>
      x + halfW >= 0 && x - halfW <= 384 &&
      y + halfH >= 0 && y - halfH <= 448;
    const onscreen = onscreenAt(e.x, e.y);
    if (!e.ecl.seen) {
      if (onscreen) e.ecl.seen = true;
      return;
    }
    if (onscreen || e.ecl.offscreenCullExempt) return;
    // FUN_0041ed50 @ 0x41f363-0x41f45f: op138 trail actors are released
    // only after the head AND history[count-1] no longer overlap the field.
    // This preserves the fixed-slot lifetime that SakuyaA's native target
    // cache observes; culling the head alone permutes later enemy slots.
    const s = e.ecl;
    if (s.trailFlags !== 0 && s.trailCount > 0) {
      const oldest = s.trailHistory[Math.min(96, s.trailCount, s.trailHistory.length) - 1];
      if (oldest && onscreenAt(oldest.x, oldest.y)) return;
    }
    e.dead = true;
  }

  private updateBullets(): void {
    this.syncEnemyBulletSlots();
    // FUN_004241c0 @ 0x424203-0x4242ee: clear the counter, then increment it
    // once for every slot that is live on entry. Later frees in this manager
    // pass do not decrement it. Since enemies (priority 10) fire before the
    // bullet manager (priority 12), their next pass observes this exact
    // latched value even when the underlying fixed slots are already free.
    this.enemyBulletManagerEntryCount = this.enemyBulletSlots.reduce(
      (count, bullet) => count + (bullet && !bullet.dead ? 1 : 0), 0
    );
    const updateSlot = (slot: number): void => {
      const b = this.enemyBulletSlots[slot];
      if (!b || b.dead) return;
      if (b.clearFadeFrames != null) {
        // Native state 5 runs only its half-speed removal animation. It is
        // neither collidable nor cullable, but still counts as an occupied
        // fixed slot until the ANM removes it.
        b.clearRunner ??= this.runtime?.createBulletClearRunner(b.sprite) ?? undefined;
        b.x = Math.fround(b.x + b.vx / 2);
        b.y = Math.fround(b.y + b.vy / 2);
        b.clearRunner?.update(this.slowRate);
        b.age += this.slowRate;
        b.clearFadeFrames -= this.slowRate;
        if (b.clearFadeFrames <= 0) this.removeEnemyBullet(b);
        return;
      }
      const wasInSpawnState = (b.spawnAge ?? b.spawnDuration) < b.spawnDuration;
      // Native spawn states 2/3/4 skip behavior, cull, bomb and player
      // collision until their authored ANM ends. On the ending tick the
      // extra full-velocity move still runs; et_ex stays until the first
      // exclusive state-1 tick (TH08 jump table @ 0x432156).
      const motion = this.updateBulletMotion(b);
      const enteredNormalState = motion.enteredNormalState;
      // TH08 spawn-state quad probe (all.c:23589-23591/23615-23617/
      // 23638-23640): the state-specific creep move runs FIRST, then every
      // player clear quad is probed and latched at +0xdbe. Conversion waits
      // for the transition VM's ending tick. Previously only familiar-death
      // zones were sampled, before movement; type-3's field consequently
      // missed exactly the two spawn-state bullets in each native 4-bullet
      // cancellation group.
      if (wasInSpawnState && (b.flags & 0x1000) === 0) {
        // On the transition-ending tick the spawn-state probe precedes the
        // ordinary behavior/full-speed move. Keep using the creep-only
        // position surfaced by updateBulletMotion, not the final position.
        const probeX = motion.transitionX ?? b.x;
        const probeY = motion.transitionY ?? b.y;
        let quadLatched = false;
        for (const r of this.bombClearRegions) {
          if (r.framesLeft <= 0) continue;
          const dx = probeX - r.x;
          const dy = probeY - r.y;
          if (dx * dx + dy * dy < r.radius * r.radius) {
            b.quadKillType = 6;
            quadLatched = true;
            break;
          }
        }
        if (!quadLatched) for (const box of this.bombClearBoxes) {
          if (box.framesLeft > 0 && orientedBoxHitsPoint(
            probeX, probeY, box.x, box.y, box.width, box.height, box.angle
          )) {
            b.quadKillType = 6;
            quadLatched = true;
            break;
          }
        }
        if (!quadLatched) for (const z of this.th08DeathClearZones) {
          if (z.framesLeft <= 0) continue;
          const dx = probeX - z.x;
          const dy = probeY - z.y;
          if (dx * dx + dy * dy < z.radius * z.radius) {
            // FUN_00449ff0 walks the fixed quad pool in slot order and
            // returns at the first contact. Do not let a later overlapping
            // quad overwrite the latch: Stage-2 f2219 has six transition
            // bullets inside both a child type-9 and master type-7 zone;
            // native retains the earlier type 9 (four orbs per bullet over
            // deferred + normal settlement), while last-hit-wins lost six.
            b.quadKillType = z.convertType;
            break;
          }
        }
      }
      if (!enteredNormalState) return;
      if (!b.dead && wasInSpawnState && b.quadKillType != null) {
        // The transition VM completed with the quad-contact latch set. Native
        // pays this deferred item BEFORE jumping into the normal-state cull
        // block (0x431801..0x43187b -> 0x431306). This order is observable
        // outside the playfield: Stage-2 native f799 converts slot 32 at
        // x=-57.104, then the promoted bullet is culled; culling first loses
        // the pointStar and permanently shifts the fixed item-pool cursor.
        //
        // Native also writes state 5 here but unconditionally overwrites it
        // with state 1 at LAB_00431306. If a quad still overlaps after cull,
        // the normal collision block below pays and kills it a second time.
        // Stage-2 f736 is the clean witness: two state-2 bullets become four
        // type-6 items. Do not start the clear runner in this deferred arm.
        const t = b.quadKillType;
        b.quadKillType = null;
        const itemX = motion.transitionX ?? b.x;
        const itemY = motion.transitionY ?? b.y;
        this.th08PayQuadConversion(t, itemX, itemY);
      }
      // op-79 0x2000 grace ticks in normal state (exe FUN_004241c0
      // all.c:16144-16146), immediately before the full-speed position add.
      // updateBulletMotion performs that add, so preserve the same frame's
      // observable countdown here before cull/collision.
      if (b.graceFrames && b.graceFrames > 0) b.graceFrames--;
      // Exe cull, FUN_004241c0 @ all.c:16150-16195: a live grace count skips
      // the bounds test entirely (the bullet stays valid and collidable
      // off-screen); otherwise FUN_0042bdc7 runs BEFORE FUN_0043b350/b200
      // (bomb clear, graze, player hit) and keeps the bullet while its OWN
      // sprite rect overlaps the 384x448 field (constants @ 0x48eabc/eab8 —
      // no flat pixel margin). Off-screen, dir-change/bounce bullets (mask
      // 0xdc0) survive up to 128 consecutive frames (+0xbfe); anything else
      // dies once any leftover count drains. This order matters: Phantasm
      // slot 730 crosses the right edge on update 10470 and native frees it
      // without ever entering FUN_0043b040; clearing first retained the Web
      // slot in state 5 and shifted every volley allocated from frame 10472.
      if (!b.graceFrames) {
        const halfW = b.rect.w / 2;
        const halfH = b.rect.h / 2;
        const onscreen = b.x + halfW >= 0 && b.x - halfW <= 384 && b.y + halfH >= 0 && b.y - halfH <= 448;
        if (onscreen) {
          b.offscreenFrames = 0;
          this.enemyBulletOffscreenCounters[slot] = 0;
        } else if ((b.exFlags & 0xdc0) === 0) {
          if (b.offscreenFrames && b.offscreenFrames > 0) {
            b.offscreenFrames--;
            this.enemyBulletOffscreenCounters[slot] = b.offscreenFrames;
          }
          else b.dead = true;
        } else {
          b.offscreenFrames = (b.offscreenFrames ?? 0) + 1;
          this.enemyBulletOffscreenCounters[slot] = b.offscreenFrames;
          if (b.offscreenFrames >= 128) b.dead = true;
        }
      }
      if (!b.dead && this.cancelBulletWithBombSlots(b)) {
        // The transition tick already performed the normal full-speed move;
        // the common native tail advances age once before state 5 begins on
        // the following manager pass.
        b.age += this.slowRate;
        return;
      }
      if (!b.dead) this.checkEnemyBulletCollision(b);
      // FUN_004241c0 advances the normal-state split counter at the common
      // tail, after movement, cull and collision. On a spawn-ANM completion
      // tick the native reset survives to the next PRE state (age remains 0);
      // the first increment occurs on the following normal-entry tick.
      if (!b.dead && !wasInSpawnState) b.age += this.slowRate;
      if (b.dead && this.enemyBulletSlots[slot] === b) this.enemyBulletSlots[slot] = null;
    };
    // FUN_004241c0's pointer wrap is unusual but unambiguous: slot 0 first,
    // then 1023 down through 1 (all.c:16038-16049,16197-16203).
    updateSlot(0);
    for (let slot = ENEMY_BULLET_POOL_CAP - 1; slot >= 1; slot--) updateSlot(slot);
    this.compactLive(this.enemyBullets);
    // Advance the bomb clear-region blast after this frame's cancellations: the
    // expanding-circle consumer grows the radius by `growth` per frame and retires
    // the region once its lifetime lapses (native: 17 frames, r 32→160).
    for (const r of this.bombClearRegions) {
      if (r.framesLeft <= 0) continue;
      // FUN_0043d8f0 stores the radius back into the float32 pool entry on
      // every head-of-player-tick update, then marks the fixed slot free.
      r.radius = Math.fround(r.radius + r.growth);
      if (--r.framesLeft <= 0) r.framesLeft = 0;
    }
    for (const box of this.bombClearBoxes) {
      if (box.framesLeft > 0 && --box.framesLeft <= 0) box.framesLeft = 0;
    }
    for (let i = this.bombClearBoxes.length - 1; i >= 0; i--) {
      if (this.bombClearBoxes[i].framesLeft <= 0) this.bombClearBoxes.splice(i, 1);
    }
    // The Th08 death-clear quads age identically (the exe's pool update grows
    // param_4 per tick and frees the slot when param_5 lapses).
    for (const z of this.th08DeathClearZones) {
      if (z.framesLeft <= 0) continue;
      z.radius = Math.fround(z.radius + z.growth);
      if (--z.framesLeft <= 0) z.framesLeft = 0;
    }
  }

  // Per-frame bullet ex-behaviors, matching Th07.exe FUN_004241c0 @ 0x4241c0.
  // Each activated behavior bit in b.exFlags (exe +0xbf4, promoted by
  // FUN_004229f0 — see advanceBulletExBehavior) runs as an INDEPENDENT
  // if in the order 0x1, 0x10, 0x20, 0x40/0x100/0x80, 0xc00, then velocity is
  // added to position ONCE. Every behavior reads only its OWN op-79 slot's
  // resolved params and clears its own bit when finished.
  private updateBulletMotion(b: EnemyBullet): {
    enteredNormalState: boolean;
    transitionX?: number;
    transitionY?: number;
  } {
    const rate = this.slowRate;
    const rateF32 = Math.fround(rate);
    // Test/dev-created bullets predating the fixed queue contract are still
    // accepted; retail bullets initialize every field in FUN_00421e90.
    b.exRampElapsed ??= 0;
    b.exRampFrac ??= 0;
    b.exAccelElapsed ??= 0;
    b.exAccelFrac ??= 0;
    b.exAngleElapsed ??= 0;
    b.exAngleFrac ??= 0;
    b.exDirElapsed ??= 0;
    b.exDirFrac ??= 0;
    b.dirTimes ??= 0;
    b.exBounceTimes ??= 0;
    let transitionX: number | undefined;
    let transitionY: number | undefined;
    const spawnAge = b.spawnAge ?? b.spawnDuration;
    // TH08 OnUpdate (0x431240) dispatches spawn through a jump table at
    // 0x432156 (state 2→0x43176e, 3→0x431880, 4→0x431991). Capture the
    // spawn-state entry BEFORE the ending tick promotes spawnAge: the ending
    // tick still performs the fractional move above, then falls through to
    // the full state-1 body (extra full-velocity move AND et_ex) below.
    const startedInSpawn = spawnAge < b.spawnDuration;
    // FUN_004069f0 executes the prototype VM's t0 synchronously at arm. The
    // native slot trace resolves the old +2 fixture workaround: a time-10
    // flash returns after nine creep-only manager ticks, then its tenth tick
    // performs the fractional move, reports remove, and falls through to the
    // full move (Stage-2 replay slots 14/15, native f655..664). At 1/3 rate a
    // time-24 flash likewise ends on wall tick 70, not 72.
    if (startedInSpawn) {
      // Enemy-bullet storage is float32. FUN_004241c0 performs its spawn-
      // state multiply/add on x87, then writes the result back to the slot's
      // f32 position fields every manager tick. Keeping JS doubles here
      // accumulated a 0.006px drift over long slowmo fields and moved native
      // graze boundaries by one frame (Stage 5 slot 738 @ PRE7774).
      b.x = Math.fround(b.x + b.vx * b.spawnMoveScale);
      b.y = Math.fround(b.y + b.vy * b.spawnMoveScale);
      // The authored spawn ANM uses the engine's integer/fraction split
      // clock, but its copied VM begins at logical frame 1. Native state 2
      // performs the half-move and tests `(intFrame + 1)` against the
      // time-24 remove instruction BEFORE advancing the pair (Stage-5 slot
      // 449 direct trace, processing 11132). This is 24 wall ticks at rate
      // 1 and 70 wall ticks at rate 1/3, not 72.
      b.spawnAgeFrac ??= 0;
      // The ending tick still performs the spawn-state fractional move above,
      // then immediately falls through to the normal full-velocity move.
      const spawnEnded = spawnAge + 1 >= b.spawnDuration;
      if (!spawnEnded) {
        if (rate > 0.99) {
          b.spawnAge = spawnAge + 1;
        } else {
          b.spawnAge = spawnAge;
          b.spawnAgeFrac += rate;
          if (b.spawnAgeFrac >= 1) {
            b.spawnAge++;
            b.spawnAgeFrac -= 1;
          }
        }
        return { enteredNormalState: false };
      }
      // State 2/3/4 probes the player quad and settles a latched conversion
      // at this creep-only position before LAB_00431306 (0x431106) promotes
      // the bullet to state 1 and falls through into the complete case-1
      // body — extra full-velocity move AND the et_ex dispatch — this tick.
      transitionX = b.x;
      transitionY = b.y;
      // The exe's spawn cases (jump table @ 0x432156) end with `movw $1,
      // slot+0xdb8` at 0x431106 then jump straight into the case-1 body at
      // 0x43110c+ (FUN_004065f0 timer reset, FUN_0042ffc0 queue pass, et_ex
      // handlers, full-velocity integrate, collision, ANM tick) — one
      // machine-code-verified fallthrough, not an early return.
      b.spawnAge = b.spawnDuration;
      b.spawnAgeFrac = 0;
      b.age = 0;
    }
    // Constructor promotion happens in FUN_00421e90. Every normal-state
    // manager tick performs exactly one further queue pass BEFORE executing
    // active behavior routines (FUN_004241c0 @ all.c:16120). TH08's 0x20000
    // wait gate ORs into +0xdac; FUN_0042ffc0 still runs (and stalls on the
    // next cond==0 slot) while the +0xdac handler ticks the timer and XOR-
    // clears the bit when it elapses (all.c:23507-23514). Skipping the
    // queue pass while the timer ran hid cond==1 commands that native
    // would still promote. The spawn-state ENDING tick runs this block
    // too: the exe's case-2/3/4 VM-finished path writes state=1 at
    // 0x431106 then falls through into the complete case-1 body
    // (0x431122 = FUN_0042ffc0, then the 0xdac et_ex dispatch) on the
    // SAME tick. Spawn states 2/3/4 themselves never enter this block.
    advanceBulletExBehavior(b, rate, this.th08BulletExHost);
    if ((b.exFlags & 0x20000) !== 0) {
      // Native handler order (all.c:23507-23514): FUN_0040e390 checks
      // remaining <= 0 FIRST — the clear tick burns no decrement — and the
      // walk earlier in that same tick still saw the bit set and stalled.
      // The bit therefore lives exactly arg3+1 handler passes after the arm;
      // decrement-then-check cleared it one pass early.
      if ((b.exWaitFrames ?? 0) <= 0) {
        b.exFlags ^= 0x20000;
      } else {
        b.exWaitFrames = (b.exWaitFrames ?? 0) - 1;
      }
    }
    if (b.clearFadeFrames != null && !b.clearRunner) {
      b.clearRunner = this.runtime?.createBulletClearRunner(b.sprite) ?? undefined;
    }
    if (b.exFlags & 1) {
      // speed-ramp (FUN_00423840): velocity = polar(angle, speed + 5·decay)
      // for 17 frames; then just clears the bit. Never writes the speed
      // scalar, so it composes cleanly with accel/angle-change.
      const elapsed = b.exRampElapsed + b.exRampFrac;
      if (b.exRampElapsed < 17) {
        // FUN_00423840 stores the ramp result and the rate-scaled speed
        // argument as float32 before FUN_004074e0 writes float32 velocity.
        const extra = Math.fround(5 - (elapsed * 5) / 16);
        const scaledSpeed = Math.fround(
          Math.fround(Math.fround(b.speed) + extra) * rateF32
        );
        b.vx = Math.fround(Math.cos(Math.fround(b.angle)) * scaledSpeed);
        b.vy = Math.fround(Math.sin(Math.fround(b.angle)) * scaledSpeed);
      } else {
        b.exFlags &= ~1;
      }
      b.exRampFrac += rate;
      while (b.exRampFrac >= 1) {
        b.exRampFrac -= 1;
        b.exRampElapsed++;
      }
    }
    if ((b.exFlags & 0x10) && b.exAccel) {
      // accel (FUN_00423910): add a fixed accel vector to velocity and
      // recompute the heading. Does NOT touch the speed scalar (the exe
      // doesn't — writing hypot() here would feed the speed-ramp into a
      // runaway loop = the "supersonic" bug). Runs while age < limit.
      const ac = b.exAccel;
      if (b.exAccelElapsed >= ac.limit) b.exFlags &= ~0x10;
      else {
        // FUN_00423910 consumes the promotion-time f32 vector at +0xccc,
        // multiplies each component by the current f32 rate into an f32
        // local, and fstp-stores each velocity component after the add.
        // Re-evaluating cos/sin here and retaining JS doubles made a
        // 518-frame Phantasm bullet drift 0.009px before Bomb cancellation.
        const accelX = Math.fround(rateF32 * Math.fround(ac.vx));
        const accelY = Math.fround(rateF32 * Math.fround(ac.vy));
        b.vx = Math.fround(accelX + Math.fround(b.vx));
        b.vy = Math.fround(accelY + Math.fround(b.vy));
        if (!(Math.abs(b.vx) <= NATIVE_VELOCITY_EPSILON_F32 &&
              Math.abs(b.vy) <= NATIVE_VELOCITY_EPSILON_F32)) {
          b.angle = Math.fround(Math.atan2(Math.fround(b.vy), Math.fround(b.vx)));
        }
      }
      b.exAccelFrac += rate;
      while (b.exAccelFrac >= 1) {
        b.exAccelFrac -= 1;
        b.exAccelElapsed++;
      }
    }
    if ((b.exFlags & 0x20) && b.exAngle) {
      // angle-change (FUN_00423a80 @ 0x423a80): angle += rate*angleDelta,
      // speed += rate*speedDelta, velocity = polar(angle, rate*speed). Both
      // deltas are rate-scaled in the exe. Runs while the DEDICATED elapsed
      // counter (exe bullet+0xcec, reset at install — not bullet age; effect
      // id 1 installs this behavior mid-life) is below the duration; the
      // counter advances fractionally under slowmo (FUN_00436acc).
      const an = b.exAngle;
      const elapsed = b.exAngleElapsed;
      if (elapsed >= an.limit) b.exFlags &= ~0x20;
      else {
        // FUN_00423a80 stores angle and speed back to their f32 bullet
        // fields before passing an independently f32-staged speed*rate to
        // FUN_004074e0.
        const angleStep = Math.fround(rateF32 * Math.fround(an.angleDelta));
        b.angle = normalizeNativeAngleF32(b.angle, angleStep);
        const speedStep = Math.fround(rateF32 * Math.fround(an.speedDelta));
        b.speed = Math.fround(speedStep + Math.fround(b.speed));
        const scaledSpeed = Math.fround(rateF32 * Math.fround(b.speed));
        b.vx = Math.fround(Math.cos(Math.fround(b.angle)) * scaledSpeed);
        b.vy = Math.fround(Math.sin(Math.fround(b.angle)) * scaledSpeed);
      }
      b.exAngleFrac += rate;
      while (b.exAngleFrac >= 1) {
        b.exAngleFrac -= 1;
        b.exAngleElapsed++;
      }
    }
    // TH08 et_ex dir-change mapping is machine-code-pinned: bit 0x40 →
    // FUN_00432460 does `flds 0xd74; fadds 0x1014; fstps 0xd74` = RELATIVE
    // `angle += f0` (0x4322ef-0x4322fe), while bit 0x100 → FUN_004325a0
    // STORES f0 to 0xd74 = ABSOLUTE set (0x43237f+). Bit 0x80 stays aimed.
    // An earlier pass inverted 0x40/0x100 ("0x40 is SET") on the theory that
    // Wriggle Sub16's rain needed absolute headings — the rotation IS the
    // authored pattern (fireflies kick ±π/2 per interval while their speed
    // sawtooths f1→0, FUN_00432460's waiting branch `f1·(1−t/interval)`).
    // Each family clears its OWN flag bit at the maxTimes fire.
    if ((b.exFlags & 0x40) && b.exDir) this.dirChangeBullet(b, 'relative', 0x40);
    if ((b.exFlags & 0x100) && b.exDir) this.dirChangeBullet(b, 'absolute', 0x100);
    if ((b.exFlags & 0x80) && b.exDir) this.dirChangeBullet(b, 'aimed', 0x80);
    if ((b.exFlags & 0xc00) && b.exBounce) this.bounceBullet(b, (b.exFlags & 0x400) !== 0);
    // Default bullet integration is the same f32 store-back (`pos += vel`)
    // at all.c:16147-16149. Math.fround is therefore state semantics, not a
    // rendering approximation. The spawn-end fallthrough takes this extra
    // full-velocity add on its ending tick (pacing tick-10 pin).
    b.x = Math.fround(b.x + b.vx);
    b.y = Math.fround(b.y + b.vy);
    return { enteredNormalState: true, transitionX, transitionY };
  }

  private dirChangeBullet(
    b: EnemyBullet,
    mode: 'relative' | 'absolute' | 'aimed',
    flagBit: number
  ): void {
    const d = b.exDir!;
    const interval = Math.max(1, d.interval | 0);
    const maxTimes = Math.max(1, d.maxTimes | 0);
    const times = b.dirTimes;
    const elapsed = b.exDirElapsed + b.exDirFrac;
    const rateF32 = Math.fround(this.slowRate);
    let speed: number;
    if (b.exDirElapsed >= interval) {
      b.dirTimes = times + 1;
      if (b.dirTimes >= maxTimes) {
        b.exFlags &= ~flagBit;
      }
      // Native BulletManager.cpp:763 (relative) is a plain f32 `angle += d.angle`
      // with NO wrap — the heading accumulates unbounded (matching the f32 LHS
      // store-back). :780 (absolute) assigns d.angle. :827 (aimed) is
      // AddNormalizeAngle(AngleToPlayer, d.angle), where AngleToPlayer returns +π/2
      // for the zero vector (not atan2's 0).
      if (mode === 'relative') {
        b.angle = Math.fround(Math.fround(b.angle) + Math.fround(d.angle));
      } else if (mode === 'absolute') {
        b.angle = Math.fround(d.angle);
      } else {
        // FUN_004326e0 (0x80 aimed) calls FUN_0044c1b0(bullet+0xd44):
        // atan2(py - by, px - bx) with EXTENDED-precision differences (the
        // x87 subtract of two f32s never rounds before the fpatan), one
        // f32 store, then FUN_0043edb0's wrap-add. Pre-narrowing dx/dy
        // through f32 double-rounds the aim of every aimed dir-change.
        const dx = this.player.x - b.x;
        const dy = this.player.y - b.y;
        const aim = dx === 0 && dy === 0
          ? Math.fround(Math.PI / 2)
          : Math.fround(Math.atan2(dy, dx));
        b.angle = normalizeNativeAngleF32(aim, Math.fround(d.angle));
      }
      b.speed = d.newSpeed;
      speed = b.speed;
      b.exDirElapsed = 0;
      b.exDirFrac = 0;
    } else {
      speed = Math.fround(b.speed - (elapsed * b.speed) / interval);
    }
    // FUN_004286e0 AngleToVector: FSINCOS produces extended-precision cos/sin,
    // multiplied by the (extended-promoted) speed, then fstp narrows the final
    // product to f32. The earlier code over-narrowed cos/sin to f32 before the
    // multiply — eclvm.ts:2720-2721 (the spawn-time path) already omits that
    // inner Math.fround. Keeping it here introduced systematic per-tick drift
    // on every direction-changed bullet (misread of "f32-staged" — the staging
    // applies to the PRODUCT, not the trig operands).
    const scaledSpeed = Math.fround(Math.fround(speed) * rateF32);
    b.vx = Math.fround(Math.cos(b.angle) * scaledSpeed);
    b.vy = Math.fround(Math.sin(b.angle) * scaledSpeed);
    b.exDirFrac += this.slowRate;
    while (b.exDirFrac >= 1) {
      b.exDirFrac -= 1;
      b.exDirElapsed++;
    }
  }

  private bounceBullet(b: EnemyBullet, includeBottom: boolean): void {
    // Native UpdateBulletBounce (BulletManager.cpp:846-852) gates the whole
    // branch on GameManager::IsInBounds(pos, sprite widthPx/heightPx) == 0
    // (GameManager.cpp:92-110): the bullet's own sprite HALF-extents against
    // all four field edges — the same rect test the offscreen cull runs —
    // not the center point. A bounce now fires half a sprite earlier, and
    // the bottom edge participates regardless of the 0x400 includeBottom
    // flag (that flag only arms the bottom REFLECTION below).
    const halfW = b.rect.w / 2;
    const halfH = b.rect.h / 2;
    if (b.x + halfW >= 0 && b.x - halfW <= 384 && b.y + halfH >= 0 && b.y - halfH <= 448) return;
    const bo = b.exBounce!;
    const maxTimes = Math.max(1, bo.maxTimes | 0);
    // The reflection axes still test the CENTER (BulletManager.cpp:857-866).
    // The x flip is angle = AddNormalizeAngle(-angle - ZUN_PI, 0) in f32;
    // the y flip is a plain negation store. Even with no axis firing, the
    // velocity re-arm and counter below still run (native fallthrough).
    if (b.x < 0 || b.x >= 384) b.angle = normalizeNativeAngleF32(-b.angle, -NATIVE_PI_F32);
    if (b.y < 0 || (includeBottom && b.y >= 448)) b.angle = Math.fround(-b.angle);
    b.speed = bo.speed;
    // Native BulletManager.cpp:870-871 AngleToVector(&velocity, angle,
    // speed * effectiveFramerateMultiplier): same FUN_004286e0 chain as
    // dirChangeBullet — FSINCOS in extended, multiply in extended, fstp to f32.
    const scaledSpeed = Math.fround(Math.fround(b.speed) * Math.fround(this.slowRate));
    b.vx = Math.fround(Math.cos(b.angle) * scaledSpeed);
    b.vy = Math.fround(Math.sin(b.angle) * scaledSpeed);
    b.exBounceTimes++;
    if (b.exBounceTimes >= maxTimes) b.exFlags &= ~0xc00;
  }

  // Additive two-pass beam: a soft colored outer quad at displayWidth plus
  // a bright core. Color indexes the standard 16-hue ZUN bullet palette
  // (ground truth uses 2/4/6/8/10). The telegraph (grow) line renders from
  // frame 0 — only the HIT test waits for telegraphDelay; a shrinking beam
  // stops drawing at shrinkCutoff like the exe.
  private static readonly LASER_COLORS = [
    '#888888', '#663333', '#ff3333', '#cc44cc', '#8844ff', '#4444ff', '#44aaff', '#44ffff',
    '#44ff88', '#44cc44', '#aaff44', '#ffff44', '#ffcc44', '#ff8844', '#cccccc', '#ffffff'
  ];

  // The player body sprite (Th07.exe FUN_0043eff0 @ 0x43f033-0x43f089), drawn
  // in every lifecycle state except game-over. It renders UNDER the danmaku
  // (enemy bullet/laser) layer — only the focus hitbox indicator is drawn on
  // top of the bullets so it stays visible.
  private drawPlayerSprite(r: Renderer, ox: number, oy: number): void {
    const p = this.playerObj;
    if (!(p.alive || p.hitState || p.materializeFrame >= 0 || p.dyingFrame >= 0)) return;
    const pf = p.runner.spriteFrame();
    const dt = p.dyingTransform();
    const mt = p.materializeTransform();
    if (dt) {
      // Death squish (exe state 2): in-place scaleX 1->0, scaleY 1->4.
      r.drawAnmFrame(pf, ox + p.x, oy + p.y, dt);
    } else if (mt) {
      // Respawn materialize (exe state 1): in-place scale/alpha ramp.
      r.drawAnmFrame(pf, ox + p.x, oy + p.y, mt);
    } else {
      // Spawn/respawn invuln (exe state 3): dark-tint 0x404040 on frames where
      // (timer & 7) < 2 (fcn.0043e2e0), instead of an invisibility blink.
      const dim = p.invulnFrames > 0 && (p.invulnFrames & 7) < 2;
      r.drawAnmFrame(pf, ox + p.x, oy + p.y, dim ? { color: 0x404040 } : {});
    }
    // TH08 Border Team familiar (the ghostly Yukari, player00.anm script 18)
    // floats at the focused option anchor — a separate ANM VM drawn above the
    // main sprite (exe FUN_0044e9e0 → FUN_00463210).
    if (p.th08OptionLive && p.th08OptionRunner) {
      const ff = p.th08OptionRunner.spriteFrame();
      if (ff) r.drawAnmFrame(ff, ox + p.th08OptionX, oy + p.th08OptionY, {});
    }
  }

  private drawLasers(r: Renderer, ox: number, oy: number): void {
    const ctx = r.ctx;
    for (const l of this.enemyLasers) {
      // Exe render (FUN_004253b0, all.c:16375-16420): the beam body draws
      // for every ALLOCATED slot, through the whole shrink — shrinkCutoff is
      // a COLLISION-only gate (all.c:16301-16303). Cutting the draw at
      // shrinkCutoff made long shrink tails (e.g. Prismriver shrink 200-300,
      // cutoff 16) vanish abruptly (LASER-001).
      if (!l.inUse) continue;
      const len = l.farDist - l.nearDist;
      if (len <= 0 || l.displayWidth <= 0) continue;
      const color = StageScene.LASER_COLORS[((l.color % 16) + 16) % 16];
      ctx.save();
      ctx.translate(ox + l.x, oy + l.y);
      ctx.rotate(l.angle);
      ctx.globalCompositeOperation = 'lighter';
      const w = l.displayWidth;
      ctx.globalAlpha = l.state === 0 ? 0.55 : 0.4;
      ctx.fillStyle = color;
      ctx.fillRect(l.nearDist, -w / 2, len, w);
      ctx.globalAlpha = l.state === 0 ? 0.7 : 0.95;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(l.nearDist, -w * 0.18, len, w * 0.36);
      // Tip glow at the origin, per the exe render gate (suppressed during
      // grow when op156 armed hideTipDuringGrow).
      if ((l.nearDist < 16 || l.speed === 0) && (!l.hideTipDuringGrow || l.state !== 0)) {
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(l.nearDist, 0, Math.max(3, w * 0.7), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // Th07.exe laser updater FUN_004241c0 (all.c:16205-16321), per
  // spec-lasers.md §3/§7.4: farDist auto-grows by speed, nearDist trails
  // by maxLength; state 0 GROW ramps displayWidth 1.2->width over
  // growDuration (hit-testable only after telegraphDelay), state 1 HOLD
  // runs holdDuration frames at full width (the ONLY state whose kill box
  // spans the beam's length), then the shared shrink body ramps width back
  // to 0 over shrinkDuration (drawn/hit only while phaseFrame <
  // shrinkCutoff); nearDist >= 640 or the shrink finishing frees the slot.
  private updateLasers(): void {
    const lrate = this.slowRate;
    for (const l of this.enemyLasers) {
      if (!l.inUse) continue;
      let retired = false;
      let transitionedFromGrow = false;
      // exe FUN_004241c0: farDist growth is rate-scaled; the phase clock is
      // a split counter at the same rate (spec-slowmo.md §3.1/§3.2).
      l.farDist += l.speed * lrate;
      if (l.farDist - l.nearDist > l.maxLength) l.nearDist = l.farDist - l.maxLength;
      if (l.nearDist < 0) l.nearDist = 0;
      if (l.state === 0) {
        if ((l.flags & 1) === 0) {
          // Exe grow ramp (all.c:16223-16241): the telegraph stays a FLAT
          // 1.2px hairline until the last min(growDuration,30) frames, then
          // jumps onto the growDuration-normalized ramp
          // (phaseFrame+frac)*width/growDuration. The old smooth full-phase
          // ramp drew (and hit-tested, via displayWidth) up to ~3x too wide
          // mid-telegraph on long grows (LASER-001).
          const rampWindow = Math.min(l.growDuration, 30);
          l.displayWidth = l.growDuration - rampWindow < l.phaseFrame
            ? Math.min(l.width, ((l.phaseFrame + (l.phaseFrac ?? 0)) * l.width) / Math.max(1, l.growDuration))
            : 1.2;
        }
        // FUN_004241c0 performs player collision inside each fixed laser
        // slot, before the phase counter is advanced at the common tail
        // (all.c:16258-16315). A separate post-update collision pass tests
        // phase N+1 and loses every 12-frame graze boundary; Stage-3 native
        // slot 1 at PRE4504 is phase 12 and consumes id8's four RNG draws,
        // while the old ordering first advanced it to 13.
        this.resolveLaserCollision(l);
        if (l.phaseFrame >= l.growDuration) {
          l.state = 1;
          l.phaseFrame = 0;
          l.phaseFrac = 0;
          l.displayWidth = l.width;
          transitionedFromGrow = true;
        }
        // Native jumps into HOLD with the state byte/phase already updated,
        // but FUN_004241c0 keeps the grow branch's stack-local collision box
        // for this second call (all.c:16221-16274). Recomputing from state=1
        // expands it to the whole beam and produced two false Stage-6 grazes
        // at processing 25206.
        if (transitionedFromGrow) this.resolveLaserCollision(l, 0);
      }
      // Native grow completion jumps directly into the HOLD label in this
      // same manager pass. The transition call above owns its stale grow
      // geometry; ordinary HOLD frames enter here directly.
      if (l.state === 1 && !transitionedFromGrow) {
        l.displayWidth = l.width;
        this.resolveLaserCollision(l);
        if (l.phaseFrame >= l.holdDuration) {
          l.state = 2;
          l.phaseFrame = 0;
          l.phaseFrac = 0;
          if (l.shrinkDuration === 0) {
            l.inUse = false;
            retired = true;
          }
        }
      }
      // HOLD completion likewise falls through to phase-0 SHRINK collision
      // before the shared phase tick. Unlike GROW -> HOLD, the native branch
      // recomputes the shrinking midpoint box before this call.
      if (!retired && l.state === 2) {
        if ((l.flags & 1) === 0) {
          l.displayWidth = Math.max(0, l.width - (l.phaseFrame * l.width) / Math.max(1, l.shrinkDuration));
        }
        this.resolveLaserCollision(l);
        if (l.phaseFrame >= l.shrinkDuration) {
          l.inUse = false;
          retired = true;
        }
      }
      if (retired) continue;
      if (l.nearDist >= 640) l.inUse = false;
      if (lrate > 0.99) {
        l.phaseFrame++;
      } else {
        l.phaseFrac = (l.phaseFrac ?? 0) + lrate;
        if (l.phaseFrac >= 1) {
          l.phaseFrame++;
          l.phaseFrac -= 1;
        }
      }
    }
    // Compact the pool once nothing references dead entries (the per-enemy
    // handle tables hold object references, so splicing is safe).
    if (this.enemyLasers.length > 96) {
      let w = 0;
      for (const l of this.enemyLasers) if (l.inUse) this.enemyLasers[w++] = l;
      this.enemyLasers.length = w;
    }
  }

  private resolveLaserCollision(l: EnemyLaser, geometryState = l.state): void {
    const result = this.checkLaserCollision(l, geometryState);
    if (result === 'hit') {
      this.onPlayerContact?.('laser');
      this.onPlayerHit(null, 'laser');
    }
    else if (result === 'graze') this.onGrazeAward();
  }

  // Player-vs-laser test, exe FUN_0043b650 (all.c:27867-27925) via
  // spec-lasers.md §7: rotate (player - anchor) by -angle into the beam's
  // local frame, then AABB the player hitbox against a box whose along-
  // axis extent is state-dependent (§7.4) — full length only during HOLD,
  // a width-sized nub around the midpoint during grow/shrink. Graze pads
  // the box by a flat 48 (DAT_0048eb94).
  private checkLaserCollision(l: EnemyLaser, geometryState = l.state): 'miss' | 'graze' | 'hit' {
    // Player::CalcLaserHitbox (Player.cpp:1107-1173) returns 0 (no hit, no graze,
    // no border break) whenever playerState != PLAYER_STATE_ALIVE. In engine terms
    // that is !alive (deathbomb window / death squish / respawn materialize); the
    // 240f invuln window is alive and is still gated below via onPlayerHit.
    if (!this.playerObj.alive) return 'miss';
    const inGrow = l.state === 0;
    if (inGrow && l.phaseFrame < l.telegraphDelay) return 'miss';
    if (l.state === 2 && l.phaseFrame >= l.shrinkCutoff) return 'miss';
    const p = this.playerObj;
    const dx = p.x - l.x;
    const dy = p.y - l.y;
    // FUN_00430070 uses outX = sin(a)*dy + cos(a)*dx and
    // outY = cos(a)*dy - sin(a)*dx. Feeding -a here mirrors every angled
    // beam across its anchor; axis-aligned tests hid the error. The native
    // Stage-3 slot-1 graze at processing 4504 is the boundary witness.
    const sin = Math.sin(l.angle);
    const cos = Math.cos(l.angle);
    const along = sin * dy + cos * dx;
    const perp = cos * dy - sin * dx;
    const phw = p.hitboxHalf;
    const midDist = (l.farDist - l.nearDist) / 2 + l.nearDist;
    const extX = geometryState === 1 ? l.farDist - l.nearDist : l.displayWidth / 2;
    const extY = l.width / 2;
    const sepX = Math.abs(along - midDist) - (extX / 2 + phw);
    const sepY = Math.abs(perp) - (extY / 2 + phw);
    if (sepX <= 0 && sepY <= 0) return 'hit';
    // Graze ticks every 12 frames (the exe passes phaseFrame % 12 == 0 as
    // the tick flag at all three call sites), box padded a flat 48.
    if (l.phaseFrame % 12 !== 0) return 'miss';
    const g = 48;
    if (sepX <= g && sepY <= g) return 'graze';
    return 'miss';
  }

  private updateItems(): void {
    if (this.traceReplayEvent && this.traceItemTick) {
      for (const it of this.items) {
        this.traceReplayEvent({
          kind: 'item-tick', frame: this.frame,
          data: {
            slot: it.poolSlot, type: it.type, state: it.state,
            x: it.x, y: it.y, vx: it.vx, vy: it.vy, age: it.age,
            px: this.playerObj.x, py: this.playerObj.y
          }
        });
      }
    }
    const p = this.playerObj;
    const sht = p.sht;
    if (this.th08ItemRunners) {
      // The per-type item VMs tick once per frame (the stage-1 scripts only
      // run deterministic color/alpha interps).
      for (const runner of this.th08ItemRunners) runner?.update(this.slowRate);
    }
    // On success the item's state byte (+0x27f) is permanently latched to 1.
    // ItemManager::OnUpdate re-reads currentPower / focus LIVE for every
    // item: a power pickup that crosses 128 inside this very pass
    // immediately latches the LATER slots of the same pass. Hoisting the
    // predicate froze it at the frame-entry power and made full-power
    // conversions start homing one frame late (th7_udMt01 st6 collect#1,
    // oracle rf919 vs web rf920).
    // Native ItemManager.cpp:195 has NO playerState gate on the PoC
    // predicate: items keep homing during the death/respawn window. Only
    // the collection gate below (CalcItemBoxCollision,
    // ALIVE/INVULNERABLE-only) is state-gated.
    // TH08's PoC rule (ItemManager all.c:31059-31062): the latch fires
    // when player.y < pocLine AND (power >= 128 [DAT_004b5b30 as a double]
    // OR player+3 focus state != 0 [DAT_017d5efb] OR role byte 1/6). For the
    // Border Team (role 0) that is exactly "focused OR full power" — focused
    // below 128 can line-collect, at 128 any form can.
    const pocActive = () => (p.power >= 128 || p.focusHeld) && p.y < sht.pocLineY;
    const globalRate = Math.fround(this.slowRate);
    // FUN_00440500 selects SHT+0x34 through the stable human/youkai form
    // byte, then multiplies it by the global time rate. Border Team stores
    // 0.9f in both forms. This local rate owns ordinary/state-3/state-5 item
    // POSITION integration and ordinary gravity; homing movement, tossed-item
    // gravity, and the state-2 ZunTimer continue to use the global rate.
    const formSht = p.th08Form ? p.focused : p.unfocused;
    const moveRate = Math.fround(Math.fround(formSht.itemMoveRate) * globalRate);
    for (const it of this.items) {
      let skipCollection = false;
      it.age++;
      if (it.state === 2 && it.tween) {
        // Spawn-mode-2 positional tween (death drops): pos = lerp(origin,
        // target, elapsed/60) for elapsed 0..59; at exactly 60 the velocity
        // zeroes and the item drops to normal fall from rest. Mid-tween
        // frames skip the latch, gravity and cull entirely (the exe's mode-2
        // branch jumps straight to the collect test). FUN_00430c10
        // all.c:21936-21956; duration divisor DAT_0048ea98 = 60.0.
        const tw = it.tween;
        if (tw.elapsed > 59) {
          if (tw.elapsed === 60) {
            it.vx = 0;
            it.vy = 0;
            it.state = 0;
            // ItemManager::OnUpdate's timer==60 branch does NOT jump to
            // check_collision: it falls through to the shared move (zero
            // velocity, no-op) and the gravity tail, so the fall arms
            // 0.03 on this very tick. Skipping that left every death-drop
            // item one gravity step behind native forever (th7_udYo01
            // stage 2, post-death collects 3 frames late).
            it.vy = Math.fround(Math.fround(0.03) * moveRate);
          }
        } else {
          const t = (tw.elapsed + tw.frac) / 60;
          it.x = Math.fround(t * tw.tx + (1 - t) * tw.sx);
          it.y = Math.fround(t * tw.ty + (1 - t) * tw.sy);
        }
        // Split-counter advance (exe FUN_00436acc): fractional under slowmo.
        tw.frac = Math.fround(tw.frac + globalRate);
        while (tw.frac >= 1) {
          tw.frac -= 1;
          tw.elapsed++;
        }
      } else if (it.state === 3 || it.state === 5) {
        // FUN_00440500 states 3/5 are TWO different toss laws, not one.
        // State 3 (type-7 spawn arm, all.c:31084-31094): 0.05*global gravity,
        // then the branch falls straight to the shared move label — ONE
        // moveRate integration plus the 0.03*moveRate tail, and LAB_004409f2's
        // state==3 test skips collection while the byte is still 3 (Stage-2
        // native f661: a human-shot orb inside the grab box survives to crest
        // instead of collecting on its allocation frame). The dead-player
        // override (DAT_017d5ef8==2, i.e. hitState or the death squish) fires
        // EVERY frame here: zero horizontal motion, vy=-0.7, ordinary-rate
        // integration + tail (native Stage-2 f678: -0.63px, vy=-0.673).
        // State 5 (type-10 tier orbs, 0x440746-0x4407e7): the branch
        // integrates BEFORE the crest test; a non-crest frame jumps directly
        // to the no-collection tail — NO 0.03 tail that frame. The crest
        // frame sets state 1, then falls to the shared move label and
        // integrates a SECOND time (double moveRate step) before paying the
        // 0.03 tail; its dead-player override lives inside the crest arm
        // only, so a rising state-5 orb keeps tossing under a dead player.
        if (it.state === 3) {
          if (p.hitState || p.dyingFrame >= 0) {
            it.state = 0;
            it.vx = 0;
            it.vy = Math.fround(-0.7);
            it.y = Math.fround(it.y + Math.fround(it.vy * moveRate));
            it.vy = Math.fround(it.vy + Math.fround(0.03) * moveRate);
          } else {
            it.vy = Math.fround(it.vy + Math.fround(0.05) * globalRate);
            it.x = Math.fround(it.x + Math.fround(it.vx * moveRate));
            it.y = Math.fround(it.y + Math.fround(it.vy * moveRate));
            if (it.vy > 0) it.state = 1;
            it.vy = Math.fround(it.vy + Math.fround(0.03) * moveRate);
            skipCollection = it.state === 3;
          }
        } else {
          it.vy = Math.fround(it.vy + Math.fround(0.05) * globalRate);
          it.x = Math.fround(it.x + Math.fround(it.vx * moveRate));
          it.y = Math.fround(it.y + Math.fround(it.vy * moveRate));
          if (it.vy > 0) {
            if (p.hitState || p.dyingFrame >= 0) {
              it.state = 0;
              it.vx = 0;
              it.vy = Math.fround(-0.7);
            } else {
              it.state = 1;
            }
            it.x = Math.fround(it.x + Math.fround(it.vx * moveRate));
            it.y = Math.fround(it.y + Math.fround(it.vy * moveRate));
            it.vy = Math.fround(it.vy + Math.fround(0.03) * moveRate);
          } else {
            skipCollection = true;
          }
        }
      } else {
        if (pocActive()) {
          it.state = 1;
        }
        if (it.state === 1) {
          if (p.hitState || p.dyingFrame >= 0 || p.materializeFrame >= 0) {
            // Player states 1/2 (respawn materialize or the complete death
            // sequence) clear the homing latch and write only vy=-0.7f;
            // the previous vx is intentionally retained for this local-rate
            // integration tick (all.c:31063-31076).
            it.vy = Math.fround(-0.7);
            it.state = 0;
          } else {
            // FUN_0044c1b0 @ all.c:37487-37497 computes atan2(py - iy, px - ix)
            // in extended precision, returning f32 angle.
            const angle = Math.fround(Math.atan2(p.y - it.y, p.x - it.x));
            it.vx = Math.fround(Math.cos(angle) * sht.autocollectSpeed);
            it.vy = Math.fround(Math.sin(angle) * sht.autocollectSpeed);
          }
        } else {
          // FUN_00430c10 @ all.c:21978-21991 integrates the current velocity
          // first, then applies gravity for the next frame.
          it.vx = 0;
          if (it.vy < Math.fround(-2.2)) it.vy = Math.fround(-2.2);
        }
        // All non-tween states share the rate-scaled integration and the
        // common vertical gravity/cap tail, including state-1 homing.
        // The live homing branch scales its velocity directly by the global
        // rate and jumps to collision. Every state that reaches the common
        // integration label instead uses the SHT-local movement rate.
        const integrationRate = it.state === 1 ? globalRate : moveRate;
        const dx = Math.fround(it.vx * integrationRate);
        const dy = Math.fround(it.vy * integrationRate);
        it.x = Math.fround(it.x + dx);
        it.y = Math.fround(it.y + dy);
        if (it.state !== 1) {
          // TH08's homing branch jumps straight to the collect test
          // (all.c:31064-31070) — no gravity tail pollutes the latch.
          // TH08 ItemManager (all.c:31109-31121): the 3.0 comparison is
          // against the item's VERTICAL VELOCITY returned by FUN_0040b460,
          // not its y position. Ordinary drops therefore accelerate from
          // -2.2 by 0.03*moveRate until vy reaches the 3px/frame terminal
          // speed. Treating y>=3 as the predicate made every visible drop
          // snap to terminal speed immediately and let Stage-2's opening
          // P-items fall out before the replay's PoC sweep.
          if (it.vy >= 3) it.vy = 3;
          else it.vy = Math.fround(it.vy + Math.fround(0.03) * moveRate);
        }
        // ItemManager::OnUpdate cull (0x44095b-0x440983): the fnstsw 0x41
        // parity test keeps the item alive AT the line (C3-only = odd parity
        // takes the gravity branch) and frees it only strictly beyond —
        // `arcadeRegionSize.y + 16.0f < y`, the 448+16 boundary. Terminal
        // velocity is exactly 3.0 and drops start near integer y, so the
        // equality case is reachable: a >= kill executes one frame early.
        if (it.y > 464) {
          it.dead = true;
          // FUN_00430c10 @ 0x4310ae-0x4310ba: every ordinary item that
          // leaves the bottom subtracts three rank points, regardless of
          // item type. Tween-state death drops bypass this cull branch.
          this.adjustRank(-3);
        }
      }
      // Player::CalcItemBoxCollision (FUN_0044a5a0 @ 0x44a5a0): inclusive
      // AABB of the ITEM-side box — computed live as item pos ± half of the
      // ItemManager size vector (FUN_00440500's prologue @ 0x440538 builds
      // vec(SHT+0x18, SHT+0x18, 16.0), halved at collision via FUN_0040c7d0's
      // /2.0) — against the PLAYER-side precomputed grab AABB (+0x3bc..0x3d0).
      // The player init (all.c:38182) derives that box's half-extents the
      // SAME way: +0x3f0 = SHT+0x18 / 2.0 — both sides are itemRadius/2.
      // ply00a.sht @24 = 24.0 for Border (the "26.0" in the old comment was
      // a misread), so the axis boundary is |Δ| = 24 inclusive. The old
      // hardcoded ±12 was numerically identical; this derives it from the
      // same SHT field the exe uses twice.
      const itemHalf = Math.fround(sht.itemRadius * 0.5);
      const itemMinX = Math.fround(it.x - itemHalf);
      const itemMaxX = Math.fround(it.x + itemHalf);
      const itemMinY = Math.fround(it.y - itemHalf);
      const itemMaxY = Math.fround(it.y + itemHalf);
      const grabMinX = Math.fround(p.x - itemHalf);
      const grabMaxX = Math.fround(p.x + itemHalf);
      const grabMinY = Math.fround(p.y - itemHalf);
      const grabMaxY = Math.fround(p.y + itemHalf);
      if (!skipCollection && p.alive && !it.dead &&
          !(grabMinX > itemMaxX || grabMaxX < itemMinX ||
            grabMinY > itemMaxY || grabMaxY < itemMinY)) {
        this.collectItem(it);
      }
    }
    let w = 0;
    for (const it of this.items) {
      if (!it.dead) {
        this.items[w++] = it;
      } else if (this.th08ItemPool) {
        // Release the spawn-pool slot HERE, at the compact that removes the
        // entity — syncItemSlots only sees entities still in this.items, so
        // deferring to it leaked every collected/despawned item's slot (the
        // pool filled monotonically: 378 live marks vs the 3-entity truth at
        // stage-1 f2700, which then made later time-orb probes fail).
        const slot = this.th08ItemPool.items[it.poolSlot];
        if (slot) slot.active = false;
      }
    }
    this.items.length = w;
    // Native item-manager walk tail (FUN_00440500 @ 0x440c8b-0x440cb7): the
    // 0x18b89d4 time-orb-gauge lockout decrements once per walk while nonzero
    // and clamps at 0 — AFTER this frame's collects, so a same-frame collect
    // still sees the pre-decrement value.
    if (this.runState.timeOrbGaugeLockout > 0) this.runState.timeOrbGaugeLockout--;
  }

  // TH08 item collection (ItemManager cases, reference/re-specs/
  // th08-decomp-items/ + th08-decomp-state/): point/power feed the run
  // state's ladder, time orbs feed the gauge + clock + orb counters, power
  // raises the SHT power level.
  private collectItemTh08(it: ItemEntity): void {
    const run = this.runState;
    const p = this.playerObj;
    // FUN_00440e40/FUN_00441020 award full value while the item is ABOVE
    // the PoC line. Below it, the value falls linearly with the rounded
    // pixel distance from the line. The old boolean was inverted and made
    // every line-collected point item partial while granting full value to
    // low pickups; it also inverted the native +10/+3 rank award.
    const belowPoC = it.y >= p.sht.pocLineY;
    const pocDistance = belowPoC
      ? Math.max(0, Math.round(Math.fround(it.y - p.sht.pocLineY)))
      : 0;
    switch (it.type) {
      case 'point': {
        const r = run.collectPoint({
          atOrAbovePoC: belowPoC,
          abovePoCRandom: pocDistance,
          isMaxValue: it.guaranteedMax
        });
        this.score = run.score;
        this.spawnScorePopup(r.award, it.x, it.y, 0xffffffff, true);
        // FUN_00440e40: +10 at maximum value, +3 otherwise. Rank/subrank is
        // gameplay state: by Stage-2 f1277 the missing item awards left the
        // port two full rank levels below native, changing every rank-lerped
        // bullet speed and ins_106 auto-fire interval.
        this.adjustRank(r.rankDelta);
        // FUN_00440e40's tail loop (all.c:31216-31221): every point-count
        // threshold crossed grants a 1UP through FUN_00439b29 — a protected
        // life/bomb write whose FUN_00406e50 re-arm draws 4 raw u16 — BEFORE
        // the point collect's own tail checksum. gx st2 crosses 100 at its
        // 43rd in-stage point item (entry 57), lives 4 -> 5 (T8RP st3 pins
        // it); the port used to compute extendsGained and drop it.
        for (let i = 0; i < r.extendsGained; i++) this.grantTh08Extend();
        break;
      }
      case 'pointSmall': case 'pointStar': {
        const r = run.collectPointSmall({
          atOrAbovePoC: belowPoC,
          abovePoCRandom: pocDistance,
          isMaxValue: it.guaranteedMax
        });
        this.score = run.score;
        this.spawnScorePopup(r.award, it.x, it.y, 0xffffffff, true);
        break;
      }
      case 'powerSmall':
        {
          const before = p.power;
          if (before < 128) {
            p.power = Math.min(128, p.power + 1);
            if (p.power >= 128) {
              // The 127 -> 128 crossing sets the protected power value to
              // its cap through FUN_00406fa0(0x80) (all.c:31150), whose
              // FUN_00406e50 re-arm draws two ranged u32 = 4 raw u16 ON TOP
              // of the FUN_00441850 add already paid in collectItem. This
              // one-shot event was the gx st2 native-f696 +20-vs-16 gap that
              // displaced the whole downstream RNG stream (the ±4 wobble
              // field, the f1807 sub12 spawn-angle mirror, the f3019 razor).
              this.payTh08ProtectedChecksum();
              this.enterTh08FullPower(it);
            }
            // FUN_004181f0(10) inside the below-cap bracket: +10 raw score.
            run.addScore(10);
            this.score = run.score;
          }
        }
        // FUN_00440cf0 awards one subrank even when power is already full.
        this.adjustRank(1);
        break;
      case 'powerBig': {
        const before = p.power;
        if (before < 128) {
          p.power = Math.min(128, p.power + 8);
          if (p.power >= 128) {
            // Same FUN_00406fa0(0x80) crossing checksum as powerSmall
            // (FUN_00441170 @ all.c:31282).
            this.payTh08ProtectedChecksum();
            this.enterTh08FullPower(it);
          }
          // FUN_004181f0(10) @ all.c:31291.
          run.addScore(10);
          this.score = run.score;
        }
        break;
      }
      case 'powerFull': {
        // Collect case 4 (all.c:31014-31027): the conversion block only
        // below the cap, but FUN_00406fa0(0x80) — and its 4-draw checksum
        // re-arm — runs UNCONDITIONALLY, then FUN_004181f0(1000).
        const before = p.power;
        p.power = 128;
        if (before < 128) this.enterTh08FullPower(it);
        this.payTh08ProtectedChecksum();
        run.addScore(1000);
        this.score = run.score;
        break;
      }
      case 'bomb':
        p.bombs = Math.min(8, p.bombs + 1);
        this.adjustRank(5);
        break;
      // Collect case 5 = FUN_00439b29, the same shared 1UP grant the
      // point-count thresholds use (protected write + 4 draws + se_extend +
      // rank; bomb fallback at full lives; nothing when both are full).
      case 'extend': this.grantTh08Extend(); break;
      case 'time': case 'time2': {
        // Time orb (CollectTimeOrb, FUN_004412b0): score + orb counter + the
        // gauge ±111 gated on the 0x18b89d4 post-familiar-death lockout timer
        // reading zero (native item-manager tail decrements it once/frame).
        const r = run.collectTimeOrb({
          specialScoringMode: false,
          timerCurrent: this.runState.timeOrbGaugeLockout,
          playerRole: p.focusHeld ? 1 : 0
        });
        this.score = run.score;
        if (r.gaugeDelta != null && r.gaugeDelta !== 0) run.addYoukaiGauge(r.gaugeDelta);
        break;
      }
      case 'unknown9': break;
      default: break;
    }
  }

  // One FUN_00406e50 protected-block checksum re-arm: two ranged u32 draws
  // (FUN_00406ef0(100000) each) = four raw u16. Every protected-value write
  // helper tails into it — FUN_00441850/FUN_00406fa0 (power), FUN_00439883
  // (bombs), FUN_0043c641 (lives), FUN_00418220 (time orbs).
  private payTh08ProtectedChecksum(): void {
    this.rng.u32InRange(100000);
    this.rng.u32InRange(100000);
  }

  // FUN_00439b29 @ all.c:27268 — the shared 1UP grant (green extend item AND
  // the point-count extend thresholds). lives < 8: protected life add
  // FUN_0043c641(1) (4-draw checksum re-arm) + se_extend + rank +200;
  // lives full: the grant falls through to the bomb stock via FUN_00439883(1)
  // (same 4 draws) while bombs < 8; both full: nothing, zero draws.
  private grantTh08Extend(): void {
    const p = this.playerObj;
    if (p.lives < 8) {
      this.payTh08ProtectedChecksum();
      p.lives++;
    } else if (p.bombs < 8) {
      this.payTh08ProtectedChecksum();
      p.bombs++;
    } else {
      return;
    }
    this.playSfx(28); // FUN_0045d550(0x1c, 0) = se_extend
    this.adjustRank(200); // FUN_0043bfc3(200)
  }

  private enterTh08FullPower(collected: ItemEntity): void {
    // FUN_00440cf0 / FUN_00441170 / the full-power item case all share this
    // transition when live power crosses 127 -> 128 (all.c:31148-31158).
    // FUN_00415c60 first performs the mode-1 point-star field clear. This
    // occurs inside the item-manager slot walk, so the newly allocated later
    // slots are updated/homed during this same pass — exactly what the live
    // `for..of` traversal below provides.
    this.cancelBulletsToItems();

    // FUN_00441450 converts every OTHER live small/big power item already on
    // the field into a point-small fragment, re-arming effect 0 at its
    // position. The collected item has already been unlinked natively; the
    // explicit dead/current checks reproduce that exclusion here.
    for (const item of this.items) {
      if (item === collected || item.dead ||
          (item.type !== 'powerSmall' && item.type !== 'powerBig')) continue;
      if (item.vy > -0.5) {
        item.vx = 0;
        item.vy = Math.fround(-0.5);
      }
      this.spawnEffectParticles(0, item.x, item.y, 1, 0xffffffff);
      item.type = 'pointSmall';
    }
  }

  private collectItem(it: ItemEntity): void {
    it.dead = true;
    this.traceReplayEvent?.({
      kind: 'item-collect', frame: this.frame,
      data: { type: it.type, slot: it.poolSlot, x: it.x, y: it.y }
    });
    this.playSfx(21); // TH08 item00 channel
    // The collect switch's FUN_00406e50 checksum (two u32 integrity values
    // = 4 raw u16) is per-PATH, not per-pickup: point and time-orb
    // collects always pay it (FUN_00440e40's tail / FUN_004412b0 ->
    // FUN_00418220); powerSmall/powerBig only below full power
    // (FUN_00441850 lives inside the power<0x80 bracket, all.c:31138 vs
    // the skipped full-power head); a bomb item only below stock 8
    // (FUN_00439883 in case 3). pointStar, pointSmall and unknown9 draw
    // zero. Charging every pickup left two full-power stage-2 collects 8
    // draws ahead of native by f1237. The gates read the PRE-collect
    // stock, matching the native head tests (collectItemTh08 below
    // performs the mutations). The extend item's draws live inside
    // grantTh08Extend (FUN_00439b29's two protected-write arms), and the
    // full-power crossing / powerFull cases pay their extra FUN_00406fa0
    // re-arm inside collectItemTh08.
    let paysIntegrityChecksum = false;
    switch (it.type) {
      case 'point': case 'time': case 'time2':
        paysIntegrityChecksum = true;
        break;
      case 'powerSmall': case 'powerBig':
        paysIntegrityChecksum = this.playerObj.power < 128;
        break;
      case 'bomb':
        paysIntegrityChecksum = this.playerObj.bombs < 8;
        break;
    }
    if (paysIntegrityChecksum) {
      this.rng.f();
      this.rng.f();
    }
    // TH08 collect dispatch: the TH08 item types settle through the run
    // state's native scoring (CollectPoint/CollectPointSmall/CollectTimeOrb,
    // reference/re-specs/th08-decomp-items/), not the TH07 cherry path. The
    // legacy pointItems counter (HUD's Point row) tracks the same collects.
    this.collectItemTh08(it);
    if (it.type === 'point') this.pointItems++;
  }

  private updateParticles(): void {
    for (const p of this.particles) {
      let alive = true;
      if (p.world) {
        // FUN_004264f0 (effect 51's world integrator, all.c:17989+) releases
        // the VM once dot(normalize(pos-camera), facing) drops below 0.94 —
        // cone-only liveness, NO ground-plane test (the z<0 kill was a TH07
        // FUN_0041a050 carry-over; keeping it shortened firefly lives and
        // perturbed the shared 512-slot effect pool's pressure). Integrate
        // acceleration/velocity, then re-project survivors into the field.
        const w = p.world;
        w.vx = Math.fround(w.vx + w.ax);
        w.vy = Math.fround(w.vy + w.ay);
        w.vz = Math.fround(w.vz + w.az);
        w.x = Math.fround(w.x + w.vx);
        w.y = Math.fround(w.y + w.vy);
        w.z = Math.fround(w.z + w.vz);
        w.angle = normalizeNativeAngleF32(w.angle, w.angularVelocity);

        const std = this.runtime.std;
        const camera = std.camera();
        const facing = std.facing();
        const dx = w.x - camera.x;
        const dy = w.y - camera.y;
        const dz = w.z - camera.z;
        // Exe-exact cone decision (asm 0x426549-0x4265a4): the displacement
        // normalizes with D3DX semantics — the length rounds to f32 ONCE,
        // then each component is its own f32 division — and the axis is the
        // camera block's unit view vector (0x4ea3e8, the per-component-f32
        // normalize of the raw facing track 0x4ea3d0). The dot itself
        // (FUN_0040b540) accumulates all three products in x87 and rounds
        // ONCE at the caller's fstp, so in JS it is a single fround of the
        // exact double sum. fcomp 0x3f70a3d7 + fnstsw/test $5 + jp releases
        // ONLY on the ordered below-threshold result (C0=1, C2=0): equality
        // keeps, and a NaN dot (C2=1) parks on the KEEP path — the opposite
        // of `dot >= 0.94`, which released NaNs and decided in double. The
        // double-decide flipped razor flies (gx st1 f1062 slot41, margin
        // 4e-10) against native and nudged the 512-slot pool's pressure.
        const f32 = Math.fround;
        const fx = f32(facing.x), fy = f32(facing.y), fz = f32(facing.z);
        const dl = f32(Math.sqrt(dx * dx + dy * dy + dz * dz));
        const fl = f32(Math.sqrt(fx * fx + fy * fy + fz * fz));
        const nx = f32(dx / dl), ny = f32(dy / dl), nz = f32(dz / dl);
        const ax = f32(fx / fl), ay = f32(fy / fl), az = f32(fz / fl);
        const dot = (dx * fx + dy * fy + dz * fz) / (Math.hypot(dx, dy, dz) * Math.hypot(fx, fy, fz));
        const dot32 = f32(nx * ax + ny * ay + nz * az);
        alive = !(dot32 < 0.9399999976158142);
        // Firefly-death forensics (pool-pressure parity): dot is the double
        // cosine (reference only), dot32 is the deciding f32 value above.
        // Only near-boundary or dying fireflies are reported (volume).
        if (this.traceReplayEvent && (Math.abs(dot - 0.94) < 0.01 || !alive)) {
          this.traceReplayEvent({
            kind: 'firefly-dot', frame: this.frame,
            data: {
              slot: p.poolSlot, age: p.age, dot, dot32,
              alive, alive32: dot32 >= 0.9399999976158142,
              x: w.x, y: w.y, z: w.z, cx: camera.x, cy: camera.y, cz: camera.z,
              fx: facing.x, fy: facing.y, fz: facing.z
            }
          });
        }
        if (alive) {
          const projected = std.project(w.x, w.y, w.z, std.cameraFrame(std.frame), {
            x: 0, y: 0, width: PLAYFIELD.width, height: PLAYFIELD.height
          });
          if (projected) {
            p.x = projected.x;
            p.y = projected.y;
          }
        }
      } else if (!p.burstDir) {
        // Border-break petals (effectId 29 with a burstDir) are positioned
        // exclusively by UpdateBurst30Frames — pos = emitter + dir·(age·256/30)
        // (EffectManager.cpp:232-237). Hold their spawn point (the break
        // emitter) steady instead of integrating the legacy random velocity,
        // which native discards for these. Other particles keep their walk.
        p.x += p.vx;
        p.y += p.vy;
      }

      if (p.ownerEnemyId != null && p.releaseFrames == null) {
        const owner = this.enemies.find((enemy) => enemy.id === p.ownerEnemyId && !enemy.dead);
        if (owner) {
          p.x = owner.x;
          p.y = owner.y;
        }
      }
      if (p.releaseFrames != null && --p.releaseFrames <= 0) alive = false;
      p.age++;
      if (p.age >= p.life) alive = false;
      if (!alive) {
        this.traceReplayEvent?.({
          kind: 'effect-death', frame: this.frame,
          data: { effectId: p.effectId, slot: p.poolSlot, age: p.age, life: p.life }
        });
        p.age = p.life;
        if (this.effectSlots[p.poolSlot] === p) this.effectSlots[p.poolSlot] = null;
      }
    }
    let w = 0;
    for (const p of this.particles) if (p.age < p.life) this.particles[w++] = p;
    this.particles.length = w;
  }

  // -- draw ------------------------------------------------------------------

  draw(r: Renderer, measurePasses = false): void {
    // The native one-shot capture flush runs before the next render, while
    // the backbuffer still holds the final live playfield. Capturing after
    // clear() would record the presentation itself instead.
    if (this.clearCaptureArmed || this.stageTransitionCaptureArmed) {
      r.capturePlayfield();
      this.clearCaptureArmed = false;
      this.stageTransitionCaptureArmed = false;
    }
    this.measureDrawPasses = measurePasses;
    if (measurePasses) {
      this.drawPassCosts = {};
      this.passT0 = performance.now();
    }
    r.clear('#101018');
    r.ctx.fillStyle = '#04040c';
    r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    this.markPass('clear');
    r.clipPlayfield(() => {
      const ox = PLAYFIELD.x + this.shakeX;
      const oy = PLAYFIELD.y + this.shakeY;
      this.drawBackground(r, ox, oy);
      this.drawSpellBackground(r);
      // Native declaration presentation is a world layer: the authored
      // portrait, rune ring, and spell-name/bonus row all sit behind the
      // boss and danmaku (native s1 f3415..3540 / f3700 captures). The
      // regular player/effect layer remains above bullets below.
      this.drawSpellRing(r, ox, oy);
      this.drawSpellDeclaration(r);
      this.drawSpellOverlay(r);
      this.markPass('background');
      for (const p of this.particles) {
        // Effect 62 (option afterimages) is pool-pressure only: the native
        // VMs sit at world (0,0,0) and show nothing on screen in practice
        // (userdemo-t100 corner region reads dark), so they are not drawn.
        if (p.effectId === 62) continue;
        const alpha = 1 - p.age / p.life;
        r.ctx.globalAlpha = alpha * 0.8;
        r.ctx.fillStyle = p.kind === 'snow' ? '#cde' : '#fff';
        r.ctx.fillRect(ox + p.x - p.size / 2, oy + p.y - p.size / 2, p.size, p.size);
        r.ctx.globalAlpha = 1;
      }
      for (const e of this.enemies) {
        if (e.ecl.invisible) continue;
        // TH08 ethereal familiars (player in youkai form) draw through the
        // ghost tint — FUN_0042c420 sets +0x3330 = 0x40 and the manager's
        // LAB_0042db0b else-branch holds the enemy VM's color1 at
        // R=G=0x20, B base, ALPHA HALVED every frame (all.c:21757-21763).
        const t8ghost = e.ecl.th08?.familiar && e.ecl.th08.sideBit === 1;
        const ghostOpts = t8ghost
          ? { color: 0x2020ff, alpha: 0.5 } as { color: number; alpha: number }
          : undefined;
        for (const slot of e.ecl.anmSlots) {
          if (slot?.runner) r.drawAnmFrame(slot.runner.spriteFrame(), ox + e.x, oy + e.y, ghostOpts);
        }
        const frame = e.ecl.anmRunner?.spriteFrame() ?? null;
        // op150 writes an absolute VM rotation; the op27 angle-follow flag
        // takes precedence when armed (both write the same exe field).
        // op120 rotate-with-movement: the exe's per-frame ANM sync
        // (FUN_004208a0) copies the LIVE heading (enemy+0x2b54) into the
        // sprite rotZ — not the mode-1 polar angle, which mode-3 orbiters
        // (Letty's テーブルターニング papers) never touch.
        const rotation = e.ecl.anmRotateWithAngle ? e.ecl.heading : e.ecl.anmRotZ;
        const opts: { rotation?: number; color?: number; alpha?: number } = {};
        if (rotation != null) opts.rotation = rotation;
        if (ghostOpts) {
          opts.color = ghostOpts.color;
          opts.alpha = ghostOpts.alpha;
        }
        r.drawAnmFrame(frame, ox + e.x, oy + e.y, opts);
      }
      this.markPass('enemies');
      // Th07.exe layers the player sprite UNDER the enemy bullet/laser danmaku
      // (only the focus hitbox indicator, drawn later, sits on top).
      this.drawPlayerSprite(r, ox, oy);
      this.drawLasers(r, ox, oy);
      // Player shots ride under the enemy-bullet danmaku so dense patterns
      // stay readable (Th07.exe layers player shot/laser below enemy bullets).
      for (const b of this.playerBullets) {
        // Script-driven sprite state (alpha/scale/spin/blend all come from
        // the playerXX.anm shot script). Auto-rotate scripts (op25 — Sakuya
        // knives, Marisa main star, the impact streaks) orient along the
        // live velocity +π/2 (sprites point up, exe FUN_0043a630); others
        // (Reimu's spinning amulets) use the script's own rotation.
        const frame = b.runner.spriteFrame();
        if (!frame) continue;
        const opts: { rotation?: number; alpha?: number } = {};
        // TH08's shot textures point along +x in the sheet (the needle strip
        // at player00 (0,144,64,16)), so face-motion rotation is the raw
        // velocity angle.
        if (frame.autoRotate) opts.rotation = Math.atan2(b.vy, b.vx);
        r.drawAnmFrame(frame, ox + b.x, oy + b.y, opts);
      }
      // Enemy bullets dominate entity draw counts in dense spells. Their
      // sprites are untinted, so one saved Canvas state can safely cover the
      // whole batch while each draw assigns its own transform/alpha/blend.
      r.ctx.save();
      for (const b of this.enemyBullets) {
        if (b.dead) continue;
        if (b.clearFadeFrames != null) {
          r.drawAnmFrame(b.clearRunner?.spriteFrame() ?? null, ox + b.x, oy + b.y);
          continue;
        }
        // 大玉 (template 10) spawn bloom: the exe's flags-selected intro
        // script (etama2 entry-1 script 2, 24 frames — recon
        // gokushinken-bullets.md) draws the same offset-shifted sprite at
        // scale 2.0 shrinking to 1.0, additive, alpha fading 0->255 over
        // 32f (clipped by the 24f script end). Draw-time only; movement/
        // collision keep the byte-confirmed spawnDuration model.
        const spawnAge = Math.min(b.spawnDuration, b.spawnAge ?? b.spawnDuration);
        const visualAge = spawnAge + b.age;
        if (b.sprite === 10 && (b.flags & 0xe) !== 0 && visualAge < 24) {
          r.drawSpriteInBatch(
            b.rect.imageKey, b.rect.x, b.rect.y, b.rect.w, b.rect.h,
            ox + b.x, oy + b.y,
            b.angle + Math.PI / 2,
            2 - visualAge / 24,
            Math.min(1, visualAge / 32),
            'lighter'
          );
          continue;
        }
        const spawning = spawnAge < b.spawnDuration;
        r.drawSpriteInBatch(
          b.rect.imageKey,
          b.rect.x,
          b.rect.y,
          b.rect.w,
          b.rect.h,
          ox + b.x,
          oy + b.y,
          b.angle + Math.PI / 2,
          spawning ? 1.6 - 0.6 * (spawnAge / Math.max(1, b.spawnDuration)) : 1,
          spawning ? 0.6 + 0.4 * (spawnAge / Math.max(1, b.spawnDuration)) : 1,
          spawning ? 'lighter' : 'source-over'
        );
      }
      r.ctx.restore();
      this.markPass('bullets');
      // Items ride the same batched path as bullets: a phase-end sweep can
      // legitimately field 1000+ of them at once, and the per-call
      // save/translate/restore path was the measured freeze source there.
      r.ctx.save();
      for (const it of this.items) {
        // TH08: the item's etama.anm script (itemType + 61) supplies the
        // sprite; above-screen items draw their plain sprite pinned to the
        // top edge (the TH08 arrow variant is undecoded — flagged).
        const above = it.y < 0;
        const slot = TH08_ITEM_TYPE_SLOT[it.type];
        const frame = slot != null ? this.th08ItemRunners[slot]?.spriteFrame() : null;
        if (frame) {
          r.drawSpriteInBatch(frame.imageKey, frame.x, frame.y, frame.w, frame.h,
            ox + it.x, oy + Math.max(8, it.y), 0, 1,
            (frame.alpha / 255) * (above ? 0.85 : 1),
            frame.blendAdd ? 'lighter' : 'source-over');
        }
      }
      r.ctx.restore();
      this.markPass('items');
      const p = this.playerObj;
      // TH08 miss white-out: FUN_0044d2c0 draws FUN_0044de60(player, 768,
      // 896, 0xffffffff, 0) EVERY frame while the +0xe2a70 countdown runs.
      // 768×896 centered on the player with opaque white always covers the
      // 384×448 playfield, so the clipped result is a solid white playfield
      // quad (tests/th08-death-white.test.mjs). There is no white during
      // the deathbomb window itself.
      if (this.th08DeathWhiteFrames > 0) {
        r.ctx.fillStyle = '#ffffff';
        r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
      }
      this.playerEffects.draw(r, ox, oy);
      this.th08Effects.draw(r, ox, oy);
      this.drawTh08BeamVisuals(r, ox, oy);
      // The declaration VMs self-position in 640x480 screen space
      // (banner strips at y=16 over the frame, name mid-playfield).
      this.th08Declaration?.draw(r);
      this.drawPopups(r, ox, oy);
      // Option orbs (yin-yang, local sprite 128).
      if (p.alive && p.power >= 8) {
        const orbSprite = p.anm.sprites.get(128) ?? p.anm.sprites.get(66);
        if (orbSprite) {
          for (const orb of [1, 2] as const) {
            const off = p.orbOffset(orb);
            r.drawSprite(orbSprite.imageKey, orbSprite.x, orbSprite.y, orbSprite.w, orbSprite.h, ox + p.x + off.x, oy + p.y + off.y, {
              rotation: this.frame * 0.1,
              scaleMultiplier: 0.75
            });
          }
        }
      }
      // The player body sprite itself is drawn earlier, UNDER the danmaku
      // layer (drawPlayerSprite). Only the focus hitbox indicator stays here,
      // on top of the bullets, so it remains visible against dense fire.
      if (this.focusHeld && p.alive) {
        r.ctx.fillStyle = '#fff';
        r.ctx.beginPath();
        r.ctx.arc(ox + p.x, oy + p.y, p.hitboxHalf + 1.5, 0, Math.PI * 2);
        r.ctx.fill();
        r.ctx.strokeStyle = '#f66';
        r.ctx.stroke();
      }
      // TH08 night blindness (FUN_00405420, all.c:1583-1609): see
      // drawNightBlindness below.
      if (this.nightBlindIntensity > 0) this.drawNightBlindness(r, ox, oy);
      this.markPass('nightBlind');
      if (this.screenFlash) {
        const f = this.screenFlash;
        const a = ((f.color >>> 24) & 0xff) / 255;
        const cr = (f.color >>> 16) & 0xff;
        const cg = (f.color >>> 8) & 0xff;
        const cb = f.color & 0xff;
        r.ctx.save();
        r.ctx.globalAlpha = a;
        r.ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
        r.ctx.restore();
      }
      this.markPass('player+fx');
    });
    this.drawFrame(r);
    this.drawSidebar(r);
    this.drawModeTags(r);
    if (this.stageResultsActive) this.drawStageClearPresentation(r);
    this.drawTh08Dialogue(r);
    this.drawStageTitle(r);
    if (this.bonusPopup) this.drawSpellBonusPopup(r);
    if (this.bossActive) this.drawBossMarker(r);
    if (this.bossActive) this.drawBossFightHud(r);
    if (this.stageResultsActive) this.drawStageClear(r);
    this.drawStageTransition(r);
    if (this.continueScreen) this.drawContinueScreen(r);
    else if (this.gameOver) r.text('GAME OVER', PLAYFIELD.x + 140, PLAYFIELD.y + 200, { size: 20, color: '#f66' });
    if (this.pauseState) this.drawPause(r);
    this.markPass('hud');
  }

  private startStageClearPresentation(): void {
    // TH08's clear presentation resolves to the native capture animation
    // (capture.anm entry-0 script -4, the full-screen capture fade) with no
    // loading portrait — the vertical bundle ships no team loading ANMs.
    if (this.stageNumber >= 6) return;
    this.clearLoadingRunner = null;
    const capture = this.assets.anms.capture;
    this.clearCaptureRunner = new AnmRunner(capture, -4, { imageKey: 'capture:@', entryIndex: 0, spriteIndexOffset: capture.entries[0].spriteBase });
    this.clearCaptureArmed = true;
    // The tally's night-clock plate (times.anm): script 1 is the persistent
    // current-时刻 plate at (224,232) holding at interrupt label 1; the
    // sprite slot mirrors runState.clockTime at the tally start. When the
    // tally pays the quota advance, script 2 (the (320,96) plate) takes the
    // ADVANCED slot and the current plate's wait releases.
    const times = this.assets.anms.times;
    if (times?.hasScriptInEntry(0, 1)) {
      const entry = times.entries[0];
      const slot = Math.min(Math.max(this.runState?.clockTime ?? 0, 0), 12);
      this.clearTimeRunner = new AnmRunner(times, 1, {
        entryIndex: 0,
        spriteIndexOffset: entry.spriteBase + slot
      });
    }
  }

  private drawStageClearPresentation(r: Renderer): void {
    // Native draw order @ all.c:18798-18800: full-playfield loading art,
    // then the rotating/shrinking captured frame. Both ANMs contain absolute
    // 640x480 screen coordinates, so the caller contributes no playfield base.
    r.drawAnmFrame(this.clearLoadingRunner?.spriteFrame() ?? null, 0, 0);
    r.drawAnmFrame(this.clearCaptureRunner?.spriteFrame() ?? null, 0, 0);
    // The night-clock plates ride the tally (current, then advanced).
    r.drawAnmFrame(this.clearTimeRunner?.spriteFrame() ?? null, 0, 0);
    r.drawAnmFrame(this.clearTimeAdvancedRunner?.spriteFrame() ?? null, 0, 0);
  }

  private startStageTransition(): void {
    // Th07.exe FUN_00427269 @ 0x42740a-0x42770e, entered for game state 3:
    // capture the outgoing playfield, split it into 12x14 32px cells, then
    // seed capture.anm scripts 2/3 with var8 = row + 2*column. Their original
    // ANM bytecode staggers a 60-frame quadratic shrink/fade/rotation, which
    // reveals the already-running next stage beneath the old clear screen.
    // TH08's capture.anm has no scripts 2/3 (its table is -5..-1): the TH07
    // tile shatter is not applicable here and is skipped (TH08's own
    // transition runs through the tally presentation instead).
    const capture = this.assets.anms.capture;
    this.stageTransitionTiles.length = 0;
    for (let row = 0; row < 14; row++) {
      for (let column = 0; column < 12; column++) {
        const script = 2 + ((row + column) & 1);
        if (!capture.hasScriptInEntry(0, script)) continue;
        const delay = row + column * 2;
        const runner = new AnmRunner(capture, script, { imageKey: 'capture:@' });
        runner.setVariable(8, delay);
        this.stageTransitionTiles.push({
          runner,
          row,
          column,
          delay,
          // Exe coordinates are cell*32 - 0.5 + 16 (center semantics).
          x: column * 32 + 15.5,
          y: row * 32 + 15.5,
          sourceX: column * 32,
          sourceY: row * 32
        });
      }
    }
    this.stageTransitionTimer = 0;
    this.stageTransitionCaptureArmed = true;
  }

  private drawStageTransition(r: Renderer): void {
    if (!this.stageTransitionTiles.some((tile) => !tile.runner.removed)) return;
    r.clipPlayfield(() => {
      for (const tile of this.stageTransitionTiles) {
        if (tile.runner.removed) continue;
        r.drawAnmFrame(
          tile.runner.spriteFrame(),
          PLAYFIELD.x + tile.x,
          PLAYFIELD.y + tile.y,
          { sourceOffsetX: tile.sourceX, sourceOffsetY: tile.sourceY, project3d: true }
        );
      }
    });
  }

  // Spell Card Bonus! popup — spec-ui-stageclear.md §4 / all.c:17171-17193.
  // Label: opaque red, 16px-class, x = (384 - 17*16)/2 + 32 = 88, y = 80.
  // Value: 2× scale light-salmon, re-centered on its own glyph width.
  // Duration 280 frames (all.c:18302-18304). Failure arms nothing.
  private drawSpellBonusPopup(r: Renderer): void {
    const pop = this.bonusPopup;
    if (!pop) return;
    // Fade out over the last 30 frames so the hard cut is less jarring
    // (exe fade path not fully decoded; cosmetic only).
    const alpha = pop.timer < 30 ? pop.timer / 30 : 1;
    const label = 'Spell Card Bonus!';
    const value = Math.trunc(pop.bonus).toLocaleString('en-US').replace(/,/g, '');
    // Label: 16px/glyph class → center over playfield width 384.
    const labelX = PLAYFIELD.x + (PLAYFIELD.width - label.length * 10) / 2;
    r.text(label, labelX, PLAYFIELD.y + 80, { size: 16, color: `rgba(255,0,0,${alpha})` });
    // Value: ~2× scale (32px/glyph class in the exe) light salmon 0xffff8080.
    const valueSize = 28;
    const valueX = PLAYFIELD.x + (PLAYFIELD.width - value.length * (valueSize * 0.6)) / 2;
    r.text(value, valueX, PLAYFIELD.y + 96, {
      size: valueSize,
      color: `rgba(255,128,128,${alpha})`
    });
  }

  // Boss X-position marker at the playfield bottom edge. Exact sprite not
  // recovered from front.anm (spec-ui-stageclear.md §3 — PROBABLE lead is
  // _DAT_004b5ee0 feed); fall back to a small "Enemy" label at ~60% alpha
  // tracking boss.x, clamped to the playfield.
  private drawBossMarker(r: Renderer): void {
    const boss = this.bossActive;
    if (!boss) return;
    const x = PLAYFIELD.x + Math.max(0, Math.min(PLAYFIELD.width, boss.x));
    const y = PLAYFIELD.y + PLAYFIELD.height - 2;
    r.text('Enemy', x, y, { size: 11, color: 'rgba(255,80,80,0.6)', align: 'center' });
  }

  // Boss-fight HUD block (native, userdemo shots n-f2950/n-f3700/ns2-6000):
  // the romaji nameplate at the playfield's top-left + the armed phase
  // deadline counting down as a number at the top-right. The native VM/rect
  // for both is unrecovered in the partial export (§7): the nameplate draws
  // the romaji row of face_stNN_name.png, the number counts the armed
  // ins_134 phase deadline down in seconds.
  private drawBossFightHud(r: Renderer): void {
    const boss = this.bossActive;
    if (!boss) return;
    // Romaji row of the stage's face_stNN_name strip (per-stage text differs
    // in length; the rows sit at the strip's bottom-right):
    //   st01 "Wriggle Nightbug" (132,38,119,9); st02 "Mystia Lorelai"
    //   (45,30,201,17).
    const nameRect = this.stageNumber === 2
      ? [45, 30, 201, 17] as const
      : [132, 38, 119, 9] as const;
    const nameKey = this.stageNumber === 2 ? 'face_st02_name' : 'face_st01_name';
    if (r.image(nameKey)) this.blit(r, nameKey, nameRect, PLAYFIELD.x, PLAYFIELD.y + 18);
    // Phase deadline countdown (the boss's ins_134-armed timer), seconds.
    const ecl = boss.ecl;
    const threshold = ecl.timerCallbackThreshold;
    if (threshold > 0) {
      const left = Math.max(0, Math.ceil((threshold - ecl.bossTimer) / 60));
      r.text(String(left), PLAYFIELD.x + PLAYFIELD.width - 8, PLAYFIELD.y + 4, {
        size: 13, color: '#fff', align: 'right'
      });
    }
  }

  // TH08 result tally (native draw FUN_0043826b, all.c:26466-26606). The
  // exe typesets every row in one pass once the tally is armed — there is
  // NO row-by-row reveal. Layout (absolute 640x480 GUI space): rows start
  // at (120, 96), the heading is followed by a 32px gap, plain rows are
  // 16px apart, the rank block opens with another 32px gap, and the
  // night-clock row trails 40px below Total (floats _DAT_004b42c4/cc/d4,
  // _DAT_004b432c @ 0x4b42c4/0x4b42cc/0x4b42d4/0x4b432c). Row text uses the
  // exe's own format strings; colors are the FUN_004398e8 D3DCOLORs.
  stageClearRows(): { text: string; x: number; y: number; color: string }[] {
    const b = this.clearBonus;
    if (!b) return [];
    const rows: { text: string; x: number; y: number; color: string }[] = [];
    const disp = (v: number) => `${String(Math.round(v / 10)).padStart(8)}0`; // "%8d0"
    const WHITE = '#ffffff';
    const YELLOW = '#ffff40'; // 0xffffff40
    const LAVENDER_HI = '#e0e0ff'; // 0xffe0e0ff
    const LAVENDER = '#d0d0ff'; // 0xffd0d0ff
    const SALMON = '#ff8080'; // 0xffff8080
    const CREAM = '#ffff80'; // 0xffffff80
    // "All Clear!" replaces "Stage Clear" on route-final clears
    // (DAT_0164d2cc >= 6 gate, all.c:26476-26484).
    rows.push({ text: this.stageNumber >= 6 ? 'All Clear!' : 'Stage Clear', x: 120, y: 96, color: YELLOW });
    let y = 96 + 32;
    rows.push({ text: `Clear = ${disp(b.clear)}`, x: 120, y, color: WHITE });
    y += 16;
    rows.push({ text: `Point = ${disp(b.point)}`, x: 120, y, color: LAVENDER_HI });
    y += 16;
    rows.push({ text: `Graze = ${disp(b.graze)}`, x: 120, y, color: LAVENDER });
    y += 16;
    rows.push({ text: `Time  = ${disp(b.time)}`, x: 120, y, color: LAVENDER });
    y += 16;
    // Gauge-extreme time ratios (all.c:26503-26508): counted by the player
    // tick tail accumulators (gaugeTrick*), displayed "%3d.%.2d%%".
    const tot = this.runState.gaugeTrickTotal;
    const pct = (n: number) =>
      tot > 0
        ? `${String(Math.trunc((n * 100) / tot)).padStart(3)}.${String(Math.trunc((n * 10000) / tot) % 100).padStart(2, '0')}`
        : '  0.00';
    rows.push({ text: `over-80% = ${pct(this.runState.gaugeTrickHuman)}%`, x: 120, y, color: LAVENDER });
    y += 16;
    rows.push({ text: `over 80% = ${pct(this.runState.gaugeTrickYoukai)}%`, x: 120, y, color: LAVENDER });
    // Player/Bomb rows only on route-final clears (all.c:26509-26518).
    if (this.stageNumber >= 6) {
      y += 16;
      rows.push({ text: `Player =${disp(b.player)}`, x: 120, y, color: CREAM });
      y += 16;
      rows.push({ text: `Bomb   = ${String(Math.round(b.bomb / 10)).padStart(7)}0`, x: 120, y, color: CREAM });
    }
    y += 32;
    // Exact native rank strings (all.c:26534-26557) — including Phantasm's.
    const RANK_LINES = [
      'Easy Rank    *0.5', 'Normal Rank  *1.0', 'Hard Rank    *1.2',
      'Lunatic Rank *1.5', 'Extra Rank   *2.0', 'Phantasm Rank*2.0'
    ];
    if (this.difficulty <= 5) {
      rows.push({ text: RANK_LINES[this.difficulty], x: 120, y, color: SALMON });
    }
    // Configured-lives penalty rows (all.c:26558-26581), difficulty < 4.
    if (this.difficulty < 4) {
      const PENALTY: Record<number, string> = {
        3: 'Player Penalty*0.5', 4: 'Player Penalty*0.2',
        5: 'Player Penalty*0.1', 6: 'Player Penalty*0.05'
      };
      const penalty = PENALTY[this.startingLives];
      if (penalty) {
        y += 16;
        rows.push({ text: penalty, x: 120, y, color: SALMON });
      }
    }
    y += 16;
    rows.push({ text: `Total = ${disp(b.total)}`, x: 120, y, color: WHITE });
    // Night-clock row (stage < 6, all.c:26587-26604): current time, ">>",
    // then the counting advanced time — one horizontal line, x advancing by
    // +99 / +34 (floats _DAT_004b4d64/_DAT_004b4d5c).
    if (this.stageNumber < 6) {
      y += 40;
      rows.push({ text: StageScene.formatTallyClock(this.tallyClockEntry), x: 120, y, color: '#dfdfdf' });
      rows.push({ text: '>>', x: 120 + 99, y, color: '#afafaf' });
      rows.push({ text: StageScene.formatTallyClock(this.tallyClockShown), x: 120 + 99 + 34, y, color: '#ff8f8f' });
    }
    return rows;
  }

  // The tally clock's "%s%2d:%.2d" (all.c:26591-26594): minutes on the
  // 12-hour face, prefix from PTR_DAT_004c72bc — "PM" while hours < 12,
  // "AM" after the midnight wrap (the native table is ordered AM,PM and
  // indexed by the boolean, so PM lands first).
  private static formatTallyClock(minutes: number): string {
    const h24 = Math.trunc(minutes / 60);
    const prefix = h24 < 12 ? 'PM' : 'AM';
    return `${prefix}${String(h24 % 12).padStart(2)}:${String(minutes % 60).padStart(2, '0')}`;
  }

  private drawStageClear(r: Renderer): void {
    const rows = this.stageClearRows();
    if (!rows.length) return;
    const t = this.stageClearTimer || 1;
    const ctx = r.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(0.45, t / 60);
    ctx.fillStyle = '#000';
    ctx.fillRect(PLAYFIELD.x, 88, PLAYFIELD.width, 280);
    ctx.restore();
    for (const row of rows) {
      r.text(row.text, row.x, row.y, { size: 14, color: row.color });
    }
  }

  private drawContinueScreen(r: Renderer): void {
    const cx = PLAYFIELD.x + PLAYFIELD.width / 2;
    const ctx = r.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 16, 0.65)';
    ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    ctx.restore();
    r.text('Continue?', cx, PLAYFIELD.y + 168, { size: 24, color: '#ffe0a0', align: 'center' });
    r.text(`Credits ${3 - this.continuesUsed}`, cx, PLAYFIELD.y + 204, { size: 13, color: '#ccc', align: 'center' });
    const blink = this.frame % 40 < 28;
    const cur = this.continueScreen!.cursor;
    r.text('Yes', cx - 40, PLAYFIELD.y + 240, {
      size: 16, align: 'center',
      color: cur === 0 ? (blink ? '#fff' : '#ffd700') : '#777'
    });
    r.text('No', cx + 40, PLAYFIELD.y + 240, {
      size: 16, align: 'center',
      color: cur === 1 ? (blink ? '#fff' : '#ffd700') : '#777'
    });
  }

  // Top-left-anchored sprite blit. Renderer#drawSprite centers on (x,y)
  // (entity semantics); the HUD layout spec's coordinates are all top-left
  // corners (the ANM scripts run ins_22 corner-relative), so convert here.
  private blit(r: Renderer, key: string, rect: readonly number[], x: number, y: number, alpha = 1): void {
    const img = r.image(key);
    if (!img) return;
    const ctx = r.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, rect[0], rect[1], rect[2], rect[3], x, y, rect[2], rect[3]);
    ctx.restore();
  }

  // Ornate maroon screen frame: tiles front.png's sprite12 (32x32) and
  // sprite13 (128x16) over every region outside the playfield. The tile
  // sizes divide the border area exactly (top/bottom 128x16 bands ×5, side
  // columns 32x32 grids), which is the spec's recommended construction — the
  // ANM scripts carry the tiles but not their positions (engine-placed).
  private drawFrame(r: Renderer): void {
    const right = PLAYFIELD.x + PLAYFIELD.width; // 416
    const bottom = PLAYFIELD.y + PLAYFIELD.height; // 464
    // TH08's front.png ships its own tile (32x32 @ 0,224) and strip
    // (128x16 @ 0,208).
    const strip = [0, 208, 128, 16] as readonly number[];
    const tile = [0, 224, 32, 32] as readonly number[];
    // Top & bottom bands (0..640 × 16), 128px strips.
    for (let x = 0; x < SCREEN_W; x += strip[2]) {
      this.blit(r, 'front', strip, x, 0);
      this.blit(r, 'front', strip, x, bottom);
    }
    // Left column and right sidebar background, 32×32 tiles.
    for (let y = PLAYFIELD.y; y < bottom; y += tile[3]) {
      for (let x = 0; x < PLAYFIELD.x; x += tile[2]) this.blit(r, 'front', tile, x, y);
      for (let x = right; x < SCREEN_W; x += tile[2]) this.blit(r, 'front', tile, x, y);
    }
  }

  // Blits a base-10 integer using the ascii.png 8x12 digit font, top-left
  // corner at (x,y). Optionally zero-pads to `width` digits (scores are
  // fixed-width in the original). Returns the x just past the last digit.
  private drawNumber(r: Renderer, value: number, x: number, y: number, width = 0, alpha = 1, advance = DIGIT_W): number {
    let s = String(Math.max(0, Math.trunc(value)));
    if (width > 0) s = s.padStart(width, '0');
    for (let i = 0; i < s.length; i++) {
      const d = s.charCodeAt(i) - 48;
      if (d >= 0 && d <= 9) {
        this.blit(r, 'ascii', [d * DIGIT_W, DIGIT_Y, DIGIT_W, DIGIT_H], x + i * advance, y, alpha);
      }
    }
    return x + s.length * advance;
  }

  // ascii.anm sprites 136-152: the original bottom gauge uses this authored
  // 8x12 row for its signed percentage and point-item value. Keep the glyph
  // mapping here instead of substituting a browser font; the latter was both
  // wider and vertically displaced in the old hand-built gauge.
  private drawGaugeText(r: Renderer, text: string, x: number, y: number, color = 0xffffff): void {
    const extraGlyphX: Readonly<Record<string, number>> = {
      '%': 80,
      '.': 88,
      '-': 96,
      '+': 104,
      '(': 112,
      ')': 120
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const d = c.charCodeAt(0) - 48;
      const sx = d >= 0 && d <= 9 ? d * DIGIT_W : extraGlyphX[c];
      if (sx == null) continue;
      r.drawSprite('ascii', sx, DIGIT_Y, DIGIT_W, DIGIT_H,
        x + i * DIGIT_W + DIGIT_W / 2, y + DIGIT_H / 2, { color });
    }
  }

  // Regular background quad VMs run on Std#animationFrame, which never
  // pauses or rewinds with the script clock (FUN_00406850 @ 0x406850).
  // NOTE both caches floor the target clock: under global slow motion the
  // STD animation clock is FRACTIONAL (…7000.33, 7000.66…), while the cached
  // runner steps in whole frames. Comparing the raw fractional target against
  // the integer runner position made "clock went backward" true on almost
  // every slowed frame, and each such frame rebuilt every background script
  // and replayed it from frame 0 — O(stage-frame) work per script per draw.
  // That was the 餓王剣 (stage-5 Youmu bullet-time) frame-drop report: cost
  // engaged exactly while slowRate < 1 and grew with elapsed stage time.
  // A genuine rewind (the STD op-4 boss loop) still rebuilds correctly.
  private bgAnmFrame(scriptId: number, targetFrame: number): AnmFrame | null {
    const target = Math.floor(targetFrame);
    let entry = this.bgAnmCache.get(scriptId);
    if (!entry || target < entry.frame) {
      const ref = this.bgScripts.get(scriptId);
      if (!ref) return null;
      entry = {
        runner: new AnmRunner(ref.anm, ref.localId, { entryIndex: ref.entryIndex, spriteIndexOffset: ref.spriteBase }),
        frame: 0
      };
      this.bgAnmCache.set(scriptId, entry);
    }
    while (entry.frame < target) {
      entry.runner.update();
      entry.frame++;
    }
    return entry.runner.spriteFrame();
  }

  private specialBgAnmFrame(slot: number, state: { script: number; age: number } | null): AnmFrame | null {
    if (!state) {
      this.specialBgAnmCache[slot] = null;
      return null;
    }
    const targetAge = Math.floor(state.age);
    let entry = this.specialBgAnmCache[slot];
    if (!entry || entry.script !== state.script || targetAge < entry.age) {
      const ref = this.bgScripts.get(state.script);
      if (!ref) return null;
      entry = {
        script: state.script,
        runner: new AnmRunner(ref.anm, ref.localId, { entryIndex: ref.entryIndex, spriteIndexOffset: ref.spriteBase }),
        age: 0
      };
      this.specialBgAnmCache[slot] = entry;
    }
    while (entry.age < targetAge) {
      entry.runner.update();
      entry.age++;
    }
    return entry.runner.spriteFrame();
  }

  // Pseudo-3D stage background: STD quad instances, perspective-projected
  // (see Std#project for the world-space axis convention this relies on).
  // Each quad is transformed like the exe's AnmManager::Draw3 — a centered
  // local quad scaled to the STD size, rotated X->Y->Z by its ANM script,
  // anchor-shifted when the script sets op22 — subdivided along its local v
  // axis into strips for perspective-correct-enough texture mapping, painted
  // back-to-front per orderBgJobsByVisibility (pairwise ray ordering standing
  // in for the exe's z-buffer), with linear distance fog. autoRotate=2
  // scripts become camera-facing billboards with manual fog
  // (Stage::RenderObjects, Stage.cpp:1032-1103).
  private drawBackground(r: Renderer, ox: number, oy: number): void {
    const std = this.runtime.std;
    // Camera/fog use script time; quad textures use independent VM time.
    const frame = std.frame;
    const camFrame = std.cameraFrame(frame);
    const fog = std.fog(frame);
    const ctx = r.ctx;
    // The sky *is* the current fog color: clear to it every frame, then let
    // quads blend toward it with distance below.
    ctx.fillStyle = fog.css;
    ctx.fillRect(ox, oy, PLAYFIELD.width, PLAYFIELD.height);

    // FUN_00405a30 draws the primary VM, then secondary, before ordinary
    // stage geometry. Their ANM scripts carry screen-space positions.
    const primary = this.specialBgAnmFrame(0, std.primaryAnm);
    const secondary = this.specialBgAnmFrame(1, std.secondaryAnm);
    if (primary) r.drawAnmFrame(primary, 0, 0);
    if (secondary) r.drawAnmFrame(secondary, 0, 0);

    const playfield = { x: ox, y: oy, width: PLAYFIELD.width, height: PLAYFIELD.height };

    type Job = {
      frame: AnmFrame;
      // The exe splits objects across two draw chains by zLevel (0/1 in the
      // high-prio chain, 2/3 in the low one), but both chains share one D3D
      // z-buffer — so chain order only matters for depth ties. Here group is
      // the ordering fallback for pairs the ray test can't separate.
      group: number;
      // View-space depth of the quad center — the D3D vertex-fog metric and
      // the ordering fallback before group.
      sortZ: number;
      billboard: boolean;
      // World-space quad center and half extents; for billboards the center
      // is the un-anchored VM position the exe projects.
      cx: number;
      cy: number;
      cz: number;
      hw: number;
      hh: number;
      cosRx: number; sinRx: number;
      cosRy: number; sinRy: number;
      cosRz: number; sinRz: number;
    };

    // Gather every quad of every instance. Scratch corners are per-job
    // objects reused across cells — the per-strip projection below (and
    // Canvas2D itself) cheaply discards anything actually off-screen.
    const jobs: Job[] = [];
    for (const inst of std.instances) {
      const obj = std.objects[inst.id];
      if (!obj) continue;
      // Exe per-instance culling (Stage.cpp:989-1004): the object center
      // (object pos + instance pos + half the object size) must sit within
      // 1300 units of the camera and inside [60, size/2 + 880] along the
      // view axis; the 60-unit near bound doubles as the near-clip policy.
      const occX = obj.x + inst.x + obj.w / 2 - camFrame.x;
      const occY = obj.y + inst.y + obj.h / 2 - camFrame.y;
      const occZ = obj.z + inst.z + obj.d / 2 - camFrame.z;
      if (occX * occX + occY * occY + occZ * occZ > 1690000) continue;
      const objDot = occX * camFrame.fwdX + occY * camFrame.fwdY + occZ * camFrame.fwdZ;
      // TH08 Stage-1's ground slab is one large object the camera rides
      // inside (its instances span the whole stage); the TH07 far bound
      // (size/2 + 880) under-covers it. TH08's Stage.cpp uses the same
      // [60, size/2+880] window per Stage.cpp:989-1004, but the window
      // measures along the view axis from the camera — the slab's own half
      // extent keeps it inside. TH08's ground slab is bigger than TH07's,
      // so keep the axis window but scale it by the object's size.
      if (objDot < 60) continue;
      if (this.runState) {
        if (objDot > Math.hypot(obj.w, obj.h, obj.d) / 2 + 880) continue;
      } else if (objDot > Math.hypot(obj.w, obj.h, obj.d) / 2 + 880) continue;
      const group = obj.zLevel <= 1 ? 0 : 1;
      for (const quad of obj.quads) {
        if (quad.type !== 0) continue; // no other type exists in the data
        const frame = this.bgAnmFrame(quad.script, std.animationFrame);
        if (!frame || frame.alpha <= 0) continue;
        const w = quad.w !== 0 ? quad.w : frame.w * Math.abs(frame.scaleX);
        const h = quad.h !== 0 ? quad.h : frame.h * Math.abs(frame.scaleY);
        if (w <= 0 || h <= 0) continue;
        // The VM position is quad pos + instance pos + the script's offset
        // (Stage.cpp:1019-1021); Draw3 then anchor-shifts x/y (never z) when
        // op22 is set, so op22 quads extend from their position CORNER by
        // width/height while unanchored quads are centered (Stage 5's
        // treads/risers anchor; its balustrades and Stage 1/2's trees don't).
        const baseX = inst.x + quad.x + frame.posOffsetX;
        const baseY = inst.y + quad.y + frame.posOffsetY;
        const baseZ = inst.z + quad.z + frame.posOffsetZ;
        const billboard = frame.autoRotateMode === 2;
        const cx = billboard || !frame.anchorTopLeft ? baseX : baseX + w / 2;
        const cy = billboard || !frame.anchorTopLeft ? baseY : baseY + h / 2;
        jobs.push({
          frame,
          group,
          sortZ: std.viewDepth(cx, cy, baseZ, camFrame),
          billboard,
          cx, cy, cz: baseZ,
          hw: w / 2,
          hh: h / 2,
          cosRx: Math.cos(frame.rotationX), sinRx: Math.sin(frame.rotationX),
          cosRy: Math.cos(frame.rotationY), sinRy: Math.sin(frame.rotationY),
          cosRz: Math.cos(frame.rotation), sinRz: Math.sin(frame.rotation)
        });
      }
    }
    // The exe depth-tests every background pixel (shared z-buffer across both
    // zLevel chains); a Canvas2D painter must emulate that with draw order.
    // Center-depth sorting alone tore stage 5 apart — see
    // orderBgJobsByVisibility for the pairwise ray-ordering replacement.
    const ordered = orderBgJobsByVisibility(jobs, camFrame, playfield);

    const fogSpan = Math.max(1, fog.far - fog.near);
    const lateralExpand = 10; // world units; hides seams between laterally-adjacent tiles
    if (this.lastFogCells) this.lastFogCells = [];
    for (const job of ordered) {
      const rect = job.frame;
      const tint = (rect.color & 0x00ffffff) !== 0x00ffffff;
      const img = tint ? r.tintedRect(rect.imageKey, rect.x, rect.y, rect.w, rect.h, rect.color) : r.image(rect.imageKey);
      if (!img) continue;
      const srcX0 = tint ? 0 : rect.x;
      const srcY0 = tint ? 0 : rect.y;
      const flip = rect.scaleX < 0;

      if (job.billboard) {
        // Camera-facing quad: project the VM position, derive the screen
        // size from the perspective scale (both axes use the x factor,
        // Stage.cpp:1062-1063), anchor per DrawFacingCamera
        // (AnmManager.cpp:1146-1173), and fog manually by euclidean
        // distance — the exe disables hardware fog here and lerps
        // color/alpha itself (Stage.cpp:1065-1082). Drawing the texture at
        // alpha (1-t) and then the fog quad at alpha t over the fog-colored
        // sky composes to exactly that lerp.
        const pt = std.project(job.cx, job.cy, job.cz, camFrame, playfield);
        if (!pt) continue;
        const dx = job.cx - camFrame.x;
        const dy = job.cy - camFrame.y;
        const dz = job.cz - camFrame.z;
        const fogT = clamp((Math.sqrt(dx * dx + dy * dy + dz * dz) - fog.near) / fogSpan, 0, 1);
        if (fogT >= 1) continue;
        const wPx = job.hw * 2 * pt.scale;
        const hPx = (rect.h * (job.hw * 2 / Math.max(1, rect.w))) * pt.scale;
        const left = rect.anchorTopLeft ? pt.x : pt.x - wPx / 2;
        const top = rect.anchorTopLeft ? pt.y : pt.y - hPx / 2;
        if (left > ox + PLAYFIELD.width + 24 || left + wPx < ox - 24) continue;
        if (top > oy + PLAYFIELD.height + 24 || top + hPx < oy - 24) continue;
        const corners = {
          tl: { x: left, y: top }, tr: { x: left + wPx, y: top },
          bl: { x: left, y: top + hPx }, br: { x: left + wPx, y: top + hPx }
        };
        ctx.save();
        ctx.globalAlpha = (rect.alpha / 255) * (1 - fogT);
        ctx.globalCompositeOperation = rect.blendAdd ? 'lighter' : 'source-over';
        r.drawTexturedQuadCell(img, { u0: srcX0, v0: srcY0, u1: srcX0 + rect.w, v1: srcY0 + rect.h }, corners);
        if (fogT > 0.01) r.fillFogQuad(corners, fog.css, fogT);
        ctx.restore();
        continue;
      }

      // Project the four outer corners: screen-bounds cull plus the
      // subdivision metric. A quad straddling the near-clip plane (the tile
      // the camera is *currently* passing through — every ~256 units of
      // travel) must keep only its valid corners here; the per-cell
      // projection in the paint loop clips each strip individually.
      let valid = 0;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      const outer: Vec3 = { x: 0, y: 0, z: 0 };
      for (let s = 0; s < 4; s++) {
        bgQuadCorner(outer, (s & 1 ? 1 : -1) * job.hw, (s & 2 ? 1 : -1) * job.hh,
          job.cosRx, job.sinRx, job.cosRy, job.sinRy, job.cosRz, job.sinRz, job.cx, job.cy, job.cz);
        const p = std.project(outer.x, outer.y, outer.z, camFrame, playfield);
        if (!p) continue;
        valid++;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        const vz = std.viewDepth(outer.x, outer.y, outer.z, camFrame);
        if (vz < minZ) minZ = vz;
        if (vz > maxZ) maxZ = vz;
      }
      if (valid === 0) continue; // fully behind the camera
      if (valid === 4) {
        if (maxX < ox - 24 || minX > ox + PLAYFIELD.width + 24) continue;
        if (maxY < oy - 24 || minY > oy + PLAYFIELD.height + 24) continue;
      }
      const steps = Math.max(1, Math.min(BG_MAX_CELL_STEPS, Math.round(((maxZ - minZ) / Math.max(60, minZ)) * 14)));

      // Fraction of [0,1] each cell's *geometry* is expanded by (UV stays
      // clamped to the sprite — small decorative quads sit only a few px
      // apart in the atlas, so UV overflow would bleed in neighbors).
      // Canvas2D's antialiased fills otherwise leave hairline gaps between
      // adjacent cells and between instances stacked in depth, showing the
      // fog clear color through.
      const slack = 0.06 + 0.6 / steps;
      // UV is clamped to the sprite's own rect (unlike the geometry).
      const u0 = srcX0;
      const u1 = srcX0 + rect.w;
      const eu = job.hw + lateralExpand;
      const c0: Vec3 = { x: 0, y: 0, z: 0 };
      const c1: Vec3 = { x: 0, y: 0, z: 0 };
      const c2: Vec3 = { x: 0, y: 0, z: 0 };
      const c3: Vec3 = { x: 0, y: 0, z: 0 };

      ctx.save();
      ctx.globalAlpha = rect.alpha / 255;
      ctx.globalCompositeOperation = rect.blendAdd ? 'lighter' : 'source-over';

      for (let i = 0; i < steps; i++) {
        const t0 = i / steps - slack;
        const t1 = (i + 1) / steps + slack;
        const v0 = (t0 - 0.5) * job.hh * 2;
        const v1 = (t1 - 0.5) * job.hh * 2;
        bgQuadCorner(c0, -eu, v0, job.cosRx, job.sinRx, job.cosRy, job.sinRy, job.cosRz, job.sinRz, job.cx, job.cy, job.cz);
        bgQuadCorner(c1, eu, v0, job.cosRx, job.sinRx, job.cosRy, job.sinRy, job.cosRz, job.sinRz, job.cx, job.cy, job.cz);
        bgQuadCorner(c2, -eu, v1, job.cosRx, job.sinRx, job.cosRy, job.sinRy, job.cosRz, job.sinRz, job.cx, job.cy, job.cz);
        bgQuadCorner(c3, eu, v1, job.cosRx, job.sinRx, job.cosRy, job.sinRy, job.cosRz, job.sinRz, job.cx, job.cy, job.cz);
        const ptl = std.project(c0.x, c0.y, c0.z, camFrame, playfield);
        const ptr = std.project(c1.x, c1.y, c1.z, camFrame, playfield);
        const pbl = std.project(c2.x, c2.y, c2.z, camFrame, playfield);
        const pbr = std.project(c3.x, c3.y, c3.z, camFrame, playfield);
        if (!ptl || !ptr || !pbl || !pbr) continue;
        // Fog from the cell center's view-space depth: large tiles span a
        // visible slice of a fog transition (as short as ~300 units
        // near/far apart), so each cell gets its own alpha instead of
        // banding the whole quad at one value.
        bgQuadCorner(c0, 0, (v0 + v1) / 2, job.cosRx, job.sinRx, job.cosRy, job.sinRy, job.cosRz, job.sinRz, job.cx, job.cy, job.cz);
        const fogDepth = std.viewDepth(c0.x, c0.y, c0.z, camFrame);
        const fogAlpha = clamp((fogDepth - fog.near) / fogSpan, 0, 1);
        if (this.lastFogCells && (i & 1) === 0) {
          const mid = std.project(c0.x, c0.y, c0.z, camFrame, playfield);
          if (mid) this.lastFogCells.push({ x: Math.round(mid.x), y: Math.round(mid.y), depth: Math.round(fogDepth), fog: Math.round(fogAlpha * 100) / 100 });
        }
        // TH08 stage 1's fog window (near ~194, far 700) lies entirely inside
        // the ground band's depth (860+), so a fully-fogged-cell skip would
        // erase the whole floor; the native night-field floor is visible, so
        // the fogged cell draws instead (flagged: the exact TH08 fog metric
        // is unresolved without a native trace — see HANDOFF.md).
        const ct0 = clamp(t0, 0, 1);
        const ct1 = clamp(t1, 0, 1);
        const vLo = flip ? rect.h * (1 - ct1) : rect.h * ct0;
        const vHi = flip ? rect.h * (1 - ct0) : rect.h * ct1;
        r.drawTexturedQuadCell(img, { u0, v0: srcY0 + vLo, u1, v1: srcY0 + vHi }, { tl: ptl, tr: ptr, bl: pbl, br: pbr });
        if (fogAlpha > 0.01) r.fillFogQuad({ tl: ptl, tr: ptr, bl: pbl, br: pbr }, fog.css, fogAlpha);
      }
      ctx.restore();
    }
  }

  // Spellcard background: the scrolling eff01 sheet over the 3D scene while
  // a card is active. Open-coded from eff01.anm script 0 — cornerRel quad at
  // (32,16) sized 384x448 (a tiled view of the 256x256 texture), alpha
  // Spell-card playfield background (native: FUN_004152a0 arms two VMs from
  // the stage's eff0N.anm — archive script indices 0/1 — at spell start,
  // all.c:9093-9095). The authored scripts are full-playfield sheets
  // (384x448 corner-anchored at (32,16)) that fade in over 60 frames and
  // then tile-wrap their 256x256 texture with per-frame op26/27 UV scroll
  // (eff01: the eff01b sheet v+0.008333/frame, the eff01 sheet
  // v-0.002083/frame). Canvas has no GPU UV wrap, so scrolled frames draw
  // through a repeat-pattern fill.
  private drawSpellBackground(r: Renderer): void {
    if (!this.spellcard) return;
    for (const runner of this.spellBackgroundRunners) {
      const frame = runner.spriteFrame();
      if (!frame) continue;
      if (frame.scrollU !== 0 || frame.scrollV !== 0) this.drawWrappedFrame(r, frame);
      else r.drawAnmFrame(frame, 0, 0);
    }
  }

  // Draws an unscaled, unrotated, corner-anchored frame whose sprite rect
  // tile-wraps its texture (the eff0N spell sheets). scrollU/V are
  // texture-fraction UV shifts: +v moves the sample window down, i.e. the
  // content moves UP on screen.
  // CanvasPatterns are immutable per source image — creating one per frame
  // per spell sheet is pure allocator churn during every spell.
  private wrapPatternCache = new Map<string, CanvasPattern | null>();

  private drawWrappedFrame(r: Renderer, frame: AnmFrame): void {
    const img = r.image(frame.imageKey);
    if (!img) return;
    const ctx = r.ctx;
    let pattern = this.wrapPatternCache.get(frame.imageKey);
    if (pattern === undefined) {
      pattern = ctx.createPattern(img, 'repeat');
      this.wrapPatternCache.set(frame.imageKey, pattern);
    }
    if (!pattern) return;
    ctx.save();
    ctx.globalAlpha = frame.alpha / 255;
    if (frame.blendAdd) ctx.globalCompositeOperation = 'lighter';
    const ox = frame.scrollU * img.width;
    const oy = frame.scrollV * img.height;
    ctx.translate(frame.vmX - ox, frame.vmY - oy);
    ctx.fillStyle = pattern;
    ctx.fillRect(ox, oy, frame.w, frame.h);
    ctx.restore();
  }

  // Enemy spell declaration portrait (face_stNN entry 0). Native captures
  // at stage-1 f3415..3540 show no teal full-playfield flash: the old flat
  // capture.anm stand-in was a visible invention, so only authored art is
  // drawn here.
  private drawSpellDeclaration(r: Renderer): void {
    if (!this.spellcard) return;
    // The authored declaration portrait VM (face_stNN entry 0) replaces the
    // hand-rolled sweep: sprite/position/alpha/timing all data-driven; it
    // self-removes at the authored 150-frame end.
    const frame = this.spellDeclPortraitRunner?.spriteFrame() ?? null;
    if (frame) r.drawAnmFrame(frame, 0, 0);
  }

  // Effect 39 (DAT_004c6d30[39] -> etama archive script 76) is not an
  // ordinary sprite. The script selects sprite221: a 16x768 surface over a
  // 16x128 texture (six vertical repeats), while its FUN_004272e0 callback
  // bends that strip around the boss. Native stage-1 captures f3415..3540
  // show the initial radial streaks and the ring settling to radius ~240;
  // script76 supplies the 70f alpha ramp and its 192->15 scale tween ends at
  // 120f (15*16 = the settled 240px radius).
  private drawSpellRing(r: Renderer, ox: number, oy: number): void {
    const ring = this.spellRing;
    const sc = this.spellcard;
    const img = r.image('etama3');
    if (!ring || !sc || !img) return;
    const age = Math.max(0, sc.declAge);
    const settle = Math.min(1, age / 120);
    // The authored effect-39 scale interp is 192->15 over the 120-frame
    // settle (etama archive script 76). At the measured declaration-time
    // ~600px screen radius that is 3.125 px per scale unit, so the ring
    // SHRINKS ONTO THE BOSS and spins there for the card's duration (the
    // native look) instead of parking at a playfield-wide 240px annulus.
    const radius = SPELL_RING_SETTLED_RADIUS + (600 - SPELL_RING_SETTLED_RADIUS) * (1 - settle);
    // The script's fade-in tops out at the authored alpha 192 (of 255).
    const alpha = Math.min(1, age / 70) * (192 / 255);
    if (alpha <= 0) return;
    // FUN_004152a0 arms the VM on the boss (all.c:9110-9126) and the slot VM
    // rides its owner: follow the live boss, not the declaration snapshot.
    const boss = this.bossActive;
    if (boss) {
      ring.x = boss.x;
      ring.y = boss.y;
    }
    const cx = ox + ring.x;
    const cy = oy + ring.y;
    const ctx = r.ctx;
    const spin = age * 0.0025;
    // Past the settle the radius is constant and only the spin advances:
    // blit a pre-rendered annulus instead of 96 rotated quads per frame
    // (the top per-frame draw cost of long cards). §7: the bake composites
    // the segments with 'lighter' INSIDE the offscreen, so overlaps
    // accumulate in premultiplied sRGB rather than against the live
    // playfield — visually equivalent for this annulus, not byte-identical.
    // The settle frame itself (age exactly 120) keeps the segmented path so
    // the boundary frame stays byte-identical, and headless node probes
    // without a DOM fall back to the segmented draw.
    if (age > 120 && typeof document !== 'undefined') {
      let cache = this.spellRingCache;
      if (!cache) {
        cache = this.bakeSpellRing(img);
        this.spellRingCache = cache;
      }
      if (cache) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha;
        ctx.translate(cx, cy);
        ctx.rotate(spin);
        ctx.drawImage(cache, -cache.width / 2, -cache.height / 2);
        ctx.restore();
        return;
      }
    }
    const repeats = 6; // sprite221 height 768 / etama3 height 128
    const segmentsPerRepeat = 16;
    const segments = repeats * segmentsPerRepeat;
    const sliceH = 128 / segmentsPerRepeat;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    // Before the annulus reaches the playfield, the same texture is stretched
    // into the radial rays visible in native f3430..3505.
    if (age < 120) {
      ctx.globalAlpha = alpha * (1 - age / 120) * 0.65;
      for (let i = 0; i < repeats * 8; i++) {
        const angle = (i / (repeats * 8)) * Math.PI * 2 + spin;
        const sy = (i % segmentsPerRepeat) * sliceH;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.drawImage(img, 0, sy, 16, sliceH, 16, -1.5, Math.max(1, radius - 16), 3);
        ctx.restore();
      }
      ctx.globalAlpha = alpha;
    }
    const arc = (Math.PI * 2 * radius) / segments + 1;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2 + spin;
      const sy = (i % segmentsPerRepeat) * sliceH;
      ctx.save();
      ctx.translate(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.rotate(angle);
      ctx.drawImage(img, 0, sy, 16, sliceH, -8, -arc / 2, 16, arc + 1);
      ctx.restore();
    }
    ctx.restore();
  }

  private spellRingCache: HTMLCanvasElement | null = null;

  private bakeSpellRing(img: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement | null {
    const radius = SPELL_RING_SETTLED_RADIUS;
    const size = Math.ceil(radius + 24) * 2;
    const surface = document.createElement('canvas');
    surface.width = size;
    surface.height = size;
    const c = surface.getContext('2d');
    if (!c) return null;
    c.translate(size / 2, size / 2);
    c.globalCompositeOperation = 'lighter';
    const repeats = 6;
    const segmentsPerRepeat = 16;
    const segments = repeats * segmentsPerRepeat;
    const sliceH = 128 / segmentsPerRepeat;
    const arc = (Math.PI * 2 * radius) / segments + 1;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const sy = (i % segmentsPerRepeat) * sliceH;
      c.save();
      c.translate(Math.cos(angle) * radius, Math.sin(angle) * radius);
      c.rotate(angle);
      c.drawImage(img, 0, sy, 16, sliceH, -8, -arc / 2, 16, arc + 1);
      c.restore();
    }
    return surface;
  }

  private drawSpellOverlay(r: Renderer): void {
    if (!this.spellName) return;
    const sc = this.spellcard;
    const declAge = sc?.declAge ?? 999;
    const ctx = r.ctx;
    // Declaration window: the runtime text surface is unavailable, but the
    // native f3430/f3445 captures pin its presentation — two thin red lines
    // (not a solid ribbon), muted red name, white ungrouped Bonus/history.
    // It moves to the top between declaration ages 90..120.
    const declPhase = Math.min(1, Math.max(0, (declAge - 90) / 30));
    const slideIn = Math.min(1, declAge / 20);
    const bannerY = PLAYFIELD.y + 300;
    const restY = PLAYFIELD.y + 12;
    const y = bannerY + (restY - bannerY) * declPhase;
    const xRest = PLAYFIELD.x + PLAYFIELD.width - 12;
    const xBanner = PLAYFIELD.x + PLAYFIELD.width - 16 + (1 - slideIn) * 120;
    const x = xBanner + (xRest - xBanner) * declPhase;
    if (declPhase < 1) {
      const bannerAlpha = (1 - declPhase) * slideIn;
      const grad = ctx.createLinearGradient(PLAYFIELD.x, 0, PLAYFIELD.x + PLAYFIELD.width, 0);
      grad.addColorStop(0, 'rgba(128,48,48,0)');
      grad.addColorStop(0.48, 'rgba(192,112,112,0.35)');
      grad.addColorStop(1, 'rgba(232,176,176,0.8)');
      ctx.save();
      ctx.globalAlpha = bannerAlpha;
      ctx.fillStyle = grad;
      ctx.fillRect(PLAYFIELD.x, y + 3, PLAYFIELD.width, 1);
      ctx.fillRect(PLAYFIELD.x, y + 7, PLAYFIELD.width, 1);
      ctx.restore();
    }
    r.text(this.spellName, x + 1, y + 1, { size: 15, color: 'rgba(24,8,12,0.85)', align: 'right' });
    r.text(this.spellName, x, y, { size: 15, color: '#d89898', align: 'right' });
    if (sc) {
      const tally = this.spellHistory.get(sc.id);
      const history = tally ? `  history ${tally.got}/${tally.seen}` : '';
      const bonusText = sc.capturing ? `Bonus ${Math.round(sc.bonus)}${history}` : `Bonus failed${history}`;
      r.text(bonusText, x, y + 18, { size: 11, color: sc.capturing ? '#fff' : '#977', align: 'right' });
    }
  }

  // TH08 dialogue presentation: the four portrait VMs draw themselves from
  // their authored scripts (corner-anchored, screen-space positions), each
  // side's pair ordered by VM Y like the native FUN_0043542b, with the
  // per-slot height compensation stored by MSG ops 1/2. Text is
  // canvas-rendered (flagged approximation until the msg text VM art is
  // decoded, same trade the TH07 dialogue made).
  private drawTh08Dialogue(r: Renderer): void {
    const dlg = this.th08Dialogue;
    if (!dlg) return;
    const state = dlg.machine.state;
    for (const [a, b] of ([[0, 1], [2, 3]] as const)) {
      const frameA = dlg.runners[a]?.spriteFrame() ?? null;
      const frameB = dlg.runners[b]?.spriteFrame() ?? null;
      // FUN_0043542b compares the two VMs' Y positions and draws the
      // smaller one first so the lower sprite overlaps in front.
      const aBehind = !frameB || (!!frameA && frameA.vmY <= frameB.vmY);
      const ordered: [AnmFrame | null, number][] = aBehind
        ? [[frameA, a], [frameB, b]]
        : [[frameB, b], [frameA, a]];
      for (const [frame, slot] of ordered) {
        if (frame) r.drawAnmFrame(frame, 0, 0, { offsetY: dlg.portraitOffsets[slot] });
      }
    }
    const ctx = r.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(8, 6, 16, 0.82)';
    ctx.fillRect(48, 336, 544, 130);
    ctx.strokeStyle = 'rgba(160, 140, 200, 0.6)';
    ctx.strokeRect(48.5, 336.5, 543, 129);
    ctx.restore();
    for (let i = 0; i < state.lines.length; i++) {
      const line = state.lines[i];
      if (line) r.text(line, 72, 362 + i * 30, { size: 20, color: '#f0eaf5' });
    }
    if (this.dialogueBossIntroLine) {
      // text.anm script 1 anchors this dedicated line at (75,410). The
      // original typesets it into the runtime '@' texture; canvas text is
      // the established browser equivalent for decoded MSG payloads.
      r.text(this.dialogueBossIntroLine, 75, 410, { size: 17, color: '#f0eaf5' });
    }
  }

  // Vanilla stage intro: runs stdNtxt.anm's four scripts verbatim — the
  // "Stage N" label, the big title, the flavor strip, and the bottom
  // stage-theme BGM credit — all positioned in screen coordinates by the
  // scripts themselves (see the constructor note for the exe arming site
  // and per-script roles). Runners self-remove around frame 550.
  private drawStageTitle(r: Renderer): void {
    for (const runner of this.stageIntroRunners) {
      if (runner.removed) continue;
      r.drawAnmFrame(runner.spriteFrame(), 0, 0);
    }
    const bgm = this.dialogueBgmRunner;
    if (bgm && !bgm.runner.removed) {
      const frame = bgm.runner.spriteFrame();
      const sprite = this.stdTxtAnm.sprites.get(bgm.spriteIndex);
      if (frame && sprite) {
        // SetSprite changes only the texture rectangle; the script's motion,
        // alpha, blend and position remain untouched.
        r.drawAnmFrame({
          ...frame,
          x: sprite.x,
          y: sprite.y,
          w: sprite.w,
          h: sprite.h
        }, 0, 0);
      }
    }
  }

  // TH08 sidebar (front.anm entry-0 label scripts -25..-18, on-disk ids;
  // sequential indices 2..9 per TH08_HUD_FIELDS). The runners position
  // themselves at their authored resting coordinates (x~416-448 column).
  private th08HudRunners: AnmRunner[] | null = null;

  private ensureTh08HudRunners(): void {
    if (this.th08HudRunners) return;
    const front = this.assets.anms.front;
    if (!front) return;
    const base = front.entries[0].spriteBase;
    const mk = (script: number) =>
      new AnmRunner(front, script, { entryIndex: 0, spriteIndexOffset: base });
    // logo (-27), caption (-26), then the eight value labels (-25..-18).
    this.th08HudRunners = [-27, -26, -25, -24, -23, -22, -21, -20, -19, -18].map(mk);
  }

  private tickTh08HudRunners(): void {
    this.ensureTh08HudRunners();
    if (!this.th08HudRunners) return;
    for (const runner of this.th08HudRunners) {
      if (!runner.removed) runner.update(this.slowRate);
    }
  }

  private drawSidebarTh08(r: Renderer): void {
    this.ensureTh08HudRunners();
    if (!this.th08HudRunners) return;
    const p = this.playerObj;
    const run = this.runState;
    const valueX = 488; // TH08_HUD_FIELDS value column
    // VMs tick from update(); draw only blits the current pose.
    // Logo panel + caption (authors' own positions, 480,208 / 448,336).
    r.drawAnmFrame(this.th08HudRunners[0].spriteFrame(), 0, 0);
    r.drawAnmFrame(this.th08HudRunners[1].spriteFrame(), 0, 0);
    for (let i = 2; i < this.th08HudRunners.length; i++) {
      r.drawAnmFrame(this.th08HudRunners[i].spriteFrame(), 0, 0);
    }
    // TH08's /10 score rule means the live field already reads at display
    // scale — no appended zero (unlike TH07's "%8d0"). Native rows (exe
    // DrawGameScene FUN_0043625d, floats 0x4b432c/0x4b42a8): HiScore at
    // y=40, Score at y=56, both "%.9d" at x=488.
    this.drawNumber(r, Math.max(this.hiScore, this.score), valueX, 40, 9, 1, TH08_ADV);
    this.drawNumber(r, this.score, valueX, 56, 9, 1, TH08_ADV);
    // Lives/bombs icons: front.png 16x16 pair at (64,80)/(80,80), 16px pitch,
    // rows y88/y104 (GuiImpl draw: 488+i*16 @ 88/104, draw-game-scene.c:162-192).
    for (let i = 0; i < Math.max(0, p.lives); i++) {
      this.blit(r, 'front', TH08_ICON_LIFE, valueX + i * 16, 88);
    }
    for (let i = 0; i < Math.max(0, p.bombs); i++) {
      this.blit(r, 'front', TH08_ICON_BOMB, valueX + i * 16, 104);
    }
    const ctx = r.ctx;
    // Power row (y136): the native bar is a single 16px-tall quad from
    // (488,136) to (488+power,152), left color 0xe0e0e0ff fading to
    // 0x80e0e0ff (D3DCOLORs, all.c:25805-25861) — no background track. The
    // "%d" value, or "MAX" at 128, prints over it at (488,136)
    // (all.c:25863-25874).
    const barW = Math.min(128, Math.max(0, p.power));
    if (barW > 0) {
      const grad = ctx.createLinearGradient(valueX, 136, valueX + barW, 136);
      grad.addColorStop(0, 'rgba(224,224,255,0.878)');
      grad.addColorStop(1, 'rgba(224,224,255,0.502)');
      ctx.save();
      ctx.fillStyle = grad;
      ctx.fillRect(valueX, 136, barW, 16);
      ctx.restore();
    }
    if (p.power >= 128) r.text('MAX', valueX + 2, 138, { size: 11, color: '#fff' });
    else this.drawNumber(r, p.power, valueX + 2, 138, 0, 1, TH08_ADV);
    this.drawNumber(r, this.graze, valueX, 152, 0, 1, TH08_ADV);
    // Point row (y168): items toward the next extend, native "%d/%d" with
    // the slash at x+digits*13 (half-scale) and the threshold 6px past it
    // (all.c:25756-25773, digit advance 13, slash dx 6 @ 0x4b497c).
    const afterItems = this.drawNumber(r, this.pointItems, valueX, 168, 0, 1, TH08_ADV);
    r.text('/', afterItems, 170, { size: 8, color: '#ddd' });
    this.drawNumber(r, run.nextPointItemExtendThreshold, afterItems + 6, 168, 0, 1, TH08_ADV);
    // Time row (y184): the stage's time-orb progress toward the
    // stage+difficulty quota (DAT_004c77f0). The whole row tints
    // 0xfffff0c0 once the quota is met (all.c:25780-25798).
    const quota = TH08_STAGE_ORB_QUOTAS[this.stageNumber - 1]?.[this.difficulty] ?? 0;
    if (quota > 0 && run.stageTimeOrbs >= quota) {
      r.text(`${run.stageTimeOrbs}/${quota}`, valueX, 186, { size: 12, color: '#fff0c0' });
    } else {
      const afterOrbs = this.drawNumber(r, run.stageTimeOrbs, valueX, 184, 0, 1, TH08_ADV);
      r.text('/', afterOrbs, 186, { size: 8, color: '#ddd' });
      this.drawNumber(r, quota, afterOrbs + 6, 184, 0, 1, TH08_ADV);
    }
    // Difficulty tag: AsciiManager VM script 25, ascii.anm sprite 283+difficulty
    // (the sprite's texture entry is pause.png),
    // corner-anchored at (552,200); alpha 0 until t=60, fades in over 20
    // frames, then holds (armed at stage load, all.c:26916-26923).
    {
      const rect = TH08_DIFFICULTY_TAG.rects[this.difficulty] ?? TH08_DIFFICULTY_TAG.rects[1];
      const alpha = Math.max(0, Math.min(1, (this.stageFrame - 60) / 20));
      if (alpha > 0) {
        this.blit(
          r, TH08_DIFFICULTY_TAG.imageKey, rect,
          TH08_DIFFICULTY_TAG.position.x, TH08_DIFFICULTY_TAG.position.y, alpha
        );
      }
    }
    // Human/youkai rate gauge. These are ascii.anm scripts 5-8 verbatim:
    // the authored plate and limit icons are top-left anchored, while the
    // triangular script-8 cursor is center anchored at the live gauge value.
    // The previous implementation replaced all four with a thick rectangle,
    // invented threshold notches, and prefixed 人/妖 to the percentage.
    {
      const gauge = TH08_FORM_GAUGE;
      const g = run.youkaiGauge;
      this.blit(r, gauge.imageKey, gauge.plate.rect,
        gauge.plate.position.x, gauge.plate.position.y);
      this.blit(r, gauge.imageKey, gauge.human.rect,
        gauge.human.position.x, gauge.human.position.y);
      this.blit(r, gauge.imageKey, gauge.youkai.rect,
        gauge.youkai.position.x, gauge.youkai.position.y);

      const cursorX = formGaugeCursorX(g);
      r.drawSprite(gauge.imageKey,
        gauge.cursor.rect[0], gauge.cursor.rect[1], gauge.cursor.rect[2], gauge.cursor.rect[3],
        cursorX, gauge.cursor.centerY);

      const pct = `${(g / 100).toFixed(2)}%`;
      const pctColor = g <= -8000 ? 0x8080ff : g >= 8000 ? 0xff80c0 : 0xffffff;
      this.drawGaugeText(r, pct, formGaugePercentX(g, pct.length), gauge.percentY, pctColor);

      const pointText = String(Math.max(0, Math.trunc(run.pointItemValue)));
      this.drawGaugeText(r, pointText,
        gauge.pointValueCenterX - pointText.length * DIGIT_W / 2,
        gauge.pointValueY);
    }

    // Native boss HP strip (geometry/colors in TH08_HUD.bossLifebar,
    // measured on the native demo captures; fill drains right-to-left).
    // The strip shows the CURRENT PHASE segment, not the whole-fight life:
    // it refills to full at every nonspell/spell entry (phaseHpCeiling is
    // re-latched at each ins_131 arm and callback clamp) and drains to the
    // next armed ins_133 threshold — one attack = one full bar drain.
    if (this.bossActive) {
      const boss = this.bossActive;
      const bar = TH08_HUD.bossLifebar;
      const hp = Math.max(0, boss.hp);
      const frac = bossLifebarFillRatio(
        hp, boss.phaseHpCeiling || boss.maxHp, boss.ecl.lifeThresholds
      );
      const px = (n: number): string =>
        `#${((n >> 24) & 0xff).toString(16).padStart(2, '0')}${((n >> 16) & 0xff).toString(16).padStart(2, '0')}${((n >> 8) & 0xff).toString(16).padStart(2, '0')}`;
      ctx.fillStyle = px(bar.emptyColor);
      ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      ctx.fillStyle = px(bar.fillColor);
      ctx.fillRect(bar.x, bar.y, bar.width * frac, bar.height);
    }
  }

  private drawSidebar(r: Renderer): void {
    this.drawSidebarTh08(r);
  }

  // Practice tag, straight from pause.png (the difficulty tag moved to the
  // sidebar's ascii.anm script-25 slot at (552,200) — see drawSidebarTh08).
  // The original's practice-mode marker position is unrecovered; this keeps
  // the long-standing bottom-right slot as a mode marker (PROBABLE).
  private drawModeTags(r: Renderer): void {
    if (this.mode === 'practice') this.blit(r, 'pause', [192, 240, 64, 16], 344, 428, 0.9);
  }
}
