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
    // New sections added in the finalized master prompt — catch accidental loss.
    expect(prompt).toContain('Consultation refusal escalation');
    expect(prompt).toContain('Tier 2');
    expect(prompt).toContain('When a client references an attachment you don');
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
