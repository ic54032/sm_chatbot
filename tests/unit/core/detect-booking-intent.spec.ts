/**
 * B4 booking-intent detector. It gates the empty-output link fallback, so the
 * negative corpus is the important half: a non-booking message must never match
 * (that would send a stray booking link on a turn where the model went empty).
 */
import { describe, it, expect } from 'vitest';
import { containsBookingIntent } from '../../../src/core/detect-booking-intent.js';

describe('containsBookingIntent — anchored ready-to-book phrases (must MATCH)', () => {
  const yes = [
    'book me in',
    'You know what, im ready, book me in', // the production B4 case
    'ok book me in for saturday',
    'sign me up',
    'i want to book',
    "i'd like to book a balayage",
    "let's book",
    'ready to book',
    "i'm ready to book",
    'im ready to book',
    'book it now',
    "I can't wait, book me in!", // negation governs "wait", not the booking phrase
  ];
  for (const t of yes) {
    it(`matches: "${t.slice(0, 40)}"`, () => expect(containsBookingIntent(t)).toBe(true));
  }
});

/**
 * The second intent family: asking for the link again.
 *
 * On 2026-08-23 18:33 a client typed "Could you send it again", the model
 * produced no reply text, and the recovery path did not read that as booking
 * intent, so what went back was a generic reassurance line instead of the URL
 * they had just asked for. The phrases mirror the ones the master prompt already
 * lists as an explicit request for the link.
 */
describe('containsBookingIntent — asking for the link again (must match)', () => {
  const yes = [
    'Could you send it again',
    'send it again please',
    'can you send the link again?',
    'resend the link',
    'resend it',
    'where is the link',
    "where's the link?",
    'which is the link',
    "i can't find the link",
    'i cant find the link',
    'i dont see the link',
    "i don't see a link",
  ];
  for (const t of yes) {
    it(`reads as a request for the link: "${t.slice(0, 40)}"`, () =>
      expect(containsBookingIntent(t)).toBe(true));
  }
});

describe('containsBookingIntent — resend requests that are NOT about the link', () => {
  const no = [
    'can you send the photo again', // their own picture, not our link
    "don't send it again", // negation immediately before
    'do not resend it',
  ];
  for (const t of no) {
    it(`stays clean: "${t.slice(0, 40)}"`, () => expect(containsBookingIntent(t)).toBe(false));
  }
});

describe('containsBookingIntent — non-booking / negated / deferred (must NOT match)', () => {
  const no = [
    '',
    'how much is a full balayage?',
    "I'm ready for the bad news lol, how much?", // bare "ready", not "ready to book"
    "let's do it another time", // "let's do it" is not a pattern
    'what time do you close on saturday?',
    'ok yeah that actually makes sense, thanks',
    'how do I cancel my appointment?',
    "don't book me in yet, I have a question first", // negation before
    'not ready to book yet', // negation before
    'book me in another time', // deferral after
    'book me in later once I check my schedule', // deferral after
    'can I get a quote first before I book',
    "I'm ready to hear the price",
  ];
  for (const t of no) {
    it(`stays clean: "${t.slice(0, 40)}"`, () => expect(containsBookingIntent(t)).toBe(false));
  }
});
