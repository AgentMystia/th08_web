import { advanceBulletExBehavior, StageRuntime, type StageData } from './eclvm';
import type {
  GameHost, Enemy, EnemyBullet, EnemyLaser, ItemEntity, ItemType,
  EffectParticle, ReplayTraceSink
} from './types';
import { Rng } from '../core/rng';
import {
  normalizeAngle, normalizeNativeAngleF32, clamp, NATIVE_PI_F32
} from '../core/util';
import type { InputFrame } from '../core/input';
import { Renderer, PLAYFIELD, SCREEN_W } from '../gfx/renderer';
import type { GameAssets } from './assets';
import { Anm, AnmRunner, type AnmFrame } from '../formats/anm';
import { bgQuadCorner, orderBgJobsByVisibility, type Vec3 } from '../formats/std';
import { TH08_DATA } from '../data/th08-data';
import type { AudioBus } from '../audio/audio';
import {
  Player, type Th08TeamId, type PlayerBullet
} from './player';
import { PlayerEffects, type PlayerEffectHandle } from './player-effects';
import { Th08RunState } from './th08-state';
import { Th08SeekingOptionShot } from './th08-option-shot';
import { Th08BorderBomb, TH08_BOMB_INVULN, type Th08BombHost } from './th08-border-bombs';
import { Th08SpellDeclaration, th08BombSpellName, archiveScript } from './th08-declaration';
import { Th08ItemSpawnPool } from './th08-item-spawn';
import { Th08DialogueMachine, TH08_DIALOGUE_INPUT_BITS } from './th08-dialogue';
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

// The stage time-orb quotas (.data 0x4c77f0, per stage and difficulty):
// the tally's clock-advance switch (FUN_0043c35f) and the HUD Time row
// both read this table. Extra's row reads 0.
export const TH08_STAGE_ORB_QUOTAS: readonly (readonly number[])[] = [
  [2000, 2500, 2700, 3000],
  [6500, 7200, 7200, 7200],
  [7500, 8500, 8800, 8800],
  [9999, 9999, 9999, 9999],
  [7500, 8500, 8500, 8500],
  [9999, 9999, 9999, 9999],
  [0, 0, 0, 0]
];

// TH08 ItemType enum (ItemManager.hpp:9-21) in declaration order; the item's
// etama.anm visual script is 61 + id (ItemManager.cpp:112).
const TH08_ITEM_TYPE_IDS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TH08_ITEM_TYPE_SLOT: Partial<Record<ItemType, number>> = {
  powerSmall: 0, point: 1, powerBig: 2, bomb: 3, powerFull: 4, extend: 5,
  pointStar: 6, time: 7, pointSmall: 8, unknown9: 9, time2: 10
};
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
const EFFECT_DRAW_COST: Record<number, number> = {
  // Th07.exe v1.00b effect table + etama.anm entry-scoped scripts.
  0: 0, 1: 0, 2: 0,
  3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4, 11: 4,
  // Effect 12 (g_EffectMapping[12] = {0x2bb, NULL, NULL}) has no callbacks
  // and its ANM script contains no random ops: zero draws. The four raw
  // u16s observed on the death frame are Die()'s RegenerateGameIntegrityCsum,
  // not this effect (see onPlayerHit).
  12: 0, 13: 0, 14: 0, 15: 0,
  17: 6, 18: 6, 20: 22, 22: 6, 23: 0,
  26: 14, 27: 12, 29: 6, 30: 16, 31: 16, 32: 6, 33: 6,
  // TH08 effect 51 (the stage-1 ambient firefly family, etama script 73):
  // five ANM random ops (2x ins_60 float + 3x ins_59 int) at two u16 draws
  // each (Global.hpp GetRandomF32/U32InRange).
  51: 10
};
const ENEMY_POOL_CAP = 0x1e0;
const PLAYER_BULLET_POOL_CAP = 0x60;
const ENEMY_BULLET_POOL_CAP = 0x400;
const BOMB_CLEAR_REGION_CAP = 0x60;
const EFFECT_POOL_CAP = 400;
// TH08's effect pool is 512 slots (FUN_00425430's 0x200-slot scan with 0xd8
// strides), TH07's 400. The slot array sizes to the superset; the cursor
// loops below cap at this field.
const EFFECT_POOL_CAP_TH08 = 512;
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
  24: Infinity, 26: 300, 27: 300, 29: 30, 30: 300, 31: 300,
  32: 90, 33: 120,
  // TH08 effect 51: etama script 73 removes at frame 241.
  51: 241
};

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

// face_st01 entry 0 is Wriggle's full-height declaration portrait.
// The sprite table contains it at global sprite id 0.
const STAGE1_BOSS_PORTRAIT_SPRITE = 0;

