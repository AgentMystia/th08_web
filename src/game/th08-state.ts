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
  pointItemValue = 300000;
  clockTime = 0;
  pointItemsCollectedInStage = 0;
  pointItemsCollected = 0;
  pointItemExtends = 0;
  nextPointItemExtendThreshold = 100;
  currentTimeOrbs = 0;
  totalTimeOrbs = 0;
  stageTimeOrbs = 0;
  gaugeLocked = false;
  private readonly gaugeEffectThresholds: readonly [number, number];

  constructor(
    readonly difficulty: number,
    private readonly gaugeLimits: readonly [number, number] = [-10000, 10000],
    gaugeEffectThresholds: readonly [number, number] = [-8000, 8000]
  ) {
    this.gaugeEffectThresholds = gaugeEffectThresholds;
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
    const oldTotalParity = this.totalTimeOrbs & 1;
    this.currentTimeOrbs += amount;
    this.totalTimeOrbs += amount;
    this.stageTimeOrbs += amount;
    if (amount > 0) {
      this.pointItemValue += Math.trunc((amount + oldTotalParity) / 2) * 10;
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

  // Item::CollectTimeOrb @ 0x4412b0. Gauge movement is returned rather than
  // applied here because the native branch also depends on the live player side.
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
    } else if (this.pointItemsCollected < 2000) {
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
