import https from 'node:https';
import { logger } from '../lib/logger.js';
import { sendChatCompletion } from '../shared/llmClient.js';
import { withLlmFallback } from './llmRouter.service.js';
import { saveQualifiedJobToDb } from './jobStorage.service.js';

export interface LanguageRule {
  germanRequirement:
    'no_german' | 'german_optional' | 'german_required' | 'any';
  englishRequired: boolean;
  explanation: string;
}

export interface ParsedSearchCriteria {
  keywords: string;
  location: string;
  geoId?: string;
  targetCount: number;
  timeFilter: string; // e.g. 'r604800' (past week) or ''
  easyApplyOnly: boolean;
  languageRule: LanguageRule;
  mustHaveKeywords: string[];
  excludedKeywords: string[];
}

export interface JobEvaluationResult {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  postedDate: string;
  passed: boolean;
  fitScore: number;
  languageAssessment: string;
  reason: string;
  jdSnippet: string;
}

export interface EasyApplyRun {
  id: string;
  userId?: string;
  status: 'running' | 'completed' | 'paused' | 'error';
  prompt: string;
  targetCount: number;
  scannedCount: number;
  qualifiedCount: number;
  rejectedCount: number;
  criteria: ParsedSearchCriteria;
  jobs: JobEvaluationResult[];
  csvContent?: string;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

// In-memory active runs store
const activeRuns = new Map<string, EasyApplyRun>();

export function getRun(runId: string): EasyApplyRun | undefined {
  return activeRuns.get(runId);
}

export function getAllRuns(): EasyApplyRun[] {
  return Array.from(activeRuns.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

/**
 * Parses user freeform prompt into structured search criteria.
 * Uses LLM if available, falling back to robust heuristic pattern parsing.
 */
export async function parseCriteriaFromPrompt(
  prompt: string,
  userId?: string,
  countOverride?: number,
  easyApplyOverride?: boolean,
): Promise<ParsedSearchCriteria> {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  // 1. Extract target count
  let targetCount = countOverride && countOverride > 0 ? countOverride : 20;
  const countRegex =
    /(?:need|get|find|want|fetch|top|collect)?\s*(\d+)\s*(?:jobs|results|leads|positions|r\s*n|n)?/i;
  const countMatch = trimmed.match(countRegex);
  if (!countOverride && countMatch && countMatch[1]) {
    const parsed = parseInt(countMatch[1], 10);
    if (parsed > 0 && parsed <= 500) {
      targetCount = parsed;
    }
  }

  // 2. Extract Easy Apply preference (not forced unless requested)
  let easyApplyOnly = false;
  if (typeof easyApplyOverride === 'boolean') {
    easyApplyOnly = easyApplyOverride;
  } else if (
    lower.includes('easy apply') ||
    lower.includes('easy-apply') ||
    lower.includes('easyapply')
  ) {
    easyApplyOnly = true;
  }

  // 3. Extract language requirements
  let germanRequirement: LanguageRule['germanRequirement'] = 'any';
  let englishRequired = false;

  if (
    lower.includes('without german') ||
    lower.includes('no german') ||
    lower.includes('german not required') ||
    lower.includes('non-german') ||
    lower.includes('exclude german')
  ) {
    germanRequirement = 'no_german';
  } else if (
    lower.includes('german optional') ||
    lower.includes('german is optional') ||
    lower.includes('german is just optional') ||
    lower.includes('german is just opeiontal') ||
    lower.includes('german as a plus')
  ) {
    germanRequirement = 'german_optional';
  } else if (
    lower.includes('german required') ||
    lower.includes('with german') ||
    lower.includes('german speaking')
  ) {
    germanRequirement = 'german_required';
  }

  if (lower.includes('english') || lower.includes('international')) {
    englishRequired = true;
  }

  // 4. Extract location defaults
  let location = 'Germany';
  let geoId: string | undefined = undefined;

  if (lower.includes('berlin')) {
    location = 'Berlin, Germany';
  } else if (lower.includes('munich') || lower.includes('münchen')) {
    location = 'Munich, Germany';
  } else if (lower.includes('hamburg')) {
    location = 'Hamburg, Germany';
  } else if (lower.includes('frankfurt')) {
    location = 'Frankfurt, Germany';
  } else if (lower.includes('cologne') || lower.includes('köln')) {
    location = 'Cologne, Germany';
  } else if (lower.includes('remote')) {
    location = 'Remote';
  } else {
    // Check if user specified a location after "in", "near", or "at"
    const locMatch = trimmed.match(
      /\b(?:in|near|at|around)\s+([A-Za-z\u00C0-\u017F\s]+?)(?:,|\.|\bwithout\b|\bwith\b|\bfor\b|\bneed\b|\bcount\b|\bjobs\b|\bmatching\b|$)/i,
    );
    if (locMatch && locMatch[1]) {
      const candidateLoc = locMatch[1].trim();
      if (
        candidateLoc.length > 2 &&
        !/^(these|all|easy|german|english|my)$/i.test(candidateLoc)
      ) {
        location = candidateLoc;
      }
    }
  }

  // Only assign Germany geoId if the search is specifically for Germany as a whole
  if (location.toLowerCase() === 'germany') {
    geoId = '101282230';
  }

  // 5. Extract core keywords dynamically (supporting ANY job role)
  let keywords = '';
  const isWorkingStudent =
    lower.includes('working student') || lower.includes('werkstudent');

  if (lower.includes('react')) {
    keywords = isWorkingStudent ? 'working student React' : 'React developer';
  } else if (lower.includes('frontend') || lower.includes('front-end')) {
    keywords = isWorkingStudent
      ? 'working student Frontend'
      : 'Frontend developer';
  } else if (lower.includes('backend') || lower.includes('back-end')) {
    keywords = isWorkingStudent
      ? 'working student Backend'
      : 'Backend developer';
  } else if (lower.includes('software engineer')) {
    keywords = isWorkingStudent
      ? 'working student Software Engineer'
      : 'Software Engineer';
  } else if (lower.includes('python')) {
    keywords = isWorkingStudent ? 'working student Python' : 'Python developer';
  } else if (
    lower.includes('data engineer') ||
    lower.includes('data science')
  ) {
    keywords = isWorkingStudent ? 'working student Data' : 'Data Engineer';
  } else if (isWorkingStudent) {
    keywords = 'working student';
  } else {
    // Dynamic extraction: strip filler words to find the actual job query
    const cleaned = trimmed
      .replace(
        /\b(i need|i want|find|get|bring|all|easy apply|easy-apply|jobs|job|matching|these|criteria|in blah blah|text field|please|for me)\b/gi,
        '',
      )
      .replace(
        /\b(without german|german optional|german is optional|german is just optional|no german|german not required|english only|with german|german required)\b/gi,
        '',
      )
      .replace(/\b(?:in|near|at|around)\s+([A-Za-z\u00C0-\u017F\s]+)/gi, '')
      .replace(/\b\d+\s*(?:jobs|results|r\s*n|n)?\b/gi, '')
      .replace(/[,.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length >= 2) {
      keywords = cleaned;
    } else {
      keywords = 'Software Engineer';
    }
  }

  const defaultCriteria: ParsedSearchCriteria = {
    keywords,
    location,
    geoId,
    targetCount,
    timeFilter: 'r604800', // past week by default
    easyApplyOnly,
    languageRule: {
      germanRequirement,
      englishRequired,
      explanation:
        germanRequirement === 'no_german'
          ? 'Must not require German; English-only positions.'
          : germanRequirement === 'german_optional'
            ? 'German may be optional or a bonus, but not mandatory.'
            : 'Any language requirement accepted.',
    },
    mustHaveKeywords: [],
    excludedKeywords: [],
  };

  // If userId provided, try LLM enhancement
  if (userId) {
    try {
      const systemPrompt = `You are a job search assistant. Parse the user's freeform job search prompt into a JSON object matching this schema:
{
  "keywords": "string (job search query keywords)",
  "location": "string (city or country)",
  "targetCount": number (default 20 if not explicitly mentioned),
  "germanRequirement": "no_german" | "german_optional" | "german_required" | "any",
  "englishRequired": boolean,
  "mustHaveKeywords": string[],
  "excludedKeywords": string[]
}
Output valid JSON only.`;

      const parsedJson = await withLlmFallback(userId, async (target) => {
        const raw = await sendChatCompletion(
          target,
          systemPrompt,
          trimmed,
          300,
          0.1,
        );
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON returned from LLM');
        return JSON.parse(jsonMatch[0]);
      });

      if (parsedJson && parsedJson.keywords) {
        return {
          ...defaultCriteria,
          keywords: parsedJson.keywords || defaultCriteria.keywords,
          location: parsedJson.location || defaultCriteria.location,
          targetCount:
            countOverride && countOverride > 0
              ? countOverride
              : parsedJson.targetCount || targetCount,
          languageRule: {
            germanRequirement:
              parsedJson.germanRequirement || germanRequirement,
            englishRequired: Boolean(
              parsedJson.englishRequired || englishRequired,
            ),
            explanation: defaultCriteria.languageRule.explanation,
          },
          mustHaveKeywords: parsedJson.mustHaveKeywords || [],
          excludedKeywords: parsedJson.excludedKeywords || [],
        };
      }
    } catch (err: any) {
      logger.warn(
        `[EasyApplyFinder] LLM criteria parse failed (${err.message}). Using rule-based extraction.`,
      );
    }
  }

  return defaultCriteria;
}

/**
 * Low-level HTTP GET with standard browser headers
 */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
    };

    https
      .get(url, { headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          }
        });
      })
      .on('error', reject);
  });
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Searches LinkedIn for Easy Apply jobs.
 */
