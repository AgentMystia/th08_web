import { TH08_TITLE_ITEMS } from './th08-menu';

export interface Th08AnmEntryRange {
  entryIndex: number;
  texture: string;
  firstScript: number;
  lastScript: number;
  purpose: string;
}

// title01.anm stores sequentially numbered global script ids across 25
// entries. Several small entries reuse no ids, but entry-scoped lookup is
// still required because sprite ids are entry-local.
export const TH08_TITLE_ANM_RANGES: readonly Th08AnmEntryRange[] = [
  { entryIndex: 0, texture: 'title02.png', firstScript: 0, lastScript: 0, purpose: 'logo' },
  { entryIndex: 1, texture: 'title01.png', firstScript: 1, lastScript: 76, purpose: 'title menu and decorative glyphs' },
  { entryIndex: 2, texture: 'replay00.png', firstScript: 77, lastScript: 90, purpose: 'replay UI' },
  { entryIndex: 3, texture: 'sl_pl00h.png', firstScript: 111, lastScript: 111, purpose: 'Reimu human select portrait' },
  { entryIndex: 4, texture: 'sl_pl00a.png', firstScript: 112, lastScript: 112, purpose: 'Yukari youkai select portrait' },
  { entryIndex: 5, texture: 'sl_pl01a.png', firstScript: 113, lastScript: 113, purpose: 'Alice youkai select portrait' },
  { entryIndex: 6, texture: 'sl_pl01h.png', firstScript: 114, lastScript: 114, purpose: 'Marisa human select portrait' },
  { entryIndex: 7, texture: 'sl_pl02h.png', firstScript: 115, lastScript: 115, purpose: 'Sakuya human select portrait' },
  { entryIndex: 8, texture: 'sl_pl02a.png', firstScript: 116, lastScript: 116, purpose: 'Remilia youkai select portrait' },
  { entryIndex: 9, texture: 'sl_pl03a.png', firstScript: 117, lastScript: 117, purpose: 'Yuyuko youkai select portrait' },
  { entryIndex: 10, texture: 'sl_pl03h.png', firstScript: 118, lastScript: 118, purpose: 'Youmu human select portrait' },
  { entryIndex: 11, texture: 'sl_pltxt0.png', firstScript: 119, lastScript: 119, purpose: 'Border Team caption' },
  { entryIndex: 12, texture: 'sl_pltxt1.png', firstScript: 120, lastScript: 120, purpose: 'Magic Team caption' },
  { entryIndex: 13, texture: 'sl_pltxt2.png', firstScript: 121, lastScript: 121, purpose: 'Scarlet Team caption' },
  { entryIndex: 14, texture: 'sl_pltxt3.png', firstScript: 122, lastScript: 122, purpose: 'Netherworld Team caption' },
  { entryIndex: 15, texture: 'sl_pltxt4.png', firstScript: 123, lastScript: 123, purpose: 'solo Reimu caption' },
  { entryIndex: 16, texture: 'sl_pltxt5.png', firstScript: 124, lastScript: 124, purpose: 'solo Yukari caption' },
  { entryIndex: 17, texture: 'sl_pltxt6.png', firstScript: 125, lastScript: 125, purpose: 'solo Marisa caption' },
  { entryIndex: 18, texture: 'sl_pltxt7.png', firstScript: 126, lastScript: 126, purpose: 'solo Alice caption' },
  { entryIndex: 19, texture: 'sl_pltxt8.png', firstScript: 127, lastScript: 127, purpose: 'solo Sakuya caption' },
  { entryIndex: 20, texture: 'sl_pltxt9.png', firstScript: 128, lastScript: 128, purpose: 'solo Remilia caption' },
  { entryIndex: 21, texture: 'sl_pltxt10.png', firstScript: 129, lastScript: 129, purpose: 'solo Youmu caption' },
  { entryIndex: 22, texture: 'sl_pltxt11.png', firstScript: 130, lastScript: 130, purpose: 'solo Yuyuko caption' },
  { entryIndex: 23, texture: 'select01.png', firstScript: 131, lastScript: 135, purpose: 'difficulty banners' },
  { entryIndex: 24, texture: 'sl_text.png', firstScript: 136, lastScript: 141, purpose: 'selection headers' }
];

export function titleEntryForScript(scriptId: number): Th08AnmEntryRange {
  const range = TH08_TITLE_ANM_RANGES.find(
    (entry) => scriptId >= entry.firstScript && scriptId <= entry.lastScript
  );
  if (!range) throw new RangeError(`script ${scriptId} is not in title01.anm`);
  return range;
}

export interface Th08MenuScriptLayout {
  scriptId: number;
  entryIndex: number;
  selectedSprite: number;
  unselectedSprite: number;
}

// TitleScreen::OnUpdateStartMenu: selected items restore their base sprite;
// unselected items use base + 1. The first nine entry-1 scripts are the nine
// menu items in native order.
export function titleMenuItemLayout(index: number): Th08MenuScriptLayout {
  if (index < 0 || index >= TH08_TITLE_ITEMS.length) {
    throw new RangeError(`TH08 title item ${index} is out of range`);
  }
  const scriptId = 1 + index;
  const baseSprite = [1, 3, 13, 5, 7, 9, 11, 15, 17][index];
  return {
    scriptId,
    entryIndex: 1,
    selectedSprite: baseSprite,
    unselectedSprite: baseSprite + 1
  };
}

export function difficultyLayout(index: number): Th08MenuScriptLayout {
  if (index < 0 || index > 3) throw new RangeError(`TH08 difficulty ${index} is out of range`);
  const scriptId = 131 + index;
  const baseSprite = 134 + index * 2;
  return {
    scriptId,
    entryIndex: 23,
    selectedSprite: baseSprite,
    unselectedSprite: baseSprite + 1
  };
}

// g_TitleCharacterSpriteIndices in TitleScreen.cpp. A selected team sends
// interrupt 9 to these global script VMs; all character VMs first receive 8.
export const TH08_CHARACTER_HIGHLIGHT_SCRIPTS: readonly (readonly number[])[] = [
  [0x77, 0x6f, 0x70],
  [0x78, 0x72, 0x71],
  [0x79, 0x73, 0x74],
  [0x7a, 0x76, 0x75],
  [0x7b, 0x6f, 0x70],
  [0x7c, 0x70, 0x6f],
  [0x7d, 0x72, 0x71],
  [0x7e, 0x71, 0x72],
  [0x7f, 0x73, 0x74],
  [0x80, 0x74, 0x73],
  [0x81, 0x76, 0x75],
  [0x82, 0x75, 0x76]
];

export const TH08_MENU_HEADER_SCRIPTS = {
  difficulty: 136,
  character: 137,
  practice: 138,
  extra: 139,
  spell: 140
} as const;
