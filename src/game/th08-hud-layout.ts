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
  score: {
    labelScript: 2,
    labelPosition: { x: 432, y: 40 },
    valuePosition: { x: 488, y: 40 }
  },
  highScore: {
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
  gauge: {
    labelScript: 6,
    labelPosition: { x: 432, y: 136 },
    valuePosition: { x: 488, y: 136 }
  },
  power: {
    labelScript: 7,
    labelPosition: { x: 432, y: 152 },
    valuePosition: { x: 488, y: 152 }
  },
  graze: {
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
