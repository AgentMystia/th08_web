import { Anm, AnmRunner, type AnmFrame, type AnmSprite } from '../formats/anm';
import { SCREEN_W, SCREEN_H, type Renderer } from '../gfx/renderer';
import type { InputFrame } from '../core/input';
import type { GameAssets } from './assets';
import type { AudioBus } from '../audio/audio';
import type { Th08TeamId } from './player';
import {
  Th08MenuModel, TH08_INPUT_BITS, TH08_TITLE_ITEMS, TH08_DIFFICULTY_NAMES,
  TH08_TEAM_NAMES, type Th08MenuEvent
} from './th08-menu';
import {
  TH08_TITLE_ANM_RANGES, titleEntryForScript, titleMenuItemLayout, difficultyLayout,
  TH08_CHARACTER_HIGHLIGHT_SCRIPTS, TH08_MENU_HEADER_SCRIPTS
} from './th08-menu-layout';

// TH08 title -> difficulty -> team select, built from the original
// title01.anm (Th08.exe v1.00d; layout mapping in th08-menu-layout.ts, unit
// pinned by tests/th08-menu-layout.test.mjs). The state machine is the
// committed Th08MenuModel; this file renders it through entry-scoped
// AnmRunners and adapts it to the MenuFlow-shaped contract main.ts and the
// dev-menu tooling drive.
//
// Entry mapping (verified against the parsed file; scripts are numbered
// globally across the 25 entries): entry 0 title02.png (right-side logo
// strip, script 0), entry 1 title01.png (menu glyphs, scripts 1-76), entries
// 3-10 the eight select portraits sl_plNNh/a (scripts 111-118), entries
// 11-14 the four team captions sl_pltxt0-3 (119-122), entry 23 select01.png
// difficulty banners (131-135), entry 24 sl_text.png headers (136-141).
//
// Presentation notes:
// - Title items (entry 1): each script positions its colored glyph at
//   vm(64, 180 + 28*i); selection swaps to the paired gray glyph one local
//   id later (TitleScreen::OnUpdateStartMenu: selected = base, unselected =
//   base + 1).
// - Difficulty banners enter through interrupt 1 and cascade diagonally:
//   Easy (4,96), Normal (164,184), Hard (220,272), Lunatic (380,360).
// - Character screen: every portrait/caption VM receives interrupt 8 on
//   entry; the selected team's [caption, human, youkai] trio (global script
//   ids in TH08_CHARACTER_HIGHLIGHT_SCRIPTS) additionally receives 9.

const SFX_SELECT: [string, number] = ['se_select00', 0.141];
const SFX_OK: [string, number] = ['se_ok00', 0.316];
const SFX_CANCEL: [string, number] = ['se_cancel00', 0.316];

// The vertical-slice bundle ships only the Border Team's SHT/ANM data;
// confirming any other team plays the cancel buzz instead of starting an
// unrunnable character (original: all four teams playable).
const PLAYABLE_TEAMS = 1;

// Stage-transition fade length; TH07's MenuFlow used 30 frames and TH08's
// model exposes no start-transition constant — flagged approximation.
const STAGE_TRANSITION_FRAMES = 30;

function withRect(frame: AnmFrame, s: AnmSprite): AnmFrame {
  return { ...frame, x: s.x, y: s.y, w: s.w, h: s.h, imageKey: s.imageKey };
}

function hint(r: Renderer, text: string): void {
  // Plain-text control hint (approved menu modernization, same as TH07's).
  r.text(text, SCREEN_W / 2, SCREEN_H - 22, { size: 12, color: '#cde', align: 'center' });
}

interface RunnerBundle {
  runner: AnmRunner;
  entryIndex: number;
}

export interface Th08MenuSnapshot {
  scene: 'title' | 'difficulty' | 'character' | 'stage';
  cursor: number;
  [key: string]: unknown;
}

