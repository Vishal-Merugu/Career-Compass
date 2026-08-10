import { IUserConfig } from './types.js';
import { IParsedProfile } from './parsers.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { LlmError } from '../errors/AppError.js';
import type { JobErrorCode } from '../errors/jobErrors.js';

/**
 * `server` — the instance's built-in model, and the default for new accounts.
 *
 * The operator knows an address that works and a model that is installed; the
 * user does not. The old default was a bare `http://localhost:11434` in the
 * schema, which inside the container is the container — so every fresh account
 * pointed at nothing and every profile it evaluated failed. See
 * `DEFAULT_LLM_URL` in config/env.ts.
 */
export const SERVER_PROVIDER = 'server';

export function normalizeProvider(config: IUserConfig): string {
  return (config.llmProvider || SERVER_PROVIDER).toLowerCase();
}

/** Ollama's native `/api/chat`, as opposed to the OpenAI-compatible shape. */
export function usesOllamaDialect(provider: string): boolean {
  return provider === 'ollama' || provider === SERVER_PROVIDER;
}

/**
 * Which model to ask for.
 *
 * Never falls back to a hardcoded name for a hosted provider — a wrong model
 * id is a 404 the user cannot explain. For the built-in provider the operator's
 * `DEFAULT_LLM_MODEL` is authoritative and the user's field is ignored.
 */
export function resolveModel(config: IUserConfig): string {
  const provider = normalizeProvider(config);
  if (provider === SERVER_PROVIDER) return env.DEFAULT_LLM_MODEL;
  return config.llmModel || '';
}

/**
 * Get Base URL based on provider
 */
export function getBaseUrl(config: IUserConfig): string {
  const provider = normalizeProvider(config);
  const llmUrl = config.llmUrl || '';

  const stripSlash = (url: string) =>
    url.endsWith('/') ? url.slice(0, -1) : url;

  switch (provider) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case SERVER_PROVIDER:
      return stripSlash(env.DEFAULT_LLM_URL);
    case 'ollama':
    default:
      // No `localhost` fallback. An empty URL is a configuration mistake worth
      // surfacing, not one to paper over with an address that is wrong in every
      // containerised deployment.
      return stripSlash(llmUrl);
  }
}

/**
 * Get Auth Headers based on provider
 */
export function getHeaders(config: IUserConfig): Record<string, string> {
  const provider = normalizeProvider(config);
  const llmApiKey = config.llmApiKey || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (provider === 'gemini' || provider === 'openrouter') {
    if (llmApiKey) {
      headers['Authorization'] = `Bearer ${llmApiKey}`;
    }
  }

  // OpenRouter requires these for ranking
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] =
      'https://github.com/vshalsingh/linkedin-automationV2';
    headers['X-Title'] = 'CareerCompass';
  }

  return headers;
}

/** What to call the provider when talking to the user. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case 'gemini':
      return 'Gemini';
    case 'openrouter':
      return 'OpenRouter';
    case 'ollama':
      return 'Ollama';
    case SERVER_PROVIDER:
      return 'The built-in model';
    default:
      return provider;
  }
}

/**
 * A failure that never reached the provider — DNS, refused connection,
 * unroutable host, timeout.
 *
 * This is the one that produced `LLM Error: fetch failed` 368 times: Node's
 * `fetch` reports every transport problem with that same opaque string, so the
 * cause has to be dug out of `err.cause`.
 */
export function classifyTransportFailure(
  err: unknown,
  ctx: { provider: string; model: string; url: string },
): LlmError {
  const error = err as { message?: string; name?: string; cause?: unknown };
  const cause = error?.cause as { code?: string; message?: string } | undefined;
  const detailParts = [error?.message, cause?.code, cause?.message].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  const detail = `${detailParts.join(' — ')} (tried ${ctx.url})`;

  return new LlmError('LLM_UNREACHABLE', 'The AI model could not be reached.', {
    detail,
    model: ctx.model,
    provider: providerLabel(ctx.provider),
  });
}

