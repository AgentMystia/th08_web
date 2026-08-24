import { AnmRunner, type Anm, type AnmRunnerOptions } from '../formats/anm';
import type { Renderer } from '../gfx/renderer';

// TH08 player spell-card declaration (the bomb cut-in). Th08.exe v1.00d:
// the bomb cast helper FUN_0040be30 calls FUN_00415d60 on the declaration
// manager singleton at 0x4ea670, which spawns four ANM VMs; every animation
// below is authored data, not hand-tuned motion:
//  - portrait: face_rm00/face_yk00 (selector = bomb side, 0x415d69/0x415da4
//    pick this+0x2624/+0x2628), archive script 0 — fade-in 30f at (48,144)
//    top-left anchored, scale to (48,-112) over 180f, alpha-out from t=90,
//    remove at t=150. Fully self-timed.
//  - banners: face_cdbg.anm (loaded as archive id 0xf at 0x4145fa) scripts
//    0 (top strip at (112,16)) and 2 (the -pi/2-rotated band at (224,264)).
//    Both fade in, hold ~100f via their var-10008 loop, fade out 50f,
//    remove. The be30 param_6=1 deathbomb binding (and every enemy
//    declaration, FUN_00415f00's constant 1) selects the second banner
//    sprite — the red variant; normal bombs use sprite 0.
//  - name: text.anm script 4 — drifts (3,3) from (208,344), squashes its
//    scale at t=100, then WAITS at interrupt label 1 until the bomb ends
//    (FUN_00416130 writes the name VM's +0x1fe interrupt on bomb end) and
//    exits with an x-shrink over 30f, removing at t=160. text.anm's '@'
//    texture is generated at runtime by the exe's AsciiManager
//    (FUN_004663b0 typesets the SJIS name into it); this port typesets the
//    name with the canvas font at the script's live position instead.
//  - sound: FUN_0045d550(0xe = sfx id 14, se_cat00 per the 46-channel id
//    table) once at declaration.
// The fourth native VM (the capture.anm flash behind the banner) reads the
// runtime-generated 'capture:@' surface, which is not recoverable from the
// data — flagged in AGENTS.md §7 rather than approximated here.
const BOMB_NAMES: readonly string[] = [
  '霊符「夢想妙珠」', // 0x4b43a0 (unfocused Reimu, selector 0)
  '境符「四重結界」', // 0x4b44f4 (focused Yukari, selector 1)
  '神霊「夢想封印　瞬」', // 0x4b43bc (unfocused deathbomb, selector 0)
  '境界「永夜四重結界」' // 0x4b4508 (focused deathbomb, selector 1)
];

export function th08BombSpellName(type: 0 | 1 | 2 | 3): string {
  return BOMB_NAMES[type];
}

// Th08.exe FUN_004069f0 indexes the ARCHIVE's script table (file order),
// not on-disk script ids — resolve an archive index to its entry and the
// entry-local on-disk id (etama/text keep negative local ids).
export function archiveScript(anm: Anm, index: number): { entryIndex: number; localId: number } {
  let rest = index;
  for (let entryIndex = 0; entryIndex < anm.entries.length; entryIndex++) {
    const ids = anm.entries[entryIndex].scriptIds;
    if (rest < ids.length) return { entryIndex, localId: ids[rest] };
    rest -= ids.length;
  }
  throw new Error(`${anm.name}: archive script index ${index} out of range`);
}

// Construct a runner for an ARCHIVE script index. Multi-entry archives key
// sprites globally as entryBase + embedded id, so the entry's sprite base is
// NOT optional: a runner built without spriteIndexOffset throws on its first
// set-sprite (etama's wave scripts reference sprites that only exist as
// entry2's 389+id). Returns null when the entry lookup misses.
export function archiveScriptRunner(
  anm: Anm,
  index: number,
  options: AnmRunnerOptions = {}
): AnmRunner | null {
  const ref = archiveScript(anm, index);
  if (!anm.hasScriptInEntry(ref.entryIndex, ref.localId)) return null;
  return new AnmRunner(anm, ref.localId, {
    ...options,
    entryIndex: ref.entryIndex,
    spriteIndexOffset: anm.entries[ref.entryIndex].spriteBase
  });
}

export class Th08SpellDeclaration {
  private readonly face: AnmRunner;
  private readonly banner1: AnmRunner;
  private readonly banner2: AnmRunner;
  private readonly name: AnmRunner;
  readonly spellName: string;
  private age = 0;
  private released = false;

