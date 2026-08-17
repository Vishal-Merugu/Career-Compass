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

/** Every provider a credential may name. `custom` is "any OpenAI-compatible host". */
export const LLM_PROVIDERS = [
  SERVER_PROVIDER,
  'ollama',
  'gemini',
  'openrouter',
  'groq',
  'custom',
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * One model, resolved and ready to call.
 *
 * The unit the transport works in. It exists because a *user* is no longer one
 * model: `llmRouter` turns an account into an ordered list of these and walks
 * it until one answers. Everything below this line is deliberately ignorant of
 * that — a target does not know its position in a chain, and the transport
 * cannot fall back on its own.
 */
export interface LlmTarget {
  /** `LlmCredential.id`, or null for the legacy `UserConfig` single provider. */
  credentialId: string | null;
  /** The user's own name for it, for logs and the run event log. */
  label: string;
  provider: string;
  apiKey: string | null;
  /** Only consulted for `ollama` and `custom`; hosted providers are hardcoded. */
  url: string;
  model: string;
}

/**
 * Accepted anywhere a target is: the legacy config shape converts on the way in.
 *
 * Keeping `IUserConfig` callable is what let this change land without touching
 * `jobPreflight`, `draftStream` or `jobRunner` — they each derive a url, headers
 * and a model from a config and were correct before the chain existed.
 */
export type LlmSource = LlmTarget | IUserConfig;

export function targetFromConfig(config: IUserConfig): LlmTarget {
  const provider = (config.llmProvider || SERVER_PROVIDER).toLowerCase();
  return {
    credentialId: null,
    label: providerLabel(provider),
    provider,
    apiKey: config.llmApiKey ?? null,
    url: config.llmUrl || '',
    model: config.llmModel || '',
  };
}

export function asTarget(source: LlmSource): LlmTarget {
  return 'llmProvider' in source ? targetFromConfig(source) : source;
}

export function normalizeProvider(source: LlmSource): string {
  return asTarget(source).provider.toLowerCase();
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
export function resolveModel(source: LlmSource): string {
  const target = asTarget(source);
  if (normalizeProvider(target) === SERVER_PROVIDER) {
    return env.DEFAULT_LLM_MODEL;
  }
  return target.model || '';
}

/**
 * Get Base URL based on provider
 */
export function getBaseUrl(source: LlmSource): string {
  const target = asTarget(source);
  const provider = normalizeProvider(target);

  const stripSlash = (url: string) =>
    url.endsWith('/') ? url.slice(0, -1) : url;

  switch (provider) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case SERVER_PROVIDER:
      return stripSlash(env.DEFAULT_LLM_URL);
    case 'ollama':
    case 'custom':
    default:
      // No `localhost` fallback. An empty URL is a configuration mistake worth
      // surfacing, not one to paper over with an address that is wrong in every
      // containerised deployment.
      //
      // `custom` is where a Cloudflare Workers AI account URL goes
      // (`…/accounts/<id>/ai/v1`) — account-scoped, so it cannot be hardcoded.
      return stripSlash(target.url || '');
  }
}

/**
 * Get Auth Headers based on provider
 */
export function getHeaders(source: LlmSource): Record<string, string> {
  const target = asTarget(source);
  const provider = normalizeProvider(target);
  const apiKey = target.apiKey || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Bearer for every hosted provider rather than a per-provider allowlist: each
  // new free tier added to `LLM_PROVIDERS` is otherwise one forgotten `case`
  // away from silently sending an unauthenticated request and reading the 401
  // as a bad key. Ollama's dialect takes no key at all.
  if (apiKey && !usesOllamaDialect(provider)) {
    headers['Authorization'] = `Bearer ${apiKey}`;
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
    case 'groq':
      return 'Groq';
    case 'ollama':
      return 'Ollama';
    case 'custom':
      return 'Custom endpoint';
    case SERVER_PROVIDER:
      return 'The built-in model';
    default:
      return provider;
  }
}

/**
 * What to call the thing that failed.
 *
 * A credential's own label wins over the provider's generic name: with two
 * Gemini keys in the chain, "Gemini rejected the API key" does not say which
 * one to go and fix.
 */
export interface LlmFailureContext {
  provider: string;
  model: string;
  url: string;
  /** `LlmTarget.label`, when the call came through the router. */
  label?: string;
}

function failureLabel(ctx: LlmFailureContext): string {
  return ctx.label || providerLabel(ctx.provider);
}

export function classifyTransportFailure(
  err: unknown,
  ctx: LlmFailureContext,
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
    provider: failureLabel(ctx),
  });
}

