/**
 * Production 2026-08-23: a client pasted an Instagram reel link, the webhook came
 * through as an ordinary text message, and nobody was told. The owner needs the
 * same note whether the share arrives natively or as text.
 */
import { describe, it, expect } from 'vitest';
import { containsSharedMediaLink } from '../../../src/core/shared-media-link.js';

describe('containsSharedMediaLink — shares the owner should see', () => {
  it('matches the reel link from the production incident', () => {
    expect(containsSharedMediaLink('https://www.instagram.com/reel/DcWLEucskaE/')).toBe(true);
  });

  it('matches posts, reels, tv and share links', () => {
    for (const url of [
      'https://www.instagram.com/p/Cx1y2z3AbCd/',
      'https://instagram.com/reels/DcE774zBVUb/',
      'https://www.instagram.com/tv/Bx9Y8z7AbCd/',
      'https://www.instagram.com/share/BAbCdEfGh/',
    ]) {
      expect(containsSharedMediaLink(url), url).toBe(true);
    }
  });

  it('matches a link sent alongside a question', () => {
    expect(containsSharedMediaLink('can you do this? https://www.instagram.com/reel/DcE774zBVUb/ 🤍')).toBe(true);
  });

  it('is case insensitive on the host', () => {
    expect(containsSharedMediaLink('HTTPS://WWW.INSTAGRAM.COM/REEL/DcWLEucskaE/')).toBe(true);
  });
});

describe('containsSharedMediaLink — text that must NOT notify the owner', () => {
  it('ignores a bare profile link, which is not a shared post', () => {
    expect(containsSharedMediaLink('https://www.instagram.com/lumenhairstudio')).toBe(false);
  });

  it('ignores the salon booking link', () => {
    expect(containsSharedMediaLink('https://lumenhairstudio.glossgenius.com/book')).toBe(false);
  });

  it('ignores ordinary messages, including ones that talk about reels', () => {
    for (const text of [
      'how much is balayage?',
      'i saw a reel with this exact colour, can you do it?',
      'do you post on instagram?',
      '',
    ]) {
      expect(containsSharedMediaLink(text), text).toBe(false);
    }
  });

  it('tolerates null and undefined', () => {
    expect(containsSharedMediaLink(null)).toBe(false);
    expect(containsSharedMediaLink(undefined)).toBe(false);
  });

  // Scoped deliberately: Instagram is what production reported and what the owner
  // approved. TikTok and Pinterest are the same problem under a different host and
  // are one alternation away, but adding hosts nobody asked for would widen the
  // notification surface silently.
  it('does not currently match other hosts', () => {
    expect(containsSharedMediaLink('https://www.tiktok.com/@user/video/123')).toBe(false);
    expect(containsSharedMediaLink('https://pin.it/abc123')).toBe(false);
  });
});
