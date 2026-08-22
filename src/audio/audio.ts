import { TH08_DATA } from '../data/th08-data';

// Web Audio bus. BGM tracks loop gaplessly using loopStart/loopEnd sample
// positions taken from the original thbgm.fmt (embedded in TH08_DATA.bgm) —
// an intentional improvement over TH06 Web's whole-file HTMLAudio looping.

interface BgmTrackInfo {
  name: string;
  sampleRate: number;
  loopStartSample: number;
  totalSamples: number;
}

const BGM_VOLUME = 0.65;

// The shipped audio bundle carries exactly these .ogg files (see
// scripts/split-th08-bgm.mjs): the title theme plus the full stage/boss pairs
// for the Stage 1+2 slice. Every other table track resolves to the stage-1
// pair by parity (even = stage theme, odd = boss theme) so neither preload
// nor play issues a doomed fetch for the unshipped files.
const SHIPPED_BGM_TRACKS = new Set(['th08_01', 'th08_00', 'th08_03', 'th08_04', 'th08_05']);

function resolveBgmTrackName(name: string): string {
  if (SHIPPED_BGM_TRACKS.has(name)) return name;
  const m = /^th08_(\d+)$/.exec(name);
  return m ? (Number(m[1]) % 2 === 0 ? 'th08_00' : 'th08_03') : name;
}

export class AudioBus {
  private ctx: AudioContext | null = null;
  private bgmBuffers = new Map<string, AudioBuffer>();
  private bgmLoading = new Map<string, Promise<AudioBuffer | null>>();
  private sfxBuffers = new Map<string, AudioBuffer>();
  private sfxLoading = new Map<string, Promise<AudioBuffer | null>>();
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  active: string | null = null;
  private pendingBgm: { name: string; fadeMs: number } | null = null;
  private unlockListenersAttached = false;
  private readonly unlockHandler = (): void => this.unlock();
  unlocked = false;
  muted = false;

  // Test-only observability: which track names are currently resolved in
  // the decoded BGM cache, so a headless check can assert preload state
  // (see window.__TH08_TEST__.bgm() in main.ts).
  get decodedTracks(): string[] {
    return Array.from(this.bgmBuffers.keys());
  }

  constructor() {
    this.attachUnlockListeners();
  }

  private attachUnlockListeners(): void {
    if (this.unlockListenersAttached) return;
    this.unlockListenersAttached = true;
    addEventListener('keydown', this.unlockHandler);
    addEventListener('pointerdown', this.unlockHandler);
  }

  private detachUnlockListeners(): void {
    if (!this.unlockListenersAttached) return;
    this.unlockListenersAttached = false;
    removeEventListener('keydown', this.unlockHandler);
    removeEventListener('pointerdown', this.unlockHandler);
  }

