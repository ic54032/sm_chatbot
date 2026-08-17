import { describe, it, expect } from 'vitest';
import { loadMasterPrompt } from '../../../src/prompt/load-master-prompt.js';

describe('loadMasterPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = loadMasterPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(500);
  });

  it('contains the key sections from the master prompt', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('IDENTITY AND VOICE');
    expect(prompt).toContain('PHOTO HANDLING');
    expect(prompt).toContain('TOOL USAGE');
    expect(prompt).toContain('PRICE QUOTING');
    // v3 sections — catch accidental loss on future prompt swaps.
    expect(prompt).toContain('IDENTITY QUESTIONS AND DISCLOSURE');
    expect(prompt).toContain('Time awareness');
    expect(prompt).toContain('service_menu.not_offered');
    expect(prompt).toContain('When a client references an attachment that is not visible');
    expect(prompt).toContain('No follow-up promises');
    expect(prompt).toContain('Send the link on turn 1');
    // Local hardening ported across swaps: the sanitizer-strip colon warning
    // and the state label matching build.ts ("sent recently", not "in last N messages").
    expect(prompt).toContain('Booking link sent recently');
    // Re-paste the link when the client can't find it (2026-07-11 fix).
    expect(prompt).toContain('cannot find it');
    expect(prompt).not.toContain('sent in last N messages');
    // Anti-leak rule after the 2026-07-06 incident: bracket example notation
    // must never be written into reply text.
    expect(prompt).toContain('INVISIBLE native function calls');
  });

  it('contains the QA Round 1 Part 1 behavior fixes', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('Never state a policy that is not in the knowledge base'); // 1.6
    expect(prompt).toContain('Do NOT send the booking link on a'); // 1.7
    expect(prompt).toContain('Name one concrete thing you actually see'); // 1.3
    expect(prompt).toContain('Every example line in this prompt is a PATTERN'); // 1.4/1.5
    expect(prompt).toContain('Never narrate your own machinery'); // 1.9 P0
    expect(prompt).toContain('Clear ready-to-book signals'); // 1.8a
    expect(prompt).toContain('If the CLIENT points out the conflict'); // 1.8b
    expect(prompt).toContain('Never repeat the same deflection twice'); // 1.8c
    expect(prompt).toContain('Phishing, scam, and impersonation'); // 1.8d
    expect(prompt).toContain('Story and reel context'); // 1.8f
    expect(prompt).toContain('Never restate the question'); // 1.9 voice
  });

  it('contains the QA Round 2 behavior fixes', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('Never dump the menu'); // 4.4
    expect(prompt).toContain('The same rule covers PEOPLE, the PAST, and PAYMENT'); // 4.5 (Petra + "cash")
    expect(prompt).toContain('Never reuse your own phrasing'); // 4.7a
    expect(prompt).toContain('Hi there,'); // 4.7a banned opener family
    expect(prompt).toContain('Start EVERY sentence lowercase'); // 4.8
    expect(prompt).toContain('The redirect is only half the rule'); // 4.3 video admission
    // The three media markers the backend can now inject (Section 8).
    expect(prompt).toContain('[client sent a video]');
    expect(prompt).toContain('[client sent a voice note]');
    expect(prompt).toContain('[client sent an attachment that did not come through]');
  });

  it('contains the QA Round 3 behavior fixes', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('Vendor pitches versus VIP offers'); // 4.1
    expect(prompt).toContain('Money flowing toward the salon is VIP'); // 4.1
    expect(prompt).toContain('One objection is never enough'); // 4.2
    expect(prompt).toContain('Two failures are equally forbidden here'); // 4.4 / 4.5
    expect(prompt).toContain('never name or price a specific service from it'); // 4.5
    expect(prompt).toContain('Answer the polarity of the question that was asked'); // 5.1
    expect(prompt).toContain('Decline in YOUR voice, never in theirs'); // 5.6
    expect(prompt).toContain('hair journey'); // 5.7 filler now banned
    expect(prompt).toContain('una consulta'); // 5.8 native-quality rule
  });

  it('ships no example the model can copy verbatim across conversations', () => {
    const prompt = loadMasterPrompt();
    // 5.2: the same finished sentence appearing twice reads to the model as
    // "this exact string is the right answer" — it shipped word for word in two
    // different production conversations.
    const youLines = prompt
      .split('\n')
      .filter((l) => /^You: "/.test(l))
      .map((l) => l.trim());
    const seen = new Set<string>();
    for (const line of youLines) {
      expect(seen.has(line)).toBe(false);
      seen.add(line);
    }
    // And no example may hardcode a real stylist roster.
    expect(prompt).not.toMatch(/renata, tash, and mia/i);
  });

  // Three separate Round 3 findings traced back to the prompt shipping the very
  // behaviour it forbids as a GOOD example. Guard the two that already bit us.
  it('a generic photo opener appears only as a Bad example', () => {
    const prompt = loadMasterPrompt();
    // These phrases may appear ONLY on a "Bad:" line. Anywhere else they are an
    // example the model copies, which is exactly how one reached a client
    // (production 2026-08-15).
    for (const phrase of ['ooh love this inspo', 'thanks for sharing the photo']) {
      const lines = [...prompt.matchAll(new RegExp('^.*' + phrase + '.*$', 'gim'))].map((m) => m[0]);
      expect(lines.length).toBeGreaterThan(0); // the Bad example must still be there
      for (const line of lines) expect(line.trimStart()).toMatch(/^Bad:/i);
    }
  });

  it('the consult objection and photo observation each ship a worked example', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('escalates on the first objection'); // 4.2 BAD pair
    expect(prompt).toContain('names something only THIS photo could have shown'); // 1.3 GOOD pair
  });

  it('the prompt obeys its own style rules (no banned phrases inside bot example lines)', () => {
    const prompt = loadMasterPrompt();
    // "happy to help" / "flag her" appeared in example replies and now conflict
    // with the strengthened rules — must only survive in the ban list / a BAD example.
    // BAD blocks are demonstrations of what NOT to do, so they are exempt: scan
    // only the "You:" lines that sit under a GOOD heading (or under none).
    const youLines: string[] = [];
    let inBadBlock = false;
    for (const line of prompt.split('\n')) {
      if (/^BAD\b/i.test(line)) inBadBlock = true;
      else if (/^GOOD\b/i.test(line)) inBadBlock = false;
      if (!inBadBlock && /You:\s*"/.test(line)) youLines.push(line);
    }
    expect(youLines.length).toBeGreaterThan(5); // guard against the filter silently matching nothing
    for (const line of youLines) {
      expect(line).not.toMatch(/happy to help/i);
      expect(line).not.toMatch(/\bflag (her|him|the owner|this)\b/i);
      expect(line).not.toMatch(/Hey there|It sounds like|Thanks for sharing/i);
    }
    // no em/en dashes or semicolons anywhere in the prompt (its own punctuation rule)
    expect(prompt).not.toMatch(/[—–]/);
    expect(prompt).not.toContain(';');
  });

  it('contains the heart emoji, not the mojibake artifact', () => {
    const prompt = loadMasterPrompt();
    expect(prompt).toContain('🤍');
    expect(prompt).not.toContain('ð¤');
  });

  it('returns the same cached string on repeated calls', () => {
    expect(loadMasterPrompt()).toBe(loadMasterPrompt());
  });
});