export class Th08MenuFlow {
  private model = new Th08MenuModel();
  private frame = 0;
  private transitionOut = 0;
  private pendingStart: { difficulty: number; shotType: number } | null = null;
  private denyFlash = 0;

  private logo: AnmRunner;
  private titleItems: RunnerBundle[] = [];
  private difficultyBanners: RunnerBundle[] = [];
  private difficultyHeader: AnmRunner | null = null;
  private characterHeader: AnmRunner | null = null;
  private portraitRunners: RunnerBundle[] = [];
  private captionRunners: RunnerBundle[] = [];
  private characterBuilt = false;

  constructor(
    private assets: GameAssets,
    private audio: AudioBus,
    private onStart: (difficulty: number, team: Th08TeamId) => void,
    initialTitleCursor = 0,
    private onOpenReplay: (() => void) | null = null
  ) {
    const anm = this.anm;
    this.logo = new AnmRunner(anm, 0, { entryIndex: 0, spriteIndexOffset: 0 });
    for (let i = 0; i < TH08_TITLE_ITEMS.length; i++) {
      const layout = titleMenuItemLayout(i);
      this.titleItems.push({
        runner: new AnmRunner(anm, layout.scriptId, {
          entryIndex: layout.entryIndex,
          spriteIndexOffset: anm.entries[layout.entryIndex].spriteBase
        }),
        entryIndex: layout.entryIndex
      });
    }
    this.model.cursor = initialTitleCursor;
  }

  private get anm(): Anm {
    return this.assets.anms.title01;
  }

  private buildDifficulty(): void {
    const anm = this.anm;
    this.difficultyBanners = [];
    for (let i = 0; i < TH08_DIFFICULTY_NAMES.length; i++) {
      const layout = difficultyLayout(i);
      const runner = new AnmRunner(anm, layout.scriptId, {
        entryIndex: layout.entryIndex,
        spriteIndexOffset: anm.entries[layout.entryIndex].spriteBase
      });
      // The banner scripts park on ins_23 (hide+wait) between ins_21(-1) and
      // ins_21(7). interrupt(1) matched no label and fell back to -1 (still
      // parked); the entry cascade (fade+slide-in) lives at label 7.
      runner.interrupt(7);
      this.difficultyBanners.push({ runner, entryIndex: layout.entryIndex });
    }
    const headerEntry = titleEntryForScript(TH08_MENU_HEADER_SCRIPTS.difficulty);
    this.difficultyHeader = new AnmRunner(anm, TH08_MENU_HEADER_SCRIPTS.difficulty, {
      entryIndex: headerEntry.entryIndex,
      spriteIndexOffset: anm.entries[headerEntry.entryIndex].spriteBase
    });
    this.difficultyHeader.interrupt(1);
  }

  private buildCharacter(): void {
    const anm = this.anm;
    this.portraitRunners = [];
    this.captionRunners = [];
    // Portraits: global scripts 111-118 = entries 3-10.
    for (let i = 0; i < 8; i++) {
      const entryIndex = 3 + i;
      const runner = new AnmRunner(anm, 111 + i, {
        entryIndex,
        spriteIndexOffset: anm.entries[entryIndex].spriteBase
      });
      runner.interrupt(8);
      this.portraitRunners.push({ runner, entryIndex });
    }
    // Team captions: global scripts 119-122 = entries 11-14.
    for (let i = 0; i < TH08_TEAM_NAMES.length; i++) {
      const entryIndex = 11 + i;
      const runner = new AnmRunner(anm, 119 + i, {
        entryIndex,
        spriteIndexOffset: anm.entries[entryIndex].spriteBase
      });
      runner.interrupt(8);
      this.captionRunners.push({ runner, entryIndex });
    }
    const headerEntry = titleEntryForScript(TH08_MENU_HEADER_SCRIPTS.character);
    this.characterHeader = new AnmRunner(anm, TH08_MENU_HEADER_SCRIPTS.character, {
      entryIndex: headerEntry.entryIndex,
      spriteIndexOffset: anm.entries[headerEntry.entryIndex].spriteBase
    });
    this.characterHeader.interrupt(1);
    this.characterBuilt = true;
    this.applyTeamHighlight();
  }

