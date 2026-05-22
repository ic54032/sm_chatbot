// One-off script: run with `npx tsx tests/unit/images/fixtures/generate-fixtures.ts`
// Produces deterministic binary fixtures used by process.spec.ts.
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Build a minimal GIF89a animated image with two solid-color frames (red, green).
 * Uses a 2-color global palette. LZW-encoded image data is produced by `encodeLzw`.
 *
 * Layout:
 *   "GIF89a" header
 *   Logical Screen Descriptor
 *   Global Color Table (2 entries -> table size flag 0, total 6 bytes)
 *   NETSCAPE2.0 Application Extension (loop = infinite)
 *   For each frame:
 *     Graphic Control Extension (delay 10 = 100ms)
 *     Image Descriptor
 *     LZW-encoded image data (pixels are constant => one palette index per pixel)
 *   Trailer
 */
function buildAnimatedGif(width: number, height: number): Buffer {
  const parts: Buffer[] = [];

  // Header
  parts.push(Buffer.from('GIF89a', 'ascii'));

  // Logical Screen Descriptor
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  // Packed: global color table flag (1) + color resolution (2 << 4 == 0x20)
  // + sort flag (0) + size of global color table (0 -> 2 entries).
  lsd.writeUInt8(0b10000000 | 0b00100000 | 0b00000000, 4);
  lsd.writeUInt8(0, 5); // background color index
  lsd.writeUInt8(0, 6); // pixel aspect ratio
  parts.push(lsd);

  // Global Color Table: index 0 = red (255,0,0), index 1 = green (0,255,0)
  parts.push(Buffer.from([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]));

  // NETSCAPE2.0 Application Extension (infinite loop)
  parts.push(
    Buffer.from([
      0x21, 0xff, 0x0b, // extension introducer, application label, block size 11
      ...Buffer.from('NETSCAPE2.0', 'ascii'),
      0x03, 0x01, 0x00, 0x00, // sub-block: size 3, sub-id 1, loop count 0 (infinite)
      0x00, // block terminator
    ]),
  );

  // Two frames; frame 0 uses palette index 0 (red), frame 1 uses index 1 (green)
  for (const colorIndex of [0, 1]) {
    // Graphic Control Extension
    parts.push(
      Buffer.from([
        0x21, 0xf9, 0x04, // extension introducer, graphic control label, block size 4
        0x00, // packed: no transparency, no user input, disposal 0
        0x0a, 0x00, // delay time = 10 (=100ms)
        0x00, // transparent color index (unused)
        0x00, // block terminator
      ]),
    );

    // Image Descriptor
    const imageDescriptor = Buffer.alloc(10);
    imageDescriptor.writeUInt8(0x2c, 0); // image separator
    imageDescriptor.writeUInt16LE(0, 1); // left
    imageDescriptor.writeUInt16LE(0, 3); // top
    imageDescriptor.writeUInt16LE(width, 5); // width
    imageDescriptor.writeUInt16LE(height, 7); // height
    imageDescriptor.writeUInt8(0, 9); // packed: no local color table
    parts.push(imageDescriptor);

    // LZW-encoded image data: each frame is a flat array of width*height entries
    // all set to `colorIndex`. The minimum LZW code size for a 2-color palette is 2
    // (GIF spec requires min 2). Total pixels = width*height.
    const pixels = Buffer.alloc(width * height, colorIndex);
    const lzwMinCodeSize = 2;
    const lzwData = encodeLzw(pixels, lzwMinCodeSize);

    parts.push(Buffer.from([lzwMinCodeSize]));
    // Split lzwData into sub-blocks of max 255 bytes each
    let offset = 0;
    while (offset < lzwData.length) {
      const chunkLen = Math.min(255, lzwData.length - offset);
      parts.push(Buffer.from([chunkLen]));
      parts.push(lzwData.subarray(offset, offset + chunkLen));
      offset += chunkLen;
    }
    parts.push(Buffer.from([0x00])); // block terminator
  }

  // Trailer
  parts.push(Buffer.from([0x3b]));

  return Buffer.concat(parts);
}

/**
 * Minimal LZW encoder for GIF image data, following the GIF89a spec.
 *
 * @param pixels - Flat array of palette indices.
 * @param minCodeSize - Initial code size in bits (>= 2 per GIF spec).
 * @returns LZW-compressed bytes (without sub-block framing or the leading code size byte).
 */
function encodeLzw(pixels: Buffer, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const maxCodeSize = 12;
  const maxTableSize = 1 << maxCodeSize;

  const out: number[] = [];
  let bitBuffer = 0;
  let bitsInBuffer = 0;

  // Emit `code` of `codeSize` bits, LSB first
  const emit = (code: number, codeSize: number): void => {
    bitBuffer |= code << bitsInBuffer;
    bitsInBuffer += codeSize;
    while (bitsInBuffer >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitsInBuffer -= 8;
    }
  };

  // Dictionary: maps string-key (sequence of palette indices joined by ',') -> code
  let dict = new Map<string, number>();
  const resetDict = (): void => {
    dict = new Map<string, number>();
    for (let i = 0; i < clearCode; i++) {
      dict.set(String(i), i);
    }
  };

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  resetDict();
  emit(clearCode, codeSize);

  let buffer = String(pixels[0]);
  for (let i = 1; i < pixels.length; i++) {
    const next = String(pixels[i]);
    const combined = `${buffer},${next}`;
    if (dict.has(combined)) {
      buffer = combined;
    } else {
      emit(dict.get(buffer)!, codeSize);
      if (nextCode < maxTableSize) {
        dict.set(combined, nextCode);
        nextCode++;
        // After assigning a code that fills the current bit-width range, grow code size
        if (nextCode > 1 << codeSize && codeSize < maxCodeSize) {
          codeSize++;
        }
      } else {
        // Table full: emit clear and reset
        emit(clearCode, codeSize);
        resetDict();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      buffer = next;
    }
  }
  // Flush final buffer
  emit(dict.get(buffer)!, codeSize);
  emit(eoiCode, codeSize);
  if (bitsInBuffer > 0) {
    out.push(bitBuffer & 0xff);
  }
  return Buffer.from(out);
}

async function main(): Promise<void> {
  // Landscape JPEG that exceeds MAX_DIMENSION
  await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg({ quality: 90 })
    .toFile(join(HERE, 'landscape-2000x1500.jpg'));

  // Small JPEG that should not be enlarged
  await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 50, g: 150, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toFile(join(HERE, 'small-800x600.jpg'));

  // Portrait with EXIF orientation 6 (rotate 90deg CW = swap dims after .rotate()).
  // Create as landscape, then embed EXIF Orientation=6 so sharp's .rotate() flips it.
  // Sharp's `withMetadata({ orientation })` is the dedicated API for this.
  await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 100, g: 200, b: 100 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(join(HERE, 'portrait-with-exif.jpg'));

  // Simple PNG with alpha
  await sharp({
    create: { width: 600, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toFile(join(HERE, 'simple.png'));

  // Animated GIF with two solid-color frames (400x400 each).
  // Sharp 0.33 does not expose libvips' `page-height` for raw input, so we cannot
  // ask sharp to encode an animated GIF from a vertically-stacked raw buffer.
  // Instead, hand-craft a minimal GIF89a binary with LZW-encoded image data.
  writeFileSync(join(HERE, 'animated.gif'), buildAnimatedGif(400, 400));

  // Random bytes that are not any image format
  writeFileSync(join(HERE, 'not-an-image.bin'), Buffer.from('this is just text, not an image'));

  console.log('Fixtures generated in', HERE);
}

void main();