  private completeUnlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.detachUnlockListeners();
    if (this.pendingBgm) {
      const { name, fadeMs } = this.pendingBgm;
      this.pendingBgm = null;
      this.playBgm(name, { fadeMs });
    }
  }

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = 0;
    this.bgmGain.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 1;
    this.sfxGain.connect(this.ctx.destination);
    return this.ctx;
  }

  unlock(): void {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'running') {
      this.completeUnlock();
      return;
    }
    void ctx.resume()
      .then(() => {
        if (ctx.state === 'running') this.completeUnlock();
      })
      .catch(() => {
        // A rejected resume keeps the gesture listeners attached so a later
        // trusted input can retry.
      });
  }

  private trackInfo(name: string): BgmTrackInfo | null {
    return (TH08_DATA.bgm as readonly BgmTrackInfo[]).find((t) => t.name === name) ?? null;
  }

  private loadBgm(name: string): Promise<AudioBuffer | null> {
    const cached = this.bgmBuffers.get(name);
    if (cached) return Promise.resolve(cached);
    let loading = this.bgmLoading.get(name);
    if (!loading) {
      loading = fetch(`assets/audio/th08/${name}.ogg`)
        .then((r) => r.arrayBuffer())
        .then((buf) => this.ensureCtx()?.decodeAudioData(buf) ?? null)
        .then((decoded) => {
          if (decoded) this.bgmBuffers.set(name, decoded);
          return decoded;
        })
        .catch(() => null);
      this.bgmLoading.set(name, loading);
    }
    return loading;
  }

  preloadBgm(names: string[]): void {
    for (const name of names) void this.loadBgm(resolveBgmTrackName(name));
  }

  playBgm(name: string | null, options: { fadeMs?: number; restart?: boolean } = {}): void {
    if (name === this.active && this.bgmSource) return;
    if (!name) {
      this.stopBgm();
      return;
    }
    if (!this.unlocked) {
      this.pendingBgm = { name, fadeMs: options.fadeMs ?? 700 };
      this.active = name;
      void this.loadBgm(name);
      return;
    }
    this.active = name;
    // Stop the previous track immediately rather than waiting for the new
    // one's decode to resolve: any residual load gap then plays silence
    // instead of the old track hard-cutting away later, off by however long
    // the new track's fetch+decode took (bug 5).
    this.stopSourceOnly();
    void this.loadBgm(name).then((buffer) => {
      if (!buffer && this.active === name) {
        // Track file missing at runtime despite the shipped-set resolution
        // above (e.g. a partial manual asset copy): fall back to the stage-1
        // pair by parity (even = stage theme, odd = boss theme) instead of
        // going silent.
        const fallback = resolveBgmTrackName(name);
        if (fallback !== name) {
          this.active = null;
          this.playBgm(fallback, options);
        }
        return;
      }
      if (!buffer || this.active !== name) return;
      const ctx = this.ensureCtx();
      if (!ctx || !this.bgmGain) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const info = this.trackInfo(name);
      if (info && info.totalSamples > 0) {
        src.loop = true;
        src.loopStart = info.loopStartSample / info.sampleRate;
        // The decoded buffer length may differ from the PCM table by a few
        // frames of codec padding; clamp to the actual buffer duration.
        src.loopEnd = Math.min(buffer.duration, info.totalSamples / info.sampleRate);
      } else {
        src.loop = true;
      }
      src.connect(this.bgmGain);
      src.start();
      this.bgmSource = src;
      const fadeS = Math.max(0.001, (options.fadeMs ?? 700) / 1000);
      const now = ctx.currentTime;
      this.bgmGain.gain.cancelScheduledValues(now);
      this.bgmGain.gain.setValueAtTime(0, now);
      this.bgmGain.gain.linearRampToValueAtTime(this.muted ? 0 : BGM_VOLUME, now + fadeS);
    });
  }

  private stopSourceOnly(): void {
    if (this.bgmSource) {
      try {
        this.bgmSource.stop();
      } catch {
        // already stopped
      }
      this.bgmSource.disconnect();
      this.bgmSource = null;
    }
  }

  stopBgm(): void {
    this.active = null;
    this.pendingBgm = null;
    this.stopSourceOnly();
  }

  fadeOutBgm(seconds = 4): void {
    const ctx = this.ctx;
    if (!ctx || !this.bgmGain) {
      this.stopBgm();
      return;
    }
    const now = ctx.currentTime;
    this.bgmGain.gain.cancelScheduledValues(now);
    this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, now);
    this.bgmGain.gain.linearRampToValueAtTime(0, now + Math.max(0.001, seconds));
    const name = this.active;
    this.active = null;
    setTimeout(() => {
      if (this.active === null || this.active === name) this.stopSourceOnly();
    }, seconds * 1000 + 50);
  }

  private loadSfx(file: string): Promise<AudioBuffer | null> {
    const cached = this.sfxBuffers.get(file);
    if (cached) return Promise.resolve(cached);
    let loading = this.sfxLoading.get(file);
    if (!loading) {
      loading = fetch(`assets/sfx/th08/${file}.wav`)
        .then((r) => r.arrayBuffer())
        .then((buf) => this.ensureCtx()?.decodeAudioData(buf) ?? null)
        .then((decoded) => {
          if (decoded) this.sfxBuffers.set(file, decoded);
          return decoded;
        })
        .catch(() => null);
      this.sfxLoading.set(file, loading);
    }
    return loading;
  }

  preloadSfx(files: string[]): void {
    for (const file of files) void this.loadSfx(file);
  }

  // One active voice per SE slot: Th07.exe duplicates one DirectSound
  // buffer per slot at init (@ 0x4468xx, IDirectSound::DuplicateSoundBuffer)
  // and re-Plays it, which RESTARTS the sound — a slot never stacks with
  // itself. Keyed by the caller's slot id (falls back to the file stem).
  private slotVoices = new Map<number | string, AudioBufferSourceNode>();

  // Plays an original SFX by file stem (e.g. "se_tan00" → assets/sfx/th08/se_tan00.wav).
  sfx(file: string, volume = 1, slot?: number | string): void {
    if (!this.unlocked || this.muted) {
      void this.loadSfx(file);
      return;
    }
    const buffer = this.sfxBuffers.get(file);
    if (!buffer) {
      void this.loadSfx(file);
      return;
    }
    const ctx = this.ensureCtx();
    if (!ctx || !this.sfxGain) return;
    const key = slot ?? file;
    const prev = this.slotVoices.get(key);
    if (prev) {
      try { prev.stop(); } catch { /* already ended */ }
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (volume >= 1) {
      src.connect(this.sfxGain);
    } else {
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, volume);
      src.connect(gain);
      gain.connect(this.sfxGain);
    }
    this.slotVoices.set(key, src);
    src.onended = () => {
      if (this.slotVoices.get(key) === src) this.slotVoices.delete(key);
    };
    src.start();
  }
}