  private applyTeamHighlight(): void {
    const trio = TH08_CHARACTER_HIGHLIGHT_SCRIPTS[this.model.cursor];
    if (!trio) return;
    for (const scriptId of trio) {
      const found = [...this.portraitRunners, ...this.captionRunners].find(
        (b) => b.runner.scriptId === scriptId
      );
      found?.runner.interrupt(9);
    }
  }

  replayFileHotkeyActive(): boolean {
    // The Replay entry is live: the host swaps in the browser replay picker.
    return true;
  }

  private inputBits(input: InputFrame): number {
    // The model derives its own rising edges from the per-frame word, so a
    // button counts on any frame it is held OR edge-pressed (dev-menu
    // injects single-frame presses that never appear in `held`).
    let bits = 0;
    const on = (b: 'up' | 'down' | 'left' | 'right' | 'shoot' | 'confirm' | 'bomb' | 'back') =>
      input.held.has(b) || input.pressed.has(b);
    if (on('up')) bits |= TH08_INPUT_BITS.up;
    if (on('down')) bits |= TH08_INPUT_BITS.down;
    if (on('left')) bits |= TH08_INPUT_BITS.left;
    if (on('right')) bits |= TH08_INPUT_BITS.right;
    if (on('shoot') || on('confirm')) bits |= TH08_INPUT_BITS.shoot | TH08_INPUT_BITS.enter;
    if (on('bomb') || on('back')) bits |= TH08_INPUT_BITS.bomb | TH08_INPUT_BITS.menu;
    return bits;
  }

