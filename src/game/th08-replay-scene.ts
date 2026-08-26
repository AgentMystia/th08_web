import { SCREEN_W, SCREEN_H, type Renderer } from '../gfx/renderer';
import type { InputFrame } from '../core/input';
import type { GameAssets } from './assets';
import type { AudioBus } from '../audio/audio';
import { Rpy, type RpyStage } from '../formats/rpy';
import { TH08_DIFFICULTY_NAMES, TH08_TEAM_NAMES } from './th08-menu';
import type { Th08TeamId } from './player';

// Browser replay picker: load a T8RP .rpy, show its card, and hand the
// parsed file back for stage-by-stage playback. The original UI here is the
// replay00.anm select screen (a server-side replay directory); a browser
// page has no such directory, so the file choice goes through a hidden
// <input type=file> (runtime DOM — index.html itself stays static) and the
// card is rendered over the shipped replay00 texture with plain-text rows
// (approved menu modernization, same class as the control hints).
//
// Everything downstream of the pick is original-behavior: stage selection
// honors the build's delivered slice, and playback itself (main.ts
// startReplayStage) restores each stage block's T8RP entry snapshot exactly
// like the Node verifier — the browser run and the test run share one
// engine pathway.

// Stages this build implements (delivered scope: Stage 1 + Stage 2).
const IMPLEMENTED_STAGES = new Set([1, 2]);

const SFX_SELECT: [string, number] = ['se_select00', 0.141];
const SFX_OK: [string, number] = ['se_ok00', 0.316];
const SFX_CANCEL: [string, number] = ['se_cancel00', 0.316];

export interface Th08ReplaySelection {
  rpy: Rpy;
  stage: RpyStage;
}

interface ReplayFileInput extends HTMLInputElement {
  __th08PickedOnce?: boolean;
}

export class Th08ReplayScene {
  private frame = 0;
  private phase: 'file' | 'card' = 'file';
  private cursor = 0;
  private denyFlash = 0;
  private error: string | null = null;
  private rpy: Rpy | null = null;
  private fileInput: ReplayFileInput | null = null;
  private previousShoot = false;
  private previousBomb = false;
  private previousUp = false;
  private previousDown = false;
  private dirHeld = 0;

