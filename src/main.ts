import { Loop } from './core/loop';
import { Input } from './core/input';
import { LatencyRecorder, type LatencyLogicState, type LatencySample } from './core/latency';
import { PLAYFIELD, Renderer } from './gfx/renderer';
import { AudioBus } from './audio/audio';
import { loadAssets } from './game/assets';
import { StageScene } from './game/stage-scene';
import { Th08MenuFlow } from './game/th08-title-scene';
import type { CharacterId } from './game/player';
import { stageBgmTracks } from './game/bgm';
import { stageSnapshot } from './game/snapshot';

interface TestHook {
  ready: boolean;
  pause(): void;
  // Restart the real rAF loop after pause() — for probes that must watch
  // live presentation (e.g. the desync stage-5 flicker probe) instead of
  // stepping frames synchronously.
  resume(): void;
  advance(n: number): void;
  setLives(n: number): void;
  setInvuln(frames: number): void;
  snapshot(): Record<string, unknown>;
  // Both read the PRESENTED display canvas (post-present()). pixelAt is the
  // historical name every probe uses; displayPixelAt exists so new probes
  // can be explicit about presented-vs-drawn semantics.
  pixelAt(x: number, y: number): number[];
  displayPixelAt(x: number, y: number): number[];
  capturePixel(x: number, y: number): number[];
  setPlayer(x: number, y: number): void;
  setPower(v: number): void;
  inject(held: string[], pressed: string[]): void;
  damageBoss(n: number): void;
  clearEnemyBullets(): void;
  spawnLog(): { t: number; time: number; sub: number }[];
  lifecycleLog(): { f: number; ev: string; id: number; sub: number; a?: number }[];
  frameCost(): { update: number[]; draw: number[] };
  // Cost rings are intentionally disabled unless the page was opened with
  // ?test=1&perf=1; plain ?test=1 returns empty arrays to avoid perturbing
  // fidelity/latency probes with performance.now() calls.
  performanceEnabled(): boolean;
  // Last frame's per-pass draw costs (ms), PERF-001 breakdown.
  drawPasses(): Record<string, number>;
  // Test-only: flood the item pool for PERF-001's dense-items scenario.
  fillItems(n: number): void;
  // Releases every previously injected held key (Input.inject is additive).
  clearInput(): void;
  setBombs(n: number): void;
  bgm(): { active: string | null; decoded: string[] };
  canvasContextAttributes(): {
    requestedDesynchronized: boolean;
    backBuffered: boolean;
    actual: CanvasRenderingContext2DSettings | null;
  };
  latencySamples(): LatencySample[];
  clearLatencySamples(): void;
  playerShotSerial(): number;
  resetBombForLatencyProbe(): void;
}

declare global {
  interface Window {
    __TH08_TEST__?: TestHook;
  }
}



