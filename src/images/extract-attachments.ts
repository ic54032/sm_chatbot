export interface ExtractedImageAttachment {
  url: string;
}

export function extractImageAttachments(rawContent: unknown): ExtractedImageAttachment[] {
  if (!rawContent || typeof rawContent !== 'object') return [];
  const atts = (rawContent as { attachments?: unknown }).attachments;
  if (!Array.isArray(atts)) return [];

  const result: ExtractedImageAttachment[] = [];
  for (const att of atts) {
    if (!att || typeof att !== 'object') continue;
    const a = att as { url?: unknown; type?: unknown };
    if (a.type !== 'image') continue;
    if (typeof a.url !== 'string' || a.url.length === 0) continue;
    result.push({ url: a.url });
  }
  return result;
}