  constructor(
    private assets: GameAssets,
    private audio: AudioBus,
    private onStart: (selection: Th08ReplaySelection) => void,
    private onExit: () => void,
    initialRpy: Rpy | null = null
  ) {
    if (initialRpy) {
      this.rpy = initialRpy;
      this.phase = 'card';
    }
    // Created up front (not on first Z) so headless probes can attach a
    // file via setInputFiles without walking the click path.
    const input = document.createElement('input') as ReplayFileInput;
    input.type = 'file';
    input.accept = '.rpy';
    input.id = 'replay-file-input';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => this.readFile(input));
    this.fileInput = input;
  }

  get currentRpy(): Rpy | null {
    return this.rpy;
  }

  update(input: InputFrame): void {
    this.frame++;
    if (this.denyFlash > 0) this.denyFlash--;
    const shoot = input.held.has('shoot') || input.pressed.has('shoot');
    const bomb = input.held.has('bomb') || input.pressed.has('bomb');
    const upNow = input.held.has('up') || input.pressed.has('up');
    const downNow = input.held.has('down') || input.pressed.has('down');
    const confirmEdge = shoot && !this.previousShoot;
    const backEdge = bomb && !this.previousBomb;
    const upEdge = upNow && !this.previousUp;
    const downEdge = downNow && !this.previousDown;
    // 30f arm / 8f repeat — same cadence as the title model.
    const dirSteady = (upNow || downNow) && upNow === this.previousUp && downNow === this.previousDown;
    this.dirHeld = dirSteady ? this.dirHeld + 1 : 0;
    const repeat = this.dirHeld > 30 && this.dirHeld % 8 === 0;
    this.previousShoot = shoot;
    this.previousBomb = bomb;
    this.previousUp = upNow;
    this.previousDown = downNow;

    const playable = this.playableStages();
    if (this.phase === 'file') {
      if (confirmEdge) this.openFilePicker();
      else if (backEdge) {
        this.audio.sfx(SFX_CANCEL[0], SFX_CANCEL[1], 11);
        this.onExit();
      }
      return;
    }
    // 'card': move among the playable stages, start on Z, re-pick on X.
    if (upEdge || (upNow && repeat)) {
      if (playable.length > 0) {
        this.cursor = (this.cursor + playable.length - 1) % playable.length;
        this.audio.sfx(SFX_SELECT[0], SFX_SELECT[1], 12);
      }
    } else if (downEdge || (downNow && repeat)) {
      if (playable.length > 0) {
        this.cursor = (this.cursor + 1) % playable.length;
        this.audio.sfx(SFX_SELECT[0], SFX_SELECT[1], 12);
      }
    }
    if (confirmEdge) {
      const stage = playable[this.cursor];
      if (stage) {
        this.audio.sfx(SFX_OK[0], SFX_OK[1], 10);
        this.onStart({ rpy: this.rpy!, stage });
      } else {
        this.audio.sfx(SFX_CANCEL[0], SFX_CANCEL[1], 11);
        this.denyFlash = 24;
      }
    } else if (backEdge) {
      this.audio.sfx(SFX_CANCEL[0], SFX_CANCEL[1], 11);
      this.phase = 'file';
      this.error = null;
    }
  }

  draw(r: Renderer): void {
    r.drawImage('replay00', 0, 0);
    const ctx = r.ctx;
    ctx.save();
    ctx.textBaseline = 'top';
    if (this.phase === 'file') {
      this.text(r, 'Replay', 40, 48, 22, '#fff');
      this.text(r, this.error ?? 'Press Z to choose a .rpy replay file', 40, 140, 16, this.error ? '#f88' : '#cde');
      this.hint(r, 'Z Load    X Back');
    } else {
      const rpy = this.rpy!;
      this.text(r, 'Replay', 40, 48, 22, '#fff');
      const meta = [
        `Name  ${rpy.name || '(no name)'}`,
        `Date  ${rpy.date}`,
        `Team  ${TH08_TEAM_NAMES[rpy.shotType] ?? `#${rpy.shotType}`}`,
        `Rank  ${TH08_DIFFICULTY_NAMES[rpy.difficulty] ?? `#${rpy.difficulty}`}`,
        `Score ${(rpy.score * 10).toLocaleString('en-US')}`
      ];
      meta.forEach((line, i) => this.text(r, line, 40, 108 + i * 22, 15, '#cde'));
      let row = 236;
      const playable = this.playableStages();
      for (const stage of rpy.stages) {
        const enabled = IMPLEMENTED_STAGES.has(stage.stage);
        const selected = enabled && playable[this.cursor]?.stage === stage.stage;
        const label = `Stage ${stage.stage}   ${(stage.scoreAtEnd * 10).toLocaleString('en-US')}   ${(stage.inputs.length / 60 | 0)}:${String(stage.inputs.length % 60).padStart(2, '0')}`;
        this.text(r, label, 72, row, 15, selected ? '#fff' : enabled ? '#9ab' : '#567');
        if (selected) this.text(r, '>', 48, row, 15, '#fff');
        row += 24;
      }
      if (playable.length === 0) {
        this.text(r, 'No Stage 1/2 data in this replay — later stages are', 40, row + 12, 13, '#f88');
        this.text(r, 'outside this build\'s delivered scope.', 40, row + 30, 13, '#f88');
      }
      this.hint(r, this.rpy!.shotType === 0
        ? 'Up/Down Stage    Z Play    X Re-pick'
        : 'X Re-pick — this build plays the Border Team only');
    }
    ctx.restore();
  }

  snapshot(): Record<string, unknown> {
    return {
      scene: 'replay',
      phase: this.phase,
      cursor: this.cursor,
      error: this.error,
      loaded: this.rpy != null,
      stages: this.rpy?.stages.map((s) => s.stage) ?? []
    };
  }

  private playableStages(): RpyStage[] {
    // Only the delivered slice plays, and only with the team this build
    // ships (same gate as the character select). shotType is unvalidated
    // file data; the team getter throws out of range, so gate on the raw
    // byte first.
    if (!this.rpy || this.rpy.shotType !== 0) return [];
    return this.rpy.stages.filter((s) => IMPLEMENTED_STAGES.has(s.stage));
  }

  private openFilePicker(): void {
    const input = this.fileInput;
    if (!input) return;
    // One programmatic click per Z press. Re-picking the same file must
    // re-fire change, so clear the value first.
    input.value = '';
    input.click();
  }

  private readFile(input: ReplayFileInput): void {
    const file = input.files?.[0];
    if (!file) return;
    file.arrayBuffer().then((buffer) => {
      try {
        const rpy = new Rpy(new Uint8Array(buffer));
        this.rpy = rpy;
        this.phase = 'card';
        this.cursor = 0;
        this.error = null;
        this.audio.sfx(SFX_OK[0], SFX_OK[1], 10);
      } catch (err) {
        this.error = `Not a TH08 replay: ${(err as Error).message}`;
        this.audio.sfx(SFX_CANCEL[0], SFX_CANCEL[1], 11);
        this.denyFlash = 24;
      }
    });
  }

  private text(r: Renderer, s: string, x: number, y: number, size: number, color: string): void {
    r.text(s, x, y, { size, color });
  }

  private hint(r: Renderer, s: string): void {
    r.text(s, SCREEN_W / 2, SCREEN_H - 22, { size: 12, color: '#cde', align: 'center' });
  }
}
