import { describe, it, expect } from 'vitest';
import { extractLeakedToolCalls } from '../../../src/core/extract-leaked-tool-calls.js';

describe('extractLeakedToolCalls — production incident strings (2026-07-06, verbatim)', () => {
  it('strips the invented [get_started_link()] from the booking reply', () => {
    const text =
      'Yay! You can book through this link: https://lumenhairstudio.glossgenius.com/book. It’ll guide you through picking a time for your consultation. 🤍\n[get_started_link()]';
    const r = extractLeakedToolCalls(text);
    expect(r.cleanedText).toBe(
      'Yay! You can book through this link: https://lumenhairstudio.glossgenius.com/book. It’ll guide you through picking a time for your consultation. 🤍',
    );
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe('get_started_link');
    expect(r.calls[0].named).toEqual({});
    expect(r.calls[0].positional).toEqual([]);
  });

  it('strips and parses the full [escalate_to_owner(...)] block from the slur reply', () => {
    const text =
      'I\'m letting Renata handle this one. 🤍\n[escalate_to_owner(reason="hostile_language", context_summary="client used hostile language directed at the salon")]';
    const r = extractLeakedToolCalls(text);
    expect(r.cleanedText).toBe("I'm letting Renata handle this one. 🤍");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe('escalate_to_owner');
    expect(r.calls[0].named.reason).toBe('hostile_language');
    expect(r.calls[0].named.context_summary).toBe('client used hostile language directed at the salon');
  });
});

describe('extractLeakedToolCalls — general shapes', () => {
  it('parses positional args of set_state_flag', () => {
    const r = extractLeakedToolCalls('totally get that 🤍\n[set_state_flag("client_is_hesitant", true)]');
    expect(r.calls[0].name).toBe('set_state_flag');
    expect(r.calls[0].positional).toEqual(['client_is_hesitant', true]);
  });

  it('handles multiple leaked calls in one reply', () => {
    const r = extractLeakedToolCalls('here you go: https://x.test/book 🤍\n[set_state_flag("client_is_hesitant", true)]\n[mark_link_sent()]');
    expect(r.calls.map((c) => c.name)).toEqual(['set_state_flag', 'mark_link_sent']);
    expect(r.cleanedText).toBe('here you go: https://x.test/book 🤍');
  });

  it('handles inline (same line) bracket text', () => {
    const r = extractLeakedToolCalls('yes! here you go 🤍 [mark_link_sent()] see you soon');
    expect(r.calls[0].name).toBe('mark_link_sent');
    expect(r.cleanedText).toBe('yes! here you go 🤍  see you soon');
  });

  it('unescapes escaped quotes inside named args', () => {
    const r = extractLeakedToolCalls('[escalate_to_owner(reason="complaint", context_summary="client said \\"ruined\\"")]');
    expect(r.calls[0].named.context_summary).toBe('client said "ruined"');
  });

  it('returns text unchanged when nothing leaks', () => {
    const text = 'we do balayage! want the details? 🤍';
    const r = extractLeakedToolCalls(text);
    expect(r.cleanedText).toBe(text);
    expect(r.calls).toEqual([]);
  });
});

describe('extractLeakedToolCalls — hardened shapes (adversarial review findings)', () => {
  it('handles ")]" INSIDE a quoted arg without leaking residue to the client', () => {
    const text =
      'I\'m letting Renata handle this one. 🤍\n[escalate_to_owner(reason="hostile_language", context_summary="client replied with [get_started_link()] pasted back")]';
    const r = extractLeakedToolCalls(text);
    expect(r.cleanedText).toBe("I'm letting Renata handle this one. 🤍");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].named.reason).toBe('hostile_language');
    expect(r.calls[0].named.context_summary).toBe('client replied with [get_started_link()] pasted back');
  });

  it('parses named set_state_flag form (key="...", value=true)', () => {
    const r = extractLeakedToolCalls('[set_state_flag(key="client_is_hesitant", value=true)]');
    expect(r.calls[0].named).toEqual({ key: 'client_is_hesitant', value: true });
  });

  it('parses bare-identifier positional args (Python-kwarg style leak)', () => {
    const r = extractLeakedToolCalls('[set_state_flag(client_is_hesitant, true)]');
    expect(r.calls[0].positional).toEqual(['client_is_hesitant', true]);
  });

  it('preserves positional source order for mixed types', () => {
    const r = extractLeakedToolCalls('[set_state_flag("client_is_hesitant", true, "balayage")]');
    expect(r.calls[0].positional).toEqual(['client_is_hesitant', true, 'balayage']);
  });

  it('does not promote key="v" text inside a quoted string to a named arg', () => {
    const r = extractLeakedToolCalls('[escalate_to_owner("client wrote reason=\\"scam\\" about us")]');
    expect(r.calls[0].named).toEqual({});
    expect(r.calls[0].positional).toEqual(['client wrote reason="scam" about us']);
  });

  it('handles multiline bracket bodies', () => {
    const r = extractLeakedToolCalls('done 🤍\n[escalate_to_owner(\n  reason="refund_request",\n  context_summary="wants money back"\n)]');
    expect(r.cleanedText).toBe('done 🤍');
    expect(r.calls[0].named.reason).toBe('refund_request');
  });

  it('parses numeric positional args', () => {
    const r = extractLeakedToolCalls('[some_tool(42, -3.5)]');
    expect(r.calls[0].positional).toEqual([42, -3.5]);
  });
});

describe('extractLeakedToolCalls — must NOT false-positive', () => {
  it('leaves single-word bracketed asides with a parenthetical alone (space before parens)', () => {
    const text = 'the deposit is $50 [deposit (non-refundable)] and covers your consult 🤍';
    const r = extractLeakedToolCalls(text);
    expect(r.cleanedText).toBe(text);
    expect(r.calls).toEqual([]);
  });

  it('leaves markdown-style links alone', () => {
    const text = '[book (free consult)](https://lumen.glossgenius.com/book)';
    const r = extractLeakedToolCalls(text);
    expect(r.cleanedText).toBe(text);
    expect(r.calls).toEqual([]);
  });

  it('leaves an unterminated quote inside brackets alone (not a call)', () => {
    const text = '[weird("unterminated]';
    expect(extractLeakedToolCalls(text).cleanedText).toBe(text);
  });

  it('leaves the [image only, no caption] placeholder alone (no parens)', () => {
    const text = 'ooh love this 🤍 [image only, no caption]';
    expect(extractLeakedToolCalls(text).cleanedText).toBe(text);
  });

  it('leaves [booking.url]-style bracket references alone', () => {
    const text = 'here you go: [booking.url] 🤍';
    expect(extractLeakedToolCalls(text).cleanedText).toBe(text);
  });

  it('leaves plain parentheses prose alone', () => {
    const text = 'the consult is free (about 15 minutes) 🤍';
    expect(extractLeakedToolCalls(text).cleanedText).toBe(text);
  });

  it('leaves bracketed prose with spaces before parens alone', () => {
    const text = '[call me maybe (just kidding)]';
    expect(extractLeakedToolCalls(text).cleanedText).toBe(text);
  });
});
