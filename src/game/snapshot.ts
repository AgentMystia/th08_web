import type { StageScene } from './stage-scene';

// Rich simulation-state snapshot shared by the browser test hook
// (window.__TH08_TEST__.snapshot()) and the headless replay harness.
export function stageSnapshot(scene: StageScene): Record<string, unknown> {
  return {
    scene: 'stage',
    stageNumber: scene.stageNumber,
    mode: scene.mode,
    frame: scene.frame,
    stageFrame: scene.stageFrame,
    difficulty: scene.difficulty,
    team: scene.playerObj.team,
    score: scene.score,
    hiScore: scene.hiScore,
    enemies: scene.enemies.length,
    bullets: scene.enemyBullets.length,
    items: scene.items.length,
    itemDump: scene.items.slice(0, 12).map((it) => ({
      type: it.type, x: Math.round(it.x), y: Math.round(it.y), state: it.state
    })),
    timelines: scene.runtime.timelineCursors.map((c) => ({ ...c })),
    bossActive: !!scene.bossActive,
    bossHp: scene.bossActive?.hp ?? null,
    // PLAN.md Phase 0: explicit boss ownership — the primary boss entity and
    // the full op99 slot table (UI-001 / LIFE-001 evidence).
    bossOwner: scene.bossActive
      ? { id: scene.bossActive.id, sub: scene.bossActive.ecl.subId, slot: scene.bossActive.ecl.bossSlot }
      : null,
    bossSlots: scene.runtime.bossSlots.map((b) => (b ? { id: b.id, sub: b.ecl.subId } : null)),
    lasers: scene.enemyLasers.filter((l) => l.inUse).length,
    laserDump: scene.enemyLasers.filter((l) => l.inUse).slice(0, 6).map((l) => ({
      x: Math.round(l.x), y: Math.round(l.y), angle: Number(l.angle.toFixed(2)),
      near: Math.round(l.nearDist), far: Math.round(l.farDist), w: Number(l.displayWidth.toFixed(1)), state: l.state,
      owner: l.ownerId, flags: l.flags, color: l.color, width: Number(l.width.toFixed(1))
    })),
    stageClear: scene.stageClear,
    pause: scene.pauseState
      ? { cursor: scene.pauseState.cursor, confirm: scene.pauseState.confirm, confirmCursor: scene.pauseState.confirmCursor }
      : null,
    stageClearTimer: scene.stageClearTimer,
    clearPresentation: {
      loadingKey: scene.clearLoadingKey,
      loading: scene.clearLoadingRunner ? {
        id: scene.clearLoadingRunner.scriptId,
        frame: Math.round(scene.clearLoadingRunner.frame),
        removed: scene.clearLoadingRunner.removed,
        visible: scene.clearLoadingRunner.visible
      } : null,
      capture: scene.clearCaptureRunner ? {
        id: scene.clearCaptureRunner.scriptId,
        frame: Math.round(scene.clearCaptureRunner.frame),
        removed: scene.clearCaptureRunner.removed,
        visible: scene.clearCaptureRunner.visible,
        waiting: scene.clearCaptureRunner.waiting
      } : null
    },
    stageTransition: {
      timer: scene.stageTransitionTimer,
      total: scene.stageTransitionTiles.length,
      live: scene.stageTransitionTiles.filter((tile) => !tile.runner.removed).length,
      first: scene.stageTransitionTiles[0] ? {
        script: scene.stageTransitionTiles[0].runner.scriptId,
        frame: Math.round(scene.stageTransitionTiles[0].runner.frame),
        delay: scene.stageTransitionTiles[0].delay
      } : null,
      last: scene.stageTransitionTiles.length ? {
        script: scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].runner.scriptId,
        frame: Math.round(scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].runner.frame),
        delay: scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].delay
      } : null
    },
    gameOver: scene.gameOver,
    continueActive: !!scene.continueScreen,
    spellName: scene.spellName,
    spell: scene.spellcard ? { id: scene.spellcard.id, capturing: scene.spellcard.capturing, declAge: scene.spellcard.declAge } : null,
    rngSeed: scene.rng.seed,
    player: {
      x: scene.playerObj.x,
      y: scene.playerObj.y,
      lives: scene.playerObj.lives,
      bombs: scene.playerObj.bombs,
      power: scene.playerObj.power,
      // TH08 human(0)/youkai(1) form byte (player+5) and the focus key.
      th08Form: scene.playerObj.th08Form,
      focusHeld: scene.playerObj.focusHeld,
      invuln: scene.playerObj.invulnFrames,
      bombInvuln: scene.playerObj.bombInvuln,
      deathbombMeter: scene.playerObj.deathbombMeter,
      hitState: scene.playerObj.hitState,
      dyingFrame: scene.playerObj.dyingFrame,
      materializeFrame: scene.playerObj.materializeFrame,
      alive: scene.playerObj.alive
    },
    settledDamage: scene.settledDamageThisFrame,
    bomb: { timer: scene.playerObj.bombTimer },
    graze: scene.graze,
    pointItems: scene.pointItems,
    th08: {
      youkaiGauge: scene.runState.youkaiGauge,
      clockTime: scene.runState.clockTime,
      currentTimeOrbs: scene.runState.currentTimeOrbs,
      totalTimeOrbs: scene.runState.totalTimeOrbs,
      pointItemValue: scene.runState.pointItemValue,
      pointItemExtends: scene.runState.pointItemExtends,
      nextPointItemExtendThreshold: scene.runState.nextPointItemExtendThreshold
    },
    spellsCaptured: scene.runState?.spellcardsCaptured ?? 0,
    playerBullets: scene.playerBullets.length,
    playerBulletDump: scene.playerBullets.slice(0, 8).map((b) => ({
      x: Math.round(b.x),
      y: Math.round(b.y),
      rect: [b.rect.x, b.rect.y, b.rect.w, b.rect.h],
      img: b.rect.imageKey,
      vx: Number(b.vx.toFixed(2)),
      vy: Number(b.vy.toFixed(2))
    })),
    // PLAN.md Phase 0: full-pool bullet type histogram keyed `sprite:offset`
    // (RENDER-001/VM-001 evidence) — the capped bulletDump under-samples
    // dense boss patterns.
    bulletHistogram: scene.enemyBullets.reduce<Record<string, number>>((h, b) => {
      if (!b.dead) {
        const key = `${b.sprite}:${b.spriteOffset}`;
        h[key] = (h[key] ?? 0) + 1;
      }
      return h;
    }, {}),
    bulletDump: scene.enemyBullets.slice(0, 64).map((b) => ({
      id: b.id,
      x: Math.round(b.x),
      y: Math.round(b.y),
      flags: b.flags,
      dead: !!b.dead,
      sprite: b.sprite,
      off: b.spriteOffset,
      rect: [b.rect.x, b.rect.y, b.rect.w, b.rect.h],
      img: b.rect.imageKey,
      vx: Number(b.vx.toFixed(2)),
      vy: Number(b.vy.toFixed(2)),
      ex: b.exFlags,
      grace: b.graceFrames ?? 0
    })),
    enemyDump: scene.enemies.slice(0, 8).map((e) => ({
      id: e.id,
      sub: e.ecl.subId,
      ctxSub: e.ecl.ctx.subId,
      ctxTime: e.ecl.ctx.time,
      ctxIndex: e.ecl.ctx.index,
      waitTimer: e.ecl.ctx.waitTimer,
      x: Math.round(e.x),
      y: Math.round(e.y),
      hp: e.hp,
      boss: e.ecl.isBoss,
      bossSlot: e.ecl.bossSlot,
      canTakeDamage: e.ecl.canTakeDamage,
      shotCollision: e.ecl.shotCollision,
      shield: e.ecl.damageShield,
      dmg: e.damageThisFrame ?? 0,
      lastFire: e.ecl.lastFireFrame ?? -1,
      deathCallbackSub: e.ecl.deathCallbackSub,
      pendingInterrupt: e.ecl.pendingInterrupt,
      interactable: e.ecl.interactable,
      invisible: e.ecl.invisible,
      // TH08 familiar (使魔) state: the side bit (0 materialized / 1
      // ethereal) and the manager list id (0 = player-youkai / 2 = human).
      familiar: e.ecl.th08?.familiar ?? false,
      sideBit: e.ecl.th08?.sideBit ?? 0,
      managerList: e.ecl.th08?.managerList ?? 0,
      deathMode: e.ecl.deathMode,
      timer: e.ecl.bossTimer
    }))
  };
}
