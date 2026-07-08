import { unzipSync } from 'fflate';

export interface CbzPage {
  name: string;
  blobUrl: string;
}

function isImageFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext);
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Loads a CBZ/ZIP archive of images and returns pages sorted in natural order. */
export function loadCbz(bytes: Uint8Array): CbzPage[] {
  const archive = unzipSync(bytes);
  const names = Object.keys(archive)
    .filter((n) => !n.endsWith('/'))
    .filter((n) => !n.startsWith('__MACOSX/'))
    .filter((n) => {
      const base = n.split('/').pop() ?? '';
      return base !== '' && !base.startsWith('.');
    })
    .filter((n) => isImageFile(n));

  names.sort(naturalCompare);

  return names.map((name) => {
    const data = archive[name];
    const blob = new Blob([data], { type: guessMimeType(name) });
    return { name, blobUrl: URL.createObjectURL(blob) };
  });
}

function guessMimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
  };
  return map[ext] ?? 'image/jpeg';
}