/** A response that arrived and said no. */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
  headers: Headers | null,
  ctx: { provider: string; model: string; url: string },
): LlmError {
  const body = bodyText.slice(0, 400);
  const lower = body.toLowerCase();
  const label = providerLabel(ctx.provider);
  const mentionsQuota = /quota|credit|billing|payment|insufficient/.test(lower);
  const mentionsModel = /model/.test(lower);

  const retryAfterRaw = headers?.get('retry-after');
  const retryAfterSeconds = retryAfterRaw
    ? Number.parseInt(retryAfterRaw, 10)
    : undefined;

  let code: JobErrorCode = 'UNKNOWN';
  let message = `${label} returned an unexpected error (HTTP ${status}).`;

  if (status === 401 || status === 403) {
    code = 'LLM_AUTH';
    message = `${label} rejected the API key.`;
  } else if (status === 402 || (status === 429 && mentionsQuota)) {
    code = 'LLM_QUOTA';
    message = `The ${label} quota or credit is exhausted.`;
  } else if (status === 429) {
    code = 'LLM_RATE_LIMIT';
    message = `${label} is rate-limiting these requests.`;
  } else if ((status === 404 || status === 400) && mentionsModel) {
    // Ollama answers a missing model with 404 `model "x" not found`; the
    // OpenAI-compatible providers use 400 or 404 with the model named in the
    // body. A 404 that does *not* mention a model is a wrong base URL.
    code = 'LLM_MODEL_NOT_FOUND';
    message = ctx.model
      ? `The AI model "${ctx.model}" is not installed.`
      : 'The configured AI model is not installed.';
  } else if (status === 404) {
    code = 'LLM_UNREACHABLE';
    message = 'The AI model could not be reached.';
  }

  return new LlmError(code, message, {
    detail: `HTTP ${status} from ${ctx.url}: ${body}`,
    model: ctx.model,
    provider: label,
    retryAfterSeconds:
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds
        ? retryAfterSeconds
        : undefined,
  });
}

export interface ILlmHealthResponse {
  ok: boolean;
  models?: string[];
  error?: string;
  code?: JobErrorCode;
  /** What the check actually contacted, so a wrong address is visible. */
  url?: string;
  /** The model the config resolves to, whether or not it is in `models`. */
  model?: string;
}

/**
 * Health check — fetch the provider's model list.
 *
 * **Runs on the server.** The equivalent button in the extension ran this in
 * the extension's own service worker, which reaches the user's laptop, not the
 * host that makes the real calls — so it could report a healthy model while the
 * server could not resolve the address at all. That is exactly what happened on
 * the VM.
 */
export async function llmHealthCheck(
  config: IUserConfig,
): Promise<ILlmHealthResponse> {
  const provider = normalizeProvider(config);
  const baseUrl = getBaseUrl(config);
  const headers = getHeaders(config);
  const model = resolveModel(config);

  if (!baseUrl) {
    return {
      ok: false,
      code: 'LLM_UNREACHABLE',
      error: 'No base URL is configured for this provider.',
      model,
    };
  }

  const modelsUrl = usesOllamaDialect(provider)
    ? `${baseUrl}/api/tags`
    : `${baseUrl}/models`;

  try {
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const failure = classifyHttpFailure(res.status, body, res.headers, {
        provider,
        model,
        url: modelsUrl,
      });
      return {
        ok: false,
        code: failure.code,
        error: failure.message,
        url: modelsUrl,
        model,
      };
    }

    const data = (await res.json()) as {
      models?: Array<{ name?: string }>;
      data?: Array<{ id?: string }>;
    };

    let models: string[] = [];
    if (usesOllamaDialect(provider) && Array.isArray(data.models)) {
      models = data.models
        .map((m) => m.name)
        .filter((name): name is string => Boolean(name));
    } else if (Array.isArray(data.data)) {
      models = data.data
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id));
    }

    return { ok: true, models, url: modelsUrl, model };
  } catch (err) {
    const failure = classifyTransportFailure(err, {
      provider,
      model,
      url: modelsUrl,
    });
    return {
      ok: false,
      code: failure.code,
      error: failure.detail ?? failure.message,
      url: modelsUrl,
      model,
    };
  }
}