async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing #game canvas');
  const params = new URLSearchParams(location.search);
  const isTest = params.get('test') === '1';
  const latencyEnabled = isTest && params.get('latency') === '1';
  const perfEnabled = isTest && params.get('perf') === '1' && !latencyEnabled;
  // Low-latency canvas is ON by default for everyone (players and tests):
  // granting browsers (Chromium) skip 1-2 compositor vsyncs; the renderer
  // then draws to a backbuffer and present() copies it in one op, which is
  // what makes the grant safe (the old Stage-5 spell-card flicker came
  // from incremental front-buffer draws, before the backbuffer existed).
  // Non-granting browsers (Firefox/Safari) feature-detect to the direct
  // path unchanged. ?desync=0 is the player-facing kill switch and the
  // latency-probe control arm; ?desync=1 stays valid for explicit A/B
  // URLs. ?backbuffer=1 (test-only) forces the backbuffer/present() path
  // on engines that never grant desync, for cross-engine present parity.
  const desyncParam = params.get('desync');
  const renderer = new Renderer(canvas, {
    desynchronized: desyncParam !== '0',
    forceBackbuffer: isTest && params.get('backbuffer') === '1'
  });
  renderer.clear('#000');
  renderer.text('Now Loading...', 270, 230, { size: 16 });
  renderer.present();

  const assets = await loadAssets();
  renderer.assets = assets.images;
  const latencyRecorder = latencyEnabled ? new LatencyRecorder() : null;
  const input = new Input(latencyRecorder ? (timing) => latencyRecorder.recordInput(timing) : undefined);
  const audio = new AudioBus();
  // Eager-preload every BGM track stage 1 can need (title + stage + boss) as
  // soon as the AudioBus exists, so decodeAudioData has already finished by
  // the time playBgm() is actually called for it (title on first
  // interaction; stage/boss at stage start). Without this, the stage track
  // was measured starting 138.9ms (~8 frames) after stage frame 0 on a
  // zero-latency local server, and 8.9s/26.2s (~533/~1573 frames) under
  // throttled Slow-4G/Fast-3G — with the title theme still audibly looping
  // for the entire gap (measured during the 2026-07-10 BGM preload audit).
  audio.preloadBgm(['th08_01', 'th08_00', 'th08_03']);
  // ?test=1 alone must still boot directly into the stage exactly as before
  // the menu flow existed (scripts/dev-shot.mjs and other automated tooling
  // depend on this). Add ?menu=1 alongside ?test=1 to make the menu flow
  // itself screenshot-testable; without ?test=1 (i.e. a real player), the
  // menu flow is always used.
  const useMenu = !isTest || params.get('menu') === '1';
  // Test-only direct arcade entry: keep the normal menu bypass while using
  // the real stage-clear/continue/next-stage flow. This lets the transition
  // probe exercise carryState() rather than constructing stage 2 directly.
  const testArcade = isTest && params.get('arcade') === '1';

  let stage: StageScene | null = null;
  let menu: Th08MenuFlow | null = null;
  // Hi-score carried across stage runs within this browser session.
  let sessionHiScore = 100000;
  const latencyState = (s: StageScene): LatencyLogicState => ({
    x: s.playerObj.x,
    y: s.playerObj.y,
    focused: s.playerObj.focusHeld,
    playerShotSerial: s.playerShotSerial,
    bombTimer: s.playerObj.bombTimer
  });

  // Shared by both the menu's "confirm" callback and the direct (?test=1,
  // no ?menu=1) boot path below, so BGM/preload behavior is identical either
  // way. Track 1 (th08_01) is the title theme, per musiccmt.txt.
  //
  function startStage(
    difficulty: number,
    character: CharacterId,
    stageNumber = 1,
    carry: import('./game/stage-scene').RunCarry | null = null,
    practice = false
  ): StageScene {
    const s = new StageScene(assets, audio, difficulty, character, stageNumber, carry);
    s.setLatencyObservationEnabled(latencyEnabled);
    // Headless probes (?test=1 without ?menu=1) keep the scene alive forever;
    // real play gets the arcade flow: continue screen + return to title.
    // Practice (exe DAT_00625628 bit0): one stage, no continues, straight
    // back to the title on clear or game over.
    s.mode = practice ? 'practice' : useMenu || testArcade ? 'arcade' : 'test';
    // Practice starts with 8 lives (Th07.exe FUN_0042cf2f @ all.c:19718-19720,
    // CONFIRMED), and any stage other than 1 starts at FULL power — the
    // stage-entry tail sets power to _DAT_0048eb84 = 128.0 when the run's
    // practice flag (stats+0x93d8 bit 0) is set and the stage isn't 1
    // (all.c:19856-19859). Stage-1 practice keeps the normal power-0 start.
    if (practice) {
      s.playerObj.lives = 8;
      if (stageNumber !== 1) s.playerObj.power = 128;
    }
    s.hiScore = Math.max(s.hiScore, sessionHiScore);
    s.onExitToTitle = () => {
      sessionHiScore = Math.max(sessionHiScore, s.hiScore);
      stage = null;
      // Returning from practice parks the title cursor back on Practice
      // Start (exe FUN_00452e91 @ all.c:40457-40459).
      menu = createMenu();
      audio.preloadBgm(['th08_01']);
      audio.playBgm('th08_01');
    };
    // Pause-menu 最初からやり直す: restart the run from its beginning —
    // story from stage 1, practice/test from the current stage.
    s.onRetryRun = () => {
      sessionHiScore = Math.max(sessionHiScore, s.hiScore);
      startStage(difficulty, character, s.mode === 'arcade' ? 1 : stageNumber, null, practice);
    };
    // Stage clear tally advanced -> tear down and enter the next stage with
    // the run state carried over (score/lives/bombs/power/graze/cherry).
    s.onStageComplete = (c) => {
      sessionHiScore = Math.max(sessionHiScore, c.hiScore);
      startStage(difficulty, character, stageNumber + 1, c);
    };
    stage = s;
    menu = null;
    const [stageTrack, bossTrack] = stageBgmTracks(stageNumber);
    audio.preloadBgm([stageTrack, bossTrack]);
    // Main-route transitions have an entire stage of lead time to decode the
    // next pair, matching the native game's ready-before-play behavior.
    if (stageNumber < 6) audio.preloadBgm([...stageBgmTracks(stageNumber + 1)]);
    audio.playBgm(stageTrack);
    return s;
  }

  // Menu-initiated runs: difficulty 4 = Extra -> stage 7, 5 = Phantasm ->
  // stage 8; main difficulties start at stage 1. Practice carries its own
  // chosen stage.
  // TH08 menu start: difficulty 0-3, Border Team, stage 1. (The TH07 menu's
  // practice/extra option mapping went away with MenuFlow; the TH08 slice's
  // title only enables Game Start.)
  const startFromMenu = (difficulty: number, character: CharacterId) =>
    startStage(difficulty, character, 1);

  function createMenu(): Th08MenuFlow {
    return new Th08MenuFlow(assets, audio, startFromMenu);
  }

  if (useMenu) {
    menu = createMenu();
    audio.preloadBgm(['th08_01']);
    audio.playBgm('th08_01');
  } else {
    // ?difficulty=0..5 (4 = Extra, 5 = Phantasm), ?stage=1..8 for probes.
    // Default shot is the TH08 Border Team: the browser ships only the TH08
    // asset bundle, so a TH07 character id cannot resolve its player ANM
    // here (the TH07 engine path stays exercised by the node test harness,
    // whose stub assets still provide the TH07 ANMs).
    const difficulty = Math.min(5, Math.max(0, Number(params.get('difficulty') ?? 1)));
    const character = (params.get('shot') ?? 'reimuYukari') as CharacterId;
    const stageNumber = Math.min(8, Math.max(1, Number(params.get('stage') ?? 1)));
    const s = startStage(difficulty, character, stageNumber);
    // Test-only override so scripts/dev-shot.mjs can snapshot a shot pattern
    // at an arbitrary power bracket without needing to grind for it in-game.
    if (params.has('power')) s.playerObj.power = Number(params.get('power'));
    // Test-only entry point for driving a real MSG stream without waiting
    // thousands of stage frames; DialogueRunner and AudioBus are unchanged.
    if (params.has('dialogue')) s.startDialogue(Number(params.get('dialogue')));
  }

  // A throw escaping the rAF tick used to end the loop permanently (frozen
  // canvas, BGM still playing, input dead — the stage-4 tester hard-lock).
  // Halt the crashed phase but keep rAF alive, and rethrow asynchronously so
  // the failure still surfaces as an uncaught page error for devtools and the
  // headless probes' PAGE ERRORS reporting.
  let simHalted = false;
  let drawHalted = false;
  const reportFatal = (phase: string, err: unknown): void => {
    console.error(`[th07] ${phase} halted by uncaught error`, err);
    setTimeout(() => {
      throw err instanceof Error ? err : new Error(String(err));
    });
  };
  const drawErrorBanner = (): void => {
    const ctx = renderer.ctx;
    const scale = ctx.canvas.width / 640;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 458, 640, 22);
    ctx.fillStyle = '#ff6666';
    ctx.font = '12px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('ERROR: simulation halted by an uncaught exception (see console)', 8, 469);
    ctx.restore();
  };
  const loop = new Loop({
    update: () => {
      if (simHalted) return;
      const liveFrame = input.frame();
      latencyRecorder?.markSampled(performance.now());
      const observedStage = stage;
      const beforeLatency = latencyRecorder && observedStage ? latencyState(observedStage) : null;
      try {
        if (menu) {
          menu.update(liveFrame);
        } else if (stage) {
          stage.update(liveFrame);
        }
        if (latencyRecorder && observedStage && stage === observedStage && beforeLatency) {
          latencyRecorder.observeLogic(
            beforeLatency,
            latencyState(observedStage),
            observedStage.frame,
            performance.now()
          );
        }
      } catch (err) {
        simHalted = true;
        reportFatal('simulation', err);
      }
    },
    draw: () => {
      let drawnLatencySamples: LatencySample[] = [];
      if (!drawHalted) {
        try {
          if (menu) menu.draw(renderer);
          else if (stage) stage.draw(renderer, perfEnabled);
          if (latencyRecorder && stage) {
            const samples = latencyRecorder.pendingDrawSamples();
            if (samples.length > 0) {
              const sequence = samples[samples.length - 1].sequence;
              const ctx = renderer.ctx;
              ctx.save();
              ctx.fillStyle = sequence & 1 ? '#fff' : '#000';
              ctx.fillRect(
                PLAYFIELD.x + 1,
                Math.max(PLAYFIELD.y, Math.min(PLAYFIELD.y + PLAYFIELD.height - 3, PLAYFIELD.y + stage.playerObj.y - 1)),
                3,
                3
              );
              ctx.restore();
              drawnLatencySamples = samples;
            }
          }
          renderer.present();
          if (latencyRecorder && drawnLatencySamples.length > 0) {
            latencyRecorder.markDrawEnd(drawnLatencySamples, performance.now());
          }
        } catch (err) {
          drawHalted = true;
          if (!simHalted) reportFatal('rendering', err);
          simHalted = true;
        }
      }
      if (simHalted || drawHalted) {
        drawErrorBanner();
        renderer.present();
      }
    }
    // Third arg: ?pace=raw disables the near-60Hz vsync snap (kill switch;
    // see src/core/pacing.ts for what the snap fixes).
  }, perfEnabled, params.get('pace') !== 'raw');

  // ?paused=1 (test-only): do not start the rAF loop — the page renders
  // nothing until the probe's first advance(). Removes the boot-frame
  // jitter between probe runs so fixed-frame checkpoints are comparable.
  const startPaused = isTest && params.get('paused') === '1';
  if (isTest) {
    window.__TH08_TEST__ = {
      ready: true,
      pause: () => loop.stop(),
      resume: () => loop.start(),
      advance: (n: number) => loop.advance(n),
      snapshot: () => {
        if (menu) return menu.snapshot();
        return stageSnapshot(stage!);
      },
      // Reads the PRESENTED display canvas — the pre-backbuffer historical
      // semantics every existing pixel probe was written against. advance()
      // ends in draw()+present(), so values match the backbuffer when
      // present() works and expose it when it doesn't (the 8552afe class).
      pixelAt: (x: number, y: number) => renderer.displayPixel(x, y),
      displayPixelAt: (x: number, y: number) => renderer.displayPixel(x, y),
      capturePixel: (x: number, y: number) => {
        const surface = renderer.image('capture:@');
        if (!(surface instanceof HTMLCanvasElement)) return [0, 0, 0, 0];
        const ctx = surface.getContext('2d');
        return ctx ? Array.from(ctx.getImageData(x, y, 1, 1).data) : [0, 0, 0, 0];
      },
      setPlayer: (x: number, y: number) => {
        if (!stage) return;
        stage.playerObj.x = x;
        stage.playerObj.y = y;
      },
      setPower: (v: number) => {
        if (stage) stage.playerObj.power = v;
      },
      inject: (held: string[], pressed: string[]) => {
        input.inject(held as never, pressed as never);
      },
      spawnLog: () => stage?.runtime.spawnLog ?? [],
      lifecycleLog: () => stage?.runtime.lifecycleLog ?? [],
      frameCost: () => loop.frameCosts(),
      performanceEnabled: () => perfEnabled,
      drawPasses: () => stage?.drawPassCosts ?? {},
      fillItems: (n: number) => {
        if (!stage) return;
        // Deterministic grid fill through the real spawn path (1100 cap
        // applies); types cycle so the draw path sees mixed art.
        const types = ['power', 'point', 'bigPower', 'cherry', 'bigCherry'] as const;
        for (let i = 0; i < n; i++) {
          stage.spawnItem(types[i % types.length], 16 + (i * 7) % 352, 16 + (i * 13) % 400);
        }
      },
      clearInput: () => input.clearInjected(),
      setBombs: (n: number) => { if (stage) stage.playerObj.bombs = n; },
      damageBoss: (n: number) => {
        // Same gate as player damage, so probes can't hit a boss that is
        // invulnerable during phase transitions / the death animation.
        const b = stage?.bossActive;
        if (b && b.ecl.canTakeDamage && b.ecl.interactable) b.hp -= n;
      },
      clearEnemyBullets: () => { if (stage) stage.enemyBullets.length = 0; },
      // Test-only: force the life count so probes can reach and observe
      // late-stage content (boss spells, the Supernatural Border) that a
      // no-dodge headless run would otherwise die before reaching. Same
      // spirit as setPower above.
      setLives: (n: number) => { if (stage) stage.playerObj.lives = n; },
      // Test-only, same spirit as setLives: hold spawn-invulnerability so
      // probes can observe full bullet patterns without death-wipes
      // (player death clears all enemy bullets) resetting the field.
      setInvuln: (frames: number) => {
        if (stage) {
          stage.playerObj.invulnFrames = frames;
          stage.playerObj.invulnFrac = 0;
        }
      },
      bgm: () => ({ active: audio.active, decoded: audio.decodedTracks }),
      canvasContextAttributes: () => renderer.contextAttributes(),
      latencySamples: () => latencyRecorder?.samples() ?? [],
      clearLatencySamples: () => latencyRecorder?.clear(),
      playerShotSerial: () => stage?.playerShotSerial ?? 0,
      resetBombForLatencyProbe: () => stage?.resetBombForLatencyProbe()
    };
  }
  if (!startPaused) loop.start();
}

void boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.color = '#f66';
  el.textContent = String((err as Error)?.stack ?? err);
  document.body.appendChild(el);
});
