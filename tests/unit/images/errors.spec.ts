import { describe, it, expect } from 'vitest';
import {
  AttachmentFetchError,
  UnsupportedImageFormatError,
  ImageTooLargeError,
} from '../../../src/images/errors.js';

describe('image error classes', () => {
  it('AttachmentFetchError preserves status and url', () => {
    const err = new AttachmentFetchError(404, 'https://x.test/img');
    expect(err.name).toBe('AttachmentFetchError');
    expect(err.status).toBe(404);
    expect(err.url).toBe('https://x.test/img');
    expect(err.message).toContain('404');
  });

  it('UnsupportedImageFormatError preserves format', () => {
    const err = new UnsupportedImageFormatError('heif');
    expect(err.name).toBe('UnsupportedImageFormatError');
    expect(err.format).toBe('heif');
  });

  it('ImageTooLargeError preserves bytes', () => {
    const err = new ImageTooLargeError(6_000_000);
    expect(err.name).toBe('ImageTooLargeError');
    expect(err.bytes).toBe(6_000_000);
  });
});
