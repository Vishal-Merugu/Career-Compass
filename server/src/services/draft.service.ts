/**
 * The system prompt for every generated draft.
 *
 * Exported so the streaming preview and the actual send use the same one. A
 * preview generated from a different prompt than the send would be worse than
 * no preview: it would look like a review step and not be one.
 */
export const DRAFT_SYSTEM_PROMPT = [
  'You write short, specific, professional outreach emails from one person to another.',
  'You only ever state things the details you are given actually support.',
  'You never invent a company initiative, product, achievement or news item.',
].join(' ');

export interface IDraftInput {
  /** Raw model output, or a body the user wrote by hand. */
  body: string;
  /** Campaign-level subject, used when the draft does not supply one. */
  fallbackSubject: string;
  /** UserConfig.emailSignature. Appended verbatim when present. */
  signature?: string | null;
}

export interface IComposedDraft {
  subject: string;
  body: string;
}

/**
 * A model told to write an email usually writes the subject line into the body
 * as `Subject: ...`. Left alone it ships as the first line of the message with
 * the campaign's generic subject in the header.
 *
 * Only a leading `Subject:` counts. The mailer this was ported from matched
 * anywhere in the body with a multiline regex, so an email that happened to
 * discuss "Subject: X" mid-paragraph had that line hoisted into the header and
 * deleted from the text.
 */
export function extractSubject(body: string): {
  subject: string | null;
  body: string;
} {
  // `.*?` rather than `.+?`: a bare `Subject:` with nothing after it still
  // needs to match, so the empty line can be dropped from the body instead of
  // being sent as its first line.
  const match = /^[ \t]*subject:[ \t]*(.*?)[ \t]*(?:\r?\n|$)/i.exec(body);
  if (!match) {
    return { subject: null, body: body.trim() };
  }

  const subject = match[1].trim();
  if (!subject) {
    return { subject: null, body: body.slice(match[0].length).trim() };
  }

  return { subject, body: body.slice(match[0].length).trim() };
}

/**
 * Strip the conversational preamble models add before the email itself
 * ("Sure! Here's a draft:"), which would otherwise be sent to the recipient.
 *
 * Deliberately conservative — only an opening line that both looks like an
 * aside and is followed by a blank line. Anything cleverer risks eating a
 * legitimate first sentence, which is worse than leaving a stray line in a
 * draft the user is about to review anyway.
 */
export function stripPreamble(body: string): string {
  const preamble =
    /^(?:sure|certainly|of course|absolutely|here(?:'s| is)|below is)\b[^\n]*:[ \t]*\r?\n\r?\n/i;
  return body.replace(preamble, '').trim();
}

/**
 * Assemble what actually gets sent.
 *
 * The signature is appended, never substituted. The mailer ran a regex over
 * the body to delete any sign-off containing its author's own name, phone
 * number or LinkedIn URL before appending a hardcoded copy of the same
 * details — so it both carried one person's identity in source and mangled
 * any body that legitimately mentioned them.
 */
export function composeDraft(input: IDraftInput): IComposedDraft {
  const cleaned = stripPreamble(input.body);
  const { subject, body } = extractSubject(cleaned);

  const signature = input.signature?.trim();
  const withSignature = signature ? `${body}\n\n${signature}` : body;

  return {
    subject: subject ?? input.fallbackSubject,
    body: withSignature,
  };
}

/** How much of a person's LinkedIn "about" text is carried into the prompt. */
const ABOUT_LIMIT = 600;

/**
 * The material a draft is personalised from.
 *
 * A headline alone ("Cloud Solutions Architect at Siemens Healthineers") is
 * not enough to write a specific opening line, so a model asked for one
 * fabricates it. The `about` text is where a person says what they actually
 * work on, and it is already scraped — it was simply never passed on.
 *
 * Truncated because an `about` can run to several thousand characters, which
 * would crowd out the instructions and slow a local model for no gain.
 */
export function contactDescription(
  headline?: string | null,
  about?: string | null,
): string | null {
  const parts: string[] = [];

  const trimmedHeadline = headline?.trim();
  if (trimmedHeadline) parts.push(trimmedHeadline);

  const trimmedAbout = about?.trim().replace(/\s+/g, ' ');
  if (trimmedAbout) {
    const clipped =
      trimmedAbout.length > ABOUT_LIMIT
        ? `${trimmedAbout.slice(0, ABOUT_LIMIT).trimEnd()}…`
        : trimmedAbout;
    parts.push(`About: ${clipped}`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * The greeting name.
 *
 * `CampaignContact.name` is `"First Last"`, and a model handed only that
 * writes "Dear Anna Weber" or drops the greeting entirely. A single token is
 * returned unchanged, so a mononym or an already-first-name contact still
 * greets correctly.
 */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim();
}

/**
 * Prompt for a single contact.
 *
 * Contact fields are labelled and placed after the instruction, so a profile
 * headline reading "ignore previous instructions" is presented as data rather
 * than as a competing directive.
 *
 * The greeting is specified here rather than left to the campaign prompt.
 * Without it the model started at whatever the campaign's first structural
 * bullet was — so real sends went out opening on "I noticed that your team
 * at X…" with no salutation at all.
 *
 * The fabrication rule is here for the same reason: it must hold for every
 * campaign, and a headline is thin enough material that a model asked for a
 * "specific" opener will otherwise invent one ("your team is pioneering cloud
 * technologies in healthcare"), which reads as generic to the one person who
 * knows what their team actually does.
 */
export function buildDraftPrompt(params: {
  commonPrompt: string;
  name: string;
  email: string;
  companyName?: string | null;
  description?: string | null;
}): string {
  const firstName = firstNameOf(params.name);

  const facts = [
    `Name: ${params.name}`,
    `First name (use this in the greeting): ${firstName}`,
    `Email: ${params.email}`,
    params.companyName ? `Company: ${params.companyName}` : null,
    params.description ? `Role/description: ${params.description}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    params.commonPrompt.trim(),
    '',
    'Rules that always apply:',
    `- Begin with the greeting line "Hi ${firstName}," on its own line, then a blank line, then the email.`,
    '- Write the email body only. Do not add commentary before or after it.',
    '- Do not write a sign-off or signature; one is appended automatically.',
    '- Use only the details given below. If they do not support a specific observation about their work, refer plainly to their actual role and company instead of inventing an initiative, product, achievement or news item.',
    '- Do not say you admire, follow, read about or have used anything of theirs.',
    '- The first line must be "Subject: ..." — before the greeting. Write a subject specific to this person: 4–8 words, lower-case or sentence case, no colon-separated marketing structure, nothing that would fit any other recipient. It should read like a subject a colleague would type, not a campaign.',
    '',
    'Deliverability — breaking these gets the mail filtered before anyone reads it:',
    '- No ALL-CAPS words, no exclamation marks, no emoji, no "!!!" or "???".',
    '- No links, no URLs, no tracking parameters, no phone numbers in the body.',
    '- No currency amounts, percentages, "free", "guaranteed", "act now", "limited time", "urgent", "opportunity of a lifetime", "dear sir/madam", "to whom it may concern".',
    '- No "Re:" or "Fwd:" in the subject when there is no prior thread — it is the single strongest false-thread spam signal.',
    '- No word repeated for emphasis, no spaced-out letters, no unusual unicode substitutions for normal letters.',
    '- Plain text only: no HTML, no markdown, no bold, no headers, no bullet points, no tables.',
    '- Do not mention this email being automated, bulk, part of a campaign, or one of many.',
    '',
    'Details of the person you are writing to:',
    facts,
  ].join('\n');
}
