import type { ContentBlock } from '../llm/client.js';
import type { BuildPromptOutput } from './build.js';

/**
 * Drop image blocks from a prompt, keeping every caption and turn in place.
 *
 * Used for the corrective retry, which asks the model for one thing: write the
 * prose you forgot. It does not need the photos again — the model already
 * analysed them on the attempt that just returned, and the retry runs with tools
 * stripped anyway.
 *
 * Re-sending them is expensive in the one currency that actually failed. Image
 * tokens count toward the tokens-per-minute limit, a turn carrying photos
 * measures 13-18k tokens, and the retry fires seconds later — roughly 38k
 * requested inside two seconds against a 30k/minute budget, which is a
 * guaranteed 429. Production 2026-08-08 and 2026-08-10 both surfaced that as a
 * bogus `llm_failed` on a healthy conversation. Without the images the retry
 * costs about a tenth as much.
 */
/**
 * What replaces an image block on the retry.
 *
 * Wording matters more than it looks. An earlier version said "[photo already
 * reviewed]", which asserts to a stateless model that it has seen something it
 * has not — and Section 8 of the prompt tells it to name a concrete detail from
 * the photo. That combination invites an invented description of a damage photo,
 * which is the exact fabrication the media rules exist to prevent. State the
 * absence and forbid the description instead.
 */
const PHOTO_OMITTED = '[the photo is not attached to this turn, do not describe it]';

export function withoutImageBlocks(messages: BuildPromptOutput['messages']): BuildPromptOutput['messages'] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return m;

    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    const hadImage = m.content.some((b) => b.type === 'image');

    // The marker keeps the turn meaningful — "what do you think?" two messages
    // later still has something to refer back to — and guarantees we never emit
    // an empty content string, which the APIs reject.
    const content = [text, hadImage ? PHOTO_OMITTED : ''].filter(Boolean).join(' ');
    return { ...m, content: content || PHOTO_OMITTED };
  });
}
