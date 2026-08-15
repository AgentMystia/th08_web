import { TH08_DATA } from '../data/th08-data';
import { Anm } from '../formats/anm';

export type AnmKey = keyof typeof TH08_DATA.anm;

export interface GameAssets {
  anms: Record<AnmKey, Anm>;
  images: Record<string, HTMLImageElement>;
}

const IMAGE_NAMES = [
  'ascii', 'asciis', 'eff01', 'eff01b', 'ename', 'enemy',
  'etama', 'etama2', 'etama3', 'etama4', 'etama5', 'etama6',
  'face_rm00', 'face_rm01an', 'face_rm01dp', 'face_rm01hp', 'face_rm01n2',
  'face_rm01no', 'face_rm01pr', 'face_rm01sp', 'face_rm01sw',
  'face_st01_00', 'face_st01_name', 'face_st01an', 'face_st01n2', 'face_st01no',
  'face_yk00', 'face_yk01an', 'face_yk01dp', 'face_yk01hp', 'face_yk01n2',
  'face_yk01no', 'face_yk01pr', 'face_yk01sp', 'face_yk01sw',
  'front', 'pause', 'player00', 'player00b', 'replay00',
  'select00', 'select01', 'sl_pl00a', 'sl_pl00h', 'sl_pl01a', 'sl_pl01h',
  'sl_pl02a', 'sl_pl02h', 'sl_pl03a', 'sl_pl03h',
  'sl_pltxt0', 'sl_pltxt1', 'sl_pltxt10', 'sl_pltxt11', 'sl_pltxt2',
  'sl_pltxt3', 'sl_pltxt4', 'sl_pltxt5', 'sl_pltxt6', 'sl_pltxt7',
  'sl_pltxt8', 'sl_pltxt9', 'sl_text', 'stg1bg', 'stg1enm', 'stg1txt',
  'times', 'title00', 'title01', 'title02'
] as const;

const IMAGE_FILES: Record<string, string> = Object.fromEntries(
  IMAGE_NAMES.map(name => [name, `assets/th08-img/${name}.png`])
);

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load image ${src}`));
    img.src = src;
  });
}

export async function loadAssets(): Promise<GameAssets> {
  const anms = Object.fromEntries(
    Object.entries(TH08_DATA.anm).map(([key, b64]) => [key, new Anm(b64 as string, key)])
  ) as Record<AnmKey, Anm>;
  const images: Record<string, HTMLImageElement> = {};
  await Promise.all(
    Object.entries(IMAGE_FILES).map(async ([key, src]) => {
      images[key] = await loadImage(src);
    })
  );
  return { anms, images };
}