export async function searchEasyApplyJobs(
  criteria: ParsedSearchCriteria,
  start = 0,
): Promise<
  Array<{
    id: string;
    title: string;
    company: string;
    location: string;
    url: string;
    date: string;
  }>
> {
  const params = new URLSearchParams({
    keywords: criteria.keywords,
    start: String(start),
  });

  if (criteria.geoId) {
    params.append('geoId', criteria.geoId);
  } else if (criteria.location) {
    params.append('location', criteria.location);
  }

  if (criteria.timeFilter) {
    params.append('f_TPR', criteria.timeFilter);
  }

  if (criteria.easyApplyOnly) {
    params.append('f_AL', 'true');
  }

  const searchUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`;
  const html = await httpGet(searchUrl);

  const jobs: Array<{
    id: string;
    title: string;
    company: string;
    location: string;
    url: string;
    date: string;
  }> = [];
  const cardRegex =
    /<div class="[^"]*base-search-card[^"]*"[^>]*data-entity-urn="urn:li:jobPosting:(\d+)"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const id = match[1];
    const cardContent = match[2];

    const titleMatch =
      /<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/i.exec(
        cardContent,
      ) || /<span class="sr-only">([\s\S]*?)<\/span>/i.exec(cardContent);
    const title = titleMatch
      ? cleanHtml(titleMatch[1]).trim()
      : 'Unknown Title';

    const companyMatch =
      /<h4 class="base-search-card__subtitle">([\s\S]*?)<\/h4>/i.exec(
        cardContent,
      ) ||
      /<a[^>]*class="[^"]*hidden-nested-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
        cardContent,
      );
    const company = companyMatch
      ? cleanHtml(companyMatch[1]).trim()
      : 'Unknown Company';

    const locationMatch =
      /<span class="job-search-card__location">([\s\S]*?)<\/span>/i.exec(
        cardContent,
      );
    const location = locationMatch
      ? cleanHtml(locationMatch[1]).trim()
      : 'Unknown Location';

    const dateMatch =
      /<time class="job-search-card__listdate[^"]*"[^>]*>([\s\S]*?)<\/time>/i.exec(
        cardContent,
      );
    const date = dateMatch ? cleanHtml(dateMatch[1]).trim() : 'Recent';

    const linkMatch = /href="([^"]*linkedin\.com\/jobs\/view\/[^"]*)"/i.exec(
      cardContent,
    );
    const cleanUrl = linkMatch
      ? linkMatch[1].split('?')[0]
      : `https://www.linkedin.com/jobs/view/${id}`;

    jobs.push({ id, title, company, location, url: cleanUrl, date });
  }

  return jobs;
}