/**
 * Universal Chat Completion Wrapper
 * Automatically switches between Native Ollama and OpenAI schemas.
 */
export async function sendChatCompletion(
  config: IUserConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const provider = normalizeProvider(config);
  const baseUrl = getBaseUrl(config);
  const headers = getHeaders(config);
  const model = resolveModel(config);

  if (!baseUrl) {
    throw new LlmError(
      'LLM_UNREACHABLE',
      'The AI model could not be reached.',
      {
        detail: `No base URL is configured for provider "${provider}".`,
        provider: providerLabel(provider),
        model,
      },
    );
  }

  let endpoint = '';
  let body = '';

  if (usesOllamaDialect(provider)) {
    endpoint = `${baseUrl}/api/chat`;
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        num_predict: maxTokens,
        temperature: temperature,
      },
    });
  } else {
    endpoint = `${baseUrl}/chat/completions`;
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: temperature,
      stream: false,
    });
  }

  const ctx = { provider, model, url: endpoint };

  // Retries are for a slow model, not a wrong address. A refused connection or
  // a rejected key fails identically on every attempt, so retrying it three
  // times only delays the message the user needs by three times as long.
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res: Response;

    try {
      if (attempt > 1) {
        logger.info(
          `[LLM] sendChatCompletion retry attempt ${attempt - 1}/3...`,
        );
        await new Promise((r) => setTimeout(r, 1000));
      }

      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        // No timeout: a large local model can legitimately think for minutes.
      });
    } catch (err) {
      const error = err as { name?: string; message?: string };
      const isTimeout =
        error.name === 'AbortError' ||
        (error.message ?? '').toLowerCase().includes('timeout') ||
        (error.message ?? '').toLowerCase().includes('timed out');

      if (isTimeout && attempt < 4) {
        logger.warn(
          `[LLM] sendChatCompletion timeout on attempt ${attempt}/4. Retrying...`,
        );
        continue;
      }

      throw classifyTransportFailure(err, ctx);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyHttpFailure(res.status, text, res.headers, ctx);
    }

    const data = (await res.json()) as {
      message?: { content?: string };
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = usesOllamaDialect(provider)
      ? (data.message?.content?.trim() ?? '')
      : (data.choices?.[0]?.message?.content?.trim() ?? '');

    return content;
  }

  // Every attempt timed out.
  throw new LlmError('LLM_UNREACHABLE', 'The AI model could not be reached.', {
    detail: `No response from ${endpoint} after 4 attempts.`,
    provider: providerLabel(provider),
    model,
  });
}

export interface IConnectionMessageResult {
  ok: boolean;
  message?: string;
  error?: string;
}

/**
 * Generate a personalized connection message
 */
