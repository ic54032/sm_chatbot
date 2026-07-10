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
    // 2026-07-06 production miss + master prompt's own hostile-language example
    ['letting X handle this one (prod incident)', "I'm letting Renata handle this one. 🤍"],
    ['Imma let X take this one (prompt example)', 'Imma let Renata take this one 🤍'],
    ['letting her handle this', 'no worries, letting her handle this'],
    ["she'll take it from here", "she'll take it from here 🤍"],
    ['X will take this one', 'Renata will take this one 🤍'],
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
    ["she'll take a look", "she'll take a look at the photo during the consult"],
    ['letting you handle it', 'letting you handle it from the booking page'],
    ['let me take a look', 'let me take a look at what works'],
    ['take this to your stylist', 'you can take this to your stylist'],
    // Benign salon vocabulary found by adversarial review — each of these
    // previously force-escalated and paused the bot for the handoff window.
    ["she'll take it slow", "if your hair feels fragile, she'll take it slow, no rush at all"],
    ["she'll take it down a shade", "she'll take it down a shade or two gradually so we protect your ends"],
    ["they'll take it off your total", "they'll take it off your total if you rebook same day!"],
    ["she'll take this into account", "she'll take this into account when mixing your color"],
    ['That will take it right out', 'That will take it right out, a clarifying wash usually does the trick!'],
    ['It will take that color a few washes', 'It will take that color a few washes to fully settle.'],
    ['Toner will take that yellow down', 'Toner will take that yellow down a ton, promise!'],
    ['Olaplex will take it from damaged', 'Olaplex will take it from damaged to silky in a few treatments.'],
    ['let her handle that at your consult', 'feel free to let her handle that at your consult, she knows exactly what to do'],
    ['let Olaplex handle it', 'just let Olaplex handle it between salon visits'],
    ['letting them take it home', "we'd suggest letting them take it home, the aftercare kit is included!"],
    ["I'll let them take it from your deposit", "I'll let them take it from your deposit!"],
    ["I'm gonna let her take it easy", "I'm gonna let her take it easy on the layers this time per your note!"],
  ];

  for (const [label, text] of negatives) {
    it(`does not flag "${label}"`, () => {
      expect(containsHandoffPromise(text)).toBe(false);
    });
  }
});
