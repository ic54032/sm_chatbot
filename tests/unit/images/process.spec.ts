import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processImageForVision } from '../../../src/images/process.js';
import { UnsupportedImageFormatError } from '../../../src/images/errors.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): Buffer => readFileSync(join(FIX, name));

describe('processImageForVision', () => {
  it('resizes landscape JPEG when longer side exceeds 1280', async () => {
    const out = await processImageForVision(read('landscape-2000x1500.jpg'));
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.width).toBe(1280);
    expect(out.height).toBe(960);
    expect(out.bytesOut).toBeLessThan(out.bytesIn);
    expect(out.base64.length).toBeGreaterThan(0);
  });

  it('does not enlarge small JPEG below 1280', async () => {
    const out = await processImageForVision(read('small-800x600.jpg'));
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
  });

  it('converts PNG input to JPEG output', async () => {
    const out = await processImageForVision(read('simple.png'));
    expect(out.mediaType).toBe('image/jpeg');
  });

  it('extracts first frame from animated GIF', async () => {
    const out = await processImageForVision(read('animated.gif'));
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.width).toBe(400);
    expect(out.height).toBe(400);
  });

  it('applies EXIF orientation 6 (rotates 90deg CW)', async () => {
    const out = await processImageForVision(read('portrait-with-exif.jpg'));
    // Original 1200x800 landscape with EXIF orientation 6 should rotate to 800x1200 portrait
    expect(out.width).toBe(800);
    expect(out.height).toBe(1200);
  });

  it('throws UnsupportedImageFormatError for SVG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>', 'utf-8');
    await expect(processImageForVision(svg)).rejects.toBeInstanceOf(UnsupportedImageFormatError);
  });

  it('throws UnsupportedImageFormatError for non-image bytes', async () => {
    await expect(processImageForVision(read('not-an-image.bin'))).rejects.toBeInstanceOf(
      UnsupportedImageFormatError,
    );
  });

  it('respects custom maxDimension and jpegQuality', async () => {
    const out = await processImageForVision(read('landscape-2000x1500.jpg'), {
      maxDimension: 640,
      jpegQuality: 50,
    });
    expect(out.width).toBe(640);
    expect(out.height).toBe(480); // aspect preserved
    // q50 should be noticeably smaller than q80 default
    const defaultOut = await processImageForVision(read('landscape-2000x1500.jpg'));
    expect(out.bytesOut).toBeLessThan(defaultOut.bytesOut);
  });
});
