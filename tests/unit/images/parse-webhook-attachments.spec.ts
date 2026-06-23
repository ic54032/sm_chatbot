import { describe, it, expect } from 'vitest';
import { parseWebhookAttachments } from '../../../src/images/parse-webhook-attachments.js';

describe('parseWebhookAttachments', () => {
  describe('empty/null inputs', () => {
    it('returns [] for null', () => {
      expect(parseWebhookAttachments(null)).toEqual([]);
    });
    it('returns [] for undefined', () => {
      expect(parseWebhookAttachments(undefined)).toEqual([]);
    });
    it('returns [] for empty string', () => {
      expect(parseWebhookAttachments('')).toEqual([]);
    });
    it('returns [] for "null" string', () => {
      expect(parseWebhookAttachments('null')).toEqual([]);
    });
    it('returns [] for "undefined" string', () => {
      expect(parseWebhookAttachments('undefined')).toEqual([]);
    });
    it('returns [] for whitespace-only string', () => {
      expect(parseWebhookAttachments('   ')).toEqual([]);
    });
  });

  describe('JSON array string formats', () => {
    it('parses JSON array of objects with url+type', () => {
      const input = '[{"url":"https://x.test/a.jpg","type":"image"}]';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
      ]);
    });
    it('parses JSON array of URL strings (defaults type to image)', () => {
      const input = '["https://x.test/a.jpg","https://x.test/b.png"]';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
      ]);
    });
    it('parses JSON array with mixed shapes', () => {
      const input = '[{"url":"https://x.test/a.jpg"},"https://x.test/b.png"]';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
      ]);
    });
    it('detects video type from mime-style hint', () => {
      const input = '[{"url":"https://x.test/v.mp4","mimeType":"video/mp4"}]';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/v.mp4', type: 'video' },
      ]);
    });
    it('parses single object wrapped in JSON', () => {
      const input = '{"url":"https://x.test/a.jpg","type":"image"}';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
      ]);
    });
    it('returns [] when JSON is malformed', () => {
      const input = '[{"url":"https://x.test/a.jpg"'; // unclosed
      expect(parseWebhookAttachments(input)).toEqual([]);
    });
  });

  describe('plain URL string formats', () => {
    it('treats a single URL as one image attachment', () => {
      const input = 'https://lookaside.fbsbx.com/some/long/path?token=abc';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://lookaside.fbsbx.com/some/long/path?token=abc', type: 'image' },
      ]);
    });
    it('splits comma-separated URL list', () => {
      const input = 'https://x.test/a.jpg, https://x.test/b.png ,https://x.test/c.gif';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
        { url: 'https://x.test/c.gif', type: 'image' },
      ]);
    });
    it('filters out non-URL parts from comma list', () => {
      const input = 'https://x.test/a.jpg, garbage-no-protocol, https://x.test/b.png';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
      ]);
    });
    it('returns [] for non-URL plain string', () => {
      expect(parseWebhookAttachments('just some text')).toEqual([]);
    });
  });

  describe('URL extension type inference', () => {
    it('detects video from .mp4 extension', () => {
      expect(parseWebhookAttachments('https://x.test/clip.mp4')).toEqual([
        { url: 'https://x.test/clip.mp4', type: 'video' },
      ]);
    });
    it('detects video from .mov / .webm / .m4v', () => {
      expect(parseWebhookAttachments('https://x.test/a.mov')[0].type).toBe('video');
      expect(parseWebhookAttachments('https://x.test/a.webm')[0].type).toBe('video');
      expect(parseWebhookAttachments('https://x.test/a.m4v')[0].type).toBe('video');
    });
    it('detects audio from .mp3 / .m4a / .ogg / .wav', () => {
      expect(parseWebhookAttachments('https://x.test/a.mp3')[0].type).toBe('audio');
      expect(parseWebhookAttachments('https://x.test/a.m4a')[0].type).toBe('audio');
      expect(parseWebhookAttachments('https://x.test/a.ogg')[0].type).toBe('audio');
      expect(parseWebhookAttachments('https://x.test/a.wav')[0].type).toBe('audio');
    });
    it('still defaults to image for .jpeg / .png / no extension', () => {
      expect(parseWebhookAttachments('https://x.test/a.jpeg')[0].type).toBe('image');
      expect(parseWebhookAttachments('https://x.test/a.png')[0].type).toBe('image');
      expect(parseWebhookAttachments('https://x.test/a')[0].type).toBe('image');
    });
    it('detects extension despite query string', () => {
      expect(parseWebhookAttachments('https://x.test/clip.mp4?token=abc')[0].type).toBe('video');
      expect(parseWebhookAttachments('https://x.test/voice.m4a?sig=xyz')[0].type).toBe('audio');
    });
    it('infers per-URL type in comma-separated list (mixed media)', () => {
      const input = 'https://x.test/a.jpg, https://x.test/b.mp4, https://x.test/c.mp3';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.mp4', type: 'video' },
        { url: 'https://x.test/c.mp3', type: 'audio' },
      ]);
    });
    it('infers type for URL strings inside a JSON array', () => {
      const input = '["https://x.test/a.jpg","https://x.test/b.mp4"]';
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.mp4', type: 'video' },
      ]);
    });
  });

  describe('direct array inputs (not strings)', () => {
    it('handles array of objects directly', () => {
      const input = [{ url: 'https://x.test/a.jpg', type: 'image' }];
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
      ]);
    });
    it('handles array of URL strings directly', () => {
      const input = ['https://x.test/a.jpg', 'https://x.test/b.png'];
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
      ]);
    });
    it('skips array items without recognizable url field', () => {
      const input = [{ foo: 'bar' }, { url: 'https://x.test/a.jpg' }];
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
      ]);
    });
    it('handles alternative url field names', () => {
      const input = [
        { imageUrl: 'https://x.test/a.jpg' },
        { mediaUrl: 'https://x.test/b.png' },
      ];
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
        { url: 'https://x.test/b.png', type: 'image' },
      ]);
    });
  });

  describe('object input (single attachment)', () => {
    it('wraps a single object as one-item array', () => {
      const input = { url: 'https://x.test/a.jpg', type: 'image' };
      expect(parseWebhookAttachments(input)).toEqual([
        { url: 'https://x.test/a.jpg', type: 'image' },
      ]);
    });
  });

  describe('garbage inputs', () => {
    it('returns [] for number', () => {
      expect(parseWebhookAttachments(42)).toEqual([]);
    });
    it('returns [] for boolean', () => {
      expect(parseWebhookAttachments(true)).toEqual([]);
    });
  });
});
