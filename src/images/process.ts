import sharp from 'sharp';
import { UnsupportedImageFormatError } from './errors.js';

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 80;
const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);

export interface ProcessedImage {
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
  bytesIn: number;
  bytesOut: number;
}

export async function processImageForVision(input: Buffer): Promise<ProcessedImage> {
  let format: string | undefined;
  try {
    const meta = await sharp(input).metadata();
    format = meta.format;
  } catch {
    throw new UnsupportedImageFormatError('unknown');
  }

  if (!format || !ALLOWED_INPUT_FORMATS.has(format)) {
    throw new UnsupportedImageFormatError(format ?? 'unknown');
  }

  const out = await sharp(input, { animated: false })
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    base64: out.data.toString('base64'),
    mediaType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    bytesIn: input.length,
    bytesOut: out.data.length,
  };
}
