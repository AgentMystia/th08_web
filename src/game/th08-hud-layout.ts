export interface Th08HudPoint {
  x: number;
  y: number;
}

export interface Th08HudFieldLayout {
  /** Global script id in front.anm entry 0. */
  labelScript: number;
  /** Final label position; front.anm first slides it in from the right. */
  labelPosition: Th08HudPoint;
  /** Number/icon origin used by GuiImpl::DrawGameScene @ 0x43625d. */
  valuePosition: Th08HudPoint;
}

export const TH08_PLAYFIELD = {
  x: 32,
  y: 16,
  width: 384,
  height: 448
} as const;

export const TH08_HUD_FIELDS = {
  // Value-row y coordinates are the exe's DrawGameScene floats (FUN_0043625d;
  // x = 0x4b4cfc = 488 everywhere): HiScore 0x4b432c=40, Score 0x4b42a8=56,
  // lives 0x4b452c=88, bombs 0x4b4cd0=104, power 0x4b4d18=136,
  // graze 0x4b4d14=152, point 0x4b4d10=168, time 0x4b4d0c=184. front.png's
  // baked label column reads HiScore/Score/Player/Spell/Power/Graze/Point/
  // Time top-down (sprites 2-9), so HiScore sits ABOVE Score.
  highScore: {
    labelScript: 2,
    labelPosition: { x: 432, y: 40 },
    valuePosition: { x: 488, y: 40 }
  },
  score: {
    labelScript: 3,
    labelPosition: { x: 432, y: 56 },
    valuePosition: { x: 488, y: 56 }
  },
  lives: {
    labelScript: 4,
    labelPosition: { x: 432, y: 88 },
    valuePosition: { x: 488, y: 88 }
  },
  bombs: {
    labelScript: 5,
    labelPosition: { x: 432, y: 104 },
    valuePosition: { x: 488, y: 104 }
  },
  power: {
    labelScript: 6,
    labelPosition: { x: 432, y: 136 },
    valuePosition: { x: 488, y: 136 }
  },
  graze: {
    labelScript: 7,
    labelPosition: { x: 432, y: 152 },
    valuePosition: { x: 488, y: 152 }
  },
  point: {
    labelScript: 8,
    labelPosition: { x: 432, y: 168 },
    valuePosition: { x: 488, y: 168 }
  },
  time: {
    labelScript: 9,
    labelPosition: { x: 432, y: 184 },
    valuePosition: { x: 488, y: 184 }
  }
} as const satisfies Record<string, Th08HudFieldLayout>;

export const TH08_HUD = {
  digitAdvance: 13,
  resourceIconStep: 16,
  resourceIconScale: Math.fround(0.12 / 0.12),
  gauge: {
    x: 488,
    top: 136,
    bottom: 152,
    fullPowerWidth: 128,
    leftColor: 0xe0e0e0ff,
    rightColor: 0x80e0e0ff
  },
  bossLifebar: {
    x: 32,
    y: 32,
    maxWidth: 384,
    height: 8
  }
} as const;

export function hudValuePosition(field: keyof typeof TH08_HUD_FIELDS): Th08HudPoint {
  return { ...TH08_HUD_FIELDS[field].valuePosition };
}

export function gaugeQuad(power: number): readonly Th08HudPoint[] {
  const width = Math.max(0, Math.min(128, power));
  return [
    { x: TH08_HUD.gauge.x, y: TH08_HUD.gauge.top },
    { x: TH08_HUD.gauge.x + width, y: TH08_HUD.gauge.top },
    { x: TH08_HUD.gauge.x + width, y: TH08_HUD.gauge.bottom },
    { x: TH08_HUD.gauge.x, y: TH08_HUD.gauge.bottom }
  ];
}
