export function splitOnSentenceBoundaries(text: string, maxWordsPerMessage: number, maxMessages: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const messages: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (messages.length >= maxMessages) break;
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.split(/\s+/).length <= maxWordsPerMessage) {
      current = candidate;
    } else {
      if (current) {
        messages.push(current.trim());
        current = '';
      }
      if (messages.length >= maxMessages) break;
      const sentenceWords = sentence.split(/\s+/);
      if (sentenceWords.length <= maxWordsPerMessage) {
        current = sentence;
      } else {
        const truncated = sentenceWords.slice(0, maxWordsPerMessage).join(' ');
        messages.push(truncated);
        current = '';
      }
    }
  }
  if (current && messages.length < maxMessages) messages.push(current.trim());
  return messages.slice(0, maxMessages);
}
