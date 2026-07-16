/**
 * 1.9 tripwire — internal-vocabulary / machinery-narration detector.
 *
 * The whole value of this net is that it fires on the bot narrating its own
 * plumbing WITHOUT firing on ordinary casual salon speech. The negative corpus
 * below is therefore the important half: every legit phrase must stay clean, or
 * the tripwire would spuriously regenerate/hand off healthy replies.
 */
import { describe, it, expect } from 'vitest';
import { matchInternalVocab } from '../../../src/sanitizer/internal-vocab.js';

describe('matchInternalVocab — machinery / internal-vocab leaks (must DETECT)', () => {
  const leaks: Array<[string, string]> = [
    ['note-as-last-quoted', 'you can book it here: https://x.test/book 🤍 I\'ll note this as the last quoted service'],
    ['make-a-note', 'sounds good, I\'ll make a note to check in with you next week'],
    ['flag-her', 'let me flag her for you, she\'ll get back to you soon'],
    ['ill-flag', 'I\'ll flag the owner about this one'],
    ['flag-this-for', 'flag this for the owner and she\'ll handle it'],
    ['last-quoted-underscore', 'noting that as your last_quoted_service now'],
    ['state-flag', 'let me set the state flag for hesitant'],
    ['reason-code', 'escalating with reason code unanswered_question'],
    ['bare-tool-name', 'set_state_flag(client_is_hesitant, true)'],
    ['mark-this', 'great, I\'ll mark this down for later'],
    ['log-this', 'I\'ll log this so we remember'],
    ['track-this', 'I\'ll track this for you'],
    ['saving-this-as', 'saving this as your preference now'],
    ['escalate-firstperson', 'let me escalate this right away'],
    ['escalate-owner', 'okay escalating this to the owner now'],
    ['handoff-owner', 'this is a handoff to the owner'],
    ['hand-you-off-owner', "I'll hand you off to the owner now"],
    ['context-summary', 'adding a context summary for the owner'],
    ['function-call', 'that was a function call, not a real message'],
    // Gerund forms — Section 12 forbids "noting your interest" / "flagging this
    // for the owner" by name; both slipped the base-verb patterns before.
    ['noting-gerund', 'noting your interest so the owner sees it'],
    ['flagging-gerund', 'flagging this for the owner now'],
    ['marking-gerund', 'marking you down on my end'],
    ['logging-gerund', 'logging that for later'],
    // Recording / datastore narration.
    ['for-my-records', 'let me keep this for my records'],
    ['in-my-notes', "it's in my notes now"],
    ['in-the-system', 'putting this in the system for you'],
    ['jot-down', 'let me jot this down'],
    // Routing / GHL-mechanism narration.
    ['pass-along', "I'll pass this along to the owner"],
    ['tag-firstperson', 'let me tag her for the owner'],
  ];

  for (const [name, text] of leaks) {
    it(`detects: ${name}`, () => {
      expect(matchInternalVocab(text)).not.toBeNull();
    });
  }
});

describe('matchInternalVocab — legit casual salon speech (must NOT detect)', () => {
  const clean: string[] = [
    'noted 🤍 see you saturday',
    'just a quick note, we\'re closed monday',
    'save your spot with the link below 🤍',
    'I\'ll save you a seat for the consult',
    'you\'re on the right track, going lighter slowly is the safe move',
    'that\'s a bit of a red flag, let\'s chat about it at the consult',
    'come on in, we\'ll get you sorted',
    'here you go 🤍 https://x.test/book',
    'let me grab Sarah for you, she\'ll jump in as soon as she\'s between clients 🤍',
    'your balayage is going to look amazing',
    'mark your calendar for saturday at 2 🤍',
    'we can track down that exact shade for you',
    'off the top of my head, a full balayage runs about 3 hours',
    'totally get the nerves, first-time color starts with a free consult',
    'the booking link I sent has all the latest openings',
    // Adversarial false-positives found in review — must stay clean:
    'no worries, we can hand off your color to a senior stylist if needed 🤍',
    'just flag her down when you get here and she\'ll get you sorted 🤍',
    'we can note that down for your next visit 🤍',
    'let\'s get you in before things escalate, we don\'t want breakage 🤍',
    'I\'ll pass you along to a senior stylist for that one',
    'tag us on insta so we can see your new look 🤍',
    'saving that spot for your visit 🤍',
    'we hand off longer color jobs to our senior team',
  ];

  for (const text of clean) {
    it(`stays clean: "${text.slice(0, 40)}..."`, () => {
      expect(matchInternalVocab(text)).toBeNull();
    });
  }
});
