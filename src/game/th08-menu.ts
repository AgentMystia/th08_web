// Deterministic TH08 title-menu state machine. Timing and cursor wrapping
// follow TitleScreen::OnUpdateStartMenu/DifficultySelect/CharacterSelect and
// Supervisor's 30-frame/8-frame scrolling cadence.
export const TH08_INPUT_BITS = {
  shoot: 0x0001,
  bomb: 0x0002,
  focus: 0x0004,
  menu: 0x0008,
  up: 0x0010,
  down: 0x0020,
  left: 0x0040,
  right: 0x0080,
  skip: 0x0100,
  enter: 0x1000
} as const;

export const TH08_TITLE_ITEMS = [
  { name: 'Game Start', enabled: true },
  { name: 'Extra Start', enabled: false },
  { name: 'Spell Practice', enabled: false },
  { name: 'Practice Start', enabled: false },
  { name: 'Replay', enabled: false },
  { name: 'Result', enabled: false },
  { name: 'Music Room', enabled: false },
  { name: 'Option', enabled: false },
  { name: 'Quit', enabled: false }
] as const;

export const TH08_DIFFICULTY_NAMES = ['Easy', 'Normal', 'Hard', 'Lunatic'] as const;
export const TH08_TEAM_NAMES = [
  'Reimu & Yukari',
  'Marisa & Alice',
  'Sakuya & Remilia',
  'Youmu & Yuyuko'
] as const;

export type Th08MenuScreen = 'title' | 'difficulty' | 'character';
export type Th08MenuEvent =
  | { type: 'move'; screen: Th08MenuScreen; cursor: number; direction: -1 | 1 }
  | { type: 'select'; screen: Th08MenuScreen; cursor: number }
  | { type: 'back'; screen: Th08MenuScreen }
  | { type: 'denied'; screen: Th08MenuScreen; cursor: number }
  | { type: 'start'; difficulty: number; shotType: number };

export interface Th08MenuStart {
  difficulty: number;
  shotType: number;
}

export class Th08MenuModel {
  screen: Th08MenuScreen = 'title';
  cursor = 0;
  chosenDifficulty = 1;
  readyFrames = 0;
  transitionFrames = 0;
  result: Th08MenuStart | null = null;
  private previousInput = 0;
  private heldFrames = 0;
  private eighthFrame = false;

  update(input: number): Th08MenuEvent[] {
    const events: Th08MenuEvent[] = [];
    const rising = input & ~this.previousInput;
    this.eighthFrame = false;
    if (input === this.previousInput) {
      if (this.heldFrames >= 30 && this.heldFrames % 8 === 0) {
        this.eighthFrame = true;
      }
      if (this.heldFrames >= 38) this.heldFrames = 30;
      this.heldFrames++;
    } else {
      this.heldFrames = 0;
    }
    this.previousInput = input;

    if (this.transitionFrames > 0) {
      this.transitionFrames--;
      if (this.transitionFrames === 0 && this.screen === 'title') this.readyFrames = 0;
      return events;
    }
    if (this.readyFrames < 8) {
      this.readyFrames++;
      return events;
    }

    const confirm = (rising & (TH08_INPUT_BITS.shoot | TH08_INPUT_BITS.enter)) !== 0;
    const back = (rising & (TH08_INPUT_BITS.bomb | TH08_INPUT_BITS.menu)) !== 0;
    const scroll = (bit: number): boolean =>
      (rising & bit) !== 0 || ((input & bit) !== 0 && this.eighthFrame);

    if (this.screen === 'title') {
      if (scroll(TH08_INPUT_BITS.up)) {
        this.cursor = (this.cursor + 8) % 9;
        events.push({ type: 'move', screen: this.screen, cursor: this.cursor, direction: -1 });
      } else if (scroll(TH08_INPUT_BITS.down)) {
        this.cursor = (this.cursor + 1) % 9;
        events.push({ type: 'move', screen: this.screen, cursor: this.cursor, direction: 1 });
      }
      if (confirm) {
        if (this.cursor === 0) {
          this.chosenDifficulty = 1;
          this.cursor = this.chosenDifficulty;
          this.screen = 'difficulty';
          this.transitionFrames = 0;
          this.readyFrames = 0;
          events.push({ type: 'select', screen: 'title', cursor: 0 });
        } else {
          events.push({ type: 'denied', screen: this.screen, cursor: this.cursor });
        }
      }
      return events;
    }

    if (this.screen === 'difficulty') {
      if (scroll(TH08_INPUT_BITS.up)) {
        this.cursor = (this.cursor + 3) % 4;
        events.push({ type: 'move', screen: this.screen, cursor: this.cursor, direction: -1 });
      } else if (scroll(TH08_INPUT_BITS.down)) {
        this.cursor = (this.cursor + 1) % 4;
        events.push({ type: 'move', screen: this.screen, cursor: this.cursor, direction: 1 });
      }
      if (confirm) {
        this.chosenDifficulty = this.cursor;
        this.cursor = 0;
        this.screen = 'character';
        this.readyFrames = 0;
        events.push({ type: 'select', screen: 'difficulty', cursor: this.chosenDifficulty });
      } else if (back) {
        this.transitionFrames = 20;
        this.screen = 'title';
        this.cursor = 0;
        events.push({ type: 'back', screen: 'difficulty' });
      }
      return events;
    }

    if (scroll(TH08_INPUT_BITS.left)) {
      this.cursor = (this.cursor + 3) % 4;
      events.push({ type: 'move', screen: this.screen, cursor: this.cursor, direction: -1 });
    } else if (scroll(TH08_INPUT_BITS.right)) {
      this.cursor = (this.cursor + 1) % 4;
      events.push({ type: 'move', screen: this.screen, cursor: this.cursor, direction: 1 });
    }
    if (confirm) {
      this.result = { difficulty: this.chosenDifficulty, shotType: this.cursor };
      events.push({ type: 'start', ...this.result });
    } else if (back) {
      this.transitionFrames = 20;
      this.screen = 'difficulty';
      this.cursor = this.chosenDifficulty;
      events.push({ type: 'back', screen: 'character' });
    }
    return events;
  }
}