export async function generateConnectionMessage(
  profileData: IParsedProfile,
  companyName: string,
  userContext: string | null,
  config: IUserConfig,
): Promise<IConnectionMessageResult> {
  const LINKEDIN_MAX_CHARS = 200;
  const MAX_ATTEMPTS = 3;

  function sanitizeMessage(raw: string): string {
    return raw
      .replace(/\\n/g, ' ')
      .replace(/\r?\n/g, ' ')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/^["']+|["']+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  const systemPrompt = `You are a professional networking assistant. Generate a SHORT, personalized LinkedIn connection request message.

RULES:
- HARD LIMIT: The message MUST be under ${LINKEDIN_MAX_CHARS} characters (including spaces). This is a strict technical limit — messages over ${LINKEDIN_MAX_CHARS} characters will be REJECTED by LinkedIn's API.
- TARGET LENGTH: 120-180 characters (including spaces).
- Write the ENTIRE message as a SINGLE paragraph. Do NOT use line breaks, newlines, or "Best regards" sign-offs.
- Be genuine and specific — reference the person's role, company, or background.
- Mention you're looking for working student / internship opportunities.
- Be warm but professional.
- Do NOT use emojis.
- Do NOT use generic phrases like "I'd love to connect".
- Output ONLY the message text, nothing else. No quotes, no newlines.`;

  const userPrompt = `Write a connection message for this person:
Name: ${profileData.firstName} ${profileData.lastName}
Title: ${profileData.headline}
Company: ${companyName}
${profileData.about ? `About: ${profileData.about.slice(0, 300)}` : ''}
${profileData.experiences?.length ? `Current Role: ${profileData.experiences[0]?.title} at ${profileData.experiences[0]?.companyName}` : ''}

${userContext ? `About me (the sender): ${userContext}` : ''}`;

  try {
    let message = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const temperature = attempt === 1 ? 0.7 : attempt === 2 ? 0.5 : 0.3;

      let promptToUse = systemPrompt;
      if (attempt > 1) {
        promptToUse += `\n\nWARNING: Your previous attempt was ${message.length} characters which EXCEEDS the ${LINKEDIN_MAX_CHARS} character limit. You MUST write a SHORTER message this time. Aim for 150 characters. NO line breaks.`;
      }

      const raw = await sendChatCompletion(
        config,
        promptToUse,
        userPrompt,
        300,
        temperature,
      );
      message = sanitizeMessage(raw);

      logger.info(
        `[LLM] Attempt ${attempt}: message length = ${message.length} chars`,
      );

      if (message.length <= LINKEDIN_MAX_CHARS) {
        logger.info(
          `[LLM] ✅ Connection message generated (${message.length} chars, attempt ${attempt})`,
        );
        return { ok: true, message };
      }

      logger.warn(
        `[LLM] ⚠️ Message too long (${message.length} chars), attempt ${attempt}/${MAX_ATTEMPTS}`,
      );
    }

    if (message.length > LINKEDIN_MAX_CHARS) {
      const truncated = message.slice(0, LINKEDIN_MAX_CHARS);
      const lastSentenceEnd = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('!'),
        truncated.lastIndexOf('?'),
      );
      message =
        lastSentenceEnd > 100
          ? truncated.slice(0, lastSentenceEnd + 1)
          : truncated.slice(0, LINKEDIN_MAX_CHARS - 3) + '...';
      logger.warn(
        `[LLM] ⚠️ Hard-truncated message to ${message.length} chars after ${MAX_ATTEMPTS} failed attempts`,
      );
    }

    return { ok: true, message };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * A verdict from the model, and nothing else.
 *
 * **There is deliberately no `ok` field.** There used to be, and it is what let
 * 368 profiles be rejected by a model that was never contacted: on any failure
 * this returned `{ ok: false, match: false, reason: 'LLM Error: …' }`, the
 * caller read `.match`, and an unreachable host became indistinguishable from
 * an unsuitable candidate. Failure is now a thrown `LlmError` — a shape that
 * cannot be mistaken for a verdict.
 */
export interface IEvaluateProfileResult {
  match: boolean;
  reason: string;
}

/**
 * Evaluate if a profile matches a given prompt.
 *
 * @throws {LlmError} if the model could not be reached, refused, or answered
 * with something that is not the requested JSON.
 */
export async function evaluateProfile(
  profileData: IParsedProfile,
  prompt: string,
  config: IUserConfig,
  targetCompanyName = '',
): Promise<IEvaluateProfileResult> {
  if ((globalThis as Record<string, unknown>).MOCK_LLM) {
    return { match: true, reason: 'Mocked profile evaluation' };
  }

  const systemPrompt = `You are a professional job search assistant evaluating LinkedIn profiles to find high-value connections.
Your task is to decide whether a person is a good target for professional outreach at a target company based on their profile data and the evaluation criteria.

CRITICAL EVALUATION RULES:
1. **Headline Priority**: A person's Headline is often the most up-to-date representation of their current role and seniority.
2. **Career-Wide Seniority**: Evaluate seniority based on their ENTIRE career history, not just their tenure at the current company.
3. **Flexibility**: Be EXTREMELY flexible with company name variations (e.g., "Yendou" is the same as "itsyendou", "Google" is the same as "Google LLC").
4. **Err on the Side of Approval**: Err on the side of approval (match: true) if a candidate is close to a tier threshold or possesses significant career depth.

Respond ONLY with valid JSON in the exact format below, nothing else. Do not use markdown blocks.
Format: {"match": true/false, "reason": "a very brief 1-sentence explanation mentioning their Tier and why they were accepted/rejected"}`;

  const targetCompany =
    targetCompanyName ||
    profileData.experiences?.[0]?.companyName ||
    'the target company';

  const experiences =
    profileData.experiences
      ?.map((e) => {
        const startYear = e.timePeriod?.startDate?.year || '';
        const startMonth = e.timePeriod?.startDate?.month || '';
        const endYear = e.timePeriod?.endDate?.year || '';
        const endMonth = e.timePeriod?.endDate?.month || '';

        let dateStr = '';
        if (startYear) {
          const start = startMonth
            ? `${startMonth}/${startYear}`
            : `${startYear}`;
          const end = endYear
            ? endMonth
              ? `${endMonth}/${endYear}`
              : `${endYear}`
            : 'Present';
          dateStr = ` [${start} - ${end}]`;
        }
        return `- ${e.title} at ${e.companyName}${dateStr}${e.description ? `\n  Description: ${e.description}` : ''}`;
      })
      .join('\n') || 'None';

  const skills = profileData.skills?.slice(0, 10).join(', ') || 'None';

  const candidateProfileString = `Name: ${profileData.firstName} ${profileData.lastName}
Headline: ${profileData.headline}
Experiences (History & Duration):
${experiences}
Skills: ${skills}
About: ${profileData.about || 'None'}`;

  const userPrompt = `You are evaluating a LinkedIn profile on behalf of a job seeker conducting a targeted outreach campaign.

Target company: ${targetCompany}
Today's date: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}

---

PROFILE DATA:
${candidateProfileString}

---

EVALUATION CRITERIA:
${prompt}

---

INSTRUCTIONS:
1. Determine if they are currently at ${targetCompany} or closely associated.
2. Assign a TIER (1, 2, 3, or NONE) based on their role, seniority, and overall career history.
3. Return a JSON response in the exact format: {"match": true/false, "reason": "a very brief 1-sentence explanation mentioning their Tier and why they were accepted/rejected"}`;

  // Not wrapped in a try/catch. An `LlmError` from `sendChatCompletion` must
  // reach `qualificationWorker`, which is the only layer that knows whether to
  // pause the run — swallowing it here is what made the failure invisible.
  const raw = await sendChatCompletion(
    config,
    systemPrompt,
    userPrompt,
    10000,
    0.1,
  );

  const content = raw
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  let parsed: { match?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(content) as { match?: unknown; reason?: unknown };
  } catch {
    logger.error(
      `[LLM] JSON parse failed. Raw LLM output: ${raw.slice(0, 500)}`,
    );
    throw new LlmError(
      'LLM_BAD_JSON',
      'The AI model returned something unreadable.',
      {
        detail: `Expected JSON, got: ${raw.slice(0, 300)}`,
        provider: providerLabel(normalizeProvider(config)),
        model: resolveModel(config),
      },
    );
  }

  return {
    match: Boolean(parsed.match),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}
