import sharp from 'sharp';
import { UnsupportedImageFormatError } from './errors.js';

const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);

export interface ProcessedImage {
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
  bytesIn: number;
  bytesOut: number;
}

export interface ProcessImageOptions {
  maxDimension?: number;
  jpegQuality?: number;
}

export async function processImageForVision(
  input: Buffer,
  opts: ProcessImageOptions = {},
): Promise<ProcessedImage> {
  const maxDimension = opts.maxDimension ?? 1280;
  const jpegQuality = opts.jpegQuality ?? 80;

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

  let out: { data: Buffer; info: sharp.OutputInfo };
  try {
    out = await sharp(input, { animated: false })
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    // metadata() said the format was allowed, but the decode/resize still failed
    // (truncated or corrupt payload). Surface it as a typed, clearly-skippable
    // failure rather than a bare sharp Error.
    throw new UnsupportedImageFormatError(format);
  }

  return {
    base64: out.data.toString('base64'),
    mediaType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    bytesIn: input.length,
    bytesOut: out.data.length,
  };
}