/** A response that arrived and said no. */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
  headers: Headers | null,
  ctx: LlmFailureContext,
): LlmError {
  const body = bodyText.slice(0, 400);
  const lower = body.toLowerCase();
  const label = failureLabel(ctx);
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
/**
 * Prove the model works by asking it for one token.
 *
 * The fallback for hosts with no `/models`. It costs a request against the
 * user's quota, which is why it is not the primary check — but it runs only on
 * an explicit Test or a preflight, and "it answered" is strictly better
 * evidence than "it has a listing endpoint".
 *
 * Returns no model list, because there is none to read. `checkAiModel` only
 * enforces the installed-model check for Ollama's dialect anyway.
 */
async function probeByAnswering(
  target: LlmTarget,
  ctx: { provider: string; model: string; url: string },
): Promise<ILlmHealthResponse> {
  try {
    // An empty completion is still a completion: the request was accepted,
    // authenticated and routed to the model, which is the whole question here.
    await sendChatCompletion(target, 'ping', 'ping', 1, 0);
    return { ok: true, models: [], url: ctx.url, model: ctx.model };
  } catch (err) {
    if (err instanceof LlmError) {
      return {
        ok: false,
        code: err.code,
        error: err.detail ?? err.message,
        url: ctx.url,
        model: ctx.model,
      };
    }
    const failure = classifyTransportFailure(err, ctx);
    return {
      ok: false,
      code: failure.code,
      error: failure.detail ?? failure.message,
      url: ctx.url,
      model: ctx.model,
    };
  }
}

export async function llmHealthCheck(
  source: LlmSource,
): Promise<ILlmHealthResponse> {
  const target = asTarget(source);
  const provider = normalizeProvider(target);
  const baseUrl = getBaseUrl(target);
  const headers = getHeaders(target);
  const model = resolveModel(target);
  const label = target.label;

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
      // A listing endpoint is optional; answering is not.
      //
      // `/models` is a convention, not a requirement of the OpenAI-compatible
      // shape, and several hosts worth using here do not serve it —
      // Cloudflare Workers AI's account-scoped `/ai/v1` and most self-hosted
      // gateways among them. Reporting those as unreachable would park a
      // perfectly good key on a 404 from a URL the run never calls.
      if (res.status === 404 || res.status === 405) {
        return probeByAnswering(target, { provider, model, url: modelsUrl });
      }

      const body = await res.text().catch(() => '');
      const failure = classifyHttpFailure(res.status, body, res.headers, {
        provider,
        model,
        url: modelsUrl,
        label,
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
      label,
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
  source: LlmSource,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const target = asTarget(source);
  const provider = normalizeProvider(target);
  const baseUrl = getBaseUrl(target);
  const headers = getHeaders(target);
  const model = resolveModel(target);

  if (!baseUrl) {
    throw new LlmError(
      'LLM_UNREACHABLE',
      'The AI model could not be reached.',
      {
        detail: `No base URL is configured for provider "${provider}".`,
        provider: target.label || providerLabel(provider),
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

  const ctx: LlmFailureContext = {
    provider,
    model,
    url: endpoint,
    label: target.label,
  };

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
    provider: failureLabel(ctx),
    model,
  });
}

export interface IConnectionMessageResult {
  ok: boolean;
  message?: string;
  error?: string;
}

/**
 * Generate a personalized connection message.
 *
 * @throws {LlmError} if the model could not be reached or refused.
 *
 * It used to catch everything and return `{ ok: false, error }`, which is the
 * same shape that turned 368 unreachable-model failures into rejections in
 * `evaluateProfile`. Here it cost less — the caller returned a 502 — but it
 * also made the note un-routable: `withLlmFallback` decides whether to try the
 * next key from the `LlmError`'s code, and a swallowed error carries none, so
 * a rate-limited first key would have ended the request instead of moving on.
 */
export async function generateConnectionMessage(
  profileData: IParsedProfile,
  companyName: string,
  userContext: string | null,
  config: LlmSource,
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

  {
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
  }
}

/**
 * Pull the verdict object out of whatever the model actually said.
 *
 * Every provider in the chain serves the same wire format, but the *models* do
 * not write the same way, and the free ones are the worst offenders — they are
 * also the ones this account will mostly be running on. Three habits break a
 * bare `JSON.parse`:
 *
 *   - fenced output — ```json { … } ```
 *   - a reasoning preamble — `<think>…</think>` before the answer, which every
 *     R1-style distill on OpenRouter and Groq emits
 *   - a polite sentence first — "Sure! Here's the evaluation: { … }"
 *
 * None of these mean the model got the answer wrong, so failing on them throws
 * away a good verdict and burns the next key in the chain to re-earn it.
 *
 * Returns null when there is genuinely no object in there — the caller turns
 * that into `LLM_BAD_JSON`, which is still a fallback and never a rejection.
 */
export function extractJsonObject(
  raw: string,
): { match?: unknown; reason?: unknown } | null {
  const cleaned = raw
    // Non-greedy, and only matched pairs: an unclosed `<think>` means the model
    // ran out of tokens mid-thought and there is no verdict to recover.
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  /**
   * A candidate is a verdict only if it actually carries `match`.
   *
   * Without this guard the extractor is dangerous rather than helpful: any
   * stray object would be accepted, `parsed.match` would be `undefined`, and
   * `Boolean(undefined)` is `false` — a silent rejection attributed to the
   * candidate. That is precisely the class of bug that recorded 368 people as
   * "not a good fit" on 2026-08-09, and it must not come back through the
   * parser instead of through the transport.
   */
  const attempt = (
    text: string,
  ): { match?: unknown; reason?: unknown } | null => {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'object' || value === null) return null;

      // A one-element array wrapping the verdict is a common formatting quirk,
      // so unwrap it rather than discarding a correct answer.
      const candidate: unknown = Array.isArray(value) ? value[0] : value;
      if (typeof candidate !== 'object' || candidate === null) return null;
      if (!('match' in candidate)) return null;

      return candidate as { match?: unknown; reason?: unknown };
    } catch {
      return null;
    }
  };

  const direct = attempt(cleaned);
  if (direct) return direct;

  /** End index of the balanced `{…}` opening at `from`, or -1. */
  const balancedEnd = (text: string, from: number): number => {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = from; i < text.length; i++) {
      const char = text[i]!;

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return i;
    }

    return -1;
  };

  // **Every** object in the text, in order — not just the first. A model that
  // restates the requested format before answering ("Format: {"match":
  // true/false, …} … {"match": true, "reason": "Tier 1"}") puts an unparseable
  // object first, and stopping there would throw away the real verdict sitting
  // right behind it. String state is tracked so a brace inside `reason` does
  // not end the object early.
  for (
    let start = cleaned.indexOf('{');
    start !== -1;
    start = cleaned.indexOf('{', start + 1)
  ) {
    const end = balancedEnd(cleaned, start);
    if (end === -1) continue;

    const candidate = attempt(cleaned.slice(start, end + 1));
    if (candidate) return candidate;
  }

  return null;
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
  config: LlmSource,
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
4. **Students are not their job titles**: An education entry whose end year is in the future, or a position marked Internship / Work Study / Working Student / Werkstudent / Apprenticeship / Trainee, means the person is still studying. Count that tenure as study, not professional seniority, however senior the title sounds.
5. **Err on the Side of Approval**: Err on the side of approval (match: true) if a candidate is close to a tier threshold or possesses significant career depth. This tie-breaker does NOT apply to anyone the criteria excludes outright — an exclusion is a floor, not a threshold to round up from.

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
        // The employment type is the whole difference between a Werkstudent and
        // a full-time engineer, and it used to be dropped before the model saw
        // it — which is how a working student with a 2026–2027 master's was
        // read as two years of professional tenure and shortlisted.
        const type = e.employmentType ? ` (${e.employmentType})` : '';

        return `- ${e.title} at ${e.companyName}${type}${dateStr}${e.description ? `\n  Description: ${e.description}` : ''}`;
      })
      .join('\n') || 'None';

  const skills = profileData.skills?.slice(0, 10).join(', ') || 'None';

  // Parsed since the pipeline was built and never once sent to the model. An
  // end year in the future is the single clearest signal that someone is still
  // a student, and no criteria prompt mentioning graduates could act on it.
  const education =
    profileData.education
      ?.map((e) => {
        const startYear = e.timePeriod?.startDate?.year || '';
        const endYear = e.timePeriod?.endDate?.year || '';

        const dateStr = startYear
          ? ` [${startYear} - ${endYear || 'Present'}]`
          : '';
        const field = e.fieldOfStudy ? `, ${e.fieldOfStudy}` : '';

        return `- ${e.degree || 'Studied'}${field} at ${e.school}${dateStr}`;
      })
      .join('\n') || 'None';

  const candidateProfileString = `Name: ${profileData.firstName} ${profileData.lastName}
Headline: ${profileData.headline}
Experiences (History & Duration):
${experiences}
Education:
${education}
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
1. Determine whether ${targetCompany} actually appears in their experience, and whether they are there now or have left. This is a real check — the profile was found by a search that also returns former employees and, sometimes, people who never worked there at all. Set match to false if the company is absent entirely.
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

  const parsed = extractJsonObject(raw);

  if (!parsed) {
    logger.error(
      `[LLM] JSON parse failed. Raw LLM output: ${raw.slice(0, 500)}`,
    );
    throw new LlmError(
      'LLM_BAD_JSON',
      'The AI model returned something unreadable.',
      {
        detail: `Expected JSON, got: ${raw.slice(0, 300)}`,
        provider:
          asTarget(config).label || providerLabel(normalizeProvider(config)),
        model: resolveModel(config),
      },
    );
  }

  return {
    match: Boolean(parsed.match),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}
