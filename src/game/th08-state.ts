// TH08 run-global state. Field semantics and arithmetic mirror the v1.00d
// decompilation's ZunGlobals, GameManager, and ItemManager structures.
export class Th08RunState {
  score = 0;
  displayScore = 0;
  graze = 0;
  grazeInStage = 0;
  spellcardsCaptured = 0;
  youkaiGauge = 0;
  youkaiGaugeCopy = 0;
  // TH08 op 184's write: the GLOBAL side mirror on singleton 0x4ea670 bit
  // 11 (every boss/midboss phase sub opens with ins_184(1)). Known reader:
  // FUN_00416b10 gates familiar-kill additions to the live spell bonus on
  // this bit being clear.
  th08SideMirror: 0 | 1 = 0;
  pointItemValue = 300000;
  clockTime = 0;
  pointItemsCollectedInStage = 0;
  pointItemsCollected = 0;
  pointItemExtends = 0;
  nextPointItemExtendThreshold = 100;
  currentTimeOrbs = 0;
  totalTimeOrbs = 0;
  stageTimeOrbs = 0;
  // The ZunTimer at 0x18b89d4: CollectTimeOrb (FUN_004412b0) applies its ±111
  // gauge step only while this timer reads zero (FUN_0040d3f0 gate @
  // 0x441390-5). The master death sweep (FUN_0042adb0, param_2=1) rewrites it
  // on every normal-path death: 0 when the dying enemy's child chain is
  // non-empty (all.c:20542), then 50 when the dying enemy itself has a parent
  // (all.c:20552-20554, the third of the 0/30/50 timer triple) — i.e. a
  // familiar death closes the orb-gauge gate for 50 frames. The item
  // manager's walk tail (FUN_00440500 @ 0x440c8b-0x440cb7) decrements it once
  // per frame while nonzero, clamping at 0. BSS-zero at stage start.
  timeOrbGaugeLockout = 0;
  gaugeLocked = false;
  // Border Team config (Player::AddedCallback @ 0x44d9ee-0x44da22, team 0):
  // limits ±10000, effects thresholds ±8000, tint thresholds ±2000. The
  // other teams/solos narrow these (0x44da30+); not reachable in this slice.
  private readonly gaugeLimits: readonly [number, number] = [-10000, 10000];
  private readonly gaugeEffectThresholds: readonly [number, number] = [-8000, 8000];
  private readonly gaugeTintThresholds: readonly [number, number] = [-2000, 2000];

  constructor(readonly difficulty: number) {
    this.updatePointItemExtendThreshold();
  }

  // GameManager::AddTimeOrbs @ 0x418220. A negative amount can only reduce
  // the current counter to zero; once it would underflow, total/stage counters
  // and the point value are untouched. Positive orbs advance the night value by
  // floor((amount + oldTotalParity) / 2) * 10.
  addTimeOrbs(amount: number): void {
    if (amount < 0 && this.currentTimeOrbs < -amount) {
      this.currentTimeOrbs = 0;
      return;
    }
    // FUN_00418220 @ all.c:10245: the running total (+0x44) is advanced
    // BEFORE the point value (+0x24) reads its parity, so a single orb pays
    // +10 on ODD totals (native f630: pv 300010 on the FIRST collect).
    this.currentTimeOrbs += amount;
    this.totalTimeOrbs += amount;
    this.stageTimeOrbs += amount;
    if (amount > 0) {
      this.pointItemValue += Math.trunc((amount + (this.totalTimeOrbs & 1)) / 2) * 10;
    }
  }

  // GameManager::AddToYoukaiGauge @ 0x43c0bb. The copy is refreshed only when
  // the gauge is not locked (or the caller explicitly bypasses the lock).
  addYoukaiGauge(amount: number, bypassLock = false): void {
    if (this.gaugeLocked && !bypassLock) return;
    this.youkaiGauge += amount;
    if (this.youkaiGauge < this.gaugeLimits[0]) {
      this.youkaiGauge = this.gaugeLimits[0];
    } else if (this.youkaiGauge > this.gaugeLimits[1]) {
      this.youkaiGauge = this.gaugeLimits[1];
    }
    this.youkaiGaugeCopy = this.youkaiGauge;
  }

  addClockTime(amount: number): void {
    this.clockTime += amount;
  }