export class StageScene implements GameHost {
  // Installed only by replay-verification tooling.
  traceReplayEvent?: ReplayTraceSink;
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
  th08Dialogue: { machine: Th08DialogueMachine; runners: (AnmRunner | null)[] } | null = null;
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
    portraitSprite: number;
  } | null = null;
  // Stage 5 owns two spell-background VMs from eff05.anm. Unlike the
  // simpler scrolling sheets, both receive bullet-time interrupt 2/1 from
  // FUN_00418020/FUN_00418130 and must remain real ANM runners so their
  // authored tint, additive blend, scale and rotation transitions survive.
  private spellBackgroundRunners: AnmRunner[] = [];
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
  private eff01Pattern: CanvasPattern | null = null;

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
  // The active bomb form's decoded state machine (12 forms, player-bombs.ts).
  private th08Bomb: Th08BorderBomb | null = null;
  // Enemy-manager target caches (Th08.exe writes them through the absolute
  // globals 0x18b899c/0x18b89a8/0x18b89b4 in the per-enemy pass at
  // 0x42d3d3-0x42d4df): the primary position cache prefers the LOWEST
  // enemy (max y, first-slot tiebreak) and feeds the seeker tick
  // (FUN_00450320) and the human bomb's orb seek; the pointer-cache pick
  // (|x-224| <= 64, upper-most/first) feeds the familiar's lunge anchor and
  // the needle shots' spawn aim (FUN_00450240 reads enemy+0x2d34/+0x2d38).
  private th08TargetPos: { x: number; y: number } | null = null;
  private th08LungeEnemy: { x: number; y: number } | null = null;
  // Frames the shot cycle has stayed disarmed (the idle-drift 30-frame gate,
  // 0x44bf22 Compare(timerB, 0x1e)).
  private th08IdleFrames = 0;
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
    // Stage-intro title: stdNtxt.anm scripts 0-3 are the full vanilla
    // presentation with positions/slides/fades baked in, in 640x480 SCREEN
    // coordinates (the playfield sits at +32,+16 like the original):
    // script0 = stage crest (128x128, add-blend), 1 = vertical JP title
    // (rotated pi/2, drifts right), 2 = "Stage N", 3 = subtitle strip; the
    // vertical BGM label rises separately via the dialogue BGM runner. All
    // finish and self-remove by ~frame 460.
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
    // same-type items pulse in phase-locked sync (the stage-1 item scripts
    // consume no RNG, so the shared runner is draw-order neutral).
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
          spriteIndexOffset: entry.spriteBase,
          rng: this.rng
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

  // TH08 Stage-1 clear bonus (Gui update around Th08.exe 0x437000):
  //   award = 1,000,000 + stageGraze*50 + stagePointItems*5000
  //           + currentTimeOrbs*100
  // followed by the integer difficulty and configured-lives multipliers.
  // The original credits the same award ten times through FUN_004181f0;
  // each call adds floor(award/10) to the stored score.
  private computeClearBonus(): void {
    const stageGraze = this.graze - this.stageEntryGraze;
    const stagePointItems = this.pointItems - this.stageEntryPointItems;
    const timeOrbs = this.runState.currentTimeOrbs;
    const clearAward = 1000000;
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
    this.playerEffects.clear();
    this.th08Effects.clear();
    this.screenShakes.length = 0;
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

  // Screen FX scheduler (exe FUN_004459c0). Type 1 shake: each frame both
  // camera axes independently pick {0, +mag, -mag}, mag ramping from->to
  // over the duration. Type 3 flash: a full-screen tint held `duration`
  // frames, repeated `repeats` times, alpha from the ARGB high byte.
  private readonly screenShakes: { duration: number; elapsed: number; from: number; to: number }[] = [];
  private screenFlash: { duration: number; timer: number; repeats: number; color: number } | null = null;
  private shakeX = 0;
  private shakeY = 0;

  startScreenShake(duration: number, from: number, to: number): void {
    // FUN_004459c0 allocates one scheduler object per request. Concurrent
    // shakes therefore retain independent clocks/RNG draws instead of a new
    // request replacing the previous one (native Phantasm PRE10485/10486).
    this.screenShakes.push({ duration: Math.max(1, duration), elapsed: 0, from, to });
  }

  startScreenFlash(duration: number, repeats: number, argb: number): void {
    this.screenFlash = { duration: Math.max(1, duration), timer: 0, repeats, color: argb >>> 0 };
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
  private spawnItemTh08(type: ItemType, x: number, y: number, options: { state?: number; vx?: number; vy?: number; tweenTarget?: { tx: number; ty: number } }): void {
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
    this.insertByPoolSlot(this.items, item);
    this.traceReplayEvent?.({
      kind: 'item-spawn', frame: this.frame,
      data: { type: item.type, slot: item.poolSlot, x: item.x, y: item.y, state: item.state }
    });
  }

  spawnItem(type: ItemType, x: number, y: number, options: { state?: number; vx?: number; vy?: number; tweenTarget?: { tx: number; ty: number } } = {}): void {
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
    for (let tries = 0, remaining = requested; tries < this.effectPoolCap && remaining > 0; tries++) {
      const slot = this.effectPoolCursor;
      this.effectPoolCursor = (this.effectPoolCursor + 1) % this.effectPoolCap;
      if (this.effectSlots[slot] !== null) continue;

      let particle: EffectParticle;
      if (effectId === 20 || effectId === 26 || effectId === 27 ||
          effectId === 30 || effectId === 31) {
        // Th07.exe DAT_00494fb0: ids 20/26/27/30/31 all install
        // FUN_0041a050 as their per-frame gate. Their spawn initializers are
        // FUN_0041a210/a600/a8d0/ab50/ad80 respectively. They are genuine
        // world-space particles, not fixed 300-frame screen sprites: omitting
        // the shared camera-cone/ground gate left hundreds of stale id30/31
        // slots alive in Stage 5 and changed which later RNG-visible effects
        // the rolling 400-slot allocator could accept.
        const camera = this.runtime.std.camera();
        const facing = this.runtime.std.facing();
        const r = (): number => this.rng.f();
        const scaled = (value: number): number => Math.fround(Math.fround(value) * this.slowRate);
        const origin = (dx: number, dy: number, dz: number) => ({
          x: Math.fround(camera.x + facing.x / 2 + dx),
          y: Math.fround(camera.y + facing.y / 2 + dy),
          z: Math.fround(camera.z + facing.z / 2 + dz)
        });
        const launchX = Math.fround(seed?.x ?? 0);
        const launchY = Math.fround(seed?.y ?? 0);
        const launchZ = Math.fround(seed?.z ?? 0);
        let pos: { x: number; y: number; z: number };
        let vx: number;
        let vy: number;
        let vz: number;
        let ax = 0;
        let ay = 0;
        let az = 0;
        if (effectId === 20) {
          // FUN_0041a210: ten frand calls plus one u32 tint branch.
          pos = origin(r() * 120 - 60, r() * 200 - 100, r() * 100 - 100);
          vx = scaled(launchX + r() * 0.06 - 0.03);
          vy = scaled(launchY + r() * 0.06 - 0.03);
          vz = scaled(launchZ + r() * 0.1 + 0.03);
          ax = scaled(r() * 0.0002 - 0.0001);
          ay = scaled(r() * 0.0002 - 0.0001);
        } else if (effectId === 26 || effectId === 27) {
          // FUN_0041a600 / FUN_0041a8d0. The caller's launch-x is the
          // authored orbital divisor (+0x258); real stage data keeps it
          // non-zero. Both variants bake slowRate into their velocity once.
          const dx = Math.fround(r() * 160 - 80);
          const dy = Math.fround(r() * 160 - 80);
          // Both FUN_0041a600 and FUN_0041a8d0 stage world Z as
          // frand*100-50 (Th07.exe v1.00b @ 0x41a632 / 0x41a8ee). The old
          // -frand-50 collapsed every particle into a one-unit slab, making
          // id27 leave the shared 400-slot pool far too early. At Stage-4
          // PRE17527 that exposed 24 false free slots and admitted eight
          // extra RNG-visible id17 particles.
          pos = origin(dx, dy, Math.fround(r() * 100 - 50));
          vx = scaled(-dy / launchX);
          vy = scaled(dx / launchX);
          vz = scaled(effectId === 26 ? r() * 0.1 + 0.09 : -(r() * 0.2) - 0.06);
          // FUN_0041a600 has one additional unconditional u32 tint branch.
          // It occurs after the two angle draws below.
        } else if (effectId === 30) {
          // FUN_0041ab50 deliberately does not slowRate-scale its launch
          // vector; its per-frame manager clock supplies the rate behavior.
          // Th07.exe (v1.00b) @ 0x41aba1-0x41abb0 stages world Z as
          // frand*100-100. The old 1-frand range kept Extra snow inside the
          // camera cone for the wrong lifetime and silently changed fixed-
          // pool pressure before PRE10621.
          pos = origin(r() * 160 - 80, r() * 160 - 80, r() * 100 - 100);
          vx = Math.fround(launchX + r() * 0.06 - 0.03);
          vy = Math.fround(launchY + r() * 0.06 - 0.03);
          vz = Math.fround(launchZ + r() * 0.02 + 0.01);
        } else {
          // FUN_0041ad80 (id31): falling world flakes with a constant
          // -0.015 z acceleration. Velocity is spawn-time slowRate baked.
          pos = origin(r() * 160 - 80, r() * 160 - 80, r() * 200);
          vx = scaled(launchX + r() * 0.06 - 0.03);
          vy = scaled(launchY + r() * 0.06 - 0.03);
          vz = scaled(launchZ - r() * 0.1);
          az = Math.fround(-0.015);
        }
        const angle = Math.fround(r() * Math.PI * 2 - Math.PI);
        const angularVelocity = Math.fround(r() * 0.031415928 - 0.015707964);
        if (effectId === 20 || effectId === 26) this.rng.u32();
        const world = { ...pos, vx, vy, vz, ax, ay, az, angle, angularVelocity };
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x, y, vx: 0, vy: 0, age: 0, life: 300,
          color, size: 3, kind: 'snow', world,
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      } else if (spec !== undefined) {
        // Effect ids 22/32 use FUN_0041b020's sentinel branch in addition to
        // four unconditional ANM time-0 draws. Th07.exe (v1.00b) @ 0x41b02c
        // compares launch-x with the f64 constant -990.0 @ 0x48ec28: values
        // <= -990 request a random angle (8 total draws), while ordinary
        // signed launch vectors are deterministic (6). Treating the low
        // dword of that f64 as a standalone 0.0 caused every negative half of
        // Stage 1 Sub51's orbit to overdraw by two.
        const conditional = effectId === 22 || effectId === 32;
        const perParticle = conditional ? (seed && seed.x <= -990 ? 8 : 6) : spec;
        // Draw EXACTLY `perParticle` raw u16. The first pair only drives the
        // port's fallback visual; authored lifetime/capacity remains exact.
        let vx = 0;
        let vy = 0;
        for (let d = 0; d < perParticle; d++) {
          const raw = this.rng.u16();
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
        const snow = effectId === 26 || effectId === 27 || effectId === 30 || effectId === 31;
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x, y, vx, vy, age: 0,
          life: EFFECT_SCRIPT_LIFE[effectId] ?? 24,
          color, size: snow ? 3 : 2, kind: snow ? 'snow' : 'spark',
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      } else {
        // Unrecovered ids 16/25/28 keep the legacy visual/RNG model, but now
        // still obey the native fixed-pool allocation contract.
        const isSnow = effectId >= 18;
        const angle = this.rng.range(Math.PI * 2);
        const speed = (isSnow ? 0.2 + this.rng.range(0.5) : 0.5 + this.rng.range(2)) * this.slowRate;
        particle = {
          id: this.id++, poolSlot: slot, effectId,
          x: x + (isSnow ? this.rng.range(384) - 192 : 0),
          y: y + (isSnow ? this.rng.range(64) - 32 : 0),
          vx: isSnow ? -0.3 - this.rng.range(0.4) : Math.cos(angle) * speed,
          vy: isSnow ? 0.7 + this.rng.range(0.8) : Math.sin(angle) * speed,
          age: 0, life: isSnow ? 240 : 24 + this.rng.u32InRange(16),
          color, size: isSnow ? 2 + this.rng.range(2) : 3,
          kind: isSnow ? 'snow' : 'spark',
          ...(ownerEnemyId == null ? {} : { ownerEnemyId })
        };
      }
      this.effectSlots[slot] = particle;
      this.insertByPoolSlot(this.particles, particle);
      const burstDir = burstDirs?.[requested - remaining];
      if (burstDir) particle.burstDir = burstDir;
      remaining--;
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
    //   FUN_004413e0()  — flag live player shots harmless, drifting up.
    // Items already on the field keep falling — no force-collect. The
    // player, background scroll, effects, and BGM keep running natively;
    // only the field is emptied, which is why the input-locked player
    // cannot be shot mid-conversation.
    this.cancelBulletsToItems();
    this.runtime.killNonBossEnemies(this, null, 0, 0);
    this.driftPlayerShotsForDialogue();
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
      runners: [null, null, null, null]
    };
    this.dialogueBossIntroLine = null;
    // The enemy-death -> dialogue path (0x42b1e5) pulls the gauge one
    // twelfth of the way back toward neutral when a conversation starts.
    this.runState.addYoukaiGauge(this.runState.gaugeDialoguePull());
  }

  // FUN_004413e0 (all.c:31356, called at msg start and from every MSG
  // runner frame @ all.c:24700): every live player shot gets the harmless
  // byte (+0x2d7 = 1) and velocity (0, -0.5, 0) — in-flight shots drift up
  // out of the field and cannot damage anything for the rest of the
  // conversation. The reset (FUN_00441530, velocity (0, -0.9)) only runs on
  // the player-death and last-spell paths; a conversation never restores
  // shots — they simply expire offscreen.
  private driftPlayerShotsForDialogue(): void {
    for (const b of this.playerBullets) {
      if (b.dead) continue;
      b.driftHarmless = true;
      b.vx = 0;
      b.vy = -0.5;
    }
  }

  // The enemy-manager target caches (0x42d3d3-0x42d4df): recomputed every
  // frame after the enemy pass. Primary (player+0xe2aa4): the lowest enemy,
  // max y with first-slot tiebreak. Pointer cache (player+0xe2abc): among
  // enemies within +-64 of playfield center x (224), the upper-most/first —
  // the familiar's lunge target and the needle shots' aim source.
  private updateTh08TargetCaches(): void {
    let primary: { x: number; y: number } | null = null;
    let lunge: { x: number; y: number } | null = null;
    for (const e of this.enemies) {
      if (e.dead || !e.ecl.interactable) continue;
      if (!primary || e.y > primary.y) primary = { x: e.x, y: e.y };
      if (Math.abs(e.x - 224) <= 64 && (!lunge || e.y < lunge.y)) lunge = { x: e.x, y: e.y };
    }
    this.th08TargetPos = primary;
    this.th08LungeEnemy = lunge;
    this.playerObj.th08LungeTarget = lunge;
  }

  // The player update's gauge block (0x44bdf0-0x44c012): fire drift while
  // the shot cycle is armed and the focus state has been stable >= 30
  // frames; idle drift back toward neutral once the cycle has been
  // disarmed >= 30 frames. Gated off during dialogue and bombs.
  private tickTh08Gauge(): void {
    const run = this.runState;
    const p = this.playerObj;
    if (this.th08Bomb || this.isDialogueActive()) return;
    const armed = p.fireFrame >= 0;
    if (armed) {
      this.th08IdleFrames = 0;
      if (p.th08FocusFrames >= 30) {
        run.addYoukaiGauge(run.gaugeFireDrift(p.th08Form === 1, p.th08FocusFrames));
      }
    } else {
      this.th08IdleFrames++;
      if (this.th08IdleFrames >= 30 && run.youkaiGauge !== 0) {
        run.addYoukaiGauge(run.gaugeIdleDrift());
      }
    }
  }

  private updateTh08Dialogue(input: InputFrame): void {
    const dlg = this.th08Dialogue;
    if (!dlg) return;
    // Native order: Player (prio 9, moves shots) ... Gui (prio 0xf) re-runs
    // FUN_004413e0 every MSG frame — our update() likewise ticks player
    // shots before this tail, so re-asserting the drift here matches.
    if (!dlg.machine.state.done) this.driftPlayerShotsForDialogue();
    let bits = 0;
    if (input.held.has('shoot') || input.held.has('confirm')) bits |= TH08_DIALOGUE_INPUT_BITS.confirm;
    if (input.held.has('up')) bits |= TH08_DIALOGUE_INPUT_BITS.humanDirection;
    if (input.held.has('down')) bits |= TH08_DIALOGUE_INPUT_BITS.youkaiDirection;
    if (input.held.has('skip')) bits |= TH08_DIALOGUE_INPUT_BITS.fastForward;
    const events = dlg.machine.update(bits);
    for (const event of events) {
      switch (event.type) {
        case 'portrait-init':
        case 'portrait-interrupt':
        case 'slot-update': {
          const slot = event.slot;
          if (slot < 0 || slot > 3) break;
          // Portrait-slot to face-ANM mapping (PROBABLE, flagged): the
          // Border Team's two speakers read face_rm00/face_yk00; stage-NPC
          // slots read the stage face ANM (face_st01 for Wriggle). The
          // portrait script indexes the anm's ENTRIES (one expression
          // script each: rm00 -172..-164, yk00 -163..-155).
          const faceKey = slot === 0 ? 'face_rm00'
            : slot === 1 ? 'face_yk00'
              : this.stageDataFaceKey();
          const faceAnm = (this.assets.anms as Record<string, Anm>)[faceKey];
          if (!faceAnm) break;
          const portrait = dlg.machine.state.portraits[slot];
          if (!portrait.active) {
            dlg.runners[slot] = null;
            break;
          }
          let runner = dlg.runners[slot];
          const entryIndex = Math.max(0, Math.min(faceAnm.entries.length - 1, portrait.script));
          const entry = faceAnm.entries[entryIndex];
          const scriptId = entry?.scriptIds[0];
          if (scriptId == null) break;
          if (!runner || runner.scriptId !== scriptId) {
            runner = new AnmRunner(faceAnm, scriptId, {
              entryIndex,
              spriteIndexOffset: entry?.spriteBase ?? 0
            });
            dlg.runners[slot] = runner;
          }
          if (portrait.interrupt >= 0) runner.interrupt(portrait.interrupt);
          break;
        }
        case 'sound':
          if (event.id === 12) this.playSfx(12);
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
    for (const runner of dlg.runners) runner?.update();
    if (dlg.machine.state.done) {
      this.th08Dialogue = null;
      this.dialogueBossIntroLine = null;
      this.dialogueResume = true;
    }
  }

  private stageDataFaceKey(): string {
    const faceAnms = (TH08_DATA.stages as unknown as { 1?: { faceAnms?: readonly string[] } })[1]?.faceAnms;
    return faceAnms?.[2] ?? 'face_st01';
  }

  startDialogue(index: number): void {
    this.startDialogueTh08(index);
  }

  private activateStageResults(): void {
    if (this.stageResultsActive) return;
    this.stageResultsActive = true;
    this.stageClearTimer = 0;
    this.computeClearBonus();
    this.startStageClearPresentation();
  }

  private finishStageResults(): void {
    // Every authored post-boss flow reaches the timeline-completion latch.
    if (!this.stageResultsActive) this.activateStageResults();
    if (this.stageClear) return;
    this.stageClear = true;
    // TH08: the night clock advances at the stage tally — FUN_0043c35f's
    // per-stage switch pays +2 when the stage's time-orb quota is missed,
    // +1 when met (the recorded Lunatic stage 1 ends at clockTime 1, i.e.
    // met). The quota comes from the .data table at 0x4c77f0.
    const quota = TH08_STAGE_ORB_QUOTAS[this.stageNumber - 1]?.[this.difficulty] ?? 0;
    this.runState.addClockTime(this.runState.currentTimeOrbs >= quota ? 1 : 2);
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
      declAge: 0,
      portraitSprite: STAGE1_BOSS_PORTRAIT_SPRITE
    };
    this.spellBackgroundRunners = this.stageNumber === 5
      ? this.effectAnm.entries.slice(0, 2).map((entry, entryIndex) =>
          new AnmRunner(this.effectAnm, 0, {
            entryIndex,
            spriteIndexOffset: entry.spriteBase,
            rng: this.rng
          })
        )
      : [];
    this.spellBanner = 150;
    const tally = this.spellHistory.get(spellId) ?? { seen: 0, got: 0 };
    tally.seen++;
    this.spellHistory.set(spellId, tally);
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
    if (this.spellcard?.capturing) {
      // Th07.exe FUN_0040f340 @ 0x40f340: award = decayed base + graze
      // additions; the banner shows the full value while the score field
      // gains value/10 (same 10:1 display convention as point items —
      // score += uVar6/10 at all.c:6644).
      const bonus = this.spellcard.bonus;
      this.addScore(bonus);
      this.runState.spellcardsCaptured++;
      const tally = this.spellHistory.get(this.spellcard.id);
      if (tally) tally.got++;
      // Duration 280 frames (0x117+1 @ all.c:18302-18304). Failure path
      // arms nothing — no banner, no score credit (all.c:6639-6692).
      this.bonusPopup = { bonus, timer: 280 };
      this.playSfx(33);
    }
    this.spellName = '';
    this.spellcard = null;
    this.spellBackgroundRunners = [];
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

  // TH08 field clear: every live bullet becomes two auto-collecting time
  // orbs. No immediate score popup is created.
  cancelBulletsToItems(): void {
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      // TH08 (all.c:23531-23533): a cancelled bullet spawns TWO time orbs
      // when the mode global reads 9 (stage 1 always does).
      this.spawnItem(this.cancelItemType, b.x, b.y, { state: 1 });
      this.spawnItem(this.cancelItemType, b.x, b.y, { state: 1 });
    }
    this.clearEnemyBullets(true);
    // FUN_00422ea0(1) also converts each non-immune live laser at its
    // origin and every 32 px along [nearDist, farDist).
    this.cancelLaserField(false, true, false);
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

  // Laser half of every FUN_00422ea0 field clear: non-bomb-immune lasers
  // (flags bit 2 clear) get the op-89-style graceful shrink and stop
  // hit-testing immediately (shrinkCutoff=0); `unconditional` mirrors
  // bombType 10 (spell timeout) which ignores the immunity bit. Every
  // clear also arms the exe's 10-frame new-laser suppression counter
  // (gamestate+0x37a12c).
  cancelLasers(unconditional: boolean): void {
    this.cancelLaserField(unconditional, false);
  }

  private cancelLaserField(unconditional: boolean, spawnItems: boolean, includeOrigin = false): void {
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
          if (includeOrigin) this.spawnItem(this.cancelItemType, l.x, l.y, { state: 1 });
          const cos = Math.cos(l.angle);
          const sin = Math.sin(l.angle);
          // Th07.exe (v1.00b) FUN_00422ea0 @ 0x422ea0 and
          // FUN_00423100 @ 0x423100; DAT_0048ead4 = 32.0f.
          for (let d = l.nearDist; d < l.farDist; d += 32) {
            this.spawnItem(this.cancelItemType, l.x + cos * d, l.y + sin * d, { state: 1 });
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
    // Declined / exhausted continues: linger on GAME OVER, then leave.
    // Practice has no continues and leaves the same way.
    if (this.gameOver && this.mode !== 'test') {
      if (++this.gameOverTimer > 240) this.exitToTitle();
    }
    if (this.stageResultsActive) {
      this.stageClearTimer++;
      this.clearLoadingRunner?.update(this.slowRate);
      this.clearCaptureRunner?.update(this.slowRate);
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
    if (!bombCleanupThisTick && !messageActive && input.held.has('bomb') &&
        (p.controllable || p.hitState) && !this.gameOver && p.tryBomb()) {
      this.voidSpellCapture();
      // Th07.exe bomb trigger @ all.c:28503-28506: zeroes the pending
      // spell bonus and latches DAT_012f40bc = spell-active state.
      this.bombDuringSpell = this.spellcard !== null;
      this.onBombUsed();
    }
    if (p.bombTimer > 0) this.prepareBombEffects();
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
      this.spawnTh08Effect(57, p.x, p.y, 90, { color: 0x8080ff });
    } else if (fx === 29) {
      this.spawnTh08Effect(58, p.x, p.y, 90, { color: 0xff8080 });
    }
    const aura = p.pendingTh08Aura;
    p.pendingTh08Aura = null;
    if (aura === 'in') {
      this.th08AuraHandle?.release();
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
    // The popup/ascii manager is priority 1, ahead of every gameplay
    // manager. Existing popups age now; item pickups later this frame create
    // fresh entries that do not tick until the next scheduler pass.
    this.updatePopups();
    const death = p.tickDeath(this.slowRate);
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
    // FUN_0041ed50 (priority 10) and the generic effect manager (priority
    // 11) do NOT honor the TH07 dialogue freeze: invisible ECL controllers,
    // enemies, movement/collision and ambient effects continue. The only
    // enemy-tail exception is the boss timer, gated in tickEnemyManagerTail.
    this.updateEnemies();
    this.updateTh08TargetCaches();
    this.tickTh08Gauge();
    this.updateParticles();
    // FUN_004241c0 calls the item manager at the head of the priority-12
    // bullet callback (all.c:16039-16042). Items therefore update after
    // effects, before bullets/lasers, and freeze with dialogue gameplay.
    // Cancellation items created later in this callback wait until the
    // next frame for their first update.
    this.updateItems();
    this.updateBullets();
    this.updateLasers();
    if (this.postBombLaserCounter > 0) this.postBombLaserCounter--;
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
    if (this.th08Declaration) {
      this.th08Declaration.update(this.slowRate);
      if (this.th08Declaration.done) this.th08Declaration = null;
    }
    this.tickScreenFx();
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
  }

  private onBombUsed(): void {
    const p = this.playerObj;
    this.bombActiveThisFrame = true;
    // TH08 Border Team: the bomb machine (0x44c650) dispatches ONE per-frame
    // callback for the whole bomb from the table at player+0x1000 (rdata
    // 0x4c7ad0 team block 0): 0x40c010 unfocused / 0x410c40 focused /
    // 0x40c910+0x410fe0 the side-inverted deathbombs. Durations come from
    // the shared cast helper 0x40be30 (260/200/260/300).
    this.th08Bomb = new Th08BorderBomb(p.th08BombType, p.x, p.y);
    this.th08BombOrbActors = [];
    this.th08Bomb.cast(this.th08BombHost(), p.x, p.y);
    // param_4 (active length) drives bombTimer; the separate param_5
    // clock at player+0xe2af4 is the LONGER invulnerability window.
    p.bombTimer = this.th08Bomb.duration;
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
      this.th08Bomb = null;
      this.th08BombOrbActors = [];
      // FUN_00416130 (bomb end): interrupt 1 releases the name VM's
      // label-1 wait into its exit; the portrait/banners are self-timed.
      this.th08Declaration?.end();
    }
  }

  // Spawn an etama.anm VM by ARCHIVE script index (Th08.exe FUN_004069f0
  // indexes the archive's script table, so index 37 = entry 1's 13th script
  // regardless of its negative on-disk id). color/scale carry the
  // FUN_00425430 host params (VM color / burst magnitude).
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
      addAttackSlot(x, y, radius, damage) {
        let settled = 0;
        const r2 = radius * radius;
        for (const e of scene.enemies) {
          if (e.dead || !e.ecl.interactable) continue;
          const dx = e.x - x;
          const dy = e.y - y;
          if (dx * dx + dy * dy <= r2) {
            scene.damageEnemy(e, damage, 'bomb');
            settled += damage;
          }
        }
        // The slot consumer compares settled damage (slot +0x30) against the
        // aura's threshold (+0x34) — return the settled total so the orb
        // state machine can burst on time.
        return settled;
      },
      clearBullets(x, y, radius) {
        const r2 = radius * radius;
        for (const b of scene.enemyBullets) {
          if (b.dead) continue;
          const dx = b.x - x;
          const dy = b.y - y;
          if (dx * dx + dy * dy <= r2) scene.beginBombClearFade(b);
        }
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
    // The bomb tick runs before this frame's enemy/bullet passes so the
    // choreography state is fixed for the rest of the frame.
    this.tickBombChoreography();
    // Cache the ordered object references instead of restarting the 112-slot
    // generator for every enemy and every bullet in a dense field.
    this.refreshActiveAttackSlots();
  }

  private refreshActiveAttackSlots(): void {
    this.activeBombSlots.length = 0;
    for (const slot of this.bombEngine.activeSlots()) this.activeBombSlots.push(slot);
  }

  private collideBombSlots(e: Enemy, hitbox = e.ecl.hitbox): void {
    // FUN_0043a980 is entered for interactable shot-collision actors even
    // while ECL op103 has cleared canTakeDamage. Contacts still accumulate
    // raw damage, Cherry/score, the global hit tally, and impact effects;
    // only settlePendingDamage's final HP subtraction is bit2-gated
    // (Th07.exe v1.00b FUN_0041ed50 @ 0x41fa76). Extra PRE7692 is the
    // concrete witness: an op103(0) actor receives all 16 focused-beam
    // history-helper contacts and four id5 effects without losing HP.
    if (!e.ecl.interactable || !e.ecl.shotCollision) return;
    // FUN_0043a980 scans attack slots 0..111 after the 96 player-shot slots.
    for (const s of this.activeBombSlots) {
      const hw = (hitbox.x + s.radiusX) / 2;
      const hh = (hitbox.y + s.radiusY) / 2;
      if (Math.abs(e.x - s.x) > hw || Math.abs(e.y - s.y) > hh) continue;
      this.damageEnemy(
        e,
        s.damage,
        s.source === 'shot' && !this.bombActiveThisFrame ? 'shot' : 'bomb'
      );
      s.hitTally += s.damage;
      // Player+0x240c is one global hit counter. Every fourth attack-slot
      // contact emits id3 for slots 0..95, id5 for slots 96..111
      // (FUN_0043a980 @ all.c:27687-27712).
      if ((++this.playerHitTally & 3) === 0) {
        this.spawnEffectParticles(s.poolSlot < 0x60 ? 3 : 5, e.x, e.y, 1, 0xffffffff);
      }
    }
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
    return this.beginBulletClearFade(b, 'time');
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

  // Th07.exe FUN_00430970 spawn mode 2 (all.c:21852-21862): every death drop
  // launches from the fixed death point toward its own random target at
  // x = rand*288+48, y = rand*192-64 (playfield coords; constants @
  // 0x48eccc/0x48eb94/0x48ecc8/0x48eb68), riding a 60-frame positional lerp
  // (FUN_00430c10 all.c:21936-21956) before dropping to normal fall from
  // rest. Velocity starts zeroed — the exe reuses those fields as the tween
  // origin while state==2.
  private spawnDeathDrop(type: ItemType, x: number, y: number): void {
    const tx = this.rng.f() * 288 + 48;
    const ty = this.rng.f() * 192 - 64;
    this.spawnItem(type, x, y, { vx: 0, vy: 0, tweenTarget: { tx, ty } });
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
    if (!e.ecl.interactable || e.ecl.invisible) return;
    // TH08 familiar side gate (all.c:21448, flags bit 11): an ETHEREAL
    // familiar (player in youkai form) takes no player-shot or attack-slot
    // damage at all — the whole settlement block is behind bit11==0.
    if (e.ecl.th08?.familiar && e.ecl.th08.sideBit === 1) return;
    // Th07.exe FUN_0043a980 @ 0x43a9e6: while the player's own bomb is
    // active (player+0x16a20), each SHOT deals table/3 damage, min 1.
    if (kind === 'shot' && this.bombActiveThisFrame) {
      damage = Math.max(1, Math.trunc(damage / 3));
    }
    if (kind === 'shot') e.pendingShotDmg += damage;
    else e.pendingBombDmg += damage;
  }

  // Th07.exe FUN_0041ed50 damage pipeline (all.c:14174-14253), run once per
  // enemy per frame:
  //   raw = this frame's shot+bomb sum (shots pre-scaled /3 during a bomb)
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
    const raw = shotRaw + bombRaw;
    const hadBomb = bombRaw > 0;
    e.pendingShotDmg = 0;
    e.pendingBombDmg = 0;
    // Zeroed every frame like the exe's enemy+0x2e4c (all.c:14173) and set
    // to the HP actually removed below — ECL var 10061 (the Prismrivers'
    // op43 damage-sharing poll) reads it.
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
        this.th08Seekers?.delete(slot);
        continue;
      }
      if (b.state === 'fired') {
        if (b.tickFunc === 1) {
          // TH08 SHT tick callback 1 (FUN_00450320): the unfocused Border
          // pair's per-frame seek against the PRIMARY position cache
          // (player+0xe2aa4, the max-y enemy). Gates on the shot's own age:
          // past frame 39 (0x27) the exe falls to the targetless branch
          // (accelerate 1/3, clamp 10) even while a target is fresh.
          const seeker = this.th08SeekerFor(b);
          seeker.update(b.age < 40 ? this.th08TargetPos : null);
          b.vx = Math.fround(seeker.vx);
          b.vy = Math.fround(seeker.vy);
          b.speed = seeker.speed;
          b.angle = seeker.heading;
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
        this.th08Seekers?.delete(slot);
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
          const spread = Math.fround(b.angle + Math.PI / 2);
          const aim = Math.fround(Math.atan2(target.y - b.y, target.x - b.x) + spread);
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
    if (!e.ecl.shotCollision || !e.ecl.interactable || e.ecl.invisible || e.dead) return;
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
        {
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
            // full 96-slot pool (native Stage 3 processing frame 2811).
            b.runner.frame = 1;
          }
          // TH08 settle (all.c:40420-40438): the VM re-arms to sprite+0xb
          // and effect 5 (DAT_004c6d30 -> etama archive script 37) bursts
          // at the bullet position; velocity is reduced to one eighth.
          this.spawnTh08Effect(37, b.x, b.y, 60);
          b.vx /= 8;
          b.vy /= 8;
          this.playSfx(20);
        }
      }
    }
    this.collideBombSlots(e, hitbox);
  }

  // Border Team callback-1 seeker state, keyed by fixed player-shot slot.
  private th08Seekers = new Map<number, Th08SeekingOptionShot>();

  private th08SeekerFor(b: PlayerBullet): Th08SeekingOptionShot {
    let seeker = this.th08Seekers.get(b.poolSlot);
    if (!seeker) {
      seeker = new Th08SeekingOptionShot(b.x, b.y, b.angle, b.speed);
      this.th08Seekers.set(b.poolSlot, seeker);
    }
    return seeker;
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
    if (t8.sideBit !== form) {
      const toYoukai = form === 1;
      // FUN_0042c420's transition colors as ARGB -> our rgb multiplier +
      // alpha: 0x80303080 (blue, player -> youkai) / 0x80803030 (red,
      // player -> human).
      this.spawnTh08Effect(
        toYoukai ? 60 : 59, e.x, e.y, 60,
        { color: toYoukai ? 0x303080 : 0x803030, alpha: 0x80 / 255 }
      );
      t8.markerHandle?.interrupt(toYoukai ? 2 : 1);
      this.playSfx(toYoukai ? 40 : 39); // se_ophide / se_opshow
      t8.managerList = toYoukai ? 0 : 2;
      t8.sideBit = form;
      t8.flags = (t8.flags & ~0x800) | (form << 11);
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
  //   draw order (all.c:20533-20541), plus FUN_0044df00's burst pool
  //   registration (pos, 32.0, 1.0, 0x10, 7) — a 16-orb batch, spawned
  //   directly here with the item pool's own state-3 velocity draws
  //   (flagged: the native burst is pool-deferred, its release draws are
  //   not yet traced).
  private settleTh08FamiliarDeath(e: Enemy): void {
    const t8 = e.ecl.th08;
    if (t8?.familiar) {
      // FUN_004412b0: a directly destroyed familiar pays a point popup,
      // one immediate time orb, and asks FUN_00416b10 to restore 8000 of
      // the live spell bonus. The latter is suppressed while op 184's
      // global side-mirror bit is set.
      const popupValue = this.runState.pointItemsCollectedInStage < 2000
        ? Math.max(100, Math.trunc(this.runState.pointItemsCollected / 2) * 10)
        : 10000;
      this.spawnScorePopup(popupValue, e.x, e.y, 0xdfffef80);
      this.addScore(popupValue);
      this.runState.addTimeOrbs(1);
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
      return;
    }
    const children = this.enemies.filter(
      c => !c.dead && c.ecl.parent === e && c.ecl.th08?.familiar
    );
    if (children.length === 0) return;
    for (const c of children) {
      const ct8 = c.ecl.th08!;
      ct8.flags |= 0x400;
      c.ecl.parent = null;
      c.dead = true;
      ct8.markerHandle?.release();
      ct8.markerHandle = null;
      ct8.markerActor = null;
      this.playSfx(2 + (c.id & 1));
    }
    for (let i = 0; i < children.length * 2; i++) {
      const radius = this.rng.f() * 128;
      const angle = this.rng.f() * Math.PI;
      this.spawnItem(
        'time',
        Math.fround(e.x + Math.cos(angle) * radius),
        Math.fround(e.y + Math.sin(angle) * radius),
        {}
      );
    }
    for (let i = 0; i < 16; i++) this.spawnItem('time', e.x, e.y, {});
  }

  private collideEnemyBody(e: Enemy): void {
    const p = this.playerObj;
    if (this.gameOver || !p.alive || !e.ecl.collisionEnabled ||
        (e.ecl.th08 && (e.ecl.th08.flags & 0x10) !== 0) ||
        !e.ecl.interactable || e.ecl.invisible || e.dead) return;
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
    if (!this.bombActiveThisFrame) this.graze++;
    this.traceReplayEvent?.({
      kind: 'graze', frame: this.frame,
      data: { x: sourceX, y: sourceY, total: this.graze }
    });
    // 0x44aa78: every graze event pushes the gauge +100 (youkai-ward).
    this.runState.addYoukaiGauge(this.runState.gaugeGrazeDelta());
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
    const result = p.hit();
    if (result === 'deathbomb-window') {
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
    // FUN_0041ed50 processes authored timeline entries before scanning the
    // native 480-slot enemy pool (all.c:14016-14039). Timeline spawns are
    // therefore eligible later in this same pass.
    this.runtime.update(this);
    for (let slot = 0; slot < ENEMY_POOL_CAP; slot++) {
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
      let transitioned: boolean;
      do {
        this.runtime.tickEnemyCore(this, e);
        if (e.dead) break;
        this.runtime.integrateEnemyPosition(e, this.slowRate);
        this.tickSpellBonusDecay(e);
        this.updateEnemyTrailHistory(e);
        this.updateEnemyCull(e);
        if (e.dead) break;
        transitioned = this.runtime.processEnemyCallbacks(this, e);
      } while (transitioned);
      if (e.dead) {
        if (this.enemySlots[slot] === e) {
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
        // FUN_0041ed50 keeps FUN_0043a980's local_18 bomb-contact flag
        // through damage settlement and passes it as FUN_00430970's spawn
        // mode when this same manager pass kills the enemy. Bomb-contact
        // drops therefore start homing immediately even when their power
        // type is converted to big Cherry at full power.
        bombContactThisFrame = this.settlePendingDamage(e);
      }
      // TH08 enemy+0x3328 bit 3 is latched at the head of the native death
      // switch (all.c:21620). Retained mode-1/2/3 callback actors keep
      // running ECL but must never re-enter score/drop/effect/gauge death
      // settlement on every subsequent negative-HP frame.
      if (!e.dead && e.hp <= 0 && ((e.ecl.th08?.flags2 ?? 0) & 8) === 0) {
        const keep = this.runtime.killEnemy(this, e, bombContactThisFrame);
        if (!keep) e.dead = true;
        // 0x42d65c: every enemy death settles the gauge toward the side the
        // player is currently acting as (-200 human / +200 youkai, read from
        // the form byte via the DAT_017d5efb mirror).
        this.runState.addYoukaiGauge(this.runState.gaugeKillDelta(this.playerObj.th08Form === 1));
        this.settleTh08FamiliarDeath(e);
      }
      this.runtime.tickEnemyManagerTail(this, e);
      if (e.dead && this.enemySlots[slot] === e) {
        this.enemySlots[slot] = null;
        this.runtime.releaseEnemy(this, e);
      }
    }
    for (const e of this.enemies) {
      if (!e.dead) continue;
      const slot = e.poolSlot;
      if (slot >= 0 && slot < ENEMY_POOL_CAP && this.enemySlots[slot] === e) {
        this.enemySlots[slot] = null;
        this.runtime.releaseEnemy(this, e);
      }
    }
    this.compactLive(this.enemies);
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
      // collision until their authored ANM ends. On the ending tick control
      // falls through into state 1 and performs the normal move as well.
      if (!this.updateBulletMotion(b)) return;
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
  }

  // Per-frame bullet ex-behaviors, matching Th07.exe FUN_004241c0 @ 0x4241c0.
  // Each activated behavior bit in b.exFlags (exe +0xbf4, promoted by
  // FUN_004229f0 — see advanceBulletExBehavior) runs as an INDEPENDENT
  // if in the order 0x1, 0x10, 0x20, 0x40/0x100/0x80, 0xc00, then velocity is
  // added to position ONCE. Every behavior reads only its OWN op-79 slot's
  // resolved params and clears its own bit when finished.
  private updateBulletMotion(b: EnemyBullet): boolean {
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
    const spawnAge = b.spawnAge ?? b.spawnDuration;
    // TH08's transition spans duration+2 manager ticks in the Stage-1
    // fixture: the f530 ring's crossing band only clears at +2; replacing it
    // with the tempting "template t0 => logical age 1" reading moves the
    // first formal Replay death back to f684. FUN_004069f0 does execute the
    // prototype VM's t0 synchronously, but the exact state copied/re-armed by
    // FUN_0042fe70/FUN_0042fea0 remains unresolved without a native slot
    // trace. Keep the observed whole-chain parity rather than that local
    // inference.
    const th08ExtraFrac = 2;
    if (spawnAge < b.spawnDuration || spawnAge <= b.spawnDuration + th08ExtraFrac) {
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
      // The finished report lands after the two fixture-pinned manager ticks;
      // the fall-through's fractional + full moves occur on that ending tick.
      const spawnEnded = spawnAge + 1 > b.spawnDuration + th08ExtraFrac;
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
        return false;
      }
      // Th07.exe FUN_004241c0 @ 0x424843-0x424860: an ending spawn ANM
      // changes state to 1, resets the normal age counter, and falls through
      // to the ordinary behavior/full-velocity move on this same tick.
      // TH08 parks one past the duration (its inclusive gate above).
      b.spawnAge = b.spawnDuration + th08ExtraFrac + 1;
      b.spawnAgeFrac = 0;
      b.age = 0;
    }
    // Constructor promotion happens in FUN_00421e90. Every normal-state
    // manager tick performs exactly one further queue pass BEFORE executing
    // active behavior routines (FUN_004241c0 @ all.c:16120). TH08's 0x20000
    // wait gate parks the queue here while the bullet's motion continues.
    if ((b.exWaitFrames ?? 0) > 0) {
      b.exWaitFrames = (b.exWaitFrames ?? 0) - 1;
    } else {
      advanceBulletExBehavior(b, rate, this.th08BulletExHost);
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
    if ((b.exFlags & 0x40) && b.exDir) this.dirChangeBullet(b, 'relative');
    if ((b.exFlags & 0x100) && b.exDir) this.dirChangeBullet(b, 'absolute');
    if ((b.exFlags & 0x80) && b.exDir) this.dirChangeBullet(b, 'aimed');
    if ((b.exFlags & 0xc00) && b.exBounce) this.bounceBullet(b, (b.exFlags & 0x400) !== 0);
    // Default bullet integration is the same f32 store-back (`pos += vel`)
    // at all.c:16147-16149. Math.fround is therefore state semantics, not a
    // rendering approximation.
    b.x = Math.fround(b.x + b.vx);
    b.y = Math.fround(b.y + b.vy);
    return true;
  }

  private dirChangeBullet(b: EnemyBullet, mode: 'relative' | 'absolute' | 'aimed'): void {
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
        b.exFlags &= mode === 'relative' ? ~0x40 : mode === 'absolute' ? ~0x100 : ~0x80;
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
        const dx = Math.fround(this.player.x - b.x);
        const dy = Math.fround(this.player.y - b.y);
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
    // FUN_004074e0 AngleToVector: cos/sin and the rate-scaled speed are f32-staged
    // before the velocity write (mirrors the speed-ramp path above).
    const scaledSpeed = Math.fround(Math.fround(speed) * rateF32);
    b.vx = Math.fround(Math.fround(Math.cos(b.angle)) * scaledSpeed);
    b.vy = Math.fround(Math.fround(Math.sin(b.angle)) * scaledSpeed);
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
    // speed * effectiveFramerateMultiplier): the rate-scaled speed and each
    // cos/sin product store through float32 (same FUN_004074e0 staging as
    // dirChangeBullet above).
    const scaledSpeed = Math.fround(Math.fround(b.speed) * Math.fround(this.slowRate));
    b.vx = Math.fround(Math.fround(Math.cos(b.angle)) * scaledSpeed);
    b.vy = Math.fround(Math.fround(Math.sin(b.angle)) * scaledSpeed);
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
    const rate = Math.fround(this.slowRate);
    for (const it of this.items) {
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
            it.vy = Math.fround(Math.fround(0.03) * rate);
          }
        } else {
          const t = (tw.elapsed + tw.frac) / 60;
          it.x = Math.fround(t * tw.tx + (1 - t) * tw.sx);
          it.y = Math.fround(t * tw.ty + (1 - t) * tw.sy);
        }
        // Split-counter advance (exe FUN_00436acc): fractional under slowmo.
        tw.frac = Math.fround(tw.frac + rate);
        while (tw.frac >= 1) {
          tw.frac -= 1;
          tw.elapsed++;
        }
      } else if (it.state === 3 || it.state === 5) {
        // TH08 ItemManager states 3/5 (all.c:31084-31108): the tossed item
        // climbs against 0.05 gravity, then flips to homing state 1 once it
        // crests (vy > 0) — the time-orb auto-collect arc. This branch jumps
        // straight to the collect test in the exe (no state-0 gravity tail).
        it.vy = Math.fround(it.vy + Math.fround(Math.fround(0.05) * rate));
        it.x = Math.fround(it.x + Math.fround(it.vx * rate));
        it.y = Math.fround(it.y + Math.fround(it.vy * rate));
        if (it.vy > 0) it.state = 1;
      } else {
        if (pocActive()) {
          it.state = 1;
        }
        if (it.state === 1) {
          if (p.materializeFrame >= 0) {
            // Player state 1 (respawn materialize) clears the homing latch
            // and writes only vy=-0.5; the previous vx is intentionally
            // retained for this integration tick (0x430f73..0x430f8a).
            it.vy = Math.fround(-0.5);
            it.state = 0;
          } else {
            // FUN_0043f2b0 stages player-item deltas through float32 before
            // atan2; its x87 result is then explicitly narrowed before
            // FUN_004074e0 stores the velocity pair at +0x258/+0x25c.
            const dx = Math.fround(p.x - it.x);
            const dy = Math.fround(p.y - it.y);
            const angle = Math.fround(Math.atan2(dy, dx));
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
        const dx = Math.fround(it.vx * rate);
        const dy = Math.fround(it.vy * rate);
        it.x = Math.fround(it.x + dx);
        it.y = Math.fround(it.y + dy);
        if (it.state !== 1) {
          // TH08's homing branch jumps straight to the collect test
          // (all.c:31064-31070) — no gravity tail pollutes the latch.
          // TH08 ItemManager (all.c:31109-31121): once the item's y reaches
          // 3.0 the fall speed SNAPS to 3.0; above that the 0.03·rate
          // gravity applies.
          if (it.y >= 3) it.vy = 3;
          else it.vy = Math.fround(it.vy + Math.fround(Math.fround(0.03) * rate));
        }
        // ItemManager::OnUpdate: `arcadeRegionSize.y + 16.0f <= y` — the
        // 448+16 boundary despawns INCLUSIVELY at exactly 464.
        if (it.y >= 464) {
          it.dead = true;
          // FUN_00430c10 @ 0x4310ae-0x4310ba: every ordinary item that
          // leaves the bottom subtracts three rank points, regardless of
          // item type. Tween-state death drops bypass this cull branch.
          this.adjustRank(-3);
        }
      }
      // Player::CalcItemBoxCollision (0x0043b480): inclusive AABB of the
      // item box (item ± f32(itemRadius/2), from ItemManager's local size
      // vector) against the player's PRECOMPUTED grab corners
      // (grabItemTopLeft/BottomRight = positionCenter ± grabItemSize, with
      // grabItemSize fixed (12,12,5) — Player.cpp:1419/2444). Both sides
      // round each corner through f32 before the comparisons; the
      // algebraically equal center-distance form |Δ| <= r/2+12 rounds in
      // different places and flipped marginal collects by one frame
      // (th7_udMt01 stage 4 collect#161, oracle 4224 vs web 4225).
      const itemHalf = Math.fround(sht.itemRadius * 0.5);
      const itemMinX = Math.fround(Math.fround(it.x) - itemHalf);
      const itemMaxX = Math.fround(Math.fround(it.x) + itemHalf);
      const itemMinY = Math.fround(Math.fround(it.y) - itemHalf);
      const itemMaxY = Math.fround(Math.fround(it.y) + itemHalf);
      const grabMinX = Math.fround(Math.fround(p.x) - 12);
      const grabMaxX = Math.fround(Math.fround(p.x) + 12);
      const grabMinY = Math.fround(Math.fround(p.y) - 12);
      const grabMaxY = Math.fround(Math.fround(p.y) + 12);
      if (p.alive && !it.dead &&
          !(grabMinX > itemMaxX || grabMaxX < itemMinX ||
            grabMinY > itemMaxY || grabMaxY < itemMinY)) {
        this.collectItem(it);
      }
    }
    let w = 0;
    for (const it of this.items) {
      if (!it.dead) {
        this.items[w++] = it;
      }
    }
    this.items.length = w;
  }

  // TH08 item collection (ItemManager cases, reference/re-specs/
  // th08-decomp-items/ + th08-decomp-state/): point/power feed the run
  // state's ladder, time orbs feed the gauge + clock + orb counters, power
  // raises the SHT power level.
  private collectItemTh08(it: ItemEntity): void {
    const run = this.runState;
    const p = this.playerObj;
    const atOrAbovePoC = it.y < p.sht.pocLineY;
    switch (it.type) {
      case 'point': {
        const r = run.collectPoint({ atOrAbovePoC });
        this.score = run.score;
        this.spawnScorePopup(r.award, it.x, it.y, 0xffffffff, true);
        break;
      }
      case 'pointSmall': case 'pointStar': {
        const r = run.collectPointSmall({ atOrAbovePoC });
        this.score = run.score;
        this.spawnScorePopup(r.award, it.x, it.y, 0xffffffff, true);
        break;
      }
      case 'powerSmall': p.power = Math.min(128, p.power + 1); break;
      case 'powerBig': p.power = Math.min(128, p.power + 8); break;
      case 'powerFull': p.power = 128; break;
      case 'bomb': p.bombs = Math.min(8, p.bombs + 1); break;
      case 'extend': p.lives = Math.min(8, p.lives + 1); break;
      case 'time': case 'time2': {
        // Time orb (CollectTimeOrb, FUN_004412b0): score + orb counter +
        // gauge ±111 when the spell timer reads zero + the night clock.
        const r = run.collectTimeOrb({
          specialScoringMode: false,
          timerCurrent: this.spellcard ? 1 : 0,
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

  private collectItem(it: ItemEntity): void {
    it.dead = true;
    this.traceReplayEvent?.({
      kind: 'item-collect', frame: this.frame,
      data: { type: it.type, slot: it.poolSlot, x: it.x, y: it.y }
    });
    this.playSfx(21); // TH08 item00 channel
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
        // FUN_0041a050 @ 0x41a050 is shared by effect ids
        // 20/26/27/30/31 and runs before their ANM tick, including on the
        // allocation frame: integrate acceleration/velocity, then retain the
        // slot only inside the camera's 0.94 cosine cone and above the
        // world-space ground plane (negative z).
        const w = p.world;
        w.vx = Math.fround(w.vx + w.ax);
        w.vy = Math.fround(w.vy + w.ay);
        w.vz = Math.fround(w.vz + w.az);
        w.x = Math.fround(w.x + w.vx);
        w.y = Math.fround(w.y + w.vy);
        w.z = Math.fround(w.z + w.vz);
        w.angle = Math.fround(normalizeAngle(w.angle + w.angularVelocity));

        const std = this.runtime.std;
        const camera = std.camera();
        const facing = std.facing();
        const dx = w.x - camera.x;
        const dy = w.y - camera.y;
        const dz = w.z - camera.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const fl = Math.hypot(facing.x, facing.y, facing.z) || 1;
        const dot = (dx * facing.x + dy * facing.y + dz * facing.z) / (dl * fl);
        alive = dot >= 0.94 && w.z < 0;
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
      this.markPass('background');
      for (const p of this.particles) {
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
      // 896, 0xffffffff, 0) EVERY frame while the +0xe2a70 countdown runs —
      // a solid white playfield quad through the death squish and 60 frames
      // past it (not the deathbomb window; that has no white flash).
      if (this.th08DeathWhiteFrames > 0) {
        r.ctx.fillStyle = '#ffffff';
        r.ctx.fillRect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
      }
      this.playerEffects.draw(r, ox, oy);
      this.th08Effects.draw(r, ox, oy);
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
      this.drawSpellDeclaration(r, ox, oy);
      this.markPass('player+fx');
    });
    this.drawFrame(r);
    this.drawSidebar(r);
    this.drawModeTags(r);
    if (this.stageResultsActive) this.drawStageClearPresentation(r);
    this.drawSpellOverlay(r);
    this.drawTh08Dialogue(r);
    this.drawStageTitle(r);
    if (this.bonusPopup) this.drawSpellBonusPopup(r);
    if (this.bossActive) this.drawBossMarker(r);
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
  }

  private drawStageClearPresentation(r: Renderer): void {
    // Native draw order @ all.c:18798-18800: full-playfield loading art,
    // then the rotating/shrinking captured frame. Both ANMs contain absolute
    // 640x480 screen coordinates, so the caller contributes no playfield base.
    r.drawAnmFrame(this.clearLoadingRunner?.spriteFrame() ?? null, 0, 0);
    r.drawAnmFrame(this.clearCaptureRunner?.spriteFrame() ?? null, 0, 0);
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

  // TH08 result tally: yellow spaced "Stage Clear", then Clear/Point/Graze/Time rows with
  // right-aligned values, the red "<Difficulty> Rank *<mult>" line, and
  // Total. Rows reveal one by one; Z advances the stage once all shown.
  private drawStageClear(r: Renderer): void {
    const b = this.clearBonus;
    if (!b) return;
    const ox = PLAYFIELD.x;
    const oy = PLAYFIELD.y;
    const t = this.stageClearTimer || 1;
    const ctx = r.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(0.45, t / 60);
    ctx.fillStyle = '#000';
    ctx.fillRect(ox, oy + 110, PLAYFIELD.width, 210);
    ctx.restore();
    const spaced = (s: string) => s.split('').join(' ');
    const labelX = ox + 74;
    const valueEndX = ox + 310;
    const num = (v: number) => v.toLocaleString('en-US').replace(/,/g, '');
    const row = (label: string, value: number, y: number, color: string) => {
      r.text(spaced(label), labelX, y, { size: 14, color });
      const txt = num(value);
      r.text(txt, valueEndX - txt.length * 9, y, { size: 14, color });
    };
    // "All Clear!" replaces "Stage Clear" on route-final clears (stage 6 /
    // Extra / Phantasm — exe gate DAT_0062583c >= 6 @ all.c:17063-17067).
    const heading = this.stageNumber >= 6 ? 'All Clear!' : 'Stage Clear';
    r.text(spaced(heading), labelX, oy + 130, { size: 16, color: '#ffcc44' });
    const reveal = Math.floor((t - 20) / 12); // rows appear one by one
    const rows: [string, number][] = [
      ['Clear', b.clear],
      ['Point', b.point],
      ['Graze', b.graze],
      ['Time', b.time]
    ];
    // Player/Bomb rows only appear on route-final clears (all.c:17081-17094).
    if (this.stageNumber >= 6) {
      rows.push(['Player', b.player], ['Bomb', b.bomb]);
    }
    rows.forEach(([label, value], i) => {
      if (reveal > i) row(label + '  =', value, oy + 168 + i * 22, '#d8d8f8');
    });
    if (reveal > rows.length) {
      const names = ['Easy', 'Normal', 'Hard', 'Lunatic', 'Extra'];
      const y = oy + 176 + rows.length * 22;
      // Phantasm prints no Rank line at all (no else arm in the exe chain).
      if (this.difficulty <= 4) {
        r.text(spaced(`${names[this.difficulty] ?? ''} Rank *${b.mult.toFixed(1)}`), labelX, y, { size: 14, color: '#ff5566' });
      }
      row('Total  =', b.total, y + 24, '#ffffff');
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
    if (alpha === 1) {
      const img = r.image(key);
      if (img) r.ctx.drawImage(img, rect[0], rect[1], rect[2], rect[3], x, y, rect[2], rect[3]);
      return;
    }
    r.drawSprite(key, rect[0], rect[1], rect[2], rect[3], x + rect[2] / 2, y + rect[3] / 2, { alpha });
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
        const fogAlpha = clamp((std.viewDepth(c0.x, c0.y, c0.z, camFrame) - fog.near) / fogSpan, 0, 1);
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
  // 0->255 over 60 frames, then a per-frame loop shifting u +0.004167 and
  // v -0.008333. Not run through AnmRunner: the script's op-4 frame-reset
  // loop would pin the frame-keyed fade interpolation near zero.
  // Spell-card playfield background: entry 0 of the stage's own eff0N.anm,
  // faded in over 60 frames (op15) and then presented per that script's own
  // authored model (decoded per stage, recon spellbg-diagnosis.md):
  //   stages 1/2 + 6-layer0: 384x448 oversized sprite over a 256x256 texture
  //     = GPU tile-wrap with per-frame op26/27 UV scroll (stage 1 scrolls
  //     diagonally u+0.004167/v-0.008333; stages 2/6 scroll v+0.008333 ONLY);
  //   stage 3: 256x256 stretched by op7 scale(1.5,1.75) with a v-wrapping
  //     pan inside the single stretched quad;
  //   stages 5/7/8: 256x256 stretched static — NO tiling, NO scroll (the old
  //     one-size eff01 pattern produced the seamy 2x3 grid the testers saw);
  //   stage 6 additionally layers entry 1 (eff06) as a static stretched
  //     overlay alpha-capped at 224/255;
  //   stage 4's eff04 entries are not corner-anchored backgrounds at all
  //     (flagged open) — kept on the legacy tiled path.
  private drawSpellBackground(r: Renderer): void {
    const sc = this.spellcard;
    if (!sc) return;
    if (this.stageNumber === 5 && this.spellBackgroundRunners.length) {
      for (const runner of this.spellBackgroundRunners) {
        r.drawAnmFrame(runner.spriteFrame(), 0, 0);
      }
      return;
    }
    // Per-stage effect sheet; resolved via the ANM entry's own texture name
    // (eff07.anm's textures are eff07b/eff07c — there is no eff07.png).
    const img = r.image(this.effectAnm.entries[0]?.imageKey ?? 'eff01');
    if (!img) return;
    const ctx = r.ctx;
    const fade = Math.min(1, sc.declAge / 60);
    const staticStretch = this.stageNumber === 5 || this.stageNumber === 7 || this.stageNumber === 8;
    ctx.save();
    ctx.globalAlpha = fade;
    if (staticStretch) {
      ctx.drawImage(img, 0, 0, img.width, img.height, PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    } else if (this.stageNumber === 3) {
      // Stretched quad with a v-wrapping pan: draw two stacked stretched
      // copies offset by the wrapped scroll so the seamless cycle of the
      // original's UV window survives without tiling artifacts.
      const dv = ((0.004167 * 256 * sc.declAge) % 256) * (PLAYFIELD.height / 256);
      ctx.beginPath();
      ctx.rect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
      ctx.clip();
      ctx.drawImage(img, 0, 0, img.width, img.height, PLAYFIELD.x, PLAYFIELD.y + dv - PLAYFIELD.height, PLAYFIELD.width, PLAYFIELD.height);
      ctx.drawImage(img, 0, 0, img.width, img.height, PLAYFIELD.x, PLAYFIELD.y + dv, PLAYFIELD.width, PLAYFIELD.height);
    } else {
      if (!this.eff01Pattern) this.eff01Pattern = ctx.createPattern(img, 'repeat');
      if (this.eff01Pattern) {
        // Stage 1 scrolls diagonally; stages 2/6 (and legacy stage 4)
        // scroll vertically only.
        const u = this.stageNumber === 1 ? 0.004167 * 256 * sc.declAge : 0;
        const v = this.stageNumber === 1 ? -0.008333 * 256 * sc.declAge : 0.008333 * 256 * sc.declAge;
        ctx.save();
        ctx.translate(PLAYFIELD.x - u, PLAYFIELD.y - v);
        ctx.fillStyle = this.eff01Pattern;
        ctx.fillRect(u, v, PLAYFIELD.width, PLAYFIELD.height);
        ctx.restore();
      }
    }
    // Stage 6's second authored layer: entry 1 (eff06.png) statically
    // stretched over the field at 224/255 alpha.
    if (this.stageNumber === 6) {
      const overlay = r.image(this.effectAnm.entries[1]?.imageKey ?? '');
      if (overlay) {
        ctx.globalAlpha = fade * (224 / 255);
        ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
      }
    }
    ctx.restore();
  }

  // Declaration-time effects drawn over the playfield entities: the teal
  // flash (capture.anm scr0: full-playfield quad, color 0x10c0e0, 30-frame
  // fade in/out — its runtime '@' texture is not extractable, so a flat
  // tint approximates it) and the boss portrait cutin sweep (face_01_00,
  // the dialogue portrait art; path/timing approximated — AGENTS.md §7).
  private drawSpellDeclaration(r: Renderer, ox: number, oy: number): void {
    const sc = this.spellcard;
    if (!sc) return;
    const t = sc.declAge;
    const ctx = r.ctx;
    if (t < 60) {
      const flash = (t < 30 ? t / 30 : 1 - (t - 30) / 30) * 0.5;
      ctx.save();
      ctx.globalAlpha = flash;
      ctx.fillStyle = 'rgb(16,192,224)';
      ctx.fillRect(ox, oy, PLAYFIELD.width, PLAYFIELD.height);
      ctx.restore();
    }
    if (t < 110) {
      const sprite = this.faceAnm.sprites.get(sc.portraitSprite);
      const img = sprite ? r.image(sprite.imageKey) : null;
      if (sprite && img) {
        const p = t / 110;
        const scale = 0.85;
        const w = sprite.w * scale;
        const h = sprite.h * scale;
        const x = ox + PLAYFIELD.width * 0.62 - w / 2;
        // Ease-out vertical sweep, fading in and back out at the ends.
        const ease = 1 - (1 - p) * (1 - p);
        const y = oy + PLAYFIELD.height / 2 - h / 2 + 140 - ease * 280;
        const alpha = Math.min(1, Math.min(p, 1 - p) * 5) * 0.55;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, sprite.x, sprite.y, sprite.w, sprite.h, x, y, w, h);
        ctx.restore();
      }
    }
  }

  private drawSpellOverlay(r: Renderer): void {
    if (!this.spellName) return;
    const sc = this.spellcard;
    const declAge = sc?.declAge ?? 999;
    const ctx = r.ctx;
    // Declaration window: the name rides a red ribbon banner in the lower
    // third, with Bonus / History beneath (text.anm's pre-rendered banner
    // textures are not extractable — r.text over a gradient approximates
    // the original look); afterwards it rests top-right under the HP bar.
    const declPhase = Math.min(1, Math.max(0, (declAge - 120) / 30));
    const slideIn = Math.min(1, declAge / 20);
    const bannerY = PLAYFIELD.y + 300;
    const restY = PLAYFIELD.y + 22;
    const y = bannerY + (restY - bannerY) * declPhase;
    const xRest = PLAYFIELD.x + PLAYFIELD.width - 12;
    const xBanner = PLAYFIELD.x + PLAYFIELD.width - 16 + (1 - slideIn) * 120;
    const x = xBanner + (xRest - xBanner) * declPhase;
    if (declPhase < 1) {
      const bannerAlpha = (1 - declPhase) * slideIn;
      const grad = ctx.createLinearGradient(PLAYFIELD.x, 0, PLAYFIELD.x + PLAYFIELD.width, 0);
      grad.addColorStop(0, 'rgba(160,16,16,0)');
      grad.addColorStop(0.55, 'rgba(190,24,24,0.75)');
      grad.addColorStop(1, 'rgba(120,8,8,0.9)');
      ctx.save();
      ctx.globalAlpha = bannerAlpha;
      ctx.fillStyle = grad;
      ctx.fillRect(PLAYFIELD.x, y - 13, PLAYFIELD.width, 18);
      ctx.restore();
    }
    r.text(this.spellName, x, y, { size: 13, color: '#fee', align: 'right' });
    if (sc) {
      const tally = this.spellHistory.get(sc.id);
      const history = tally ? `  history ${tally.got}/${tally.seen}` : '';
      const bonusText = sc.capturing ? `Bonus ${sc.bonus.toLocaleString('en-US')}${history}` : `Bonus failed${history}`;
      r.text(bonusText, x, y + 18, { size: 11, color: sc.capturing ? '#adf' : '#977', align: 'right' });
    }
  }

  // TH08 dialogue presentation: the four portrait slots at their authored
  // positions (the machine's position codes 3/4/6 map left/right/back like
  // the native GuiImpl layout) plus the current speaker's two text lines.
  // Text is canvas-rendered (flagged approximation until the msg text VM
  // art is decoded, same trade the TH07 dialogue made).
  private drawTh08Dialogue(r: Renderer): void {
    const dlg = this.th08Dialogue;
    if (!dlg) return;
    const state = dlg.machine.state;
    const slotX = [80, 464, 272, 272];
    for (let slot = 0; slot < 4; slot++) {
      const runner = dlg.runners[slot];
      if (!runner) continue;
      const portrait = state.portraits[slot];
      if (!portrait.active) continue;
      const frame = runner.spriteFrame();
      if (!frame) continue;
      // Position codes: 3 = left active, 4 = side rest, 6 = opposite rest.
      const x = portrait.position === 3 ? 80 : portrait.position === 6 ? 420 : slotX[slot];
      r.drawAnmFrame(frame, x + frame.w / 2, 240);
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

  // Stage title card during the opening seconds, using the stage/song names
  // decoded from the STD data.
  // Vanilla stage intro: play stdNtxt.anm's five scripts verbatim — crest,
  // vertical JP title, "Stage N", subtitle strip, and the vertical BGM
  // label — all positioned in screen coordinates by the scripts themselves
  // (see the constructor note). Runners self-remove around frame 460.
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

  private drawSidebarTh08(r: Renderer): void {
    const front = this.assets.anms.front;
    if (!this.th08HudRunners) {
      const base = front.entries[0].spriteBase;
      const mk = (script: number) =>
        new AnmRunner(front, script, { entryIndex: 0, spriteIndexOffset: base });
      // logo (-27), caption (-26), then the eight value labels (-25..-18).
      this.th08HudRunners = [-27, -26, -25, -24, -23, -22, -21, -20, -19, -18].map(mk);
      for (const runner of this.th08HudRunners) runner.update();
    }
    const p = this.playerObj;
    const run = this.runState;
    const valueX = 488; // TH08_HUD_FIELDS value column
    // The label scripts fade themselves in (entry alpha 32 -> 255); they
    // must tick every frame like every other ANM VM.
    for (const runner of this.th08HudRunners) runner.update();
    // Logo panel + caption (authors' own positions, 480,208 / 448,336).
    r.drawAnmFrame(this.th08HudRunners[0].spriteFrame(), 0, 0);
    r.drawAnmFrame(this.th08HudRunners[1].spriteFrame(), 0, 0);
    for (let i = 2; i < this.th08HudRunners.length; i++) {
      r.drawAnmFrame(this.th08HudRunners[i].spriteFrame(), 0, 0);
    }
    // TH08's /10 score rule means the live field already reads at display
    // scale — no appended zero (unlike TH07's "%8d0").
    this.drawNumber(r, Math.max(this.hiScore, this.score), valueX, 44, 9, 1, TH08_ADV);
    this.drawNumber(r, this.score, valueX, 60, 9, 1, TH08_ADV);
    // Lives/bombs icons: front.png 16x16 pair at (64,80)/(80,80), 16px pitch,
    // rows y88/y104 (GuiImpl draw: 488+i*16 @ 88/104, draw-game-scene.c:162-192).
    for (let i = 0; i < Math.max(0, p.lives); i++) {
      this.blit(r, 'front', TH08_ICON_LIFE, valueX + i * 16, 88);
    }
    for (let i = 0; i < Math.max(0, p.bombs); i++) {
      this.blit(r, 'front', TH08_ICON_BOMB, valueX + i * 16, 104);
    }
    const ctx = r.ctx;
    // Power row (y136): the 128-wide bar fills white with power/128 and the
    // value prints on it (native rows at 136/152/168/184).
    ctx.save();
    ctx.fillStyle = '#303030';
    ctx.fillRect(valueX, 136, 128, 12);
    ctx.fillStyle = 'rgba(240,240,240,0.85)';
    ctx.fillRect(valueX, 136, Math.min(128, Math.max(0, p.power)), 12);
    ctx.restore();
    if (p.power >= 128) r.text('MAX', valueX + 2, 137, { size: 11, color: '#222' });
    else this.drawNumber(r, p.power, valueX + 2, 137, 0, 1, TH08_ADV);
    this.drawNumber(r, this.graze, valueX, 152, 0, 1, TH08_ADV);
    // Point row: items toward the next extend (native "26/100").
    this.drawNumber(r, this.pointItems, valueX, 168, 0, 1, TH08_ADV);
    r.text('/' + run.nextPointItemExtendThreshold, valueX + 28, 168, { size: 12, color: '#ddd' });
    // Time row: the stage's time-orb progress toward the stage+difficulty
    // quota (DAT_004c77f0; native "825/3000" for Lunatic stage 1); the
    // night clock itself advances at the tally.
    this.drawNumber(r, run.stageTimeOrbs, valueX, 184, 0, 1, TH08_ADV);
    const quota = TH08_STAGE_ORB_QUOTAS[this.stageNumber - 1]?.[this.difficulty] ?? 0;
    r.text('/' + quota, valueX + 28, 184, { size: 12, color: '#ddd' });
    // Human/youkai rate gauge at the playfield's bottom-left. Native layout
    // (AsciiManager::InitializeVms): the bar spans 2x56px for +-10000 with
    // the 人/妖 icons at the LIMIT positions and a cursor VM (script 8) at
    // the live value; the fill reads grey (human) / periwinkle (youkai)
    // and the extremes (|g| >= the 8000 effects threshold) drive the
    // gauge VM's interrupt swap (bright state).
    {
      const gx = 66;
      const gy = 442;
      const g = run.youkaiGauge;
      const extreme = Math.abs(g) >= 8000 && (this.frame & 3) < 2;
      const pct = ((g < 0 ? '人' : g > 0 ? '妖' : '') + (Math.abs(g) / 100).toFixed(2) + '%');
      r.text(pct, gx, gy - 8, { size: 11, color: extreme ? '#fff' : g < 0 ? '#eee' : '#9cf' });
      ctx.save();
      ctx.fillStyle = '#282028';
      ctx.fillRect(gx, gy, 112, 6);
      const frac = Math.max(-1, Math.min(1, g / 10000));
      if (frac < 0) {
        ctx.fillStyle = 'rgba(232,232,232,0.9)';
        ctx.fillRect(gx + 56 + frac * 56, gy, -frac * 56, 6);
      } else {
        ctx.fillStyle = 'rgba(140,160,255,0.85)';
        ctx.fillRect(gx + 56, gy, frac * 56, 6);
      }
      // The +-8000 effects thresholds (0x164d304/0x164d306) mark where the
      // extreme interrupts arm — draw them as faint notches.
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(gx + 56 - 44.8, gy, 1, 6);
      ctx.fillRect(gx + 56 + 44.8, gy, 1, 6);
      // The cursor caret at the live position.
      ctx.fillStyle = extreme ? '#ffffff' : '#ffd070';
      ctx.fillRect(gx + 56 + frac * 56 - 1, gy - 2, 2, 10);
      ctx.restore();
      r.text('人', gx - 14, gy - 2, { size: 11, color: '#eee' });
      r.text('妖', gx + 116, gy - 2, { size: 11, color: '#9cf' });
      this.drawNumber(r, run.pointItemValue, gx + 14, gy + 12, 0, 1, TH08_ADV);
    }

    if (this.bossActive) {
      const hp = Math.max(0, this.bossActive.hp);
      const max = Math.max(1, this.bossActive.maxHp);
      ctx.fillStyle = '#311';
      ctx.fillRect(PLAYFIELD.x + 40, PLAYFIELD.y + 6, PLAYFIELD.width - 80, 5);
      ctx.fillStyle = '#e55';
      ctx.fillRect(PLAYFIELD.x + 40, PLAYFIELD.y + 6, (PLAYFIELD.width - 80) * (hp / max), 5);
    }
  }

  private drawSidebar(r: Renderer): void {
    this.drawSidebarTh08(r);
  }

  // Bottom-right difficulty tag (+ the Practice tag above it), straight from
  // pause.png: the authored ascii.anm entry-2 scripts place the 64x16 tags
  // corner-anchored at x=344 (difficulty y=444, practice y=428).
  private drawModeTags(r: Renderer): void {
    // Column layout pixel-verified against pause.png: Hard/Lunatic stack at
    // x=128, Easy/Normal at x=192 (the reverse of reading order).
    const DIFF_TAG_RECTS = [
      [192, 0, 64, 16], // Easy
      [192, 16, 64, 16], // Normal
      [128, 0, 64, 16], // Hard
      [128, 16, 64, 16], // Lunatic
      [192, 192, 64, 16], // Extra
      [192, 208, 64, 16] // Phantasm
    ] as const;
    const rect = DIFF_TAG_RECTS[this.difficulty] ?? DIFF_TAG_RECTS[1];
    this.blit(r, 'pause', rect, 344, 444, 0.9);
    if (this.mode === 'practice') this.blit(r, 'pause', [192, 240, 64, 16], 344, 428, 0.9);
  }
}