/**
 * Fetches full job description from LinkedIn with 429 backoff retry
 */
export async function fetchJobDescription(
  jobId: string,
  retries = 1,
): Promise<string> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  try {
    const html = await httpGet(url);

    const descMatch =
      /<div class="description__text[^"]*"[^>]*>([\s\S]*?)<\/section>/i.exec(
        html,
      ) ||
      /<div class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
        html,
      );

    if (descMatch) {
      return cleanHtml(descMatch[1]);
    }
    return cleanHtml(html).slice(0, 4000);
  } catch (err: any) {
    if (retries > 0 && err.message && err.message.includes('429')) {
      logger.warn(
        `[EasyApplyFinder] 429 rate limit fetching JD for ${jobId}. Backing off 2500ms...`,
      );
      await new Promise((r) => setTimeout(r, 2500));
      return fetchJobDescription(jobId, retries - 1);
    }
    throw err;
  }
}

/**
 * Evaluates the Job Description using the configured LLM (OpenAI, Gemini, Groq, Ollama, etc.)
 * with automatic fallback to structural rules if LLM is unreachable or unconfigured.
 */
export async function evaluateJobDescriptionWithLlm(
  jd: string,
  title: string,
  company: string,
  criteria: ParsedSearchCriteria,
  userId?: string,
): Promise<{
  passed: boolean;
  fitScore: number;
  languageAssessment: string;
  reason: string;
}> {
  if ((globalThis as Record<string, unknown>).MOCK_LLM) {
    return evaluateJobDescriptionRules(jd, title, company, criteria);
  }

  const systemPrompt = `You are an expert HR talent evaluator and recruiter analyzing job descriptions for candidates.
Your task is to inspect the Job Description and determine whether it matches the candidate's criteria, specifically regarding language requirements (German vs English) and role alignment.

CRITERIA:
- Target role / keywords: "${criteria.keywords}"
- German requirement rule: "${criteria.languageRule.germanRequirement}"
  * "no_german": The job MUST NOT require German. If fluent/mandatory German (B2, C1, C2, verhandlungssicher, fließend) is required, it must FAIL (passed: false). If German is only a bonus / optional / nice-to-have, or if the role is 100% English, it PASSES (passed: true).
  * "german_optional": The job can require English, or have German as optional/bonus, but MUST NOT require mandatory fluent German.
  * "german_required": The job MUST require German.
  * "any": Any language accepted.
- English required: ${criteria.languageRule.englishRequired}

EVALUATION RULES:
1. If the job description explicitly states "Deutschkenntnisse sind nicht erforderlich", "No German required", or "Working language is English", it PASSES for "no_german" and "german_optional".
2. If the entire text is written exclusively in German without mentioning an English working environment, infer that German is required.
3. If German is described as "von Vorteil", "plus", "bonus", or "optional", it PASSES for "german_optional" and "no_german".

Respond ONLY with valid JSON in the exact format below, nothing else:
{
  "passed": true or false,
  "fitScore": number between 0 and 100,
  "languageAssessment": "e.g. English Working Language | German is Optional / Bonus | Mandatory German Required | No German Needed",
  "reason": "Clear 1-sentence explanation of why it passed or failed."
}`;

  const userPrompt = `Job Title: ${title}
Company: ${company}
Job Description:
${jd.slice(0, 3500)}`;

  try {
    const activeUserId = userId || 'default';
    const result = await withLlmFallback(activeUserId, async (target) => {
      const raw = await sendChatCompletion(
        target,
        systemPrompt,
        userPrompt,
        400,
        0.1,
      );

      // Clean markdown code fence if returned
      const cleanJson = raw
        .replace(/^```json\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(cleanJson);

      return {
        passed: Boolean(parsed.passed),
        fitScore:
          typeof parsed.fitScore === 'number'
            ? parsed.fitScore
            : parsed.passed
              ? 85
              : 30,
        languageAssessment: String(
          parsed.languageAssessment ||
            (parsed.passed ? 'Matches Criteria' : 'Criteria Not Met'),
        ),
        reason: String(parsed.reason || ''),
      };
    });

    return result;
  } catch (err: any) {
    logger.warn(
      `[EasyApplyFinder] LLM evaluation unavailable (${err.message}). Falling back to heuristic rules.`,
    );
    return evaluateJobDescriptionRules(jd, title, company, criteria);
  }
}

/**
 * Fast structural & linguistic rule evaluation (used directly or as fallback).
 */
export function evaluateJobDescriptionRules(
  jd: string,
  title: string,
  company: string,
  criteria: ParsedSearchCriteria,
): {
  passed: boolean;
  fitScore: number;
  languageAssessment: string;
  reason: string;
} {
  // Edge case: unreadable or empty JD
  if (!jd || jd.trim().length < 50) {
    return {
      passed: false,
      fitScore: 0,
      languageAssessment: 'JD Unreadable',
      reason:
        'Job description text was too short or could not be retrieved from LinkedIn.',
    };
  }

  const lowerJd = jd.toLowerCase();
  const lowerTitle = title.toLowerCase();

  // Explicit negative patterns (e.g. "Deutschkenntnisse sind nicht erforderlich" / "German not required")
  const explicitNoGermanPatterns = [
    /deutsch.*(nicht\s+erforderlich|keine\s+voraussetzung|nicht\s+notwendig|nicht\s+zwingend|kein\s+muss)/i,
    /(no|not)\s+german\s+(required|needed|mandatory)/i,
    /german.*(is\s+)?not\s+(required|mandatory|needed)/i,
    /without\s+german/i,
  ];

  // Detect language clues in JD
  const germanMandatoryPatterns = [
    /deutsch.*(verhandlungssicher|flie(?:ss|ß)end|c1|c2|b2|muttersprache|erforderlich|voraussetzung|pflicht)/i,
    /(sehr gute|hervorragende|flie(?:ss|ß)ende)\s+deutschkenntnisse/i,
    /deutsch.*in wort und schrift/i,
    /fluent\s+german\s+(required|mandatory|essential|must)/i,
    /german.*(c1|c2|b2|native|bilingual|fluent)\s+(is\s+)?(required|mandatory)/i,
    /german.*fluency\s+required/i,
  ];

  const germanOptionalPatterns = [
    /german.*(plus|bonus|optional|advantage|nice to have|beneficial|asset)/i,
    /deutsch.*(von vorteil|ein plus|w\u00FCnschenswert|bonus)/i,
  ];

  const englishExplicitPatterns = [
    /fluent\s+in\s+english/i,
    /working\s+language\s+is\s+english/i,
    /english.*working\s+language/i,
    /excellent\s+english\s+skills/i,
    /corporate\s+language\s+is\s+english/i,
  ];

  let hasMandatoryGerman = germanMandatoryPatterns.some((pattern) =>
    pattern.test(jd),
  );
  const hasOptionalGerman = germanOptionalPatterns.some((pattern) =>
    pattern.test(jd),
  );
  const hasExplicitEnglish = englishExplicitPatterns.some((pattern) =>
    pattern.test(jd),
  );
  const hasExplicitNoGerman = explicitNoGermanPatterns.some((pattern) =>
    pattern.test(jd),
  );

  // If JD explicitly states German is not required, override any false positive mandatory pattern
  if (hasExplicitNoGerman) {
    hasMandatoryGerman = false;
  }

  // If the whole JD is predominantly in German (e.g. "Wir suchen", "Deine Aufgaben", "Über uns")
  const germanTextClues = [
    'wir suchen',
    'deine aufgaben',
    'das bringst du mit',
    'über uns',
    'was wir bieten',
    'bewerben sie sich',
  ];
  let germanClueCount = 0;
  for (const clue of germanTextClues) {
    if (lowerJd.includes(clue)) germanClueCount++;
  }
  const isPredominantlyGerman = germanClueCount >= 2;

  if (isPredominantlyGerman && !hasOptionalGerman && !hasExplicitNoGerman) {
    hasMandatoryGerman = true;
  }

  // If title is German (e.g. Werkstudent, Praktikant, Sachbearbeiter) without English subtitle
  if (lowerTitle.includes('werkstudent') && isPredominantlyGerman) {
    hasMandatoryGerman = true;
  }

  // Language Rule Evaluation
  let languagePassed = true;
  let languageAssessment = 'Language OK';
  let reason = '';

  if (
    criteria.languageRule.germanRequirement === 'no_german' ||
    criteria.languageRule.germanRequirement === 'german_optional'
  ) {
    if (hasMandatoryGerman) {
      languagePassed = false;
      languageAssessment = 'Mandatory German Required';
      reason = isPredominantlyGerman
        ? 'Job description is in German and requires German communication.'
        : 'JD explicitly states fluent/mandatory German is required.';
    } else if (hasOptionalGerman) {
      languagePassed = true;
      languageAssessment = 'German is Optional / Bonus';
      reason = 'German is listed as a plus or optional; English is accepted.';
    } else if (hasExplicitEnglish) {
      languagePassed = true;
      languageAssessment = 'English Working Language';
      reason = 'English is the stated working language; no German required.';
    } else {
      languagePassed = true;
      languageAssessment = 'No German requirement detected';
      reason = 'Job description does not require German.';
    }
  } else if (criteria.languageRule.germanRequirement === 'german_required') {
    if (!hasMandatoryGerman && !isPredominantlyGerman) {
      languagePassed = false;
      languageAssessment = 'German Not Required';
      reason = 'Role appears to be English-only without German focus.';
    } else {
      languagePassed = true;
      languageAssessment = 'German Required (Matches Criteria)';
      reason = 'Job requires German as requested.';
    }
  }

  // Keyword check
  let keywordPassed = true;
  if (criteria.mustHaveKeywords.length > 0) {
    const missing = criteria.mustHaveKeywords.filter(
      (kw) =>
        !lowerJd.includes(kw.toLowerCase()) &&
        !lowerTitle.includes(kw.toLowerCase()),
    );
    if (missing.length > 0) {
      keywordPassed = false;
      reason +=
        (reason ? ' ' : '') +
        `Missing required keywords: ${missing.join(', ')}.`;
    }
  }

  const passed = languagePassed && keywordPassed;
  const fitScore = passed ? (hasExplicitEnglish ? 95 : 85) : 30;

  return {
    passed,
    fitScore,
    languageAssessment,
    reason:
      reason ||
      (passed ? 'Role matches all criteria.' : 'Does not match criteria.'),
  };
}

/**
 * Standard evaluateJobDescription entrypoint (invokes LLM with fallback).
 */
export const evaluateJobDescription = evaluateJobDescriptionWithLlm;

/**
 * Runs the discovery loop until targetCount is met or results are exhausted.
 */
export async function runEasyApplyDiscovery(
  prompt: string,
  userId?: string,
  countOverride?: number,
  easyApplyOverride?: boolean,
  onProgress?: (run: EasyApplyRun) => void,
  waitForCompletion = false,
): Promise<EasyApplyRun> {
  const criteria = await parseCriteriaFromPrompt(
    prompt,
    userId,
    countOverride,
    easyApplyOverride,
  );
  const runId =
    'run_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  const run: EasyApplyRun = {
    id: runId,
    userId,
    status: 'running',
    prompt,
    targetCount: criteria.targetCount,
    scannedCount: 0,
    qualifiedCount: 0,
    rejectedCount: 0,
    criteria,
    jobs: [],
    createdAt: new Date(),
  };

  activeRuns.set(runId, run);
  if (onProgress) onProgress(run);

  // Background discovery execution
  const executePromise = (async () => {
    try {
      let start = 0;
      const seenJobIds = new Set<string>();
      let consecutiveEmptyPages = 0;

      while (
        run.qualifiedCount < criteria.targetCount &&
        consecutiveEmptyPages < 3 &&
        run.scannedCount < 300
      ) {
        logger.info(
          `[EasyApplyFinder] Fetching jobs batch at start=${start}...`,
        );
        const batch = await searchEasyApplyJobs(criteria, start);

        const newCards = batch.filter((c) => !seenJobIds.has(c.id));
        if (newCards.length === 0) {
          consecutiveEmptyPages++;
          start += batch.length || 10;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        consecutiveEmptyPages = 0;

        for (const card of newCards) {
          seenJobIds.add(card.id);
          run.scannedCount++;

          try {
            // Respectful jitter delay to prevent rate limits
            await new Promise((r) => setTimeout(r, 600 + Math.random() * 400));
            const jd = await fetchJobDescription(card.id);

            const evaluation = await evaluateJobDescription(
              jd,
              card.title,
              card.company,
              criteria,
              userId,
            );

            const result: JobEvaluationResult = {
              jobId: card.id,
              title: card.title,
              company: card.company,
              location: card.location,
              url: card.url,
              postedDate: card.date,
              passed: evaluation.passed,
              fitScore: evaluation.fitScore,
              languageAssessment: evaluation.languageAssessment,
              reason: evaluation.reason,
              jdSnippet: jd.slice(0, 400),
            };

            run.jobs.push(result);

            if (evaluation.passed) {
              run.qualifiedCount++;
              try {
                await saveQualifiedJobToDb(result, prompt, userId);
              } catch (dbErr: any) {
                logger.warn(
                  `[EasyApplyFinder] DB save notice: ${dbErr.message}`,
                );
              }
            } else {
              run.rejectedCount++;
            }

            if (onProgress) onProgress(run);

            if (run.qualifiedCount >= criteria.targetCount) {
              break;
            }
          } catch (itemErr: any) {
            logger.warn(
              `[EasyApplyFinder] Error evaluating job ${card.id}: ${itemErr.message}`,
            );
            if (itemErr.message && itemErr.message.includes('429')) {
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
        }

        start += batch.length;
      }

      run.status = 'completed';
      run.completedAt = new Date();
      run.csvContent = generateJobsCsv(run.jobs.filter((j) => j.passed));
      if (onProgress) onProgress(run);
    } catch (err: any) {
      logger.error(`[EasyApplyFinder] Run failed: ${err.message}`);
      run.status = 'error';
      run.errorMessage = err.message;
      if (onProgress) onProgress(run);
    }
  })();

  if (waitForCompletion) {
    await executePromise;
  }

  return run;
}

/**
 * Formats qualified jobs into RFC-4180 compliant CSV format.
 */
export function generateJobsCsv(jobs: JobEvaluationResult[]): string {
  const headers = [
    'Job Title',
    'Company Name',
    'Location',
    'LinkedIn Job URL',
    'Match Status',
    'Language Fit',
    'AI Reason',
    'Date Posted',
  ];

  const escapeCsv = (val: string) => {
    if (!val) return '""';
    const clean = String(val)
      .replace(/[\r\n]+/g, ' ')
      .replace(/"/g, '""')
      .trim();
    return `"${clean}"`;
  };

  const rows = jobs.map((j) => [
    escapeCsv(j.title),
    escapeCsv(j.company),
    escapeCsv(j.location),
    escapeCsv(j.url),
    escapeCsv(j.passed ? 'PASSED' : 'REJECTED'),
    escapeCsv(j.languageAssessment),
    escapeCsv(j.reason),
    escapeCsv(j.postedDate),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}