  gaugeIsExtremelyHuman(): boolean {
    return this.youkaiGauge <= this.gaugeEffectThresholds[0];
  }

  gaugeIsExtremelyYoukai(): boolean {
    return this.youkaiGauge >= this.gaugeEffectThresholds[1];
  }

  // Tally "over-80%"/"over 80%" row accumulators + the extreme-gauge score
  // trickle (player tick tail, all.c:37597-37614): every non-dialogue
  // player tick counts the denominator; a frame with the gauge at/below the
  // human effects threshold counts gaugeTrickHuman, at/above the youkai
  // threshold counts gaugeTrickYoukai, and either side trickles a +100
  // award (FUN_004181f0 → +10 live score) per frame.
  gaugeTrickTotal = 0;
  gaugeTrickYoukai = 0;
  gaugeTrickHuman = 0;

  // Returns the award to credit this frame (0 or 100).
  tickGaugeTrickle(): number {
    this.gaugeTrickTotal++;
    if (this.youkaiGauge <= this.gaugeEffectThresholds[0]) {
      this.gaugeTrickHuman++;
      return 100;
    }
    if (this.youkaiGauge >= this.gaugeEffectThresholds[1]) {
      this.gaugeTrickYoukai++;
      return 100;
    }
    return 0;
  }

  // The player update's gauge block (0x44bdf0-0x44c012). Once the shot
  // cycle is armed and the separate idle timer has counted back to zero,
  // player+0xe2ae8 ramps the gauge contribution from zero: trunc(timer/15)
  // through timer 300 (the 0x41 fnstsw mask covers C0|C3, so EQUALITY also
  // takes the divide path), then the fixed cap 21 (0x41a80000 @ 0x44be82;
  // divisor 15.0 @ 0x4b6e94, bound 300.0 @ 0x4b6f30; the native Stage-2
  // checkpoints -1002 @ f1237 / -2513 @ f1276 pin both the cap and the
  // equality frame). Direction comes from the RAW focus key byte
  // (player+3 @ 0x44bcb9) — equivalent to the form byte whenever the
  // stability gate is open, since any edge closes the gate for 31 frames
  // while the form settles within 8.
  gaugeFireDrift(focused: boolean, fireTimer: number): number {
    const amount = fireTimer > 300 ? 21 : Math.trunc(fireTimer / 15);
    if (amount === 0) return 0;
    return focused ? amount : -amount;
  }

  // The idle branch (0x44bef9-0x44c007): cycle disarmed for >= 30 frames
  // and the gauge off zero — it drifts back toward the center by depth,
  // mirroring the human tiers: youkai side >= effects(+8000) -> -5,
  // >= tint(+2000) -> -3 (0x44bd8f), >= 1 -> -2; human side
  // <= effects(-8000) -> +5, <= tint(-2000) -> +3, else +2.
  gaugeIdleDrift(): number {
    const g = this.youkaiGauge;
    if (g >= this.gaugeEffectThresholds[1]) return -5;
    if (g >= this.gaugeTintThresholds[1]) return -3;
    if (g >= 1) return -2;
    if (g <= this.gaugeEffectThresholds[0]) return 5;
    if (g <= this.gaugeTintThresholds[0]) return 3;
    return 2;
  }

  // Dialogue start (0x42b1e5-0x42b228, the boss-conversation path of the
  // enemy death settlement): gauge += trunc(-gauge / 12).
  gaugeDialoguePull(): number {
    return Math.trunc(-this.youkaiGauge / 12);
  }

  // Enemy kill (0x42d65c-0x42d682, right before the death-mode switch):
  // sign from the RAW focus key byte at player+3 (movzbl 0x17d5efb; test;
  // jne) — unfocused -200 (toward human), focused +200 (toward youkai).
  // This is the focus byte, NOT the form byte: they diverge for up to 8
  // frames around every focus edge while the form settles.
  gaugeKillDelta(focused: boolean): number {
    return focused ? 200 : -200;
  }

  // Graze (0x44aa78): +100 per graze event.
  gaugeGrazeDelta(): number {
    return 100;
  }

  // Graze counter increment (0x44a930 head): +1, +2 past the human tint,
  // +3 past the human effects threshold.
  grazeCounterIncrement(): number {
    if (this.youkaiGauge <= this.gaugeEffectThresholds[0]) return 3;
    if (this.youkaiGauge <= this.gaugeTintThresholds[0]) return 2;
    return 1;
  }

