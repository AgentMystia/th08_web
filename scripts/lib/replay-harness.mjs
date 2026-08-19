// Headless TH08 replay harness support.
//
// Drives the real StageScene in plain Node — no browser, no canvas, no
// Playwright. update() is DOM-free by design; only draw() touches images and
// it is never called here. The convergence oracle itself lives in
// scripts/replay-verify-th08.mjs; this module only provides the shared
// engine bundle + TH08 stub assets.
import { cachedEsbuild } from './test-build-cache.mjs';

let modsPromise = null;

// Bundles src/testkit/replay-entry.ts once per process and imports it.
export function loadEngine() {
  modsPromise ??= cachedEsbuild({
    name: 'replay-harness',
    entryPoints: ['src/testkit/replay-entry.ts']
  });
  return modsPromise;
}

export function makeStubAssetsTh08(mod) {
  const anms = Object.fromEntries(
    Object.entries(mod.TH08_DATA.anm).map(([key, b64]) => [key, new mod.Anm(b64, key)])
  );
  // images are only dereferenced inside draw(), which the harness never calls.
  return { anms, images: {} };
}

export function makeStubAudio() {
  return {
    preloadSfx() {},
    preloadBgm() {},
    playBgm() {},
    stopBgm() {},
    fadeOutBgm() {},
    sfx() {}
  };
}
