// TH08 stage-local BGM descriptors. The values come from each stage's STD
// header (Song1/Song2) and musiccmt.txt; Stage 1 is th08_00 ("Ghostly Eyes")
// followed by Wriggle's theme th08_03 ("Mooned Insect"). The title theme is
// th08_01 ("Eastern Night"). Keep this table explicit rather than deriving it
// from contiguous track numbers: th08_02 is absent and th08_13b is a special
// Final Spell insertion rather than a normal stage pair.
export function stageBgmTracks(stageNumber: number): readonly [string, string] {
  const pairs: Record<number, readonly [number, number]> = {
    1: [0, 3],
    2: [4, 5],
    3: [6, 7],
    4: [8, 9],
    5: [11, 12],
    6: [13, 14],
    7: [18, 19]
  };
  const pair = pairs[stageNumber];
  if (!pair) throw new Error(`no TH08 BGM mapping for stage ${stageNumber}`);
  const name = (track: number) => `th08_${String(track).padStart(2, '0')}`;
  return [name(pair[0]), name(pair[1])];
}

export function stageBgmTrack(stageNumber: number, slot: number): string | null {
  if (slot !== 0 && slot !== 1) return null;
  return stageBgmTracks(stageNumber)[slot];
}
