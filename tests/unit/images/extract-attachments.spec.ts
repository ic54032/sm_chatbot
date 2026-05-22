import { describe, it, expect } from 'vitest';
import { extractImageAttachments } from '../../../src/images/extract-attachments.js';

describe('extractImageAttachments', () => {
  it('extracts image attachments with URLs from raw_content', () => {
    const raw = {
      location_id: 'loc',
      contact_id: 'c',
      attachments: [
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
      ],
    };
    expect(extractImageAttachments(raw)).toEqual([
      { url: 'https://x.test/a.jpg' },
      { url: 'https://x.test/b.png' },
    ]);
  });

  it('skips non-image types', () => {
    const raw = {
      attachments: [
        { url: 'https://x.test/v.mp4', type: 'video' },
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/x.mp3', type: 'audio' },
      ],
    };
    expect(extractImageAttachments(raw)).toEqual([{ url: 'https://x.test/a.jpg' }]);
  });

  it('skips images without URL', () => {
    const raw = {
      attachments: [
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: null, type: 'image' },
        { type: 'image' },
      ],
    };
    expect(extractImageAttachments(raw)).toEqual([{ url: 'https://x.test/a.jpg' }]);
  });

  it('returns empty array when no attachments field', () => {
    expect(extractImageAttachments({ location_id: 'loc' })).toEqual([]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(extractImageAttachments(null)).toEqual([]);
    expect(extractImageAttachments(undefined)).toEqual([]);
  });

  it('returns empty array when input is not an object', () => {
    expect(extractImageAttachments('not an object')).toEqual([]);
    expect(extractImageAttachments(42)).toEqual([]);
  });
});
