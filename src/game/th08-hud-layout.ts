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
  // Native boss HP strip: a 2px bar at y=19 spanning x=34..414 (the
  // playfield minus a 2px inset), grey-white fill draining right-to-left
  // over a dark-blue remainder. Geometry/colors measured on the native
  // demo captures (n-f5900/n-f6050: fill rgb(149,149,149), empty
  // rgb(0,0,28)); colors packed RGBA like the gauge above.
  bossLifebar: {
    x: TH08_PLAYFIELD.x + 2,
    y: 19,
    width: TH08_PLAYFIELD.width - 4,
    height: 2,
    fillColor: 0x959595ff,
    emptyColor: 0x00001cff
  }
} as const;

// Th08.exe GuiImpl::Initialize (all.c:26916-26923) selects embedded sprite
// 283+difficulty from ascii.anm. Those sprites belong to ascii.anm's THIRD
// entry, whose texture is pause.png; the coordinates happen to look valid in
// ascii.png too, but point at digits/Japanese UI fragments rather than the
// Easy/Normal/Hard/Lunatic tags.
export const TH08_DIFFICULTY_TAG = {
  imageKey: 'pause',
  position: { x: 552, y: 200 },
  rects: [
    [192, 0, 64, 16],
    [192, 16, 64, 16],
    [128, 0, 64, 16],
    [128, 16, 64, 16],
    [192, 192, 64, 16],
    [192, 208, 64, 16]
  ]
} as const;

// ascii.anm entry 0 scripts 5-8 (FUN_00402600 @ 0x402600). Script 5 is
// the authored 128x16 gauge plate at (32,449); scripts 6/7 are the human
// and youkai limit markers. Their x coordinates start at 88 in the ANM and
// are shifted by the configured +/-10000 limits over the 56px half-span,
// producing 32/144. Script 8 is center-anchored and follows the live value.
export const TH08_FORM_GAUGE = {
  imageKey: 'ascii',
  plate: { rect: [0, 224, 128, 16], position: { x: 32, y: 449 } },
  human: { rect: [160, 208, 16, 16], position: { x: 32, y: 449 } },
  youkai: { rect: [176, 208, 16, 16], position: { x: 144, y: 449 } },
  cursor: { rect: [128, 208, 8, 12], centerY: 453 },
  centerX: 88,
  halfSpan: 56,
  percentY: 437,
  pointValueCenterX: 96,
  pointValueY: 453
} as const;

export function formGaugeCursorX(gauge: number): number {
  const clamped = Math.max(-10000, Math.min(10000, gauge));
  return TH08_FORM_GAUGE.centerX + clamped * TH08_FORM_GAUGE.halfSpan / 10000;
}

export function formGaugePercentX(gauge: number, glyphCount: number): number {
  const width = Math.max(0, glyphCount) * 8;
  const wanted = formGaugeCursorX(gauge) - width / 2;
  const left = TH08_FORM_GAUGE.plate.position.x;
  const right = left + TH08_FORM_GAUGE.plate.rect[2];
  return Math.max(left, Math.min(right - width, wanted));
}

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
