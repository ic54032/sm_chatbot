/**
 * The owner reads the escalation reason in a phone notification, so it must be
 * English and human. QA Round 2 item 3.1: every notification showed raw codes
 * like `sanitizer_empty_output`. The raw code still goes to the database.
 */
import { describe, it, expect } from 'vitest';
import { escalationLabel } from '../../../src/core/escalation-labels.js';

describe('escalationLabel', () => {
  it('maps the client-intent reasons from the QA table', () => {
    expect(escalationLabel('refund_request')).toBe('Refund request');
    expect(escalationLabel('medical_question')).toBe('Health question, needs you');
    expect(escalationLabel('explicit_request_for_owner')).toBe('Client asked for you directly');
    expect(escalationLabel('this_salon_complaint')).toBe('Complaint about a recent visit');
    expect(escalationLabel('client_refused_consultation_path')).toBe('Wants a direct answer, skipped the consult');
    expect(escalationLabel('hostile_language')).toBe('Hostile message, take a look');
  });

  it('maps the media reasons', () => {
    expect(escalationLabel('video_attachment')).toBe('Client sent a video, take a look');
    expect(escalationLabel('audio_attachment')).toBe('Client sent a voice note, take a look');
    expect(escalationLabel('unviewable_media')).toContain('reel');
  });

  it('maps the bot-side reasons without leaking internal vocabulary', () => {
    expect(escalationLabel('sanitizer_empty_output')).toBe("Bot couldn't answer, jumping to you");
    expect(escalationLabel('llm_failed')).toBe('Technical issue, bot paused');
    // No label may contain our internal identifiers.
    for (const reason of ['sanitizer_empty_output', 'llm_failed', 'internal_vocab_leak', 'implied_handoff_no_tool_call']) {
      expect(escalationLabel(reason)).not.toMatch(/sanitizer|llm|vocab|tool_call|_/);
    }
  });

  it('degrades an unmapped reason to a readable sentence, never raw snake_case', () => {
    expect(escalationLabel('some_new_reason')).toBe('Some new reason');
    expect(escalationLabel('')).toBe('Needs your attention');
  });
});
