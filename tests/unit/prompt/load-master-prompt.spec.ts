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
    expect(prompt).toContain('dangling colon');
    expect(prompt).not.toContain('sent in last N messages');
    // Anti-leak rule after the 2026-07-06 incident: bracket example notation
    // must never be written into reply text.
    expect(prompt).toContain('INVISIBLE native function calls');
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
