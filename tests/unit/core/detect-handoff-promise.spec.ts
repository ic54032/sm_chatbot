import { describe, it, expect } from 'vitest';
import { containsHandoffPromise } from '../../../src/core/detect-handoff-promise.js';

describe('containsHandoffPromise — true positives (must escalate)', () => {
  const positives: Array<[string, string]> = [
    ['let me grab [Name]', 'Let me grab Renata for you'],
    ['let me get her', "I'm so sorry. Let me get her on this right away."],
    ['let me pull in [Name]', 'Let me pull in Renata to address this directly'],
    ["I'll let her know", "I'll let her know right away 🤍"],
    ['I will let [Name] know', 'I will let Renata know about this'],
    ['letting [Name] know', 'letting Renata know now 🤍'],
    ["she'll jump in", "she'll jump in shortly to help"],
    ["he'll reach out", "he'll reach out as soon as he can"],
    ['[Name] will jump in', 'Renata will jump in when she gets a sec'],
    ['she will address this directly', 'she will address this directly with you'],
    ['compound: get + let know', 'Let me get Renata to address this directly with you. I\'ll let her know right away.'],
  ];

  for (const [label, text] of positives) {
    it(`detects "${label}"`, () => {
      expect(containsHandoffPromise(text)).toBe(true);
    });
  }
});

describe('containsHandoffPromise — true negatives (must NOT escalate)', () => {
  const negatives: Array<[string, string]> = [
    ['simple greeting', 'Hi! How can I help you today? 🤍'],
    ['booking link reply', "Here's the link to book https://example.com/book"],
    ['price quote', 'Balayage starts at $200 with us 🤍'],
    ['I\'ll let you know', "I'll let you know once we confirm the date"],
    ['letting you choose', 'letting you pick the best time that works'],
    ['she does balayage', 'She does balayage and color corrections'],
    ['he is available', 'He is available Tuesday afternoon'],
    ['letting her pick', 'letting her pick the slot that fits her schedule'],
  ];

  for (const [label, text] of negatives) {
    it(`does not flag "${label}"`, () => {
      expect(containsHandoffPromise(text)).toBe(false);
    });
  }
});
