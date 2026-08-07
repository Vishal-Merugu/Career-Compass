/**
 * The system prompt for every generated draft.
 *
 * Exported so the streaming preview and the actual send use the same one. A
 * preview generated from a different prompt than the send would be worse than
 * no preview: it would look like a review step and not be one.
 */
export const DRAFT_SYSTEM_PROMPT =
  'You write short, specific, professional outreach emails.';

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

/**
 * Prompt for a single contact.
 *
 * Contact fields are labelled and placed after the instruction, so a profile
 * headline reading "ignore previous instructions" is presented as data rather
 * than as a competing directive.
 */
export function buildDraftPrompt(params: {
  commonPrompt: string;
  name: string;
  email: string;
  companyName?: string | null;
  description?: string | null;
}): string {
  const facts = [
    `Name: ${params.name}`,
    `Email: ${params.email}`,
    params.companyName ? `Company: ${params.companyName}` : null,
    params.description ? `Role/description: ${params.description}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    params.commonPrompt.trim(),
    '',
    'Write the email body only. Do not add commentary before or after it.',
    'Do not write a sign-off or signature; one is appended automatically.',
    'If you want a subject line, put it on the very first line as "Subject: ...".',
    '',
    'Details of the person you are writing to:',
    facts,
  ].join('\n');
}