  addScore(award: number): number {
    const credited = Math.trunc(award / 10);
    this.score += credited;
    return credited;
  }

  // Item::CollectPoint @ 0x440e40 and Item::CollectPointSmall @ 0x441020.
  // `abovePoCRandom` is the native RNG draw used only above the PoC line.
  collectPoint(options: {
    atOrAbovePoC: boolean;
    isMaxValue?: boolean;
    abovePoCRandom?: number;
  }): { award: number; creditedScore: number; rankDelta: number; extendsGained: number } {
    const full = this.pointItemValue;
    let award = full;
    if (options.atOrAbovePoC) {
      award = Math.trunc(full / 2) -
        (options.abovePoCRandom ?? 0) * Math.trunc(full / 1000);
    }
    if (options.isMaxValue) award = full;
    award -= award % 10;
    if (this.gaugeIsExtremelyHuman()) award *= 2;

    const creditedScore = this.addScore(award);
    this.pointItemsCollectedInStage++;
    this.pointItemsCollected++;
    let extendsGained = 0;
    if (this.pointItemExtends >= 0) {
      while (this.nextPointItemExtendThreshold <= this.pointItemsCollected) {
        this.pointItemExtends++;
        this.updatePointItemExtendThreshold();
        extendsGained++;
      }
    }
    return { award, creditedScore, rankDelta: award < full ? 3 : 10, extendsGained };
  }

  collectPointSmall(options: {
    atOrAbovePoC: boolean;
    isMaxValue?: boolean;
    abovePoCRandom?: number;
  }): { award: number; creditedScore: number } {
    const full = this.pointItemValue;
    let award = full;
    if (options.atOrAbovePoC) {
      award = Math.trunc(full / 2) -
        (options.abovePoCRandom ?? 0) * Math.trunc(full / 1000);
    }
    if (options.isMaxValue) award = full;
    award = Math.trunc(award / 10);
    award -= award % 10;
    if (this.gaugeIsExtremelyHuman()) award *= 2;
    return { award, creditedScore: this.addScore(award) };
  }

  // Item::CollectTimeOrb @ 0x4412b0. The ±111 gauge step is gated on the
  // 0x18b89d4 lockout timer reading zero (FUN_0040d3f0(0) @ 0x441395), NOT on
  // the spell timer: while a post-familiar-death lockout counts down (50
  // frames, armed by FUN_0042adb0(1)'s child-with-parent tail), orb collects
  // pay score/orbs/rank but leave the gauge alone. The sign follows the RAW
  // focus byte (player+3, DAT_017d5efb): unfocused −111, focused +111.
  collectTimeOrb(options: {
    specialScoringMode?: boolean;
    timerCurrent?: number;
    playerRole?: 0 | 1;
  }): {
    award: number;
    creditedScore: number;
    rankDelta: number;
    gaugeDelta: number | null;
  } {
    let award: number;
    if (options.specialScoringMode) {
      award = 100;
    } else if (this.pointItemsCollectedInStage < 2000) {
      // FUN_004412b0: the <2000 bracket tests the STAGE counter (run+0x2c)
      // while the award scales with the cumulative counter (run+0x30).
      award = Math.max((this.pointItemsCollected >> 1) * 10, 100);
    } else {
      award = 10000;
    }
    const creditedScore = this.addScore(award);
    this.addTimeOrbs(1);
    const gaugeDelta = options.timerCurrent === 0
      ? options.playerRole === 0 ? -111 : 111
      : null;
    return { award, creditedScore, rankDelta: 8000, gaugeDelta };
  }

  // ItemManager::UpdatePointItemExtendThreshold @ 0x440470 and the adjacent
  // v1.00d threshold tables.
  updatePointItemExtendThreshold(): void {
    if (this.difficulty < 4) {
      const table = [100, 250, 500, 800, 1100, 9999];
      this.nextPointItemExtendThreshold = this.pointItemExtends < 6
        ? table[this.pointItemExtends]
        : (this.pointItemExtends - 5) * 500 + table[5];
      return;
    }
    const table = [200, 666, 9999, 1];
    this.nextPointItemExtendThreshold = this.pointItemExtends < 3
      ? table[this.pointItemExtends]
      : 99999;
  }
}
