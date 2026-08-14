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

  constructor(
    readonly difficulty: number,
    private readonly gaugeLimits: readonly [number, number] = [-10000, 10000]
  ) {
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
