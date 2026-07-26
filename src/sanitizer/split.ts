/**
 * Split a reply into at most `maxMessages` bubbles, preferring sentence
 * boundaries and never losing a word.
 *
 * The previous version silently damaged output in two ways, both confirmed in
 * production:
 *
 *   - A reply needing more than `maxMessages` bubbles had the remainder thrown
 *     away by a trailing `.slice()`. A 104-word reply on 2026-07-21 lost roughly
 *     24 words, and anything at the end (the booking link, for instance) went
 *     with them.
 *   - A single sentence longer than the word cap was cut mid-thought with
 *     `slice(0, maxWords)` and the tail discarded.
 *
 * The rule now is that text is never dropped. The final bubble absorbs whatever
 * is left, and an oversized sentence goes out whole. A bubble slightly over the
 * word cap is a much smaller problem than half an answer.
 *
 * NOTE on URLs: the caller keeps them masked behind placeholders while this
 * runs. That matters because a domain's dots look exactly like sentence
 * boundaries to the regex below, and rejoining split pieces with spaces turned
 * "lumenhairstudio.glossgenius.com/book" into a dead link (production
 * 2026-07-15).
 */
const SENTENCE_RE = /[^.!?]+[.!?]+|\S[^.!?]*$/g;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function splitOnSentenceBoundaries(
  text: string,
  maxWordsPerMessage: number,
  maxMessages: number,
): string[] {
  const sentences = text.match(SENTENCE_RE)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const messages: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    // On the final allowed bubble everything remaining must go in, or it would
    // be lost. This is what bounds the bubble count without discarding text.
    const onFinalBubble = messages.length === maxMessages - 1;
    const candidate = current ? `${current} ${sentence}` : sentence;

    if (onFinalBubble || wordCount(candidate) <= maxWordsPerMessage) {
      current = candidate;
      continue;
    }

    if (current) messages.push(current.trim());
    // An oversized single sentence starts (and may end) a bubble on its own.
    // Better one long message than a truncated one.
    current = sentence;
  }

  if (current) messages.push(current.trim());
  return messages;
}
