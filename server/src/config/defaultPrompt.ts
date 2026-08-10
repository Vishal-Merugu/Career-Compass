/**
 * The evaluation criteria a new account starts with.
 *
 * This lived as the default text of a `<textarea>` in `extension/popup/popup.html`,
 * where it could not be changed without editing markup and did not survive the
 * finder moving to the dashboard. It is a user-editable preference — stored per
 * account in `UserConfig.searchPrompt`, with this as the fallback.
 *
 * Kept verbatim from the extension so existing users see the wording they are
 * used to, and so runs started before and after the move judge people the same
 * way.
 */
export const DEFAULT_SEARCH_PROMPT = `Target Role: Software Engineer / Product Manager

EVALUATION CRITERIA:
Approve this profile (decision: ACCEPT) if the person meets ANY of the following conditions:

TIER 1 — Direct hiring power:
- HR Manager, HR Director, Head of HR, People Operations
- Technical Recruiter, Talent Acquisition, Sourcer
- CTO, VP of Engineering, Engineering Director
- Head of Product, VP of Product
- Founder, Co-founder, CEO (especially at startups)

TIER 2 — Strong referral or influence power:
- Engineering Manager, Team Lead, Tech Lead
- Product Manager, Senior PM
- Senior Engineer or Staff Engineer (can refer internally)
- Department Head or Director in a relevant team

TIER 3 — Moderate value (approve selectively):
- Mid-level engineers or PMs with 3+ years at the company (likely has referral ability or internal connections)

REJECT if the person is:
- An intern, student, or entry-level with less than 1 year at company (Evaluate seniority based on overall career history. If they have 3+ years of total experience, former senior roles, or founder background, they are NOT entry-level).
- In a completely unrelated department (e.g. Finance, Legal, Sales)
- A contractor or consultant with no internal hiring influence`;