  constructor(
    anms: { face: Anm; cdbg: Anm; text: Anm },
    // selector: 0 = human side portrait, 1 = youkai side (be30's EDX arg).
    selector: 0 | 1,
    spellName: string,
    // be30 param_6: 1 for both deathbombs — binds banner sprite variant 1.
    deathbomb: boolean
  ) {
    this.spellName = spellName;
    const face = archiveScript(anms.face, 0);
    this.face = new AnmRunner(anms.face, face.localId, {
      entryIndex: face.entryIndex,
      spriteIndexOffset: anms.face.entries[face.entryIndex].spriteBase
    });
    // face_cdbg's scripts setSprite 0; the deathbomb's +1 sprite index
    // offset rebinds that reference to the red variant (sprite 1).
    const variant = deathbomb ? 1 : 0;
    const b1 = archiveScript(anms.cdbg, 0);
    this.banner1 = new AnmRunner(anms.cdbg, b1.localId, {
      entryIndex: b1.entryIndex,
      spriteIndexOffset: anms.cdbg.entries[b1.entryIndex].spriteBase + variant
    });
    const b2 = archiveScript(anms.cdbg, 2);
    this.banner2 = new AnmRunner(anms.cdbg, b2.localId, {
      entryIndex: b2.entryIndex,
      spriteIndexOffset: anms.cdbg.entries[b2.entryIndex].spriteBase + variant
    });
    const nm = archiveScript(anms.text, 4);
    this.name = new AnmRunner(anms.text, nm.localId, {
      entryIndex: nm.entryIndex,
      spriteIndexOffset: anms.text.entries[nm.entryIndex].spriteBase
    });
  }

  // Bomb end (Th08.exe FUN_00416130): interrupt 1 on the name VM releases
  // its label-1 wait into the 30-frame exit. The portrait and banners are
  // self-timed and take no interrupt.
  end(): void {
    this.name.interrupt(1);
  }

  update(rate = 1): void {
    this.age += rate;
    this.face.update(rate);
    this.banner1.update(rate);
    this.banner2.update(rate);
    this.name.update(rate);
    // The banners' hold loops (op5 JmpDec on var 10008) RESET the counter
    // inside the loop body, so the authored hold never falls through and the
    // native manager force-releases the VMs at bomb end (site not yet
    // recovered). Reproduce the authored exit shape with a bounded release:
    // the 100-frame hold, then the authored 50-frame alpha-out.
    if (!this.released && this.age >= 100) {
      this.released = true;
      for (const banner of [this.banner1, this.banner2]) {
        if (!banner.removed) banner.armFade(50, 0, 255, 0);
      }
    }
  }

  get done(): boolean {
    if (this.age < 160) return false;
    return this.face.removed && this.name.removed;
  }

  // Screen-space draw (the scripts position themselves in 640x480
  // coordinates: banner strips at y=16, the name at (208,344)); the name is
  // typeset at the VM's live position/alpha, riding its drift and squash.
  draw(r: Renderer): void {
    // The native's fourth VM (capture.anm) draws the runtime-captured
    // playfield texture dimmed behind the declaration ('@' surface). That
    // surface is exe-runtime-generated and unrecoverable from data
    // (AGENTS.md §7); approximate its visible effect — the darkened
    // backdrop seen in native captures — with a plain dim quad.
    // (approximation: flat dim, not the transformed capture texture.)
    r.ctx.fillStyle = 'rgba(0,0,16,0.55)';
    r.ctx.fillRect(32, 16, 384, 448);
    for (const runner of [this.face, this.banner1, this.banner2]) {
      if (runner === this.banner1 || runner === this.banner2) {
        if (this.age >= 160) continue;
      }
      const frame = runner.spriteFrame();
      // drawAnmFrame adds the frame's own vmX/vmY to the anchor; the
      // scripts position themselves in screen space, so anchor at (0,0).
      if (frame) r.drawAnmFrame(frame, 0, 0, {});
    }
    // text.anm's '@' surface is runtime-only; the frame carries the VM's
    // authored position/alpha, which drive the typeset name instead.
    const frame = this.name.spriteFrame();
    if (!frame) return;
    const alpha = frame.alpha / 255;
    if (alpha <= 0.02) return;
    r.ctx.globalAlpha = alpha;
    r.text(this.spellName, frame.vmX, frame.vmY - 8, {
      size: 15,
      color: '#f0f0ff',
      align: 'center'
    });
    r.ctx.globalAlpha = 1;
  }
}