  private handleEvents(events: Th08MenuEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'move':
          this.audio.sfx(SFX_SELECT[0], SFX_SELECT[1], 12);
          if (this.model.screen === 'character') this.applyTeamHighlight();
          break;
        case 'denied':
          this.audio.sfx(SFX_CANCEL[0], SFX_CANCEL[1], 11);
          this.denyFlash = 20;
          break;
        case 'back':
          this.audio.sfx(SFX_CANCEL[0], SFX_CANCEL[1], 11);
          break;
        case 'select':
          this.audio.sfx(SFX_OK[0], SFX_OK[1], 10);
          if (this.model.screen === 'difficulty' && !this.difficultyBanners.length) this.buildDifficulty();
          if (this.model.screen === 'character' && !this.characterBuilt) this.buildCharacter();
          break;
        case 'replay':
          this.audio.sfx(SFX_OK[0], SFX_OK[1], 10);
          this.onOpenReplay?.();
          break;
        case 'start': {
          // Only the Border Team is playable in the vertical slice; the
          // model emits start for any confirmed team, so re-check here.
          if (event.shotType >= PLAYABLE_TEAMS) {
            this.audio.sfx(SFX_CANCEL[0], SFX_CANCEL[1], 11);
            this.denyFlash = 20;
            break;
          }
          this.pendingStart = { difficulty: event.difficulty, shotType: event.shotType };
          this.transitionOut = STAGE_TRANSITION_FRAMES;
          break;
        }
      }
    }
  }

  update(input: InputFrame): void {
    this.frame++;
    if (this.transitionOut > 0) {
      this.transitionOut--;
      if (this.transitionOut === 0 && this.pendingStart) {
        const { difficulty, shotType } = this.pendingStart;
        this.pendingStart = null;
        this.onStart(difficulty, shotType === 0 ? 'reimuYukari' : 'reimuYukari');
      }
      return;
    }
    if (this.denyFlash > 0) this.denyFlash--;
    this.logo.update();
    for (const item of this.titleItems) item.runner.update();
    for (const banner of this.difficultyBanners) banner.runner.update();
    this.difficultyHeader?.update();
    for (const portrait of this.portraitRunners) portrait.runner.update();
    for (const caption of this.captionRunners) caption.runner.update();
    this.characterHeader?.update();
    const events = this.model.update(this.inputBits(input));
    this.handleEvents(events);
  }

  draw(r: Renderer): void {
    switch (this.model.screen) {
      case 'title':
        this.drawTitle(r);
        break;
      case 'difficulty':
        this.drawDifficulty(r);
        break;
      case 'character':
        this.drawCharacter(r);
        break;
    }
    if (this.transitionOut > 0) {
      const alpha = 1 - this.transitionOut / STAGE_TRANSITION_FRAMES;
      const ctx = r.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
      ctx.restore();
    }
  }

  private drawTitle(r: Renderer): void {
    r.drawImage('title00', 0, 0);
    r.drawAnmFrame(this.logo.spriteFrame(), 0, 0);
    const entry = this.anm.entries[1];
    const selected = this.model.screen === 'title' && this.transitionOut === 0
      ? this.model.cursor
      : -1;
    this.titleItems.forEach((item, i) => {
      const frame = item.runner.spriteFrame();
      if (!frame) return;
      const layout = titleMenuItemLayout(i);
      if (i === selected) {
        r.drawAnmFrame(frame, 0, 0);
      } else {
        const gray = this.anm.sprites.get(entry.spriteBase + layout.unselectedSprite);
        r.drawAnmFrame(gray ? withRect(frame, gray) : frame, 0, 0, gray ? {} : { alpha: 0.5 });
      }
    });
    if (this.denyFlash > 0 && this.denyFlash % 8 < 4) {
      hint(r, 'Game Start and Replay are available in this build');
    } else {
      hint(r, 'Up/Down Move    Z Decide');
    }
  }

  private drawDifficulty(r: Renderer): void {
    r.drawImage('select00', 0, 0);
    if (this.difficultyHeader) r.drawAnmFrame(this.difficultyHeader.spriteFrame(), 0, 0);
    const entry = this.anm.entries[23];
    this.difficultyBanners.forEach((banner, i) => {
      const frame = banner.runner.spriteFrame();
      if (!frame) return;
      const layout = difficultyLayout(i);
      if (i === this.model.cursor) {
        r.drawAnmFrame(frame, 0, 0);
      } else {
        const dim = this.anm.sprites.get(entry.spriteBase + layout.unselectedSprite);
        r.drawAnmFrame(dim ? withRect(frame, dim) : frame, 0, 0, dim ? { alpha: 0.6 } : { alpha: 0.5 });
      }
    });
    hint(r, 'Up/Down Move    Z Decide    X Back');
  }

  private drawCharacter(r: Renderer): void {
    r.drawImage('select00', 0, 0);
    if (this.characterHeader) r.drawAnmFrame(this.characterHeader.spriteFrame(), 0, 0);
    for (const caption of this.captionRunners) {
      r.drawAnmFrame(caption.runner.spriteFrame(), 0, 0);
    }
    for (const portrait of this.portraitRunners) {
      r.drawAnmFrame(portrait.runner.spriteFrame(), 0, 0);
    }
    if (this.denyFlash > 0) {
      hint(r, 'This build ships the Border Team only');
    } else {
      hint(r, 'Left/Right Team    Z Decide    X Back');
    }
  }

  snapshot(): Th08MenuSnapshot {
    const transitioning = this.transitionOut > 0;
    switch (this.model.screen) {
      case 'title':
        return {
          scene: 'title',
          cursor: this.model.cursor,
          item: TH08_TITLE_ITEMS[this.model.cursor]?.name ?? null,
          transitioning
        };
      case 'difficulty':
        return {
          scene: 'difficulty',
          cursor: this.model.cursor,
          difficultyName: TH08_DIFFICULTY_NAMES[this.model.cursor],
          transitioning
        };
      case 'character':
        return {
          scene: 'character',
          cursor: this.model.cursor,
          team: TH08_TEAM_NAMES[this.model.cursor],
          transitioning
        };
    }
  }
}
