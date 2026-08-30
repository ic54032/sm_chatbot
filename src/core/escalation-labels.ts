/**
 * Human-readable labels for escalation reasons.
 *
 * The reason code is our internal vocabulary — `sanitizer_empty_output` means
 * nothing to a salon owner reading a phone notification at the chair. The raw
 * code stays in the database (escalations.reason and the escalated_to_owner
 * event) so analytics and debugging keep working; only what the owner actually
 * READS gets translated.
 *
 * Labels are written from the bot's point of view, in plain English, and say
 * what the owner should do. Keep them short enough to survive a lock screen.
 */
const LABELS: Record<string, string> = {
  // Client intent
  refund_request: 'Refund request',
  vip_client: 'Possible VIP, press or influencer',
  medical_question: 'Health question, needs you',
  explicit_request_for_owner: 'Client asked for you directly',
  this_salon_complaint: 'Complaint about a recent visit',
  unanswered_question: "Question I couldn't answer",
  client_refused_consultation_path: 'Wants a direct answer, skipped the consult',
  hostile_language: 'Hostile message, take a look',
  // A lead, not a problem: the bot keeps the conversation going while she sees it.
  //
  // Deliberately not named for colour. A client sending "can you fix this" could be
  // showing box dye gone wrong, brassiness, banding, a patchy bleach, a cut they
  // hate, a perm that dropped, extensions matting at the bonds, or hair that is
  // simply breaking. The cause differs every time and the business meaning does
  // not: someone wants corrective work, it is usually expensive, and it is usually
  // not this salon's doing.
  correction_lead: 'Client wants something fixed, take a look',

  // Media the bot cannot read.
  //
  // Video and voice notes share one label on purpose. GHL delivers both as .mp4
  // and serves both as video/mp4, so the only way to tell them apart is to read
  // the container bytes at request time — and when that probe does not return in
  // time the guess falls back to "video", which is how a voice note was
  // announced as a video for three QA rounds running. A merged label is slightly
  // less specific and always true, which is the better trade for a notification
  // the owner acts on.
  video_attachment: 'Client sent a video, take a look',
  audio_attachment: 'Client sent a voice note, take a look',
  // Only when the container probe could not settle it. GHL serves both as
  // video/mp4 and the URL extension calls every voice note a video, so without a
  // verdict the honest answer is that we do not know which one it is.
  unconfirmed_media_attachment: 'Client sent a video or voice note, take a look',
  // Not "disappearing photo": a vanish-mode photo produces no webhook at all
  // (verified 2026-08-17 — nothing reaches GHL, let alone us), so it can never
  // land on this branch. What does land here is a shared reel or post.
  unviewable_media: 'Client shared a reel or post, take a look',
  image_without_url: "Client sent a photo I couldn't open, take a look",
  image_processing_disabled: 'Client sent a photo, take a look',
  attachment_fetch_failed: "Client sent a photo I couldn't open, take a look",

  // Bot-side trouble
  sanitizer_empty_output: "Bot couldn't answer, jumping to you",
  llm_failed: 'Technical issue, bot paused',
  internal_vocab_leak: "Bot couldn't answer, jumping to you",
  implied_handoff_no_tool_call: 'Bot told the client you would step in',
  unspecified: 'Needs your attention',
};

/**
 * The label an owner should see for `reason`. An unmapped reason degrades to a
 * readable sentence rather than leaking snake_case: "some_new_reason" reads as
 * "Some new reason".
 */
export function escalationLabel(reason: string): string {
  const known = LABELS[reason];
  if (known) return known;
  const words = reason.replace(/[_-]+/g, ' ').trim();
  if (!words) return LABELS.unspecified;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
